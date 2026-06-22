import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-turn-timing-terminal-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `turn-timing-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: tempRoot,
  });
  const configPath = join(tempRoot, "executors.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: { leader: { adapterId: "leader_api", strategy: "model_only" } },
      providers: {},
      models: {},
      bindings: {},
    }),
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("processTaskExecution persists request timing on failed terminal chat event", async () => {
  const requestStartedAtMs = Date.now() - 10_000;

  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const { processTaskExecution } = await import("../../src/services/process-task-intent-service");

  const taskId = "task_turn_timing_terminal";
  const runId = "rt_turn_timing_terminal";
  const requestId = "req_turn_timing_terminal";
  const now = new Date();

  await new TaskRepository().create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "Timing terminal event",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await new RoleRuntimeRepository().create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  const events = new ExecutionEventRepository();
  await events.create({
    id: "event_approval_requested",
    type: "leader.approval_requested",
    taskId,
    roleRuntimeId: runId,
    requestId,
    occurredAt: new Date(requestStartedAtMs + 2_000),
    payloadJson: JSON.stringify({ approvalId: "approval_timing" }),
  });
  await events.create({
    id: "event_approval_resolved",
    type: "leader.approval_resolved",
    taskId,
    roleRuntimeId: runId,
    requestId,
    occurredAt: new Date(requestStartedAtMs + 5_000),
    payloadJson: JSON.stringify({
      approvalId: "approval_timing",
      decision: "approved",
    }),
  });

  const originalListByTaskId = ExecutionEventRepository.prototype.listByTaskId;
  ExecutionEventRepository.prototype.listByTaskId = async () => {
    throw new Error("terminal timing must not load the full task event log");
  };
  try {
    await processTaskExecution({
      taskId,
      runId,
      requestId,
      requestStartedAtMs,
      workspaceId: "workspace_main",
      prompt: "Measure this",
    });
  } finally {
    ExecutionEventRepository.prototype.listByTaskId = originalListByTaskId;
  }

  const terminal = (await new ExecutionEventRepository().listAll()).find(
    (event) => event.type === "task:failed" && event.requestId === requestId,
  );
  expect(terminal).toBeDefined();
  const payload = JSON.parse(String(terminal?.payloadJson)) as {
    timing?: { wallMs: number; pausedMs: number; elapsedMs: number };
  };
  expect(payload.timing?.pausedMs).toBe(3_000);
  expect(payload.timing?.wallMs).toBeGreaterThanOrEqual(10_000);
  expect(payload.timing?.elapsedMs).toBe(
    (payload.timing?.wallMs ?? 0) - 3_000,
  );
});
