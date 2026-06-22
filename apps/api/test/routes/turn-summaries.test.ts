import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";

const tempRoot = join(process.cwd(), ".tmp-turn-summaries-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `turn-summaries-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /tasks/:taskId/turn-summaries returns bounded per-request timing, tools, and usage", async () => {
  const taskId = "task_turn_summaries";
  const runId = "rt_leader_turn_summaries";
  const reqA = "req_summary_a";
  const reqB = "req_summary_b";

  await new TaskRepository().create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "Turn summaries",
    state: "DONE",
    createdAt: new Date("2026-05-12T08:00:00Z"),
    updatedAt: new Date("2026-05-12T08:00:00Z"),
  });
  await new RoleRuntimeRepository().create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    startedAt: new Date("2026-05-12T08:00:00Z"),
    updatedAt: new Date("2026-05-12T08:00:00Z"),
  });

  const events = new ExecutionEventRepository();
  await events.create({
    id: "evt_req_a_text",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.stream_delta",
    occurredAt: new Date("2026-05-12T08:00:01Z"),
    payloadJson: JSON.stringify({ type: "text_delta", text: "working" }),
  });
  await events.create({
    id: "evt_req_a_read",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.tool_call",
    occurredAt: new Date("2026-05-12T08:00:02Z"),
    payloadJson: JSON.stringify({ toolName: "read_file", toolUseId: "tool_read" }),
  });
  await events.create({
    id: "evt_req_a_spawn",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.tool_call",
    occurredAt: new Date("2026-05-12T08:00:03Z"),
    payloadJson: JSON.stringify({ toolName: "spawn_teammate", toolUseId: "tool_spawn" }),
  });
  await events.create({
    id: "evt_req_a_failed_result",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.tool_result",
    occurredAt: new Date("2026-05-12T08:00:04Z"),
    payloadJson: JSON.stringify({ toolUseId: "tool_spawn", isError: true }),
  });
  await events.create({
    id: "evt_req_a_write",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.tool_call",
    occurredAt: new Date("2026-05-12T08:00:04.100Z"),
    payloadJson: JSON.stringify({ toolName: "write_file", toolUseId: "tool_write" }),
  });
  await events.create({
    id: "evt_req_a_timeout",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "leader.tool_timeout",
    occurredAt: new Date("2026-05-12T08:00:04.200Z"),
    payloadJson: JSON.stringify({ toolUseId: "tool_write" }),
  });
  await events.create({
    id: "evt_req_a_done",
    taskId,
    roleRuntimeId: runId,
    requestId: reqA,
    type: "task:completed",
    occurredAt: new Date("2026-05-12T08:00:06Z"),
    payloadJson: JSON.stringify({
      state: "DONE",
      timing: {
        startedAtMs: 1_000,
        completedAtMs: 6_000,
        wallMs: 5_000,
        pausedMs: 0,
        elapsedMs: 5_000,
      },
    }),
  });
  await events.create({
    id: "evt_req_b_done",
    taskId,
    roleRuntimeId: runId,
    requestId: reqB,
    type: "task:completed",
    occurredAt: new Date("2026-05-12T08:01:00Z"),
    payloadJson: JSON.stringify({ state: "DONE" }),
  });

  const { TokenUsageRepository } = await import("../../src/repositories/token-usage-repository");
  await new TokenUsageRepository().record({
    taskId,
    runId,
    requestId: reqA,
    roleId: "leader",
    turnNumber: 1,
    model: "gpt-5.4",
    provider: "openai",
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0,
  });

  const response = await buildApp().inject({
    method: "GET",
    url: `/tasks/${taskId}/turn-summaries`,
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json() as {
    data: {
      items: Array<{
        requestId: string;
        status: string;
        timing?: { elapsedMs: number };
        usage: null | { inputTokens: number; outputTokens: number; totalTokens: number };
        toolSummary: {
          totalCount: number;
          readCount: number;
          writeCount: number;
          delegationCount: number;
          failedCount: number;
        };
      }>;
    };
  };

  const reqASummary = payload.data.items.find((item) => item.requestId === reqA);
  const reqBSummary = payload.data.items.find((item) => item.requestId === reqB);
  expect(reqASummary).toMatchObject({
    requestId: reqA,
    status: "completed",
    timing: { elapsedMs: 5_000 },
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    toolSummary: {
      totalCount: 3,
      readCount: 1,
      writeCount: 1,
      delegationCount: 1,
      failedCount: 2,
    },
  });
  expect(reqBSummary?.usage).toBeNull();
});
