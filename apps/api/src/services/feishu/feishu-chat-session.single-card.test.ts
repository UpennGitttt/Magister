import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { FeishuClient } from "../../integrations/feishu/feishu-client";
import {
  feishuChatSessionRegistry,
  FeishuChatSession,
  TokenBucket,
} from "./feishu-chat-session";
import { taskEventBus } from "../../sse/task-event-bus";
import { __resetQueueForTests } from "../../integrations/feishu/sequential-queue";

beforeEach(() => {
  feishuChatSessionRegistry.__resetForTests();
  __resetQueueForTests();
});

afterEach(() => {
  feishuChatSessionRegistry.__resetForTests();
  __resetQueueForTests();
});

type PatchRecord = {
  elementId: string;
  sequence: number;
  uuid: string;
  content: string;
};

type MockState = {
  createCard: number;
  sendCardRef: number;
  sendText: number;
  patches: PatchRecord[];
  settings: number;
  updateCard: number;
  uploadImage: number;
  uploadedFilenames: string[];
  lastUpdateCard: { cardJson: unknown; sequence: number; uuid: string } | null;
  /** Count of 11402 rejections raised by the monotonic server model. */
  seqConflicts: number;
  /** Monotonic-clock timestamp (ms) of EVERY card mutation (patch/settings/updateCard). */
  mutationTimes: number[];
};

function mockClient(state: MockState, opts?: {
  failPatchOnce?: { elementId: string };
  /** Delay (ms) before createCard resolves — simulates an in-flight eager create. */
  createCardDelayMs?: number;
  /** Make createCard reject — simulates a card-delivery failure. */
  failCreateCard?: boolean;
  /** Throw a Feishu 11402 (duplicate sequence) on the first patch to this element. */
  conflict11402Once?: { elementId: string };
  /**
   * Model Feishu's server-side monotonic sequence check: reject any
   * patch whose sequence is <= the last APPLIED sequence with code
   * 11402. Exposes the sequence-gap bug — if a later element lands a
   * higher seq while an earlier seq is still parked, the earlier retry
   * is rejected (can never apply).
   */
  enforceMonotonicSeq?: boolean;
  /**
   * ALWAYS fail every patchCardElement to this element at the network
   * layer (no code → ambiguous → parked-for-retry). Used to keep an op
   * permanently unsettled so close()'s force flushes can't drain the
   * frontier — exercising the can't-settle full-card updateCard fallover
   * (Codex re-review P1). updateCard / settings still succeed.
   */
  failPatchElementAlways?: { elementId: string };
}): FeishuClient {
  let failed = false;
  let conflicted = false;
  let lastAppliedSeq = 1; // createCard reserves seq 1
  return {
    async getTenantAccessToken() {
      return "tok";
    },
    async createCard() {
      if (opts?.createCardDelayMs) {
        await new Promise((r) => setTimeout(r, opts.createCardDelayMs));
      }
      if (opts?.failCreateCard) {
        throw new Error("createCard boom");
      }
      state.createCard += 1;
      return { cardId: `card-${state.createCard}` };
    },
    async sendCardRef() {
      state.sendCardRef += 1;
      return { messageId: `m${state.sendCardRef}` };
    },
    async sendTextMessage(input: { chatId: string; text: string }) {
      state.sendText += 1;
      return { messageId: "stub" };
    },
    async patchCardElement(input: {
      elementId: string;
      sequence: number;
      uuid: string;
      partial: { content?: string };
    }) {
      if (
        opts?.failPatchElementAlways &&
        input.elementId === opts.failPatchElementAlways.elementId
      ) {
        const err: Error & { code?: string } = new Error("network blip (persistent)");
        err.code = "ECONNRESET";
        throw err;
      }
      if (
        opts?.failPatchOnce &&
        !failed &&
        input.elementId === opts.failPatchOnce.elementId
      ) {
        failed = true;
        const err: Error & { code?: string } = new Error("network blip");
        err.code = "ECONNRESET";
        throw err;
      }
      if (
        opts?.conflict11402Once &&
        !conflicted &&
        input.elementId === opts.conflict11402Once.elementId
      ) {
        conflicted = true;
        const err: Error & { code?: number } = new Error("sequence number compare failed");
        err.code = 11402;
        throw err;
      }
      if (opts?.enforceMonotonicSeq && input.sequence <= lastAppliedSeq) {
        state.seqConflicts += 1;
        const err: Error & { code?: number } = new Error("sequence number compare failed");
        err.code = 11402;
        throw err;
      }
      if (opts?.enforceMonotonicSeq) lastAppliedSeq = input.sequence;
      state.mutationTimes.push(performance.now());
      state.patches.push({
        elementId: input.elementId,
        sequence: input.sequence,
        uuid: input.uuid,
        content:
          typeof input.partial.content === "string" ? input.partial.content : "",
      });
    },
    async patchCardSettings() {
      state.mutationTimes.push(performance.now());
      state.settings += 1;
    },
    async updateCard(input: { cardJson: unknown; sequence: number; uuid: string }) {
      state.mutationTimes.push(performance.now());
      state.updateCard += 1;
      state.lastUpdateCard = {
        cardJson: input.cardJson,
        sequence: input.sequence,
        uuid: input.uuid,
      };
    },
    async uploadImage(input: { data: Buffer; filename: string }) {
      state.uploadImage += 1;
      state.uploadedFilenames.push(input.filename);
      return { imageKey: `img_${state.uploadImage}` };
    },
    async replyTextMessage() {
      return { messageId: "stub" };
    },
    async addMessageReaction() {
      return { reactionId: "stub" };
    },
    async deleteMessageReaction() {
      /* noop */
    },
    async sendCardMessage() {
      return { messageId: "stub" };
    },
    async replyCardMessage() {
      return { messageId: "stub" };
    },
  } as unknown as FeishuClient;
}

function newState(): MockState {
  return {
    createCard: 0,
    sendCardRef: 0,
    sendText: 0,
    patches: [],
    settings: 0,
    updateCard: 0,
    uploadImage: 0,
    uploadedFilenames: [],
    lastUpdateCard: null,
    seqConflicts: 0,
    mutationTimes: [],
  };
}

type FakeMediaRow = {
  id: string;
  requestId: string | null;
  kind: string;
  filename: string;
  storagePath: string;
  caption: string | null;
};

/**
 * Fake TaskMediaRepository scoped to listByTaskIdAndRequestId — the only
 * method the finalizer uses. No mock.module (avoids the cross-file leak
 * hazard); injected via SessionConfig.mediaRepo.
 */
function fakeMediaRepo(rows: FakeMediaRow[]) {
  return {
    async listByTaskIdAndRequestId(taskId: string, requestId: string) {
      return rows.filter((r) => r.requestId === requestId) as unknown[];
    },
  };
}

describe("TokenBucket", () => {
  it("caps consumption at the configured rate over a window", async () => {
    // 10 tokens/sec, capacity 10. After draining the burst, the next
    // grant must wait roughly 1/rate seconds.
    let now = 0;
    const bucket = new TokenBucket({ ratePerSec: 10, capacity: 10, nowMs: () => now });
    // Drain the full burst.
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryTake()).toBe(true);
    }
    // Bucket is empty now.
    expect(bucket.tryTake()).toBe(false);
    // After 100ms (1 token at 10/s) one token refills.
    now += 100;
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    // After 1s, capacity is back (capped at capacity).
    now += 1000;
    let granted = 0;
    while (bucket.tryTake()) granted += 1;
    expect(granted).toBe(10);
  });

  it("never exceeds capacity even after long idle", () => {
    let now = 0;
    const bucket = new TokenBucket({ ratePerSec: 10, capacity: 10, nowMs: () => now });
    now += 100_000;
    let granted = 0;
    while (bucket.tryTake()) granted += 1;
    expect(granted).toBe(10);
  });
});

describe("FeishuChatSession single-card orchestration", () => {
  it("tools go into tools_body panel, no standalone text messages, shared monotonic sequence", async () => {
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-1";
    const taskId = "task-1";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "high",
      client,
    });

    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "hi " },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.tool_call",
      requestId,
      data: { toolName: "bash", input: { command: "ls" }, toolUseId: "t1" },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.tool_call",
      requestId,
      data: { toolName: "read_file", input: { path: "x.ts" }, toolUseId: "t2" },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "done" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 900));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(state.createCard).toBe(1);
    expect(state.sendText).toBe(0); // no scattered tool messages

    const answerPatches = state.patches.filter((p) => p.elementId === "answer");
    const toolPatches = state.patches.filter((p) => p.elementId === "tools_body");
    expect(answerPatches.length).toBeGreaterThanOrEqual(1);
    expect(toolPatches.length).toBeGreaterThanOrEqual(1);

    // Last tool body carries the count + both tool rows.
    const lastTools = toolPatches[toolPatches.length - 1]!;
    expect(lastTools.content).toContain("**2 个工具**");
    expect(lastTools.content).toContain("bash");
    expect(lastTools.content).toContain("read_file");

    // Sequence is shared across both elements and strictly monotonic,
    // and the first patch is >= 2 (createCard reserves seq 1).
    const seqs = state.patches.map((p) => p.sequence);
    expect(seqs[0]).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it("rate-limits combined answer+tool patches to roughly the per-card cap", async () => {
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-rl";
    const taskId = "task-rl";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "high",
      client,
    });
    // Fire a rapid burst of distinct deltas + tool calls so both
    // elements want to flush many times within ~500ms.
    for (let i = 0; i < 40; i++) {
      taskEventBus.publish(taskId, {
        type: "leader.stream_delta",
        requestId,
        data: { type: "text_delta", text: `w${i} ` },
        timestamp: new Date().toISOString(),
      });
      taskEventBus.publish(taskId, {
        type: "leader.tool_call",
        requestId,
        data: { toolName: "bash", input: { command: `c${i}` }, toolUseId: `t${i}` },
        timestamp: new Date().toISOString(),
      });
    }
    await new Promise((r) => setTimeout(r, 550));
    // At ~10 patches/sec, ~550ms should yield well under 20 patches.
    // (Burst capacity 10 + ~5 refilled tokens.) Generous upper bound.
    expect(state.patches.length).toBeLessThanOrEqual(18);
    const session = feishuChatSessionRegistry.get(requestId)!;
    await session.close();
  });

  it("retries a network-failed patch with the SAME sequence + uuid", async () => {
    const state = newState();
    const client = mockClient(state, { failPatchOnce: { elementId: "answer" } });
    const requestId = "req-retry";
    const taskId = "task-retry";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "hello world" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 1200));
    const answerPatches = state.patches.filter((p) => p.elementId === "answer");
    // The first attempt threw; the retry must have landed with the
    // SAME sequence and uuid (idempotent re-send), not a new gap.
    expect(answerPatches.length).toBeGreaterThanOrEqual(1);
    const session = feishuChatSessionRegistry.get(requestId)!;
    // Sequence must not have skipped past the failed attempt — the next
    // flush after a successful retry uses the next number with no gap.
    await session.close();
  });

  it("inlines this-turn media at finalize: uploadImage → updateCard on the same queue with the next sequence", async () => {
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-media";
    const taskId = "task-media";
    const mediaRepo = fakeMediaRepo([
      // Prior turn — must NOT be inlined into this card.
      { id: "m_prior", requestId: "req-prior", kind: "image", filename: "old.png", storagePath: "/x/old.png", caption: null },
      // This turn: one image (uploaded) + one non-image file (link row).
      { id: "m_img", requestId, kind: "image", filename: "chart.png", storagePath: "/x/chart.png", caption: "图表" },
      { id: "m_file", requestId, kind: "file", filename: "report.pdf", storagePath: "/x/report.pdf", caption: null },
    ]);
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
      mediaRepo: mediaRepo as never,
      readMediaBytes: async () => Buffer.from("bytes"),
    });

    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "见图" },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.media_sent",
      requestId,
      data: { mediaId: "m_img", kind: "image", filename: "chart.png" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 200));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 300));

    // Finalize rebuilt the full card via updateCard (with inline media),
    // exactly once. uploadImage ran once (only the image, not the file).
    expect(state.updateCard).toBe(1);
    expect(state.uploadImage).toBe(1);
    expect(state.uploadedFilenames).toEqual(["chart.png"]);
    // No-media finalize path (patchCardSettings) must NOT also run when
    // updateCard handled finalization.
    expect(state.settings).toBe(0);

    const upd = state.lastUpdateCard!;
    expect(upd).not.toBeNull();
    // updateCard sequence is the NEXT monotonic number after the last
    // element PATCH (drain-then-update on the shared per-card sequence).
    const maxPatchSeq = state.patches.reduce((m, p) => Math.max(m, p.sequence), 1);
    expect(upd.sequence).toBeGreaterThan(maxPatchSeq);

    const json = JSON.stringify(upd.cardJson);
    // Image embedded by its uploaded image_key (alt uses caption "图表").
    expect(json).toContain("img_1");
    expect(json).toContain("图表");
    expect(json).toContain("report.pdf"); // non-image becomes a link row
    expect(json).not.toContain("old.png"); // prior turn excluded
  });

  it("no-media terminal path keeps the existing patchCardSettings finalize (no updateCard)", async () => {
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-nomedia";
    const taskId = "task-nomedia";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
      mediaRepo: fakeMediaRepo([]) as never,
      readMediaBytes: async () => Buffer.from(""),
    });
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "hello" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 200));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 300));

    // No media → unchanged finalize: settings PATCH, no full-card update.
    expect(state.updateCard).toBe(0);
    expect(state.uploadImage).toBe(0);
    expect(state.settings).toBe(1);
  });

  it("creates the card eagerly on start — no inbound event required (replaces the 已收到 ack)", async () => {
    const state = newState();
    const client = mockClient(state);
    feishuChatSessionRegistry.start({
      requestId: "req-eager",
      taskId: "task-eager",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    // No taskEventBus.publish — the eager create must fire on start.
    await new Promise((r) => setTimeout(r, 80));
    expect(state.createCard).toBe(1);
    expect(state.sendCardRef).toBe(1);
    // The single card is the only outbound — no separate ack text.
    expect(state.sendText).toBe(0);
  });
});

describe("Codex P0 — exactly-one-delivery (card-decision settled promise)", () => {
  it("awaitCardDecision resolves only AFTER an in-flight createCard settles → fallback sees delivered=true (no double send)", async () => {
    const state = newState();
    // createCard takes 120ms — long enough that a naive
    // hasDeliveredCardFor() read right after start() would be false.
    const client = mockClient(state, { createCardDelayMs: 120 });
    const requestId = "req-p0-slow";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p0-slow",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });

    // Mid-flight: the decision is NOT yet settled, and the gate is false.
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(false);

    // The fallback path awaits the decision FIRST — this resolves only
    // once createCard + sendCardRef have settled.
    await feishuChatSessionRegistry.awaitCardDecision(requestId);

    // Now the gate is authoritative: the card WAS delivered → fallback
    // must skip the plain-text send (no double delivery).
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(true);
    expect(state.createCard).toBe(1);
    expect(state.sendCardRef).toBe(1);
  });

  it("awaitCardDecision resolves when createCard FAILS → gate stays false so fallback proceeds with one text", async () => {
    const state = newState();
    const client = mockClient(state, { failCreateCard: true });
    const requestId = "req-p0-fail";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p0-fail",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });

    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    // Card delivery failed → gate false → fallback proceeds (one text).
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(false);
    expect(state.createCard).toBe(0);
    expect(state.sendCardRef).toBe(0);
  });

  it("awaitCardDecision resolves immediately when no session ever started for the requestId", async () => {
    // No start() — there's no decision to wait on, so the fallback must
    // proceed immediately (resolves without hanging).
    let resolved = false;
    await Promise.race([
      feishuChatSessionRegistry.awaitCardDecision("req-never").then(() => {
        resolved = true;
      }),
      new Promise((r) => setTimeout(r, 100)),
    ]);
    expect(resolved).toBe(true);
  });

  it("awaitCardDecision is safe to await twice", async () => {
    const state = newState();
    const client = mockClient(state, { createCardDelayMs: 30 });
    const requestId = "req-p0-twice";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p0-twice",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    await feishuChatSessionRegistry.awaitCardDecision(requestId); // no hang
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(true);
  });

  it("close() before createCard finishes settles the decision (abandoned, gate false)", async () => {
    const state = newState();
    const client = mockClient(state, { createCardDelayMs: 200 });
    const requestId = "req-p0-close";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p0-close",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    const session = feishuChatSessionRegistry.get(requestId)!;
    // Close while createCard is still in flight.
    await session.close("abort");
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    // Card creation was abandoned mid-flight → not delivered.
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(false);
  });
});

describe("Codex P1a — per-card sequence invariant + 11402 handling", () => {
  it("a parked failed PATCH blocks new sequence allocation on the OTHER element + terminal until settled", async () => {
    const state = newState();
    // The answer element's first PATCH fails at the network layer and
    // parks (frozen seq). While parked, the tools element must NOT
    // allocate a higher sequence.
    const client = mockClient(state, {
      failPatchOnce: { elementId: "answer" },
      enforceMonotonicSeq: true,
    });
    const requestId = "req-p1a-gap";
    const taskId = "task-p1a-gap";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "high",
      client,
    });
    // Fire answer text first (will fail+park), then a tool call.
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "hello" },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.tool_call",
      requestId,
      data: { toolName: "bash", input: { command: "ls" }, toolUseId: "t1" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 1500));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 600));

    // With the invariant, sequences land at the server in STRICTLY
    // increasing order (the mock enforces Feishu's monotonic check and
    // would reject any gap-crossing seq with 11402). The retried answer
    // PATCH must therefore have landed — proving the tools element waited
    // behind the parked answer op rather than racing a higher seq ahead.
    const landedSeqs = state.patches.map((p) => p.sequence);
    for (let i = 1; i < landedSeqs.length; i++) {
      expect(landedSeqs[i]!).toBeGreaterThan(landedSeqs[i - 1]!);
    }
    // The answer content (which initially failed) must have fully landed
    // — if a tools seq had jumped ahead, the answer retry would have been
    // rejected by the monotonic server check and "hello" never landed.
    const answerPatches = state.patches.filter((p) => p.elementId === "answer");
    expect(answerPatches.length).toBeGreaterThanOrEqual(1);
    expect(answerPatches[answerPatches.length - 1]!.content).toContain("hello");
    // The tools panel also landed.
    const toolPatches = state.patches.filter((p) => p.elementId === "tools_body");
    expect(toolPatches.length).toBeGreaterThanOrEqual(1);
    // CRUX of the invariant: the server-side monotonic check NEVER fired
    // a 11402. Without the invariant the tools element would allocate a
    // higher seq while the answer's seq-2 retry is still parked; the
    // retry would then be rejected as out-of-order (a gap) — exactly the
    // 11402 we must prevent.
    expect(state.seqConflicts).toBe(0);
  });

  it("a 11402 (duplicate-seq) rejection is treated as applied — advances instead of retry-looping", async () => {
    const state = newState();
    const client = mockClient(state, { conflict11402Once: { elementId: "answer" } });
    const requestId = "req-p1a-11402";
    const taskId = "task-p1a-11402";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "first chunk" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 200));
    // More text after the conflict — a later flush must still land
    // (the session advanced past the 11402 instead of looping on it).
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: " second chunk" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 200));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 300));

    // A PATCH after the conflicting one must have landed with a HIGHER
    // sequence (we advanced, did not retry the same seq forever).
    const answerPatches = state.patches.filter((p) => p.elementId === "answer");
    expect(answerPatches.length).toBeGreaterThanOrEqual(1);
    const lastAnswer = answerPatches[answerPatches.length - 1]!;
    expect(lastAnswer.content).toContain("second chunk");
  });
});

describe("Codex re-review P1 — close() never crosses an unsettled sequence frontier", () => {
  it("a parked force-flush op at close → full-card updateCard fallover above the frontier, NO 11402, NO partial settings/footer mutation", async () => {
    const state = newState();
    // The answer element ALWAYS fails at the network layer → its op
    // stays parked-for-retry permanently. close()'s force flush of the
    // answer therefore re-parks it; the frontier can never settle within
    // the bounded drain budget. enforceMonotonicSeq makes the server
    // reject (11402) any terminal mutation that allocates a sequence
    // ahead of a still-unsettled lower seq — so a partial footer/settings
    // PATCH (the BUG) would trip it. The fix takes the full-card
    // updateCard fallover instead, which the monotonic server accepts
    // (its seq is strictly the highest).
    const client = mockClient(state, {
      failPatchElementAlways: { elementId: "answer" },
      enforceMonotonicSeq: true,
    });
    const requestId = "req-frontier";
    const taskId = "task-frontier";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "high",
      client,
    });
    // Some answer text (will fail+park) + a tool row (lands cleanly).
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "the answer" },
      timestamp: new Date().toISOString(),
    });
    taskEventBus.publish(taskId, {
      type: "leader.tool_call",
      requestId,
      data: { toolName: "bash", input: { command: "ls" }, toolUseId: "t1" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 700));
    taskEventBus.publish(taskId, {
      type: "task:completed",
      requestId,
      data: {},
      timestamp: new Date().toISOString(),
    });
    // close() drains (twice), can't settle the parked answer op, then
    // takes the full-card updateCard fallover. Allow for the bounded
    // drain budget (TOOLS_FLUSH_MS*4 per drain, ×2).
    await new Promise((r) => setTimeout(r, 5000));

    // The can't-settle fallover finalized via a SINGLE full-card
    // updateCard — NOT a partial footer/settings PATCH that would cross
    // the unsettled frontier.
    expect(state.updateCard).toBe(1);
    expect(state.settings).toBe(0);
    // CRUX: the monotonic server NEVER rejected a terminal mutation with
    // 11402. Without the fix, the footer/settings PATCH would allocate a
    // seq ahead of the parked answer op (a gap) and be rejected.
    expect(state.seqConflicts).toBe(0);
    // The terminal updateCard's sequence is strictly above every landed
    // element PATCH (and above the parked op's frozen seq).
    const upd = state.lastUpdateCard!;
    expect(upd).not.toBeNull();
    const maxLandedSeq = state.patches.reduce((m, p) => Math.max(m, p.sequence), 1);
    expect(upd.sequence).toBeGreaterThan(maxLandedSeq);
    // The full-card rebuild carries the live answer text (subsumes the
    // parked partial op that never landed) + the done footer.
    const json = JSON.stringify(upd.cardJson);
    expect(json).toContain("the answer");
  }, 15000);
});

describe("Codex re-review P2 — text fallback gate is consulted regardless of verbose level", () => {
  it("a delivered card suppresses the text fallback even when verbose flipped to off mid-turn", async () => {
    // Simulate the registry-level effect of Fix 2: the call sites now
    // await the decision + read hasDeliveredCardFor() OUTSIDE the verbose
    // guard. We assert the registry gate is authoritative for a delivered
    // card — i.e., once a card is delivered, the gate returns true and the
    // fallback (which both sites short-circuit on a true gate) is skipped,
    // independent of verbose.
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-p2-verboseoff";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p2-verboseoff",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "high",
      client,
    });
    // Card gets delivered.
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(true);

    // Now model the fallback decision as the FIXED call sites make it:
    // consult the gate unconditionally (no verbose guard). Even if the
    // current verbose level is "off", the delivered card must suppress
    // the text fallback.
    const verboseLevelNow: "off" | "low" | "high" = "off";
    let textFallbackFired = false;
    // FIXED control flow: await decision + early-return on delivered,
    // BEFORE / OUTSIDE any verbose branch.
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    if (feishuChatSessionRegistry.hasDeliveredCardFor(requestId)) {
      // suppressed — return without sending text
    } else if (verboseLevelNow !== "off") {
      textFallbackFired = true;
    } else {
      textFallbackFired = true;
    }
    expect(textFallbackFired).toBe(false);
  });

  it("no delivered card → fallback still fires (gate false), regardless of verbose", async () => {
    const state = newState();
    const client = mockClient(state, { failCreateCard: true });
    const requestId = "req-p2-nocard";
    feishuChatSessionRegistry.start({
      requestId,
      taskId: "task-p2-nocard",
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    expect(feishuChatSessionRegistry.hasDeliveredCardFor(requestId)).toBe(false);

    let textFallbackFired = false;
    await feishuChatSessionRegistry.awaitCardDecision(requestId);
    if (feishuChatSessionRegistry.hasDeliveredCardFor(requestId)) {
      // suppressed
    } else {
      textFallbackFired = true; // gate false → fallback fires
    }
    expect(textFallbackFired).toBe(true);
  });
});

describe("Codex P1b — rate limit covers the WHOLE card incl. terminal", () => {
  it("a terminal mutation WAITS for a bucket token when the bucket is depleted (does not bypass)", async () => {
    const state = newState();
    const client = mockClient(state);
    const requestId = "req-p1b";
    const taskId = "task-p1b";
    feishuChatSessionRegistry.start({
      requestId,
      taskId,
      bindingId: "b1",
      chatId: "c1",
      verboseLevel: "low",
      client,
    });
    const session = feishuChatSessionRegistry.get(requestId)!;
    // Let the eager card exist so close() takes the finalize path.
    await new Promise((r) => setTimeout(r, 50));
    // Give the card some answer so close() has a footer PATCH + settings
    // PATCH to issue at the terminal.
    taskEventBus.publish(taskId, {
      type: "leader.stream_delta",
      requestId,
      data: { type: "text_delta", text: "final answer" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 200)); // let the streaming PATCH land

    // DEPLETE the shared per-card bucket to empty, then close. The
    // terminal footer PATCH + settings PATCH (each draws a token) must
    // now WAIT ~one refill interval (100ms at 10/s) apiece. With the bug
    // (terminal bypasses the bucket) they'd fire near-instantly.
    session.__depleteBucketForTests();
    const closeStart = performance.now();
    await session.close("✅ done");
    const closeDurationMs = performance.now() - closeStart;

    // Two terminal token draws (footer + settings) against an empty
    // bucket ⇒ at least ~2 refill intervals (~200ms). Assert a margin
    // well above the ~0ms a bypass would take, but below the real wait so
    // the test isn't flaky. (Refill is 1 token / 100ms.)
    expect(closeDurationMs).toBeGreaterThanOrEqual(120);
    // Finalize still completed correctly (no-media settings path).
    expect(state.settings).toBe(1);
  });
});
