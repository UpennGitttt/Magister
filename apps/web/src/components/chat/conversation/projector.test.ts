import { describe, expect, test } from "bun:test";

import {
  applyEvent,
  applyEvents,
  createOptimisticExchange,
  projectSnapshot,
  textPartId,
  toolPartId,
} from "./projector";
import type { Conversation, SnapshotEvent, WireEvent } from "./types";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const TASK_ID = "task_test";
const REQ_A = "req_AAA";
const REQ_B = "req_BBB";

let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

function emptyConversation(): Conversation {
  return { taskId: TASK_ID, exchanges: [] };
}

function ev(
  type: string,
  requestId: string,
  data: Record<string, unknown>,
): WireEvent {
  return { type, requestId, seq: nextSeq(), data };
}

function evAt(
  type: string,
  requestId: string,
  timestamp: string,
  data: Record<string, unknown>,
): WireEvent {
  return { type, requestId, seq: nextSeq(), timestamp, data };
}

function textDelta(requestId: string, text: string): WireEvent {
  return ev("leader.stream_delta", requestId, { type: "text_delta", text });
}

function toolUseStart(requestId: string, id: string, name: string): WireEvent {
  return ev("leader.stream_delta", requestId, { type: "tool_use_start", id, name });
}

function toolCall(requestId: string, toolUseId: string, name: string, input: unknown = null): WireEvent {
  return ev("leader.tool_call", requestId, { toolUseId, toolName: name, input });
}

function toolResult(
  requestId: string,
  toolUseId: string,
  output: string,
  isError = false,
): WireEvent {
  return ev("leader.tool_result", requestId, { toolUseId, output, isError });
}

function teammateEvent(event: WireEvent, parentToolUseId = "toolu_spawn"): WireEvent {
  return {
    ...event,
    agent: {
      id: "rt_coder",
      role: "coder",
      name: "Coder",
      depth: 1,
      parentToolUseId,
    },
  };
}

function turnComplete(requestId: string): WireEvent {
  return ev("leader.turn_complete", requestId, {});
}

function taskCompleted(requestId: string): WireEvent {
  return ev("task:completed", requestId, { state: "DONE" });
}

function taskFailed(requestId: string): WireEvent {
  return ev("task:failed", requestId, { state: "FAILED" });
}

function taskCancelled(requestId: string): WireEvent {
  return ev("task:cancelled", requestId, { state: "CANCELLED" });
}

function modelError(requestId: string, message: string, durableEventId?: string): WireEvent {
  return {
    type: "leader.model_error",
    requestId,
    seq: nextSeq(),
    data: durableEventId ? { error: message, __eventId: durableEventId } : { error: message },
  };
}

function withOptimistic(prompt: string, exchangeId: string = REQ_A): Conversation {
  return {
    taskId: TASK_ID,
    exchanges: [createOptimisticExchange(exchangeId, prompt)],
  };
}

// ──────────────────────────────────────────────────────────────────────
// Stable part-id derivation (spec §3.4 #3)
// ──────────────────────────────────────────────────────────────────────

describe("part id derivation", () => {
  test("textPartId is stable for (requestId, ordinal)", () => {
    expect(textPartId("req_X", 0)).toBe("req_X:text:0");
    expect(textPartId("req_X", 1)).toBe("req_X:text:1");
    expect(textPartId("req_X", 0)).toBe(textPartId("req_X", 0));
  });

  test("toolPartId is stable for (requestId, toolUseId)", () => {
    expect(toolPartId("req_X", "toolu_a")).toBe("req_X:tool:toolu_a");
    expect(toolPartId("req_X", "toolu_a")).toBe(toolPartId("req_X", "toolu_a"));
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8 fixed-bug-history regression tests (spec §6.1)
// ──────────────────────────────────────────────────────────────────────

describe("regression: 8 fixed bugs", () => {
  test("[2829167] optimistic exchange survives across route-change-style replays", () => {
    seqCounter = 0;
    let state = withOptimistic("hello", REQ_A);

    // Route switched mid-flight (simulated by re-projecting an empty snapshot).
    // chatStore would re-run projectSnapshot([]) on a fresh task — assert the
    // optimistic exchange is preserved when chatStore merges the result back
    // (the projector itself produces the empty result; the merge is the
    // chatStore's job, not the projector's. This test asserts that an
    // empty event log produces an empty Conversation, which is the safe
    // input the chatStore needs).
    const reproject = projectSnapshot(TASK_ID, []);
    expect(reproject.exchanges).toHaveLength(0);
    // The OLD optimistic state is still intact — no mutation occurred.
    expect(state.exchanges).toHaveLength(1);
    expect(state.exchanges[0]?.id).toBe(REQ_A);
  });

  test("[9e48084] exchange id is keyed on requestId, not URL/Zustand mirror", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("hello"), [
      textDelta(REQ_A, "hi"),
      turnComplete(REQ_A),
    ]);
    // Single exchange whose id matches requestId; the projector never reads
    // any selectedTaskId/URL state — pure input-output.
    expect(state.exchanges).toHaveLength(1);
    expect(state.exchanges[0]?.id).toBe(REQ_A);
  });

  test("[9e633ac] second-turn events apply even though first turn already complete", () => {
    seqCounter = 0;
    const startA = withOptimistic("first", REQ_A);
    const after1 = applyEvents(startA, [
      textDelta(REQ_A, "first reply"),
      taskCompleted(REQ_A),
    ]);
    expect(after1.exchanges[0]?.status).toBe("complete");

    // chatStore.beginExchange would create the second optimistic exchange
    // before its events flow.
    const startB: Conversation = {
      ...after1,
      exchanges: [...after1.exchanges, createOptimisticExchange(REQ_B, "second")],
    };
    const after2 = applyEvents(startB, [
      textDelta(REQ_B, "second reply"),
      taskCompleted(REQ_B),
    ]);
    expect(after2.exchanges).toHaveLength(2);
    expect(after2.exchanges[1]?.id).toBe(REQ_B);
    expect(after2.exchanges[1]?.status).toBe("complete");
    const part = after2.exchanges[1]?.response.parts[0];
    expect(part?.kind).toBe("text");
    if (part?.kind === "text") expect(part.content).toBe("second reply");
  });

  test("[e35d106] no ghost streaming-empty bubble inserted before optimistic-user", () => {
    seqCounter = 0;
    // Optimistic exchange exists. NO events have flowed yet.
    const state = withOptimistic("hello", REQ_A);
    expect(state.exchanges).toHaveLength(1);
    // Response has zero parts — no ghost. The projector model has no
    // empty placeholder concept; parts only exist if events created them.
    expect(state.exchanges[0]?.response.parts).toHaveLength(0);
    expect(state.exchanges[0]?.status).toBe("pending");
  });

  test("[b83f191] reconnect snapshot replay produces identical state", () => {
    seqCounter = 0;
    const start = withOptimistic("hello", REQ_A);
    const events: WireEvent[] = [
      textDelta(REQ_A, "abc"),
      textDelta(REQ_A, "def"),
      taskCompleted(REQ_A),
    ];
    const first = applyEvents(start, events);
    // Reconnect: the SAME events arrive again (the snapshot includes them).
    const second = applyEvents(start, events);
    // Same input → byte-identical state. (Function references inside parts
    // would differ if we put closures there; we don't.)
    expect(structuredClone(second)).toEqual(structuredClone(first));
  });

  test("[cb4a7bf] tool-call-only turn produces no empty assistant text part", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("describe the repo"), [
      // Leader fires tool calls before any text.
      toolCall(REQ_A, "toolu_1", "list_dir", { path: "." }),
      toolResult(REQ_A, "toolu_1", "[apps,packages]"),
      toolCall(REQ_A, "toolu_2", "read_file", { path: "README.md" }),
      toolResult(REQ_A, "toolu_2", "# Magister"),
      // Then text streams.
      textDelta(REQ_A, "Here's the layout."),
      turnComplete(REQ_A),
    ]);
    const parts = state.exchanges[0]?.response.parts ?? [];
    // No empty text part at the start.
    expect(parts[0]?.kind).toBe("tool");
    // Exactly two tool parts and one text part.
    expect(parts.filter((p) => p.kind === "tool")).toHaveLength(2);
    const texts = parts.filter((p) => p.kind === "text");
    expect(texts).toHaveLength(1);
    if (texts[0]?.kind === "text") expect(texts[0].content).toBe("Here's the layout.");
  });

  test("[90dce9f] tool calls dedupe by toolUseId; user message preserved across follow-up turn racing", () => {
    seqCounter = 0;
    let state = applyEvents(withOptimistic("hello"), [
      toolCall(REQ_A, "toolu_1", "web_search", { q: "x" }),
      toolResult(REQ_A, "toolu_1", "result"),
    ]);
    // Terminal for a different requestId arrives (e.g. follow-up turn
    // initiated outside ChatInput, like a PlanCard Approve click). The
    // projector seeds a fresh Exchange for it — same shape as snapshot
    // replay — and REQ_A's existing state is untouched (no mutation
    // bleed-over because ids don't match).
    state = applyEvents(state, [taskCompleted("req_GHOST")]);
    expect(state.exchanges).toHaveLength(2);
    expect(state.exchanges[0]?.id).toBe(REQ_A);
    expect(state.exchanges[0]?.user.content).toBe("hello");
    expect(state.exchanges[0]?.status).not.toBe("complete");
    expect(state.exchanges[1]?.id).toBe("req_GHOST");
    expect(state.exchanges[1]?.status).toBe("complete");

    // Snapshot replay (with ALL events, including the same toolCall again)
    // doesn't double the tool part.
    const replayEvents: WireEvent[] = [
      toolCall(REQ_A, "toolu_1", "web_search", { q: "x" }),
      toolResult(REQ_A, "toolu_1", "result"),
    ];
    const replay = applyEvents(withOptimistic("hello"), [...replayEvents, ...replayEvents]);
    expect(replay.exchanges[0]?.response.parts.filter((p) => p.kind === "tool")).toHaveLength(1);
  });

  test("[5babe93] stale task:completed for a previous requestId does not unlock the current", () => {
    seqCounter = 0;
    const turnA = applyEvents(withOptimistic("first", REQ_A), [
      textDelta(REQ_A, "ok"),
      taskCompleted(REQ_A),
    ]);
    expect(turnA.exchanges[0]?.status).toBe("complete");

    // User submits second turn. chatStore creates the optimistic Exchange
    // for REQ_B.
    const startB: Conversation = {
      ...turnA,
      exchanges: [...turnA.exchanges, createOptimisticExchange(REQ_B, "second")],
    };

    // A stale task:completed for REQ_A re-arrives (e.g. WS replays it).
    // Apply: REQ_A is already complete, dedup drops it; REQ_B is unaffected.
    const after = applyEvents(startB, [taskCompleted(REQ_A)]);
    expect(after.exchanges[1]?.status).toBe("pending");
  });
});

describe("media events", () => {
  test("leader.media_sent appends a MediaPart with a task-scoped API URL", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("show me the screenshot"), [
      ev("leader.media_sent", REQ_A, {
        mediaId: "media_123",
        kind: "image",
        mimeType: "image/png",
        filename: "screenshot.png",
        sizeBytes: 95,
        caption: "Current screen",
        display: "inline",
        width: 1,
        height: 1,
      }),
    ]);

    const part = state.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("media");
    if (part?.kind === "media") {
      expect(part.mediaId).toBe("media_123");
      expect(part.mediaKind).toBe("image");
      expect(part.url).toBe("/api/tasks/task_test/media/media_123");
      expect(part.caption).toBe("Current screen");
      expect(part.width).toBe(1);
      expect(part.height).toBe(1);
    }
  });
});

describe("turn timing", () => {
  test("terminal timing payload is stored on the exchange", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("measure this", REQ_A), [
      textDelta(REQ_A, "done"),
      ev("task:completed", REQ_A, {
        state: "DONE",
        timing: {
          startedAtMs: 1_000,
          completedAtMs: 11_000,
          wallMs: 10_000,
          pausedMs: 4_000,
          elapsedMs: 6_000,
        },
      }),
    ]);

    expect(state.exchanges[0]?.timing).toMatchObject({
      startedAtMs: 1_000,
      completedAtMs: 11_000,
      wallMs: 10_000,
      pausedMs: 4_000,
      elapsedMs: 6_000,
    });
  });

  test("approval pause/resume updates live timing state", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("dangerous command", REQ_A), [
      evAt("leader.approval_requested", REQ_A, "1970-01-01T00:00:03.000Z", {
        approvalId: "approval_1",
        toolName: "bash",
        command: "rm -rf dist",
        reason: "Recursive/forced file deletion",
      }),
      evAt("leader.approval_resolved", REQ_A, "1970-01-01T00:00:07.000Z", {
        approvalId: "approval_1",
        decision: "approved",
      }),
    ]);

    expect(state.exchanges[0]?.timing?.pausedMs).toBe(4_000);
    expect(state.exchanges[0]?.timing?.activePauseStartedAtMs).toBeUndefined();
  });

  test("nested teammate approval also pauses the parent exchange timer", () => {
    seqCounter = 0;
    const nestedStart = evAt("leader.approval_requested", REQ_A, "1970-01-01T00:00:03.000Z", {
      approvalId: "approval_nested",
    });
    nestedStart.agent = {
      id: "rt_coder",
      role: "coder",
      name: "Coder",
      depth: 1,
      parentToolUseId: "toolu_spawn",
    };
    const nestedEnd = evAt("leader.approval_resolved", REQ_A, "1970-01-01T00:00:06.000Z", {
      approvalId: "approval_nested",
      decision: "approved",
    });
    nestedEnd.agent = nestedStart.agent;

    const state = applyEvents(withOptimistic("delegate", REQ_A), [
      nestedStart,
      nestedEnd,
    ]);

    expect(state.exchanges[0]?.timing?.pausedMs).toBe(3_000);
  });

  test("overlapping approvals are counted as one pause window", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("parallel approvals", REQ_A), [
      evAt("leader.approval_requested", REQ_A, "1970-01-01T00:00:03.000Z", {
        approvalId: "approval_a",
      }),
      evAt("leader.approval_requested", REQ_A, "1970-01-01T00:00:05.000Z", {
        approvalId: "approval_b",
      }),
      evAt("leader.approval_resolved", REQ_A, "1970-01-01T00:00:07.000Z", {
        approvalId: "approval_a",
        decision: "approved",
      }),
      evAt("leader.approval_resolved", REQ_A, "1970-01-01T00:00:09.000Z", {
        approvalId: "approval_b",
        decision: "approved",
      }),
    ]);

    expect(state.exchanges[0]?.timing?.pausedMs).toBe(6_000);
    expect(state.exchanges[0]?.timing?.activePauseStartedAtMs).toBeUndefined();
  });
});

describe("runtime recovery notices", () => {
  test("snapshot replay attaches task-scoped recovery events without requestId to the latest exchange", () => {
    seqCounter = 0;
    const conv = projectSnapshot(TASK_ID, [
      {
        id: "evt_prior_text",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "working..." }),
      },
      {
        id: "evt_task_scoped_recovery",
        type: "task.orchestration.transition",
        requestId: null,
        seq: 2,
        occurredAt: "2026-05-12T08:01:00.000Z",
        payloadJson: JSON.stringify({
          action: "retry",
          reason: "runtime_recovery_stale_running",
          previousState: "RUNNING",
          state: "IN_PROGRESS",
          runId: "rt_recovered",
        }),
      },
    ]);

    const parts = conv.exchanges[0]?.response.parts ?? [];
    const notice = parts.find((part) => part.kind === "system");
    expect(notice?.kind).toBe("system");
    if (notice?.kind === "system") {
      expect(notice.variant).toBe("recovery");
      expect(notice.detail).toContain("runtime_recovery_stale_running");
    }
  });

  test("runtime recovery retry transition projects into a chat system notice", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("keep working", REQ_A), [
      evAt("task.orchestration.transition", REQ_A, "2026-05-12T08:01:00.000Z", {
        action: "retry",
        reason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        state: "IN_PROGRESS",
        runId: "rt_recovered",
      }),
    ]);

    const part = state.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("system");
    if (part?.kind === "system") {
      expect(part.variant).toBe("recovery");
      expect(part.headline).toContain("Recovered");
      expect(part.detail).toContain("runtime_recovery_stale_running");
      expect(part.detail).toContain("RUNNING");
      expect(part.detail).toContain("IN_PROGRESS");
    }
  });

  test("runtime recovery exhaustion projects into an actionable blocked notice", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("keep working", REQ_A), [
      evAt("task.orchestration.stopped", REQ_A, "2026-05-12T08:02:00.000Z", {
        action: "block",
        stopReason: "runtime_recovery_exhausted",
        previousState: "RUNNING",
        state: "BLOCKED",
        runId: "rt_blocked",
      }),
    ]);

    const part = state.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("system");
    if (part?.kind === "system") {
      expect(part.variant).toBe("recovery_blocked");
      expect(part.headline).toContain("Blocked by recovery");
      expect(part.detail).toContain("user action needed");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5 failure-mode tests (Codex review, spec §3.4)
// ──────────────────────────────────────────────────────────────────────

describe("Codex-flagged failure modes", () => {
  test("duplicate event delivery on reconnect is a no-op", () => {
    seqCounter = 0;
    const events = [
      textDelta(REQ_A, "alpha"),
      textDelta(REQ_A, "beta"),
      taskCompleted(REQ_A),
    ];
    const once = applyEvents(withOptimistic("hi"), events);
    const twice = applyEvents(once, events);
    // Second pass: every event already applied (seq <= lastAppliedSeq).
    // State unchanged.
    expect(structuredClone(twice)).toEqual(structuredClone(once));
  });

  test("non-deterministic ordering input is normalized by seq", () => {
    seqCounter = 0;
    const e1 = textDelta(REQ_A, "alpha "); // seq 1
    const e2 = textDelta(REQ_A, "beta"); // seq 2
    const e3 = taskCompleted(REQ_A); // seq 3

    // Input shuffled — projector sorts by seq internally.
    const state = applyEvents(withOptimistic("hi"), [e3, e1, e2]);
    const text = state.exchanges[0]?.response.parts[0];
    if (text?.kind === "text") {
      expect(text.content).toBe("alpha beta");
    } else {
      throw new Error("expected text part");
    }
    expect(state.exchanges[0]?.status).toBe("complete");
  });

  test("partial optimistic + persisted reconciliation: events applied to existing optimistic", () => {
    seqCounter = 0;
    // chatStore registered the optimistic exchange BEFORE events flow.
    const start = withOptimistic("hello", REQ_A);
    const state = applyEvents(start, [
      textDelta(REQ_A, "world"),
      turnComplete(REQ_A),
      taskCompleted(REQ_A),
    ]);
    // Same exchange (id matches), prompt preserved, response populated.
    expect(state.exchanges).toHaveLength(1);
    expect(state.exchanges[0]?.id).toBe(REQ_A);
    expect(state.exchanges[0]?.user.content).toBe("hello");
    expect(state.exchanges[0]?.status).toBe("complete");
  });

  test("part ids stable under different traversal order — derived from (requestId, ordinal/toolUseId)", () => {
    seqCounter = 0;
    // Sequence A: text, tool, text
    const stateA = applyEvents(withOptimistic("hi"), [
      textDelta(REQ_A, "first segment"),
      toolUseStart(REQ_A, "toolu_X", "web_search"),
      toolCall(REQ_A, "toolu_X", "web_search", null),
      toolResult(REQ_A, "toolu_X", "ok"),
      textDelta(REQ_A, "second segment"),
      turnComplete(REQ_A),
    ]);
    const partsA = stateA.exchanges[0]?.response.parts ?? [];
    // Three parts: text(0), tool, text(1).
    expect(partsA[0]?.id).toBe(textPartId(REQ_A, 0));
    expect(partsA[1]?.id).toBe(toolPartId(REQ_A, "toolu_X"));
    expect(partsA[2]?.id).toBe(textPartId(REQ_A, 1));

    // Reset seq, replay same logical events with different seq numbers
    // — part ids are independent of seq.
    seqCounter = 1000;
    const stateB = applyEvents(withOptimistic("hi"), [
      textDelta(REQ_A, "first segment"),
      toolUseStart(REQ_A, "toolu_X", "web_search"),
      toolCall(REQ_A, "toolu_X", "web_search", null),
      toolResult(REQ_A, "toolu_X", "ok"),
      textDelta(REQ_A, "second segment"),
      turnComplete(REQ_A),
    ]);
    expect(stateB.exchanges[0]?.response.parts.map((p) => p.id))
      .toEqual(partsA.map((p) => p.id));
  });

  test("interleaved events for different requestIds seed separate exchanges", () => {
    seqCounter = 0;
    const start = withOptimistic("first", REQ_A);
    // Mix of REQ_A events AND a different REQ_GHOST (e.g. backend
    // started a new turn after a Plan approve sentinel). Both should
    // get exchanges; events stay segregated by requestId.
    const state = applyEvents(start, [
      textDelta(REQ_A, "ok"),
      ev("leader.stream_delta", "req_GHOST", { type: "text_delta", text: "ghost text" }),
      toolCall("req_GHOST", "toolu_g", "noop"),
      taskCompleted(REQ_A),
    ]);
    expect(state.exchanges).toHaveLength(2);
    const a = state.exchanges.find((e) => e.id === REQ_A);
    const g = state.exchanges.find((e) => e.id === "req_GHOST");
    expect(a?.response.parts).toHaveLength(1);
    expect(g?.response.parts).toHaveLength(2); // text + tool
    expect(a?.status).toBe("complete");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Snapshot replay (spec §4.6 idempotent hydration)
// ──────────────────────────────────────────────────────────────────────

describe("projectSnapshot — cold-load hydration", () => {
  test("groups events by requestId, drops legacy NULL-requestId rows", () => {
    const events: SnapshotEvent[] = [
      // Legacy event with no requestId — dropped.
      {
        id: "evt_legacy",
        type: "leader.stream_delta",
        requestId: null,
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "legacy" }),
      },
      {
        id: "evt_a1",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 2,
        payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }),
      },
      {
        id: "evt_a2",
        type: "task:completed",
        requestId: REQ_A,
        seq: 3,
        payloadJson: JSON.stringify({}),
      },
      {
        id: "evt_b1",
        type: "leader.stream_delta",
        requestId: REQ_B,
        seq: 4,
        payloadJson: JSON.stringify({ type: "text_delta", text: "beta" }),
      },
    ];
    const conv = projectSnapshot(TASK_ID, events);
    expect(conv.exchanges.map((e) => e.id)).toEqual([REQ_A, REQ_B]);
    const reqA = conv.exchanges[0];
    expect(reqA?.status).toBe("complete");
    const text = reqA?.response.parts[0];
    if (text?.kind === "text") expect(text.content).toBe("alpha");
  });

  test("idempotent: projecting the same snapshot twice yields identical state", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_a1",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }),
      },
      {
        id: "evt_a2",
        type: "leader.tool_call",
        requestId: REQ_A,
        seq: 2,
        payloadJson: JSON.stringify({ toolUseId: "toolu_1", toolName: "x" }),
      },
      {
        id: "evt_a3",
        type: "leader.tool_result",
        requestId: REQ_A,
        seq: 3,
        payloadJson: JSON.stringify({ toolUseId: "toolu_1", output: "ok" }),
      },
    ];
    const a = projectSnapshot(TASK_ID, events);
    const b = projectSnapshot(TASK_ID, events);
    expect(structuredClone(b)).toEqual(structuredClone(a));
  });

  test("model-error part id uses durable execution_events row id", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_err",
        type: "leader.model_error",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({ error: "rate limited" }),
      },
    ];
    const conv = projectSnapshot(TASK_ID, events);
    const part = conv.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("model-error");
    expect(part?.id).toBe("evt_err");
    if (part?.kind === "model-error") expect(part.message).toBe("rate limited");
  });

  test("requestId carrying ONLY decision_trace does not seed a blank exchange", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_a1",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }),
      },
      {
        id: "evt_a2",
        type: "task:completed",
        requestId: REQ_A,
        seq: 2,
        payloadJson: JSON.stringify({}),
      },
      // REQ_B has ONLY a telemetry decision_trace row — must NOT seed an exchange.
      {
        id: "evt_b_trace",
        type: "leader.decision_trace",
        requestId: REQ_B,
        seq: 3,
        payloadJson: JSON.stringify({ contextUtilization: 0.25 }),
      },
    ];
    const conv = projectSnapshot(TASK_ID, events);
    expect(conv.exchanges.map((e) => e.id)).toEqual([REQ_A]); // no blank REQ_B stub
  });

  test("decision_trace mixed with real content does not change rendered output", () => {
    const withTrace: SnapshotEvent[] = [
      { id: "evt_a1", type: "leader.stream_delta", requestId: REQ_A, seq: 1, payloadJson: JSON.stringify({ type: "text_delta", text: "alpha" }) },
      { id: "evt_trace", type: "leader.decision_trace", requestId: REQ_A, seq: 2, payloadJson: JSON.stringify({ contextUtilization: 0.5 }) },
      { id: "evt_a2", type: "task:completed", requestId: REQ_A, seq: 3, payloadJson: JSON.stringify({}) },
    ];
    const without = withTrace.filter((e) => e.type !== "leader.decision_trace");
    expect(structuredClone(projectSnapshot(TASK_ID, withTrace))).toEqual(
      structuredClone(projectSnapshot(TASK_ID, without)),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Live SSE event handling
// ──────────────────────────────────────────────────────────────────────

describe("live event semantics", () => {
  test("text → tool boundary seals previous text part; next text opens fresh part", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("hi"), [
      textDelta(REQ_A, "before"),
      toolUseStart(REQ_A, "toolu_1", "web_search"),
      toolCall(REQ_A, "toolu_1", "web_search"),
      toolResult(REQ_A, "toolu_1", "ok"),
      textDelta(REQ_A, "after"),
      turnComplete(REQ_A),
    ]);
    const parts = state.exchanges[0]?.response.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "text"]);
    if (parts[0]?.kind === "text") {
      expect(parts[0].content).toBe("before");
      expect(parts[0].sealed).toBe(true);
    }
    if (parts[2]?.kind === "text") {
      expect(parts[2].content).toBe("after");
      expect(parts[2].sealed).toBe(true);
    }
  });

  test("model_error after text seals the text part and surfaces the error part", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("hi"), [
      textDelta(REQ_A, "partial..."),
      modelError(REQ_A, "context length exceeded"),
      taskFailed(REQ_A),
    ]);
    const parts = state.exchanges[0]?.response.parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(["text", "model-error"]);
    expect(state.exchanges[0]?.status).toBe("failed");
    if (parts[0]?.kind === "text") expect(parts[0].sealed).toBe(true);
  });

  test("tool result without preceding tool call is dropped silently", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("hi"), [
      toolResult(REQ_A, "toolu_orphan", "stale"),
      textDelta(REQ_A, "ok"),
      turnComplete(REQ_A),
    ]);
    const parts = state.exchanges[0]?.response.parts ?? [];
    expect(parts.filter((p) => p.kind === "tool")).toHaveLength(0);
  });

  test("toolCall is idempotent (replay-safe)", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("hi"), [
      toolCall(REQ_A, "toolu_1", "web_search"),
      toolCall(REQ_A, "toolu_1", "web_search"), // duplicate
      toolResult(REQ_A, "toolu_1", "ok"),
    ]);
    expect(state.exchanges[0]?.response.parts.filter((p) => p.kind === "tool")).toHaveLength(1);
  });

  test("event with seq <= lastAppliedSeq is dropped (event-level dedup)", () => {
    seqCounter = 0;
    let state = applyEvents(withOptimistic("hi"), [
      textDelta(REQ_A, "alpha"),
    ]);
    expect(state.exchanges[0]?.lastAppliedSeq).toBeGreaterThan(0);

    // Inject a duplicate with the SAME seq.
    const stale: WireEvent = {
      type: "leader.stream_delta",
      requestId: REQ_A,
      seq: state.exchanges[0]!.lastAppliedSeq, // same as already applied
      data: { type: "text_delta", text: "DOUBLED" },
    };
    state = applyEvents(state, [stale]);
    const text = state.exchanges[0]?.response.parts[0];
    if (text?.kind === "text") expect(text.content).toBe("alpha");
    expect(text?.kind === "text" ? text.content.includes("DOUBLED") : true).toBe(false);
  });

  test("older unknown requestId event is dropped instead of seeding a ghost exchange", () => {
    let state = applyEvent(withOptimistic("hi", REQ_A), {
      type: "leader.stream_delta",
      requestId: REQ_A,
      seq: 100,
      data: { type: "text_delta", text: "latest" },
    });
    state = applyEvent(state, {
      type: "leader.stream_delta",
      requestId: "req_windowed_out",
      seq: 50,
      data: { type: "text_delta", text: "old" },
    });

    expect(state.exchanges.map((exchange) => exchange.id)).toEqual([REQ_A]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Teammate transcript scanner (Phase 3a / C3)
// ──────────────────────────────────────────────────────────────────────

describe("teammate transcript scanner", () => {
  test("summarizes spawned teammate runtime, duration, tools, and last meaningful message", () => {
    seqCounter = 0;
    const state = applyEvents(withOptimistic("delegate", REQ_A), [
      toolCall(REQ_A, "toolu_spawn", "spawn_teammate", {
        role: "coder",
        goal: "Implement transcript scanner",
      }),
      evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:01.000Z", {
        parentToolUseId: "toolu_spawn",
        teammateRunId: "rt_coder",
        teammateName: "Coder",
        role: "coder",
        runtimeType: "codex",
        modelName: "gpt-5.3-codex",
      }),
      teammateEvent(toolCall(REQ_A, "toolu_read", "read_file", { path: "projector.ts" })),
      teammateEvent(textDelta(REQ_A, "Found the transcript grouping bug.")),
      evAt("leader.teammate_completed", REQ_A, "1970-01-01T00:01:06.000Z", {
        teammateRunId: "rt_coder",
        reason: "completed",
        summary: "Patched the scanner.",
      }),
    ]);

    const part = state.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") throw new Error("expected spawn_teammate tool part");

    expect(part.teammateRole).toBe("coder");
    expect(part.teammateRuntime).toBe("codex");
    expect(part.teammateModel).toBe("gpt-5.3-codex");
    expect(part.teammateStartedAtMs).toBe(1_000);
    expect(part.teammateCompletedAtMs).toBe(66_000);
    expect(part.teammateToolCount).toBe(1);
    expect(part.teammateLastMessage).toBe("Found the transcript grouping bug.");
    expect(part.teammateStatus).toBe("completed");
    expect(part.transcriptEventCount).toBe(2);
  });

  test("teammate scanner metadata is idempotent under snapshot replay", () => {
    const events: SnapshotEvent[] = [
      {
        id: "evt_spawn_tool",
        type: "leader.tool_call",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({
          toolUseId: "toolu_spawn",
          toolName: "spawn_teammate",
          input: { role: "reviewer", goal: "Review phase 1" },
        }),
      },
      {
        id: "evt_spawned",
        type: "leader.teammate_spawned",
        requestId: REQ_A,
        seq: 2,
        occurredAt: "1970-01-01T00:00:02.000Z",
        payloadJson: JSON.stringify({
          parentToolUseId: "toolu_spawn",
          teammateRunId: "rt_reviewer",
          teammateName: "Reviewer",
          role: "reviewer",
          runtimeType: "opencode",
          modelName: "kimi-k2",
        }),
      },
      {
        id: "evt_nested_tool",
        type: "leader.tool_call",
        requestId: REQ_A,
        seq: 3,
        payloadJson: JSON.stringify({
          toolUseId: "toolu_rg",
          toolName: "rg",
          input: { q: "phase1" },
        }),
        agent: {
          id: "rt_reviewer",
          role: "reviewer",
          name: "Reviewer",
          depth: 1,
          parentToolUseId: "toolu_spawn",
        },
      },
      {
        id: "evt_nested_result",
        type: "leader.tool_result",
        requestId: REQ_A,
        seq: 4,
        payloadJson: JSON.stringify({
          toolUseId: "toolu_rg",
          output: "Phase 1 checks pass",
        }),
        agent: {
          id: "rt_reviewer",
          role: "reviewer",
          name: "Reviewer",
          depth: 1,
          parentToolUseId: "toolu_spawn",
        },
      },
      {
        id: "evt_completed",
        type: "leader.teammate_completed",
        requestId: REQ_A,
        seq: 5,
        occurredAt: "1970-01-01T00:00:12.000Z",
        payloadJson: JSON.stringify({
          teammateRunId: "rt_reviewer",
          reason: "failed",
          error: "review found regressions",
          nextAction: "Fix the regressions, then rerun review.",
        }),
      },
    ];

    const first = projectSnapshot(TASK_ID, events);
    const second = projectSnapshot(TASK_ID, events);

    expect(structuredClone(second)).toEqual(structuredClone(first));
    const part = first.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") throw new Error("expected spawn_teammate tool part");
    expect(part.teammateToolCount).toBe(1);
    expect(part.teammateLastMessage).toBe("Phase 1 checks pass");
    expect(part.teammateFailureReason).toBe("review found regressions");
    expect(part.teammateNextAction).toBe("Fix the regressions, then rerun review.");
  });

  test("routes nested teammate lifecycle events to the nested spawn_teammate tool", () => {
    seqCounter = 0;
    const topTool = toolCall(REQ_A, "toolu_spawn", "spawn_teammate", {
      role: "coder",
      goal: "Implement nested orchestration",
    });
    const topSpawned = evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:01.000Z", {
      parentToolUseId: "toolu_spawn",
      teammateRunId: "rt_coder",
      teammateName: "Coder",
      role: "coder",
    });
    const nestedTool = teammateEvent(toolCall(REQ_A, "toolu_nested_spawn", "spawn_teammate", {
      role: "reviewer",
      goal: "Review nested work",
    }));
    const nestedSpawned = teammateEvent(
      evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:03.000Z", {
        parentToolUseId: "toolu_nested_spawn",
        teammateRunId: "rt_reviewer",
        teammateName: "Reviewer",
        role: "reviewer",
        runtimeType: "opencode",
        modelName: "gpt-5.5",
      }),
      "toolu_spawn",
    );
    const nestedText: WireEvent = {
      ...textDelta(REQ_A, "Nested review complete."),
      agent: {
        id: "rt_reviewer",
        role: "reviewer",
        name: "Reviewer",
        depth: 2,
        parentToolUseId: "toolu_nested_spawn",
      },
    };
    const nestedCompleted: WireEvent = {
      ...evAt("leader.teammate_completed", REQ_A, "1970-01-01T00:00:08.000Z", {
        teammateRunId: "rt_reviewer",
        reason: "completed",
        summary: "Nested review passed.",
      }),
      agent: {
        id: "rt_reviewer",
        role: "reviewer",
        name: "Reviewer",
        depth: 2,
        parentToolUseId: "toolu_nested_spawn",
      },
    };

    const state = applyEvents(withOptimistic("delegate", REQ_A), [
      topTool,
      topSpawned,
      nestedTool,
      nestedSpawned,
      nestedText,
      nestedCompleted,
    ]);

    const top = state.exchanges[0]?.response.parts[0];
    expect(top?.kind).toBe("tool");
    if (top?.kind !== "tool") throw new Error("expected top-level spawn_teammate tool part");
    const nested = top.transcript?.find(
      (part) => part.kind === "tool" && part.toolUseId === "toolu_nested_spawn",
    );
    expect(nested?.kind).toBe("tool");
    if (nested?.kind !== "tool") throw new Error("expected nested spawn_teammate tool part");
    expect(nested.teammateRunId).toBe("rt_reviewer");
    expect(nested.teammateRole).toBe("reviewer");
    expect(nested.teammateStatus).toBe("completed");
    expect(nested.teammateStartedAtMs).toBe(3_000);
    expect(nested.teammateCompletedAtMs).toBe(8_000);
    expect(nested.transcriptEventCount).toBe(1);
    expect(nested.teammateLastMessage).toBe("Nested review complete.");
    expect(nested.transcript?.[0]?.kind).toBe("text");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Plan mode (spec docs/specs/2026-04-26-plan-mode-spec.md §10)
// ──────────────────────────────────────────────────────────────────────

function planProposed(requestId: string, plan: string): WireEvent {
  return ev("leader.plan_proposed", requestId, { plan });
}

function planExited(
  requestId: string,
  reason: "approved" | "cancelled" | "revised",
  feedback?: string,
): WireEvent {
  return ev("leader.plan_mode_exited", requestId, {
    reason,
    ...(feedback !== undefined ? { feedback } : {}),
  });
}

describe("plan mode events", () => {
  test("plan_proposed appends a PlanPart with awaiting_approval status", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [planProposed(REQ_A, "## Plan\n\nstep 1")]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "plan",
      plan: "## Plan\n\nstep 1",
      status: "awaiting_approval",
    });
  });

  test("plan_mode_exited (approved) flips PlanPart status", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      planProposed(REQ_A, "step 1"),
      planExited(REQ_A, "approved"),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "plan") expect(part.status).toBe("approved");
  });

  test("plan_mode_exited (revised) flips status and carries feedback", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      planProposed(REQ_A, "step 1"),
      planExited(REQ_A, "revised", "make it shorter"),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "plan") {
      expect(part.status).toBe("revised");
      expect(part.feedback).toBe("make it shorter");
    }
  });

  test("plan_mode_exited (cancelled) flips status to cancelled", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      planProposed(REQ_A, "step 1"),
      planExited(REQ_A, "cancelled"),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "plan") expect(part.status).toBe("cancelled");
  });

  test("out-of-order: plan_mode_exited BEFORE plan_proposed buffers and resolves on arrival", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    // Reverse the seq order so the exit arrives first
    const exit = planExited(REQ_A, "approved");
    const proposed = planProposed(REQ_A, "buffered plan");
    // Apply in arrival order — exit first, then proposed
    const afterExit = applyEvents(start, [exit]);
    // No PlanPart yet but pendingPlanExit should be set
    expect(afterExit.exchanges[0]?.response.parts).toHaveLength(0);
    expect(afterExit.exchanges[0]?.pendingPlanExit).toEqual({ status: "approved" });

    const afterProposed = applyEvents(afterExit, [proposed]);
    // PlanPart present, status comes from buffered exit, pendingPlanExit cleared
    const part = afterProposed.exchanges[0]?.response.parts.find((p) => p.kind === "plan");
    expect(part?.kind).toBe("plan");
    if (part?.kind === "plan") expect(part.status).toBe("approved");
    expect(afterProposed.exchanges[0]?.pendingPlanExit).toBeUndefined();
  });

  test("multiple plan cycles in one exchange (revise loop)", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      planProposed(REQ_A, "v1"),
      planExited(REQ_A, "revised", "make it shorter"),
      planProposed(REQ_A, "v2"),
      planExited(REQ_A, "approved"),
    ]);
    const planParts = after.exchanges[0]?.response.parts.filter((p) => p.kind === "plan") ?? [];
    expect(planParts).toHaveLength(2);
    if (planParts[0]?.kind === "plan") {
      expect(planParts[0].plan).toBe("v1");
      expect(planParts[0].status).toBe("revised");
    }
    if (planParts[1]?.kind === "plan") {
      expect(planParts[1].plan).toBe("v2");
      expect(planParts[1].status).toBe("approved");
    }
  });

  test("plan_mode_exited with unknown reason is ignored", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      planProposed(REQ_A, "v1"),
      ev("leader.plan_mode_exited", REQ_A, { reason: "weirdo" }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "plan") expect(part.status).toBe("awaiting_approval");
  });

  test("plan_mode_entered emits no part (badge derived from PlanPart presence)", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [createOptimisticExchange(REQ_A, "do X")],
    };
    const after = applyEvents(start, [
      ev("leader.plan_mode_entered", REQ_A, { taskId: TASK_ID, runId: "r" }),
    ]);
    expect(after.exchanges[0]?.response.parts).toHaveLength(0);
  });

  test("approval_requested attaches pendingApproval to most recent unresolved tool", () => {
    const start = withOptimistic("rm cache");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "bash", { command: "rm -rf x" }),
      ev("leader.approval_requested", REQ_A, {
        approvalId: "approval_abc",
        toolName: "bash",
        command: "rm -rf x",
        reason: "Recursive/forced file deletion",
      }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind === "tool") {
      expect(part.pendingApproval).toEqual({
        approvalId: "approval_abc",
        reason: "Recursive/forced file deletion",
        command: "rm -rf x",
        // 2026-05-21 — projector defaults subjectKey to null when the
        // upstream event lacks one (older snapshots, this minimal stub).
        subjectKey: null,
      });
      expect(part.result).toBeNull();
    }
  });

  test("tool_result clears pendingApproval (gate has resolved either way)", () => {
    const start = withOptimistic("rm cache");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "bash", { command: "rm -rf x" }),
      ev("leader.approval_requested", REQ_A, {
        approvalId: "approval_abc",
        toolName: "bash",
        command: "rm -rf x",
        reason: "Recursive/forced file deletion",
      }),
      toolResult(REQ_A, "tu_1", "blocked"),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "tool") {
      expect(part.pendingApproval).toBeUndefined();
      expect(part.result?.output).toBe("blocked");
    }
  });

  test("terminal exchange strips orphan pendingApproval from tool parts", () => {
    // Bash hits the danger gate (approval_requested), but the turn fails
    // before tool_result lands (model error / abort / doom-loop). The
    // inline approval row would otherwise stay visible — clicking it
    // would 404 on the long-expired approval id with no recovery path.
    const start = withOptimistic("rm cache");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "bash", { command: "rm -rf x" }),
      ev("leader.approval_requested", REQ_A, {
        approvalId: "approval_abc",
        toolName: "bash",
        command: "rm -rf x",
        reason: "Recursive/forced file deletion",
      }),
      taskFailed(REQ_A),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "tool") {
      expect(part.pendingApproval).toBeUndefined();
      expect(part.result).toBeNull();
    }
    expect(after.exchanges[0]?.status).toBe("failed");
  });

  test("messages_compacted produces a SystemPart with token stats", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      ev("leader.messages_compacted", REQ_A, {
        preCompactTokens: 12000,
        postCompactTokens: 4500,
        truncatedCount: 2,
        snippedCount: 0,
        droppedCount: 1,
        llmCompacted: true,
      }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("system");
    if (part?.kind === "system") {
      expect(part.variant).toBe("compaction");
      expect(part.headline).toContain("12.0k");
      expect(part.headline).toContain("4.5k");
      expect(part.detail).toContain("Truncated 2 large tool results");
      expect(part.detail).toContain("Dropped 1 oldest turn");
      expect(part.detail).toContain("LLM summary applied");
    }
  });

  test("doom_loop_detected produces a SystemPart with the warning message", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      ev("leader.doom_loop_detected", REQ_A, {
        toolName: "bash",
        fingerprint: "abc",
        count: 3,
        message: "Repeated bash call detected; blocking further attempts.",
      }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "system") {
      expect(part.variant).toBe("doom_loop");
      expect(part.headline).toContain("bash");
      expect(part.headline).toContain("×3");
      expect(part.detail).toContain("Repeated bash call");
    }
  });

  test("max_turns produces a SystemPart with the limit", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      ev("leader.max_turns", REQ_A, { maxTurns: 30, turnCount: 31 }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "system") {
      expect(part.variant).toBe("max_turns");
      expect(part.headline).toContain("30");
    }
  });

  test("system notices dedupe on snapshot replay (same eventId)", () => {
    const start = withOptimistic("hi");
    const eventId = "evt_compaction_1";
    const evCompact = ev("leader.messages_compacted", REQ_A, {
      __eventId: eventId,
      preCompactTokens: 5000,
      postCompactTokens: 2000,
    });
    const after = applyEvents(start, [evCompact, evCompact]);
    const systemParts = after.exchanges[0]?.response.parts.filter((p) => p.kind === "system");
    expect(systemParts).toHaveLength(1);
  });

  test("approval_requested without a matching unresolved tool is ignored", () => {
    // Stale snapshot replay: the original tool_result already cleared
    // pendingApproval. A re-applied approval_requested has nowhere to
    // attach and must not crash or attach to an unrelated part.
    const start = withOptimistic("rm cache");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "bash", { command: "rm -rf x" }),
      toolResult(REQ_A, "tu_1", "blocked"),
      ev("leader.approval_requested", REQ_A, {
        approvalId: "approval_abc",
        toolName: "bash",
        command: "rm -rf x",
        reason: "Recursive/forced file deletion",
      }),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    if (part?.kind === "tool") {
      expect(part.pendingApproval).toBeUndefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Thinking-stream
// Spec: docs/specs/2026-04-28-thinking-stream-spec.md
// ──────────────────────────────────────────────────────────────────────

describe("thinking_delta projection", () => {
  function thinkingDelta(requestId: string, text: string) {
    return ev("leader.stream_delta", requestId, { type: "thinking_delta", text });
  }

  test("first thinking_delta opens a ThinkingPart with stable id", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [thinkingDelta(REQ_A, "Let me think...")]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("thinking");
    if (part?.kind === "thinking") {
      expect(part.id).toBe(`${REQ_A}:thinking:0`);
      expect(part.content).toBe("Let me think...");
      expect(part.sealed).toBe(false);
    }
  });

  test("two thinking_delta extend same ThinkingPart (no second part)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Step 1: "),
      thinkingDelta(REQ_A, "consider X."),
    ]);
    const parts = after.exchanges[0]?.response.parts;
    expect(parts).toHaveLength(1);
    if (parts?.[0]?.kind === "thinking") {
      expect(parts[0].content).toBe("Step 1: consider X.");
    }
  });

  test("text_delta after thinking_delta seals thinking and opens text", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Reasoning..."),
      textDelta(REQ_A, "Answer."),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.kind).toBe("thinking");
    if (parts[0]?.kind === "thinking") expect(parts[0].sealed).toBe(true);
    expect(parts[1]?.kind).toBe("text");
    if (parts[1]?.kind === "text") {
      expect(parts[1].content).toBe("Answer.");
      expect(parts[1].sealed).toBe(false);
    }
  });

  test("tool_use_start after thinking_delta seals thinking (no text part opened)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "I'll list files."),
      ev("leader.stream_delta", REQ_A, { type: "tool_use_start", id: "tu_1", name: "list_dir" }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("thinking");
    if (parts[0]?.kind === "thinking") expect(parts[0].sealed).toBe(true);
  });

  test("leader.tool_call after thinking_delta also seals thinking", () => {
    // Spec checklist callsite: applyToolCall must seal both text AND
    // thinking. Without this fix the tool_call event would only seal
    // text, leaving the thinking part with a live TextBuffer leaking.
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Plan: list."),
      toolCall(REQ_A, "tu_1", "list_dir", { path: "/tmp" }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const thinking = parts.find((p) => p.kind === "thinking");
    expect(thinking?.kind).toBe("thinking");
    if (thinking?.kind === "thinking") expect(thinking.sealed).toBe(true);
  });

  test("turn_complete after thinking_delta seals thinking", () => {
    // Spec checklist callsite: turn_complete handler must seal both
    // text AND thinking. v1 of the spec only sealed text; this test
    // catches the regression where a thinking-only turn would stay
    // "🤔 Thinking..." forever after the turn ends.
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Just thinking."),
      turnComplete(REQ_A),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(1);
    if (parts[0]?.kind === "thinking") expect(parts[0].sealed).toBe(true);
  });

  test("task:completed (markTerminal) seals unsealed thinking", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "incomplete..."),
      taskCompleted(REQ_A),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    if (parts[0]?.kind === "thinking") expect(parts[0].sealed).toBe(true);
    expect(after.exchanges[0]?.status).toBe("complete");
  });

  test("task:failed seals unsealed thinking", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "interrupted..."),
      taskFailed(REQ_A),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    if (parts[0]?.kind === "thinking") expect(parts[0].sealed).toBe(true);
    expect(after.exchanges[0]?.status).toBe("failed");
  });

  test("task:failed stamps in-flight teammate so duration freezes (no infinite Working timer)", () => {
    const start = withOptimistic("delegate", REQ_A);
    const after = applyEvents(start, [
      toolCall(REQ_A, "toolu_spawn_a", "spawn_teammate", {
        role: "coder",
        goal: "Read backend",
      }),
      evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:01.000Z", {
        parentToolUseId: "toolu_spawn_a",
        teammateRunId: "rt_a",
        role: "coder",
      }),
      // Parent task fails BEFORE leader.teammate_completed arrives —
      // the scenario behind the "Working (Xm Ys)" timer that never
      // stops in the chat UI after the user clicks Cancel.
      taskFailed(REQ_A),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") throw new Error("expected tool part");
    expect(part.teammateStatus).toBe("failed");
    expect(typeof part.teammateCompletedAtMs).toBe("number");
    expect(part.teammateFailureReason).toMatch(/Parent task ended/);
  });

  test("task:cancelled stamps in-flight teammate as cancelled so duration freezes", () => {
    const start = withOptimistic("delegate", REQ_A);
    const after = applyEvents(start, [
      toolCall(REQ_A, "toolu_spawn_cancel", "spawn_teammate", {
        role: "reviewer",
        goal: "Audit overfitting risk",
      }),
      evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:01.000Z", {
        parentToolUseId: "toolu_spawn_cancel",
        teammateRunId: "rt_cancel",
        role: "reviewer",
      }),
      taskCancelled(REQ_A),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(after.exchanges[0]?.status).toBe("complete");
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") throw new Error("expected tool part");
    expect(part.teammateStatus).toBe("cancelled");
    expect(typeof part.teammateCompletedAtMs).toBe("number");
    expect(part.teammateFailureReason).toMatch(/cancelled/i);
  });

  test("task:completed leaves already-completed teammates intact", () => {
    const start = withOptimistic("delegate", REQ_A);
    const after = applyEvents(start, [
      toolCall(REQ_A, "toolu_spawn_b", "spawn_teammate", {
        role: "coder",
        goal: "Read frontend",
      }),
      evAt("leader.teammate_spawned", REQ_A, "1970-01-01T00:00:01.000Z", {
        parentToolUseId: "toolu_spawn_b",
        teammateRunId: "rt_b",
        role: "coder",
      }),
      evAt("leader.teammate_completed", REQ_A, "1970-01-01T00:00:05.000Z", {
        teammateRunId: "rt_b",
        reason: "completed",
        summary: "Done.",
      }),
      taskCompleted(REQ_A),
    ]);
    const part = after.exchanges[0]?.response.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") throw new Error("expected tool part");
    expect(part.teammateStatus).toBe("completed");
    expect(part.teammateCompletedAtMs).toBe(5_000);
    expect(part.teammateFailureReason).toBeUndefined();
  });

  test("model_error seals unsealed thinking", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "thinking when error..."),
      modelError(REQ_A, "rate limited"),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const thinking = parts.find((p) => p.kind === "thinking");
    if (thinking?.kind === "thinking") expect(thinking.sealed).toBe(true);
    expect(parts.some((p) => p.kind === "model-error")).toBe(true);
  });

  test("thinking-only response (no text, no tools, then turn_complete)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Decided not to respond."),
      turnComplete(REQ_A),
      taskCompleted(REQ_A),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("thinking");
    if (parts[0]?.kind === "thinking") {
      expect(parts[0].content).toBe("Decided not to respond.");
      expect(parts[0].sealed).toBe(true);
    }
    expect(after.exchanges[0]?.status).toBe("complete");
  });

  test("empty thinking_delta is dropped (no part opened)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [thinkingDelta(REQ_A, "")]);
    expect(after.exchanges[0]?.response.parts).toHaveLength(0);
  });

  test("thinking_delta arriving AFTER a sealed text_delta opens a NEW thinking part", () => {
    // Out-of-order policy: the model emitted thinking after text. We
    // open a new thinking part rather than dropping the content.
    // (Edge case — the renderer will show "🤔 Thinking" between text
    // segments which is unusual but informative.)
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      textDelta(REQ_A, "First answer."),
      ev("leader.turn_complete", REQ_A, {}), // seals text
      thinkingDelta(REQ_A, "Wait, reconsidering..."),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.kind).toBe("text");
    expect(parts[1]?.kind).toBe("thinking");
    if (parts[1]?.kind === "thinking") {
      expect(parts[1].id).toBe(`${REQ_A}:thinking:0`);
      expect(parts[1].sealed).toBe(false);
    }
  });

  test("snapshot replay with thinking deltas reconstructs ThinkingPart", () => {
    seqCounter = 0;
    const events: SnapshotEvent[] = [
      {
        id: "evt_1",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 1,
        payloadJson: JSON.stringify({ type: "thinking_delta", text: "Considering..." }),
      },
      {
        id: "evt_2",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 2,
        payloadJson: JSON.stringify({ type: "thinking_delta", text: " more." }),
      },
      {
        id: "evt_3",
        type: "leader.stream_delta",
        requestId: REQ_A,
        seq: 3,
        payloadJson: JSON.stringify({ type: "text_delta", text: "Answer." }),
      },
      {
        id: "evt_4",
        type: "leader.turn_complete",
        requestId: REQ_A,
        seq: 4,
        payloadJson: JSON.stringify({}),
      },
    ];
    const conv = projectSnapshot(TASK_ID, events);
    const parts = conv.exchanges[0]?.response.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.kind).toBe("thinking");
    if (parts[0]?.kind === "thinking") {
      expect(parts[0].content).toBe("Considering... more.");
      expect(parts[0].sealed).toBe(true); // text_delta + turn_complete both seal
    }
    expect(parts[1]?.kind).toBe("text");
    if (parts[1]?.kind === "text") {
      expect(parts[1].content).toBe("Answer.");
      expect(parts[1].sealed).toBe(true);
    }
  });
});

describe("thinking seal at all 8 callsites (kimi review)", () => {
  function thinkingDelta(requestId: string, text: string) {
    return ev("leader.stream_delta", requestId, { type: "thinking_delta", text });
  }

  test("plan_proposed seals open ThinkingPart before appending PlanPart", async () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Should I plan this?"),
      ev("leader.plan_proposed", REQ_A, { plan: "## Plan\n- step 1" }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const thinking = parts.find((p) => p.kind === "thinking");
    expect(thinking?.kind).toBe("thinking");
    if (thinking?.kind === "thinking") expect(thinking.sealed).toBe(true);
    expect(parts.some((p) => p.kind === "plan")).toBe(true);
  });

  test("messages_compacted SystemNotice seals open ThinkingPart", async () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      thinkingDelta(REQ_A, "Reasoning before compaction..."),
      ev("leader.messages_compacted", REQ_A, {
        preCompactTokens: 5000,
        postCompactTokens: 2000,
      }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const thinking = parts.find((p) => p.kind === "thinking");
    if (thinking?.kind === "thinking") expect(thinking.sealed).toBe(true);
    expect(parts.some((p) => p.kind === "system")).toBe(true);
  });
});

describe("update_plan → TodoListPart projection", () => {
  // Spec: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md §3
  // The leader's `update_plan` tool calls render as a dedicated
  // TodoListPart (not a generic ToolPart row). The structured `input.todos`
  // is the canonical snapshot — each call is a full replacement, not a
  // delta. The matching tool_result is intentionally suppressed (no
  // ToolPart pair to update).

  test("creates a TodoListPart instead of a ToolPart for update_plan", () => {
    const start = withOptimistic("Build a feature");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "update_plan", {
        todos: [
          { content: "Read spec", activeForm: "Reading spec", status: "completed" },
          { content: "Code", activeForm: "Coding", status: "in_progress" },
        ],
      }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts.some((p) => p.kind === "tool")).toBe(false);
    const todo = parts.find((p) => p.kind === "todo_list");
    expect(todo?.kind).toBe("todo_list");
    if (todo?.kind === "todo_list") {
      expect(todo.todos).toHaveLength(2);
      expect(todo.todos[0]!.status).toBe("completed");
      expect(todo.todos[1]!.status).toBe("in_progress");
    }
  });

  test("each update_plan call appends a new TodoListPart (snapshot semantics)", () => {
    const start = withOptimistic("Multi-step task");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "update_plan", {
        todos: [{ content: "A", activeForm: "Doing A", status: "in_progress" }],
      }),
      textDelta(REQ_A, "Step A done.\n"),
      toolCall(REQ_A, "tu_2", "update_plan", {
        todos: [
          { content: "A", activeForm: "Doing A", status: "completed" },
          { content: "B", activeForm: "Doing B", status: "in_progress" },
        ],
      }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const todoParts = parts.filter((p) => p.kind === "todo_list");
    // Two distinct snapshots — leader's "the latest one is canonical"
    // semantics is preserved by visual ordering, not by deduping.
    expect(todoParts.length).toBe(2);
    const last = todoParts[todoParts.length - 1];
    if (last?.kind === "todo_list") {
      expect(last.todos[0]!.status).toBe("completed");
      expect(last.todos[1]!.status).toBe("in_progress");
    }
  });

  test("ignores update_plan with malformed input (no part inserted)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_x", "update_plan", { todos: "not-an-array" }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    expect(parts.some((p) => p.kind === "todo_list")).toBe(false);
    // And no stray ToolPart either — the special-case branch returned
    // the exchange unchanged.
    expect(parts.some((p) => p.kind === "tool" && p.name === "update_plan")).toBe(false);
  });

  test("seals an open TextPart before inserting the TodoListPart (boundary contract)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      textDelta(REQ_A, "Let me plan: "),
      toolCall(REQ_A, "tu_1", "update_plan", {
        todos: [{ content: "X", activeForm: "Doing X", status: "in_progress" }],
      }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const text = parts.find((p) => p.kind === "text");
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") expect(text.sealed).toBe(true);
  });

  test("update_plan tool_result is silently dropped (no ToolPart to update)", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "update_plan", {
        todos: [{ content: "X", activeForm: "Doing X", status: "in_progress" }],
      }),
      toolResult(REQ_A, "tu_1", "Plan updated successfully"),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    // Still exactly one TodoListPart; tool_result is a no-op.
    expect(parts.filter((p) => p.kind === "todo_list").length).toBe(1);
    expect(parts.some((p) => p.kind === "tool")).toBe(false);
  });

  test("filters out items with invalid status values", () => {
    const start = withOptimistic("hi");
    const after = applyEvents(start, [
      toolCall(REQ_A, "tu_1", "update_plan", {
        todos: [
          { content: "Good", activeForm: "Doing", status: "pending" },
          { content: "Bogus", activeForm: "Doing", status: "blocked" }, // invalid
          { content: "Good2", activeForm: "Doing", status: "completed" },
        ],
      }),
    ]);
    const parts = after.exchanges[0]?.response.parts ?? [];
    const todo = parts.find((p) => p.kind === "todo_list");
    if (todo?.kind === "todo_list") {
      // The invalid-status item is dropped; the surrounding plan still
      // renders so the user isn't shown a blank where there should be 2/3.
      expect(todo.todos.length).toBe(2);
      expect(todo.todos.map((t) => t.content)).toEqual(["Good", "Good2"]);
    }
  });
});

describe("task.prompt_merged fold", () => {
  test("folds orphan optimistic source exchange into run's target — deletes source, appends content", () => {
    // Set up: two exchanges, REQ_A (target / current leader run with
    // prompt "answer to A") and REQ_B (orphan optimistic with prompt
    // "B was the mailbox prompt", no leader output).
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [
        { ...createOptimisticExchange(REQ_A, "first prompt"), status: "streaming" },
        { ...createOptimisticExchange(REQ_B, "B was the mailbox prompt"), status: "streaming" },
      ],
    };
    const merged = applyEvents(start, [
      {
        type: "task.prompt_merged",
        requestId: REQ_A,
        seq: nextSeq(),
        data: {
          sourceRequestId: REQ_B,
          intoRequestId: REQ_A,
          content: "B was the mailbox prompt",
        },
      },
    ]);
    expect(merged.exchanges).toHaveLength(1);
    expect(merged.exchanges[0]?.id).toBe(REQ_A);
    expect(merged.exchanges[0]?.user.content).toContain("first prompt");
    expect(merged.exchanges[0]?.user.content).toContain("B was the mailbox prompt");
    expect(merged.exchanges[0]?.user.content).toContain("---");
  });

  test("source missing (cap-evicted or pre-fix data) — falls back to appending event.content directly", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [{ ...createOptimisticExchange(REQ_A, "main prompt"), status: "streaming" }],
    };
    const merged = applyEvents(start, [
      {
        type: "task.prompt_merged",
        requestId: REQ_A,
        seq: nextSeq(),
        data: {
          sourceRequestId: "req_evicted",
          intoRequestId: REQ_A,
          content: "the missing prompt content",
        },
      },
    ]);
    expect(merged.exchanges).toHaveLength(1);
    expect(merged.exchanges[0]?.user.content).toContain("main prompt");
    expect(merged.exchanges[0]?.user.content).toContain("the missing prompt content");
  });

  test("idempotent: replaying same merge event is a no-op", () => {
    const start: Conversation = {
      taskId: TASK_ID,
      exchanges: [
        { ...createOptimisticExchange(REQ_A, "A"), status: "streaming" },
        { ...createOptimisticExchange(REQ_B, "B"), status: "streaming" },
      ],
    };
    const evMerge = {
      type: "task.prompt_merged",
      requestId: REQ_A,
      seq: nextSeq(),
      data: { sourceRequestId: REQ_B, intoRequestId: REQ_A, content: "B" },
    };
    const once = applyEvents(start, [evMerge]);
    const twice = applyEvents(once, [evMerge]);
    expect(twice).toEqual(once);
  });
});
