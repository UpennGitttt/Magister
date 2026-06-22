/**
 * Goal-mode v2 — plan.md artifact lifecycle (phase 3).
 *
 * Each goal task gets a durable plan file at
 *   `<workspaceDir>/.magister/goals/<taskId>/plan.md`
 * which acts as the single source of truth for that goal across
 * iterations.  Codex `/goal` uses the same "plan-as-artifact"
 * pattern: humans can read/edit it, the model writes to it via
 * the `update_goal_plan` tool, and every continuation embeds its
 * contents so the model never relies on conversation memory
 * for the objective + acceptance criteria.
 *
 * Operations:
 *   - initializePlan      — write skeleton on goal start
 *   - readPlan            — load full contents (NULL if missing)
 *   - writePlan           — full-content replacement (model tool)
 *   - appendIterationLog  — append iteration verdict block
 *   - markBlocker         — append blocker section (used by evaluator
 *                           in phase 4)
 *   - markRequirementDone — tick a checklist item
 *
 * Locking: plan.md operations are single-task-scoped and the
 * TaskWorker runs per-task single-flighted, so there's no need
 * for a file lock. If two requests racced (e.g. parallel goal
 * starts on the same task — shouldn't happen), the last writer
 * wins and the goal_id mismatch in phase 6 would catch the orphan.
 *
 * Spec reference: docs/plans/2026-05-12-goal-mode-overhaul.md phase 3.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { resolveWorkspaceBaseDir } from "../runtime-workspace-service";
import { TaskRepository } from "../../repositories/task-repository";

/** Cap on plan.md size to keep continuation prompts bounded.
 *  64 KiB is generous — codex caps theirs at 32 KiB. */
const MAX_PLAN_BYTES = 64 * 1024;

export type PlanInitInput = {
  taskId: string;
  workspaceId: string;
  objective: string;
  goalId: string;
};

export type PlanLocation = {
  /** Absolute on-disk path. */
  absolutePath: string;
  /** Path relative to the workspace base dir — what we persist
   *  to `tasks.goal_plan_path` for portability. */
  relativePath: string;
};

/** Resolve where this task's plan.md lives. Pure path math —
 *  does not touch the filesystem. */
export async function resolvePlanLocation(
  taskId: string,
  workspaceId: string,
): Promise<PlanLocation> {
  const baseDir = await resolveWorkspaceBaseDir(workspaceId);
  const absolutePath = join(baseDir, ".magister", "goals", taskId, "plan.md");
  const relativePath = relative(baseDir, absolutePath);
  return { absolutePath, relativePath };
}

/** Synthesize the initial plan skeleton. Kept simple — heavy
 *  acceptance-criteria authoring happens in the leader's first turn
 *  via `update_goal_plan`. */
function renderSkeleton(input: PlanInitInput): string {
  const isoNow = new Date().toISOString();
  return [
    "# Goal plan",
    "",
    `**Goal ID**: \`${input.goalId}\``,
    `**Started**: ${isoNow}`,
    "",
    "## Objective",
    "",
    input.objective.trim(),
    "",
    "## Acceptance criteria",
    "",
    "_(Leader: replace this section with concrete, verifiable criteria on the first turn.",
    "Each criterion should be checkable against `file:line`, command output, or a git commit.)_",
    "",
    "- [ ] (criterion 1 — replace me)",
    "",
    "## Iteration log",
    "",
    "_(Updated by the loop after each iteration verdict.)_",
    "",
  ].join("\n");
}

/** Variant skeleton used by mid-conversation goal-start (v3 §P0-1).
 *  Same shape as renderSkeleton but with an extra `## Prior context`
 *  section right after the objective so the model's first iteration
 *  knows the goal landed on top of an existing conversation rather
 *  than starting cold.
 *
 *  The summary is hard-capped at ~1 KiB so plan.md doesn't blow past
 *  its 64 KiB ceiling early. */
function renderSkeletonWithPriorContext(
  input: PlanInitInput,
  priorContextSummary: string,
): string {
  const isoNow = new Date().toISOString();
  const cappedSummary = priorContextSummary.length > 1024
    ? `${priorContextSummary.slice(0, 1024)}\n\n_(truncated; full conversation is still in leader checkpoint)_`
    : priorContextSummary;
  return [
    "# Goal plan",
    "",
    `**Goal ID**: \`${input.goalId}\``,
    `**Started**: ${isoNow}`,
    `**Started**: mid-conversation (token budget counts from this moment)`,
    "",
    "## Objective",
    "",
    input.objective.trim(),
    "",
    "## Prior context",
    "",
    cappedSummary,
    "",
    "## Acceptance criteria",
    "",
    "_(Leader: replace this section with concrete, verifiable criteria on the first turn.",
    "Each criterion should be checkable against `file:line`, command output, or a git commit.)_",
    "",
    "- [ ] (criterion 1 — replace me)",
    "",
    "## Iteration log",
    "",
    "_(Updated by the loop after each iteration verdict.)_",
    "",
  ].join("\n");
}

/** Write the skeleton + return where it landed. Idempotent: if
 *  the file already exists, it is NOT overwritten — the existing
 *  goal_id wins (defends against duplicate POST /tasks attempts
 *  for the same task). */
export async function initializePlan(input: PlanInitInput): Promise<PlanLocation> {
  const location = await resolvePlanLocation(input.taskId, input.workspaceId);
  await mkdir(dirname(location.absolutePath), { recursive: true });
  try {
    // Try the strictest create — `wx` flag fails if file exists.
    await writeFile(location.absolutePath, renderSkeleton(input), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    // File already exists — preserve.  Caller already has the
    // correct plan_path persisted; nothing to do.
  }
  return location;
}

/** Mid-conversation goal-start variant (v3 §P0-1). Same idempotent
 *  contract as initializePlan, but writes the prior-context skeleton
 *  instead of the cold one. */
export async function initializePlanWithPriorContext(input: PlanInitInput & {
  priorContextSummary: string;
}): Promise<PlanLocation> {
  const location = await resolvePlanLocation(input.taskId, input.workspaceId);
  await mkdir(dirname(location.absolutePath), { recursive: true });
  try {
    await writeFile(
      location.absolutePath,
      renderSkeletonWithPriorContext(input, input.priorContextSummary),
      { encoding: "utf8", flag: "wx" },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
  }
  return location;
}

/** Read plan.md, or NULL if missing / unreadable / oversize. */
export async function readPlan(
  taskId: string,
  workspaceId: string,
): Promise<string | null> {
  const { absolutePath } = await resolvePlanLocation(taskId, workspaceId);
  try {
    const content = await readFile(absolutePath, "utf8");
    if (content.length > MAX_PLAN_BYTES) {
      // Truncate from the END so the most-recent iteration log
      // survives even when the criterion table is gigantic.
      // Plan.md should never realistically exceed this — but if a
      // model goes wild, we still degrade gracefully.
      const head = content.slice(0, Math.floor(MAX_PLAN_BYTES * 0.3));
      const tail = content.slice(-Math.floor(MAX_PLAN_BYTES * 0.6));
      return `${head}\n\n... [truncated ${content.length - head.length - tail.length} bytes] ...\n\n${tail}`;
    }
    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write the entire plan.md — used by the `update_goal_plan` leader
 *  tool. Rejects content over MAX_PLAN_BYTES to prevent runaway. */
export async function writePlan(
  taskId: string,
  workspaceId: string,
  content: string,
): Promise<{ bytesWritten: number }> {
  if (content.length > MAX_PLAN_BYTES) {
    throw new Error(
      `plan.md content (${content.length}B) exceeds the ${MAX_PLAN_BYTES}B cap. `
      + `Trim acceptance criteria or move historical iteration logs into a separate file.`,
    );
  }
  const { absolutePath } = await resolvePlanLocation(taskId, workspaceId);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return { bytesWritten: Buffer.byteLength(content, "utf8") };
}

/** Append a structured iteration verdict block under
 *  `## Iteration log`. Falls back to appending at EOF if the
 *  header isn't found (e.g. user edited the plan and removed it). */
export async function appendIterationLog(
  taskId: string,
  workspaceId: string,
  entry: {
    iteration: number;
    verdict: "in-progress" | "complete-claimed" | "blocked";
    summary: string;
  },
): Promise<void> {
  const existing = (await readPlan(taskId, workspaceId)) ?? "";
  const isoNow = new Date().toISOString();
  const block = [
    "",
    `### Iteration ${entry.iteration} — ${entry.verdict} (${isoNow})`,
    "",
    entry.summary.trim(),
    "",
  ].join("\n");

  let next: string;
  if (existing.includes("## Iteration log")) {
    next = existing + block;
  } else {
    next = `${existing}\n\n## Iteration log\n${block}`;
  }
  await writePlan(taskId, workspaceId, next);
}

/** Append a "blocker" section — used by phase 4's evaluator when
 *  it rejects a `mark_goal_complete` attempt. */
export async function appendBlocker(
  taskId: string,
  workspaceId: string,
  iteration: number,
  reason: string,
): Promise<void> {
  await appendIterationLog(taskId, workspaceId, {
    iteration,
    verdict: "blocked",
    summary: reason,
  });
}

/** Backfill on TaskRepository: persist the `goal_plan_path` /
 *  `goal_id` for a task that just initialized its plan. Kept
 *  near the file ops so callers can do it in a single helper. */
export async function persistPlanLocation(
  taskId: string,
  location: PlanLocation,
  goalId: string,
): Promise<void> {
  const repo = new TaskRepository();
  await repo.update(taskId, {
    goalId,
    goalPlanPath: location.relativePath,
  });
}
