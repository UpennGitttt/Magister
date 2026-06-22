import { readFile } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { adapterSupportsNativeResume } from "./executor-capability-service";

const DEFAULT_LOOKBACK_TASK_LIMIT = 16;

function parseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function resolvePriorWorkdir(runId: string) {
  const artifactRepository = new ArtifactRepository();
  const artifacts = await artifactRepository.listByRoleRuntimeId(runId);
  const latestExecutionMetadataArtifact = [...artifacts]
    .filter(
      (artifact) =>
        artifact.storageKind === "file" && artifact.artifactType === "execution_metadata",
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!latestExecutionMetadataArtifact) {
    return null;
  }

  try {
    const content = await readFile(latestExecutionMetadataArtifact.storageRef, "utf8");
    const payload = parseJsonRecord(content);
    if (!payload) {
      return null;
    }

    const workspaceDir =
      typeof payload.workspaceDir === "string" && payload.workspaceDir.trim().length > 0
        ? payload.workspaceDir.trim()
        : typeof payload.runtimeWorkspaceDir === "string" &&
            payload.runtimeWorkspaceDir.trim().length > 0
          ? payload.runtimeWorkspaceDir.trim()
          : null;

    return workspaceDir;
  } catch {
    return null;
  }
}

export type RuntimeContinuitySeed = {
  sourceTaskId: string;
  sourceRunId: string;
  priorSessionId: string;
  priorWorkdir: string | null;
  sourceState: string;
  sourceUpdatedAt: Date;
};

export type RuntimeContinuityPolicy = "resume_first" | "rehydrate_only";

export type RuntimeContinuityDecision = {
  source: "control_plane";
  decisionSource: "runtime-continuity-service";
  policy: RuntimeContinuityPolicy;
  adapterId: string | null;
  priorSessionId: string;
  priorWorkdir: string | null;
  adapterSupportsResume: boolean;
  nativeResumeAttempted: boolean;
  fallbackToFresh: boolean;
  reason: string;
};

export function resolveRuntimeContinuityPolicy(input: {
  adapterId?: string | null;
  priorSessionId?: string | null;
}): RuntimeContinuityPolicy | null {
  const priorSessionId = input.priorSessionId?.trim();
  if (!priorSessionId) {
    return null;
  }

  return adapterSupportsNativeResume(input.adapterId) ? "resume_first" : "rehydrate_only";
}

export function resolveRuntimeContinuityDecision(input: {
  adapterId?: string | null;
  priorSessionId?: string | null;
  priorWorkdir?: string | null;
  resumePolicy?: RuntimeContinuityPolicy | null;
  nativeResumeAttempted?: boolean;
  resumeFailureReason?: string | null;
}): RuntimeContinuityDecision | null {
  const priorSessionId = input.priorSessionId?.trim();
  const policy = input.resumePolicy;
  if (!priorSessionId || (policy !== "resume_first" && policy !== "rehydrate_only")) {
    return null;
  }

  const adapterId = input.adapterId?.trim() ?? null;
  const adapterSupportsResume = adapterSupportsNativeResume(adapterId);
  const nativeResumeAttempted =
    typeof input.nativeResumeAttempted === "boolean"
      ? input.nativeResumeAttempted
      : policy === "resume_first" && adapterSupportsResume;
  const reason =
    input.resumeFailureReason?.trim() ??
    (policy === "rehydrate_only"
      ? "rehydrate_only"
      : adapterSupportsResume
        ? "resume_requested"
        : `resume_not_supported_for_${adapterId ?? "unknown"}`);

  return {
    source: "control_plane",
    decisionSource: "runtime-continuity-service",
    policy,
    adapterId,
    priorSessionId,
    priorWorkdir: input.priorWorkdir?.trim() ?? null,
    adapterSupportsResume,
    nativeResumeAttempted,
    fallbackToFresh: policy === "resume_first",
    reason,
  };
}

export async function resolveRuntimeContinuitySeedForRole(input: {
  workspaceId: string;
  roleId: string;
  rootChannelBindingId?: string | null;
  excludeTaskId?: string;
  lookbackTaskLimit?: number;
}) {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const lookbackLimit = input.lookbackTaskLimit ?? DEFAULT_LOOKBACK_TASK_LIMIT;

  const recentTasks = input.rootChannelBindingId
    ? await taskRepository.listRecentByRootChannelBindingId(input.rootChannelBindingId, {
        limit: lookbackLimit,
        ...(input.excludeTaskId ? { excludeTaskId: input.excludeTaskId } : {}),
      })
    : (await taskRepository.listRecentByWorkspaceId(input.workspaceId, lookbackLimit + 1))
        .filter((task) => task.id !== input.excludeTaskId)
        .slice(0, lookbackLimit);

  if (recentTasks.length === 0) {
    return null;
  }

  const recentTaskIdSet = new Set(recentTasks.map((task) => task.id));
  const candidateRuntimes = (await roleRuntimeRepository.listAll())
    .filter(
      (runtime) =>
        runtime.roleId === input.roleId &&
        recentTaskIdSet.has(runtime.taskId) &&
        runtime.state !== "CREATED" &&
        runtime.state !== "QUEUED",
    )
    .filter((runtime) => {
      const sessionId = runtime.currentSessionId?.trim() ?? runtime.priorSessionId?.trim();
      return Boolean(sessionId);
    })
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const sourceRuntime = candidateRuntimes[0];
  if (!sourceRuntime) {
    return null;
  }

  const sessionId = sourceRuntime.currentSessionId?.trim() ?? sourceRuntime.priorSessionId?.trim();
  if (!sessionId) {
    return null;
  }

  const priorWorkdir =
    (await resolvePriorWorkdir(sourceRuntime.id)) ?? sourceRuntime.priorWorkdir ?? null;

  return {
    sourceTaskId: sourceRuntime.taskId,
    sourceRunId: sourceRuntime.id,
    priorSessionId: sessionId,
    priorWorkdir,
    sourceState: sourceRuntime.state,
    sourceUpdatedAt: sourceRuntime.updatedAt,
  } satisfies RuntimeContinuitySeed;
}
