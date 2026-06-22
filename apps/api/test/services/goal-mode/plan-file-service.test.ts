import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendBlocker,
  appendIterationLog,
  initializePlan,
  readPlan,
  resolvePlanLocation,
  writePlan,
} from "../../../src/services/goal-mode/plan-file-service";

/**
 * These tests pin the path layout + key file-content invariants of
 * the plan.md service. They use the env override
 * `MAGISTER_WORKSPACE_PATH_MAP` to redirect resolveWorkspaceBaseDir
 * at a freshly-created tmpdir per test, so they neither touch a real
 * Magister install nor pollute the dev workspace.
 */

let tmpRoot: string;
const WS_ID = "ws_plan_test";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "magister-plan-"));
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({ [WS_ID]: tmpRoot });
});

afterEach(async () => {
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("plan-file-service", () => {
  test("resolvePlanLocation returns <ws>/.magister/goals/<task>/plan.md", async () => {
    const loc = await resolvePlanLocation("task_abc", WS_ID);
    expect(loc.absolutePath).toBe(join(tmpRoot, ".magister", "goals", "task_abc", "plan.md"));
    expect(loc.relativePath).toBe(join(".magister", "goals", "task_abc", "plan.md"));
  });

  test("initializePlan writes a skeleton with goal_id + objective", async () => {
    const loc = await initializePlan({
      taskId: "task_skel",
      workspaceId: WS_ID,
      objective: "Ship the foo button by friday",
      goalId: "goal-uuid-1",
    });
    const content = await readFile(loc.absolutePath, "utf8");
    expect(content).toContain("# Goal plan");
    expect(content).toContain("goal-uuid-1");
    expect(content).toContain("Ship the foo button by friday");
    expect(content).toContain("## Acceptance criteria");
    expect(content).toContain("## Iteration log");
  });

  test("initializePlan is idempotent — second call does not overwrite", async () => {
    await initializePlan({
      taskId: "task_idem",
      workspaceId: WS_ID,
      objective: "first",
      goalId: "g1",
    });
    // Mutate the file then re-initialize.
    const loc = await resolvePlanLocation("task_idem", WS_ID);
    await writePlan("task_idem", WS_ID, "MUTATED BODY");
    await initializePlan({
      taskId: "task_idem",
      workspaceId: WS_ID,
      objective: "different",
      goalId: "g2",
    });
    const content = await readFile(loc.absolutePath, "utf8");
    expect(content).toBe("MUTATED BODY");
  });

  test("readPlan returns NULL when plan.md missing", async () => {
    const result = await readPlan("task_missing", WS_ID);
    expect(result).toBeNull();
  });

  test("appendIterationLog injects under existing Iteration log header", async () => {
    await initializePlan({
      taskId: "task_log",
      workspaceId: WS_ID,
      objective: "x",
      goalId: "g3",
    });
    await appendIterationLog("task_log", WS_ID, {
      iteration: 1,
      verdict: "in-progress",
      summary: "Read the schema, found 3 issues.",
    });
    const content = (await readPlan("task_log", WS_ID))!;
    // Only one Iteration log header should exist
    expect(content.match(/## Iteration log/g)?.length).toBe(1);
    expect(content).toContain("Iteration 1 — in-progress");
    expect(content).toContain("Read the schema, found 3 issues.");
  });

  test("appendBlocker is appendIterationLog with verdict=blocked", async () => {
    await initializePlan({
      taskId: "task_block",
      workspaceId: WS_ID,
      objective: "x",
      goalId: "g4",
    });
    await appendBlocker("task_block", WS_ID, 2, "Tests failing: foo.test.ts");
    const content = (await readPlan("task_block", WS_ID))!;
    expect(content).toContain("Iteration 2 — blocked");
    expect(content).toContain("Tests failing: foo.test.ts");
  });

  test("writePlan rejects content over 64KB cap", async () => {
    const huge = "x".repeat(70_000);
    await expect(writePlan("task_huge", WS_ID, huge)).rejects.toThrow(/exceeds/);
  });

  test("writePlan + readPlan roundtrip for normal content", async () => {
    const body = "# Plan\n\nObjective: do the thing.\n";
    await writePlan("task_rt", WS_ID, body);
    const read = await readPlan("task_rt", WS_ID);
    expect(read).toBe(body);
  });
});
