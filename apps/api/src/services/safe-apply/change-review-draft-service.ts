import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactInsert, ExecutionEventInsert } from "@magister/db";

import type {
  ChangeReviewDraft,
  McpToolRisk,
  RuntimeDiffArtifact,
  RuntimeSecurityMetadata,
  SastAdvisoryResult,
  SideEffectWarning,
  StaticGateResult,
  VerificationEvidence,
} from "./safe-apply-types";

type ArtifactRepositoryLike = {
  create(input: ArtifactInsert): Promise<unknown>;
};

type ExecutionEventRepositoryLike = {
  create(input: ExecutionEventInsert): Promise<unknown>;
};

export async function createChangeReviewDraft(input: {
  taskId: string;
  roleRuntimeId: string | null;
  workspaceId: string;
  runtimeSecurity: RuntimeSecurityMetadata;
  diffArtifact: RuntimeDiffArtifact;
  gate: StaticGateResult;
  mcpToolRisk?: McpToolRisk[];
  sastAdvisory?: SastAdvisoryResult | null;
  sideEffectWarning: SideEffectWarning | null;
  verification: VerificationEvidence[];
  artifactsDir: string;
  createId?: () => string;
  now?: () => Date;
  artifactRepository: ArtifactRepositoryLike;
  executionEventRepository: ExecutionEventRepositoryLike;
}) {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const now = input.now ?? (() => new Date());
  const createdAt = now();
  await mkdir(input.artifactsDir, { recursive: true });

  const gateArtifactId = `artifact_${createId()}`;
  const reviewDraftArtifactId = `artifact_${createId()}`;
  const gatePath = join(input.artifactsDir, `${gateArtifactId}.json`);
  const draftPath = join(input.artifactsDir, `${reviewDraftArtifactId}.json`);
  const draft: ChangeReviewDraft = {
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    workspaceId: input.workspaceId,
    runtimeSecurity: input.runtimeSecurity,
    diffArtifact: input.diffArtifact,
    gate: input.gate,
    mcpToolRisk: input.mcpToolRisk ?? [],
    sastAdvisory: input.sastAdvisory ?? null,
    sideEffectWarning: input.sideEffectWarning,
    verification: input.verification,
  };

  await writeFile(gatePath, JSON.stringify(input.gate, null, 2), "utf8");
  await writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");

  await input.artifactRepository.create({
    id: input.diffArtifact.artifactId,
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    artifactType: "runtime_diff",
    title: "Runtime diff",
    storageKind: "file",
    storageRef: input.diffArtifact.storageRef,
    summary: `Diff: ${input.diffArtifact.changedFiles.length} files, +${input.diffArtifact.addedLines} -${input.diffArtifact.removedLines}, sha256:${input.diffArtifact.diffHash.slice(0, 12)}`,
    createdAt,
  } satisfies ArtifactInsert);

  await input.artifactRepository.create({
    id: gateArtifactId,
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    artifactType: "static_gate_result",
    title: "Static gate result",
    storageKind: "file",
    storageRef: gatePath,
    summary: `Static Gate: ${input.gate.risk}${input.gate.reasons.length > 0 ? ` (${input.gate.reasons.length} reasons)` : ""}`,
    createdAt,
  } satisfies ArtifactInsert);

  await input.artifactRepository.create({
    id: reviewDraftArtifactId,
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    artifactType: "change_review_draft",
    title: "Change review draft",
    storageKind: "file",
    storageRef: draftPath,
    summary: `Change Review Draft: ${input.gate.risk}, sha256:${input.diffArtifact.diffHash.slice(0, 12)}`,
    createdAt,
  } satisfies ArtifactInsert);

  const eventPayload = {
    message: `Safe Apply review draft created: ${input.gate.risk}`,
    diffArtifactId: input.diffArtifact.artifactId,
    gateArtifactId,
    reviewDraftArtifactId,
    risk: input.gate.risk,
    reasonCodes: input.gate.reasons.map((item) => item.code),
    diffHash: input.diffArtifact.diffHash,
    changedFiles: input.diffArtifact.changedFiles.length,
    addedLines: input.diffArtifact.addedLines,
    removedLines: input.diffArtifact.removedLines,
    mcpToolRiskCount: draft.mcpToolRisk.length,
    sastAdvisoryStatus: draft.sastAdvisory?.status ?? null,
    sastFindingCount: draft.sastAdvisory?.findings.length ?? 0,
    sideEffectWarning: input.sideEffectWarning?.code ?? null,
  };

  await input.executionEventRepository.create({
    id: `event_${createId()}`,
    type: "safe_apply.review_draft_created",
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    workspaceId: input.workspaceId,
    artifactId: reviewDraftArtifactId,
    severity: input.gate.risk === "HUMAN_REQUIRED" ? "warn" : "info",
    payloadJson: JSON.stringify(eventPayload),
    occurredAt: createdAt,
  } satisfies ExecutionEventInsert);

  return {
    draft,
    artifactIds: {
      diffArtifactId: input.diffArtifact.artifactId,
      gateArtifactId,
      reviewDraftArtifactId,
    },
  };
}
