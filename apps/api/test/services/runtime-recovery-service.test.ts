import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../../src/repositories/runtime-workspace-repository";
import { TaskMailboxRepository } from "../../src/repositories/task-mailbox-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { LeaderSessionStore } from "../../src/services/leader-session-store";
import {
  __resetActiveAsyncTeammatesForTest,
  registerActiveAsyncTeammate,
  unregisterActiveAsyncTeammate,
} from "../../src/services/manager-automation/async-teammate-registry";
import { recoverRuntimeOrchestrationTick } from "../../src/services/runtime-recovery-service";

const tempRoot = join(process.cwd(), ".tmp-runtime-recovery-db");
const ORIGINAL_STALE_RUNNING_MS = process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS;
const ORIGINAL_STUCK_TASK_MS = process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS;
const ORIGINAL_MAX_ATTEMPTS = process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `runtime-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS = "60000";
  process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS = "60000";
  process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS = "3";
});

afterEach(() => {
  __resetActiveAsyncTeammatesForTest();
  delete process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS = ORIGINAL_STALE_RUNNING_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS = ORIGINAL_STUCK_TASK_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS = ORIGINAL_MAX_ATTEMPTS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("recoverRuntimeOrchestrationTick requeues stale RUNNING lanes and dispatches them", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const now = new Date("2026-04-13T10:00:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_running_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Recover stale running lane",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_running_1",
    taskId: "task_runtime_recovery_running_1",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_stale_running",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T09:30:00.000Z"),
    updatedAt: new Date("2026-04-13T09:30:00.000Z"),
  });

  const dispatched: string[] = [];
  const result = await recoverRuntimeOrchestrationTick({
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    async dispatchRun(runId) {
      dispatched.push(runId);
      return {
        ok: true,
        runId,
        adapterId: "codex",
        state: "COMPLETED",
        sessionId: `session_${runId}`,
        artifactId: `artifact_${runId}`,
      };
    },
  });

  const runtime = await roleRuntimeRepository.getById("runtime_runtime_recovery_running_1");
  expect(runtime?.state).toBe("QUEUED");
  expect(runtime?.currentSessionId).toBeNull();
  expect(dispatched).toEqual(["runtime_runtime_recovery_running_1"]);
  expect(result.recoveredRunIds).toEqual(["runtime_runtime_recovery_running_1"]);
});

test("recoverRuntimeOrchestrationTick blocks stale RUNNING lanes after recovery attempts are exhausted", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const now = new Date("2026-04-13T10:00:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_exhausted_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Exhausted stale run",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_exhausted_1",
    taskId: "task_runtime_recovery_exhausted_1",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_stale_running_exhausted",
    attemptCount: 3,
    startedAt: new Date("2026-04-13T09:00:00.000Z"),
    updatedAt: new Date("2026-04-13T09:00:00.000Z"),
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    async dispatchRun() {
      throw new Error("dispatch should not be called for exhausted run");
    },
  });

  const runtime = await roleRuntimeRepository.getById("runtime_runtime_recovery_exhausted_1");
  const task = await taskRepository.getById("task_runtime_recovery_exhausted_1");
  expect(runtime?.state).toBe("FAILED");
  expect(task?.state).toBe("BLOCKED");
  expect(result.blockedRunIds).toEqual(["runtime_runtime_recovery_exhausted_1"]);
});

test("recoverRuntimeOrchestrationTick resumes stuck task orchestration when no lane is RUNNING", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const now = new Date("2026-04-13T11:00:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_stuck_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Resume stuck orchestration",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_stuck_manager_1",
    taskId: "task_runtime_recovery_stuck_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_completed",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T10:30:00.000Z"),
    updatedAt: new Date("2026-04-13T10:31:00.000Z"),
    completedAt: new Date("2026-04-13T10:31:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_stuck_coder_1",
    taskId: "task_runtime_recovery_stuck_1",
    roleId: "coder",
    state: "QUEUED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    attemptCount: 0,
    updatedAt: new Date("2026-04-13T10:31:00.000Z"),
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => new Date("2026-04-13T11:00:00.000Z"),
  });

  expect(result.resumedTaskIds).toEqual(["task_runtime_recovery_stuck_1"]);
});

test("recoverRuntimeOrchestrationTick wakes due WAITING tasks once nextWakeupAt has passed", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T11:30:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_waiting_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Wake waiting orchestration",
    state: "WAITING",
    createdAt: now,
    updatedAt: new Date("2026-04-13T11:00:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_waiting_manager_1",
    taskId: "task_runtime_recovery_waiting_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_waiting_manager_completed",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T10:30:00.000Z"),
    updatedAt: new Date("2026-04-13T10:31:00.000Z"),
    completedAt: new Date("2026-04-13T10:31:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_runtime_recovery_waiting_1",
    type: "task.orchestration.waiting",
    taskId: "task_runtime_recovery_waiting_1",
    roleRuntimeId: "runtime_runtime_recovery_waiting_manager_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-13T10:32:00.000Z"),
    payloadJson: JSON.stringify({
      action: "wait",
      executionMode: "long_running",
      stopReason: "sleep_until",
      taskState: "WAITING",
      waitReason: "ci_status",
      nextWakeupAt: "2026-04-13T11:15:00.000Z",
      message: "Wait for ci_status until 2026-04-13T11:15:00.000Z",
    }),
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
  });

  expect(result.resumedTaskIds).toEqual(["task_runtime_recovery_waiting_1"]);
  expect((await taskRepository.getById("task_runtime_recovery_waiting_1"))?.state).toBe(
    "IN_PROGRESS",
  );
});

test("recoverRuntimeOrchestrationTick does not wake WAITING tasks unless they are long_running", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T11:30:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_waiting_bounded_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Bounded waiting orchestration",
    state: "WAITING",
    createdAt: now,
    updatedAt: new Date("2026-04-13T11:00:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_waiting_bounded_manager_1",
    taskId: "task_runtime_recovery_waiting_bounded_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_waiting_bounded_manager_completed",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T10:30:00.000Z"),
    updatedAt: new Date("2026-04-13T10:31:00.000Z"),
    completedAt: new Date("2026-04-13T10:31:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_runtime_recovery_waiting_bounded_1",
    type: "task.orchestration.waiting",
    taskId: "task_runtime_recovery_waiting_bounded_1",
    roleRuntimeId: "runtime_runtime_recovery_waiting_bounded_manager_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-13T10:32:00.000Z"),
    payloadJson: JSON.stringify({
      action: "wait",
      executionMode: "bounded_execution",
      stopReason: "sleep_until",
      taskState: "WAITING",
      waitReason: "ci_status",
      nextWakeupAt: "2026-04-13T11:15:00.000Z",
      message: "Wait for ci_status until 2026-04-13T11:15:00.000Z",
    }),
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
  });

  expect(result.resumedTaskIds).toEqual([]);
  expect((await taskRepository.getById("task_runtime_recovery_waiting_bounded_1"))?.state).toBe(
    "WAITING",
  );
});

test("recoverRuntimeOrchestrationTick wakes long-running orchestration_pending tasks once nextWakeupAt has passed", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T11:30:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_waiting_pending_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Wake long-running pending orchestration",
    state: "WAITING",
    createdAt: now,
    updatedAt: new Date("2026-04-13T11:00:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_waiting_pending_manager_1",
    taskId: "task_runtime_recovery_waiting_pending_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_waiting_pending_manager_completed",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T10:30:00.000Z"),
    updatedAt: new Date("2026-04-13T10:31:00.000Z"),
    completedAt: new Date("2026-04-13T10:31:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_runtime_recovery_waiting_pending_1",
    type: "task.orchestration.waiting",
    taskId: "task_runtime_recovery_waiting_pending_1",
    roleRuntimeId: "runtime_runtime_recovery_waiting_pending_manager_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-13T10:32:00.000Z"),
    payloadJson: JSON.stringify({
      action: "wait",
      executionMode: "long_running",
      stopReason: "orchestration_pending",
      taskState: "WAITING",
      waitReason: "orchestration_pending",
      nextWakeupAt: "2026-04-13T11:15:00.000Z",
      message: "Long-running orchestration is waiting for downstream progress.",
    }),
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
  });

  expect(result.resumedTaskIds).toEqual(["task_runtime_recovery_waiting_pending_1"]);
  expect((await taskRepository.getById("task_runtime_recovery_waiting_pending_1"))?.state).toBe(
    "IN_PROGRESS",
  );
});

test("recoverRuntimeOrchestrationTick treats missing runtime workspaces as stale recovery candidates", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T12:00:00.000Z");

  await taskRepository.create({
    id: "task_runtime_recovery_missing_workspace_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Recover missing runtime workspace",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_runtime_recovery_missing_workspace_1",
    taskId: "task_runtime_recovery_missing_workspace_1",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_missing_workspace",
    attemptCount: 1,
    startedAt: new Date("2026-04-13T11:59:30.000Z"),
    updatedAt: new Date("2026-04-13T11:59:30.000Z"),
  });

  await runtimeWorkspaceRepository.upsert({
    id: "workspace_runtime_recovery_missing_workspace_1",
    runId: "runtime_runtime_recovery_missing_workspace_1",
    taskId: "task_runtime_recovery_missing_workspace_1",
    workspaceId: "workspace_main",
    roleId: "coder",
    requestedStrategy: "git_worktree",
    strategy: "workspace_root",
    decisionReason: "dirty_workspace",
    fallbackReason: "non_git_workspace",
    status: "running",
    baseWorkspaceDir: tempRoot,
    workspaceDir: join(tempRoot, "missing-runtime-workspace"),
    metadataPath: join(tempRoot, "missing-runtime-workspace.json"),
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });

  const dispatched: string[] = [];
  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
    async dispatchRun(runId) {
      dispatched.push(runId);
      return {
        ok: true,
        runId,
        adapterId: "codex",
        state: "COMPLETED",
        sessionId: `session_${runId}`,
        artifactId: `artifact_${runId}`,
      };
    },
  });

  expect(dispatched).toEqual(["runtime_runtime_recovery_missing_workspace_1"]);
  expect(result.recoveredRunIds).toEqual(["runtime_runtime_recovery_missing_workspace_1"]);
  expect(result.missingWorkspaceRunIds).toEqual(["runtime_runtime_recovery_missing_workspace_1"]);

  const events = await executionEventRepository.listByTaskId(
    "task_runtime_recovery_missing_workspace_1",
  );
  const transitionEvent = events.find((event) => event.type === "task.orchestration.transition");
  expect(transitionEvent).toBeTruthy();
  expect(JSON.parse(transitionEvent?.payloadJson ?? "{}")).toMatchObject({
    reason: "runtime_workspace_missing",
    runtimeWorkspace: {
      requestedStrategy: "git_worktree",
      strategy: "workspace_root",
      decisionReason: "dirty_workspace",
      fallbackReason: "non_git_workspace",
      missingOnDisk: true,
    },
  });
});

test("reaps stuck EXECUTING tasks whose latest event is older than threshold", async () => {
  // The user hit this: leader loop hung mid-flight (model API call
  // never returned, or socket dropped silently). State stayed
  // EXECUTING, no recovery loop touched it since the prior version
  // only scanned IN_PROGRESS / WAITING. Restart was the only way out.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-28T10:00:00.000Z");

  await taskRepository.create({
    id: "task_stuck_executing",
    workspaceId: "workspace_main",
    source: "web",
    title: "Stuck EXECUTING task",
    state: "EXECUTING",
    createdAt: new Date("2026-04-28T09:00:00.000Z"),
    updatedAt: new Date("2026-04-28T09:00:00.000Z"),
  });
  await roleRuntimeRepository.create({
    id: "runtime_stuck",
    taskId: "task_stuck_executing",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_stuck",
    attemptCount: 1,
    startedAt: new Date("2026-04-28T09:00:00.000Z"),
    updatedAt: new Date("2026-04-28T09:00:00.000Z"),
  });
  // Latest event ~10 min ago — older than the 60s stuck threshold the
  // beforeEach sets via env var.
  await executionEventRepository.create({
    id: "evt_stuck_last",
    type: "leader.tool_call",
    taskId: "task_stuck_executing",
    roleRuntimeId: "runtime_stuck",
    requestId: "req-stuck",
    occurredAt: new Date("2026-04-28T09:50:00.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });

  await recoverRuntimeOrchestrationTick({ now: () => now });

  const task = await taskRepository.getById("task_stuck_executing");
  expect(task?.state).toBe("FAILED");
  const runtime = await roleRuntimeRepository.getById("runtime_stuck");
  expect(runtime?.state).toBe("FAILED");

  // A leader.recovery_attempted event should be appended for diagnostics.
  const events = await executionEventRepository.listByTaskId("task_stuck_executing");
  const recoveryEvent = events.find((e) => e.type === "leader.recovery_attempted");
  expect(recoveryEvent).toBeTruthy();
  const payload = JSON.parse(recoveryEvent?.payloadJson ?? "{}");
  expect(payload.trigger).toBe("stuck_executing");
});

test("does NOT reap fresh EXECUTING tasks (events still recent)", async () => {
  // Healthy long-running task — events emitted recently. Should be
  // left alone even though state=EXECUTING.
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-28T10:00:00.000Z");

  await taskRepository.create({
    id: "task_healthy_executing",
    workspaceId: "workspace_main",
    source: "web",
    title: "Healthy EXECUTING task",
    state: "EXECUTING",
    createdAt: new Date("2026-04-28T09:55:00.000Z"),
    updatedAt: new Date("2026-04-28T09:59:50.000Z"),
  });
  await executionEventRepository.create({
    id: "evt_healthy_recent",
    type: "leader.stream_delta",
    taskId: "task_healthy_executing",
    roleRuntimeId: "rt_healthy",
    requestId: "req-healthy",
    occurredAt: new Date("2026-04-28T09:59:55.000Z"), // 5s ago, well under 60s threshold
    payloadJson: JSON.stringify({}),
  });

  await recoverRuntimeOrchestrationTick({ now: () => now });

  const task = await taskRepository.getById("task_healthy_executing");
  expect(task?.state).toBe("EXECUTING");
});

test("does NOT reap brand-new EXECUTING tasks with no events yet", async () => {
  // Task just created, loop hasn't emitted anything yet (model call in
  // flight, first event imminent). The freshness signal uses
  // task.updatedAt — a recent updatedAt protects this window even
  // before the first event arrives.
  const taskRepository = new TaskRepository();
  const now = new Date("2026-04-28T10:00:00.000Z");

  await taskRepository.create({
    id: "task_brand_new",
    workspaceId: "workspace_main",
    source: "web",
    title: "Brand new EXECUTING task",
    state: "EXECUTING",
    createdAt: new Date("2026-04-28T09:59:50.000Z"),
    updatedAt: new Date("2026-04-28T09:59:50.000Z"), // 10s ago
  });

  await recoverRuntimeOrchestrationTick({ now: () => now });

  const task = await taskRepository.getById("task_brand_new");
  expect(task?.state).toBe("EXECUTING");
});

test("does NOT reap a freshly-resumed turn whose only events are from a prior turn", async () => {
  // Critical regression: the prior version used events[-1].occurredAt
  // alone. After processTaskExecution flips state→EXECUTING for a
  // follow-up turn (the 142f4d8 fix), the most recent event in the DB
  // is still the prior turn's task:completed — old. Reaper would
  // falsely kill the new turn before its first event lands. The fix
  // blends task.updatedAt into the freshness signal so the recent
  // EXECUTING write keeps the task alive.
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-28T10:00:00.000Z");

  await taskRepository.create({
    id: "task_resumed_after_done",
    workspaceId: "workspace_main",
    source: "web",
    title: "Resumed-after-DONE follow-up",
    state: "EXECUTING",
    createdAt: new Date("2026-04-28T08:00:00.000Z"),
    updatedAt: new Date("2026-04-28T09:59:55.000Z"), // 5s ago — fresh resume
  });
  // Old terminal event from the prior turn (8 min ago).
  await executionEventRepository.create({
    id: "evt_prior_terminal",
    type: "task:completed",
    taskId: "task_resumed_after_done",
    roleRuntimeId: "rt_resumed",
    requestId: "req-prior",
    occurredAt: new Date("2026-04-28T09:52:00.000Z"),
    payloadJson: JSON.stringify({ state: "DONE" }),
  });

  await recoverRuntimeOrchestrationTick({ now: () => now });

  const task = await taskRepository.getById("task_resumed_after_done");
  expect(task?.state).toBe("EXECUTING"); // not reaped — fresh updatedAt saved it
});

test("does NOT reap when an AbortController is registered for the taskId", async () => {
  // The loop is alive in THIS process and may legitimately be blocked
  // on a long-running tool (waitForApproval can hold for 5min). Reaper
  // is for crash / orphaned-state recovery only — never for in-process
  // pauses. This test simulates a danger-gate wait scenario where no
  // events flow but the AC is registered.
  const { registerAbortController, removeAbortController } = await import(
    "../../src/services/task-worker"
  );
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-28T10:00:00.000Z");

  await taskRepository.create({
    id: "task_blocked_on_approval",
    workspaceId: "workspace_main",
    source: "web",
    title: "Blocked on approval (no events)",
    state: "EXECUTING",
    createdAt: new Date("2026-04-28T09:00:00.000Z"),
    updatedAt: new Date("2026-04-28T09:00:00.000Z"), // 60min ago — VERY stale
  });
  await executionEventRepository.create({
    id: "evt_approval_request",
    type: "leader.approval_requested",
    taskId: "task_blocked_on_approval",
    roleRuntimeId: "rt_block",
    requestId: "req-block",
    occurredAt: new Date("2026-04-28T09:00:00.000Z"),
    payloadJson: JSON.stringify({}),
  });

  const ac = new AbortController();
  registerAbortController("task_blocked_on_approval", ac);
  try {
    await recoverRuntimeOrchestrationTick({ now: () => now });
    const task = await taskRepository.getById("task_blocked_on_approval");
    expect(task?.state).toBe("EXECUTING"); // AC alive → reaper skips
  } finally {
    removeAbortController("task_blocked_on_approval");
  }
});

test("does NOT reap active async teammates while parent task is awaiting their completion", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const mailboxRepository = new TaskMailboxRepository();
  const now = new Date("2026-05-31T10:00:00.000Z");

  await taskRepository.create({
    id: "task_awaiting_live_async",
    workspaceId: "workspace_main",
    source: "web",
    title: "Awaiting live async teammate",
    state: "AWAITING_TEAMMATES",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_awaiting_live_leader",
    taskId: "task_awaiting_live_async",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_leader",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_awaiting_live_child",
    taskId: "task_awaiting_live_async",
    parentRunId: "runtime_awaiting_live_leader",
    roleId: "architect",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "claude-code",
    currentSessionId: "session_child",
    attemptCount: 0,
    spawnedAsync: true,
    startedAt: now,
    updatedAt: now,
  });

  registerActiveAsyncTeammate("task_awaiting_live_async", "runtime_awaiting_live_child");
  try {
    await recoverRuntimeOrchestrationTick({
      now: () => new Date("2026-05-31T10:00:30.000Z"),
    });
  } finally {
    unregisterActiveAsyncTeammate("task_awaiting_live_async", "runtime_awaiting_live_child");
  }

  const childRuntime = await roleRuntimeRepository.getById("runtime_awaiting_live_child");
  expect(childRuntime?.state).toBe("RUNNING");
  expect(childRuntime?.completedAt).toBeNull();
  expect(await mailboxRepository.getUnconsumed("task_awaiting_live_async")).toEqual([]);

  const events = await new ExecutionEventRepository().listByTaskId("task_awaiting_live_async");
  expect(events.find((e) => e.type === "leader.recovery_attempted")).toBeUndefined();
});

test("reaps awaiting async teammates when no live async run is registered after restart", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const mailboxRepository = new TaskMailboxRepository();
  const now = new Date("2026-05-31T10:30:00.000Z");

  await taskRepository.create({
    id: "task_awaiting_lost_async",
    workspaceId: "workspace_main",
    source: "web",
    title: "Awaiting lost async teammate",
    state: "AWAITING_TEAMMATES",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_awaiting_lost_leader",
    taskId: "task_awaiting_lost_async",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_leader",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_awaiting_lost_child",
    taskId: "task_awaiting_lost_async",
    parentRunId: "runtime_awaiting_lost_leader",
    roleId: "architect",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "claude-code",
    currentSessionId: "session_child",
    attemptCount: 0,
    spawnedAsync: true,
    startedAt: now,
    updatedAt: now,
  });

  await recoverRuntimeOrchestrationTick({
    now: () => new Date("2026-05-31T10:30:30.000Z"),
  });

  const childRuntime = await roleRuntimeRepository.getById("runtime_awaiting_lost_child");
  expect(childRuntime?.state).toBe("FAILED");

  const mailbox = await mailboxRepository.getUnconsumed("task_awaiting_lost_async");
  expect(mailbox).toHaveLength(1);
  expect(JSON.parse(mailbox[0]!.metadataJson ?? "{}")).toMatchObject({
    type: "teammate_completion",
    teammateRunId: "runtime_awaiting_lost_child",
    status: "FAILED",
    failureReason: "process_lost_on_restart",
  });
});

test("defers stale-RUNNING runtime when task is EXECUTING with fresh events (waits for next tick)", async () => {
  // GLM-5.1 review nudge: pin the deferral semantics introduced by the
  // EXECUTING-task filter. When the runtime is stale-RUNNING but its
  // owner task is EXECUTING with fresh events, the stale-RUNNING reaper
  // skips it (defers to stuck-EXECUTING handler) AND the stuck handler
  // skips it too (events fresh). Net: untouched this tick — events
  // will stale within stuckTaskThresholdMs and the stuck handler
  // catches it on the next sweep. Documents that the deferral is
  // intentional, not a leak.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-29T10:00:00.000Z");

  await taskRepository.create({
    id: "task_deferred",
    workspaceId: "workspace_main",
    source: "web",
    title: "Deferred task",
    state: "EXECUTING",
    createdAt: new Date("2026-04-29T09:55:00.000Z"),
    updatedAt: new Date("2026-04-29T09:59:50.000Z"),
  });
  // Runtime stale: updatedAt 10 minutes old (beyond 60s threshold).
  await roleRuntimeRepository.create({
    id: "runtime_deferred",
    taskId: "task_deferred",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_deferred",
    attemptCount: 1,
    startedAt: new Date("2026-04-29T09:50:00.000Z"),
    updatedAt: new Date("2026-04-29T09:50:00.000Z"),
  });
  // Latest event 5 seconds ago — stuck-EXECUTING threshold (60s) not
  // crossed yet.
  await executionEventRepository.create({
    id: "evt_recent",
    type: "leader.tool_call",
    taskId: "task_deferred",
    roleRuntimeId: "runtime_deferred",
    requestId: "req-deferred",
    occurredAt: new Date("2026-04-29T09:59:55.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });

  await recoverRuntimeOrchestrationTick({ now: () => now });

  // Both states untouched — neither reaper applies this tick.
  const task = await taskRepository.getById("task_deferred");
  expect(task?.state).toBe("EXECUTING");
  const runtime = await roleRuntimeRepository.getById("runtime_deferred");
  expect(runtime?.state).toBe("RUNNING");

  // No recovery_attempted event yet.
  const events = await executionEventRepository.listByTaskId("task_deferred");
  expect(events.find((e) => e.type === "leader.recovery_attempted")).toBeUndefined();
});

test("P5 — orphan child runtime is reaped when parent ended in COMPLETED", async () => {
  // The leader just finished (parent runtime COMPLETED) but a
  // teammate spawned earlier is still RUNNING. The recovery tick
  // should detect the orphan and mark the child FAILED.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const now = new Date("2026-05-08T10:00:00.000Z");

  await taskRepository.create({
    id: "task_orphan_parent",
    workspaceId: "workspace_main",
    source: "web",
    title: "Parent task",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await taskRepository.create({
    id: "task_orphan_child",
    workspaceId: "workspace_main",
    source: "spawn_teammate",
    title: "Child task",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orphan_parent",
    taskId: "task_orphan_parent",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "magister_loop",
    currentSessionId: null,
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_orphan_child",
    taskId: "task_orphan_child",
    parentRunId: "runtime_orphan_parent",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "magister_loop",
    currentSessionId: "session_orphan_child",
    attemptCount: 1,
    startedAt: now,
    // updatedAt fresh — heartbeat would normally be active. Critical:
    // proves stale-RUNNING reaper would NOT catch this (it's not
    // stale), the orphan reaper does.
    updatedAt: now,
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
    async dispatchRun(runId) {
      return { ok: true, runId, adapterId: "magister_loop", state: "COMPLETED", sessionId: `session_${runId}`, artifactId: `artifact_${runId}` };
    },
  });

  expect(result.orphanedRunIds).toContain("runtime_orphan_child");

  const childRuntime = await roleRuntimeRepository.getById("runtime_orphan_child");
  expect(childRuntime?.state).toBe("FAILED");
  expect(childRuntime?.completedAt).toBeDefined();

  const childTask = await taskRepository.getById("task_orphan_child");
  expect(childTask?.state).toBe("FAILED");

  const eventRepo = new ExecutionEventRepository();
  const events = await eventRepo.listByTaskId("task_orphan_child");
  const stoppedEvent = events.find((e) => e.type === "task.orchestration.stopped");
  expect(stoppedEvent).toBeDefined();
  const payload = JSON.parse(stoppedEvent!.payloadJson ?? "{}");
  expect(payload.stopReason).toBe("parent_terminal");
  expect(payload.parentState).toBe("COMPLETED");
});

test("P5 — orphan reaper does NOT touch child whose parent is still RUNNING", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const now = new Date("2026-05-08T10:00:00.000Z");

  await taskRepository.create({
    id: "task_alive_parent",
    workspaceId: "workspace_main",
    source: "web",
    title: "Live parent",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await taskRepository.create({
    id: "task_alive_child",
    workspaceId: "workspace_main",
    source: "spawn_teammate",
    title: "Live child",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_alive_parent",
    taskId: "task_alive_parent",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "magister_loop",
    currentSessionId: "session_parent",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_alive_child",
    taskId: "task_alive_child",
    parentRunId: "runtime_alive_parent",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "magister_loop",
    currentSessionId: "session_alive_child",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
  });

  const result = await recoverRuntimeOrchestrationTick({
    now: () => now,
    async dispatchRun(runId) {
      return { ok: true, runId, adapterId: "magister_loop", state: "COMPLETED", sessionId: `session_${runId}`, artifactId: `artifact_${runId}` };
    },
  });

  expect(result.orphanedRunIds).toEqual([]);
  const childRuntime = await roleRuntimeRepository.getById("runtime_alive_child");
  expect(childRuntime?.state).toBe("RUNNING");
});

// ──────────────────────────────────────────────────────────────────────────────
// B8 — stuck-EXECUTING resume instead of FAIL
// ──────────────────────────────────────────────────────────────────────────────

test("B8 — stuck-EXECUTING task WITH checkpoint calls resumeLeaderFromCheckpoint and does NOT mark FAILED", async () => {
  // Regression: before B8, a stuck EXECUTING task was always marked FAILED
  // even when a checkpoint existed. Now recovery routes through
  // resumeLeaderFromCheckpoint so the B1-B5 restore work actually fires.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-06-01T10:00:00.000Z");

  await taskRepository.create({
    id: "task_stuck_exec_with_ckpt",
    workspaceId: "workspace_main",
    source: "web",
    title: "Stuck EXECUTING task with checkpoint",
    state: "EXECUTING",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await roleRuntimeRepository.create({
    id: "runtime_stuck_exec_with_ckpt",
    taskId: "task_stuck_exec_with_ckpt",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_stuck_ckpt",
    attemptCount: 1,
    startedAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  // Stale event — 60 min old, well beyond the 60s threshold.
  await executionEventRepository.create({
    id: "evt_stuck_exec_with_ckpt",
    type: "leader.tool_call",
    taskId: "task_stuck_exec_with_ckpt",
    roleRuntimeId: "runtime_stuck_exec_with_ckpt",
    requestId: "req-ckpt",
    occurredAt: new Date("2026-06-01T09:00:00.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });
  // Write a checkpoint — this is what triggers resume instead of FAIL.
  await sessionStore.writeCheckpoint({
    sessionId: "session_stuck_ckpt",
    taskId: "task_stuck_exec_with_ckpt",
    runId: "runtime_stuck_exec_with_ckpt",
    requestId: "req-ckpt",
    turnCount: 3,
    messages: [
      { type: "user", content: "Fix the API" },
      { type: "assistant", content: [{ type: "text", text: "Working on it" }] },
    ],
  });

  const resumed: Array<{ taskId: string; runId: string; workspaceId: string }> = [];

  await recoverRuntimeOrchestrationTick({
    now: () => now,
    resumeLeaderFromCheckpoint: async (input) => {
      resumed.push({ taskId: input.taskId, runId: input.runId, workspaceId: input.workspaceId });
      return { ok: true, reason: "completed", turnCount: 4 };
    },
  });

  // resumeLeaderFromCheckpoint must have been called — not FAILED.
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({
    taskId: "task_stuck_exec_with_ckpt",
    runId: "runtime_stuck_exec_with_ckpt",
    workspaceId: "workspace_main",
  });

  // Task must NOT have been marked FAILED by the reaper.
  const task = await taskRepository.getById("task_stuck_exec_with_ckpt");
  expect(task?.state).not.toBe("FAILED");

  // Observability: a recovery_attempted event with trigger=stuck_executing_resume.
  const events = await executionEventRepository.listByTaskId("task_stuck_exec_with_ckpt");
  const recoveryEvent = events.find((e) => e.type === "leader.recovery_attempted");
  expect(recoveryEvent).toBeTruthy();
  const payload = JSON.parse(recoveryEvent?.payloadJson ?? "{}");
  expect(payload.trigger).toBe("stuck_executing_resume");
});

test("B8 — stuck-EXECUTING task WITHOUT checkpoint still marked FAILED (fallback unchanged)", async () => {
  // The existing fallback must stay intact: no checkpoint → FAIL, not hang.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-06-01T10:00:00.000Z");

  await taskRepository.create({
    id: "task_stuck_exec_no_ckpt",
    workspaceId: "workspace_main",
    source: "web",
    title: "Stuck EXECUTING task without checkpoint",
    state: "EXECUTING",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await roleRuntimeRepository.create({
    id: "runtime_stuck_exec_no_ckpt",
    taskId: "task_stuck_exec_no_ckpt",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_no_ckpt",
    attemptCount: 1,
    startedAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await executionEventRepository.create({
    id: "evt_stuck_exec_no_ckpt",
    type: "leader.tool_call",
    taskId: "task_stuck_exec_no_ckpt",
    roleRuntimeId: "runtime_stuck_exec_no_ckpt",
    requestId: "req-no-ckpt",
    occurredAt: new Date("2026-06-01T09:00:00.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });
  // NO checkpoint written — fallback to FAILED.

  const resumed: unknown[] = [];

  await recoverRuntimeOrchestrationTick({
    now: () => now,
    resumeLeaderFromCheckpoint: async (input) => {
      resumed.push(input);
      return { ok: true, reason: "completed", turnCount: 0 };
    },
  });

  // Resume must NOT have been called.
  expect(resumed).toHaveLength(0);

  // Task must be marked FAILED.
  const task = await taskRepository.getById("task_stuck_exec_no_ckpt");
  expect(task?.state).toBe("FAILED");

  const runtime = await roleRuntimeRepository.getById("runtime_stuck_exec_no_ckpt");
  expect(runtime?.state).toBe("FAILED");

  // Observability event with trigger=stuck_executing (unchanged).
  const events = await executionEventRepository.listByTaskId("task_stuck_exec_no_ckpt");
  const recoveryEvent = events.find((e) => e.type === "leader.recovery_attempted");
  expect(recoveryEvent).toBeTruthy();
  const payload = JSON.parse(recoveryEvent?.payloadJson ?? "{}");
  expect(payload.trigger).toBe("stuck_executing");
});

test("P1-fix-a — stuck-EXECUTING task with a TERMINAL checkpoint is RESUMED (not finalized), so goal re-enqueues aren't prematurely ended", async () => {
  // A terminal-flagged checkpoint can mean either (a) a run that completed
  // but crashed before its terminal task write, or (b) a goal iteration
  // that produced an answer and re-enqueued. Finalizing as DONE would
  // prematurely kill an active goal, so recovery RESUMES on any checkpoint
  // (terminal or not). Resume self-heals case (a) and correctly continues
  // case (b).
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-06-01T10:00:00.000Z");

  await taskRepository.create({
    id: "task_stuck_exec_terminal_ckpt",
    workspaceId: "workspace_main",
    source: "web",
    title: "Stuck EXECUTING task with terminal checkpoint",
    state: "EXECUTING",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await roleRuntimeRepository.create({
    id: "runtime_stuck_exec_terminal_ckpt",
    taskId: "task_stuck_exec_terminal_ckpt",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_terminal_ckpt",
    attemptCount: 1,
    startedAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await executionEventRepository.create({
    id: "evt_stuck_exec_terminal_ckpt",
    type: "leader.tool_call",
    taskId: "task_stuck_exec_terminal_ckpt",
    roleRuntimeId: "runtime_stuck_exec_terminal_ckpt",
    requestId: "req-terminal",
    occurredAt: new Date("2026-06-01T09:00:00.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });
  // Terminal checkpoint — final answer present, terminal flag set.
  await sessionStore.writeCheckpoint({
    sessionId: "session_terminal_ckpt",
    taskId: "task_stuck_exec_terminal_ckpt",
    runId: "runtime_stuck_exec_terminal_ckpt",
    requestId: "req-terminal",
    turnCount: 5,
    terminal: true,
    messages: [
      { type: "user", content: "What is 2+2?" },
      { type: "assistant", content: [{ type: "text", text: "The answer is 4." }] },
    ],
  });

  const resumed: Array<{ taskId: string; runId: string }> = [];
  await recoverRuntimeOrchestrationTick({
    now: () => now,
    resumeLeaderFromCheckpoint: async (input) => {
      resumed.push({ taskId: input.taskId, runId: input.runId });
      return { ok: true, reason: "completed", turnCount: 6 };
    },
  });

  // Terminal checkpoint is RESUMED, not finalized/FAILED.
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.taskId).toBe("task_stuck_exec_terminal_ckpt");
  const task = await taskRepository.getById("task_stuck_exec_terminal_ckpt");
  expect(task?.state).not.toBe("FAILED");
});

test("P1-fix-a — an ACTIVE-GOAL stuck-EXECUTING task with a checkpoint is NOT resumed (would prematurely end the goal) — marked FAILED", async () => {
  // resumeLeaderFromCheckpoint can't continue a goal (the mailbox+requeue
  // logic lives in process-task-intent), so recovery must NOT auto-resume
  // an active goal — it falls through to FAILED instead.
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-06-01T10:00:00.000Z");

  await taskRepository.create({
    id: "task_stuck_exec_goal",
    workspaceId: "workspace_main",
    source: "web",
    title: "Stuck EXECUTING active-goal task",
    state: "EXECUTING",
    goalObjective: "Keep improving the docs until perfect",
    goalStatus: "active",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await roleRuntimeRepository.create({
    id: "runtime_stuck_exec_goal",
    taskId: "task_stuck_exec_goal",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "ucm",
    currentSessionId: "session_goal",
    attemptCount: 1,
    startedAt: new Date("2026-06-01T09:00:00.000Z"),
    updatedAt: new Date("2026-06-01T09:00:00.000Z"),
  });
  await executionEventRepository.create({
    id: "evt_stuck_exec_goal",
    type: "leader.tool_call",
    taskId: "task_stuck_exec_goal",
    roleRuntimeId: "runtime_stuck_exec_goal",
    requestId: "req-goal",
    occurredAt: new Date("2026-06-01T09:00:00.000Z"),
    payloadJson: JSON.stringify({ toolName: "bash" }),
  });
  await sessionStore.writeCheckpoint({
    sessionId: "session_goal",
    taskId: "task_stuck_exec_goal",
    runId: "runtime_stuck_exec_goal",
    requestId: "req-goal",
    turnCount: 4,
    messages: [
      { type: "user", content: "Improve the docs" },
      { type: "assistant", content: [{ type: "text", text: "Iteration 1 done" }] },
    ],
  });

  const resumed: unknown[] = [];
  await recoverRuntimeOrchestrationTick({
    now: () => now,
    resumeLeaderFromCheckpoint: async (input) => {
      resumed.push(input);
      return { ok: true, reason: "completed", turnCount: 5 };
    },
  });

  // Active goal must NOT be resumed (would prematurely DONE the goal).
  expect(resumed).toHaveLength(0);
  // Falls through to FAILED.
  const task = await taskRepository.getById("task_stuck_exec_goal");
  expect(task?.state).toBe("FAILED");
});
