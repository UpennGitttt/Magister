import { rm } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import { getArtifactLifecycleMap } from "./artifact-lifecycle-service";

type CleanupArtifactsResult = {
  scope: "run" | "task";
  runId?: string;
  taskId?: string;
  deletedCount: number;
  deletedArtifactIds: string[];
  keptArtifactIds: string[];
};

async function removeArtifactFiles(
  artifacts: Array<{
    storageKind: string;
    storageRef: string;
  }>,
) {
  await Promise.all(
    artifacts.map(async (artifact) => {
      if (artifact.storageKind !== "file") {
        return;
      }

      try {
        await rm(artifact.storageRef, { force: true });
      } catch {
        // Keep cleanup best-effort. DB deletion is the authoritative removal step.
      }
    }),
  );
}

async function cleanupArtifacts(
  scope: "run" | "task",
  identifier: string,
  listArtifacts: () => ReturnType<ArtifactRepository["listByTaskId"]>,
): Promise<CleanupArtifactsResult> {
  const artifactRepository = new ArtifactRepository();
  const artifacts = await listArtifacts();
  const lifecycleMap = getArtifactLifecycleMap(artifacts);

  const deletableArtifacts = artifacts.filter(
    (artifact) => lifecycleMap.get(artifact.id)?.cleanupEligible,
  );
  const keptArtifacts = artifacts.filter(
    (artifact) => !lifecycleMap.get(artifact.id)?.cleanupEligible,
  );

  await removeArtifactFiles(deletableArtifacts);
  await artifactRepository.deleteByIds(deletableArtifacts.map((artifact) => artifact.id));

  return {
    scope,
    ...(scope === "run" ? { runId: identifier } : { taskId: identifier }),
    deletedCount: deletableArtifacts.length,
    deletedArtifactIds: deletableArtifacts.map((artifact) => artifact.id),
    keptArtifactIds: keptArtifacts.map((artifact) => artifact.id),
  };
}

export async function cleanupRunArtifacts(runId: string): Promise<CleanupArtifactsResult> {
  const artifactRepository = new ArtifactRepository();
  return await cleanupArtifacts("run", runId, () => artifactRepository.listByRoleRuntimeId(runId));
}

export async function cleanupTaskArtifacts(taskId: string): Promise<CleanupArtifactsResult> {
  const artifactRepository = new ArtifactRepository();
  return await cleanupArtifacts("task", taskId, () => artifactRepository.listByTaskId(taskId));
}
