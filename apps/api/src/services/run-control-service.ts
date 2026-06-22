import { readFile } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getDefaultRoleRoutingForRole } from "../executors/executor-catalog";
import { dispatchRun, type DispatchRunResult } from "./dispatch-run-service";
import { resolveRuntimeContinuityPolicy } from "./runtime-continuity-service";
import { resumeLeaderFromCheckpoint as defaultResumeLeaderFromCheckpoint } from "./leader-session-resume-service";
import type { WorkspaceAllocationStrategy } from "./workspace-allocation-manager";

type ResumeLeaderFromCheckpointFn = typeof defaultResumeLeaderFromCheckpoint;

let resumeLeaderFromCheckpointImpl: ResumeLeaderFromCheckpointFn =
  defaultResumeLeaderFromCheckpoint;

/** For testing only — inject a stub implementation. */
export function setResumeLeaderFromCheckpointForTest(
  impl?: ResumeLeaderFromCheckpointFn,
): void {
  resumeLeaderFromCheckpointImpl = impl ?? defaultResumeLeaderFromCheckpoint;
}

export type RetryRunControlResult =
  | {
      ok: true;
      result: DispatchRunResult;
    }
  | {
      ok: false;
      code: "not_found" | "run_active";
      message: string;
    };

export type ContinueRunControlResult =
  | {
      ok: true;
      message: string;
    }
  | {
      ok: false;
      code: "not_found" | "run_active";
      message: string;
    };

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
        : typeof payload.runtimeWorkspaceDir === "string" && payload.runtimeWorkspaceDir.trim().length > 0
          ? payload.runtimeWorkspaceDir.trim()
          : null;

    return workspaceDir;
  } catch {
    return null;
  }
}

export async function retryRun(
  runId: string,
  options: {
    workspaceStrategyOverride?: WorkspaceAllocationStrategy | null;
  } = {},
): Promise<RetryRunControlResult> {
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const taskRepository = new TaskRepository();
  const observabilityAdapter = new LocalObservabilityAdapter();
  const runtime = await roleRuntimeRepository.getById(runId);
  if (!runtime) {
    return {
      ok: false,
      code: "not_found",
      message: `Run not found: ${runId}`,
    };
  }

  if (runtime.state === "RUNNING") {
    return {
      ok: false,
      code: "run_active",
      message: `Run ${runId} is already running and cannot be retried`,
    };
  }

  const task = await taskRepository.getById(runtime.taskId);
  if (!task) {
    return {
      ok: false,
      code: "not_found",
      message: `Task not found for run: ${runId}`,
    };
  }

  const retriedAt = new Date();
  const priorSessionId = runtime.currentSessionId ?? runtime.priorSessionId ?? null;
  const priorWorkdir = (await resolvePriorWorkdir(runtime.id)) ?? runtime.priorWorkdir ?? null;
  await roleRuntimeRepository.update(runtime.id, {
    state: "QUEUED",
    currentSessionId: null,
    priorSessionId,
    priorWorkdir,
    ...(Object.prototype.hasOwnProperty.call(options, "workspaceStrategyOverride")
      ? { workspaceStrategyOverride: options.workspaceStrategyOverride ?? null }
      : {}),
    resumePolicy: resolveRuntimeContinuityPolicy({
      adapterId:
        runtime.activeExecutorId ??
        getDefaultRoleRoutingForRole(runtime.roleId)?.adapterId ??
        null,
      priorSessionId,
    }),
    resumeAttemptedAt: null,
    resumeFailureReason: null,
    completedAt: null,
    updatedAt: retriedAt,
  });
  await taskRepository.update(task.id, {
    state: "IN_PROGRESS",
    updatedAt: retriedAt,
    completedAt: null,
  });
  await observabilityAdapter.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: "task.orchestration.transition",
    taskId: task.id,
    roleRuntimeId: runtime.id,
    workspaceId: task.workspaceId,
    severity: "info",
    occurredAt: retriedAt,
    payloadJson: JSON.stringify({
      message: `Manual retry requested for ${runtime.roleId}`,
      transition: "retry",
      reason: "manual_retry",
      action: "retry",
      state: "IN_PROGRESS",
      taskState: "IN_PROGRESS",
      roleId: runtime.roleId,
      runId: runtime.id,
    }),
  });

  const result = await dispatchRun(runtime.id);
  if (!result) {
    return {
      ok: false,
      code: "not_found",
      message: `Run not found after retry enqueue: ${runId}`,
    };
  }

  return {
    ok: true,
    result,
  };
}

export async function continueRun(runId: string): Promise<ContinueRunControlResult> {
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const taskRepository = new TaskRepository();

  const runtime = await roleRuntimeRepository.getById(runId);
  if (!runtime) {
    return {
      ok: false,
      code: "not_found",
      message: `Run not found: ${runId}`,
    };
  }

  if (runtime.state === "RUNNING") {
    return {
      ok: false,
      code: "run_active",
      message: `Run ${runId} is already running and cannot be continued`,
    };
  }

  const task = await taskRepository.getById(runtime.taskId);
  if (!task) {
    return {
      ok: false,
      code: "not_found",
      message: `Task not found for run: ${runId}`,
    };
  }

  const result = await resumeLeaderFromCheckpointImpl({
    taskId: runtime.taskId,
    runId,
    workspaceId: task.workspaceId,
  });

  if (result.ok) {
    return { ok: true, message: result.reason };
  }
  return { ok: false, code: "not_found" as const, message: result.reason };
}
