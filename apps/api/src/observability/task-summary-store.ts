import { ApprovalRepository } from "../repositories/approval-repository";
import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getTaskOrchestrationReadModel } from "../services/orchestration-read-model-service";
import { deriveTaskBlockedNarrative } from "../services/task-blocked-narrative-service";
import type { TaskSummary } from "../services/materialize-task-summary-service";

function parseMessage(payloadJson?: string | null) {
  if (!payloadJson) {
    return undefined;
  }

  try {
    const payload = JSON.parse(payloadJson) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {}

  return undefined;
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

function readPayloadString(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
) {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function readPayloadStringArray(
  value: Record<string, unknown> | null | undefined,
  key: string,
) {
  if (!value) {
    return [];
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

type RecoveryNotice = NonNullable<TaskSummary["recoveryNotice"]>;

const ACTIVE_RECOVERY_TASK_STATES = new Set([
  "INTAKE",
  "CLARIFYING",
  "PLANNING",
  "EXECUTING",
  "REVIEWING",
  "TESTING",
  "IN_PROGRESS",
  "WAITING",
  "PAUSED",
  "QUEUED",
]);

function isActiveForRecoveredBadge(state: string): boolean {
  return ACTIVE_RECOVERY_TASK_STATES.has(state.trim().toUpperCase());
}

function recoveryRunId(
  payload: Record<string, unknown> | null,
  fallbackRunId: string | null | undefined,
): string | null {
  return readPayloadString(payload, ["runId", "roleRuntimeId"]) ?? fallbackRunId ?? null;
}

function recoveryReasonForTransition(payload: Record<string, unknown> | null): string | null {
  const action = readPayloadString(payload, ["action", "transition"]);
  const reason = readPayloadString(payload, ["reason", "recoveryReason"]);
  if (action !== "retry" || !reason?.startsWith("runtime_recovery_")) {
    return null;
  }
  return reason;
}

function recoveryReasonForStopped(payload: Record<string, unknown> | null): string | null {
  const stopReason = readPayloadString(payload, ["stopReason", "reason"]);
  if (stopReason !== "runtime_recovery_exhausted") {
    return null;
  }
  return stopReason;
}

function buildRecoveryNotice(input: {
  status: "recovered" | "blocked";
  occurredAt: Date;
  reason: string;
  previousState: string | null;
  nextState: string | null;
  runId: string | null;
}): RecoveryNotice {
  return {
    status: input.status,
    occurredAt: input.occurredAt.toISOString(),
    reason: input.reason,
    previousState: input.previousState,
    nextState: input.nextState,
    requiresUserAction: input.status === "blocked",
    runId: input.runId,
  };
}

function deriveTaskRecoveryNotice(input: {
  taskState: string;
  latestRunId: string | null;
  events: Awaited<ReturnType<ExecutionEventRepository["listForTaskSummary"]>>;
  latestRecoveryTickPayload: Record<string, unknown> | null;
  latestRecoveryTickAt: Date | null;
}): RecoveryNotice | null {
  const recoveryEvents = input.events
    .filter((event) =>
      event.type === "task.orchestration.transition" ||
      event.type === "task.orchestration.stopped")
    .sort((a, b) => {
      const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return (b.seq ?? 0) - (a.seq ?? 0);
    });

  const latestOrchestrationEvent = recoveryEvents[0];
  if (latestOrchestrationEvent) {
    const event = latestOrchestrationEvent;
    const payload = parsePayload(event.payloadJson);
    if (event.type === "task.orchestration.stopped") {
      const reason = recoveryReasonForStopped(payload);
      if (reason) {
        return buildRecoveryNotice({
          status: "blocked",
          occurredAt: event.occurredAt,
          reason,
          previousState: readPayloadString(payload, ["previousState", "fromState"]),
          nextState: readPayloadString(payload, ["state", "taskState", "nextState"]) ?? "BLOCKED",
          runId: recoveryRunId(payload, event.roleRuntimeId ?? input.latestRunId),
        });
      }
    } else {
      const reason = recoveryReasonForTransition(payload);
      if (reason && isActiveForRecoveredBadge(input.taskState)) {
        return buildRecoveryNotice({
          status: "recovered",
          occurredAt: event.occurredAt,
          reason,
          previousState: readPayloadString(payload, ["previousState", "fromState"]),
          nextState: readPayloadString(payload, ["state", "taskState", "nextState"]) ?? input.taskState,
          runId: recoveryRunId(payload, event.roleRuntimeId ?? input.latestRunId),
        });
      }
    }
  }

  const blockedRunIds = input.latestRecoveryTickPayload
    ? readPayloadStringArray(input.latestRecoveryTickPayload, "blockedRunIds")
    : [];
  const recoveryTickIsNewerThanTaskMarker =
    !latestOrchestrationEvent ||
    (input.latestRecoveryTickAt?.getTime() ?? 0) > latestOrchestrationEvent.occurredAt.getTime();
  if (
    input.latestRunId &&
    input.latestRecoveryTickAt &&
    recoveryTickIsNewerThanTaskMarker &&
    blockedRunIds.includes(input.latestRunId)
  ) {
    return buildRecoveryNotice({
      status: "blocked",
      occurredAt: input.latestRecoveryTickAt,
      reason: "runtime_recovery_exhausted",
      previousState: null,
      nextState: input.taskState,
      runId: input.latestRunId,
    });
  }

  return null;
}

export class TaskSummaryStore {
  constructor(
    private readonly taskRepository = new TaskRepository(),
    private readonly roleRuntimeRepository = new RoleRuntimeRepository(),
    private readonly approvalRepository = new ApprovalRepository(),
    private readonly artifactRepository = new ArtifactRepository(),
    private readonly executionEventRepository = new ExecutionEventRepository(),
  ) {}

  async get(taskId: string): Promise<TaskSummary | null> {
    const task = await this.taskRepository.getById(taskId);
    if (!task) {
      return null;
    }

    const [runtimes, approvals, artifacts, events, orchestration, latestRecoveryTick] = await Promise.all([
      this.roleRuntimeRepository.listByTaskId(taskId),
      this.approvalRepository.listByTaskId(taskId),
      this.artifactRepository.listByTaskId(taskId),
      this.executionEventRepository.listForTaskSummary(taskId),
      getTaskOrchestrationReadModel(taskId),
      this.executionEventRepository.getLatestByType("worker.runtime_recovery.tick"),
    ]);

    const latestRuntime = [...runtimes].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0];
    const latestApproval = [...approvals].sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    )[0];
    const latestArtifact = [...artifacts].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
    const latestFailureEvent = [...events]
      .filter((event) => event.severity === "warn" || event.severity === "error")
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    const latestWaitingEvent = [...events]
      .filter((event) => event.type === "task.orchestration.waiting")
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    const latestWaitingPayload = latestWaitingEvent
      ? parsePayload(latestWaitingEvent.payloadJson)
      : null;
    const latestRecoveryTickPayload = latestRecoveryTick
      ? parsePayload(latestRecoveryTick.payloadJson)
      : null;
    const recoveryNotice = deriveTaskRecoveryNotice({
      taskState: task.state,
      latestRunId: latestRuntime?.id ?? null,
      events,
      latestRecoveryTickPayload,
      latestRecoveryTickAt: latestRecoveryTick?.occurredAt ?? null,
    });
    const blockedNarrative = deriveTaskBlockedNarrative({
      taskState: task.state,
      approvalState: latestApproval?.state ?? null,
      approvals: approvals.map((row) => ({ id: row.id, state: row.state })),
      recoveryNotice,
      events,
    });

    return {
      id: task.id,
      title: task.title,
      state: task.state,
      source: task.source,
      workspaceId: task.workspaceId,
      updatedAt: task.updatedAt,
      ...(task.rootChannelBindingId ? { rootChannelBindingId: task.rootChannelBindingId } : {}),
      // Goal mode (Ralph loop) — pass through verbatim. NULL
      // goalObjective signals "not a goal task" to the frontend.
      ...(task.goalObjective ? { goalObjective: task.goalObjective } : {}),
      ...(task.goalStatus ? { goalStatus: task.goalStatus as "active" | "paused" | "complete" | "cancelled" } : {}),
      ...(typeof task.goalStartedAt === "number" ? { goalStartedAt: task.goalStartedAt } : {}),
      ...(typeof task.goalMaxWallSeconds === "number" ? { goalMaxWallSeconds: task.goalMaxWallSeconds } : {}),
      ...(typeof task.goalIterations === "number" ? { goalIterations: task.goalIterations } : {}),
      ...(typeof task.goalTokensUsed === "number" ? { goalTokensUsed: task.goalTokensUsed } : {}),
      ...(typeof task.goalCompletedAt === "number" ? { goalCompletedAt: task.goalCompletedAt } : {}),
      ...(typeof task.goalId === "string" ? { goalId: task.goalId } : {}),
      ...(typeof task.goalTokenBudget === "number" ? { goalTokenBudget: task.goalTokenBudget } : {}),
      ...(typeof task.goalPlanPath === "string" ? { goalPlanPath: task.goalPlanPath } : {}),
      ...(task.goalLastVerifierVerdict === "READY" || task.goalLastVerifierVerdict === "BLOCKED"
        ? { goalLastVerifierVerdict: task.goalLastVerifierVerdict }
        : {}),
      ...(typeof task.goalLastVerifierAt === "number"
        ? { goalLastVerifierAt: task.goalLastVerifierAt }
        : {}),
      ...(typeof task.goalLastVerifierBlocker === "string"
        ? { goalLastVerifierBlocker: task.goalLastVerifierBlocker }
        : {}),
      // Project user subgoals so the GoalBanner can render them.
      // Parsed JIT to keep the store contract simple (string[] vs the JSON string on the row).
      ...(typeof task.goalSubgoals === "string" && task.goalSubgoals.length > 0
        ? { goalSubgoals: safeParseSubgoals(task.goalSubgoals) }
        : {}),
      // Project edit + parse-failure signals so the GoalBanner can surface
      // "objective just changed" and "evaluator parse-failure auto-pause" hints.
      ...(typeof task.goalObjectiveEditedAt === "number"
        ? { goalObjectiveEditedAt: task.goalObjectiveEditedAt }
        : {}),
      ...(typeof task.goalEvaluatorParseFailures === "number"
        ? { goalEvaluatorParseFailures: task.goalEvaluatorParseFailures }
        : {}),
      ...(task.attentionDismissedAt
        ? { attentionDismissedAt: task.attentionDismissedAt.getTime() }
        : {}),
      ...(latestRuntime ? { latestRunId: latestRuntime.id } : {}),
      ...(latestFailureEvent
        ? {
            latestBlocker:
              parseMessage(latestFailureEvent.payloadJson) ?? latestFailureEvent.type,
          }
        : {}),
      ...(latestApproval ? { approvalState: latestApproval.state } : {}),
      ...(latestArtifact
        ? {
            latestArtifactSummary: latestArtifact.summary ?? latestArtifact.title,
          }
        : {}),
      ...(latestArtifact?.artifactType === "pull_request" &&
      latestArtifact.storageKind === "url"
        ? { prUrl: latestArtifact.storageRef }
        : {}),
      ...(orchestration.latestAnswer ? { latestAnswer: orchestration.latestAnswer } : {}),
      ...(orchestration.managerPlan?.executionMode
        ? { executionMode: orchestration.managerPlan.executionMode }
        : readPayloadString(latestWaitingPayload, ["executionMode"])
          ? { executionMode: readPayloadString(latestWaitingPayload, ["executionMode"]) }
          : {}),
      ...(orchestration.nextCapability ? { nextCapability: orchestration.nextCapability } : {}),
      ...(readPayloadString(latestWaitingPayload, ["waitReason"])
        ? { waitReason: readPayloadString(latestWaitingPayload, ["waitReason"]) }
        : {}),
      ...(readPayloadString(latestWaitingPayload, ["nextWakeupAt"])
        ? { nextWakeupAt: readPayloadString(latestWaitingPayload, ["nextWakeupAt"]) }
        : {}),
      ...(recoveryNotice ? { recoveryNotice } : {}),
      ...(blockedNarrative ? { blockedNarrative } : {}),
      ...(typeof orchestration.managerPlan?.needsHuman === "boolean"
        ? { needsHuman: orchestration.managerPlan.needsHuman }
        : {}),
      ...(orchestration.managerPlan?.confidence
        ? {
            leaderConfidence: orchestration.managerPlan.confidence,
            managerConfidence: orchestration.managerPlan.confidence,
            plannerConfidence: orchestration.managerPlan.confidence,
          }
        : {}),
      ...(orchestration.managerPlan?.warnings?.length
        ? {
            leaderWarnings: orchestration.managerPlan.warnings,
            managerWarnings: orchestration.managerPlan.warnings,
            plannerWarnings: orchestration.managerPlan.warnings,
          }
        : {}),
    };
  }
}

/** Defensive JSON parse for tasks.goal_subgoals — returns an array
 *  of trimmed non-empty strings, or null when malformed. v3 §P0-2. */
function safeParseSubgoals(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}
