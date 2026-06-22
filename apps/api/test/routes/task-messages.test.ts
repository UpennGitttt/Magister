import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { TaskRepository } from "../../src/repositories/task-repository";

const tempRoot = join(process.cwd(), ".tmp-task-messages-test");
const originalConsoleInfo = console.info;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `messages-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  console.info = originalConsoleInfo;
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_SESSION_PERF_LOG_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /tasks/:taskId/messages can return the latest visible messages", async () => {
  const perfLogs: string[] = [];
  process.env.MAGISTER_SESSION_PERF_LOG_MS = "0";
  console.info = (...args: unknown[]) => {
    perfLogs.push(args.map((arg) => String(arg)).join(" "));
  };

  const app = buildApp();
  const taskId = "task_messages_tail";
  await new TaskRepository().create({
    id: taskId,
    title: "Messages tail fixture",
    state: "DONE",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: new Date("2026-05-12T09:00:00Z"),
    updatedAt: new Date("2026-05-12T09:05:00Z"),
  });

  const events = new ExecutionEventRepository();
  await events.create({
    id: "evt-message-noise",
    type: "leader.stream_delta",
    taskId,
    roleRuntimeId: "rt_messages_tail",
    occurredAt: new Date("2026-05-12T09:01:00Z"),
    payloadJson: JSON.stringify({ delta: "ignored" }),
  });
  await events.create({
    id: "evt-message-old-checkpoint",
    type: "leader.session_checkpoint",
    taskId,
    roleRuntimeId: "rt_messages_tail",
    occurredAt: new Date("2026-05-12T09:02:00Z"),
    payloadJson: JSON.stringify({
      messages: [
        { type: "user", content: "old user" },
        { type: "assistant", content: [{ type: "text", text: "old assistant" }] },
      ],
    }),
  });
  await events.create({
    id: "evt-message-latest-checkpoint",
    type: "leader.session_checkpoint",
    taskId,
    roleRuntimeId: "rt_messages_tail",
    occurredAt: new Date("2026-05-12T09:03:00Z"),
    payloadJson: JSON.stringify({
      messages: [
        { type: "user", content: "first user" },
        { type: "assistant", content: [{ type: "text", text: "first assistant" }] },
        { type: "user", isMeta: true, content: "[Session Progress] hidden" },
        { type: "user", content: "latest user" },
        { type: "assistant", content: [{ type: "text", text: "latest assistant" }] },
      ],
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${taskId}/messages?tail=true&limit=2`,
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    data: {
      messages: Array<{ type: string; content: unknown }>;
      total: number;
      offset: number;
      limit: number;
    };
  };
  expect(body.data.total).toBe(4);
  expect(body.data.offset).toBe(2);
  expect(body.data.limit).toBe(2);
  expect(body.data.messages.map((message) => message.content)).toEqual([
    "latest user",
    [{ type: "text", text: "latest assistant" }],
  ]);

  const perfLog = perfLogs.find((line) => line.includes("[session-perf] /tasks/:taskId/messages"));
  expect(perfLog).toBeDefined();
  expect(perfLog).toContain('"taskId":"task_messages_tail"');
  expect(perfLog).toContain('"tail":true');
  expect(perfLog).toContain('"total":4');
  expect(perfLog).toContain('"returned":2');
});
