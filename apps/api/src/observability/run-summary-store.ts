import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import type { RunSummary } from "../services/materialize-run-summary-service";

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

export class RunSummaryStore {
  constructor(
    private readonly roleRuntimeRepository = new RoleRuntimeRepository(),
    private readonly executionEventRepository = new ExecutionEventRepository(),
    private readonly artifactRepository = new ArtifactRepository(),
  ) {}

  async get(runId: string): Promise<RunSummary | null> {
    const runtime = await this.roleRuntimeRepository.getById(runId);
    if (!runtime) {
      return null;
    }

    const [events, artifacts] = await Promise.all([
      this.executionEventRepository.listByRoleRuntimeId(runId),
      this.artifactRepository.listByRoleRuntimeId(runId),
    ]);

    const latestFailureEvent = [...events]
      .filter((event) => event.severity === "warn" || event.severity === "error")
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    const latestArtifact = [...artifacts].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];

    return {
      id: runtime.id,
      taskId: runtime.taskId,
      roleId: runtime.roleId,
      state: runtime.state,
      executorId: runtime.activeExecutorId,
      sessionId: runtime.currentSessionId,
      updatedAt: runtime.updatedAt,
      ...(latestFailureEvent
        ? {
            lastError:
              parseMessage(latestFailureEvent.payloadJson) ?? latestFailureEvent.type,
          }
        : {}),
      ...(latestArtifact
        ? {
            latestArtifactSummary: latestArtifact.summary ?? latestArtifact.title,
          }
        : {}),
    };
  }
}
