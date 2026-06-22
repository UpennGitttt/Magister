import { ArtifactRepository } from "../repositories/artifact-repository";

import { getArtifactLifecycleMap } from "./artifact-lifecycle-service";
import type { ArtifactResource } from "./list-task-artifacts-service";
import { getArtifactProvenanceMap } from "./artifact-provenance-service";

export async function listRunArtifacts(runId: string): Promise<ArtifactResource[]> {
  const artifactRepository = new ArtifactRepository();
  const artifacts = await artifactRepository.listByRoleRuntimeId(runId);
  const artifactProvenance = await getArtifactProvenanceMap(artifacts.map((artifact) => artifact.id));
  const artifactLifecycle = getArtifactLifecycleMap(artifacts);

  return artifacts
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((artifact) => ({
      id: artifact.id,
      taskId: artifact.taskId,
      roleRuntimeId: artifact.roleRuntimeId,
      artifactType: artifact.artifactType,
      title: artifact.title,
      storageKind: artifact.storageKind,
      storageRef: artifact.storageRef,
      summary: artifact.summary,
      createdAt: artifact.createdAt.toISOString(),
      provenance: artifactProvenance.get(artifact.id) ?? null,
      lifecycle: artifactLifecycle.get(artifact.id) ?? null,
    }));
}
