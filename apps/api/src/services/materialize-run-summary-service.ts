import { readFile } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import { RunSummaryStore } from "../observability/run-summary-store";
import {
  extractManagerDecisionOutput,
  type ManagerDecisionExtraction,
  type ManagerDecisionFallbackReason,
  type ManagerDecisionSourceKind,
} from "./manager-decision-service";

export type ManagerDecisionSummary = ManagerDecisionExtraction & {
  sourceArtifactId: string;
  sourceArtifactType: string;
  sourceArtifactTitle: string;
  sourceArtifactSummary: string | null;
};

export type RunSummary = {
  id: string;
  taskId: string;
  roleId: string;
  state: string;
  executorId?: string | null;
  sessionId?: string | null;
  lastError?: string;
  latestArtifactSummary?: string;
  leaderDecision?: ManagerDecisionSummary | null;
  managerDecision?: ManagerDecisionSummary | null;
  updatedAt: Date;
};

const MANAGER_DECISION_ARTIFACT_TYPES = new Set(["plan", "execution_note", "review"]);

type ManagerDecisionArtifactText = {
  rawOutput: string | null;
  sourceKind: ManagerDecisionSourceKind;
  sourceDegraded: boolean;
  sourceUnavailableReason: "artifact_file_unreadable" | null;
  fallbackReason: ManagerDecisionFallbackReason | null;
};

async function readManagerDecisionArtifactText(input: {
  storageKind: string;
  storageRef: string;
  summary?: string | null;
  title: string;
}): Promise<ManagerDecisionArtifactText> {
  if (input.storageKind === "file") {
    try {
      return {
        rawOutput: (await readFile(input.storageRef, "utf8")).trim() || null,
        sourceKind: "artifact_file",
        sourceDegraded: false,
        sourceUnavailableReason: null,
        fallbackReason: null,
      };
    } catch {
      // Fall through to degraded metadata-only fallback.
    }
  }

  const summary = input.summary?.trim();
  if (summary) {
    return {
      rawOutput: summary,
      sourceKind: "artifact_summary",
      sourceDegraded: true,
      sourceUnavailableReason: "artifact_file_unreadable",
      fallbackReason: "artifact_file_unreadable",
    };
  }

  const title = input.title.trim();
  return {
    rawOutput: title.length > 0 ? title : null,
    sourceKind: "artifact_title",
    sourceDegraded: true,
    sourceUnavailableReason: "artifact_file_unreadable",
    fallbackReason: "artifact_file_unreadable",
  };
}

function isManagerDecisionArtifact(artifact: { artifactType: string }) {
  return MANAGER_DECISION_ARTIFACT_TYPES.has(artifact.artifactType);
}

async function materializeManagerDecision(input: {
  runId: string;
  roleId: string;
}): Promise<ManagerDecisionSummary | null> {
  if (input.roleId !== "leader") {
    return null;
  }

  const artifactRepository = new ArtifactRepository();
  const artifacts = await artifactRepository.listByRoleRuntimeId(input.runId);
  const candidateArtifact = [...artifacts]
    .filter(isManagerDecisionArtifact)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!candidateArtifact) {
    return null;
  }

  const artifactText = await readManagerDecisionArtifactText({
    storageKind: candidateArtifact.storageKind,
    storageRef: candidateArtifact.storageRef,
    summary: candidateArtifact.summary,
    title: candidateArtifact.title,
  });

  const extraction =
    artifactText.sourceKind === "artifact_file"
      ? extractManagerDecisionOutput(artifactText.rawOutput)
      : {
          parsedDecision: null,
          rawOutput: artifactText.rawOutput,
          fallbackReason: artifactText.fallbackReason,
          sourceKind: artifactText.sourceKind,
          sourceDegraded: artifactText.sourceDegraded,
          sourceUnavailableReason: artifactText.sourceUnavailableReason,
        };

  return {
    ...extraction,
    sourceArtifactId: candidateArtifact.id,
    sourceArtifactType: candidateArtifact.artifactType,
    sourceArtifactTitle: candidateArtifact.title,
    sourceArtifactSummary: candidateArtifact.summary ?? null,
  };
}

export async function materializeRunSummary(runId: string): Promise<RunSummary | null> {
  const runSummaryStore = new RunSummaryStore();
  const summary = await runSummaryStore.get(runId);

  if (!summary) {
    return null;
  }

  const managerDecision = await materializeManagerDecision({
    runId: summary.id,
    roleId: summary.roleId,
  });

  return {
    ...summary,
    ...(managerDecision
      ? {
          leaderDecision: managerDecision,
          managerDecision,
        }
      : {}),
  };
}
