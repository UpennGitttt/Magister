/**
 * Mid-flight objective edit (v3 §P1-5).
 *
 * Adopted from codex `objective_updated.md` — when the user redirects
 * a running goal, the next iteration gets a special prompt that:
 *   1. wraps the new objective in `<untrusted_objective>` (defensive
 *      framing for user data that just landed mid-conversation)
 *   2. clears the previous evaluator verdict, since it was issued
 *      against the old objective and can no longer gate completion
 *   3. tells the model not to keep doing work that only served the
 *      previous objective.
 *
 * The trigger is a timestamp on the task row (`goal_objective_edited_at`);
 * the worker checks it when assembling the next continuation, picks
 * the objective_updated template, and clears the timestamp so
 * subsequent iterations resume normal continuation.
 */

import { TaskRepository } from "../../repositories/task-repository";

const MAX_OBJECTIVE_BYTES = 32 * 1024;

export type EditObjectiveInput = {
  taskId: string;
  objective: string;
};

export type EditObjectiveResult =
  | {
      ok: true;
      data: {
        taskId: string;
        objective: string;
        editedAt: number;
      };
    }
  | {
      ok: false;
      error: {
        code:
          | "task_not_found"
          | "no_active_goal"
          | "invalid_objective"
          | "goal_not_active";
        message: string;
      };
    };

export async function editGoalObjective(
  input: EditObjectiveInput,
): Promise<EditObjectiveResult> {
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
    return { ok: false, error: { code: "task_not_found", message: `Task ${input.taskId} not found` } };
  }
  if (!task.goalObjective) {
    return {
      ok: false,
      error: { code: "no_active_goal", message: "Task has no goal to edit" },
    };
  }
  // Refuse on terminal goals — once it's complete/cancelled, editing
  // the objective is meaningless. Allow on paused (the user might
  // want to redirect before resuming).
  if (task.goalStatus === "complete" || task.goalStatus === "cancelled") {
    return {
      ok: false,
      error: {
        code: "goal_not_active",
        message: `Goal is in terminal status "${task.goalStatus}"; nothing to edit`,
      },
    };
  }

  const now = new Date();
  // Clear the previous evaluator verdict — it was issued against the
  // old objective. The next mark_goal_complete must wait for a fresh
  // evaluator spawn against the new objective.
  await taskRepo.update(input.taskId, {
    goalObjective: trimmed,
    goalObjectiveEditedAt: now.getTime(),
    goalLastVerifierVerdict: null,
    goalLastVerifierAt: null,
    goalLastVerifierBlocker: null,
    updatedAt: now,
  });

  // Append an iteration log entry to plan.md (best-effort).
  try {
    if (task.workspaceId) {
      const { appendIterationLog } = await import("./plan-file-service");
      await appendIterationLog(input.taskId, task.workspaceId, {
        iteration: task.goalIterations ?? 0,
        verdict: "in-progress",
        summary: `Objective edited by user. New objective: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? "…" : ""}`,
      });
    }
  } catch {
    // Best-effort.
  }

  return {
    ok: true,
    data: {
      taskId: input.taskId,
      objective: trimmed,
      editedAt: now.getTime(),
    },
  };
}
