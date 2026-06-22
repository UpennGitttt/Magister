/**
 * Mid-conversation goal start (v3 §P0-1).
 *
 * The original v2 design only let a user start a goal at task creation
 * time (`POST /tasks { goal: { … } }`). Codex and Hermes both let
 * users start a goal on any active conversation; this service brings
 * Magister to parity.
 *
 * The function mirrors the goal-creation branch in
 * process-task-intent-service.ts but operates on an existing task:
 *
 *   1. Validate: task exists, non-terminal, has no existing goal
 *   2. Mint a goal_id and write the 10 goal_* columns on the task row
 *   3. Initialize plan.md with a `## Prior context` section that
 *      summarizes the pre-goal conversation so the model's first
 *      iteration isn't blind (we don't dump the whole history — the
 *      checkpoint still carries it; this is a 1-paragraph anchor)
 *   4. Inject a `<<goal_continuation>>` mailbox row so the worker's
 *      next idle window picks up the new goal
 *   5. Enqueue the leader runtime so the continuation fires
 *
 * Token baseline starts at 0 from this moment. The pre-goal turns'
 * token consumption is NOT counted against `goal_token_budget`. The
 * UI banner surfaces "Started mid-conversation" with the timestamp so
 * the user understands the budget window.
 *
 * Failures are reported as discriminated-union variants so the route
 * layer can map them to HTTP codes without `throw`/`catch` of
 * domain errors.
 */

import { randomUUID } from "node:crypto";

import { TaskRepository } from "../../repositories/task-repository";

import { initializePlanWithPriorContext, persistPlanLocation } from "./plan-file-service";

/** States we refuse to start a goal on. Any of these = task is
 *  effectively done; starting a goal would write fields that the UI
 *  / projector won't render anyway. */
const REFUSED_STATES = new Set([
  "COMPLETED",
  "DONE",
  "MERGE_WAITING",
  "PR_OPEN",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
]);

const MAX_OBJECTIVE_BYTES = 32 * 1024;

export type StartGoalInput = {
  taskId: string;
  objective: string;
  tokenBudget?: number | null;
  maxWallSeconds?: number | null;
};

export type StartGoalSuccess = {
  ok: true;
  data: {
    taskId: string;
    goalId: string;
    goalStatus: "active";
    startedAt: number;
    tokenBudget: number | null;
    maxWallSeconds: number | null;
    planPath: string;
  };
};

export type StartGoalFailure = {
  ok: false;
  error: {
    code:
      | "task_not_found"
      | "task_terminal"
      | "goal_already_active"
      | "invalid_objective";
    message: string;
  };
};

export type StartGoalResult = StartGoalSuccess | StartGoalFailure;

export async function startGoalOnExistingTask(
  input: StartGoalInput,
): Promise<StartGoalResult> {
  const trimmed = input.objective.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_objective", message: "Objective is empty" },
    };
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_OBJECTIVE_BYTES) {
    return {
      ok: false,
      error: {
        code: "invalid_objective",
        message: `Objective exceeds ${MAX_OBJECTIVE_BYTES} bytes`,
      },
    };
  }

  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(input.taskId);
  if (!task) {
    return {
      ok: false,
      error: { code: "task_not_found", message: `Task ${input.taskId} not found` },
    };
  }
  if (REFUSED_STATES.has(task.state)) {
    return {
      ok: false,
      error: {
        code: "task_terminal",
        message: `Task is in terminal state "${task.state}"; cannot start a goal on it`,
      },
    };
  }
  if (task.goalObjective && task.goalStatus && task.goalStatus !== "cancelled") {
    return {
      ok: false,
      error: {
        code: "goal_already_active",
        message: `Task already has a goal (status: ${task.goalStatus}). Cancel or complete it before starting a new one.`,
      },
    };
  }

  const now = new Date();
  const goalId = randomUUID();

  // Write goal_* fields first. Mirrors process-task-intent-service.ts
  // line 1233-1251 except we're on UPDATE not CREATE. Mid-conversation
  // start ALWAYS resets iterations + tokens_used to 0 — the baseline
  // is "from this moment", regardless of what the task did pre-goal.
  await taskRepo.update(input.taskId, {
    goalObjective: trimmed,
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    goalCompletedAt: null,
    goalId,
    goalMaxWallSeconds: input.maxWallSeconds ?? null,
    goalTokenBudget: input.tokenBudget ?? null,
    // Clear any stale verifier verdict from a previous (cancelled) goal.
    goalLastVerifierVerdict: null,
    goalLastVerifierAt: null,
    goalLastVerifierBlocker: null,
    updatedAt: now,
  });

  // Initialize plan.md with a "Prior context" section so the model's
  // first iteration is anchored. The Prior context is a small anchor;
  // the full pre-goal conversation is still preserved in the leader's
  // checkpoint and will be visible to the model normally — this is
  // just so plan.md (which is re-injected every iteration) doesn't
  // pretend the goal started cold. We pull the conversational summary
  // from the materialized TaskSummary (latestAnswer + title), which
  // also pulls from execution_events. Best-effort: a failure here
  // doesn't roll back the goal.
  let relativePath = "";
  try {
    const { getTaskSummary } = await import("../get-task-service");
    const summary = await getTaskSummary(input.taskId);
    const priorContext = buildPriorContextSummary({
      title: task.title ?? summary?.title ?? null,
      latestAnswer: summary?.latestAnswer ?? null,
      // `description` is the closest analog to "initial user prompt"
      // on the Task DB row — title is the short slug, description
      // carries the longer prompt text.
      initialPrompt: task.description ?? null,
    });
    const location = await initializePlanWithPriorContext({
      taskId: input.taskId,
      workspaceId: task.workspaceId,
      objective: trimmed,
      goalId,
      priorContextSummary: priorContext,
    });
    await persistPlanLocation(input.taskId, location, goalId);
    relativePath = location.relativePath;
  } catch (err) {
    console.warn(
      "[goal/start] plan.md init failed (continuing without plan):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // NOTE: This service does NOT inject a mailbox row or enqueue the
  // worker. The caller is responsible for sending the user prompt
  // through the normal createTask / sendTaskMessage path, which:
  //   1. delivers a real requestId the frontend can bind the
  //      optimistic exchange to
  //   2. respects all the existing turn / channel-binding plumbing
  //   3. lets the Ralph hook inject continuation only AFTER turn 1
  //      (matching the new-task goal-creation flow rather than
  //      double-firing).
  //
  // For programmatic callers that want to start a goal without an
  // accompanying message, follow this call with the existing
  // POST /tasks/:id/goal/resume which is built to inject the
  // synthetic <<goal_continuation>>. The two-step path is more
  // explicit than baking message injection here.

  return {
    ok: true,
    data: {
      taskId: input.taskId,
      goalId,
      goalStatus: "active",
      startedAt: now.getTime(),
      tokenBudget: input.tokenBudget ?? null,
      maxWallSeconds: input.maxWallSeconds ?? null,
      planPath: relativePath,
    },
  };
}

/** Synthesize a ≤ 1 KiB prior-context summary so the goal's first
 *  iteration has an anchor for what was happening pre-goal. The full
 *  conversation is still in the leader's checkpoint; this is just a
 *  hint surface for plan.md (which is what gets re-injected each
 *  iteration). */
function buildPriorContextSummary(input: {
  title?: string | null;
  latestAnswer?: string | null;
  initialPrompt?: string | null;
}): string {
  const parts: string[] = [];
  if (input.title) {
    parts.push(`Conversation title: ${input.title}`);
  }
  if (input.initialPrompt) {
    const trimmed = input.initialPrompt.replace(/\s+/g, " ").trim();
    const snippet = trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
    parts.push(`Initial user prompt: ${snippet}`);
  }
  if (input.latestAnswer) {
    const trimmed = input.latestAnswer.replace(/\s+/g, " ").trim();
    const snippet = trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
    parts.push(`Last assistant turn: ${snippet}`);
  }
  if (parts.length === 0) {
    return "No durable pre-goal context recorded.";
  }
  return parts.join("\n\n");
}
