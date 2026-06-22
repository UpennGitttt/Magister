import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getExecutorSlotList, type ExecutorSlotResource } from "./executor-slot-service";

type FailureInsight = {
  id: string;
  taskId?: string | null;
  runId?: string | null;
  roleId?: string | null;
  executorId?: string | null;
  summary: string;
  occurredAt: string;
};

type PullRequestInsight = {
  id: string;
  taskId: string;
  runId?: string | null;
  title: string;
  url: string;
  summary?: string;
  occurredAt: string;
};

type MemoryCandidateInsight = {
  id: string;
  taskId?: string | null;
  runId?: string | null;
  title: string;
  summary: string;
  scope: string;
  status: string;
  occurredAt: string;
};

export type WorkspaceInsights = {
  recentFailures: FailureInsight[];
  recentPullRequests: PullRequestInsight[];
  recentMemoryCandidates: MemoryCandidateInsight[];
  executorSlots: ExecutorSlotResource[];
};

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

export async function getWorkspaceInsights(): Promise<WorkspaceInsights> {
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const taskRepository = new TaskRepository();

  const [runtimes, artifactList, events, tasks] = await Promise.all([
    roleRuntimeRepository.listAll(),
    artifactRepository.listAll(),
    executionEventRepository.listAll(),
    taskRepository.listAll(),
  ]);
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const recentFailures: FailureInsight[] = events
    .filter((event) => event.severity === "error")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 5)
    .map((event) => {
      const runtime = event.roleRuntimeId ? runtimeById.get(event.roleRuntimeId) : undefined;
      const payload = parsePayload(event.payloadJson);
      const summary =
        typeof payload?.message === "string" && payload.message.length > 0
          ? payload.message
          : typeof payload?.error === "string" && payload.error.length > 0
            ? payload.error
            : event.type;

      return {
        id: event.id,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.roleRuntimeId ? { runId: event.roleRuntimeId } : {}),
        ...(runtime?.roleId ? { roleId: runtime.roleId } : {}),
        ...(runtime?.activeExecutorId ? { executorId: runtime.activeExecutorId } : {}),
        summary,
        occurredAt: event.occurredAt.toISOString(),
      };
    });

  const recentPullRequests: PullRequestInsight[] = artifactList
    .filter((artifact) => artifact.artifactType === "pull_request")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 5)
    .map((artifact) => {
      const summary = artifact.summary ?? taskById.get(artifact.taskId)?.title;
      return {
        id: artifact.id,
        taskId: artifact.taskId,
        ...(artifact.roleRuntimeId ? { runId: artifact.roleRuntimeId } : {}),
        title: artifact.title,
        url: artifact.storageRef,
        ...(summary ? { summary } : {}),
        occurredAt: artifact.createdAt.toISOString(),
      };
    });

  const recentMemoryCandidates: MemoryCandidateInsight[] = events
    .filter((event) => event.type === "memory.candidate_created")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 5)
    .map((event) => {
      const payload = parsePayload(event.payloadJson);
      return {
        id: event.id,
        taskId: event.taskId,
        runId: event.roleRuntimeId,
        title:
          typeof payload?.title === "string" && payload.title.length > 0
            ? payload.title
            : event.type,
        summary:
          typeof payload?.summary === "string" && payload.summary.length > 0
            ? payload.summary
            : "Memory candidate emitted by runtime",
        scope:
          typeof payload?.scope === "string" && payload.scope.length > 0
            ? payload.scope
            : "task",
        status:
          typeof payload?.status === "string" && payload.status.length > 0
            ? payload.status
            : "candidate",
        occurredAt: event.occurredAt.toISOString(),
      };
    });

  return {
    recentFailures,
    recentPullRequests,
    recentMemoryCandidates,
    executorSlots: await getExecutorSlotList(),
  };
}
