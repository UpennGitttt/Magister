import { ExecutionEventRepository } from "../repositories/execution-event-repository";

export type ArtifactProvenance = {
  sourceEventId: string;
  sourceEventType: string;
  sourceRoleRuntimeId: string | null;
  sourceExecutorSessionId: string | null;
  sourceWorkspaceId: string | null;
  sourceOccurredAt: string;
  source: string | null;
};

function parsePayloadSource(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadJson) as { source?: unknown };
    return typeof payload.source === "string" && payload.source.trim().length > 0
      ? payload.source.trim()
      : null;
  } catch {
    return null;
  }
}

export async function getArtifactProvenanceMap(
  artifactIds: string[],
): Promise<Map<string, ArtifactProvenance>> {
  const executionEventRepository = new ExecutionEventRepository();
  const events = await executionEventRepository.listByArtifactIds(artifactIds);
  const provenanceByArtifactId = new Map<string, ArtifactProvenance>();

  for (const event of [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const artifactId = event.artifactId?.trim();
    if (!artifactId || provenanceByArtifactId.has(artifactId)) {
      continue;
    }

    provenanceByArtifactId.set(artifactId, {
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceRoleRuntimeId: event.roleRuntimeId ?? null,
      sourceExecutorSessionId: event.executorSessionId ?? null,
      sourceWorkspaceId: event.workspaceId ?? null,
      sourceOccurredAt: event.occurredAt.toISOString(),
      source: parsePayloadSource(event.payloadJson),
    });
  }

  return provenanceByArtifactId;
}
