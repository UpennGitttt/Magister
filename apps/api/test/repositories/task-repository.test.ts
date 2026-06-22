import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";

const tempRoot = join(process.cwd(), ".tmp-test-db");

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

test("repositories create and load a task with linked runtime and event", async () => {
  const now = new Date();
  const taskId = "task_test_1";
  const runtimeId = "runtime_test_1";
  const eventId = "event_test_1";

  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "cli",
    title: "Bootstrap the control plane",
    description: "Create the first task from a repository test",
    state: "INTAKE",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: runtimeId,
    taskId,
    roleId: "leader",
    state: "CREATED",
    attemptCount: 0,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: eventId,
    type: "task.created",
    taskId,
    roleRuntimeId: runtimeId,
    severity: "info",
    occurredAt: now,
  });

  const task = await taskRepository.getById(taskId);
  const runtimes = await roleRuntimeRepository.listByTaskId(taskId);
  const events = await executionEventRepository.listByTaskId(taskId);

  expect(task?.title).toBe("Bootstrap the control plane");
  expect(runtimes).toHaveLength(1);
  expect(runtimes[0]?.roleId).toBe("leader");
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("task.created");
});
