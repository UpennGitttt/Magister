import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-spawn-teammates-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `batch-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("role_runtimes persists and reads back parallelGroupId", async () => {
  const { RoleRuntimeRepository } = await import(
    "../../src/repositories/role-runtime-repository"
  );
  const repo = new RoleRuntimeRepository();
  await repo.create({
    id: "rt_test_1",
    taskId: "task_1",
    roleId: "coder",
    state: "RUNNING",
    parallelGroupId: "pg_abc",
    attemptCount: 0,
    updatedAt: new Date(),
  });
  const group = await repo.listByParallelGroupId("pg_abc");
  expect(group.map((r) => r.id)).toEqual(["rt_test_1"]);
});

test("createLeaderTools includes spawn_teammates and it is concurrency-safe", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const tools = createLeaderTools(tempRoot);
  const batch = tools.find((t) => t.name === "spawn_teammates");
  expect(batch).toBeDefined();
  // Concurrency-safe only when every task is isolated (default). A bare
  // call with no tasks is treated as not-safe (see dedicated test below).
  expect(batch!.isConcurrencySafe({ tasks: [{ role: "coder", goal: "x" }] })).toBe(true);
  expect(batch!.isReadOnly({})).toBe(false);
});

test("spawn_teammates rejects empty task list", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const batch = createLeaderTools(tempRoot).find((t) => t.name === "spawn_teammates")!;
  const ctx: any = {
    taskId: "task_x",
    runId: "run_x",
    workspaceDir: tempRoot,
    recordEvent: async () => {},
  };
  const res = await batch.call({ tasks: [] } as any, ctx);
  expect(res.data).toContain("at least one task");
});

test("spawn_teammates is concurrency-safe only when all tasks are isolated", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const batch = createLeaderTools(tempRoot).find((t) => t.name === "spawn_teammates")!;
  // all isolated (default) → safe
  expect(batch.isConcurrencySafe({ tasks: [{ role: "coder", goal: "x" }] })).toBe(true);
  expect(batch.isConcurrencySafe({ tasks: [{ role: "coder", goal: "x", isolate: true }] })).toBe(true);
  // any non-isolated task → not safe
  expect(batch.isConcurrencySafe({ tasks: [{ role: "coder", goal: "x", isolate: false }] })).toBe(false);
  expect(batch.isConcurrencySafe({ tasks: [{ role: "a", goal: "x" }, { role: "b", goal: "y", isolate: false }] })).toBe(false);
  // empty/malformed → not safe
  expect(batch.isConcurrencySafe({ tasks: [] })).toBe(false);
});

test("default leader tool profile includes spawn_teammates", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  // The leader (no profileId) gets the full set.
  const names = createLeaderTools(tempRoot).map((t) => t.name);
  expect(names).toContain("spawn_teammates");
});

test("spawn_teammate usage notes point at spawn_teammates for fan-out", async () => {
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );
  const spawn = createLeaderTools(tempRoot).find((t) => t.name === "spawn_teammate")!;
  expect(spawn.description).toContain("spawn_teammates");
});

test("group completion requires the full encoded cohort AND all-terminal", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { isParallelGroupComplete } = await import(
    "../../src/services/manager-automation/teammate-completion-service"
  );
  const repo = new RoleRuntimeRepository();
  const now = new Date();
  // Group id encodes expected size 2 (trailing `_2`).
  // Partial group: only 1 of 2 rows exist (and COMPLETED) → not complete.
  await repo.create({ id: "rt_a", taskId: "t1", roleId: "coder", state: "COMPLETED", parallelGroupId: "pg_x_2", attemptCount: 0, updatedAt: now });
  expect(await isParallelGroupComplete("pg_x_2")).toBe(false);
  // Both rows present and COMPLETED → complete.
  await repo.create({ id: "rt_b", taskId: "t1", roleId: "coder", state: "COMPLETED", parallelGroupId: "pg_x_2", attemptCount: 0, updatedAt: now });
  expect(await isParallelGroupComplete("pg_x_2")).toBe(true);
});

test("group with full cohort but a non-terminal member is not complete", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { isParallelGroupComplete } = await import(
    "../../src/services/manager-automation/teammate-completion-service"
  );
  const repo = new RoleRuntimeRepository();
  const now = new Date();
  // Both members of the size-2 cohort exist, but one is still RUNNING.
  await repo.create({ id: "rt_c", taskId: "t2", roleId: "coder", state: "COMPLETED", parallelGroupId: "pg_y_2", attemptCount: 0, updatedAt: now });
  await repo.create({ id: "rt_d", taskId: "t2", roleId: "coder", state: "RUNNING", parallelGroupId: "pg_y_2", attemptCount: 0, updatedAt: now });
  expect(await isParallelGroupComplete("pg_y_2")).toBe(false);
});
