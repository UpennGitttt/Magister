import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-adapter-route-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `adapter-route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("adapter health reflects active runtimes and recent failures", async () => {
  const now = new Date("2026-04-10T10:10:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_adapter_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Check adapter health",
    description: "Check adapter health",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_adapter_1",
    taskId: "task_adapter_1",
    roleId: "coder",
    state: "RUNNING",
    activeExecutorId: "codex",
    currentSessionId: "session_adapter_1",
    attemptCount: 1,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: "event_adapter_1",
    type: "executor_session.failed",
    taskId: "task_adapter_1",
    roleRuntimeId: "runtime_adapter_1",
    severity: "error",
    occurredAt: new Date("2026-04-10T10:11:00.000Z"),
    payloadJson: JSON.stringify({ message: "sandbox timeout" }),
  });

  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/adapters/health",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          healthState: "degraded",
          activeSessionCount: 1,
          lastError: "sandbox timeout",
        }),
        expect.objectContaining({
          adapterId: "claude_code",
        }),
        expect.objectContaining({
          adapterId: "opencode",
        }),
        expect.objectContaining({
          adapterId: "qoder",
        }),
      ]),
    },
  });
});
