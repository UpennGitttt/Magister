export type TaskSummary = {
  id: string;
  title: string;
  state: string;
  source: string;
  workspaceId: string;
  rootChannelBindingId?: string | null;
  latestRunId?: string;
  latestBlocker?: string;
  approvalState?: string;
  latestArtifactSummary?: string;
  latestAnswer?: string | null;
  executionMode?: string | null;
  nextCapability?: string | null;
  waitReason?: string | null;
  nextWakeupAt?: string | null;
  recoveryNotice?: {
    status: "recovered" | "blocked";
    occurredAt: string;
    reason: string;
    previousState: string | null;
    nextState: string | null;
    requiresUserAction: boolean;
    runId: string | null;
  };
  blockedNarrative?: {
    reason:
      | "awaiting_approval"
      | "awaiting_plan_approval"
      | "paused_by_user"
      | "cancel_requested"
      | "runtime_recovery_in_progress"
      | "blocked_by_recovery"
      | "executor_unavailable"
      | "rate_limited"
      | "model_unavailable"
      | "max_turns_reached";
    status: "waiting" | "recovering" | "blocked" | "failed";
    severity: "info" | "warn" | "error";
    message: string;
    nextAction: string | null;
    occurredAt: string | null;
    source: string;
  };
  needsHuman?: boolean | null;
  leaderConfidence?: string | null;
  leaderWarnings?: string[];
  managerConfidence?: string | null;
  managerWarnings?: string[];
  plannerConfidence?: string | null;
  plannerWarnings?: string[];
  prUrl?: string;
  updatedAt: Date;
  /** Goal mode (Ralph loop). Null when the task isn't in goal
   *  mode — most are. The frontend GoalBanner reads these. */
  goalObjective?: string | null;
  goalStatus?: "active" | "paused" | "complete" | "cancelled" | null;
  goalStartedAt?: number | null;
  goalMaxWallSeconds?: number | null;
  goalIterations?: number | null;
  goalTokensUsed?: number | null;
  /** When goal transitioned to a terminal state (complete / paused /
   *  cancelled). Frontend freezes the elapsed-time counter here. */
  goalCompletedAt?: number | null;
  /** 2026-05-12 goal v2 — UUID per goal-version, soft token cap,
   *  plan.md artifact path. See goal-mode overhaul design doc. */
  goalId?: string | null;
  goalTokenBudget?: number | null;
  goalPlanPath?: string | null;
  /** Phase 4 — last external-verifier verdict + when, so the UI
   *  can show a "blocked by evaluator: <reason>" hint without
   *  scraping plan.md.  NULL = no verdict on this goal yet. */
  goalLastVerifierVerdict?: "READY" | "BLOCKED" | null;
  goalLastVerifierAt?: number | null;
  goalLastVerifierBlocker?: string | null;
  /** 2026-05-21 v3 §P0-2 — user-added subgoals projected from the
   *  task row's JSON-serialized `goal_subgoals` column. */
  goalSubgoals?: string[] | null;
  /** 2026-05-21 v3 §P1-5 — non-null while a mid-flight objective edit
   *  is queued for the next iteration; UI may surface "objective just
   *  changed; evaluator will re-verify". */
  goalObjectiveEditedAt?: number | null;
  /** 2026-05-21 v3 §P1-8 — consecutive evaluator UNCLEAR returns. UI
   *  shows a "switch evaluator model" hint when goal is paused and
   *  this is at threshold (3). */
  goalEvaluatorParseFailures?: number | null;
  /** Board "Attention" column dismissal. UI-only: when
   *  set, the task hides from the Attention column (FAILED / BLOCKED
   *  cards the user has explicitly acknowledged). Doesn't touch
   *  `state`. Epoch-ms. */
  attentionDismissedAt?: number | null;
};

import { TaskSummaryStore } from "../observability/task-summary-store";

export async function materializeTaskSummary(taskId: string): Promise<TaskSummary | null> {
  const taskSummaryStore = new TaskSummaryStore();
  return taskSummaryStore.get(taskId);
}
