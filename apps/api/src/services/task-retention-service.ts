import { and, eq, inArray, lt } from "@magister/db";

import {
  approvals,
  artifacts,
  channelSessions,
  createDb,
  getRawSqlite,
  executionEvents,
  roleRuntimes,
  runtimeWorkspaces,
  taskAttachments,
  taskMailbox,
  taskMedia,
  tasks,
} from "@magister/db";

// Mirror retention policy of `runtime-workspace-service.ts` so disk and
// DB stay in lockstep:
//   - TTL: 30 days. Tasks older than this go.
//   - Cap: 50 most-recently-updated terminal tasks. Older eligible
//     tasks beyond rank 50 go even if under TTL.
// Active states (non-terminal) are NEVER deleted — we don't want to
// rip a task out from under a running leader loop.
const DEFAULT_TASK_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TASK_RETENTION_MAX = 50;
const DEFAULT_TASK_RETENTION_INTERVAL_MS = 5 * 60 * 1000;

// High-frequency low-value worker events. These are written every
// scan even when nothing happened (recovery / housekeeping pings)
// and we don't want them to outlive their usefulness — 24 h is the
// longest debug window we'd ever care about. Source-side, the
// recovery worker now only emits ticks when it acts (see
// `runtime-recovery-service.ts`); this list catches anything that
// slipped in before the source fix or that other no-op workers add
// later.
const NOISE_EVENT_TYPES = ["worker.runtime_recovery.tick"] as const;
const DEFAULT_NOISE_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

// Terminal states — anything NOT in this list is treated as still-active
// and skipped by the retention sweep. The canonical TASK_STATES enum in
// `packages/core/src/domain/task.ts` doesn't list CANCELLED / BLOCKED /
// COMPLETED, but the codebase writes them as raw strings:
//   - CANCELLED — `routes/tasks.ts:114` (user cancel)
//   - BLOCKED   — `dispatch-run-service.ts:317` + `runtime-recovery-service.ts:302`
//   - COMPLETED — legacy state used by `routes/tasks.ts:54` classification sets
// Treat them as terminal so they don't accumulate forever.
const TERMINAL_TASK_STATES = [
  "DONE",
  "FAILED",
  "PR_OPEN",
  "MERGE_WAITING",
  "CANCELLED",
  "BLOCKED",
  "COMPLETED",
] as const;
const TERMINAL_TASK_STATE_SET = new Set<string>(TERMINAL_TASK_STATES);

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Delete all rows for a single task — child tables first, then the task
 * row, all in a SQLite transaction so we never leave dangling children.
 * `channel_sessions.current_task_id` is also nulled if it points at the
 * task being deleted (the channel session itself is shared infrastructure
 * and stays).
 *
 * Returns `true` if the delete went through, `false` if the task no
 * longer exists or has transitioned back to a non-terminal state since
 * the eligibility query (e.g. a recovery loop reactivated it, or a user
 * retry transitioned it from FAILED back to EXECUTING). The recheck
 * inside the transaction is the only thing that makes this race-safe —
 * SQLite's BEGIN IMMEDIATE serializes the read+write so by the time we
 * read the state and decide to delete, no other writer can sneak in.
 */
/**
 * Best-effort cleanup of the on-disk attachment directory for a
 * task. Runs OUTSIDE the DB transaction because filesystem
 * operations don't participate in SQLite rollback — leftover dir
 * with no rows pointing at it is preferable to losing the rows
 * but keeping the dir, which would leak space without the
 * dashboard knowing.
 */
async function purgeAttachmentFiles(taskId: string): Promise<void> {
  const { promises: fsp } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), ".magister", "uploads", taskId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Don't surface — retention sweep is best-effort and shouldn't
    // block on filesystem hiccups.
  }
}

export async function deleteTaskRowAndChildren(
  taskId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const db = createDb();
  // Native synchronous transaction (F4 — async drizzle tx is a no-op on
  // bun-sqlite and throws on better-sqlite3). The state read is a sync
  // `.get()` inside the same native tx.
  const sqlite = getRawSqlite();
  const removed = sqlite.transaction(() => {
    const current = db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!current) return false;
    // Retention sweeps must skip non-terminal tasks (don't yank a running
    // task out from under the leader loop). User-initiated DELETE passes
    // `force: true` — the user explicitly chose to drop the row, including
    // anything still running.
    if (!options.force && !TERMINAL_TASK_STATE_SET.has(current.state)) {
      return false;
    }

    db.delete(executionEvents).where(eq(executionEvents.taskId, taskId)).run();
    db.delete(roleRuntimes).where(eq(roleRuntimes.taskId, taskId)).run();
    db.delete(runtimeWorkspaces).where(eq(runtimeWorkspaces.taskId, taskId)).run();
    db.delete(approvals).where(eq(approvals.taskId, taskId)).run();
    db.delete(artifacts).where(eq(artifacts.taskId, taskId)).run();
    db.delete(taskMailbox).where(eq(taskMailbox.taskId, taskId)).run();
    // Drop attachment metadata rows in the same transaction as the
    // task. The on-disk files under .magister/uploads/<taskId>/
    // are removed by `purgeAttachmentFiles` below — outside the
    // transaction since fs ops can't roll back.
    db.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
    db.delete(taskMedia).where(eq(taskMedia.taskId, taskId)).run();

    db
      .update(channelSessions)
      .set({ currentTaskId: null })
      .where(eq(channelSessions.currentTaskId, taskId))
      .run();

    db.delete(tasks).where(eq(tasks.id, taskId)).run();
    return true;
  })();

  if (removed) {
    await purgeAttachmentFiles(taskId);
    try {
      const { purgeOutboundMediaForTask } = await import("./media-output-service");
      await purgeOutboundMediaForTask(taskId);
    } catch {
      // Same best-effort posture as attachments/scratchpad: a failed
      // filesystem cleanup must not resurrect an already-deleted task.
    }
    // Memory scratchpad lives at project/.magister/memory/scratchpad/<taskId>.md
    // and pins to the task's lifecycle — purge it in the same hook so
    // we don't leak an orphan markdown file once the task it described
    // is gone. Best-effort; degrade silently when the memory runtime
    // isn't initialized (legacy / test environments).
    try {
      const { purgeScratchpadForTask } = await import(
        "./memory/memory-fs-service"
      );
      await purgeScratchpadForTask(taskId);
    } catch {
      // Memory runtime might not be initialized in some test paths —
      // ignore so retention sweeps keep working regardless.
    }
  }
  return removed;
}

export type TaskRetentionTickResult = {
  scanned: number;
  /** Tasks that were actually removed from the DB this tick. */
  deletedTaskIds: string[];
  /** Tasks that were eligible but the recheck-in-transaction declined to
   *  delete (transitioned back to active, or already gone). Distinct from
   *  failures so logs report reality, not intent. */
  skippedTaskIds: string[];
  /** Tasks where the delete itself threw. Will be retried on the next tick. */
  failedTaskIds: string[];
  reason: { ttl: number; cap: number };
};

/**
 * Delete terminal tasks that fall outside the retention window. Returns
 * a summary of what was dropped so the periodic loop can log meaningful
 * progress without re-querying.
 */
export async function cleanupStaleTasks(): Promise<TaskRetentionTickResult> {
  const ttlMs = parsePositiveInteger(
    process.env.MAGISTER_TASK_RETENTION_TTL_MS,
    DEFAULT_TASK_RETENTION_TTL_MS,
  );
  const maxKept = parsePositiveInteger(
    process.env.MAGISTER_TASK_RETENTION_MAX,
    DEFAULT_TASK_RETENTION_MAX,
  );

  const db = createDb();

  // Pull only terminal tasks; non-terminal stays untouched. Order by
  // updatedAt desc so the cap rule keeps the most-recent N.
  const terminalTasks = await db.query.tasks.findMany({
    where: (t, { inArray }) => inArray(t.state, [...TERMINAL_TASK_STATES]),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
    columns: { id: true, updatedAt: true },
  });

  const now = Date.now();
  const toDelete: string[] = [];
  let ttlReason = 0;
  let capReason = 0;

  for (let i = 0; i < terminalTasks.length; i++) {
    const t = terminalTasks[i]!;
    const updatedAtMs = t.updatedAt instanceof Date ? t.updatedAt.getTime() : Number(t.updatedAt);
    const overTtl = now - updatedAtMs > ttlMs;
    const overCap = i >= maxKept;
    if (overTtl || overCap) {
      toDelete.push(t.id);
      if (overTtl) ttlReason++;
      if (overCap) capReason++;
    }
  }

  const deletedTaskIds: string[] = [];
  const skippedTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  for (const id of toDelete) {
    try {
      const removed = await deleteTaskRowAndChildren(id);
      if (removed) deletedTaskIds.push(id);
      else skippedTaskIds.push(id);
    } catch {
      // Best-effort. A failed delete will be retried on the next tick.
      failedTaskIds.push(id);
    }
  }

  return {
    scanned: terminalTasks.length,
    deletedTaskIds,
    skippedTaskIds,
    failedTaskIds,
    reason: { ttl: ttlReason, cap: capReason },
  };
}

/**
 * Bulk-prune low-value worker events older than `ttlMs`. Runs in the
 * task-retention tick so we don't spawn a separate timer. Returns the
 * row count for logging. No-op if the noise list is empty.
 */
export async function pruneNoiseEvents(ttlMs?: number): Promise<number> {
  const effectiveTtlMs = parsePositiveInteger(
    process.env.MAGISTER_NOISE_EVENT_TTL_MS,
    ttlMs ?? DEFAULT_NOISE_EVENT_TTL_MS,
  );
  const cutoff = new Date(Date.now() - effectiveTtlMs);
  const db = createDb();
  const result = await db
    .delete(executionEvents)
    .where(
      and(
        inArray(executionEvents.type, [...NOISE_EVENT_TYPES]),
        lt(executionEvents.occurredAt, cutoff),
      ),
    );
  // bun:sqlite returns `changes` on the result; drizzle re-exposes it
  // as `.rowsAffected` on the underlying RunResult, but the public
  // typing varies by adapter. Best-effort: if the count is missing,
  // fall back to 0 — the log line is just informational.
  const rowsAffected =
    (result as unknown as { changes?: number; rowsAffected?: number }).changes ??
    (result as unknown as { changes?: number; rowsAffected?: number }).rowsAffected ??
    0;
  return rowsAffected;
}

// ──────────────────────────────────────────────────────────────────────
// Periodic loop
// ──────────────────────────────────────────────────────────────────────

let retentionLoopTimer: ReturnType<typeof setInterval> | null = null;
let retentionLoopInFlight = false;

/**
 * Periodic background tick that prunes terminal tasks past the TTL or
 * recent-N cap. Runs once at startup (so a long-stopped server cleans
 * up immediately on boot) and every 5 minutes thereafter.
 *
 * Disable via MAGISTER_TASK_RETENTION_ENABLED=false.
 */
export async function startTaskRetentionLoop() {
  const enabled = (process.env.MAGISTER_TASK_RETENTION_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled || retentionLoopTimer) return;

  const intervalMs = parsePositiveInteger(
    process.env.MAGISTER_TASK_RETENTION_INTERVAL_MS,
    DEFAULT_TASK_RETENTION_INTERVAL_MS,
  );

  const tick = async () => {
    if (retentionLoopInFlight) return;
    retentionLoopInFlight = true;
    try {
      const result = await cleanupStaleTasks();
      if (result.deletedTaskIds.length > 0 || result.failedTaskIds.length > 0 || result.skippedTaskIds.length > 0) {
        console.log(
          `[task-retention] swept ${result.scanned} terminal tasks, deleted ${result.deletedTaskIds.length}, skipped ${result.skippedTaskIds.length}, failed ${result.failedTaskIds.length} (ttl=${result.reason.ttl}, cap=${result.reason.cap})`,
        );
      }
      try {
        const noiseDeleted = await pruneNoiseEvents();
        if (noiseDeleted > 0) {
          console.log(`[task-retention] pruned ${noiseDeleted} stale noise events`);
        }
      } catch (err) {
        console.warn(
          `[task-retention] noise prune failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // P1 — token usage record retention. 30 days TTL + 50K row
      // cap (whichever fires first). Hooks into the same tick so
      // we don't spawn another timer. Tunable via env mirroring
      // task TTL knobs.
      try {
        const tokenTtlMs = parsePositiveInteger(
          process.env.MAGISTER_TOKEN_USAGE_TTL_MS,
          30 * 24 * 60 * 60 * 1000,
        );
        const tokenMaxRows = parsePositiveInteger(
          process.env.MAGISTER_TOKEN_USAGE_MAX_ROWS,
          50_000,
        );
        const cutoff = new Date(Date.now() - tokenTtlMs);
        const { TokenUsageRepository } = await import("../repositories/token-usage-repository");
        const pruned = await new TokenUsageRepository().pruneOlderThan(cutoff, tokenMaxRows);
        if (pruned.removedByTtl > 0 || pruned.removedByCap > 0) {
          console.log(
            `[task-retention] pruned token usage rows: ${pruned.removedByTtl} ttl + ${pruned.removedByCap} cap`,
          );
        }
      } catch (err) {
        console.warn(
          `[task-retention] token usage prune failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      console.warn(`[task-retention] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      retentionLoopInFlight = false;
    }
  };

  await tick();
  retentionLoopTimer = setInterval(() => { void tick(); }, intervalMs);
}

export async function stopTaskRetentionLoop() {
  if (!retentionLoopTimer) return;
  clearInterval(retentionLoopTimer);
  retentionLoopTimer = null;
}
