import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { LeaderSessionStore } from "./leader-session-store";
import type { TaskJob } from "./process-task-intent-service";

const RECOVERY_REQUEST_ID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateRecoveryRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const byte of bytes) {
    id += RECOVERY_REQUEST_ID_ALPHABET[byte % RECOVERY_REQUEST_ID_ALPHABET.length];
  }
  return id;
}

type RecoveryDependencies = {
  /**
   * Override the queue handoff for tests. The default lazily imports
   * taskWorker so a real `bun run dev` startup actually requeues —
   * tests pass a no-op (or a spy) to inspect what would have run
   * without spinning up the worker against a stub provider.
   */
  enqueueResume?: (job: TaskJob) => void;
};

/**
 * Startup recovery for tasks left in `EXECUTING` after a previous api
 * process died (SIGTERM from `bun --watch`, OOM, crash). Walks every
 * EXECUTING task and either:
 *   - Requeues the task from its latest leader checkpoint (state stays
 *     EXECUTING, runtime stays RUNNING — `processTaskExecution` resumes
 *     the loop with `restoredMessages`).
 *   - Marks it FAILED if there's no checkpoint to resume from.
 *
 * The pre-existing implementation always marked FAILED even when a
 * checkpoint existed (it logged "Recovered stale task" and then wrote
 * FAILED in the next breath), which is why every dev-restart of the
 * api turned in-flight chats into FAILED tasks. The fix actually
 * requeues.
 */
export async function recoverStaleTasks(
  deps: RecoveryDependencies = {},
): Promise<{ recovered: number; failed: number }> {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionStore = new LeaderSessionStore();

  const tasks = await taskRepo.listAll();
  const staleTasks = tasks.filter((task) => task.state === "EXECUTING");

  // Lazy-import taskWorker by default so the entry point of the
  // service module isn't tied to a heavy dependency graph at startup
  // and tests can swap a no-op via deps.enqueueResume.
  const enqueueResume: (job: TaskJob) => void = deps.enqueueResume
    ?? (async (job) => {
      const { taskWorker } = await import("./task-worker");
      taskWorker.enqueue(job);
    }) as (job: TaskJob) => void;

  let recovered = 0;
  let failed = 0;

  for (const task of staleTasks) {
    const runtimes = await runtimeRepo.listByTaskId(task.id);
    const latestRuntime = [...runtimes]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    // Only the leader runtime carries a session checkpoint. Other
    // runtimes (coder, reviewer, …) terminate per-call and don't
    // need a multi-turn resume — if their parent leader resumes,
    // it will respawn them as needed.
    const leaderRuntime = latestRuntime?.roleId === "leader" ? latestRuntime : null;
    const checkpoint = leaderRuntime
      ? await sessionStore.getLatestCheckpoint(leaderRuntime.id)
      : null;

    if (leaderRuntime && checkpoint && checkpoint.messages.length > 0) {
      // Real recovery: requeue with the restored message log. The
      // resumed loop reads the messages and continues from the next
      // turn — same path as a regular follow-up resume in
      // processTaskIntent (cf. line 502 there).
      try {
        enqueueResume({
          taskId: task.id,
          runId: leaderRuntime.id,
          requestId: generateRecoveryRequestId(),
          workspaceId: task.workspaceId,
          prompt: "[crash-recovery] resuming from checkpoint",
          restoredMessages: checkpoint.messages,
          ...(task.rootChannelBindingId
            ? { channelBindingId: task.rootChannelBindingId }
            : {}),
        });
        recovered += 1;
        console.log(
          `[crash-recovery] Requeued task ${task.id} from checkpoint (runId=${leaderRuntime.id}, turnCount=${checkpoint.turnCount})`,
        );
        // Bump runtime updatedAt so the periodic recovery loop and
        // any UI staleness check don't trip on stale timestamps
        // before processTaskExecution writes EXECUTING again.
        await runtimeRepo.update(leaderRuntime.id, {
          state: "RUNNING",
          updatedAt: new Date(),
        });
        continue;
      } catch (err) {
        console.error(
          `[crash-recovery] Failed to requeue task ${task.id}, will mark FAILED:`,
          err instanceof Error ? err.message : String(err),
        );
        // fall through to FAILED branch below
      }
    }

    const failedAt = new Date();
    await taskRepo.update(task.id, {
      state: "FAILED",
      updatedAt: failedAt,
      completedAt: failedAt,
    });
    failed += 1;

    // M5 Phase 3 — crash recovery reaped a task that was running
    // when the process died. Fire reflection so the extractor can
    // record a lesson if the failure pattern is recurring (e.g.,
    // "task type X keeps getting crash-reaped — investigate"). The
    // extractor is conservative; one-off reaps return empty ops.
    try {
      const { fireFailureReflection } = await import(
        "./memory/memory-failure-reflection"
      );
      fireFailureReflection({
        kind: "task_failed",
        taskId: task.id,
        summary: `crash-recovery: task was running when Magister exited; marked FAILED at boot`,
      });
    } catch {
      // Best-effort.
    }

    for (const runtime of runtimes) {
      if (runtime.state !== "RUNNING") {
        continue;
      }
      await runtimeRepo.update(runtime.id, {
        state: "FAILED",
        currentSessionId: null,
        updatedAt: failedAt,
        completedAt: failedAt,
      });
    }
  }

  try {
    const heartbeatService = await import("./agent-heartbeat-service");
    const profileService = await import("./agent-profile-service");

    await profileService.ensureDefaultAgentProfiles();
    const statuses = await heartbeatService.getAgentStatuses();
    for (const status of statuses) {
      if (status.status === "working") {
        await heartbeatService.updateAgentStatus(status.roleId, "idle");
      }
    }
  } catch {
    // best-effort startup cleanup
  }

  return { recovered, failed };
}
