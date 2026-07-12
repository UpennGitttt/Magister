import { randomUUID } from "node:crypto";

import { Cron } from "croner";

import { createDb, eq, scheduledTasks, type ScheduledTaskSelect } from "@magister/db";

/**
 * User-configurable recurring task schedules (cron).
 *
 * A schedule row holds a 5-field cron expression + a prompt template.
 * The loop below (same startXxxLoop pattern as task-retention-service)
 * scans due rows every tick and fires each through processTaskIntent()
 * with source "web" — the spawned task is a completely normal task:
 * it lands on the Board, streams events, records token usage.
 *
 * Semantics:
 * - `nextRunAt` is persisted, so a schedule that came due while the
 *   server was down fires ONCE on the next tick (not N catch-up runs).
 * - Overlap guard: if the previously spawned task is still non-terminal,
 *   the trigger is skipped and nextRunAt advances to the next slot.
 * - Cron expressions evaluate in server-local time.
 */

const DEFAULT_SCHEDULER_INTERVAL_MS = 60 * 1000;

// Mirrors TERMINAL_TASK_STATES in task-retention-service.ts — states
// where the previous spawned task is finished and a new trigger may fire.
const TERMINAL_TASK_STATES = new Set([
  "DONE",
  "FAILED",
  "PR_OPEN",
  "MERGE_WAITING",
  "CANCELLED",
  "BLOCKED",
  "COMPLETED",
]);

export function validateCronExpression(expr: string): string | null {
  try {
    // croner throws on malformed expressions; paused+no-op run keeps
    // this validation side-effect free.
    new Cron(expr, { paused: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function computeNextRunAt(expr: string, from: Date = new Date()): Date | null {
  try {
    return new Cron(expr, { paused: true }).nextRun(from);
  } catch {
    return null;
  }
}

export type CreateScheduleInput = {
  name: string;
  cronExpr: string;
  prompt: string;
  workspaceId?: string | null | undefined;
  enabled?: boolean | undefined;
};

export type UpdateScheduleInput = {
  name?: string | undefined;
  cronExpr?: string | undefined;
  prompt?: string | undefined;
  workspaceId?: string | null | undefined;
  enabled?: boolean | undefined;
};

export async function listSchedules(): Promise<ScheduledTaskSelect[]> {
  const db = createDb();
  return db.query.scheduledTasks.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

export async function getSchedule(id: string): Promise<ScheduledTaskSelect | null> {
  const db = createDb();
  const row = await db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, id) });
  return row ?? null;
}

export async function createSchedule(input: CreateScheduleInput): Promise<ScheduledTaskSelect> {
  const cronError = validateCronExpression(input.cronExpr);
  if (cronError) {
    throw new Error(`Invalid cron expression "${input.cronExpr}": ${cronError}`);
  }
  const db = createDb();
  const now = new Date();
  const enabled = input.enabled !== false;
  const row = {
    id: `sched_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    name: input.name.trim(),
    cronExpr: input.cronExpr.trim(),
    prompt: input.prompt,
    workspaceId: input.workspaceId?.trim() || null,
    enabled: enabled ? 1 : 0,
    nextRunAt: enabled ? computeNextRunAt(input.cronExpr) : null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(scheduledTasks).values(row);
  return (await getSchedule(row.id))!;
}

export async function updateSchedule(
  id: string,
  input: UpdateScheduleInput,
): Promise<ScheduledTaskSelect | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;

  if (input.cronExpr !== undefined) {
    const cronError = validateCronExpression(input.cronExpr);
    if (cronError) {
      throw new Error(`Invalid cron expression "${input.cronExpr}": ${cronError}`);
    }
  }

  const cronExpr = input.cronExpr?.trim() ?? existing.cronExpr;
  const enabled = input.enabled ?? existing.enabled === 1;
  // Recompute the slot only when the expression or enablement changes —
  // a name-only edit must not push the next fire out by a period. A
  // disabled schedule keeps nextRunAt=null so the due-scan never sees it.
  const recomputeSlot = input.cronExpr !== undefined || input.enabled !== undefined;
  const db = createDb();
  await db
    .update(scheduledTasks)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.cronExpr !== undefined ? { cronExpr } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.workspaceId !== undefined
        ? { workspaceId: input.workspaceId?.trim() || null }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      ...(recomputeSlot ? { nextRunAt: enabled ? computeNextRunAt(cronExpr) : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, id));
  return getSchedule(id);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const existing = await getSchedule(id);
  if (!existing) return false;
  const db = createDb();
  await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
  return true;
}

async function isTaskStillRunning(taskId: string | null): Promise<boolean> {
  if (!taskId) return false;
  try {
    const { TaskRepository } = await import("../repositories/task-repository");
    const task = await new TaskRepository().getById(taskId);
    if (!task) return false;
    return !TERMINAL_TASK_STATES.has(task.state);
  } catch {
    // Can't tell — err on the side of not double-firing.
    return true;
  }
}

async function resolveWorkspaceId(preferred: string | null): Promise<string> {
  if (preferred) return preferred;
  try {
    const { WorkspaceRepository } = await import("../repositories/workspace-repository");
    const fallback = await new WorkspaceRepository().getDefault();
    if (fallback?.id) return fallback.id;
  } catch {
    // Fall through to the legacy literal (same posture as POST /tasks).
  }
  return "workspace_main";
}

export type SchedulerTickResult = {
  due: number;
  fired: string[];
  skippedRunning: string[];
  failed: string[];
};

export async function runSchedulerTick(now: Date = new Date()): Promise<SchedulerTickResult> {
  const db = createDb();
  const due = await db.query.scheduledTasks.findMany({
    where: (t, { and, eq: eqOp, lte, isNotNull }) =>
      and(eqOp(t.enabled, 1), isNotNull(t.nextRunAt), lte(t.nextRunAt, now)),
  });

  const result: SchedulerTickResult = { due: due.length, fired: [], skippedRunning: [], failed: [] };

  for (const schedule of due) {
    // Advance the slot FIRST so a crash mid-trigger can't cause a
    // re-fire storm on restart — at-most-once per slot.
    const nextRunAt = computeNextRunAt(schedule.cronExpr, now);
    await db
      .update(scheduledTasks)
      .set({ nextRunAt, updatedAt: now })
      .where(eq(scheduledTasks.id, schedule.id));

    if (await isTaskStillRunning(schedule.lastTaskId)) {
      result.skippedRunning.push(schedule.id);
      console.log(
        `[scheduler] "${schedule.name}" skipped — previous task ${schedule.lastTaskId} still running`,
      );
      continue;
    }

    try {
      const workspaceId = await resolveWorkspaceId(schedule.workspaceId);
      const { processTaskIntent } = await import("./process-task-intent-service");
      const spawned = await processTaskIntent({
        prompt: schedule.prompt,
        source: "web",
        workspaceId,
        createdBy: `schedule:${schedule.id}`,
      });
      await db
        .update(scheduledTasks)
        .set({ lastRunAt: now, lastTaskId: spawned.taskId, lastError: null, updatedAt: new Date() })
        .where(eq(scheduledTasks.id, schedule.id));
      result.fired.push(schedule.id);
      console.log(`[scheduler] "${schedule.name}" fired -> task ${spawned.taskId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(scheduledTasks)
        .set({ lastRunAt: now, lastError: message.slice(0, 2_000), updatedAt: new Date() })
        .where(eq(scheduledTasks.id, schedule.id));
      result.failed.push(schedule.id);
      console.warn(`[scheduler] "${schedule.name}" trigger failed: ${message}`);
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────
// Periodic loop (same shape as startTaskRetentionLoop)
// ──────────────────────────────────────────────────────────────────────

let schedulerLoopTimer: ReturnType<typeof setInterval> | null = null;
let schedulerLoopInFlight = false;

/**
 * Scans for due schedules every minute. Runs a tick immediately at
 * startup so schedules that came due during downtime fire right away.
 * Disable via MAGISTER_SCHEDULER_ENABLED=false.
 */
export async function startScheduledTaskLoop() {
  const enabled = (process.env.MAGISTER_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled || schedulerLoopTimer) return;

  const intervalMs = (() => {
    const parsed = Number.parseInt(process.env.MAGISTER_SCHEDULER_INTERVAL_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCHEDULER_INTERVAL_MS;
  })();

  const tick = async () => {
    if (schedulerLoopInFlight) return;
    schedulerLoopInFlight = true;
    try {
      await runSchedulerTick();
    } catch (err) {
      console.warn(`[scheduler] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      schedulerLoopInFlight = false;
    }
  };

  await tick();
  schedulerLoopTimer = setInterval(() => { void tick(); }, intervalMs);
}

export async function stopScheduledTaskLoop() {
  if (!schedulerLoopTimer) return;
  clearInterval(schedulerLoopTimer);
  schedulerLoopTimer = null;
}
