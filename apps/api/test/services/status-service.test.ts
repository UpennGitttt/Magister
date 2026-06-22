/**
 * Smoke tests for the /status aggregator. The real shape is a
 * composition of many existing services; this test isolates the
 * shape contract and the per-section error-isolation behavior so
 * a bug there can't silently 500 the panel for everyone.
 *
 * Kimi review I — was zero tests; this file exists to anchor the
 * minimum that would have caught real regressions (DB error
 * propagation, activeTasks shape after the M3 contract change).
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

// buildStatusReport probes codex via discoverCodexSkills(); cold-start
// codex spawn is 3-6s. Bun's default 5s test timeout flakes the first
// test in this file until the cache warms. Set per-file default to 30s.
setDefaultTimeout(30_000);
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "status-service-test-"));
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

test("buildStatusReport returns the documented shape with empty DB", async () => {
  // buildStatusReport probes codex via the new discovery service;
  // cold-start spawn is ~5-6s on a fresh box. The bun:test default
  // timeout (5s) wasn't enough; bumped via setDefaultTimeout below.
  // The result caches for 5 min so subsequent tests in the same
  // bun run get the fast path.
  const { buildStatusReport } = await import("../../src/services/status-service");
  const report = await buildStatusReport();

  // Top-level shape: every section present, no `null` at the top
  // level — the panel must always render something.
  expect(typeof report.workspace.cwd).toBe("string");
  expect(typeof report.workspace.agentsFile.found).toBe("boolean");
  expect(typeof report.workspace.git).toBe("object");
  expect(Array.isArray(report.agents)).toBe(true);
  expect(Array.isArray(report.mcp)).toBe(true);
  expect(typeof report.skills.total).toBe("number");
  expect(typeof report.skills.bySource.github).toBe("number");
  expect(typeof report.skills.bySource.manual).toBe("number");
  // M3 contract — activeTasks is ALWAYS an array, not nullable.
  expect(Array.isArray(report.activeTasks)).toBe(true);
  // Empty DB = no executing tasks.
  expect(report.activeTasks.length).toBe(0);
});

test("activeTasks surfaces multiple parallel runs (not just one)", async () => {
  // Kimi review M3 — the previous shape was `activeTask: T | null`,
  // which silently picked an arbitrary winner when several tasks ran
  // concurrently. Confirm the new array shape returns all of them.
  const { createDb, tasks } = await import("@magister/db");
  const { buildStatusReport } = await import("../../src/services/status-service");

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values([
    {
      id: "task_a",
      workspaceId: "workspace_main",
      source: "web",
      title: "Task A",
      state: "EXECUTING",
      createdAt: now,
      updatedAt: new Date(now.getTime() - 10_000),
    },
    {
      id: "task_b",
      workspaceId: "workspace_main",
      source: "web",
      title: "Task B",
      state: "EXECUTING",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "task_done",
      workspaceId: "workspace_main",
      source: "web",
      title: "Already done",
      state: "COMPLETED",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const report = await buildStatusReport();
  const ids = report.activeTasks.map((t) => t.id).sort();
  expect(ids).toEqual(["task_a", "task_b"]);
  // Most-recently-updated first (task_b updatedAt > task_a's)
  expect(report.activeTasks[0]?.id).toBe("task_b");
  // ISO timestamps.
  expect(typeof report.activeTasks[0]?.startedAt).toBe("string");
  expect(report.activeTasks[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("buildStatusReport(taskId) populates currentSession with task details", async () => {
  // Joint-review I9 — pin the session-aware path so future drift
  // (forgetting to populate currentSession, breaking the tracked
  // flag, etc.) breaks the suite.
  const { createDb, tasks } = await import("@magister/db");
  const { buildStatusReport } = await import("../../src/services/status-service");

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values({
    id: "task_with_session",
    workspaceId: "workspace_main",
    source: "web",
    title: "Test the panel",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  const report = await buildStatusReport({ taskId: "task_with_session" });
  expect(report.currentSession).not.toBeNull();
  if (!report.currentSession) return;
  expect(report.currentSession.taskId).toBe("task_with_session");
  expect(report.currentSession.title).toBe("Test the panel");
  expect(report.currentSession.state).toBe("EXECUTING");
  expect(report.currentSession.workspaceId).toBe("workspace_main");
  // No usage records were inserted — tracked must be false.
  expect(report.currentSession.tokenUsage.tracked).toBe(false);
  expect(report.currentSession.tokenUsage.turnCount).toBe(0);
  // ISO timestamps.
  expect(report.currentSession.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("buildStatusReport(taskId) returns currentSession=null when task not found", async () => {
  const { buildStatusReport } = await import("../../src/services/status-service");
  const report = await buildStatusReport({ taskId: "task_does_not_exist" });
  expect(report.currentSession).toBeNull();
  // The rest of the report still renders — workspace section
  // should be intact even when the requested task is missing.
  expect(typeof report.workspace.cwd).toBe("string");
  expect(Array.isArray(report.agents)).toBe(true);
});

test("buildStatusReport(taskId) reflects recorded model in currentSession.agent", async () => {
  // Round-2 kimi review M2 — when the in-process usage store has
  // records for this task, the LATEST recorded model should
  // populate currentSession.agent.modelName (rather than the
  // global resolver's default). We use the latest (`.at(-1)`)
  // because a fallback chain would record older models earlier.
  const { createDb, tasks } = await import("@magister/db");
  const { recordUsage } = await import("../../src/services/token-usage-service");
  const { buildStatusReport } = await import("../../src/services/status-service");

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values({
    id: "task_with_usage",
    workspaceId: "workspace_main",
    source: "web",
    title: "Has usage",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });
  // Two turns, two different models — fallback chain shape.
  await recordUsage({
    taskId: "task_with_usage",
    runId: "run_x",
    turnNumber: 1,
    model: "kimi-k2.6-ark",
    provider: "volcengine-ark",
    inputTokens: 100,
    outputTokens: 50,
  });
  await recordUsage({
    taskId: "task_with_usage",
    runId: "run_x",
    turnNumber: 2,
    model: "glm-5.1-ark", // fallback fired
    provider: "volcengine-ark",
    inputTokens: 80,
    outputTokens: 40,
  });

  const report = await buildStatusReport({ taskId: "task_with_usage" });
  expect(report.currentSession).not.toBeNull();
  if (!report.currentSession) return;
  // Latest model wins (not the first one recorded).
  expect(report.currentSession.agent?.modelName).toBe("glm-5.1-ark");
  expect(report.currentSession.tokenUsage.tracked).toBe(true);
  expect(report.currentSession.tokenUsage.inputTokens).toBe(180);
  expect(report.currentSession.tokenUsage.outputTokens).toBe(90);
  expect(report.currentSession.tokenUsage.turnCount).toBe(2);
});

test("currentSession.agent.modelName tracks fallback cycle A → B → A correctly", async () => {
  // Codex review M2 — `usage.models` is Set-deduped, so a cycle
  // A → B → A leaves the array as [A, B] and `.at(-1)` returns
  // the WRONG model (B) when latestModel should be A. This test
  // pins the temporal-correctness contract.
  const { createDb, tasks } = await import("@magister/db");
  const { recordUsage } = await import("../../src/services/token-usage-service");
  const { buildStatusReport } = await import("../../src/services/status-service");

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values({
    id: "task_cycle_aba",
    workspaceId: "workspace_main",
    source: "web",
    title: "ABA cycle",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });
  await recordUsage({ taskId: "task_cycle_aba", runId: "run_y", turnNumber: 1, model: "model-A", provider: "p", inputTokens: 10, outputTokens: 5 });
  await recordUsage({ taskId: "task_cycle_aba", runId: "run_y", turnNumber: 2, model: "model-B", provider: "p", inputTokens: 10, outputTokens: 5 });
  await recordUsage({ taskId: "task_cycle_aba", runId: "run_y", turnNumber: 3, model: "model-A", provider: "p", inputTokens: 10, outputTokens: 5 });

  const report = await buildStatusReport({ taskId: "task_cycle_aba" });
  expect(report.currentSession?.agent?.modelName).toBe("model-A");
  // models[] still surfaces the distinct set.
  expect(new Set(report.currentSession?.tokenUsage.models)).toEqual(new Set(["model-A", "model-B"]));
});

test("currentSession.agent.providerLabel pairs with recorded model (not resolver)", async () => {
  // Codex review M3 — provider/model pairing must come from the
  // SAME usage record, not a recorded model + the resolver's
  // current provider (which can be a different vendor entirely).
  const { createDb, tasks } = await import("@magister/db");
  const { recordUsage } = await import("../../src/services/token-usage-service");
  const { buildStatusReport } = await import("../../src/services/status-service");

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values({
    id: "task_provider_pair",
    workspaceId: "workspace_main",
    source: "web",
    title: "Provider pairing",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });
  await recordUsage({
    taskId: "task_provider_pair",
    runId: "run_z",
    turnNumber: 1,
    model: "moonshot-v1-8k",
    provider: "moonshot-direct", // distinct provider id
    inputTokens: 50,
    outputTokens: 25,
  });

  const report = await buildStatusReport({ taskId: "task_provider_pair" });
  expect(report.currentSession?.agent?.modelName).toBe("moonshot-v1-8k");
  expect(report.currentSession?.agent?.providerLabel).toBe("moonshot-direct");
});

test("buildStatusReport(taskId) derives workspace from task when workspaceId omitted", async () => {
  // Codex review M1 — when /status is called from a chat in a
  // non-default workspace with `?taskId=...` but no workspaceId,
  // the panel must show the TASK'S workspace below currentSession,
  // not the registry's default. Otherwise the user sees session
  // in workspace A above a workspace block describing workspace B.
  const { createDb, tasks } = await import("@magister/db");
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir: osTmp } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { buildStatusReport } = await import("../../src/services/status-service");

  // Register a non-default workspace pointing at a real dir so
  // path validation in resolveWorkspaceBaseDir succeeds.
  const altDir = await mkdtemp(joinPath(osTmp(), "alt-ws-"));
  const repo = new WorkspaceRepository();
  await repo.create({ id: "alt", label: "Alt", basePath: altDir, isDefault: false });

  const db = createDb();
  const now = new Date();
  await db.insert(tasks).values({
    id: "task_in_alt",
    workspaceId: "alt",
    source: "web",
    title: "In alt workspace",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  const report = await buildStatusReport({ taskId: "task_in_alt" });
  // currentSession reflects the task's workspace.
  expect(report.currentSession?.workspaceId).toBe("alt");
  // AND the activeWorkspace block now matches it (was previously
  // "workspace_main" from the registry default).
  expect(report.activeWorkspace?.id).toBe("alt");
});
