/**
 * Goal-mode continuation prompt builder.
 *
 * v3 spec §P1-6 — was a single monolithic string-concat function;
 * now dispatches to one of three .md templates under ./prompts/ via
 * `renderTemplate`. Each template covers a focused state:
 *
 *   - `continuation.md` — the default per-turn prompt
 *   - `budget_limit.md` — fired when token budget hits 100% (replaces
 *     the inline "exhausted" sub-section the v2 single template had)
 *   - `objective_updated.md` — Phase 3 (P1-5); used the turn after the
 *     user edits the objective mid-flight
 *
 * Section composition (plan, blocker, soft steering at ≥ 85%) is
 * still done here in TS — those are conditional sections that get
 * inlined into the chosen template's `{{ planSection }}`,
 * `{{ blockerSection }}`, `{{ softSteerSection }}` slots.
 *
 * Sentinel `<<goal_continuation>>` is at the start of every template
 * so existing frontend filters (isSentinelToken at
 * apps/web/src/components/chat/conversation/render.tsx) keep hiding
 * these from the chat UI.
 *
 * Iteration count is deliberately NOT exposed in any template —
 * codex's anti-defeatism choice. Still tracked in DB.
 *
 * Spec references: docs/plans/2026-05-12-goal-mode-overhaul.md,
 * docs/specs/2026-05-21-goal-mode-v3-spec.md.
 */

import { escapeXmlText } from "./escape-xml";
import { renderTemplate, type TemplateName } from "./template-renderer";

const GOAL_CONTINUATION_SENTINEL = "<<goal_continuation>>";
const DEFAULT_BUDGET_STEER_RATIO = 0.85;

export type GoalContinuationInput = {
  objective: string;
  elapsedSeconds: number;
  /** NULL when the goal has no wall-time cap. */
  wallCapSeconds?: number | null;
  tokensUsed: number;
  /** NULL when the goal has no token budget. */
  tokenBudget?: number | null;
  /** UUID of the current goal version. Surfaced so the model can
   *  pass it back to mutation tools (mark_goal_complete,
   *  update_goal_plan, add_acceptance_criterion) as
   *  `expected_goal_id` — protects against stale tool calls
   *  landing after the goal was re-issued. NULL on goals created
   *  before phase 1 of the v2 overhaul (no goal_id minted). */
  goalId?: string | null;
  /** Current `.magister/goals/<task_id>/plan.md` contents.
   *  NULL when no plan file has been written yet (early iterations
   *  or pre-phase-3 tasks). The template degrades gracefully:
   *  no plan = no plan section. */
  planMd?: string | null;
  /** Result from the last `mark_goal_complete` attempt that the
   *  evaluator rejected (phase 4). NULL on first iteration or when
   *  the previous iteration didn't try to complete. */
  lastVerifierBlocker?: string | null;
  /** User-added subgoals (mid-flight criteria refinement). When
   *  present, injected as a separate "Additional criteria added by
   *  user" section alongside plan.md's main acceptance criteria. */
  subgoals?: string[] | null;
  /** Mid-flight objective edit flag. When true, the continuation
   *  render uses objective_updated.md instead of continuation.md.
   *  Fires for exactly one iteration after objective edit; the worker
   *  clears it after consuming this turn. */
  objectiveJustEdited?: boolean;
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function budgetLines(input: GoalContinuationInput): string {
  const lines: string[] = [];
  const wallLine = input.wallCapSeconds
    ? `- Wall time: ${formatElapsed(input.elapsedSeconds)} / ${formatElapsed(input.wallCapSeconds)} cap`
    : `- Wall time: ${formatElapsed(input.elapsedSeconds)} (no cap)`;
  lines.push(wallLine);
  const tokenLine = input.tokenBudget
    ? `- Tokens: ${formatTokens(input.tokensUsed)} / ${formatTokens(input.tokenBudget)} budget (${formatTokens(Math.max(0, input.tokenBudget - input.tokensUsed))} remaining)`
    : `- Tokens used: ${formatTokens(input.tokensUsed)} (no budget cap)`;
  lines.push(tokenLine);
  return lines.join("\n");
}

function goalIdSection(input: GoalContinuationInput): string {
  if (!input.goalId) return "";
  return (
    "\n"
    + `**goal_id**: \`${input.goalId}\` — pass as \`expected_goal_id\` to any `
    + "goal-mutation tool (mark_goal_complete, update_goal_plan, "
    + "add_acceptance_criterion) so a stale call gets refused.\n"
  );
}

function planSection(input: GoalContinuationInput): string {
  if (!input.planMd || input.planMd.trim().length === 0) return "";
  return (
    "\n## Plan (source of truth)\n\n"
    + input.planMd.trim()
    + "\n\n"
    + "If the plan needs updating (mark a requirement done, add a blocker, "
    + "refine the checklist), call `update_goal_plan` with the new full "
    + "content. The file is the durable record across iterations.\n"
  );
}

function subgoalsSection(input: GoalContinuationInput): string {
  if (!input.subgoals || input.subgoals.length === 0) return "";
  const lines = input.subgoals.map((s, i) => `${i + 1}. ${s}`);
  return (
    "\n## Additional criteria added by user mid-flight\n\n"
    + "The user added these tightening conditions to the original objective "
    + "after the goal was started. They are NOT a replacement for the main "
    + "acceptance criteria in plan.md — they are extra requirements that "
    + "must ALSO be satisfied before the goal can be marked complete.\n\n"
    + lines.join("\n")
    + "\n\n"
    + "When you spawn the evaluator, instruct it to verify each subgoal "
    + "explicitly with concrete evidence. The same evidence-quality bar "
    + "applies (file:line / command output / git commit).\n"
  );
}

function blockerSection(input: GoalContinuationInput): string {
  if (!input.lastVerifierBlocker || input.lastVerifierBlocker.trim().length === 0) return "";
  return (
    "\n## ⚠ Previous attempt rejected by evaluator\n\n"
    + input.lastVerifierBlocker.trim()
    + "\n\n"
    + "Address this BEFORE attempting `mark_goal_complete` again. "
    + "The evaluator will re-check on the next attempt.\n"
  );
}

function softSteerSection(input: GoalContinuationInput): string {
  if (input.tokenBudget == null || input.tokenBudget <= 0) return "";
  const ratio = input.tokensUsed / input.tokenBudget;
  if (ratio < DEFAULT_BUDGET_STEER_RATIO) return "";
  // 100%+ is the budget_limit.md template's job; this only handles the
  // 85-100% soft-warning window.
  if (input.tokensUsed >= input.tokenBudget) return "";
  return (
    `\n## Token budget nearly exhausted (${Math.round(ratio * 100)}%)\n\n`
    + "Plan the rest of the work assuming you have only a handful of turns left. "
    + "Prefer finishing what's started over starting new work.\n"
  );
}

/** Pick the template to render. Precedence:
 *  1. objective_updated.md — when the user just edited the objective.
 *     Fires exactly once; the worker clears the trigger after this
 *     iteration. Beats budget_limit because the user explicitly
 *     redirected the goal — that signal is more important than the
 *     budget warning.
 *  2. budget_limit.md — when the token budget is at 100%+ (below the
 *     150% hard cancel threshold the worker enforces).
 *  3. continuation.md — default per-turn. */
function chooseTemplate(input: GoalContinuationInput): TemplateName {
  if (input.objectiveJustEdited) return "objective_updated";
  if (input.tokenBudget != null && input.tokenBudget > 0 && input.tokensUsed >= input.tokenBudget) {
    return "budget_limit";
  }
  return "continuation";
}

export function buildGoalContinuationV2(input: GoalContinuationInput): string {
  const name = chooseTemplate(input);
  // Escape XML control chars in the user-provided objective so
  // `</untrusted_objective>` literals can't terminate the wrapper.
  const objective = escapeXmlText(input.objective);
  const rendered = renderTemplate(name, {
    objective,
    budgetLines: budgetLines(input),
    goalIdSection: goalIdSection(input),
    planSection: planSection(input),
    subgoalsSection: subgoalsSection(input),
    blockerSection: blockerSection(input),
    softSteerSection: softSteerSection(input),
  });
  // Trim trailing whitespace from each line and collapse 3+ blank
  // lines to 2 — template gaps left by empty section vars otherwise
  // produce ugly multi-blank-line stretches.
  return rendered
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** Re-exported sentinel so process-task-intent-service can keep using
 *  the same constant for filtering. */
export { GOAL_CONTINUATION_SENTINEL };
