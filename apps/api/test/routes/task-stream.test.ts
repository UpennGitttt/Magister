import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";

const tempRoot = join(process.cwd(), ".tmp-stream-db");

function writeStubRoutingConfig(configPath: string, overrides?: { managerConfiguredModel?: string | null }) {
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel:
            overrides && "managerConfiguredModel" in overrides
              ? overrides.managerConfiguredModel
              : "gpt-5.3-codex",
          commandPath: "__stub__",
        },
        qoder: {
          configuredModel: "qoder-review",
          commandPath: "qoder",
        },
      },
      roleRouting: {
        manager: "codex",
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `stream-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  // Close idle SSE streams quickly so `app.inject` can collect the
  // response body. Production stays at 5 min (handler default).
  process.env.MAGISTER_SSE_IDLE_MS = "200";
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_SSE_IDLE_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /tasks/:taskId/stream emits an SSE snapshot after task creation", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const taskId = `task_test_${Date.now()}_snapshot`;
  const runId = `rt_leader_${Date.now()}_snapshot`;
  const requestId = "req-snapshot-created";
  const now = new Date("2026-05-12T07:00:00Z");

  await new TaskRepository().create({
    id: taskId,
    title: "Stream the first task snapshot",
    state: "DONE",
    source: "cli",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
  });
  await new RoleRuntimeRepository().create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });
  await new ExecutionEventRepository().create({
    id: "evt-task-created-snapshot",
    type: "task.created",
    taskId,
    roleRuntimeId: runId,
    requestId,
    occurredAt: now,
    payloadJson: JSON.stringify({ source: "cli", prompt: "Stream the first task snapshot" }),
  });

  const taskStreamResponse = await app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });

  const runStreamResponse = await app.inject({
    method: "GET",
    url: `/runs/${runId}/stream`,
  });

  expect(taskStreamResponse.statusCode).toBe(200);
  expect(taskStreamResponse.headers["content-type"]).toContain("text/event-stream");
  expect(taskStreamResponse.body).toContain("event: task.snapshot");
  expect(taskStreamResponse.body).toContain(taskId);
  expect(taskStreamResponse.body).toContain("task.created");

  expect(runStreamResponse.statusCode).toBe(200);
  expect(runStreamResponse.headers["content-type"]).toContain("text/event-stream");
  expect(runStreamResponse.body).toContain("event: run.snapshot");
  expect(runStreamResponse.body).toContain(runId);
});

test("GET /tasks/:taskId/stream preserves requestId on snapshot replay and live relayed events", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  // Bypass POST /tasks so the task worker never enqueues a competing leader
  // run. The leader run would emit its own `task:failed` (no real model is
  // configured in tests), close the SSE on the backend's terminal-event
  // path, and race-eat the live events this test publishes — exactly the
  // flake we hit when paired with workspace/feishu-gateway suites.
  const taskRepo = new TaskRepository();
  const taskId = `task_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestId = "req-stream-replay-fixture";
  await taskRepo.create({
    id: taskId,
    title: "Stream requestId fixture",
    state: "EXECUTING",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-04-25T09:59:00Z"),
    updatedAt: new Date("2026-04-25T09:59:00Z"),
  });

  const eventRepository = new ExecutionEventRepository();
  await eventRepository.create({
    id: "evt-request-id-history",
    type: "leader.stream_delta",
    taskId,
    roleRuntimeId: "rt_fixture",
    requestId,
    occurredAt: new Date("2026-04-25T10:00:00Z"),
    payloadJson: JSON.stringify({ delta: "snapshot text" }),
  });

  const streamPromise = app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });

  // Give the SSE a moment to subscribe before we publish live events.
  await new Promise((resolve) => setTimeout(resolve, 10));

  taskEventBus.publish(taskId, {
    type: "leader.stream_delta",
    requestId,
    data: { delta: "live text" },
    timestamp: new Date("2026-04-25T10:00:01Z").toISOString(),
  });
  taskEventBus.publish(taskId, {
    type: "task:completed",
    requestId,
    data: { taskId, state: "DONE" },
    timestamp: new Date("2026-04-25T10:00:02Z").toISOString(),
  });

  const taskStreamResponse = await streamPromise;
  expect(taskStreamResponse.statusCode).toBe(200);

  const lines = taskStreamResponse.body
    .split("\n")
    .filter((line) => line.startsWith("data: "));
  const payloads = lines.map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

  const snapshotPayload = payloads.find((payload) => Array.isArray(payload.events));
  expect(snapshotPayload).toBeDefined();
  const snapshotEvents = snapshotPayload!.events as Array<Record<string, unknown>>;
  const historicalEvent = snapshotEvents.find((event) => event.id === "evt-request-id-history");
  expect(historicalEvent).toMatchObject({
    id: "evt-request-id-history",
    requestId,
  });

  const liveEvent = payloads.find((payload) => payload.type === "leader.stream_delta");
  expect(liveEvent).toMatchObject({
    type: "leader.stream_delta",
    requestId,
    data: { delta: "live text" },
  });
});

test("snapshot replays distinct requestIds for consecutive turns on the same task", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) throw new Error("Expected executor config path");
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");

  // Same fixture pattern as above (bypass POST /tasks to avoid the worker
  // race) — but the assertion is different: TWO distinct historical events
  // with TWO distinct requestIds, both replayed in the SSE snapshot.
  const taskRepo = new TaskRepository();
  const taskId = `task_test_${Date.now()}_multi`;
  const requestIdA = "req-multi-A";
  const requestIdB = "req-multi-B";
  await taskRepo.create({
    id: taskId,
    title: "Multi-turn requestId fixture",
    state: "DONE",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-04-25T11:00:00Z"),
    updatedAt: new Date("2026-04-25T11:00:30Z"),
  });

  const events = new ExecutionEventRepository();
  await events.create({
    id: "evt-turn-A",
    type: "leader.stream_delta",
    taskId,
    roleRuntimeId: "rt_multi",
    requestId: requestIdA,
    occurredAt: new Date("2026-04-25T11:00:05Z"),
    payloadJson: JSON.stringify({ delta: "turn A" }),
  });
  await events.create({
    id: "evt-turn-B",
    type: "leader.stream_delta",
    taskId,
    roleRuntimeId: "rt_multi",
    requestId: requestIdB,
    occurredAt: new Date("2026-04-25T11:00:25Z"),
    payloadJson: JSON.stringify({ delta: "turn B" }),
  });

  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  const responsePromise = app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });
  // Give the SSE a moment to write its snapshot, then publish a terminal
  // event so the backend closes the stream — without this the SSE would
  // sit on the 5-min idle timeout (stream opened against a DONE task).
  await new Promise((r) => setTimeout(r, 10));
  taskEventBus.publish(taskId, {
    type: "task:completed",
    requestId: requestIdB,
    data: { taskId, state: "DONE" },
    timestamp: new Date("2026-04-25T11:00:30Z").toISOString(),
  });

  const response = await responsePromise;
  expect(response.statusCode).toBe(200);

  const snapshotLine = response.body
    .split("\n")
    .find((line) => line.startsWith("data: ") && line.includes("\"events\""));
  expect(snapshotLine).toBeDefined();
  const snapshotPayload = JSON.parse(snapshotLine!.slice("data: ".length)) as {
    events: Array<Record<string, unknown>>;
  };

  const eventA = snapshotPayload.events.find((e) => e.id === "evt-turn-A");
  const eventB = snapshotPayload.events.find((e) => e.id === "evt-turn-B");
  expect(eventA?.requestId).toBe(requestIdA);
  expect(eventB?.requestId).toBe(requestIdB);
  expect(eventA?.requestId).not.toBe(eventB?.requestId);
});

test("snapshot synthesizes terminal for latest cancelled turn even when an earlier turn is terminal", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) throw new Error("Expected executor config path");
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const taskRepo = new TaskRepository();
  const eventRepo = new ExecutionEventRepository();
  const taskId = `task_test_${Date.now()}_cancelled_latest`;
  const requestIdA = "req-cancelled-previous";
  const requestIdB = "req-cancelled-latest";
  await taskRepo.create({
    id: taskId,
    title: "Cancelled follow-up turn",
    state: "CANCELLED",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-05-27T10:00:00Z"),
    updatedAt: new Date("2026-05-27T10:02:00Z"),
  });

  await eventRepo.create({
    id: "evt-previous-terminal",
    type: "task:completed",
    taskId,
    roleRuntimeId: "rt_cancelled_fixture",
    requestId: requestIdA,
    occurredAt: new Date("2026-05-27T10:00:30Z"),
    payloadJson: JSON.stringify({ taskId, requestId: requestIdA, state: "DONE" }),
  });
  await eventRepo.create({
    id: "evt-latest-started",
    type: "leader.stream_delta",
    taskId,
    roleRuntimeId: "rt_cancelled_fixture",
    requestId: requestIdB,
    occurredAt: new Date("2026-05-27T10:01:00Z"),
    payloadJson: JSON.stringify({ type: "thinking_delta", text: "Working on latest turn" }),
  });

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });
  expect(response.statusCode).toBe(200);

  const snapshotLine = response.body
    .split("\n")
    .find((line) => line.startsWith("data: ") && line.includes("\"events\""));
  expect(snapshotLine).toBeDefined();
  const snapshotPayload = JSON.parse(snapshotLine!.slice("data: ".length)) as {
    events: Array<Record<string, unknown>>;
  };

  const synthetic = snapshotPayload.events.find((event) =>
    event.type === "task:cancelled" && event.requestId === requestIdB
  );
  expect(synthetic).toBeDefined();
  expect(synthetic?.id).toContain("synthetic_terminal");
});

test("events published before snapshot fetch resolves are buffered and delivered", async () => {
  // Regression: previously the SSE handler ran `await listByTaskId` BEFORE
  // subscribing to the event bus, so any publish() landing during that
  // await was dropped (not in snapshot, not on live wire). On hot streaming
  // turns the user saw "stale content" until refresh. The handler now
  // subscribes synchronously before the DB await, buffers events while
  // the snapshot is in flight, and drains the buffer with seq-dedup
  // against the snapshot's max seq.
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) throw new Error("Expected executor config path");
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  const taskRepo = new TaskRepository();
  const taskId = `task_test_${Date.now()}_gap`;
  const requestId = "req-gap-fixture";
  await taskRepo.create({
    id: taskId,
    title: "Gap window fixture",
    state: "EXECUTING",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-04-27T12:00:00Z"),
    updatedAt: new Date("2026-04-27T12:00:00Z"),
  });

  // Kick off the SSE handler. We need to publish AFTER the handler has
  // synchronously installed the bus subscription (which happens before
  // its first await) but BEFORE the DB fetch resolves and the snapshot
  // is written. A microtask yield (`await Promise.resolve()`) gives the
  // handler one event-loop tick to start; the DB fetch is async so it
  // hasn't returned yet — exactly the gap window we're testing.
  const streamPromise = app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });
  await new Promise((r) => setImmediate(r));

  // Publish via the bus only — do not write to DB. If the publish lands
  // during the DB-fetch gap (which it always does given the synchronous
  // ordering), the only way for it to reach the wire is via the
  // buffered drain. NOT writing to DB ensures it's not in the snapshot.
  taskEventBus.publish(taskId, {
    type: "leader.tool_call",
    requestId,
    seq: 9_999_999,
    data: { toolName: "bash", input: { command: "echo hi" } },
    timestamp: new Date("2026-04-27T12:00:00.500Z").toISOString(),
  });

  // Now publish a terminal so the handler closes and we can read the body.
  taskEventBus.publish(taskId, {
    type: "task:completed",
    requestId,
    seq: 10_000_000,
    data: { taskId, state: "DONE" },
    timestamp: new Date("2026-04-27T12:00:01Z").toISOString(),
  });

  const response = await streamPromise;
  expect(response.statusCode).toBe(200);

  const dataLines = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "));
  const payloads = dataLines.map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

  const liveToolCall = payloads.find((p) => p.type === "leader.tool_call");
  expect(liveToolCall).toBeDefined();
  expect(liveToolCall).toMatchObject({
    type: "leader.tool_call",
    requestId,
    seq: 9_999_999,
  });
});

test("stream stays open across follow-up turns (terminal event does not close)", async () => {
  // Regression: a previous design closed the stream on every terminal
  // event (task:completed/failed). Browsers auto-reconnected after ~3s,
  // but if a PlanCard Approve sentinel triggered a fresh turn within
  // that window, those new-turn events landed in the bus with no
  // subscriber — captured only in the DB and recovered via snapshot
  // on reconnect, but the user perceived a multi-second stall. The
  // handler now keeps the stream open and arms a 5-min idle timer
  // instead, cancelled by any non-terminal event (a fresh turn flows
  // through cleanly without forcing reconnect).
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) throw new Error("Expected executor config path");
  writeStubRoutingConfig(configPath);

  const app = buildApp();
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { taskEventBus } = await import("../../src/sse/task-event-bus");

  const taskRepo = new TaskRepository();
  const taskId = `task_test_${Date.now()}_keepalive`;
  const turnA = "req-keepalive-A";
  const turnB = "req-keepalive-B";
  await taskRepo.create({
    id: taskId,
    title: "Keep-alive across turns fixture",
    state: "EXECUTING",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-04-28T01:00:00Z"),
    updatedAt: new Date("2026-04-28T01:00:00Z"),
  });

  const streamPromise = app.inject({
    method: "GET",
    url: `/tasks/${taskId}/stream`,
  });
  await new Promise((r) => setImmediate(r));

  // Turn A finishes — terminal event arrives. Old code would cleanup()
  // here and close the stream.
  taskEventBus.publish(taskId, {
    type: "task:completed",
    requestId: turnA,
    seq: 1,
    data: { taskId, state: "DONE" },
    timestamp: new Date("2026-04-28T01:00:01Z").toISOString(),
  });

  // Quick yield. With the old behavior the stream would have already
  // closed and this publish would have no subscriber. With the new
  // idle-timer behavior the listener is still attached.
  await new Promise((r) => setTimeout(r, 50));

  taskEventBus.publish(taskId, {
    type: "leader.tool_call",
    requestId: turnB,
    seq: 2,
    data: { toolName: "bash", toolUseId: "tu_x" },
    timestamp: new Date("2026-04-28T01:00:02Z").toISOString(),
  });

  // Final terminal so the (test-overridden 200ms) idle timer fires
  // promptly and `app.inject` resolves.
  taskEventBus.publish(taskId, {
    type: "task:completed",
    requestId: turnB,
    seq: 3,
    data: { taskId, state: "DONE" },
    timestamp: new Date("2026-04-28T01:00:03Z").toISOString(),
  });

  const response = await streamPromise;
  expect(response.statusCode).toBe(200);

  const lines = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "));
  const payloads = lines.map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

  // The follow-up turn's tool_call MUST be on the wire — that's the
  // direct symptom of the close-on-terminal regression.
  const liveTool = payloads.find((p) => p.type === "leader.tool_call" && p.requestId === turnB);
  expect(liveTool).toBeDefined();
});
