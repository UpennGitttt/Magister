/**
 * Goal-mode v2 — fresh-context-per-iteration (phase 5).
 *
 * Ralph's core insight: an agent that accumulates context across N
 * iterations of a long-running goal hits the context window and
 * starts losing fidelity well before it should hit completion.
 * Filesystem (plan.md) is the durable memory; the LLM context is
 * scratch.
 *
 * Magister's normal compaction triggers on context utilization (≥85%
 * of the input window). Goal mode is different — we WANT to reset
 * proactively at every iteration boundary, even at 20% utilization,
 * because:
 *
 *   1. plan.md already preserves the durable knowledge (objective,
 *      acceptance criteria, iteration log).
 *   2. The continuation prompt re-injects plan.md + live budget +
 *      audit checklist. Whatever the model "knew" from prior turns
 *      it can re-derive from plan.md + the new continuation.
 *   3. The model that returns BLOCKED from an evaluator should
 *      tackle the blocker with a fresh head — not its prior chain
 *      of rationalizations.
 *
 * This service exports `trimForFreshContext(messages, options)`
 * which returns a trimmed message array suitable for a checkpoint
 * rewrite. The leader-session checkpoint is overwritten with the
 * trimmed messages, so the next iteration resumes with only the
 * recent tail in scope.
 *
 * Opt-out: `MAGISTER_GOAL_FRESH_CONTEXT=0` env disables the trim
 * (falls back to Magister's normal accumulating-context behavior).
 *
 * Spec reference: docs/plans/2026-05-12-goal-mode-overhaul.md phase 5.
 */

import type { LeaderMessage } from "../manager-automation/autonomous-loop/autonomous-types";

const GOAL_FRESH_CONTEXT_ANCHOR =
  "[Previous conversation summary]\n"
  + "Earlier turns in this goal have been intentionally elided to give "
  + "the next iteration a fresh context window. The durable record of "
  + "what's been done and what's left lives in `plan.md`, which is "
  + "embedded in the continuation message below. Use plan.md as the "
  + "source of truth; do not assume hidden state from prior turns.";

export type TrimOptions = {
  /** Number of full turns to retain at the tail. A "turn" starts at
   *  a user message and runs through to the next user message. */
  tailTurns?: number;
  /** Optional: skip trim if env override turns it off. */
  envOverride?: string | null | undefined;
};

const DEFAULT_TAIL_TURNS = 3;

/** Identify turn boundaries. Matches the helper in message-compaction.ts
 *  but kept local so this module has zero coupling to the autocompact
 *  pipeline (different concern, different cadence). */
function identifyTurns(messages: LeaderMessage[]): LeaderMessage[][] {
  const turns: LeaderMessage[][] = [];
  let current: LeaderMessage[] = [];
  for (const msg of messages) {
    if (msg.type === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export function isFreshContextEnabled(
  envOverride?: string | null | undefined,
): boolean {
  const raw = envOverride ?? process.env.MAGISTER_GOAL_FRESH_CONTEXT;
  if (raw == null) return true;
  const lower = raw.trim().toLowerCase();
  // Common false-y values: "0", "false", "off", "no".
  return !(lower === "0" || lower === "false" || lower === "off" || lower === "no");
}

/** Drop everything except the last `tailTurns` turns, prepending a
 *  meta anchor so the trimmed history looks coherent to whatever
 *  consumes it next.
 *
 *  Pure function — no IO, no side-effects. Caller decides whether
 *  to persist the result back to a checkpoint. */
export function trimForFreshContext(
  messages: LeaderMessage[],
  options: TrimOptions = {},
): { messages: LeaderMessage[]; trimmedTurns: number; trimmed: boolean } {
  if (!isFreshContextEnabled(options.envOverride)) {
    return { messages, trimmedTurns: 0, trimmed: false };
  }

  const tailTurns = options.tailTurns ?? DEFAULT_TAIL_TURNS;
  if (tailTurns < 0) {
    return { messages, trimmedTurns: 0, trimmed: false };
  }

  const turns = identifyTurns(messages);
  if (turns.length <= tailTurns) {
    // Already within budget; no trim necessary.
    return { messages, trimmedTurns: 0, trimmed: false };
  }

  const dropped = turns.length - tailTurns;
  const tail = turns.slice(-tailTurns).flat();

  // Strip any existing summary anchor from the head so we don't
  // stack two summaries. Our new anchor replaces it.
  const filteredTail = tail.filter((m, idx) => {
    if (idx !== 0) return true;
    if (m.type !== "user") return true;
    if (m.isMeta !== true) return true;
    return !(typeof m.content === "string"
      && m.content.startsWith("[Previous conversation summary]"));
  });

  const anchor: LeaderMessage = {
    type: "user",
    content: GOAL_FRESH_CONTEXT_ANCHOR,
    isMeta: true,
  };
  return {
    messages: [anchor, ...filteredTail],
    trimmedTurns: dropped,
    trimmed: true,
  };
}

export { GOAL_FRESH_CONTEXT_ANCHOR };
