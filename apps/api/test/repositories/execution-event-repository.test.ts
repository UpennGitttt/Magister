import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";

const tempRoot = join(process.cwd(), ".tmp-event-repo-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `repo-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("getLatestCheckpointByRunId returns most recent checkpoint", async () => {
  const repo = new ExecutionEventRepository();
  await repo.create({
    id: "evt-1",
    type: "leader.session_checkpoint",
    taskId: "t-1",
    roleRuntimeId: "run-1",
    occurredAt: new Date("2026-04-20T10:00:00Z"),
    payloadJson: JSON.stringify({ turnCount: 1, messages: [] }),
  });
  await repo.create({
    id: "evt-2",
    type: "leader.session_checkpoint",
    taskId: "t-1",
    roleRuntimeId: "run-1",
    occurredAt: new Date("2026-04-20T10:05:00Z"),
    payloadJson: JSON.stringify({ turnCount: 3, messages: [{ type: "user", content: "hello" }] }),
  });
  await repo.create({
    id: "evt-3",
    type: "leader.session_checkpoint",
    taskId: "t-1",
    roleRuntimeId: "run-2",
    occurredAt: new Date("2026-04-20T10:10:00Z"),
    payloadJson: JSON.stringify({ turnCount: 1, messages: [] }),
  });

  const latest = await repo.getLatestCheckpointByRunId("run-1");
  expect(latest).not.toBeNull();
  const payload = JSON.parse(latest!.payloadJson!);
  expect(payload.turnCount).toBe(3);
});

test("getLatestCheckpointByRunId uses seq order when timestamps tie", async () => {
  const repo = new ExecutionEventRepository();
  const occurredAt = new Date("2026-04-20T10:00:00Z");

  await repo.create({
    id: "evt-same-time-1",
    type: "leader.session_checkpoint",
    taskId: "t-same-time",
    roleRuntimeId: "run-same-time",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 1 }),
  });
  await repo.create({
    id: "evt-same-time-2",
    type: "leader.session_checkpoint",
    taskId: "t-same-time",
    roleRuntimeId: "run-same-time",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 2 }),
  });

  const latest = await repo.getLatestCheckpointByRunId("run-same-time");
  expect(latest?.id).toBe("evt-same-time-2");
});

test("getLatestCheckpointByRunId returns null when no checkpoint exists", async () => {
  const repo = new ExecutionEventRepository();
  const latest = await repo.getLatestCheckpointByRunId("nonexistent");
  expect(latest).toBeNull();
});

test("getLatestByTaskIdAndType returns the newest matching task event", async () => {
  const repo = new ExecutionEventRepository();
  const occurredAt = new Date("2026-04-20T10:00:00Z");

  await repo.create({
    id: "evt-noise-1",
    type: "leader.stream_delta",
    taskId: "t-latest-by-type",
    roleRuntimeId: "run-latest-by-type",
    occurredAt,
    payloadJson: JSON.stringify({ delta: "noise" }),
  });
  await repo.create({
    id: "evt-checkpoint-1",
    type: "leader.session_checkpoint",
    taskId: "t-latest-by-type",
    roleRuntimeId: "run-latest-by-type",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 1 }),
  });
  await repo.create({
    id: "evt-checkpoint-2",
    type: "leader.session_checkpoint",
    taskId: "t-latest-by-type",
    roleRuntimeId: "run-latest-by-type",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 2 }),
  });
  await repo.create({
    id: "evt-other-task-newer",
    type: "leader.session_checkpoint",
    taskId: "t-other",
    roleRuntimeId: "run-other",
    occurredAt: new Date("2026-04-20T11:00:00Z"),
    payloadJson: JSON.stringify({ turnCount: 99 }),
  });

  const latest = await repo.getLatestByTaskIdAndType("t-latest-by-type", "leader.session_checkpoint");

  expect(latest?.id).toBe("evt-checkpoint-2");
});

test("listByTaskId returns events in seq order when timestamps tie", async () => {
  const repo = new ExecutionEventRepository();
  const occurredAt = new Date("2026-04-20T10:00:00Z");

  await repo.create({
    id: "evt-tie-1",
    type: "leader.session_checkpoint",
    taskId: "t-tie",
    roleRuntimeId: "run-tie",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 1 }),
  });
  await repo.create({
    id: "evt-tie-2",
    type: "leader.session_checkpoint",
    taskId: "t-tie",
    roleRuntimeId: "run-tie",
    occurredAt,
    payloadJson: JSON.stringify({ turnCount: 2 }),
  });

  const events = await repo.listByTaskId("t-tie");
  expect(events.map((event) => event.id)).toEqual(["evt-tie-1", "evt-tie-2"]);
});

test("requestId persists round-trip via list paths", async () => {
  const repo = new ExecutionEventRepository();
  const occurredAt = new Date("2026-04-25T11:00:00Z");

  await repo.create({
    id: "evt-rid-A",
    type: "leader.stream_delta",
    taskId: "t-rid",
    roleRuntimeId: "run-rid",
    requestId: "req-A",
    occurredAt,
    payloadJson: JSON.stringify({ delta: "first" }),
  });
  await repo.create({
    id: "evt-rid-B",
    type: "leader.stream_delta",
    taskId: "t-rid",
    roleRuntimeId: "run-rid",
    requestId: "req-B",
    occurredAt: new Date("2026-04-25T11:01:00Z"),
    payloadJson: JSON.stringify({ delta: "second" }),
  });
  // Legacy / pre-refactor write — no requestId. Verifies the column is
  // genuinely nullable and reads return null without crashing.
  await repo.create({
    id: "evt-rid-legacy",
    type: "leader.stream_delta",
    taskId: "t-rid",
    roleRuntimeId: "run-rid",
    occurredAt: new Date("2026-04-25T11:02:00Z"),
    payloadJson: JSON.stringify({ delta: "third" }),
  });

  const byTask = await repo.listByTaskId("t-rid");
  const byRunId = await repo.listByRoleRuntimeId("run-rid");
  for (const list of [byTask, byRunId]) {
    const a = list.find((e) => e.id === "evt-rid-A");
    const b = list.find((e) => e.id === "evt-rid-B");
    const legacy = list.find((e) => e.id === "evt-rid-legacy");
    expect(a?.requestId).toBe("req-A");
    expect(b?.requestId).toBe("req-B");
    expect(legacy?.requestId ?? null).toBe(null);
  }
});

test("listByRoleRuntimeIdAndTypes returns only selected event types in seq order", async () => {
  const repo = new ExecutionEventRepository();
  const occurredAt = new Date("2026-04-25T11:00:00Z");

  await repo.create({
    id: "evt-runtime-started",
    type: "executor_session.started",
    taskId: "t-runtime-filter",
    roleRuntimeId: "run-runtime-filter",
    occurredAt,
    payloadJson: JSON.stringify({ message: "started" }),
  });
  await repo.create({
    id: "evt-runtime-delta",
    type: "leader.stream_delta",
    taskId: "t-runtime-filter",
    roleRuntimeId: "run-runtime-filter",
    occurredAt: new Date("2026-04-25T11:00:01Z"),
    payloadJson: JSON.stringify({ delta: "ignored" }),
  });
  await repo.create({
    id: "evt-runtime-completed",
    type: "executor_session.completed",
    taskId: "t-runtime-filter",
    roleRuntimeId: "run-runtime-filter",
    occurredAt: new Date("2026-04-25T11:00:02Z"),
    payloadJson: JSON.stringify({ summary: "done" }),
  });
  await repo.create({
    id: "evt-other-runtime",
    type: "executor_session.completed",
    taskId: "t-runtime-filter",
    roleRuntimeId: "run-other-runtime",
    occurredAt: new Date("2026-04-25T11:00:03Z"),
    payloadJson: JSON.stringify({ summary: "ignored" }),
  });

  const events = await repo.listByRoleRuntimeIdAndTypes("run-runtime-filter", [
    "executor_session.started",
    "executor_session.completed",
  ]);

  expect(events.map((event) => event.id)).toEqual([
    "evt-runtime-started",
    "evt-runtime-completed",
  ]);
});

test("listLatestRequestEvents honors the raw event budget by dropping older requestIds", async () => {
  const repo = new ExecutionEventRepository();
  let eventIndex = 0;
  for (const requestId of ["req-old", "req-middle", "req-new"]) {
    for (let i = 0; i < 3; i++) {
      eventIndex += 1;
      await repo.create({
        id: `evt-budget-${eventIndex}`,
        type: "leader.tool_call",
        taskId: "t-budget",
        roleRuntimeId: "run-budget",
        requestId,
        occurredAt: new Date(`2026-04-25T11:00:${String(eventIndex).padStart(2, "0")}Z`),
        payloadJson: JSON.stringify({ index: eventIndex }),
      });
    }
  }

  const events = await repo.listLatestRequestEvents("t-budget", 3, 4);

  expect([...new Set(events.map((event) => event.requestId))]).toEqual(["req-new"]);
  expect(events).toHaveLength(3);
});

test("listLatestRequestEvents returns a single oversized request in full (rather than dropping the newest turn)", async () => {
  // Regression for the M1 review finding: when the first selected
  // requestId alone exceeds maxRawEvents, the budget-loop's
  // `recentRequestIds.length > 0` guard must skip the budget check
  // on entry zero so the user's most recent (and largest) turn is
  // still returned. Dropping partial events from the latest turn
  // would corrupt the rendered answer; dropping older turns is
  // acceptable.
  const repo = new ExecutionEventRepository();
  for (let i = 0; i < 10; i++) {
    await repo.create({
      id: `evt-oversize-${i}`,
      type: "leader.tool_call",
      taskId: "t-oversize",
      roleRuntimeId: "run-oversize",
      requestId: "req-the-only-one",
      occurredAt: new Date(`2026-04-25T13:00:${String(i).padStart(2, "0")}Z`),
      payloadJson: JSON.stringify({ index: i }),
    });
  }

  // maxRawEvents=4 is tighter than the request's 10 events.
  const events = await repo.listLatestRequestEvents("t-oversize", 5, 4);

  expect(events).toHaveLength(10);
  expect([...new Set(events.map((event) => event.requestId))]).toEqual(["req-the-only-one"]);
});

test("listLatestRequestEvents coalesces stream deltas across DB page boundaries", async () => {
  const repo = new ExecutionEventRepository();
  let lastSeq = 0;
  for (let i = 0; i < 5; i++) {
    lastSeq = await repo.create({
      id: `evt-paged-delta-${i}`,
      type: "leader.stream_delta",
      taskId: "t-paged-coalesce",
      roleRuntimeId: "run-paged-coalesce",
      requestId: "req-paged",
      occurredAt: new Date(`2026-04-25T12:00:0${i}Z`),
      payloadJson: JSON.stringify({ type: "text_delta", text: String(i) }),
    });
  }

  const events = await repo.listLatestRequestEvents("t-paged-coalesce", 1, 50, 2);

  expect(events).toHaveLength(1);
  expect(events[0]?.seq).toBe(lastSeq);
  expect(JSON.parse(events[0]!.payloadJson!)).toEqual({ type: "text_delta", text: "01234" });
});

test("listLatestRequestEvents keeps stream deltas from different agents separate", async () => {
  const repo = new ExecutionEventRepository();
  await repo.create({
    id: "evt-coalesce-leader",
    type: "leader.stream_delta",
    taskId: "t-agent-coalesce",
    roleRuntimeId: "run-leader",
    requestId: "req-agent-coalesce",
    occurredAt: new Date("2026-04-25T14:00:00Z"),
    payloadJson: JSON.stringify({ type: "text_delta", text: "leader " }),
    agentJson: JSON.stringify({ id: "run-leader", role: "leader", depth: 0 }),
  });
  await repo.create({
    id: "evt-coalesce-teammate",
    type: "leader.stream_delta",
    taskId: "t-agent-coalesce",
    roleRuntimeId: "run-coder",
    requestId: "req-agent-coalesce",
    occurredAt: new Date("2026-04-25T14:00:01Z"),
    payloadJson: JSON.stringify({ type: "text_delta", text: "teammate" }),
    agentJson: JSON.stringify({
      id: "run-coder",
      role: "coder",
      depth: 1,
      parentToolUseId: "toolu_spawn",
    }),
    parentToolUseId: "toolu_spawn",
  });

  const events = await repo.listLatestRequestEvents("t-agent-coalesce", 1, 50);

  expect(events).toHaveLength(2);
  expect(events.map((event) => event.roleRuntimeId)).toEqual(["run-leader", "run-coder"]);
  expect(events.map((event) => JSON.parse(event.payloadJson!).text)).toEqual(["leader ", "teammate"]);
});

test("listByTypesSince filters by type set and time window, sorted ascending", async () => {
  const repo = new ExecutionEventRepository();
  await repo.create({
    id: "evt-window-old",
    type: "sentinel.signal",
    occurredAt: new Date("2026-07-13T08:00:00Z"),
    payloadJson: "{}",
  });
  await repo.create({
    id: "evt-window-in-2",
    type: "digest.sent",
    occurredAt: new Date("2026-07-14T10:00:00Z"),
    payloadJson: "{}",
  });
  await repo.create({
    id: "evt-window-in-1",
    type: "sentinel.signal",
    occurredAt: new Date("2026-07-14T09:00:00Z"),
    payloadJson: "{}",
  });
  await repo.create({
    id: "evt-window-wrong-type",
    type: "leader.text",
    taskId: "t-x",
    roleRuntimeId: "run-x",
    occurredAt: new Date("2026-07-14T09:30:00Z"),
    payloadJson: "{}",
  });

  const events = await repo.listByTypesSince(
    ["sentinel.signal", "digest.sent"],
    new Date("2026-07-14T00:00:00Z"),
  );
  expect(events.map((e) => e.id)).toEqual(["evt-window-in-1", "evt-window-in-2"]);
});

test("listByTypesSince returns [] for empty type list and includes boundary timestamp", async () => {
  const repo = new ExecutionEventRepository();
  const boundary = new Date("2026-07-14T00:00:00Z");
  await repo.create({
    id: "evt-boundary",
    type: "sentinel.signal",
    occurredAt: boundary,
    payloadJson: "{}",
  });

  expect(await repo.listByTypesSince([], boundary)).toEqual([]);
  const events = await repo.listByTypesSince(["sentinel.signal"], boundary);
  expect(events.map((e) => e.id)).toEqual(["evt-boundary"]);
});

test("deleteOlderCheckpoints keeps only latest N", async () => {
  const repo = new ExecutionEventRepository();
  for (let i = 1; i <= 5; i++) {
    await repo.create({
      id: `evt-${i}`,
      type: "leader.session_checkpoint",
      taskId: "t-1",
      roleRuntimeId: "run-1",
      occurredAt: new Date(`2026-04-20T10:0${i}:00Z`),
      payloadJson: JSON.stringify({ turnCount: i }),
    });
  }

  await repo.deleteOlderCheckpoints("run-1", 2);

  const remaining = (await repo.listByRoleRuntimeId("run-1"))
    .filter((e) => e.type === "leader.session_checkpoint");
  expect(remaining.length).toBe(2);
  const turns = remaining.map((e) => JSON.parse(e.payloadJson!).turnCount).sort();
  expect(turns).toEqual([4, 5]);
});

// ─────────────────────────────────────────────────────────────────────
// Spec §5 — listByTraceId (root-level trace identifier)
// ─────────────────────────────────────────────────────────────────────

test("listByTraceId returns events matching trace_id, time-sorted", async () => {
  const repo = new ExecutionEventRepository();
  // Two events in trace "trace_a", one event in unrelated trace.
  await repo.create({
    id: "evt-trace-a-2",
    type: "leader.text",
    taskId: "task_root_a",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-05-17T10:01:00Z"),
    payloadJson: "{}",
    traceId: "task_root_a",
  });
  await repo.create({
    id: "evt-trace-a-1",
    type: "leader.text",
    taskId: "task_root_a",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-05-17T10:00:00Z"),
    payloadJson: "{}",
    traceId: "task_root_a",
  });
  await repo.create({
    id: "evt-trace-b",
    type: "leader.text",
    taskId: "task_root_b",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-05-17T10:00:30Z"),
    payloadJson: "{}",
    traceId: "task_root_b",
  });

  const events = await repo.listByTraceId("task_root_a");
  expect(events.map((e) => e.id)).toEqual(["evt-trace-a-1", "evt-trace-a-2"]);
});

test("listByTraceId: COALESCE fallback finds legacy NULL-trace_id events by task_id", async () => {
  const repo = new ExecutionEventRepository();
  // Legacy event predating spec §5 — trace_id NOT set.
  await repo.create({
    id: "evt-legacy",
    type: "leader.text",
    taskId: "task_legacy",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-04-01T10:00:00Z"),
    payloadJson: "{}",
    // traceId omitted — simulates pre-migration row
  });
  // New event with trace_id set, same trace value.
  await repo.create({
    id: "evt-new",
    type: "leader.text",
    taskId: "task_legacy",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-04-01T10:00:01Z"),
    payloadJson: "{}",
    traceId: "task_legacy",
  });

  const events = await repo.listByTraceId("task_legacy");
  expect(events.map((e) => e.id).sort()).toEqual(["evt-legacy", "evt-new"]);
});

test("listByTraceId: NULL-trace_id from different task is NOT included", async () => {
  // Verifies the COALESCE branch is correctly scoped: legacy events
  // from other tasks must not leak into another trace's query.
  const repo = new ExecutionEventRepository();
  await repo.create({
    id: "evt-other-legacy",
    type: "leader.text",
    taskId: "task_OTHER",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-04-01T10:00:00Z"),
    payloadJson: "{}",
  });

  const events = await repo.listByTraceId("task_legacy");
  expect(events).toHaveLength(0);
});

test("listByTraceId respects desc order option", async () => {
  const repo = new ExecutionEventRepository();
  await repo.create({
    id: "evt-1",
    type: "leader.text",
    taskId: "task_t",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-05-17T10:00:00Z"),
    payloadJson: "{}",
    traceId: "task_t",
  });
  await repo.create({
    id: "evt-2",
    type: "leader.text",
    taskId: "task_t",
    roleRuntimeId: "run-leader",
    occurredAt: new Date("2026-05-17T10:05:00Z"),
    payloadJson: "{}",
    traceId: "task_t",
  });

  const desc = await repo.listByTraceId("task_t", { order: "desc" });
  expect(desc.map((e) => e.id)).toEqual(["evt-2", "evt-1"]);
});
