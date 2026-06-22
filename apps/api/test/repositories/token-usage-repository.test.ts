/**
 * TokenUsageRepository tests — pin the durability + retention
 * behavior introduced in P1. The kimi review of 460ce6e flagged
 * concrete failure modes (timestamp ties surviving the cap, race
 * between count-and-delete) that we now fix and lock here.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "token-usage-repo-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("record + getTaskAggregate round-trip survives across handle reuse", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_rt",
    workspaceId: "workspace_main",
    source: "web",
    title: "Round-trip",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repo = new TokenUsageRepository();
  await repo.record({
    taskId: "task_rt",
    runId: "run_a",
    turnNumber: 1,
    model: "kimi-k2.6-ark",
    provider: "volcengine",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
  });
  await repo.record({
    taskId: "task_rt",
    runId: "run_a",
    turnNumber: 2,
    model: "glm-5.1-ark",
    provider: "volcengine",
    inputTokens: 200,
    outputTokens: 80,
    costUsd: 0.002,
  });

  const agg = await repo.getTaskAggregate("task_rt");
  expect(agg.totalInputTokens).toBe(300);
  expect(agg.totalOutputTokens).toBe(130);
  expect(agg.turnCount).toBe(2);
  expect(new Set(agg.models)).toEqual(new Set(["kimi-k2.6-ark", "glm-5.1-ark"]));
  expect(agg.latestModel).toBe("glm-5.1-ark");
  expect(agg.latestProvider).toBe("volcengine");
});

test("getTaskAggregate counts request ids as chat turns, not model calls", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_request_turns",
    workspaceId: "workspace_main",
    source: "web",
    title: "Request turns",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repo = new TokenUsageRepository();
  await repo.record({
    taskId: "task_request_turns",
    runId: "run_a",
    requestId: "req_tool_turn",
    roleId: "leader",
    turnNumber: 1,
    model: "kimi-k2.6",
    provider: "anthropic",
    inputTokens: 100,
    outputTokens: 20,
    costUsd: null,
  });
  await repo.record({
    taskId: "task_request_turns",
    runId: "run_a",
    requestId: "req_tool_turn",
    roleId: "leader",
    turnNumber: 2,
    model: "kimi-k2.6",
    provider: "anthropic",
    inputTokens: 120,
    outputTokens: 30,
    costUsd: null,
  });
  await repo.record({
    taskId: "task_request_turns",
    runId: "run_a",
    requestId: "req_followup",
    roleId: "leader",
    turnNumber: 1,
    model: "kimi-k2.6",
    provider: "anthropic",
    inputTokens: 140,
    outputTokens: 40,
    costUsd: null,
  });

  const agg = await repo.getTaskAggregate("task_request_turns");
  expect(agg.totalInputTokens).toBe(360);
  expect(agg.totalOutputTokens).toBe(90);
  expect(agg.turnCount).toBe(2);
});

test("getTaskAggregate does not let legacy null request rows inflate visible chat turns", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_request_turns_with_legacy",
    workspaceId: "workspace_main",
    source: "web",
    title: "Request turns with legacy rows",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values([
    {
      id: "usage_req_a",
      taskId: "task_request_turns_with_legacy",
      runId: "rt_leader_a",
      requestId: "req_a",
      roleId: "leader",
      turnNumber: 1,
      model: "kimi-k2.6",
      provider: "volcengine",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: null,
      recordedAt: new Date("2026-05-12T08:00:00Z"),
    },
    {
      id: "usage_req_b",
      taskId: "task_request_turns_with_legacy",
      runId: "rt_leader_a",
      requestId: "req_b",
      roleId: "leader",
      turnNumber: 2,
      model: "kimi-k2.6",
      provider: "volcengine",
      inputTokens: 120,
      outputTokens: 30,
      costUsd: null,
      recordedAt: new Date("2026-05-12T08:00:01Z"),
    },
    {
      id: "usage_legacy_null_request",
      taskId: "task_request_turns_with_legacy",
      runId: "rt_coder_legacy",
      requestId: null,
      roleId: "coder",
      turnNumber: 1,
      model: "gpt-5.5",
      provider: "openai",
      inputTokens: 90,
      outputTokens: 10,
      costUsd: null,
      recordedAt: new Date("2026-05-12T08:00:02Z"),
    },
  ]);

  const agg = await new TokenUsageRepository().getTaskAggregate("task_request_turns_with_legacy");
  expect(agg.turnCount).toBe(2);
});

test("listUsageByRequestIds aggregates request-scoped rows and ignores legacy null request ids", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_turn_usage",
    workspaceId: "workspace_main",
    source: "web",
    title: "Turn usage",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(tokenUsageRecords).values([
    {
      id: "usage_req_a_1",
      taskId: "task_turn_usage",
      runId: "run_a",
      requestId: "req_a",
      roleId: "leader",
      turnNumber: 1,
      model: "gpt-5.4",
      provider: "openai",
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.001,
      recordedAt: new Date("2026-05-12T08:00:00Z"),
    },
    {
      id: "usage_req_a_2",
      taskId: "task_turn_usage",
      runId: "run_a",
      requestId: "req_a",
      roleId: "leader",
      turnNumber: 1,
      model: "gpt-5.4",
      provider: "openai",
      inputTokens: 50,
      outputTokens: 10,
      costUsd: 0.002,
      recordedAt: new Date("2026-05-12T08:00:01Z"),
    },
    {
      id: "usage_legacy",
      taskId: "task_turn_usage",
      runId: "run_a",
      requestId: null,
      roleId: "leader",
      turnNumber: 2,
      model: "gpt-5.4",
      provider: "openai",
      inputTokens: 999,
      outputTokens: 999,
      costUsd: 0.999,
      recordedAt: new Date("2026-05-12T08:00:02Z"),
    },
  ]);

  const rows = await new TokenUsageRepository().listUsageByRequestIds("task_turn_usage", [
    "req_a",
    "req_missing",
  ]);

  expect(rows).toEqual([
    {
      requestId: "req_a",
      inputTokens: 150,
      outputTokens: 35,
      totalTokens: 185,
    },
  ]);
});

test("listUsageByRequestIds returns null cost when request rows have no cost", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_turn_usage_no_cost",
    workspaceId: "workspace_main",
    source: "web",
    title: "Turn usage without cost",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(tokenUsageRecords).values({
    id: "usage_req_no_cost",
    taskId: "task_turn_usage_no_cost",
    runId: "run_a",
    requestId: "req_no_cost",
    roleId: "leader",
    turnNumber: 1,
    model: "gpt-5.4",
    provider: "openai",
    inputTokens: 100,
    outputTokens: 25,
    costUsd: null,
    recordedAt: new Date("2026-05-12T08:00:00Z"),
  });

  const rows = await new TokenUsageRepository().listUsageByRequestIds("task_turn_usage_no_cost", [
    "req_no_cost",
  ]);

  expect(rows).toEqual([
    {
      requestId: "req_no_cost",
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    },
  ]);
});

test("latestInputTokens prefers provider usage over estimated_prompt_tokens", async () => {
  // Normalized provider rows already carry the provider's inclusive
  // inputTokens. The UI must not let the char-based estimate hide that
  // provider value. Provider-side non-token billing-unit anomalies are
  // handled separately by usage_source='estimated' / future adjusted rows.
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_ctx_max",
    workspaceId: "workspace_main",
    source: "web",
    title: "Context max within request",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values([
    // Earlier request: 5K input + 3K cache_read = 8K. Should NOT be
    // picked — there's a newer request_id.
    {
      id: "ctx_old_1",
      taskId: "task_ctx_max",
      runId: "rt_leader_x",
      requestId: "req_older",
      roleId: "leader",
      turnNumber: 1,
      model: "deepseek-v4-pro",
      provider: "dashscope",
      inputTokens: 5_000,
      outputTokens: 100,
      cacheReadTokens: 3_000,
      usageSource: "provider",
      recordedAt: new Date("2026-05-22T08:00:00Z"),
    },
    // Latest request, turn 1: 28826 input. Our estimate also says ~29K.
    {
      id: "ctx_latest_1",
      taskId: "task_ctx_max",
      runId: "rt_leader_x",
      requestId: "req_latest",
      roleId: "leader",
      turnNumber: 1,
      model: "deepseek-v4-pro",
      provider: "dashscope",
      inputTokens: 28_826,
      outputTokens: 445,
      cacheReadTokens: 0,
      estimatedPromptTokens: 29_000,
      usageSource: "provider",
      recordedAt: new Date("2026-05-22T08:01:00Z"),
    },
    // Latest request, turn 2: provider reports 578 and an estimate is
    // also present. Because usageSource='provider', provider wins.
    {
      id: "ctx_latest_2",
      taskId: "task_ctx_max",
      runId: "rt_leader_x",
      requestId: "req_latest",
      roleId: "leader",
      turnNumber: 2,
      model: "deepseek-v4-pro",
      provider: "dashscope",
      inputTokens: 578,
      outputTokens: 435,
      cacheReadTokens: 0,
      estimatedPromptTokens: 30_200,
      usageSource: "provider",
      recordedAt: new Date("2026-05-22T08:01:30Z"),
    },
    // Teammate row on the same task — must be ignored by Bug 2 filter
    // (run_id LIKE 'rt_leader_%'). Even though it's the most recent
    // row, it's a teammate so it doesn't represent leader context.
    {
      id: "ctx_teammate",
      taskId: "task_ctx_max",
      runId: "rt_coder_y",
      requestId: "req_teammate",
      roleId: "coder",
      turnNumber: 1,
      model: "kimi-k2.6",
      provider: "volcengine",
      inputTokens: 999_999,
      outputTokens: 1,
      cacheReadTokens: 0,
      usageSource: "provider",
      recordedAt: new Date("2026-05-22T08:02:00Z"),
    },
  ]);

  const agg = await new TokenUsageRepository().getTaskAggregate("task_ctx_max");
  // Latest (request_id, turn_number) is (req_latest, 2). Provider
  // input is 578 and must not be overridden by estimatedPromptTokens.
  expect(agg.latestInputTokens).toBe(578);
  // Peak across all leader provider rows uses inclusive inputTokens
  // only; cache is a breakdown and must not be added a second time.
  expect(agg.peakInputTokens).toBe(28_826);
});

test("getTaskAggregate splits leader and teammate tokens and keeps latest model leader-scoped", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_leader_teammate_split",
    workspaceId: "workspace_main",
    source: "web",
    title: "Leader teammate split",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values([
    {
      id: "split_leader_old",
      taskId: "task_leader_teammate_split",
      runId: "rt_leader_split",
      requestId: "req_leader_old",
      roleId: "leader",
      turnNumber: 1,
      model: "gpt-5.5",
      provider: "openai",
      inputTokens: 1_000,
      outputTokens: 100,
      usageSource: "provider",
      recordedAt: new Date("2026-05-27T08:00:00Z"),
    },
    {
      id: "split_leader_latest",
      taskId: "task_leader_teammate_split",
      runId: "rt_leader_split",
      requestId: "req_leader_latest",
      roleId: "leader",
      turnNumber: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      inputTokens: 2_000,
      outputTokens: 200,
      usageSource: "provider",
      recordedAt: new Date("2026-05-27T08:01:00Z"),
    },
    {
      id: "split_teammate_latest",
      taskId: "task_leader_teammate_split",
      runId: "runtime_reviewer_split",
      requestId: "req_teammate_latest",
      roleId: "reviewer",
      turnNumber: 1,
      model: "opencode-gpt-5.5",
      provider: "cli:opencode",
      inputTokens: 7_000,
      outputTokens: 700,
      usageSource: "provider",
      recordedAt: new Date("2026-05-27T08:02:00Z"),
    },
  ]);

  const agg = await new TokenUsageRepository().getTaskAggregate("task_leader_teammate_split");
  expect(agg.totalInputTokens).toBe(10_000);
  expect(agg.totalOutputTokens).toBe(1_000);
  expect(agg.leaderInputTokens).toBe(3_000);
  expect(agg.leaderOutputTokens).toBe(300);
  expect(agg.teammateInputTokens).toBe(7_000);
  expect(agg.teammateOutputTokens).toBe(700);
  expect(agg.latestModel).toBe("claude-sonnet-4-6");
  expect(agg.latestProvider).toBe("anthropic");
  expect(agg.latestInputTokens).toBe(2_000);
});

test("getTaskAggregate marks legacy unscoped usage split as unknown", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_legacy_usage_split",
    workspaceId: "workspace_main",
    source: "web",
    title: "Legacy usage split",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values([
    {
      id: "legacy_usage_a",
      taskId: "task_legacy_usage_split",
      runId: "run_a",
      requestId: null,
      roleId: null,
      turnNumber: 1,
      model: "gpt-5.4",
      provider: "openai",
      inputTokens: 1_000,
      outputTokens: 100,
      usageSource: null,
      recordedAt: new Date("2026-05-27T08:00:00Z"),
    },
    {
      id: "legacy_usage_b",
      taskId: "task_legacy_usage_split",
      runId: "run_a",
      requestId: null,
      roleId: null,
      turnNumber: 2,
      model: "gpt-5.4",
      provider: "openai",
      inputTokens: 2_000,
      outputTokens: 200,
      usageSource: null,
      recordedAt: new Date("2026-05-27T08:01:00Z"),
    },
  ]);

  const agg = await new TokenUsageRepository().getTaskAggregate("task_legacy_usage_split");
  expect(agg.totalInputTokens).toBe(3_000);
  expect(agg.totalOutputTokens).toBe(300);
  expect(agg.usageSplitKnown).toBe(false);
  expect(agg.leaderInputTokens).toBe(3_000);
  expect(agg.leaderOutputTokens).toBe(300);
  expect(agg.teammateInputTokens).toBe(0);
  expect(agg.teammateOutputTokens).toBe(0);
});

test("latestInputTokens falls back to estimated_prompt_tokens for estimated rows", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_ctx_estimated",
    workspaceId: "workspace_main",
    source: "web",
    title: "Estimated context",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values({
    id: "ctx_estimated_1",
    taskId: "task_ctx_estimated",
    runId: "rt_leader_est",
    requestId: "req_estimated",
    roleId: "leader",
    turnNumber: 1,
    model: "ark-billing-units",
    provider: "volcengine",
    inputTokens: 578,
    outputTokens: 100,
    estimatedPromptTokens: 30_200,
    usageSource: "estimated",
    recordedAt: new Date("2026-05-22T08:01:30Z"),
  });

  const agg = await new TokenUsageRepository().getTaskAggregate("task_ctx_estimated");
  expect(agg.latestInputTokens).toBe(30_200);
});

test("latestInputTokens reflects compaction (Bug 4)", async () => {
  // After mid-session compaction (128K → 30K), the "Last prompt"
  // display should drop to ~30K, not stay at the pre-compaction peak.
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_compact",
    workspaceId: "workspace_main",
    source: "web",
    title: "Compaction test",
    state: "EXECUTING",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values([
    // Turn 7: pre-compaction peak — 128K
    {
      id: "compact_pre",
      taskId: "task_compact",
      runId: "rt_leader_z",
      requestId: "req_big",
      roleId: "leader",
      turnNumber: 7,
      model: "qwen3.5-plus",
      provider: "dashscope",
      inputTokens: 128_000,
      outputTokens: 2_000,
      estimatedPromptTokens: 128_500,
      usageSource: "estimated",
      recordedAt: new Date("2026-05-26T10:00:00Z"),
    },
    // Turn 8: post-compaction — model sees ~30K
    {
      id: "compact_post",
      taskId: "task_compact",
      runId: "rt_leader_z",
      requestId: "req_big",
      roleId: "leader",
      turnNumber: 8,
      model: "qwen3.5-plus",
      provider: "dashscope",
      inputTokens: 29_500,
      outputTokens: 1_500,
      estimatedPromptTokens: 30_000,
      usageSource: "estimated",
      recordedAt: new Date("2026-05-26T10:01:00Z"),
    },
  ]);

  const agg = await new TokenUsageRepository().getTaskAggregate("task_compact");
  // Latest turn is 8 (post-compaction). Should show ~30K, not 128K.
  expect(agg.latestInputTokens).toBe(30_000);
  // Peak is still the pre-compaction high-water mark.
  expect(agg.peakInputTokens).toBe(128_000);
});

test("latestInputTokens credits cache_read_tokens when provider reports them", async () => {
  // Anthropic / providers that DO report cache_read correctly: the
  // billable input is small but the actual context the model saw is
  // input + cache_read. Confirms the COALESCE math, not just the
  // request_id picking logic.
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_ctx_cached",
    workspaceId: "workspace_main",
    source: "web",
    title: "Context with cache read",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values({
    id: "ctx_cached_1",
    taskId: "task_ctx_cached",
    runId: "rt_leader_z",
    requestId: "req_cached",
    roleId: "leader",
    turnNumber: 1,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 46_200,
    outputTokens: 300,
    nonCachedInputTokens: 1_200,
    cacheReadTokens: 45_000,
    usageSource: "provider",
    recordedAt: new Date("2026-05-22T09:00:00Z"),
  });

  const agg = await new TokenUsageRepository().getTaskAggregate("task_ctx_cached");
  expect(agg.latestInputTokens).toBe(46_200);
});

test("context inputs preserve legacy NULL usage_source cache breakdown semantics", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_ctx_legacy_cached",
    workspaceId: "workspace_main",
    source: "web",
    title: "Legacy cached context",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(tokenUsageRecords).values({
    id: "ctx_legacy_cached_1",
    taskId: "task_ctx_legacy_cached",
    runId: "rt_leader_legacy",
    requestId: "req_legacy_cached",
    roleId: "leader",
    turnNumber: 1,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 6,
    outputTokens: 8,
    cacheReadTokens: 18_273,
    cacheWriteTokens: 25_324,
    recordedAt: new Date("2026-05-22T09:30:00Z"),
  });

  const agg = await new TokenUsageRepository().getTaskAggregate("task_ctx_legacy_cached");
  expect(agg.latestInputTokens).toBe(43_603);
  expect(agg.peakInputTokens).toBe(43_603);
});

test("mixed OpenAI and Anthropic provider rows accumulate inclusive input once", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_mixed_provider_usage",
    workspaceId: "workspace_main",
    source: "web",
    title: "Mixed provider usage",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repo = new TokenUsageRepository();
  await repo.record({
    taskId: "task_mixed_provider_usage",
    runId: "rt_leader_mix",
    requestId: "req_openai",
    roleId: "leader",
    turnNumber: 1,
    model: "gpt-5.4",
    provider: "openai",
    inputTokens: 1_000,
    outputTokens: 300,
    nonCachedInputTokens: 750,
    cacheReadTokens: 250,
    reasoningTokens: 120,
    totalTokens: 1_300,
    usageSource: "provider",
    costUsd: null,
  });
  await repo.record({
    taskId: "task_mixed_provider_usage",
    runId: "rt_leader_mix",
    requestId: "req_anthropic",
    roleId: "leader",
    turnNumber: 2,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    inputTokens: 160,
    outputTokens: 8,
    nonCachedInputTokens: 10,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    totalTokens: 168,
    usageSource: "provider",
    costUsd: null,
  });

  const agg = await repo.getTaskAggregate("task_mixed_provider_usage");
  expect(agg.totalInputTokens).toBe(1_160);
  expect(agg.totalOutputTokens).toBe(308);
  expect(agg.latestInputTokens).toBe(160);
  expect(agg.peakInputTokens).toBe(1_000);
});

test("pruneOlderThan removes rows past the TTL cutoff", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");
  const repo = new TokenUsageRepository();
  const db = createDb();

  await db.insert(tasks).values({
    id: "task_ttl",
    workspaceId: "workspace_main",
    source: "web",
    title: "TTL",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Insert 3 rows: two old, one new. TTL cutoff = now - 1 day.
  const oldDate1 = new Date(Date.now() - 10 * 86_400_000);
  const oldDate2 = new Date(Date.now() - 5 * 86_400_000);
  const recentDate = new Date();

  await db.insert(tokenUsageRecords).values([
    { id: "r_old1", taskId: "task_ttl", runId: "r", turnNumber: 1, model: "x", provider: "p", inputTokens: 1, outputTokens: 1, recordedAt: oldDate1 },
    { id: "r_old2", taskId: "task_ttl", runId: "r", turnNumber: 2, model: "x", provider: "p", inputTokens: 1, outputTokens: 1, recordedAt: oldDate2 },
    { id: "r_new", taskId: "task_ttl", runId: "r", turnNumber: 3, model: "x", provider: "p", inputTokens: 1, outputTokens: 1, recordedAt: recentDate },
  ]);

  const cutoff = new Date(Date.now() - 1 * 86_400_000);
  const result = await repo.pruneOlderThan(cutoff, 1000);
  expect(result.removedByTtl).toBe(2);
  expect(result.removedByCap).toBe(0);

  const rows = await db.query.tokenUsageRecords.findMany();
  expect(rows.length).toBe(1);
  expect(rows[0]?.id).toBe("r_new");
});

test("pruneOlderThan cap survives timestamp ties (kimi M3)", async () => {
  // Burst-insert pattern: many rows with the same recorded_at ms.
  // Old timestamp-based cap would compare `< cutoffRow.recordedAt`
  // and skip ALL ties, leaving the table over `maxRows`. The new
  // PK-subquery approach deletes by id, robust to ties.
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");
  const repo = new TokenUsageRepository();
  const db = createDb();

  await db.insert(tasks).values({
    id: "task_burst",
    workspaceId: "workspace_main",
    source: "web",
    title: "Burst",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 10 rows, ALL at the same timestamp.
  const sameDate = new Date(2026, 0, 1);
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `r_${i}`,
    taskId: "task_burst",
    runId: "r",
    turnNumber: i + 1,
    model: "x",
    provider: "p",
    inputTokens: 1,
    outputTokens: 1,
    recordedAt: sameDate,
  }));
  await db.insert(tokenUsageRecords).values(rows);

  const result = await repo.pruneOlderThan(new Date(0), /* maxRows */ 3);
  // Cap kicks in: 10 rows down to 3.
  expect(result.removedByCap).toBe(7);
  const remaining = await db.query.tokenUsageRecords.findMany();
  expect(remaining.length).toBe(3);
});

test("pruneOlderThan ttl + cap interaction — TTL fires first", async () => {
  const { TokenUsageRepository } = await import(
    "../../src/repositories/token-usage-repository"
  );
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");
  const repo = new TokenUsageRepository();
  const db = createDb();

  await db.insert(tasks).values({
    id: "task_both",
    workspaceId: "workspace_main",
    source: "web",
    title: "Both",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 3 old rows past TTL + 5 recent rows. Cap = 4. Expected: TTL
  // drops the 3 old, cap then drops 1 of the 5 recent → 4 remain.
  const oldDate = new Date(Date.now() - 10 * 86_400_000);
  const recentBase = Date.now();
  const inserts = [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `old_${i}`, taskId: "task_both", runId: "r", turnNumber: i,
      model: "x", provider: "p", inputTokens: 1, outputTokens: 1, recordedAt: oldDate,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `new_${i}`, taskId: "task_both", runId: "r", turnNumber: i + 100,
      model: "x", provider: "p", inputTokens: 1, outputTokens: 1,
      recordedAt: new Date(recentBase + i),
    })),
  ];
  await db.insert(tokenUsageRecords).values(inserts);

  const cutoff = new Date(Date.now() - 1 * 86_400_000);
  const result = await repo.pruneOlderThan(cutoff, 4);
  expect(result.removedByTtl).toBe(3);
  expect(result.removedByCap).toBe(1);
  const remaining = await db.query.tokenUsageRecords.findMany();
  expect(remaining.length).toBe(4);
  // Most-recent are the survivors (new_4..new_1).
  const ids = new Set(remaining.map((r) => r.id));
  expect(ids.has("new_4")).toBe(true);
  expect(ids.has("old_0")).toBe(false);
});
