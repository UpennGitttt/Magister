/**
 * Goal-mode v2 — external verifier (phase 4).
 *
 * The model's self-assessment of "goal complete" is unreliable —
 * documented as a 22% → 77% miscalibration in the SOTA research
 * (achievement bias). Magister mitigates this by requiring a fresh
 * evaluator verdict before mark_goal_complete can flip the goal
 * to terminal-complete state.
 *
 * This file does two narrow things:
 *
 *   1. parseEvaluatorVerdict() — given the evaluator teammate's
 *      final assistant text, classify it as READY / BLOCKED, and
 *      extract a single-line blocker reason on BLOCKED. The
 *      evaluator system prompt (teammate-system-prompts.ts) mandates
 *      a final-paragraph "Overall verdict: READY" /
 *      "Overall verdict: BLOCKED — <reason>" so the parser stays
 *      pinned to a specific shape.
 *
 *   2. recordVerdict() — persists the parsed verdict on the task
 *      row so mark_goal_complete can later check
 *      `task.goalLastVerifierVerdict === "READY"`.
 *
 * Why not spawn the evaluator from here?
 *   The model already has the `spawn_teammate(role="evaluator",
 *   ...)` tool. Reusing that machinery instead of duplicating it
 *   means: a) one teammate-spawn code path, b) the evaluator's
 *   tool calls + transcript naturally land in the existing W1
 *   sidechain UI, c) no tool-to-tool re-entrancy. The hook lives
 *   in the spawn_teammate completion callback — see
 *   manager-tools-adapter.ts:buildLeaderTools.
 *
 * Spec reference: docs/plans/2026-05-12-goal-mode-overhaul.md phase 4.
 */

export type EvaluatorVerdict =
  | { verdict: "READY"; blockerReason: null }
  | { verdict: "BLOCKED"; blockerReason: string }
  | { verdict: "UNCLEAR"; blockerReason: null };

/** Match "Overall verdict: READY" (case-insensitive, surrounding whitespace
 *  tolerated). The evaluator prompt also accepts the shorter "VERDICT: READY"
 *  per our hardened addendum. Either form wins. */
const READY_RE = /\b(?:overall\s+verdict|verdict)\s*:?\s*ready\b/i;

/** Match "Overall verdict: BLOCKED — <reason>" / "VERDICT: BLOCKED — <reason>".
 *  Em-dash, en-dash, or plain hyphen+spaces all accepted. Reason runs to
 *  end-of-line. */
const BLOCKED_RE =
  /\b(?:overall\s+verdict|verdict)\s*:?\s*blocked\b[\s\-–—:]*([^\n\r]*)/i;

export function parseEvaluatorVerdict(rawText: string): EvaluatorVerdict {
  const text = rawText?.toString() ?? "";
  if (text.trim().length === 0) {
    return { verdict: "UNCLEAR", blockerReason: null };
  }
  // BLOCKED takes precedence over READY when both appear — if the
  // evaluator says "criterion 3 is READY but overall BLOCKED" we
  // honor BLOCKED. Check the last ~2 KiB so the FINAL verdict line
  // wins over earlier discussion of individual criteria.
  const tail = text.slice(-2048);
  const blockedMatch = tail.match(BLOCKED_RE);
  if (blockedMatch) {
    const reason = (blockedMatch[1] ?? "").trim()
      || "Evaluator returned BLOCKED with no reason summary; spawn evaluator again with explicit criteria.";
    return { verdict: "BLOCKED", blockerReason: reason };
  }
  if (READY_RE.test(tail)) {
    return { verdict: "READY", blockerReason: null };
  }
  return { verdict: "UNCLEAR", blockerReason: null };
}

/** v3 §P1-8 — parse-failure threshold for the evaluator backstop.
 *  After this many consecutive UNCLEAR returns from the evaluator,
 *  the goal auto-pauses with a "switch evaluator model" hint. Three
 *  consecutive misses is a strong signal the evaluator model is too
 *  weak to follow the verdict format; single misses can be flaky
 *  and shouldn't trip
 *  the user. */
export const PARSE_FAILURE_THRESHOLD = 3;

/** Persist the parsed verdict on the task. Called from the
 *  spawn_teammate completion path (manager-tools-adapter.ts) when
 *  the just-finished teammate's role is "evaluator" and the parent
 *  task is in goal mode.
 *
 *  Also handles the v3 §P1-8 backstop:
 *    - successful READY/BLOCKED parse → resets the parse-failure
 *      counter to 0
 *    - UNCLEAR parse → increments the counter; at threshold the
 *      goal auto-pauses with a hint surfaced in plan.md + UI */
export async function recordVerdict(
  taskId: string,
  verdict: EvaluatorVerdict,
): Promise<{ autoPaused: boolean; parseFailureCount: number }> {
  const { TaskRepository } = await import("../../repositories/task-repository");
  const repo = new TaskRepository();

  if (verdict.verdict === "UNCLEAR") {
    // Don't overwrite a prior READY with UNCLEAR — UNCLEAR is
    // effectively "no signal", and the prior verdict still stands
    // until either the model spawns another evaluator (overwriting)
    // or the goal returns to active state (clearing).
    //
    // BUT do bump the parse-failure counter — at threshold we
    // auto-pause and surface the hint. This catches the "evaluator
    // model is too weak to follow the verdict format" case where the
    // goal would otherwise spin forever waiting for a READY that
    // never lands.
    const task = await repo.getById(taskId);
    if (!task) {
      return { autoPaused: false, parseFailureCount: 0 };
    }
    const next = (task.goalEvaluatorParseFailures ?? 0) + 1;
    let autoPaused = false;
    if (next >= PARSE_FAILURE_THRESHOLD && task.goalStatus === "active") {
      await repo.update(taskId, {
        goalEvaluatorParseFailures: next,
        goalStatus: "paused",
        goalCompletedAt: Date.now(),
        updatedAt: new Date(),
      });
      autoPaused = true;
      // Append a hint to plan.md so the user has a breadcrumb when
      // they open the file.
      try {
        if (task.workspaceId) {
          const { appendBlocker } = await import("./plan-file-service");
          await appendBlocker(
            taskId,
            task.workspaceId,
            task.goalIterations ?? 0,
            `Evaluator returned UNCLEAR ${PARSE_FAILURE_THRESHOLD} times in a row — goal auto-paused. The configured evaluator model is likely too weak to follow the verdict format. Switch the evaluator agent's model in Settings (or change its system-prompt addendum), then resume the goal.`,
          );
        }
      } catch {
        // Best-effort.
      }
    } else {
      await repo.update(taskId, {
        goalEvaluatorParseFailures: next,
        updatedAt: new Date(),
      });
    }
    return { autoPaused, parseFailureCount: next };
  }

  await repo.update(taskId, {
    goalLastVerifierVerdict: verdict.verdict,
    goalLastVerifierAt: Date.now(),
    goalLastVerifierBlocker:
      verdict.verdict === "BLOCKED" ? verdict.blockerReason : null,
    // Successful parse resets the counter.
    goalEvaluatorParseFailures: 0,
  });
  return { autoPaused: false, parseFailureCount: 0 };
}

/** Clear the verifier verdict — used when the goal returns to
 *  "active" after a BLOCKED, so a future mark_goal_complete can't
 *  silently reuse the stale READY. */
export async function clearVerdict(taskId: string): Promise<void> {
  const { TaskRepository } = await import("../../repositories/task-repository");
  const repo = new TaskRepository();
  await repo.update(taskId, {
    goalLastVerifierVerdict: null,
    goalLastVerifierAt: null,
    goalLastVerifierBlocker: null,
  });
}

/** Freshness gate — a verdict older than this is treated as stale
 *  by mark_goal_complete (model may have done significant work
 *  after the verdict). Default 10 minutes. */
export const VERDICT_FRESHNESS_MS = 10 * 60 * 1000;

export function isVerdictFresh(
  goalLastVerifierAt: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!goalLastVerifierAt) return false;
  return now - goalLastVerifierAt <= VERDICT_FRESHNESS_MS;
}
