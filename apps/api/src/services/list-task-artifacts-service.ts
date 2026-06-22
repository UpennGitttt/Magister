import { ArtifactRepository } from "../repositories/artifact-repository";
import type { ArtifactLifecycle } from "./artifact-lifecycle-service";
import { getArtifactLifecycleMap } from "./artifact-lifecycle-service";
import type { ArtifactProvenance } from "./artifact-provenance-service";
import { getArtifactProvenanceMap } from "./artifact-provenance-service";

export type ArtifactResource = {
  id: string;
  taskId: string;
  roleRuntimeId?: string | null;
  artifactType: string;
  title: string;
  storageKind: string;
  storageRef: string;
  summary?: string | null;
  createdAt: string;
  provenance?: ArtifactProvenance | null;
  lifecycle?: ArtifactLifecycle | null;
};

export async function listTaskArtifacts(taskId: string): Promise<ArtifactResource[]> {
  const artifactRepository = new ArtifactRepository();
  const artifacts = await artifactRepository.listByTaskId(taskId);
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
