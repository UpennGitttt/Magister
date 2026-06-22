import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { TaskRepository } from "../../src/repositories/task-repository";

const tempRoot = join(process.cwd(), ".tmp-task-model-terminal-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `model-term-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

// A finished (DONE) conversation can still take a follow-up message that
// re-wakes the leader (POST /tasks/:taskId/messages), and that resume
// path applies tasks.model_override. So switching the model on a
// terminal task IS meaningful — the next turn uses it. The route must
// therefore NOT reject terminal tasks with task_terminal/409.
test("POST /tasks/:taskId/model on a DONE task is NOT rejected as terminal", async () => {
  const app = buildApp();
  const taskId = "task_done_model_switch";
  await new TaskRepository().create({
    id: taskId,
    title: "Done fixture",
    state: "DONE",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-05-12T09:00:00Z"),
    updatedAt: new Date("2026-05-12T09:05:00Z"),
  });

  // Empty modelName clears the override (next=null) — avoids needing a
  // configured model, isolating the terminal-state gate under test.
  const resp = await app.inject({
    method: "POST",
    url: `/tasks/${taskId}/model`,
    payload: { modelName: "" },
  });

  // The bug: terminal tasks returned 409 { code: "task_terminal" }.
  expect(resp.statusCode).not.toBe(409);
  const body = resp.json() as { ok?: boolean; error?: { code?: string } };
  expect(body.error?.code).not.toBe("task_terminal");
});
