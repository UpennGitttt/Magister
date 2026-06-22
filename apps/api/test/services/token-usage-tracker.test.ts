import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the DB BEFORE any import that resolves the db client.
// Previously this test wrote 1000/2000/1200/300/2000/3000 token rows
// for models "gpt-5.4" / "kimi-k2.6-ark" to whatever MAGISTER_DB_PATH
// pointed at — defaulting to the project's `.local/control-plane.sqlite`
// (the prod local DB). Every `bun run test` polluted Diagnostics ›
// Usage-by-Model with these perfectly-round fixture numbers mixed in
// with real model calls.
const tempDir = mkdtempSync(join(tmpdir(), "magister-token-usage-test-"));
process.env.MAGISTER_DB_PATH = join(tempDir, "test.sqlite");
process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(tempDir, "executors.json");

import {
  getRecentUsage,
  getTaskUsage,
  recordUsage,
} from "../../src/services/token-usage-service";

afterAll(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

test("recordUsage stores input and output tokens", async () => {
  const taskId = uniqueId("task");
  const runId = uniqueId("run");

  const record = await recordUsage({
    taskId,
    runId,
    turnNumber: 1,
    model: "gpt-5.4",
    provider: "openai",
    inputTokens: 1200,
    outputTokens: 300,
  });

  expect(record.taskId).toBe(taskId);
  expect(record.runId).toBe(runId);
  expect(record.inputTokens).toBe(1200);
  expect(record.outputTokens).toBe(300);
  expect(typeof record.timestamp).toBe("number");
  expect(record.timestamp).toBeGreaterThan(0);
});

test("getTaskUsage aggregates all usage for a task", async () => {
  const taskId = uniqueId("task");
  const runId = uniqueId("run");

  await recordUsage({
    taskId,
    runId,
    turnNumber: 1,
    model: "gpt-5.4",
    provider: "openai",
    inputTokens: 1000,
    outputTokens: 2000,
  });
  await recordUsage({
    taskId,
    runId,
    turnNumber: 2,
    model: "kimi-k2.6-ark",
    provider: "volcengine",
    inputTokens: 2000,
    outputTokens: 3000,
  });

  const summary = await getTaskUsage(taskId);

  expect(summary.taskId).toBe(taskId);
  expect(summary.totalInputTokens).toBe(3000);
  expect(summary.totalOutputTokens).toBe(5000);
  expect(summary.turnCount).toBe(2);
  expect(summary.models.sort()).toEqual(["gpt-5.4", "kimi-k2.6-ark"].sort());
});

test("getTaskUsage resolves context window from model config when agent profile has none", async () => {
  writeFileSync(
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH!,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {},
      models: {
        "deepseek-v4-pro[1m]": {
          modelName: "deepseek-v4-pro[1m]",
          contextWindow: 1_000_000,
          maxOutputTokens: 65_536,
          providerRefs: { api: "DeepSeek" },
        },
      },
      bindings: {},
    }),
  );

  const taskId = uniqueId("task_context_window");
  await recordUsage({
    taskId,
    runId: uniqueId("rt_leader"),
    requestId: uniqueId("req"),
    roleId: "leader",
    turnNumber: 1,
    model: "deepseek-v4-pro[1m]",
    provider: "DeepSeek",
    inputTokens: 1240,
    outputTokens: 174,
    cacheReadTokens: 50_304,
    usageSource: "estimated",
    estimatedPromptTokens: 25_703,
  });

  const summary = await getTaskUsage(taskId);

  expect(summary.latestInputTokens).toBe(25_703);
  expect(summary.contextWindow).toBe(1_000_000);
});

test("recordUsage caps raw usage at the persistence boundary", async () => {
  const taskId = uniqueId("task_raw_cap");
  const runId = uniqueId("rt_leader_raw_cap");

  await recordUsage({
    taskId,
    runId,
    turnNumber: 1,
    model: "gpt-5.5",
    provider: "openai",
    inputTokens: 100,
    outputTokens: 20,
    rawUsage: { payload: "x".repeat(20_000) },
  });

  const [row] = await getRecentUsage(1);
  expect(row?.taskId).toBe(taskId);
  expect(row?.rawUsage).toEqual({
    truncated: true,
    originalBytes: expect.any(Number),
    maxBytes: 16 * 1024,
  });
  expect((row?.rawUsage as { originalBytes?: number } | undefined)?.originalBytes).toBeGreaterThan(16 * 1024);
});

test("getTaskUsage resolves latest model and context window from leader usage only", async () => {
  writeFileSync(
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH!,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {},
      models: {
        "leader-small": {
          modelName: "leader-small",
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          providerRefs: { api: "openai" },
        },
        "teammate-large": {
          modelName: "teammate-large",
          contextWindow: 1_000_000,
          maxOutputTokens: 65_536,
          providerRefs: { cli: "opencode" },
        },
      },
      bindings: {},
    }),
  );

  const taskId = uniqueId("task_leader_context_window");
  await recordUsage({
    taskId,
    runId: uniqueId("rt_leader"),
    requestId: uniqueId("req_leader"),
    roleId: "leader",
    turnNumber: 1,
    model: "leader-small",
    provider: "openai",
    inputTokens: 31_500,
    outputTokens: 900,
  });
  await recordUsage({
    taskId,
    runId: uniqueId("runtime_reviewer"),
    requestId: uniqueId("req_reviewer"),
    roleId: "reviewer",
    turnNumber: 1,
    model: "teammate-large",
    provider: "cli:opencode",
    inputTokens: 500_000,
    outputTokens: 40_000,
  });

  const summary = await getTaskUsage(taskId);

  expect(summary.totalInputTokens).toBe(531_500);
  expect(summary.totalOutputTokens).toBe(40_900);
  expect(summary.leaderInputTokens).toBe(31_500);
  expect(summary.leaderOutputTokens).toBe(900);
  expect(summary.teammateInputTokens).toBe(500_000);
  expect(summary.teammateOutputTokens).toBe(40_000);
  expect(summary.latestModel).toBe("leader-small");
  expect(summary.latestProvider).toBe("openai");
  expect(summary.leaderLatestModel).toBe("leader-small");
  expect(summary.leaderLatestProvider).toBe("openai");
  expect(summary.latestInputTokens).toBe(31_500);
  expect(summary.leaderLatestInputTokens).toBe(31_500);
  expect(summary.contextWindow).toBe(200_000);
  expect(summary.leaderContextWindow).toBe(200_000);
});

test("getTaskUsage returns zero for unknown task", async () => {
  const taskId = uniqueId("unknown_task");
  const summary = await getTaskUsage(taskId);

  expect(summary).toEqual({
    taskId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    leaderInputTokens: 0,
    leaderOutputTokens: 0,
    teammateInputTokens: 0,
    teammateOutputTokens: 0,
    turnCount: 0,
    models: [],
    latestModel: null,
    latestProvider: null,
    leaderLatestModel: null,
    leaderLatestProvider: null,
    latestInputTokens: 0,
    peakInputTokens: 0,
    leaderLatestInputTokens: 0,
    leaderPeakInputTokens: 0,
    usageSplitKnown: true,
    contextWindow: null,
    leaderContextWindow: null,
    byRole: [],
  });
});
