import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-05-22 — isolated DB MUST be set before TaskRepository import.
const isolatedDb = join(tmpdir(), `magister-parsefail-db-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.MAGISTER_DB_PATH = isolatedDb;

import {
  PARSE_FAILURE_THRESHOLD,
  recordVerdict,
} from "../../../src/services/goal-mode/evaluator-verifier-service";
import { TaskRepository } from "../../../src/repositories/task-repository";

/**
 * v3 §P1-8 — evaluator parse-failure auto-pause backstop.
 *
 * When the evaluator returns text the parser can't classify as
 * READY/BLOCKED N times in a row, the goal auto-pauses with a hint
 * so the user knows to switch the evaluator model. Without this, a
 * misconfigured evaluator would spin the goal forever waiting for a
 * verdict that never lands.
 */

const taskRepo = new TaskRepository();

async function createActiveGoalTask() {
  const id = `task_pf_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  await taskRepo.create({
    id,
    workspaceId: "ws_pf",
    title: "pf test",
    state: "RUNNING",
    source: "web",
    submittedBy: "user",
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
    goalObjective: "test",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    goalId: "gpf",
  } as Parameters<TaskRepository["create"]>[0]);
  return id;
}

describe("parse-failure backstop", () => {
  test("PARSE_FAILURE_THRESHOLD is 3", () => {
    expect(PARSE_FAILURE_THRESHOLD).toBe(3);
  });

  test("one UNCLEAR bumps the counter but does not auto-pause", async () => {
    const taskId = await createActiveGoalTask();
    const r = await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    expect(r.autoPaused).toBe(false);
    expect(r.parseFailureCount).toBe(1);
    const t = await taskRepo.getById(taskId);
    expect(t?.goalStatus).toBe("active");
    expect(t?.goalEvaluatorParseFailures).toBe(1);
  });

  test("third consecutive UNCLEAR auto-pauses the goal", async () => {
    const taskId = await createActiveGoalTask();
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    const r = await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    expect(r.autoPaused).toBe(true);
    expect(r.parseFailureCount).toBe(3);
    const t = await taskRepo.getById(taskId);
    expect(t?.goalStatus).toBe("paused");
    expect(t?.goalCompletedAt).toBeGreaterThan(0);
  });

  test("a successful READY parse resets the counter to 0", async () => {
    const taskId = await createActiveGoalTask();
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    await recordVerdict(taskId, { verdict: "READY", blockerReason: null });
    const t = await taskRepo.getById(taskId);
    expect(t?.goalEvaluatorParseFailures).toBe(0);
    expect(t?.goalLastVerifierVerdict).toBe("READY");
    expect(t?.goalStatus).toBe("active"); // not paused
  });

  test("a successful BLOCKED parse also resets the counter", async () => {
    const taskId = await createActiveGoalTask();
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    await recordVerdict(taskId, {
      verdict: "BLOCKED",
      blockerReason: "tests fail",
    });
    const t = await taskRepo.getById(taskId);
    expect(t?.goalEvaluatorParseFailures).toBe(0);
    expect(t?.goalLastVerifierVerdict).toBe("BLOCKED");
    expect(t?.goalLastVerifierBlocker).toBe("tests fail");
  });

  test("does NOT auto-pause if goal is already paused/terminal", async () => {
    const taskId = await createActiveGoalTask();
    // Manually flip to paused first.
    await taskRepo.update(taskId, { goalStatus: "paused", updatedAt: new Date() });
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    const r = await recordVerdict(taskId, { verdict: "UNCLEAR", blockerReason: null });
    // Counter still increments, but no auto-pause (it's already paused).
    expect(r.autoPaused).toBe(false);
    expect(r.parseFailureCount).toBe(3);
    const t = await taskRepo.getById(taskId);
    expect(t?.goalStatus).toBe("paused");
  });
});
