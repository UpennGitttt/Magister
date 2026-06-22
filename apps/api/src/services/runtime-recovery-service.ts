import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { stat } from "node:fs/promises";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../repositories/runtime-workspace-repository";
import { TaskRepository } from "../repositories/task-repository";
import { dispatchRun, type DispatchRunResult } from "./dispatch-run-service";
import { resumeLeaderFromCheckpoint } from "./leader-session-resume-service";
import { LeaderSessionStore } from "./leader-session-store";

const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_STALE_RUNNING_MS = 10 * 60 * 1000;
const DEFAULT_STUCK_TASK_MS = 3 * 60 * 1000;
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 3;

type RecoveryNow = () => Date;
type RecoveryDispatchRun = (
  runId: string,
  options?: {
    skipAutomation?: boolean;
  },
) => Promise<DispatchRunResult | null>;

export type RuntimeRecoveryTickResult = {
  scannedRunningCount: number;
  scannedTaskCount: number;
  scannedWorkspaceCount: number;
  recoveredRunIds: string[];
  resumedTaskIds: string[];
  blockedRunIds: string[];
  cleanupEligibleRunIds: string[];
  missingWorkspaceRunIds: string[];
  /** P5 — child runtimes whose parent ended (COMPLETED / FAILED /
   *  CANCELLED) while they were still RUNNING. Reaped here so the
   *  task tree doesn't accumulate ghosts. */
  orphanedRunIds: string[];
};

export type RuntimeRecoveryStatus = {
  enabled: boolean;
  inFlight: boolean;
  intervalMs: number;
  staleRunningThresholdMs: number;
  stuckTaskThresholdMs: number;
  maxAttempts: number;
  lastTickAt: string | null;
  lastScannedRunningCount: number;
  lastScannedTaskCount: number;
  lastScannedWorkspaceCount: number;
  lastRecoveredRunIds: string[];
  lastResumedTaskIds: string[];
  lastBlockedRunIds: string[];
  lastCleanupEligibleRunIds: string[];
  lastMissingWorkspaceRunIds: string[];
  lastOrphanedRunIds: string[];
};

type RecoveryResumeLeader = (input: {
  taskId: string;
  runId: string;
  workspaceId: string;
}) => Promise<{ ok: boolean; reason: string }>;

type RuntimeRecoveryDependencies = {
  now?: RecoveryNow;
  dispatchRun?: RecoveryDispatchRun;
  resumeLeaderFromCheckpoint?: RecoveryResumeLeader;
  executionEventRepository?: ExecutionEventRepository;
  roleRuntimeRepository?: RoleRuntimeRepository;
  runtimeWorkspaceRepository?: RuntimeWorkspaceRepository;
  taskRepository?: TaskRepository;
  observabilityAdapter?: LocalObservabilityAdapter;
};

let recoveryLoopTimer: ReturnType<typeof setInterval> | null = null;
let recoveryLoopInFlight = false;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isRuntimeRecoveryEnabled() {
  return parseBoolean(process.env.MAGISTER_RUNTIME_RECOVERY_ENABLED, true);
}

function getRecoveryIntervalMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_RECOVERY_INTERVAL_MS,
    DEFAULT_RECOVERY_INTERVAL_MS,
  );
}

function getStaleRunningThresholdMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS,
    DEFAULT_STALE_RUNNING_MS,
  );
}

function getStuckTaskThresholdMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS,
    DEFAULT_STUCK_TASK_MS,
  );
}

function getRecoveryMaxAttempts() {
  return parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_RECOVERY_MAX_ATTEMPTS,
  );
}

function buildEventId(prefix: string) {
  return `event_${prefix}_${crypto.randomUUID()}`;
}

function isRuntimeStale(runtimeUpdatedAt: Date, now: Date, thresholdMs: number) {
  return now.getTime() - runtimeUpdatedAt.getTime() >= thresholdMs;
}

function parsePayload(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readNumber(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function readStringArray(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readString(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function canWakeWaitingTask(waitingPayload: Record<string, unknown> | null) {
  const executionMode = readString(waitingPayload, "executionMode");
  if (executionMode === "long_running") {
    return true;
  }

  if (executionMode === "immediate" || executionMode === "bounded_execution") {
    return false;
  }

  return readString(waitingPayload, "stopReason") === "sleep_until";
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function getRuntimeRecoveryStatus(
  executionEventRepository = new ExecutionEventRepository(),
): Promise<RuntimeRecoveryStatus> {
  const latestTickEvent = await executionEventRepository.getLatestByType(
    "worker.runtime_recovery.tick",
  );
  const payload = parsePayload(latestTickEvent?.payloadJson);

  return {
    enabled: isRuntimeRecoveryEnabled(),
    inFlight: recoveryLoopInFlight,
    intervalMs: getRecoveryIntervalMs(),
    staleRunningThresholdMs: getStaleRunningThresholdMs(),
    stuckTaskThresholdMs: getStuckTaskThresholdMs(),
    maxAttempts: getRecoveryMaxAttempts(),
    lastTickAt: latestTickEvent?.occurredAt.toISOString() ?? null,
    lastScannedRunningCount: readNumber(payload, "scannedRunningCount"),
    lastScannedTaskCount: readNumber(payload, "scannedTaskCount"),
    lastScannedWorkspaceCount: readNumber(payload, "scannedWorkspaceCount"),
    lastRecoveredRunIds: readStringArray(payload, "recoveredRunIds"),
    lastResumedTaskIds: readStringArray(payload, "resumedTaskIds"),
    lastBlockedRunIds: readStringArray(payload, "blockedRunIds"),
    lastCleanupEligibleRunIds: readStringArray(payload, "cleanupEligibleRunIds"),
    lastMissingWorkspaceRunIds: readStringArray(payload, "missingWorkspaceRunIds"),
    lastOrphanedRunIds: readStringArray(payload, "orphanedRunIds"),
  };
}

export async function recoverRuntimeOrchestrationTick(
  dependencies: RuntimeRecoveryDependencies = {},
): Promise<RuntimeRecoveryTickResult> {
  const now = dependencies.now ?? (() => new Date());
  const dispatchRunFn = dependencies.dispatchRun ?? dispatchRun;
  const resumeLeaderFn =
    dependencies.resumeLeaderFromCheckpoint ?? resumeLeaderFromCheckpoint;
  const executionEventRepository =
    dependencies.executionEventRepository ?? new ExecutionEventRepository();
  const roleRuntimeRepository =
    dependencies.roleRuntimeRepository ?? new RoleRuntimeRepository();
  const runtimeWorkspaceRepository =
    dependencies.runtimeWorkspaceRepository ?? new RuntimeWorkspaceRepository();
  const taskRepository = dependencies.taskRepository ?? new TaskRepository();
  const observabilityAdapter =
    dependencies.observabilityAdapter ?? new LocalObservabilityAdapter();

  const staleRunningThresholdMs = getStaleRunningThresholdMs();
  const stuckTaskThresholdMs = getStuckTaskThresholdMs();
  const recoveryMaxAttempts = getRecoveryMaxAttempts();
  const tickStartedAt = now();
  const runtimes = await roleRuntimeRepository.listAll();
  const runtimeWorkspaces = await runtimeWorkspaceRepository.listAll();
  const runtimeWorkspaceByRunId = new Map(
    runtimeWorkspaces.map((workspace) => [workspace.runId, workspace] as const),
  );
  const tasks = await taskRepository.listAll();
  const cleanupEligibleRunIds = runtimeWorkspaces
    .filter((workspace) => workspace.status !== "running" && Boolean(workspace.finishedAt))
    .map((workspace) => workspace.runId);
  const missingWorkspaceRunIds: string[] = [];
  for (const workspace of runtimeWorkspaces) {
    if (workspace.status !== "running") {
      continue;
    }
    if (await pathExists(workspace.workspaceDir)) {
      continue;
    }
    missingWorkspaceRunIds.push(workspace.runId);
  }

  // Skip runtimes whose task is in EXECUTING state — those are owned
  // by the stuck-EXECUTING handler later in this same tick. If both
  // conditions fire (runtime stale-RUNNING AND task stuck-EXECUTING),
  // the stale-RUNNING path's "requeue + redispatch" leads to a
  // configuration-block branch in dispatchRun (when the leader's
  // provider config has gone stale or is missing for tests), which
  // sets task=BLOCKED. That's a worse outcome than the stuck-EXECUTING
  // verdict (task=FAILED with `trigger: stuck_executing`) — and it
  // races the test fixture that pre-existed since 0ad8902.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const staleRunningRuntimes = runtimes
    .filter((runtime) => runtime.state === "RUNNING")
    .filter((runtime) => {
      const ownerTask = taskById.get(runtime.taskId);
      if (ownerTask?.state === "EXECUTING") return false;
      return (
        isRuntimeStale(runtime.updatedAt, tickStartedAt, staleRunningThresholdMs) ||
        missingWorkspaceRunIds.includes(runtime.id)
      );
    });

  const recoveredRunIds: string[] = [];
  const blockedRunIds: string[] = [];
  for (const runtime of staleRunningRuntimes) {
    const task = tasks.find((item) => item.id === runtime.taskId);
    if (!task) {
      continue;
    }
    const missingRuntimeWorkspace = missingWorkspaceRunIds.includes(runtime.id)
      ? runtimeWorkspaceByRunId.get(runtime.id) ?? null
      : null;
    const recoveryReason = missingRuntimeWorkspace
      ? "runtime_workspace_missing"
      : "runtime_recovery_stale_running";
    const runtimeWorkspacePayload = missingRuntimeWorkspace
      ? {
          requestedStrategy: missingRuntimeWorkspace.requestedStrategy ?? null,
          strategy: missingRuntimeWorkspace.strategy,
          decisionReason: missingRuntimeWorkspace.decisionReason ?? null,
          fallbackReason: missingRuntimeWorkspace.fallbackReason ?? null,
          workspaceDir: missingRuntimeWorkspace.workspaceDir,
          baseWorkspaceDir: missingRuntimeWorkspace.baseWorkspaceDir,
          missingOnDisk: true,
        }
      : null;

    const eventAt = now();
    if (runtime.attemptCount >= recoveryMaxAttempts) {
      await roleRuntimeRepository.update(runtime.id, {
        state: "FAILED",
        currentSessionId: null,
        updatedAt: eventAt,
        completedAt: eventAt,
      });

      await taskRepository.update(task.id, {
        state: "BLOCKED",
        updatedAt: eventAt,
      });

      await observabilityAdapter.recordEvent({
        id: buildEventId("runtime_recovery_exhausted"),
        type: "task.orchestration.stopped",
        taskId: task.id,
        roleRuntimeId: runtime.id,
        workspaceId: task.workspaceId,
        severity: "warn",
        occurredAt: eventAt,
        payloadJson: JSON.stringify({
          message: missingRuntimeWorkspace
            ? `Runtime recovery exhausted for ${runtime.roleId} after the allocated workspace disappeared`
            : `Runtime recovery exhausted for ${runtime.roleId}; run moved to FAILED`,
          action: "block",
          stopReason: "runtime_recovery_exhausted",
          recoveryReason,
          state: "BLOCKED",
          taskState: "BLOCKED",
          roleId: runtime.roleId,
          runId: runtime.id,
          attemptCount: runtime.attemptCount,
          maxAttempts: recoveryMaxAttempts,
          runtimeWorkspace: runtimeWorkspacePayload,
        }),
      });

      blockedRunIds.push(runtime.id);
      continue;
    }

    await roleRuntimeRepository.update(runtime.id, {
      state: "QUEUED",
      currentSessionId: null,
      completedAt: null,
      updatedAt: eventAt,
    });

    await taskRepository.update(task.id, {
      state: "IN_PROGRESS",
      updatedAt: eventAt,
      completedAt: null,
    });

    await observabilityAdapter.recordEvent({
      id: buildEventId("runtime_recovery_requeue"),
      type: "task.orchestration.transition",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      severity: "info",
      occurredAt: eventAt,
      payloadJson: JSON.stringify({
        message: missingRuntimeWorkspace
          ? `Runtime recovery re-queued ${runtime.roleId} after the allocated workspace disappeared`
          : `Runtime recovery re-queued stale ${runtime.roleId} run`,
        transition: "retry",
        reason: recoveryReason,
        action: "retry",
        state: "IN_PROGRESS",
        taskState: "IN_PROGRESS",
        roleId: runtime.roleId,
        runId: runtime.id,
        previousState: "RUNNING",
        runtimeWorkspace: runtimeWorkspacePayload,
      }),
    });

    recoveredRunIds.push(runtime.id);
    await dispatchRunFn(runtime.id, { skipAutomation: true });
  }

  const runtimesByTaskId = new Map<string, typeof runtimes>();
  for (const runtime of runtimes) {
    const list = runtimesByTaskId.get(runtime.taskId) ?? [];
    list.push(runtime);
    runtimesByTaskId.set(runtime.taskId, list);
  }

  const resumedTaskIds: string[] = [];
  const candidateTasks = tasks.filter(
    (task) => task.state === "IN_PROGRESS" || task.state === "WAITING",
  );
  for (const task of candidateTasks) {
    const taskRuntimes = runtimesByTaskId.get(task.id) ?? [];
    if (taskRuntimes.length === 0) {
      continue;
    }

    const managerRuntime = [...taskRuntimes]
      .filter((runtime) => runtime.roleId === "leader" && runtime.state === "COMPLETED")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    if (task.state === "WAITING") {
      if (!managerRuntime) {
        continue;
      }

      const waitingEvents = await executionEventRepository.listByTaskId(task.id);
      const latestWaitingEvent = [...waitingEvents]
        .filter((event) => event.type === "task.orchestration.waiting")
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
      const waitingPayload = parsePayload(latestWaitingEvent?.payloadJson);
      const nextWakeupAt = readString(waitingPayload, "nextWakeupAt");
      if (!nextWakeupAt) {
        continue;
      }
      if (!canWakeWaitingTask(waitingPayload)) {
        continue;
      }

      const wakeupAtMs = Date.parse(nextWakeupAt);
      if (!Number.isFinite(wakeupAtMs) || wakeupAtMs > tickStartedAt.getTime()) {
        continue;
      }

      await taskRepository.update(task.id, {
        state: "IN_PROGRESS",
        updatedAt: tickStartedAt,
        completedAt: null,
      });
      resumedTaskIds.push(task.id);

      const leaderRuntimeForWaiting = taskRuntimes.find((r) => r.roleId === "leader");
      if (leaderRuntimeForWaiting) {
        const recoveryAttemptedAtWaiting = now();
        await observabilityAdapter.recordEvent({
          id: buildEventId("leader_recovery_attempted_waiting"),
          type: "leader.recovery_attempted",
          taskId: task.id,
          roleRuntimeId: leaderRuntimeForWaiting.id,
          workspaceId: task.workspaceId,
          severity: "info",
          occurredAt: recoveryAttemptedAtWaiting,
          payloadJson: JSON.stringify({
            message: `Recovery attempted for leader after WAITING wakeup`,
            trigger: "waiting_wakeup",
            runId: leaderRuntimeForWaiting.id,
          }),
        });
        await resumeLeaderFn({
          taskId: task.id,
          runId: leaderRuntimeForWaiting.id,
          workspaceId: task.workspaceId,
        }).catch(() => {
          // Log but don't throw — recovery is best-effort
        });
      }
      continue;
    }

    const hasRunning = taskRuntimes.some((runtime) => runtime.state === "RUNNING");
    if (hasRunning) {
      continue;
    }

    const hasQueuedOrCreated = taskRuntimes.some(
      (runtime) => runtime.state === "QUEUED" || runtime.state === "CREATED",
    );
    if (!hasQueuedOrCreated) {
      continue;
    }

    const latestUpdatedAt = taskRuntimes.reduce((latest, runtime) => {
      return runtime.updatedAt.getTime() > latest.getTime() ? runtime.updatedAt : latest;
    }, taskRuntimes[0]!.updatedAt);
    if (!isRuntimeStale(latestUpdatedAt, tickStartedAt, stuckTaskThresholdMs)) {
      continue;
    }

    if (!managerRuntime) {
      continue;
    }

    await taskRepository.update(task.id, {
      state: "IN_PROGRESS",
      updatedAt: now(),
      completedAt: null,
    });
    resumedTaskIds.push(task.id);

    const leaderRuntimeForStuck = taskRuntimes.find((r) => r.roleId === "leader");
    if (leaderRuntimeForStuck) {
      const recoveryAttemptedAtStuck = now();
      await observabilityAdapter.recordEvent({
        id: buildEventId("leader_recovery_attempted_stuck"),
        type: "leader.recovery_attempted",
        taskId: task.id,
        roleRuntimeId: leaderRuntimeForStuck.id,
        workspaceId: task.workspaceId,
        severity: "info",
        occurredAt: recoveryAttemptedAtStuck,
        payloadJson: JSON.stringify({
          message: `Recovery attempted for leader after stuck IN_PROGRESS detection`,
          trigger: "stuck_in_progress",
          runId: leaderRuntimeForStuck.id,
        }),
      });
      await resumeLeaderFn({
        taskId: task.id,
        runId: leaderRuntimeForStuck.id,
        workspaceId: task.workspaceId,
      }).catch(() => {});
    }
  }

  // Stuck-EXECUTING scan: live-process recovery for leader loops that
  // hung mid-flight without crashing the api process — model API call
  // never returned, websocket dropped silently with no error event,
  // user cancelled but the loop got stuck on a tool that ignored
  // signals, etc. The startup `recoverStaleTasks` only runs at api
  // boot; in-process freezes have no reaper.
  //
  // Freshness signal: max(task.updatedAt, latest event occurredAt).
  // task.updatedAt is bumped whenever processTaskExecution writes
  // EXECUTING (start of a follow-up turn) — using events alone would
  // mistakenly reap a freshly-resumed task whose latest event is
  // still the prior turn's task:completed.
  //
  // Skip when an AbortController is registered for the taskId — the
  // loop is alive in THIS process, either making progress or blocked
  // on a long-running tool (waitForApproval can hold for ~5min).
  // The reaper is for crashes / orphaned state, not in-process pauses;
  // this is what distinguishes "stuck" from "patiently working".
  const stuckExecutingTaskIds: string[] = [];
  const executingTasks = tasks.filter((task) => task.state === "EXECUTING");
  const { getAbortController, isTaskQueued } = await import("./task-worker");
  for (const task of executingTasks) {
    // Skip if the loop is alive in-process (AbortController present)
    // OR the task is queued waiting for a worker slot. A queued task
    // has `state=EXECUTING` (stamped at intake) but no AbortController
    // yet — without this check the reaper saw `EXECUTING + no AC +
    // last event = task.created intake stamp` and fail-reaped at the
    // 3-min threshold before the task ever got a dispatch slot.
    if (getAbortController(task.id) || isTaskQueued(task.id)) continue;
    const events = await executionEventRepository.listByTaskId(task.id);
    // Exclude checkpoint events from the freshness signal — they are
    // internal bookkeeping written at wall-clock time (new Date()), not
    // leader-loop progress. Including them would reset the staleness
    // clock on every checkpoint write, masking a genuinely stuck loop.
    const progressEvents = events.filter(
      (e) => e.type !== "leader.session_checkpoint",
    );
    const latestEventAt = progressEvents.length > 0
      ? progressEvents[progressEvents.length - 1]!.occurredAt
      : null;
    const lastTouchedMs = Math.max(
      task.updatedAt.getTime(),
      latestEventAt?.getTime() ?? 0,
    );
    if (lastTouchedMs === 0) continue; // brand-new with nothing yet — let it breathe
    if (!isRuntimeStale(new Date(lastTouchedMs), tickStartedAt, stuckTaskThresholdMs)) {
      continue;
    }

    // B8: Before marking FAILED, check if a checkpoint exists for
    // the leader runtime. If one does, route through resumeLeaderFn
    // instead — crash recovery with a live checkpoint is a resume, not
    // a failure. Only fall through to FAILED when there is nothing to
    // resume from (no leader runtime or no checkpoint).
    const taskRuntimes = runtimesByTaskId.get(task.id) ?? [];
    const leaderRuntimeForExec = taskRuntimes.find((r) => r.roleId === "leader");
    if (leaderRuntimeForExec) {
      const sessionStore = new LeaderSessionStore();
      const hasCheckpoint = await sessionStore.isSessionActive(leaderRuntimeForExec.id);
      // Active-goal tasks are NOT auto-resumed here. `resumeLeaderFromCheckpoint`
      // finalizes the run DONE/FAILED and does not run the goal-continuation
      // logic (mailbox write + requeue lives in process-task-intent), so
      // resuming a crashed goal iteration would PREMATURELY end an active
      // goal. Fall through to FAILED instead — the operator can restart the
      // goal, and FAILED is honest (the goal didn't finish) where a resumed
      // DONE would be a lie. (Follow-up: teach the resume wrapper goal
      // continuation so goals can be recovered — see task #42.)
      const isActiveGoal = Boolean(task.goalObjective) && task.goalStatus === "active";
      if (hasCheckpoint && !isActiveGoal) {
        stuckExecutingTaskIds.push(task.id);

        // A checkpoint exists → resume rather than mark FAILED. We resume
        // even a checkpoint flagged `terminal` (the final-answer turn):
        // for a non-goal run, resume self-heals a run that completed but
        // crashed before its terminal task write (one wasteful final turn
        // over the narrow crash window). The `terminal` flag is persisted
        // as checkpoint metadata but deliberately not acted on here.
        const recoveryAttemptedAtExec = tickStartedAt;
        await observabilityAdapter.recordEvent({
          id: buildEventId("leader_recovery_stuck_executing"),
          type: "leader.recovery_attempted",
          taskId: task.id,
          roleRuntimeId: leaderRuntimeForExec.id,
          workspaceId: task.workspaceId,
          severity: "info",
          occurredAt: recoveryAttemptedAtExec,
          payloadJson: JSON.stringify({
            message: `Stuck EXECUTING task has checkpoint — attempting resume instead of FAIL`,
            trigger: "stuck_executing_resume",
            runId: leaderRuntimeForExec.id,
            lastTouchedAt: new Date(lastTouchedMs).toISOString(),
            ...(latestEventAt ? { lastEventAt: latestEventAt.toISOString() } : {}),
            thresholdMs: stuckTaskThresholdMs,
          }),
        });
        await resumeLeaderFn({
          taskId: task.id,
          runId: leaderRuntimeForExec.id,
          workspaceId: task.workspaceId,
        }).catch(() => {
          // Log but don't throw — recovery is best-effort
        });
        continue;
      }
    }

    // No checkpoint (or no leader runtime) — fall through to FAILED.
    const failedAt = tickStartedAt;
    await taskRepository.update(task.id, {
      state: "FAILED",
      updatedAt: failedAt,
      completedAt: failedAt,
    });
    // M5 Phase 3 — runtime-recovery reaped a stuck-EXECUTING task.
    // Reflection lets the extractor note the failure pattern if
    // it recurs (e.g., "tasks of class X always stall after Y").
    try {
      const { fireFailureReflection } = await import(
        "./memory/memory-failure-reflection"
      );
      fireFailureReflection({
        kind: "task_failed",
        taskId: task.id,
        summary: `runtime-recovery: task was stuck in EXECUTING with no live heartbeat; reaped`,
      });
    } catch {
      // Best-effort.
    }
    for (const runtime of taskRuntimes) {
      if (runtime.state === "RUNNING") {
        await roleRuntimeRepository.update(runtime.id, {
          state: "FAILED",
          completedAt: failedAt,
          updatedAt: failedAt,
        });
      }
    }
    stuckExecutingTaskIds.push(task.id);

    await observabilityAdapter.recordEvent({
      id: buildEventId("leader_recovery_stuck_executing"),
      type: "leader.recovery_attempted",
      taskId: task.id,
      ...(taskRuntimes[0] ? { roleRuntimeId: taskRuntimes[0].id } : {}),
      workspaceId: task.workspaceId,
      severity: "warning",
      occurredAt: failedAt,
      payloadJson: JSON.stringify({
        message: `Reaped stuck EXECUTING task — last activity ${Math.round((failedAt.getTime() - lastTouchedMs) / 1000)}s ago`,
        trigger: "stuck_executing",
        lastTouchedAt: new Date(lastTouchedMs).toISOString(),
        ...(latestEventAt ? { lastEventAt: latestEventAt.toISOString() } : {}),
        thresholdMs: stuckTaskThresholdMs,
      }),
    });
  }

  // P5.5 — AWAITING_TEAMMATES recovery. Tasks in this state are
  // sitting idle waiting for background teammates to complete. After
  // an API restart (deploy/crash), their teammate processes may be
  // gone but the role_runtime rows still say RUNNING. Without
  // recovery, the task is stuck forever — no one will write the
  // completion mailbox row that would wake the leader.
  //
  // Strategy: for each AWAITING_TEAMMATES task, find orphaned
  // background teammate runtimes (state=RUNNING, spawnedAsync=true,
  // no live abort controller) and treat them as failed:
  //   1. Mark runtime FAILED
  //   2. Write a synthetic teammate completion mailbox row so the
  //      leader sees a result instead of waiting forever
  //   3. Re-enqueue the leader so it processes the synthetic results
  const awaitingTeammatesTasks = tasks.filter((t) => t.state === "AWAITING_TEAMMATES");
  if (awaitingTeammatesTasks.length > 0) {
    const { getAbortController: getTaskAC } = await import("./task-worker");
    const { isActiveAsyncTeammate } = await import(
      "./manager-automation/async-teammate-registry"
    );
    const { writeTeammateCompletionMailbox, reenqueueLeaderIfAwaiting } = await import(
      "./manager-automation/teammate-completion-service"
    );
    for (const task of awaitingTeammatesTasks) {
      const taskRuntimes = runtimesByTaskId.get(task.id) ?? [];
      const orphanedChildren = taskRuntimes.filter(
        (rt) =>
          rt.state === "RUNNING" &&
          rt.spawnedAsync &&
          !getTaskAC(task.id) &&
          !isActiveAsyncTeammate(task.id, rt.id),
      );
      let anyOrphans = false;
      for (const child of orphanedChildren) {
        anyOrphans = true;
        const reapedAt = now();
        await roleRuntimeRepository.update(child.id, {
          state: "FAILED",
          updatedAt: reapedAt,
          completedAt: reapedAt,
        });
        try {
          await writeTeammateCompletionMailbox({
            parentTaskId: task.id,
            teammateRunId: child.id,
            role: child.roleId,
            status: "FAILED",
            summary: "Recovery: this background teammate's process did not survive an API restart. The result is unrecoverable. Decide whether to re-spawn or move on.",
            spawnedAtMs: (child.startedAt ?? child.updatedAt).getTime(),
            completedAtMs: reapedAt.getTime(),
            parallelGroupId: child.parallelGroupId ?? null,
            failureReason: "process_lost_on_restart",
          });
        } catch (err) {
          console.warn(
            `[runtime-recovery] failed to write completion mailbox for orphaned ${child.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      let shouldReenqueue = anyOrphans;
      if (!shouldReenqueue) {
        try {
          const { TaskMailboxRepository } = await import(
            "../repositories/task-mailbox-repository"
          );
          shouldReenqueue =
            (await new TaskMailboxRepository().countUnconsumedTeammateCompletions(task.id)) > 0;
        } catch {
          // Best-effort. If mailbox inspection fails and no orphan was
          // synthesized, leave the awaiting task alone this tick.
        }
      }
      if (shouldReenqueue) {
        try {
          await reenqueueLeaderIfAwaiting(task.id);
        } catch (err) {
          console.warn(
            `[runtime-recovery] failed to re-enqueue AWAITING_TEAMMATES task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (anyOrphans) {
        await observabilityAdapter.recordEvent({
          id: buildEventId("leader_recovery_awaiting_teammates"),
          type: "leader.recovery_attempted",
          taskId: task.id,
          severity: "warn",
          occurredAt: now(),
          payloadJson: JSON.stringify({
            trigger: "awaiting_teammates_orphaned_children",
            orphanedRunIds: orphanedChildren.map((c) => c.id),
          }),
        });
      }
    }
  }

  // P5 — orphan child runtime cleanup. When the leader spawns a
  // teammate via spawn_teammate, the child runtime has parentRunId
  // pointing at the leader's runId. If the parent enters a terminal
  // state (COMPLETED, FAILED, CANCELLED) while the child is still
  // RUNNING — typical cause: parent task was cancelled by user, or
  // crashed with the child still mid-flight — the child runtime
  // would otherwise heartbeat forever. The stale-RUNNING reaper
  // misses it because heartbeats keep updatedAt fresh. We catch it
  // by checking parent state directly.
  //
  // For Magister teammates (in-process leaderLoop): if the abort
  // controller is still in THIS process, signal abort so the loop
  // exits cleanly. For CLI teammates: best-effort mark FAILED; the
  // separate cli-agent-spawn-service holds child PIDs.
  const orphanedRunIds: string[] = [];
  const runtimeById = new Map(runtimes.map((r) => [r.id, r] as const));
  const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
  const { getAbortController: getTaskAbortController } = await import("./task-worker");
  for (const child of runtimes) {
    if (child.state !== "RUNNING") continue;
    if (!child.parentRunId) continue;
    const parent = runtimeById.get(child.parentRunId);
    if (!parent) continue; // parent not found — leave to other reaper
    if (!TERMINAL_STATES.has(parent.state)) continue;
    const childTask = taskById.get(child.taskId);
    if (
      child.spawnedAsync &&
      parent.taskId === child.taskId &&
      childTask?.state === "AWAITING_TEAMMATES"
    ) {
      continue;
    }

    // Kimi review C — race guard. The runtimes list snapshotted at
    // tick start may be stale: the child could have naturally
    // transitioned to COMPLETED/FAILED/CANCELLED between the read
    // and this write. Re-fetch and bail if the child is no longer
    // RUNNING — otherwise we'd clobber a legitimately-completed
    // child back to FAILED.
    const childCurrent = await roleRuntimeRepository.getById(child.id);
    if (!childCurrent || childCurrent.state !== "RUNNING") {
      continue;
    }

    const reapedAt = now();
    await roleRuntimeRepository.update(child.id, {
      state: "FAILED",
      currentSessionId: null,
      updatedAt: reapedAt,
      completedAt: reapedAt,
    });

    // Mark the child task FAILED too (only when not already
    // terminal AND not BLOCKED). Kimi review M — BLOCKED tasks are
    // awaiting manual user intervention; auto-reaping them to FAILED
    // destroys legitimate intervention workflow. Leave BLOCKED tasks
    // alone; a separate human-driven path will resolve them.
    if (childTask && !["DONE", "FAILED", "CANCELLED", "BLOCKED"].includes(childTask.state)) {
      await taskRepository.update(child.taskId, {
        state: "FAILED",
        updatedAt: reapedAt,
        completedAt: reapedAt,
      });
      // M5 Phase 3 — child task reaped because parent runtime died.
      try {
        const { fireFailureReflection } = await import(
          "./memory/memory-failure-reflection"
        );
        fireFailureReflection({
          kind: "task_failed",
          taskId: child.taskId,
          summary: `runtime-recovery: parent runtime died, child task reaped`,
        });
      } catch {
        // Best-effort.
      }
    }

    // Best-effort in-process abort. CLI teammates have their own
    // process tree which we don't reach into here — they'll be
    // cleaned up by OS process accounting when the parent exits, or
    // by a future cli-agent reaper.
    try {
      const abort = getTaskAbortController(child.taskId);
      abort?.abort?.();
    } catch {
      // ignored
    }

    await observabilityAdapter.recordEvent({
      id: buildEventId("runtime_orphan_reaped"),
      type: "task.orchestration.stopped",
      taskId: child.taskId,
      roleRuntimeId: child.id,
      workspaceId: childTask?.workspaceId ?? null,
      severity: "warn",
      occurredAt: reapedAt,
      payloadJson: JSON.stringify({
        message: `Child runtime ${child.roleId} reaped — parent ${parent.roleId} ended in ${parent.state}`,
        action: "reap",
        stopReason: "parent_terminal",
        parentRunId: parent.id,
        parentState: parent.state,
        roleId: child.roleId,
        runId: child.id,
        state: "FAILED",
        taskState: "FAILED",
      }),
    });
    orphanedRunIds.push(child.id);
  }

  const result = {
    scannedRunningCount: staleRunningRuntimes.length,
    scannedTaskCount: candidateTasks.length + stuckExecutingTaskIds.length,
    scannedWorkspaceCount: runtimeWorkspaces.length,
    recoveredRunIds,
    resumedTaskIds,
    blockedRunIds,
    cleanupEligibleRunIds,
    missingWorkspaceRunIds,
    orphanedRunIds,
  };

  // Persist tick events on two cadences:
  //   1. ALWAYS when the tick did real work — kept for audit trail.
  //   2. Otherwise as a low-rate heartbeat (every 30 min by
  //      default) so `/system/status.workers.runtimeRecovery.lastTickAt`
  //      stays a meaningful liveness signal. Without the
  //      heartbeat, suppressing no-op ticks made `lastTickAt`
  //      look stale (or null after the 24h TTL prune ran),
  //      producing false "worker hung" diagnoses for an
  //      idle-but-healthy system.
  //
  // Net write rate vs the pre-suppression baseline:
  //   before this PR: ~2,880 rows/day (every 30s)
  //   after no-op suppression alone: ~0 rows/day on idle systems → liveness gone
  //   after heartbeat: ~48 rows/day (every 30min) → liveness preserved
  // — well below the noise threshold that triggered the 20k-row
  // problem, while keeping the read-side contract intact.
  const tickDidWork =
    result.recoveredRunIds.length > 0 ||
    result.resumedTaskIds.length > 0 ||
    result.blockedRunIds.length > 0 ||
    result.cleanupEligibleRunIds.length > 0 ||
    result.missingWorkspaceRunIds.length > 0 ||
    result.orphanedRunIds.length > 0;
  const heartbeatIntervalMs = parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_RECOVERY_HEARTBEAT_MS,
    30 * 60 * 1000,
  );
  // Latest persisted tick — heartbeat fires when the gap since
  // that tick exceeds `heartbeatIntervalMs`. Best-effort: if the
  // lookup fails we err on the side of writing a heartbeat (lose
  // a row, don't lose liveness).
  let shouldHeartbeat = false;
  if (!tickDidWork) {
    try {
      const latest = await executionEventRepository.getLatestByType(
        "worker.runtime_recovery.tick",
      );
      const sinceLastMs = latest
        ? tickStartedAt.getTime() - latest.occurredAt.getTime()
        : Number.POSITIVE_INFINITY;
      shouldHeartbeat = sinceLastMs >= heartbeatIntervalMs;
    } catch {
      shouldHeartbeat = true;
    }
  }
  if (tickDidWork || shouldHeartbeat) {
    await observabilityAdapter.recordEvent({
      id: buildEventId("runtime_recovery_tick"),
      type: "worker.runtime_recovery.tick",
      severity: "info",
      occurredAt: tickStartedAt,
      payloadJson: JSON.stringify({
        message: `Runtime recovery scanned ${result.scannedRunningCount} running lanes, ${result.scannedTaskCount} in-progress tasks, and ${result.scannedWorkspaceCount} runtime workspaces`,
        action: tickDidWork ? "scan" : "heartbeat",
        trigger: "runtime_recovery_worker",
        scannedRunningCount: result.scannedRunningCount,
        scannedTaskCount: result.scannedTaskCount,
        scannedWorkspaceCount: result.scannedWorkspaceCount,
        recoveredRunIds: result.recoveredRunIds,
        resumedTaskIds: result.resumedTaskIds,
        blockedRunIds: result.blockedRunIds,
        cleanupEligibleRunIds: result.cleanupEligibleRunIds,
        missingWorkspaceRunIds: result.missingWorkspaceRunIds,
        orphanedRunIds: result.orphanedRunIds,
      }),
    });
  }

  return result;
}

export async function startRuntimeRecoveryLoop() {
  if (!isRuntimeRecoveryEnabled()) {
    return;
  }

  if (recoveryLoopTimer) {
    return;
  }

  const runTick = async () => {
    if (recoveryLoopInFlight) {
      return;
    }

    recoveryLoopInFlight = true;
    try {
      await recoverRuntimeOrchestrationTick();
    } finally {
      recoveryLoopInFlight = false;
    }
  };

  await runTick();
  recoveryLoopTimer = setInterval(() => {
    void runTick();
  }, getRecoveryIntervalMs());
}

export async function stopRuntimeRecoveryLoop() {
  if (!recoveryLoopTimer) {
    return;
  }

  clearInterval(recoveryLoopTimer);
  recoveryLoopTimer = null;
}
