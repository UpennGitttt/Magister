import { readFile } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import type { RuntimeContextDocument } from "./build-runtime-context-document-service";

export type RuntimeContextProjection = {
  runtimeContextArtifactId: string | null;
  runtimeContextSummary: RuntimeContextDocument | null;
};

export async function getLatestRuntimeContextForRun(
  runId: string,
): Promise<RuntimeContextProjection> {
  const artifactRepository = new ArtifactRepository();
  const artifacts = await artifactRepository.listByRoleRuntimeId(runId);

  const runtimeContextArtifact = [...artifacts]
    .filter(
      (artifact) => artifact.storageKind === "file" && artifact.artifactType === "runtime_context",
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!runtimeContextArtifact) {
    return {
      runtimeContextArtifactId: null,
      runtimeContextSummary: null,
    };
  }

  try {
    const content = await readFile(runtimeContextArtifact.storageRef, "utf8");
    const parsed = JSON.parse(content) as RuntimeContextDocument;
    return {
      runtimeContextArtifactId: runtimeContextArtifact.id,
      runtimeContextSummary: parsed && typeof parsed === "object" ? parsed : null,
    };
  } catch {
    return {
      runtimeContextArtifactId: runtimeContextArtifact.id,
      runtimeContextSummary: null,
    };
  }
}
