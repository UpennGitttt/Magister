type ArtifactSnapshot = {
  id: string;
  taskId: string;
  roleRuntimeId?: string | null;
  artifactType: string;
  createdAt: Date;
};

export type ArtifactLifecycle = {
  derivedFromArtifactId: string | null;
  retentionClass: "diagnostic" | "runtime" | "deliverable";
  status: "active" | "final" | "superseded";
  cleanupEligible: boolean;
};

function classifyRetentionClass(artifactType: string): ArtifactLifecycle["retentionClass"] {
  switch (artifactType) {
    case "execution_log":
      return "diagnostic";
    case "runtime_context":
    case "execution_metadata":
      return "runtime";
    default:
      return "deliverable";
  }
}

function buildArtifactGroupKey(artifact: ArtifactSnapshot) {
  return `${artifact.roleRuntimeId ?? artifact.taskId}:${artifact.artifactType}`;
}

function resolveDerivedFromArtifactId(
  artifact: ArtifactSnapshot,
  runtimeContextArtifacts: ArtifactSnapshot[],
) {
  if (artifact.artifactType === "runtime_context") {
    return null;
  }

  const candidate = [...runtimeContextArtifacts]
    .filter(
      (runtimeContextArtifact) =>
        runtimeContextArtifact.roleRuntimeId === artifact.roleRuntimeId &&
        runtimeContextArtifact.createdAt.getTime() <= artifact.createdAt.getTime(),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  return candidate?.id ?? null;
}

export function getArtifactLifecycleMap(
  artifacts: ArtifactSnapshot[],
): Map<string, ArtifactLifecycle> {
  const newestArtifactIdByGroup = new Map<string, string>();
  const runtimeContextArtifacts = artifacts.filter(
    (artifact) => artifact.artifactType === "runtime_context",
  );

  for (const artifact of [...artifacts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const groupKey = buildArtifactGroupKey(artifact);
    if (!newestArtifactIdByGroup.has(groupKey)) {
      newestArtifactIdByGroup.set(groupKey, artifact.id);
    }
  }

  return new Map(
    artifacts.map((artifact) => {
      const retentionClass = classifyRetentionClass(artifact.artifactType);
      const newestArtifactId = newestArtifactIdByGroup.get(buildArtifactGroupKey(artifact));
      const status: ArtifactLifecycle["status"] =
        retentionClass === "deliverable"
          ? "final"
          : newestArtifactId === artifact.id
            ? "active"
            : "superseded";

      const cleanupEligible =
        retentionClass === "diagnostic" ||
        (retentionClass === "runtime" && status === "superseded");

      return [
        artifact.id,
        {
          derivedFromArtifactId: resolveDerivedFromArtifactId(artifact, runtimeContextArtifacts),
          retentionClass,
          status,
          cleanupEligible,
        },
      ];
    }),
  );
}
