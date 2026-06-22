import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";

type MemoryLink = {
  slot: string;
  summary: string;
  sourceType: "task" | "artifact" | "event";
  sourceId: string;
};

type MemoryCandidate = {
  id: string;
  title: string;
  summary: string;
  scope: string;
  status: string;
  sourceRunId?: string | null;
};

export type TaskMemoryView = {
  linkedMemories: {
    project: MemoryLink[];
    repo: MemoryLink[];
    task: MemoryLink[];
  };
  candidates: MemoryCandidate[];
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

export async function getTaskMemoryView(taskId: string): Promise<TaskMemoryView | null> {
  const taskRepository = new TaskRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const [task, artifacts, events] = await Promise.all([
    taskRepository.getById(taskId),
    artifactRepository.listByTaskId(taskId),
    executionEventRepository.listByTaskId(taskId),
  ]);

  if (!task) {
    return null;
  }

  const taskLinks: MemoryLink[] = [
    {
      slot: "task_brief",
      summary: task.description ?? task.title,
      sourceType: "task",
      sourceId: task.id,
    },
  ];

  const projectLinks: MemoryLink[] = artifacts
    .slice(0, 2)
    .map((artifact) => ({
      slot: "linked_artifact",
      summary: artifact.summary ?? artifact.title,
      sourceType: "artifact" as const,
      sourceId: artifact.id,
    }));

  const repoLinks: MemoryLink[] = [];

  const candidates: MemoryCandidate[] = events
    .filter((event) => event.type === "memory.candidate_created")
    .map((event) => {
      const payload = parsePayload(event.payloadJson);
      return {
        id: event.id,
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
        sourceRunId: event.roleRuntimeId,
      };
    });

  return {
    linkedMemories: {
      project: projectLinks,
      repo: repoLinks,
      task: taskLinks,
    },
    candidates,
  };
}
