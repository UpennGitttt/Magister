import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-05-22 — isolated DB MUST be set before TaskRepository is imported,
// otherwise the first test write lands in the real .local/control-plane.sqlite
// and pollutes the live DB with phantom "active goal" rows.
const isolatedDb = join(tmpdir(), `magister-startgoal-db-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.MAGISTER_DB_PATH = isolatedDb;

import { startGoalOnExistingTask } from "../../../src/services/goal-mode/start-goal-service";
import { TaskRepository } from "../../../src/repositories/task-repository";

/**
 * Mid-conversation goal start (v3 §P0-1).
 *
 * Covers the failure-mode matrix from the spec's acceptance criteria:
 *   - task_not_found / task_terminal / goal_already_active /
 *     invalid_objective
 * Plus the happy path: writes goal_* columns, initializes plan.md
 * with a Prior context section, leaves mailbox + worker alone (the
 * caller's createTask is what drives the actual turn).
 */

const WS_ID = "ws_start_test";
let tmpRoot: string;
const taskRepo = new TaskRepository();

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "magister-startgoal-"));
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({ [WS_ID]: tmpRoot });
});

afterEach(async () => {
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function createBaseTask(overrides: Record<string, unknown> = {}) {
  const taskId = `task_start_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  // Cast to any to tolerate test-only overrides like `latestAnswer`
  // that don't exist on the strict CreateTaskInput type.
  await taskRepo.create({
    id: taskId,
    workspaceId: WS_ID,
    title: "existing chat",
    description: "hi",
    state: "RUNNING",
    source: "web",
    submittedBy: "user",
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Parameters<TaskRepository["create"]>[0]);
  return taskId;
}

describe("startGoalOnExistingTask", () => {
  test("happy path — sets goal_* columns + initializes plan.md with prior context", async () => {
    const taskId = await createBaseTask({
      title: "fix the auth flow",
      description: "Originally asked: can you help fix the auth flow?",
    });
    const result = await startGoalOnExistingTask({
      taskId,
      objective: "Refactor user auth to JWT",
      tokenBudget: 50000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.goalStatus).toBe("active");
    expect(result.data.tokenBudget).toBe(50000);

    const task = await taskRepo.getById(taskId);
    expect(task?.goalObjective).toBe("Refactor user auth to JWT");
    expect(task?.goalStatus).toBe("active");
    expect(task?.goalTokensUsed).toBe(0);
    expect(task?.goalIterations).toBe(0);
    expect(task?.goalId).toBeTruthy();
    expect(task?.goalPlanPath).toBeTruthy();

    // Plan.md contains both objective and Prior context with title +
    // initial-prompt snippets pulled from the existing task.
    const planPath = join(tmpRoot, task!.goalPlanPath!);
    const content = await readFile(planPath, "utf8");
    expect(content).toContain("Refactor user auth to JWT");
    expect(content).toContain("## Prior context");
    expect(content).toContain("fix the auth flow");
    expect(content).toContain("mid-conversation");
  });

  test("rejects: task_not_found", async () => {
    const result = await startGoalOnExistingTask({
      taskId: "task_doesnt_exist",
      objective: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("task_not_found");
  });

  test("rejects: task_terminal (already COMPLETED)", async () => {
    const taskId = await createBaseTask({ state: "COMPLETED" });
    const result = await startGoalOnExistingTask({
      taskId,
      objective: "too late",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("task_terminal");
  });

  test("rejects: goal_already_active", async () => {
    const taskId = await createBaseTask();
    // First start succeeds.
    await startGoalOnExistingTask({ taskId, objective: "first" });
    // Second start refused.
    const result = await startGoalOnExistingTask({
      taskId,
      objective: "second",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("goal_already_active");
  });

  test("allows re-start after a previous goal was cancelled", async () => {
    const taskId = await createBaseTask();
    await startGoalOnExistingTask({ taskId, objective: "first" });
    // Simulate user cancellation.
    await taskRepo.update(taskId, {
      goalStatus: "cancelled",
      goalCompletedAt: Date.now(),
      updatedAt: new Date(),
    });
    // Now starting a fresh goal should work.
    const result = await startGoalOnExistingTask({
      taskId,
      objective: "second attempt",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects: empty objective", async () => {
    const taskId = await createBaseTask();
    const result = await startGoalOnExistingTask({ taskId, objective: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_objective");
  });

  test("does not require a workspace path map to succeed (plan.md write is best-effort)", async () => {
    // Drop the env mapping so the workspace path can't be resolved.
    // Goal fields should still be written; only plan.md fails silently.
    const taskId = await createBaseTask();
    delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
    const result = await startGoalOnExistingTask({
      taskId,
      objective: "Refactor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = await taskRepo.getById(taskId);
    expect(task?.goalObjective).toBe("Refactor");
    // Restore for afterEach cleanup.
    process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({ [WS_ID]: tmpRoot });
  });
});
