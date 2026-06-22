import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-projector-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `proj-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("createEventProjector records events to execution_events table", async () => {
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");

  const projector = createEventProjector({ taskId: "t-1", runId: "r-1", requestId: "req-fixture" });

  await projector({
    type: "leader.tool_call",
    timestamp: new Date().toISOString(),
    data: { toolName: "bash", inputSummary: "ls -la" },
  });

  const repo = new ExecutionEventRepository();
  const events = await repo.listByTaskId("t-1");
  expect(events.length).toBe(1);
  expect(events[0]!.type).toBe("leader.tool_call");
  const payload = JSON.parse(events[0]!.payloadJson!);
  expect(payload.toolName).toBe("bash");
});

test("createEventProjector caps long summaries at MAX_SUMMARY_LENGTH (50KB)", async () => {
  // Plan v2.1 §6 / Step 1 — UI summary cap raised 500B → 50KB so
  // users can read a teammate's full output. The cap still exists
  // (huge SSE frames hurt the frontend) but is large enough that
  // typical artifacts fit. Above 50KB consumers go to the lazy-load
  // endpoint.
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");

  const projector = createEventProjector({ taskId: "t-1", runId: "r-1", requestId: "req-fixture" });

  // Generate slightly more than the cap so we can verify truncation fires.
  const oversized = "x".repeat(60_000);
  await projector({
    type: "leader.tool_result",
    timestamp: new Date().toISOString(),
    data: { toolName: "bash", outputSummary: oversized, isError: false },
  });

  const repo = new ExecutionEventRepository();
  const events = await repo.listByTaskId("t-1");
  const payload = JSON.parse(events[0]!.payloadJson!);
  expect(payload.outputSummary.length).toBeLessThanOrEqual(50_000);
  // And under-cap content passes through intact.
  await projector({
    type: "leader.tool_result",
    timestamp: new Date().toISOString(),
    data: { toolName: "bash", outputSummary: "y".repeat(1_000), isError: false },
  });
  const events2 = await repo.listByTaskId("t-1");
  const payload2 = JSON.parse(events2[1]!.payloadJson!);
  expect(payload2.outputSummary.length).toBe(1_000);
});

test("createEventProjector includes requestId on ws and SSE emissions", async () => {
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { wsHub } = await import("../../src/ws/hub");
  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  const wsEvents: unknown[] = [];
  const sseEvents: unknown[] = [];
  const originalBroadcast = wsHub.broadcast.bind(wsHub);
  const originalPublish = taskEventBus.publish.bind(taskEventBus);

  wsHub.broadcast = ((taskId, event) => {
    wsEvents.push({ taskId, event });
  }) as typeof wsHub.broadcast;
  taskEventBus.publish = ((taskId, event) => {
    sseEvents.push({ taskId, event });
  }) as typeof taskEventBus.publish;

  try {
    const projector = createEventProjector({
      taskId: "t-request",
      runId: "r-request",
      requestId: "req-123456789012",
    });

    await projector({
      type: "leader.stream_delta",
      timestamp: new Date().toISOString(),
      data: { delta: "hello" },
    });
  } finally {
    wsHub.broadcast = originalBroadcast;
    taskEventBus.publish = originalPublish;
  }

  expect(wsEvents).toHaveLength(1);
  expect(sseEvents).toHaveLength(1);
  expect(wsEvents[0]).toMatchObject({
    taskId: "t-request",
    event: {
      type: "leader.stream_delta",
      requestId: "req-123456789012",
      data: { delta: "hello" },
    },
  });
  expect(sseEvents[0]).toMatchObject({
    taskId: "t-request",
    event: {
      type: "leader.stream_delta",
      requestId: "req-123456789012",
      data: { delta: "hello" },
    },
  });
});

test("createEventProjector honors per-event requestId override (plan-mode resume path)", async () => {
  // When the leader-loop's plan wrapper rewrites
  // `event.data.requestId` (so a `leader.plan_mode_exited` after
  // resume lands in the original PlanCard's exchange), the projector
  // must persist + broadcast THAT id, not the context default.
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const { wsHub } = await import("../../src/ws/hub");
  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  const wsEvents: Array<{ taskId: string; event: { requestId?: string } }> = [];
  const sseEvents: Array<{ taskId: string; event: { requestId?: string } }> = [];
  const originalBroadcast = wsHub.broadcast.bind(wsHub);
  const originalPublish = taskEventBus.publish.bind(taskEventBus);
  wsHub.broadcast = ((taskId, event) => {
    wsEvents.push({ taskId, event: event as { requestId?: string } });
  }) as typeof wsHub.broadcast;
  taskEventBus.publish = ((taskId, event) => {
    sseEvents.push({ taskId, event: event as { requestId?: string } });
  }) as typeof taskEventBus.publish;

  try {
    const projector = createEventProjector({
      taskId: "t-rewrite",
      runId: "r-rewrite",
      requestId: "req_resumed",   // context default
    });

    await projector({
      type: "leader.plan_mode_exited",
      timestamp: new Date().toISOString(),
      data: {
        // Rewritten by autonomous-loop-service.ts so the exit lands
        // on the original plan_proposed's exchange.
        requestId: "req_original_plan",
        reason: "approved",
        runId: "r-rewrite",
        taskId: "t-rewrite",
      },
    });
  } finally {
    wsHub.broadcast = originalBroadcast;
    taskEventBus.publish = originalPublish;
  }

  // DB row uses the override.
  const repo = new ExecutionEventRepository();
  const rows = await repo.listByTaskId("t-rewrite");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.requestId).toBe("req_original_plan");

  // Live emissions also use the override so the frontend projector
  // matches the existing PlanCard.
  expect(wsEvents[0]?.event.requestId).toBe("req_original_plan");
  expect(sseEvents[0]?.event.requestId).toBe("req_original_plan");
});

// ─────────────────────────────────────────────────────────────────────
// Spec §5 — trace_id stamping
// ─────────────────────────────────────────────────────────────────────

test("createEventProjector stamps trace_id on emitted events", async () => {
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");

  const projector = createEventProjector({
    taskId: "task_root_xyz",
    runId: "r-1",
    requestId: "req-fixture",
    traceId: "task_root_xyz",  // explicit root-self trace
  });

  await projector({
    type: "leader.tool_call",
    timestamp: new Date().toISOString(),
    data: { toolName: "bash", inputSummary: "echo hi" },
  });

  const repo = new ExecutionEventRepository();
  const events = await repo.listByTraceId("task_root_xyz");
  expect(events).toHaveLength(1);
  expect(events[0]!.traceId).toBe("task_root_xyz");
});

test("createEventProjector falls back to taskId when traceId omitted", async () => {
  // The common case today: a root task whose trace_id equals task_id.
  // Callers that don't yet look up task.trace_id explicitly should
  // still produce correctly-stamped events thanks to the projector's
  // `traceId ?? taskId` default.
  const { createEventProjector } = await import("../../src/services/leader-event-projector");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");

  const projector = createEventProjector({
    taskId: "task_fallback",
    runId: "r-1",
    requestId: "req-fixture",
    // traceId intentionally omitted
  });

  await projector({
    type: "leader.tool_call",
    timestamp: new Date().toISOString(),
    data: { toolName: "bash", inputSummary: "echo fallback" },
  });

  const repo = new ExecutionEventRepository();
  const events = await repo.listByTraceId("task_fallback");
  expect(events).toHaveLength(1);
  expect(events[0]!.traceId).toBe("task_fallback");
});
