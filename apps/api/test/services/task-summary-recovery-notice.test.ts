import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { TaskSummaryStore } from "../../src/observability/task-summary-store";

const tempRoot = join(process.cwd(), ".tmp-task-summary-recovery-notice-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `task-summary-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

async function seedTask(input: {
  taskId: string;
  runId: string;
  taskState: string;
  runtimeState?: string;
}) {
  const now = new Date("2026-05-12T08:00:00.000Z");
  await new TaskRepository().create({
    id: input.taskId,
    title: input.taskId,
    state: input.taskState,
    source: "web",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
  });
  await new RoleRuntimeRepository().create({
    id: input.runId,
    taskId: input.taskId,
    roleId: "leader",
    state: input.runtimeState ?? "RUNNING",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
  });
}

describe("TaskSummaryStore recoveryNotice", () => {
  test("projects runtime recovery retry transitions as recovered session notices", async () => {
    const taskId = "task_recovered_summary";
    const runId = "rt_recovered_summary";
    const occurredAt = new Date("2026-05-12T08:01:00.000Z");
    await seedTask({ taskId, runId, taskState: "IN_PROGRESS" });
    await new ExecutionEventRepository().create({
      id: "event_recovery_retry",
      type: "task.orchestration.transition",
      taskId,
      roleRuntimeId: runId,
      occurredAt,
      payloadJson: JSON.stringify({
        action: "retry",
        reason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        state: "IN_PROGRESS",
        runId,
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.recoveryNotice).toEqual({
      status: "recovered",
      occurredAt: occurredAt.toISOString(),
      reason: "runtime_recovery_stale_running",
      previousState: "RUNNING",
      nextState: "IN_PROGRESS",
      requiresUserAction: false,
      runId,
    });
  });

  test("projects runtime recovery exhaustion as blocked session notices", async () => {
    const taskId = "task_blocked_summary";
    const runId = "rt_blocked_summary";
    const occurredAt = new Date("2026-05-12T08:02:00.000Z");
    await seedTask({ taskId, runId, taskState: "BLOCKED", runtimeState: "FAILED" });
    await new ExecutionEventRepository().create({
      id: "event_recovery_blocked",
      type: "task.orchestration.stopped",
      taskId,
      roleRuntimeId: runId,
      occurredAt,
      payloadJson: JSON.stringify({
        action: "block",
        stopReason: "runtime_recovery_exhausted",
        recoveryReason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        state: "BLOCKED",
        runId,
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.recoveryNotice).toEqual({
      status: "blocked",
      occurredAt: occurredAt.toISOString(),
      reason: "runtime_recovery_exhausted",
      previousState: "RUNNING",
      nextState: "BLOCKED",
      requiresUserAction: true,
      runId,
    });
  });

  test("uses recovery tick blockedRunIds as a blocked session notice fallback", async () => {
    const taskId = "task_blocked_tick_summary";
    const runId = "rt_blocked_tick_summary";
    const occurredAt = new Date("2026-05-12T08:03:00.000Z");
    await seedTask({ taskId, runId, taskState: "BLOCKED", runtimeState: "FAILED" });
    await new ExecutionEventRepository().create({
      id: "event_recovery_tick_blocked",
      type: "worker.runtime_recovery.tick",
      occurredAt,
      payloadJson: JSON.stringify({
        trigger: "runtime_recovery_worker",
        blockedRunIds: [runId],
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.recoveryNotice).toEqual({
      status: "blocked",
      occurredAt: occurredAt.toISOString(),
      reason: "runtime_recovery_exhausted",
      previousState: null,
      nextState: "BLOCKED",
      requiresUserAction: true,
      runId,
    });
  });

  test("does not keep a recovered notice after a newer non-recovery orchestration transition", async () => {
    const taskId = "task_recovery_cleared_summary";
    const runId = "rt_recovery_cleared_summary";
    await seedTask({ taskId, runId, taskState: "IN_PROGRESS" });
    await new ExecutionEventRepository().create({
      id: "event_recovery_retry_cleared",
      type: "task.orchestration.transition",
      taskId,
      roleRuntimeId: runId,
      occurredAt: new Date("2026-05-12T08:01:00.000Z"),
      payloadJson: JSON.stringify({
        action: "retry",
        reason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        state: "IN_PROGRESS",
        runId,
      }),
    });
    await new ExecutionEventRepository().create({
      id: "event_regular_transition_after_recovery",
      type: "task.orchestration.transition",
      taskId,
      roleRuntimeId: runId,
      occurredAt: new Date("2026-05-12T08:02:00.000Z"),
      payloadJson: JSON.stringify({
        action: "dispatch",
        reason: "leader_completed",
        previousState: "IN_PROGRESS",
        state: "IN_PROGRESS",
        runId,
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.recoveryNotice).toBeUndefined();
  });

  test("does not revive a blocked notice from a stale recovery tick after newer non-recovery transition", async () => {
    const taskId = "task_stale_tick_cleared_summary";
    const runId = "rt_stale_tick_cleared_summary";
    await seedTask({ taskId, runId, taskState: "IN_PROGRESS" });
    await new ExecutionEventRepository().create({
      id: "event_stale_recovery_tick_blocked",
      type: "worker.runtime_recovery.tick",
      occurredAt: new Date("2026-05-12T08:01:00.000Z"),
      payloadJson: JSON.stringify({
        trigger: "runtime_recovery_worker",
        blockedRunIds: [runId],
      }),
    });
    await new ExecutionEventRepository().create({
      id: "event_regular_transition_after_stale_tick",
      type: "task.orchestration.transition",
      taskId,
      roleRuntimeId: runId,
      occurredAt: new Date("2026-05-12T08:02:00.000Z"),
      payloadJson: JSON.stringify({
        action: "dispatch",
        reason: "leader_resumed",
        previousState: "BLOCKED",
        state: "IN_PROGRESS",
        runId,
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.recoveryNotice).toBeUndefined();
  });
});

describe("TaskSummaryStore blockedNarrative", () => {
  test("materializes awaiting plan approval from unresolved plan events", async () => {
    const taskId = "task_plan_waiting_narrative";
    const runId = "rt_plan_waiting_narrative";
    await seedTask({ taskId, runId, taskState: "IN_PROGRESS" });
    await new ExecutionEventRepository().create({
      id: "event_plan_waiting_narrative",
      type: "leader.plan_proposed",
      taskId,
      roleRuntimeId: runId,
      requestId: "req_plan_waiting",
      occurredAt: new Date("2026-05-12T08:04:00.000Z"),
      payloadJson: JSON.stringify({
        plan: "## Plan\n- inspect\n- edit\n- verify",
      }),
    });

    const summary = await new TaskSummaryStore().get(taskId);

    expect(summary?.blockedNarrative).toMatchObject({
      reason: "awaiting_plan_approval",
      status: "waiting",
      message: "Waiting for plan approval.",
      nextAction: "Approve, revise, or cancel the proposed plan.",
      occurredAt: "2026-05-12T08:04:00.000Z",
    });
  });
});
