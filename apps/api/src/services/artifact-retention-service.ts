import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getArtifactLifecycleMap } from "./artifact-lifecycle-service";
import { cleanupTaskArtifacts } from "./cleanup-artifacts-service";

const DEFAULT_RETENTION_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_GRACE_MS = 60_000;

type RetentionNow = () => Date;
type RetentionCleanupTaskArtifacts = typeof cleanupTaskArtifacts;

export type ArtifactRetentionTickResult = {
  scannedTaskCount: number;
  eligibleTaskCount: number;
  cleanedTaskIds: string[];
  deletedArtifactIds: string[];
  failedTaskIds: string[];
};

export type ArtifactRetentionStatus = {
  enabled: boolean;
  inFlight: boolean;
  intervalMs: number;
  graceMs: number;
  lastTickAt: string | null;
  lastWindowStart: string | null;
  lastScannedTaskCount: number;
  lastEligibleTaskCount: number;
  lastCleanedTaskIds: string[];
  lastDeletedArtifactIds: string[];
  lastFailedTaskIds: string[];
  lastFailureAt: string | null;
  lastFailureTaskId: string | null;
  lastFailureMessage: string | null;
};

type ArtifactRetentionDependencies = {
  now?: RetentionNow;
  taskRepository?: TaskRepository;
  artifactRepository?: ArtifactRepository;
  executionEventRepository?: ExecutionEventRepository;
  observabilityAdapter?: LocalObservabilityAdapter;
  cleanupTaskArtifacts?: RetentionCleanupTaskArtifacts;
};

let retentionLoopTimer: ReturnType<typeof setInterval> | null = null;
let retentionLoopInFlight = false;

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

function isArtifactRetentionEnabled() {
  return parseBoolean(process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED, false);
}

function getArtifactRetentionIntervalMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS,
    DEFAULT_RETENTION_INTERVAL_MS,
  );
}

function getArtifactRetentionGraceMs() {
  return parsePositiveInteger(
    process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS,
    DEFAULT_RETENTION_GRACE_MS,
  );
}

function buildEventId(prefix: string) {
  return `event_${prefix}_${crypto.randomUUID()}`;
}

function isPastRetentionGrace(updatedAt: Date, now: Date) {
  return now.getTime() - updatedAt.getTime() >= getArtifactRetentionGraceMs();
}

function resolveRetentionCheckpointWindowStart(
  latestTickAt: Date | null,
): Date | undefined {
  if (!latestTickAt) {
    return undefined;
  }

  return new Date(latestTickAt.getTime() - getArtifactRetentionGraceMs());
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

function readString(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function readStringArray(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export async function getArtifactRetentionStatus(
  executionEventRepository = new ExecutionEventRepository(),
): Promise<ArtifactRetentionStatus> {
  const latestTickEvent = await executionEventRepository.getLatestByType(
    "worker.artifact_retention.tick",
  );
  const latestFailureEvent = await executionEventRepository.getLatestByType(
    "worker.artifact_retention.failed",
  );
  const payload = parsePayload(latestTickEvent?.payloadJson);
  const failurePayload = parsePayload(latestFailureEvent?.payloadJson);

  return {
    enabled: isArtifactRetentionEnabled(),
    inFlight: retentionLoopInFlight,
    intervalMs: getArtifactRetentionIntervalMs(),
    graceMs: getArtifactRetentionGraceMs(),
    lastTickAt: latestTickEvent?.occurredAt.toISOString() ?? null,
    lastWindowStart: readString(payload, "windowStart"),
    lastScannedTaskCount: readNumber(payload, "scannedTaskCount"),
    lastEligibleTaskCount: readNumber(payload, "eligibleTaskCount"),
    lastCleanedTaskIds: readStringArray(payload, "cleanedTaskIds"),
    lastDeletedArtifactIds: readStringArray(payload, "deletedArtifactIds"),
    lastFailedTaskIds: readStringArray(payload, "failedTaskIds"),
    lastFailureAt: latestFailureEvent?.occurredAt.toISOString() ?? null,
    lastFailureTaskId:
      latestFailureEvent?.taskId ?? readString(failurePayload, "failedTaskId"),
    lastFailureMessage:
      readString(failurePayload, "error") ?? readString(failurePayload, "message"),
  };
}

export async function runArtifactRetentionTick(
  dependencies: ArtifactRetentionDependencies = {},
): Promise<ArtifactRetentionTickResult> {
  const now = dependencies.now ?? (() => new Date());
  const taskRepository = dependencies.taskRepository ?? new TaskRepository();
  const artifactRepository = dependencies.artifactRepository ?? new ArtifactRepository();
  const executionEventRepository =
    dependencies.executionEventRepository ?? new ExecutionEventRepository();
  const observabilityAdapter =
    dependencies.observabilityAdapter ?? new LocalObservabilityAdapter();
  const cleanupTaskArtifactsFn =
    dependencies.cleanupTaskArtifacts ?? cleanupTaskArtifacts;

  const tickStartedAt = now();
  const latestTickEvent = await executionEventRepository.getLatestByType(
    "worker.artifact_retention.tick",
  );
  const windowStart = resolveRetentionCheckpointWindowStart(latestTickEvent?.occurredAt ?? null);
  const terminalTasks = await taskRepository.listTerminalUpdatedSince(windowStart);
  const eligibleTasks = terminalTasks.filter((task) =>
    isPastRetentionGrace(task.updatedAt, tickStartedAt),
  );

  const cleanedTaskIds: string[] = [];
  const deletedArtifactIds: string[] = [];
  const failedTaskIds: string[] = [];
  for (const task of eligibleTasks) {
    const artifacts = await artifactRepository.listByTaskId(task.id);
    const lifecycleMap = getArtifactLifecycleMap(artifacts);
    const hasCleanupEligibleArtifacts = artifacts.some(
      (artifact) => lifecycleMap.get(artifact.id)?.cleanupEligible,
    );
    if (!hasCleanupEligibleArtifacts) {
      continue;
    }

    let cleanupResult;
    try {
      cleanupResult = await cleanupTaskArtifactsFn(task.id);
    } catch (error) {
      failedTaskIds.push(task.id);
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Artifact retention cleanup failed";
      await observabilityAdapter.recordEvent({
        id: buildEventId("artifact_retention_failed"),
        type: "worker.artifact_retention.failed",
        taskId: task.id,
        workspaceId: task.workspaceId,
        severity: "error",
        occurredAt: tickStartedAt,
        payloadJson: JSON.stringify({
          message: `Artifact retention failed for task ${task.id}`,
          action: "cleanup",
          trigger: "artifact_retention_worker",
          failedTaskId: task.id,
          error: message,
          taskState: task.state,
        }),
      });
      continue;
    }

    if (cleanupResult.deletedCount === 0) {
      continue;
    }

    cleanedTaskIds.push(task.id);
    deletedArtifactIds.push(...cleanupResult.deletedArtifactIds);
    await observabilityAdapter.recordEvent({
      id: buildEventId("artifact_retention_cleanup"),
      type: "task.artifacts.cleaned",
      taskId: task.id,
      workspaceId: task.workspaceId,
      severity: "info",
      occurredAt: tickStartedAt,
      payloadJson: JSON.stringify({
        message: `Artifact retention cleaned ${cleanupResult.deletedCount} artifact(s) for task ${task.id}`,
        action: "cleanup",
        scope: cleanupResult.scope,
        taskState: task.state,
        deletedCount: cleanupResult.deletedCount,
        deletedArtifactIds: cleanupResult.deletedArtifactIds,
        keptArtifactIds: cleanupResult.keptArtifactIds,
        trigger: "artifact_retention_worker",
      }),
    });
  }

  await observabilityAdapter.recordEvent({
    id: buildEventId("artifact_retention_tick"),
    type: "worker.artifact_retention.tick",
    severity: "info",
    occurredAt: tickStartedAt,
    payloadJson: JSON.stringify({
      message: `Artifact retention scanned ${terminalTasks.length} terminal task(s) and cleaned ${cleanedTaskIds.length}`,
      action: "scan",
      trigger: "artifact_retention_worker",
      windowStart: windowStart?.toISOString() ?? null,
      windowEnd: tickStartedAt.toISOString(),
      scannedTaskCount: terminalTasks.length,
      eligibleTaskCount: eligibleTasks.length,
      cleanedTaskIds,
      deletedArtifactIds,
      failedTaskIds,
    }),
  });

  return {
    scannedTaskCount: terminalTasks.length,
    eligibleTaskCount: eligibleTasks.length,
    cleanedTaskIds,
    deletedArtifactIds,
    failedTaskIds,
  };
}

export async function startArtifactRetentionLoop() {
  if (!isArtifactRetentionEnabled()) {
    return;
  }

  if (retentionLoopTimer) {
    return;
  }

  const runTick = async () => {
    if (retentionLoopInFlight) {
      return;
    }

    retentionLoopInFlight = true;
    try {
      await runArtifactRetentionTick();
    } finally {
      retentionLoopInFlight = false;
    }
  };

  await runTick();
  retentionLoopTimer = setInterval(() => {
    void runTick();
  }, getArtifactRetentionIntervalMs());
}

export async function stopArtifactRetentionLoop() {
  if (!retentionLoopTimer) {
    return;
  }

  clearInterval(retentionLoopTimer);
  retentionLoopTimer = null;
}
