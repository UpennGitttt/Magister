import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-05-22 — isolated DB MUST be set before TaskRepository import.
const isolatedDb = join(tmpdir(), `magister-subgoal-db-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.MAGISTER_DB_PATH = isolatedDb;

import {
  addSubgoal,
  clearSubgoals,
  listSubgoals,
  parseSubgoals,
  removeSubgoal,
} from "../../../src/services/goal-mode/subgoal-service";
import { TaskRepository } from "../../../src/repositories/task-repository";

const taskRepo = new TaskRepository();
const WS_ID = "ws_subgoal_test";

async function createGoalTask() {
  const id = `task_sub_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  await taskRepo.create({
    id,
    workspaceId: WS_ID,
    title: "test task",
    state: "RUNNING",
    source: "web",
    submittedBy: "user",
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    // Goal must be active so addSubgoal accepts it.
    goalObjective: "Refactor auth",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    goalId: "test-goal-id",
  } as Parameters<TaskRepository["create"]>[0]);
  return id;
}

describe("parseSubgoals", () => {
  test("returns empty array for null / undefined", () => {
    expect(parseSubgoals(null)).toEqual([]);
    expect(parseSubgoals(undefined)).toEqual([]);
  });

  test("returns empty array for invalid JSON / non-array", () => {
    expect(parseSubgoals("not json")).toEqual([]);
    expect(parseSubgoals('{"foo": "bar"}')).toEqual([]);
  });

  test("filters non-string and empty entries", () => {
    expect(parseSubgoals('["one", 42, "", "two"]')).toEqual(["one", "two"]);
  });

  test("happy path", () => {
    expect(parseSubgoals('["x", "y"]')).toEqual(["x", "y"]);
  });
});

describe("subgoal-service CRUD", () => {
  test("addSubgoal happy path", async () => {
    const taskId = await createGoalTask();
    const r = await addSubgoal(taskId, "Add unit tests");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.subgoals).toEqual(["Add unit tests"]);
  });

  test("addSubgoal preserves order across multiple adds", async () => {
    const taskId = await createGoalTask();
    await addSubgoal(taskId, "first");
    await addSubgoal(taskId, "second");
    const r = await addSubgoal(taskId, "third");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.subgoals).toEqual(["first", "second", "third"]);
  });

  test("addSubgoal rejects empty text", async () => {
    const taskId = await createGoalTask();
    const r = await addSubgoal(taskId, "   ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalid_subgoal");
  });

  test("addSubgoal rejects when task has no active goal", async () => {
    const id = `task_nogoal_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date();
    await taskRepo.create({
      id,
      workspaceId: WS_ID,
      title: "no goal here",
      state: "RUNNING",
      source: "web",
      submittedBy: "user",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    } as Parameters<TaskRepository["create"]>[0]);
    const r = await addSubgoal(id, "won't take");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("no_active_goal");
  });

  test("removeSubgoal happy path (1-based index)", async () => {
    const taskId = await createGoalTask();
    await addSubgoal(taskId, "a");
    await addSubgoal(taskId, "b");
    await addSubgoal(taskId, "c");
    const r = await removeSubgoal(taskId, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.subgoals).toEqual(["a", "c"]);
  });

  test("removeSubgoal rejects 0-based / negative index", async () => {
    const taskId = await createGoalTask();
    await addSubgoal(taskId, "a");
    expect((await removeSubgoal(taskId, 0)).ok).toBe(false);
    expect((await removeSubgoal(taskId, -1)).ok).toBe(false);
  });

  test("removeSubgoal rejects out-of-range index", async () => {
    const taskId = await createGoalTask();
    await addSubgoal(taskId, "only");
    const r = await removeSubgoal(taskId, 5);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("index_out_of_range");
  });

  test("clearSubgoals empties the list", async () => {
    const taskId = await createGoalTask();
    await addSubgoal(taskId, "a");
    await addSubgoal(taskId, "b");
    const r = await clearSubgoals(taskId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.subgoals).toEqual([]);
    const list = await listSubgoals(taskId);
    expect(list.ok && list.data.subgoals.length).toBe(0);
  });

  test("listSubgoals on a task with no goal returns no_active_goal", async () => {
    const id = `task_li_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date();
    await taskRepo.create({
      id,
      workspaceId: WS_ID,
      title: "nope",
      state: "RUNNING",
      source: "web",
      submittedBy: "user",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    } as Parameters<TaskRepository["create"]>[0]);
    const r = await listSubgoals(id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("no_active_goal");
  });
});
