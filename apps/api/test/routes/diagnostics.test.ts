import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "magister-diagnostics-test-"));
const prevDbPath = process.env.MAGISTER_DB_PATH;
process.env.MAGISTER_DB_PATH = join(tempDir, "test.sqlite");

afterAll(() => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  rmSync(tempDir, { recursive: true, force: true });
});

test("/diagnostics/usage-by-model includes reasoning token aggregates", async () => {
  const { buildApp } = await import("../../src/app");
  const { createDb, tasks, tokenUsageRecords } = await import("@magister/db");

  const db = createDb();
  await db.insert(tasks).values({
    id: "task_diagnostics_reasoning",
    workspaceId: "workspace_main",
    source: "web",
    title: "Diagnostics reasoning",
    state: "DONE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(tokenUsageRecords).values([
    {
      id: "diag_reasoning_a",
      taskId: "task_diagnostics_reasoning",
      runId: "rt_leader_diag",
      requestId: "req_diag_a",
      roleId: "leader",
      turnNumber: 1,
      model: "gpt-5.5",
      provider: "openai",
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      costUsd: null,
      recordedAt: new Date(),
    },
    {
      id: "diag_reasoning_b",
      taskId: "task_diagnostics_reasoning",
      runId: "rt_leader_diag",
      requestId: "req_diag_b",
      roleId: "leader",
      turnNumber: 2,
      model: "gpt-5.5",
      provider: "openai",
      inputTokens: 200,
      outputTokens: 70,
      reasoningTokens: 30,
      costUsd: null,
      recordedAt: new Date(),
    },
  ]);

  const app = buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/diagnostics/usage-by-model?days=90",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: {
        entries: Array<{
          model: string;
          provider: string;
          reasoningTokens?: number;
        }>;
      };
    };
    const entry = body.data.entries.find((item) => item.model === "gpt-5.5" && item.provider === "openai");
    expect(entry?.reasoningTokens).toBe(50);
  } finally {
    await app.close();
  }
});
