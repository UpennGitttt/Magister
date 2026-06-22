/**
 * Subgoals — mid-flight criteria refinement (v3 §P0-2).
 *
 * Lets the user tighten the goal's acceptance criteria while it's
 * actively running, without pausing the loop or re-spawning the task.
 *
 * Subgoals are user authority: the model cannot add them, only
 * verify them. The continuation template surfaces them as
 * "Additional criteria added by user mid-flight" and the evaluator's
 * system prompt is augmented to verify each one alongside the main
 * acceptance criteria from plan.md.
 *
 * Storage: JSON-serialized string array in `tasks.goal_subgoals`.
 * NULL or "[]" = no subgoals. Indices passed to the remove API are
 * 1-based for user-friendliness, but the service normalizes to
 * 0-based internally.
 */

import { TaskRepository } from "../../repositories/task-repository";

const MAX_SUBGOAL_BYTES = 4 * 1024;
const MAX_SUBGOALS = 32;

export type SubgoalOperation =
  | { kind: "add"; text: string }
  | { kind: "remove"; index1Based: number }
  | { kind: "clear" };

export type SubgoalResult =
  | { ok: true; data: { subgoals: string[] } }
  | {
      ok: false;
      error: {
        code:
          | "task_not_found"
          | "no_active_goal"
          | "invalid_subgoal"
          | "index_out_of_range"
          | "limit_reached";
        message: string;
      };
    };

export async function listSubgoals(taskId: string): Promise<SubgoalResult> {
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(taskId);
  if (!task) {
    return { ok: false, error: { code: "task_not_found", message: `Task ${taskId} not found` } };
  }
  if (!task.goalObjective) {
    return { ok: false, error: { code: "no_active_goal", message: "Task has no goal" } };
  }
  return { ok: true, data: { subgoals: parseSubgoals(task.goalSubgoals) } };
}

export async function addSubgoal(
  taskId: string,
  text: string,
): Promise<SubgoalResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "invalid_subgoal", message: "Subgoal text is empty" } };
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_SUBGOAL_BYTES) {
    return {
      ok: false,
      error: {
        code: "invalid_subgoal",
        message: `Subgoal exceeds ${MAX_SUBGOAL_BYTES} bytes`,
      },
    };
  }
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(taskId);
  if (!task) {
    return { ok: false, error: { code: "task_not_found", message: `Task ${taskId} not found` } };
  }
  if (!task.goalObjective || task.goalStatus !== "active") {
    return {
      ok: false,
      error: {
        code: "no_active_goal",
        message: "Task has no active goal — start a goal first",
      },
    };
  }
  const current = parseSubgoals(task.goalSubgoals);
  if (current.length >= MAX_SUBGOALS) {
    return {
      ok: false,
      error: {
        code: "limit_reached",
        message: `Cannot add more than ${MAX_SUBGOALS} subgoals on a single goal`,
      },
    };
  }
  const next = [...current, trimmed];
  await taskRepo.update(taskId, {
    goalSubgoals: JSON.stringify(next),
    updatedAt: new Date(),
  });
  return { ok: true, data: { subgoals: next } };
}

export async function removeSubgoal(
  taskId: string,
  index1Based: number,
): Promise<SubgoalResult> {
  if (!Number.isInteger(index1Based) || index1Based < 1) {
    return {
      ok: false,
      error: { code: "index_out_of_range", message: "Index must be 1-based positive integer" },
    };
  }
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(taskId);
  if (!task) {
    return { ok: false, error: { code: "task_not_found", message: `Task ${taskId} not found` } };
  }
  if (!task.goalObjective) {
    return { ok: false, error: { code: "no_active_goal", message: "Task has no goal" } };
  }
  const current = parseSubgoals(task.goalSubgoals);
  if (index1Based > current.length) {
    return {
      ok: false,
      error: {
        code: "index_out_of_range",
        message: `Index ${index1Based} out of range (current: ${current.length})`,
      },
    };
  }
  const next = current.filter((_, i) => i !== index1Based - 1);
  await taskRepo.update(taskId, {
    goalSubgoals: next.length > 0 ? JSON.stringify(next) : null,
    updatedAt: new Date(),
  });
  return { ok: true, data: { subgoals: next } };
}

export async function clearSubgoals(taskId: string): Promise<SubgoalResult> {
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(taskId);
  if (!task) {
    return { ok: false, error: { code: "task_not_found", message: `Task ${taskId} not found` } };
  }
  if (!task.goalObjective) {
    return { ok: false, error: { code: "no_active_goal", message: "Task has no goal" } };
  }
  await taskRepo.update(taskId, {
    goalSubgoals: null,
    updatedAt: new Date(),
  });
  return { ok: true, data: { subgoals: [] } };
}

/** Parse the JSON-serialized subgoals string from a Task row. Returns
 *  an empty array for NULL / invalid / non-array JSON — defensive
 *  against any future schema migration that hands us garbage. */
export function parseSubgoals(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}
