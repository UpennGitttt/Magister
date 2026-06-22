import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-05-22 — isolated DB MUST be set before TaskRepository import.
const isolatedDb = join(tmpdir(), `magister-editobj-db-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.MAGISTER_DB_PATH = isolatedDb;

import { editGoalObjective } from "../../../src/services/goal-mode/edit-objective-service";
import { TaskRepository } from "../../../src/repositories/task-repository";

const WS_ID = "ws_edit_obj";
let tmpRoot: string;
const taskRepo = new TaskRepository();

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "magister-editobj-"));
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({ [WS_ID]: tmpRoot });
});

afterEach(async () => {
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function createGoalTask(overrides: Record<string, unknown> = {}) {
  const id = `task_edit_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  await taskRepo.create({
    id,
    workspaceId: WS_ID,
    title: "test",
    state: "RUNNING",
    source: "web",
    submittedBy: "user",
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    goalObjective: "old objective",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    goalId: "test-goal-1",
    ...overrides,
  } as Parameters<TaskRepository["create"]>[0]);
  return id;
}

describe("editGoalObjective", () => {
  test("happy path — updates objective, sets edited_at, clears verifier", async () => {
    const taskId = await createGoalTask({
      goalLastVerifierVerdict: "READY",
      goalLastVerifierAt: Date.now() - 1000,
      goalLastVerifierBlocker: null,
    });
    const r = await editGoalObjective({ taskId, objective: "new objective" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.objective).toBe("new objective");

    const t = await taskRepo.getById(taskId);
    expect(t?.goalObjective).toBe("new objective");
    expect(t?.goalObjectiveEditedAt).toBeGreaterThan(0);
    // Old verdict cleared — must re-verify against new objective.
    expect(t?.goalLastVerifierVerdict).toBeNull();
    expect(t?.goalLastVerifierAt).toBeNull();
  });

  test("rejects task_not_found", async () => {
    const r = await editGoalObjective({ taskId: "task_nope", objective: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("task_not_found");
  });

  test("rejects when goal terminal (complete)", async () => {
    const taskId = await createGoalTask({ goalStatus: "complete" });
    const r = await editGoalObjective({ taskId, objective: "won't take" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("goal_not_active");
  });

  test("allows edit on paused goal (user may want to redirect before resume)", async () => {
    const taskId = await createGoalTask({ goalStatus: "paused" });
    const r = await editGoalObjective({ taskId, objective: "redirected" });
    expect(r.ok).toBe(true);
  });

  test("rejects empty objective", async () => {
    const taskId = await createGoalTask();
    const r = await editGoalObjective({ taskId, objective: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalid_objective");
  });
});
