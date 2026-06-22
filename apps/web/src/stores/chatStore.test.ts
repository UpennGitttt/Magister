import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseWireEvent, useChatStore } from "./chatStore";
import type { SnapshotEvent, WireEvent } from "../components/chat/conversation/types";

// ──────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────

const TASK = "task_chat_store_test";
let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

beforeEach(() => {
  useChatStore.getState().resetForTests();
  seqCounter = 0;
});

afterEach(() => {
  useChatStore.getState().resetForTests();
});

function eventOf(
  type: string,
  requestId: string,
  data: Record<string, unknown>,
): WireEvent {
  return { type, requestId, seq: nextSeq(), data };
}

function applyEvents(taskId: string, events: WireEvent[]): void {
  const apply = useChatStore.getState().applyWireEvent;
  for (const ev of events) apply(taskId, ev);
}

function getConv(taskId: string) {
  return useChatStore.getState().conversations[taskId];
}

// ──────────────────────────────────────────────────────────────────────
// Optimistic + bindRequestId lifecycle
// ──────────────────────────────────────────────────────────────────────

describe("optimistic exchange lifecycle", () => {
  test("beginExchange creates a pending exchange with a local id", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe(id);
    expect(conv?.exchanges[0]?.status).toBe("pending");
    expect(conv?.exchanges[0]?.user.content).toBe("hi");
    expect(useChatStore.getState().pendingExchangeId(TASK)).toBe(id);
  });

  test("bindRequestId rewrites the local id and applies pending events to the right exchange", () => {
    const localId = useChatStore.getState().beginExchange(TASK, "hello");
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    const conv = getConv(TASK);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
    expect(conv?.exchanges[0]?.user.content).toBe("hello");

    // Now events for req_AAA flow.
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "world" }),
      eventOf("task:completed", "req_AAA", { state: "DONE" }),
    ]);
    const updated = getConv(TASK);
    expect(updated?.exchanges[0]?.status).toBe("complete");
    const part = updated?.exchanges[0]?.response.parts[0];
    if (part?.kind === "text") {
      expect(part.content).toBe("world");
      expect(part.sealed).toBe(true);
    }
  });

  test("rollbackOptimistic drops the unbound exchange (used on createTask failure)", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().rollbackOptimistic(id);
    expect(getConv(TASK)?.exchanges).toHaveLength(0);
    expect(useChatStore.getState().pendingExchangeId(TASK)).toBe(null);
  });

  test("beginExchange(null, ...) places exchange in a `_pending:*` bucket; bindRequestId migrates to the real taskId", () => {
    // Pre-network: caller doesn't know taskId yet.
    const localId = useChatStore.getState().beginExchange(null, "fresh chat");
    const stateAfterBegin = useChatStore.getState();
    const pendingKeys = Object.keys(stateAfterBegin.conversations).filter((k) =>
      k.startsWith("_pending:"),
    );
    expect(pendingKeys).toHaveLength(1);
    const pending = stateAfterBegin.conversations[pendingKeys[0]!]!;
    expect(pending.exchanges).toHaveLength(1);
    expect(pending.exchanges[0]?.id).toBe(localId);
    expect(pending.exchanges[0]?.user.content).toBe("fresh chat");

    // Backend confirms — bindRequestId migrates to the real conversation.
    useChatStore.getState().bindRequestId(localId, "task_real", "req_REAL");
    const final = useChatStore.getState();
    // Pending bucket cleaned up.
    expect(Object.keys(final.conversations).filter((k) => k.startsWith("_pending:"))).toHaveLength(0);
    // Exchange landed under the real taskId with the canonical id.
    const real = final.conversations["task_real"]!;
    expect(real.exchanges).toHaveLength(1);
    expect(real.exchanges[0]?.id).toBe("req_REAL");
    expect(real.exchanges[0]?.user.content).toBe("fresh chat");
  });

  test("bindRequestId is idempotent", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA"); // again, no-op
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Race: backend events arrive BEFORE bindRequestId
// ──────────────────────────────────────────────────────────────────────

describe("backend-first race", () => {
  test("bindRequestId merges into the remote exchange when events arrived first", () => {
    // User submits, optimistic id assigned.
    const localId = useChatStore.getState().beginExchange(TASK, "hello");

    // Backend events for the canonical requestId arrive BEFORE we
    // got the POST /tasks response back. The applyWireEvent path
    // drops them because the requestId isn't registered yet.
    // EXCEPT: in real life this can happen because some other tab
    // already saw the same task. Cover the case where chatStore
    // pre-registers the remote exchange via hydrateFromSnapshot
    // ahead of bindRequestId.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      {
        id: "evt_1",
        type: "leader.stream_delta",
        requestId: "req_AAA",
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "world" }),
      },
    ]);

    // Now we have TWO exchanges: the local optimistic + the remote.
    expect(getConv(TASK)?.exchanges).toHaveLength(2);

    // bindRequestId merges them: local user prompt wins, remote
    // response wins.
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
    expect(conv?.exchanges[0]?.user.content).toBe("hello"); // from local
    const part = conv?.exchanges[0]?.response.parts[0];
    if (part?.kind === "text") expect(part.content).toBe("world"); // from remote
  });
});

// ──────────────────────────────────────────────────────────────────────
// Stale event rejection
// ──────────────────────────────────────────────────────────────────────

describe("stale event filtering", () => {
  test("events for an unknown requestId seed a new exchange", () => {
    // Behavior changed in 2758a08: PlanCard Approve / Cancel / Revise
    // sentinels kick off a new turn under a fresh requestId without
    // going through the optimistic-exchange flow, so live applyEvent
    // must seed an Exchange to avoid the chat looking frozen until
    // refresh. Prior semantics ("drop unknown") was this test; we
    // assert the new seeded behavior to keep regression coverage.
    useChatStore.getState().beginExchange(TASK, "hi");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_GHOST", { type: "text_delta", text: "ghost" }),
    ]);
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(2);
    const seeded = conv?.exchanges.find((e) => e.id === "req_GHOST");
    expect(seeded).toBeDefined();
    expect(seeded?.status).toBe("streaming");
  });

  test("events with seq <= lastApplied dropped (event-level dedup)", () => {
    const localId = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "abc" }),
    ]);
    const conv = getConv(TASK);
    const seqAfter = conv?.exchanges[0]?.lastAppliedSeq ?? 0;
    expect(seqAfter).toBeGreaterThan(0);

    // Inject a duplicate at the SAME seq.
    const duplicate: WireEvent = {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: seqAfter,
      data: { type: "text_delta", text: "DOUBLED" },
    };
    useChatStore.getState().applyWireEvent(TASK, duplicate);
    const after = getConv(TASK);
    const part = after?.exchanges[0]?.response.parts[0];
    if (part?.kind === "text") expect(part.content).toBe("abc");
  });

  test("flushes queued thinking deltas before applying a later immediate event", () => {
    const localId = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 1,
      data: { type: "thinking_delta", text: "reasoning" },
    });
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.turn_complete",
      requestId: "req_AAA",
      seq: 2,
      data: {},
    });

    const parts = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    expect(parts[0]?.kind).toBe("thinking");
    if (parts[0]?.kind === "thinking") {
      expect(parts[0].content).toBe("reasoning");
      expect(parts[0].sealed).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// TextBuffer attachment
// ──────────────────────────────────────────────────────────────────────

describe("TextBuffer attachment", () => {
  test("first text_delta on a fresh part attaches a buffer", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "alpha" }),
    ]);
    const conv = getConv(TASK);
    const part = conv?.exchanges[0]?.response.parts[0];
    if (part?.kind !== "text") throw new Error("expected text part");
    expect(part.buffer).toBeDefined();
    // Buffer was seeded with the projector-applied content.
    expect(part.buffer?.getSnapshot()).toBe("alpha");
  });

  test("buffer reference is stable across subsequent text_deltas to the same part", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "alpha" }),
    ]);
    const buf1 = (getConv(TASK)?.exchanges[0]?.response.parts[0] as { buffer: unknown }).buffer;

    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "beta" }),
    ]);
    const buf2 = (getConv(TASK)?.exchanges[0]?.response.parts[0] as { buffer: unknown }).buffer;
    // CRITICAL: same instance — never mutate buffer ref under live
    // useSyncExternalStore subscription.
    expect(buf2).toBe(buf1);
  });

  test("sealing the part disposes the buffer (sets to null)", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "alpha" }),
      eventOf("leader.turn_complete", "req_AAA", {}),
    ]);
    const conv = getConv(TASK);
    const part = conv?.exchanges[0]?.response.parts[0];
    if (part?.kind !== "text") throw new Error("expected text part");
    expect(part.sealed).toBe(true);
    expect(part.buffer).toBe(null);
    expect(part.content).toBe("alpha");
  });

  test("a NEW text part after a tool boundary gets its OWN buffer instance", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "before" }),
      eventOf("leader.stream_delta", "req_AAA", { type: "tool_use_start", id: "toolu_1", name: "x" }),
      eventOf("leader.tool_call", "req_AAA", { toolUseId: "toolu_1", toolName: "x" }),
      eventOf("leader.tool_result", "req_AAA", { toolUseId: "toolu_1", output: "ok" }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "after" }),
    ]);
    const parts = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
    if (parts[0]?.kind === "text" && parts[2]?.kind === "text") {
      expect(parts[0].buffer).toBe(null); // sealed; disposed
      expect(parts[2].buffer).toBeDefined();
      expect(parts[2].buffer).not.toBe(parts[0].buffer);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Leader text_delta decoupling (mobile streaming perf)
//
// For a LEADER (depth 0) text_delta that appends to an EXISTING unsealed
// text part that already owns a buffer, applyWireEvent must feed the
// buffer ONLY and NOT change the `conversations` object identity. The
// first delta still commits once (creates the part + seeds the buffer).
// On seal, part.content must equal the FULL streamed text sourced from
// the buffer, since content no longer accumulates per-delta.
// ──────────────────────────────────────────────────────────────────────

describe("leader text_delta decoupling", () => {
  function getTextPart(taskId: string, idx = 0) {
    const p = getConv(taskId)?.exchanges[0]?.response.parts[idx];
    if (p?.kind !== "text") throw new Error("expected text part");
    return p;
  }

  test("2nd..Nth leader text_delta do NOT change conversations identity (no re-render); buffer accumulates full text", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");

    // First delta — MUST commit once (creates the part, attaches+seeds buffer).
    const refBefore0 = useChatStore.getState().conversations;
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "one " }),
    ]);
    const refAfter1 = useChatStore.getState().conversations;
    expect(refAfter1).not.toBe(refBefore0); // first delta commits
    const part1 = getTextPart(TASK);
    expect(part1.buffer).toBeDefined();
    const buf = part1.buffer;

    // 2nd..Nth deltas — buffer only, NO new conversations reference.
    const refBeforeRest = useChatStore.getState().conversations;
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "two " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "three" }),
    ]);
    const refAfterRest = useChatStore.getState().conversations;
    expect(refAfterRest).toBe(refBeforeRest); // CRITICAL: identity unchanged → no ChatArea re-render

    // Same conversation/exchange/part object identity too (truly no commit).
    expect(getConv(TASK)).toBe(refBeforeRest[TASK]);
    // Buffer is the same stable instance and now holds the full streamed text.
    const part2 = getTextPart(TASK);
    expect(part2.buffer).toBe(buf);
    expect(part2.buffer?.getFullText()).toBe("one two three");
  });

  test("fast-path deduplicates redelivered deltas (no double-append); lastAppliedSeq is only advanced by projector commits", () => {
    // FE1 fix note: the fast path now uses a SEPARATE per-exchange watermark
    // (fastPathSeqWatermark) for its own dedup, instead of mutating
    // ex.lastAppliedSeq in place. lastAppliedSeq is only advanced by full
    // projector commits so nested/thinking deltas with lower seqs are not dropped.
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");

    // seq 1 commits (creates the part + buffer); seq 2 runs the fast path.
    const d1 = eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "one " });
    const d2 = eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "two " });
    applyEvents(TASK, [d1, d2]);

    const before = getTextPart(TASK);
    expect(before.buffer?.getFullText()).toBe("one two ");
    // lastAppliedSeq is only advanced by projector commits (d1 committed; d2 ran
    // the fast path and only advanced fastPathSeqWatermark). So lastAppliedSeq
    // stays at d1.seq after d2 is processed.
    expect(getConv(TASK)?.exchanges[0]?.lastAppliedSeq).toBe(d1.seq);

    // Re-deliver seq 2 verbatim (same seq, same payload). The fast path must
    // reject it via its separate watermark — NOT append "two " a second time.
    const dup: WireEvent = {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: d2.seq,
      data: { type: "text_delta", text: "two " },
    };
    useChatStore.getState().applyWireEvent(TASK, dup);

    const after = getTextPart(TASK);
    expect(after.buffer?.getFullText()).toBe("one two "); // NOT "one two two "
    // lastAppliedSeq still at d1.seq — the dup also ran through the fast path
    // and was rejected there (watermark d2.seq >= d2.seq), no commit.
    expect(getConv(TASK)?.exchanges[0]?.lastAppliedSeq).toBe(d1.seq);
  });

  test("seal via turn_complete reconciles part.content to FULL streamed text", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "Hello " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "wonderful " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "world" }),
      eventOf("leader.turn_complete", "req_AAA", {}),
    ]);
    const part = getTextPart(TASK);
    expect(part.sealed).toBe(true);
    expect(part.buffer).toBe(null);
    expect(part.content).toBe("Hello wonderful world");
  });

  test("tool-boundary seal reconciles the first segment's FULL content; second segment starts a fresh buffer", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "first " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "segment" }),
      eventOf("leader.stream_delta", "req_AAA", { type: "tool_use_start", id: "toolu_1", name: "x" }),
      eventOf("leader.tool_call", "req_AAA", { toolUseId: "toolu_1", toolName: "x" }),
      eventOf("leader.tool_result", "req_AAA", { toolUseId: "toolu_1", output: "ok" }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "second " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "part" }),
      eventOf("leader.turn_complete", "req_AAA", {}),
    ]);
    const parts = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
    if (parts[0]?.kind === "text" && parts[2]?.kind === "text") {
      // First segment sealed at the tool boundary with its FULL content.
      expect(parts[0].sealed).toBe(true);
      expect(parts[0].content).toBe("first segment");
      expect(parts[0].buffer).toBe(null);
      // Second segment sealed at turn_complete with its FULL content + own buffer.
      expect(parts[2].sealed).toBe(true);
      expect(parts[2].content).toBe("second part");
      expect(parts[2].buffer).toBe(null);
    }
  });

  test("bare tool_call (NO preceding tool_use_start) still reconciles the first segment's FULL content", () => {
    // Robustness: a tool boundary that arrives as a single `leader.tool_call`
    // (no `tool_use_start` first) seals the text part AND appends the tool
    // part in the SAME projector pass, so the sealed text part is no longer
    // the last part when chatStore reconciles. The buffer holds the full
    // streamed text; content must still be backfilled from it (else the
    // message renders truncated to its first delta and the buffer leaks).
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "alpha " }),
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "beta" }),
      // No tool_use_start — straight to tool_call.
      eventOf("leader.tool_call", "req_AAA", { toolUseId: "toolu_1", toolName: "x" }),
      eventOf("leader.tool_result", "req_AAA", { toolUseId: "toolu_1", output: "ok" }),
      eventOf("leader.turn_complete", "req_AAA", {}),
    ]);
    const parts = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool"]);
    if (parts[0]?.kind === "text") {
      expect(parts[0].sealed).toBe(true);
      expect(parts[0].content).toBe("alpha beta"); // FULL text, not just "alpha "
      expect(parts[0].buffer).toBe(null); // buffer disposed, not leaked
    }
  });

  test("re-delivered duplicate text_delta (seq <= lastApplied) does NOT double-feed the buffer", () => {
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");
    applyEvents(TASK, [
      eventOf("leader.stream_delta", "req_AAA", { type: "text_delta", text: "abc" }),
    ]);
    const lastSeq = getConv(TASK)?.exchanges[0]?.lastAppliedSeq ?? 0;
    // Re-deliver a delta at a seq we've already applied.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: lastSeq,
      data: { type: "text_delta", text: "DOUBLED" },
    });
    const part = getTextPart(TASK);
    expect(part.buffer?.getFullText()).toBe("abc"); // duplicate ignored
  });
});

// ──────────────────────────────────────────────────────────────────────
// FE1: leader text_delta fast-path must NOT dedup-drop queued
// nested/thinking deltas that arrive with lower seq numbers.
//
// Root cause: tryFastAppendLeaderDelta mutates ex.lastAppliedSeq in place
// when it handles a leader text_delta. If a nested (depth>0) or thinking
// delta was already queued with a LOWER seq, the projector dedup check
// (`event.seq <= old.lastAppliedSeq`) sees the advanced watermark and
// silently drops the queued event — causing teammate transcripts and
// thinking content to go missing.
// ──────────────────────────────────────────────────────────────────────

describe("FE1 – fast-path does NOT dedup-drop lower-seq nested/thinking deltas", () => {
  test("queued thinking delta (lower seq) is NOT dropped after leader text_delta fast-path advances seq", () => {
    // Setup: an exchange that has an open text part with a buffer
    // (the fast path's precondition — requires at least one committed text_delta first).
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");

    // seq=1: leader text_delta — FIRST delta, creates the part + buffer (commits).
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 1,
      data: { type: "text_delta", text: "Hello " },
    });

    // Confirm buffer is open (fast path will trigger on next leader text_delta).
    const partAfterFirst = getConv(TASK)?.exchanges[0]?.response.parts[0];
    expect(partAfterFirst?.kind).toBe("text");
    if (partAfterFirst?.kind === "text") {
      expect(partAfterFirst.buffer).not.toBe(null); // fast path is now armed
    }

    // seq=2: thinking delta — goes to queue (RAF-batched), NOT yet applied.
    // seq=3: leader text_delta — fast path fires, advances lastAppliedSeq to 3.
    //
    // Without the fix: when the queue flushes seq=2, the projector sees
    // 2 <= 3 (lastAppliedSeq) and drops it → thinking content MISSING.
    // With the fix: the fast path must NOT advance the exchange-level
    // lastAppliedSeq, so seq=2 is still applied when the queue flushes.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 2,
      data: { type: "thinking_delta", text: "reasoning step" },
    });

    // seq=3 leader text_delta hits the fast path (buffer already exists).
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 3,
      data: { type: "text_delta", text: "world" },
    });

    // Now simulate the RAF flush by triggering flushPendingDeltasForTask
    // via a synchronous non-delta event (turn_complete triggers the flush).
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.turn_complete",
      requestId: "req_AAA",
      seq: 4,
      data: {},
    });

    const conv = getConv(TASK);
    const parts = conv?.exchanges[0]?.response.parts ?? [];

    // The thinking part MUST exist — it should not have been dedup-dropped.
    const thinkingPart = parts.find((p) => p.kind === "thinking");
    expect(thinkingPart).toBeDefined();
    if (thinkingPart?.kind === "thinking") {
      expect(thinkingPart.content).toBe("reasoning step");
    }

    // The text part should also still be present with its content.
    const textPart = parts.find((p) => p.kind === "text");
    expect(textPart).toBeDefined();
    if (textPart?.kind === "text") {
      // Content should include the full streamed text (reconciled from buffer at seal).
      expect(textPart.content).toBe("Hello world");
    }
  });

  test("queued nested (depth>0) teammate delta (lower seq) is NOT dropped after leader text_delta fast-path advances seq", () => {
    // Same scenario as thinking, but with a depth>0 nested teammate delta.
    const id = useChatStore.getState().beginExchange(TASK, "hi");
    useChatStore.getState().bindRequestId(id, TASK, "req_AAA");

    // seq=1: leader text_delta — first delta, commits, creates buffer.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 1,
      data: { type: "text_delta", text: "Leader says " },
    });

    // Confirm the leader text part now has a buffer (fast path armed).
    const leaderParts = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    const leaderTextPart = leaderParts.find((p) => p.kind === "text");
    if (leaderTextPart?.kind === "text") {
      expect(leaderTextPart.buffer).not.toBe(null);
    }

    // seq=2: tool_use_start + seq=3: tool_call → creates the spawn_teammate ToolPart.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 2,
      data: { type: "tool_use_start", id: "toolu_spawn_1", name: "spawn_teammate" },
    });
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.tool_call",
      requestId: "req_AAA",
      seq: 3,
      data: { toolUseId: "toolu_spawn_1", toolName: "spawn_teammate", input: { role: "coder" } },
    });

    // seq=4: leader text_delta after the tool — opens new text part, commits, creates buffer.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 4,
      data: { type: "text_delta", text: "continuing " },
    });

    // Confirm the new leader text part has a buffer (fast path now armed on the new part).
    const partsAfterTool = getConv(TASK)?.exchanges[0]?.response.parts ?? [];
    const newLeaderTextPart = partsAfterTool[partsAfterTool.length - 1];
    if (newLeaderTextPart?.kind === "text") {
      expect(newLeaderTextPart.buffer).not.toBe(null);
    }

    // seq=5: depth>0 (nested teammate) stream_delta → queued, not yet applied.
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 5,
      agent: { id: "run_coder_1", depth: 1, parentToolUseId: "toolu_spawn_1", role: "coder", name: "coder" },
      data: { type: "text_delta", text: "teammate output" },
    });

    // seq=6: leader text_delta — hits the fast path, would advance lastAppliedSeq to 6.
    // Without the fix, seq=5 in the queue would then be dedup-dropped (5 <= 6).
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.stream_delta",
      requestId: "req_AAA",
      seq: 6,
      data: { type: "text_delta", text: "response" },
    });

    // Flush the queue via a turn_complete (triggers flushPendingDeltasForTask).
    useChatStore.getState().applyWireEvent(TASK, {
      type: "leader.turn_complete",
      requestId: "req_AAA",
      seq: 7,
      data: {},
    });

    const conv = getConv(TASK);
    const toolPart = conv?.exchanges[0]?.response.parts.find((p) => p.kind === "tool");
    expect(toolPart).toBeDefined();
    if (toolPart?.kind === "tool") {
      // The nested delta must have landed in the transcript.
      const transcript = toolPart.transcript ?? [];
      // There should be at least one text part in the transcript.
      const nestedTextPart = transcript.find((p) => p.kind === "text");
      expect(nestedTextPart).toBeDefined();
      if (nestedTextPart?.kind === "text") {
        expect(nestedTextPart.content).toBe("teammate output");
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Snapshot hydration / cold load
// ──────────────────────────────────────────────────────────────────────

describe("hydrateFromSnapshot", () => {
  test("cold load: empty store, snapshot creates the conversation", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_1",
        type: "leader.stream_delta",
        requestId: "req_AAA",
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }),
      },
      {
        id: "evt_2",
        type: "task:completed",
        requestId: "req_AAA",
        seq: 2,
        payloadJson: JSON.stringify({}),
      },
    ];
    useChatStore.getState().hydrateFromSnapshot(TASK, events);
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
    expect(conv?.exchanges[0]?.status).toBe("complete");
  });

  test("hydration after optimistic: preserves local user prompt; merges by id", () => {
    const localId = useChatStore.getState().beginExchange(TASK, "my prompt");
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    // Snapshot replay arrives — same requestId.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      {
        id: "evt_1",
        type: "leader.stream_delta",
        requestId: "req_AAA",
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "snapshot" }),
      },
    ]);
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
    // Local user prompt wins (snapshot can't reconstruct it).
    expect(conv?.exchanges[0]?.user.content).toBe("my prompt");
  });

  test("empty snapshot over a bound optimistic exchange preserves local state (mobile new-task flash regression 2026-05-20)", () => {
    // Reproduces the bug user reported: "+ New Task on mobile, then
    // content appears, vanishes for 1-2s, then reappears". Root cause
    // was hydrateFromSnapshot wiping a freshly-bindRequestId'd
    // optimistic exchange when the brand-new task's first snapshot
    // arrived with 0 events (the leader loop hadn't emitted anything
    // yet). Pre-fix the `extraLocals` filter only kept ids starting
    // with `local_` — bindRequestId had already rewritten the id to
    // the requestId, so the optimistic got dropped to `[]`.
    const localId = useChatStore.getState().beginExchange(TASK, "my prompt");
    useChatStore.getState().bindRequestId(localId, TASK, "req_AAA");
    // Sanity: bound state present before snapshot.
    expect(getConv(TASK)?.exchanges).toHaveLength(1);
    expect(getConv(TASK)?.exchanges[0]?.id).toBe("req_AAA");
    // Empty snapshot (task just created, no live events yet on the
    // server side).
    useChatStore.getState().hydrateFromSnapshot(TASK, []);
    const conv = getConv(TASK);
    expect(conv?.exchanges).toHaveLength(1);
    expect(conv?.exchanges[0]?.id).toBe("req_AAA");
    expect(conv?.exchanges[0]?.user.content).toBe("my prompt");
  });

  test("stale non-empty snapshot preserves a bound optimistic follow-up until live events catch up", () => {
    const oldSnapshot: SnapshotEvent[] = [
      {
        id: "evt_old_text",
        type: "leader.stream_delta",
        requestId: "req_OLD",
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "old answer" }),
      },
      {
        id: "evt_old_done",
        type: "task:completed",
        requestId: "req_OLD",
        seq: 2,
        payloadJson: JSON.stringify({}),
      },
    ];
    useChatStore.getState().hydrateFromSnapshot(TASK, oldSnapshot);

    const localId = useChatStore.getState().beginExchange(TASK, "new follow-up");
    useChatStore.getState().bindRequestId(localId, TASK, "req_NEW");

    // A reconnect snapshot can race behind the POST /tasks response: it
    // contains prior requestIds but not the just-bound requestId yet.
    useChatStore.getState().hydrateFromSnapshot(TASK, oldSnapshot);

    const conv = getConv(TASK);
    expect(conv?.exchanges.map((ex) => ex.id)).toEqual(["req_OLD", "req_NEW"]);
    expect(conv?.exchanges[1]?.user.content).toBe("new follow-up");
  });

  test("hydration is idempotent: replaying the same snapshot twice keeps state unchanged", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_1",
        type: "leader.stream_delta",
        requestId: "req_AAA",
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }),
      },
      {
        id: "evt_2",
        type: "task:completed",
        requestId: "req_AAA",
        seq: 2,
        payloadJson: JSON.stringify({}),
      },
    ];
    useChatStore.getState().hydrateFromSnapshot(TASK, events);
    const after1 = JSON.parse(JSON.stringify(getConv(TASK)));
    useChatStore.getState().hydrateFromSnapshot(TASK, events);
    const after2 = JSON.parse(JSON.stringify(getConv(TASK)));
    expect(after2).toEqual(after1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// hydrateUserPrompts (cold-load /messages → user.content)
// ──────────────────────────────────────────────────────────────────────

describe("hydrateAttachments", () => {
  // Helper: seed a stream-delta event so projectSnapshot produces an
  // Exchange for the given requestId. task:completed alone doesn't
  // create one in the projector.
  const seedExchange = (rid: string, ord: number = 1): SnapshotEvent => ({
    id: `evt_${rid}_${ord}`,
    type: "leader.stream_delta",
    requestId: rid,
    seq: ord,
    payloadJson: JSON.stringify({ type: "text_delta", text: " " }),
  });

  test("groups by requestId and stamps user.attachments on matching exchange", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      seedExchange("req_A"),
      seedExchange("req_B"),
    ]);
    useChatStore.getState().hydrateAttachments(TASK, [
      { requestId: "req_A", filename: "a.md", mimeType: "text/markdown", sizeBytes: 100 },
      { requestId: "req_A", filename: "b.png", mimeType: "image/png", sizeBytes: 200 },
      { requestId: "req_B", filename: "c.pdf", mimeType: "application/pdf", sizeBytes: 300 },
    ]);
    const conv = getConv(TASK);
    const exA = conv?.exchanges.find((e) => e.id === "req_A");
    const exB = conv?.exchanges.find((e) => e.id === "req_B");
    expect(exA?.user.attachments?.map((a) => a.filename)).toEqual(["a.md", "b.png"]);
    expect(exB?.user.attachments?.map((a) => a.filename)).toEqual(["c.pdf"]);
  });

  test("idempotent: replaying the same input doesn't change state", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [seedExchange("req_A")]);
    const input = [{ requestId: "req_A", filename: "a.md", mimeType: "text/markdown", sizeBytes: 1 }];
    useChatStore.getState().hydrateAttachments(TASK, input);
    const before = getConv(TASK)?.exchanges[0];
    useChatStore.getState().hydrateAttachments(TASK, input);
    const after = getConv(TASK)?.exchanges[0];
    expect(after).toBe(before); // same object reference — no re-render trigger
  });

  test("attachments with null requestId are dropped (legacy / pre-migration uploads)", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [seedExchange("req_A")]);
    useChatStore.getState().hydrateAttachments(TASK, [
      { requestId: null, filename: "orphan.md", mimeType: "text/markdown", sizeBytes: 1 },
    ]);
    expect(getConv(TASK)?.exchanges[0]?.user.attachments).toBeUndefined();
  });
});

describe("hydrateUserPrompts", () => {
  test("legacy tail-pair fallback when no prompts carry requestId", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_1", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "answer1" }) },
      { id: "e2", type: "task:completed", requestId: "req_1", seq: 2,
        payloadJson: JSON.stringify({}) },
      { id: "e3", type: "leader.stream_delta", requestId: "req_2", seq: 3,
        payloadJson: JSON.stringify({ type: "text_delta", text: "answer2" }) },
      { id: "e4", type: "task:completed", requestId: "req_2", seq: 4,
        payloadJson: JSON.stringify({}) },
    ]);
    let conv = getConv(TASK)!;
    expect(conv.exchanges).toHaveLength(2);
    expect(conv.exchanges.every((e) => e.user.content === "")).toBe(true);

    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "first prompt" },
      { content: "second prompt" },
    ]);
    conv = getConv(TASK)!;
    expect(conv.exchanges[0]?.user.content).toBe("first prompt");
    expect(conv.exchanges[1]?.user.content).toBe("second prompt");
  });

  test("requestId-based binding matches prompt to exchange by id, immune to count drift", () => {
    // Exchange seeded with req_2; prompts list also includes a phantom for
    // req_1 (cap-evicted exchange). Without requestId binding, tail-pair
    // would put "the second one" into the only seeded exchange — wrong.
    // With requestId binding, "the second one" lands on the right exchange
    // and the orphan prompt for req_1 silently skips.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_2", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "ok" }) },
    ]);
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "the first one (orphan)", requestId: "req_1" },
      { content: "the second one", requestId: "req_2" },
    ]);
    const conv = getConv(TASK)!;
    expect(conv.exchanges).toHaveLength(1);
    expect(conv.exchanges[0]?.user.content).toBe("the second one");
  });

  test("never overwrites populated user.content", () => {
    const id = useChatStore.getState().beginExchange(TASK, "local prompt");
    useChatStore.getState().bindRequestId(id, TASK, "req_X");
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "api prompt", requestId: "req_X" },
    ]);
    expect(getConv(TASK)?.exchanges[0]?.user.content).toBe("local prompt");
  });

  test("idempotent: calling twice with same input is a no-op", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_1", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "a" }) },
    ]);
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "the prompt", requestId: "req_1" },
    ]);
    const before = JSON.parse(JSON.stringify(getConv(TASK)));
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "the prompt", requestId: "req_1" },
    ]);
    const after = JSON.parse(JSON.stringify(getConv(TASK)));
    expect(after).toEqual(before);
  });

  test("CR Finding 1: prompt_merged-then-hydrate preserves both canonical and folded prompts (cold load)", () => {
    // Snapshot replay order: events apply BEFORE /messages hydrate.
    // Bug repro: events apply prompt_merged event, which writes the
    // folded mailbox content ("B mailbox") into target req_A.user.content.
    // Then hydrateUserPrompts runs with the canonical initial "A initial"
    // for req_A and a phantom for req_B (cap-evicted source). Pre-fix:
    // hydrate refused to write because content was non-empty → "A initial"
    // was LOST and req_A.user.content showed only "B mailbox" — UI
    // misattributed the leader's run to the wrong prompt.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_A", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "leader work" }) },
      { id: "e2", type: "task.prompt_merged", requestId: "req_A", seq: 2,
        payloadJson: JSON.stringify({
          sourceRequestId: "req_B",
          intoRequestId: "req_A",
          content: "B mailbox",
        }) },
    ]);
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "A initial", requestId: "req_A" },
      { content: "B mailbox", requestId: "req_B" }, // phantom — req_B exchange doesn't exist
    ]);
    const conv = getConv(TASK)!;
    expect(conv.exchanges).toHaveLength(1);
    const content = conv.exchanges[0]?.user.content ?? "";
    expect(content).toContain("A initial");
    expect(content).toContain("B mailbox");
    // Canonical comes first (prepended on hydrate when content was
    // already populated by the fold).
    expect(content.indexOf("A initial")).toBeLessThan(content.indexOf("B mailbox"));
  });

  test("CR Finding 3: mixed-mode hydration backfills legacy prompts via tail-pair when some new prompts have requestId", () => {
    // Pre-fix: presence of ANY prompt with requestId triggered an
    // early return from the requestId-binding branch, leaving legacy
    // prompts (no requestId) unbound. Fix runs tail-pair as a second
    // pass for the legacy prompts only.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_legacy", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "old" }) },
      { id: "e2", type: "leader.stream_delta", requestId: "req_new", seq: 2,
        payloadJson: JSON.stringify({ type: "text_delta", text: "new" }) },
    ]);
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "legacy prompt (no requestId)" },
      { content: "new prompt", requestId: "req_new" },
    ]);
    const conv = getConv(TASK)!;
    const legacyEx = conv.exchanges.find((e) => e.id === "req_legacy");
    const newEx = conv.exchanges.find((e) => e.id === "req_new");
    expect(newEx?.user.content).toBe("new prompt");
    expect(legacyEx?.user.content).toBe("legacy prompt (no requestId)");
  });

  test("CR Finding 5: substring overlap doesn't suppress a distinct prompt", () => {
    // Pre-fix used `existing.includes(foldedContent)` for idempotency
    // — would drop a follow-up prompt whose text was a substring of an
    // earlier prompt even though they're distinct messages.
    // hydratedRequestIds is the authoritative tracker.
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_A", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "ok" }) },
      { id: "e2", type: "task.prompt_merged", requestId: "req_A", seq: 2,
        payloadJson: JSON.stringify({
          sourceRequestId: "req_B",
          intoRequestId: "req_A",
          content: "go", // a substring of "go ahead" below
        }) },
      { id: "e3", type: "task.prompt_merged", requestId: "req_A", seq: 3,
        payloadJson: JSON.stringify({
          sourceRequestId: "req_C",
          intoRequestId: "req_A",
          content: "go ahead",
        }) },
    ]);
    useChatStore.getState().hydrateUserPrompts(TASK, [
      { content: "A initial", requestId: "req_A" },
    ]);
    const conv = getConv(TASK)!;
    const content = conv.exchanges[0]?.user.content ?? "";
    expect(content).toContain("A initial");
    expect(content).toContain("go");
    expect(content).toContain("go ahead");
  });
});

// ──────────────────────────────────────────────────────────────────────
// hasModernEvents (legacy task fallback)
// ──────────────────────────────────────────────────────────────────────

describe("hasModernEvents", () => {
  test("returns false for an unknown task", () => {
    expect(useChatStore.getState().hasModernEvents("never_seen")).toBe(false);
  });

  test("returns false when snapshot dropped all events (all NULL requestId — legacy)", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: null, seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "legacy" }) },
    ]);
    expect(useChatStore.getState().hasModernEvents(TASK)).toBe(false);
  });

  test("returns true after a modern (requestId-tagged) event hydrated", () => {
    useChatStore.getState().hydrateFromSnapshot(TASK, [
      { id: "e1", type: "leader.stream_delta", requestId: "req_X", seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "hi" }) },
    ]);
    expect(useChatStore.getState().hasModernEvents(TASK)).toBe(true);
  });

  // Codex blocker 3 fix (commit 0c9842c): a pure-optimistic exchange
  // — created by beginExchange/bindRequestId before any server event has
  // been applied — must NOT flip the modern gate. Otherwise typing a
  // follow-up on a legacy task would blank the user's history before SSE
  // catches up.
  test("returns false when a conversation exists but only via optimistic exchange (lastAppliedSeq=0)", () => {
    const localId = useChatStore.getState().beginExchange(TASK, "fresh send");
    useChatStore.getState().bindRequestId(localId, TASK, "req_optimistic");
    expect(useChatStore.getState().conversations[TASK]?.exchanges).toHaveLength(1);
    expect(useChatStore.getState().conversations[TASK]?.exchanges[0]?.lastAppliedSeq).toBe(0);
    expect(useChatStore.getState().hasModernEvents(TASK)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// pendingExchangeId selector
// ──────────────────────────────────────────────────────────────────────

describe("pendingExchangeId", () => {
  test("returns the latest non-terminal exchange id", () => {
    const idA = useChatStore.getState().beginExchange(TASK, "first");
    useChatStore.getState().bindRequestId(idA, TASK, "req_A");
    applyEvents(TASK, [eventOf("task:completed", "req_A", {})]);
    expect(useChatStore.getState().pendingExchangeId(TASK)).toBe(null);

    const idB = useChatStore.getState().beginExchange(TASK, "second");
    expect(useChatStore.getState().pendingExchangeId(TASK)).toBe(idB);
    useChatStore.getState().bindRequestId(idB, TASK, "req_B");
    expect(useChatStore.getState().pendingExchangeId(TASK)).toBe("req_B");
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseWireEvent
// ──────────────────────────────────────────────────────────────────────

describe("parseWireEvent", () => {
  test("happy path: top-level requestId/seq/data", () => {
    const wire = parseWireEvent("leader.stream_delta", {
      requestId: "req_X",
      seq: 5,
      data: { type: "text_delta", text: "hi" },
    });
    expect(wire?.requestId).toBe("req_X");
    expect(wire?.seq).toBe(5);
    expect(wire?.data).toEqual({ type: "text_delta", text: "hi" });
  });

  test("falls back to top-level fields if no wrapped data field", () => {
    const wire = parseWireEvent("leader.tool_call", {
      requestId: "req_X",
      seq: 7,
      toolUseId: "toolu_1",
      toolName: "web_search",
    });
    expect(wire?.data.toolUseId).toBe("toolu_1");
    expect(wire?.data.toolName).toBe("web_search");
  });

  test("returns null for malformed payloads (missing requestId or seq)", () => {
    expect(parseWireEvent("leader.stream_delta", {})).toBe(null);
    expect(parseWireEvent("leader.stream_delta", { requestId: "req_X" })).toBe(null);
    expect(parseWireEvent("leader.stream_delta", { seq: 5 })).toBe(null);
    expect(parseWireEvent("leader.stream_delta", null)).toBe(null);
  });
});
