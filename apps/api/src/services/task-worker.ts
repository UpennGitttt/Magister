import { processTaskExecution, type TaskJob } from "./process-task-intent-service";

// ───────────────────────────────────────────────────────────────────
// AbortController registry (per active task) — unchanged signature
// ───────────────────────────────────────────────────────────────────

const activeAbortControllers = new Map<string, AbortController>();

export function getAbortController(taskId: string): AbortController | undefined {
  return activeAbortControllers.get(taskId);
}

export function registerAbortController(taskId: string, ac: AbortController): void {
  activeAbortControllers.set(taskId, ac);
}

export function removeAbortController(taskId: string): void {
  activeAbortControllers.delete(taskId);
}

// ───────────────────────────────────────────────────────────────────
// Concurrent TaskWorker
// ───────────────────────────────────────────────────────────────────
//
// Previous design was a single-threaded serial queue (one `running`
// boolean, one task at a time). With long-running plan-mode + goal-loop
// tasks that ran for minutes, any concurrently-submitted task sat in
// the queue uninstrumented and got reaped by the stuck-EXECUTING
// recovery scan (which only skipped tasks with an active
// AbortController — registered AFTER dequeue).
//
// New design: bounded concurrent pool with explicit queued/active sets
// visible to the reaper and the cancel path, idempotent enqueue
// (multiple intake paths can call enqueue(taskId) safely), and a
// telemetry snapshot for the status panel.
//
// Default concurrency is 4. Each leader runtime holds checkpoint
// history + provider streaming state, ~50-200 MB peak — 4 concurrent
// ≈ ~1 GB worst case. WAL + 5s busy_timeout (packages/db/src/client.ts)
// bounds SQLite write contention. Env override:
// `MAGISTER_TASK_WORKER_CONCURRENCY=N`.

function defaultConcurrency(): number {
  const raw = process.env.MAGISTER_TASK_WORKER_CONCURRENCY;
  if (!raw) return 4;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

export class TaskWorker {
  private queue: TaskJob[] = [];
  private queuedIds = new Set<string>();
  private active = new Set<string>();
  private concurrency: number;
  private readonly executor: (job: TaskJob) => Promise<void>;

  /**
   * `executor` is injectable so tests can construct a TaskWorker with a
   * stub instead of monkey-patching the `processTaskExecution` module
   * binding (bun's `mock.module` leaks across files and tripped the
   * cancel-integration suite when both ran in the same process).
   * Production still calls the singleton at the bottom of this file
   * with no override → falls back to the real `processTaskExecution`.
   */
  constructor(
    concurrency: number,
    executor: (job: TaskJob) => Promise<void> = processTaskExecution,
  ) {
    this.concurrency = concurrency;
    this.executor = executor;
  }

  /**
   * Add a task job to the queue. Idempotent: re-enqueueing a taskId
   * that is currently queued OR active is a no-op. Multiple intake
   * paths (REST /tasks, /tasks/:id/messages mailbox-resume, Feishu
   * gateway, startup recovery) all converge here, so the contract
   * is "tell the worker this id needs to run; if it already knows,
   * don't double-dispatch". Follow-up prompts during queued-state
   * MUST go through the mailbox path — see routes/tasks.ts where
   * the live-run/queued check writes the new prompt to the mailbox
   * table instead of calling enqueue with a fresh job.
   */
  enqueue(job: TaskJob): void {
    if (this.queuedIds.has(job.taskId) || this.active.has(job.taskId)) return;
    this.queue.push(job);
    this.queuedIds.add(job.taskId);
    this.tryStart();
  }

  /**
   * Drain the queue up to `concurrency` parallel tasks. Each
   * `runOne` is fire-and-forget — its `finally` block calls
   * `tryStart` again to fill any newly-vacated slot.
   *
   * Pre-async mutation order: we add to `active` and remove from
   * `queuedIds` SYNCHRONOUSLY before scheduling the async `runOne`,
   * so the next `tryStart` call (or any `isQueued`/`isActive`
   * caller) sees consistent state before the next event-loop tick.
   */
  private tryStart(): void {
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queuedIds.delete(job.taskId);
      this.active.add(job.taskId);
      void this.runOne(job);
    }
  }

  private async runOne(job: TaskJob): Promise<void> {
    const ac = new AbortController();
    registerAbortController(job.taskId, ac);
    try {
      await this.executor(job);
    } catch (err) {
      console.error(`Task ${job.taskId} failed:`, err);
    } finally {
      removeAbortController(job.taskId);
      this.active.delete(job.taskId);
      this.tryStart();
    }
  }

  /**
   * Self-requeue path for the running job's own continuation —
   * specifically the goal-mode Ralph loop, which finishes a leader
   * turn and immediately wants the next turn to drain the
   * mailbox row it just wrote (`process-task-intent-service.ts`
   * Ralph branch).
   *
   * The plain `enqueue` is no-op when `active.has(taskId)` is true,
   * which IS true for the currently-running job calling this from
   * inside `processTaskExecution` — the `active.delete(taskId)` in
   * `runOne.finally` only fires after `processTaskExecution` returns.
   * So a synchronous self-enqueue is silently dropped, the mailbox
   * row never gets consumed, and the task hangs in EXECUTING until a
   * recovery scan reaps it. (Regression introduced when the worker
   * went from serial queue to concurrent pool — the old serial
   * `while (queue.length > 0)` naturally consumed self-enqueues
   * because nothing tracked "active" yet.)
   *
   * Fix: defer the enqueue to the next macrotask via `setImmediate`.
   * The promise-microtask queue drains first — that's when
   * `runOne`'s await continuation + `finally` run, releasing the
   * active slot — and our deferred enqueue fires AFTER, hitting the
   * normal idempotency guard with `active.has(taskId) === false`.
   * Re-uses `enqueue` so all the existing queue accounting still
   * applies; the only difference is timing.
   */
  requeueAfterCurrent(job: TaskJob): void {
    setImmediate(() => this.enqueue(job));
  }

  isQueued(taskId: string): boolean {
    return this.queuedIds.has(taskId);
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /**
   * Cancel a task that is queued but not yet dispatched. Returns
   * true if a queued entry was removed. The cancel route should
   * call this BEFORE attempting `getAbortController(taskId)?.abort()`
   * — a queued task has no controller registered yet, so the
   * existing cancel path was a no-op for them. After removal the
   * caller is responsible for flipping the role_runtime / task
   * state rows to CANCELLED (the worker only knows about queue
   * state, not DB state).
   */
  cancelQueued(taskId: string): boolean {
    if (!this.queuedIds.has(taskId)) return false;
    this.queue = this.queue.filter((j) => j.taskId !== taskId);
    this.queuedIds.delete(taskId);
    return true;
  }

  /**
   * Snapshot for /system/status. Pure read — safe to call any time.
   */
  snapshot(): { concurrency: number; activeCount: number; queuedCount: number; activeIds: string[]; queuedIds: string[] } {
    return {
      concurrency: this.concurrency,
      activeCount: this.active.size,
      queuedCount: this.queuedIds.size,
      activeIds: Array.from(this.active),
      queuedIds: Array.from(this.queuedIds),
    };
  }
}

export const taskWorker = new TaskWorker(defaultConcurrency());

/** Exposed for runtime-recovery-service so the stuck-EXECUTING reaper
 *  can skip tasks that are queued but not yet dispatched (they have
 *  no AbortController yet because that's only registered on
 *  dequeue). */
export function isTaskQueued(taskId: string): boolean {
  return taskWorker.isQueued(taskId);
}
