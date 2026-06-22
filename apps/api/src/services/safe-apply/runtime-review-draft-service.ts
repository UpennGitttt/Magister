import { join } from "node:path";

import { ArtifactRepository } from "../../repositories/artifact-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import { TaskRepository } from "../../repositories/task-repository";
import type { LeaderLoopEvent } from "../manager-automation/autonomous-loop/autonomous-types";
import { buildObservedSideEffectEvidence } from "./side-effect-evidence-service";
import { createChangeReviewDraft } from "./change-review-draft-service";
import { materializeChangeReviewFromDraftBestEffort } from "./change-review-state-service";
import { buildMcpToolRisk } from "./mcp-tool-risk-service";
import { collectRuntimeDiff } from "./runtime-diff-service";
import { runSastAdvisory } from "./sast-advisory-service";
import { classifyStaticGate } from "./static-gate-service";
import type { RuntimeSecurityMetadata } from "./safe-apply-types";

export type RuntimeSafeApplyReviewDraftResult =
  | {
      created: false;
      reason: "not_git_worktree" | "empty_diff_without_side_effects";
    }
  | {
      created: true;
      diffArtifactId: string;
      gateArtifactId: string;
      reviewDraftArtifactId: string;
    };

export function buildUcmRuntimeSecurity(input: {
  runtimeWorkspaceStrategy: RuntimeSecurityMetadata["runtimeWorkspaceStrategy"];
  permissionSignals?: string[];
  executionSandbox?: RuntimeSecurityMetadata["executionSandbox"];
}): RuntimeSecurityMetadata {
  return {
    runtimeSource: "ucm",
    commandPath: null,
    argvFlags: [],
    sandboxMode: null,
    permissionMode: "interactive",
    permissionSignals: input.permissionSignals ?? ["magister:tool-permission-hooks"],
    envPermissionHints: [],
    runtimeWorkspaceStrategy: input.runtimeWorkspaceStrategy,
    executionSandbox: input.executionSandbox ?? null,
  };
}

export async function createRuntimeSafeApplyReviewDraft(input: {
  taskId: string;
  roleRuntimeId: string;
  parentWorkspaceDir: string;
  runtimeWorkspaceDir: string;
  baseRevision: string | null;
  runtimeSecurity: RuntimeSecurityMetadata;
  observedEvents: readonly LeaderLoopEvent[];
}): Promise<RuntimeSafeApplyReviewDraftResult> {
  if (input.runtimeSecurity.runtimeWorkspaceStrategy !== "git_worktree") {
    return { created: false, reason: "not_git_worktree" };
  }

  const task = await new TaskRepository().getById(input.taskId).catch(() => null);
  const workspaceId = task?.workspaceId || "default";
  const artifactsDir = join(
    input.parentWorkspaceDir,
    ".magister",
    "safe-apply",
    input.taskId,
    input.roleRuntimeId,
  );
  const createId = () => crypto.randomUUID();
  const observedSideEffectEvidence = buildObservedSideEffectEvidence(input.observedEvents);
  const observedSideEffectEventTypes = observedSideEffectEvidence.eventTypes;
  const completedAt = new Date();
  const diffArtifact = await collectRuntimeDiff({
    workspaceDir: input.runtimeWorkspaceDir,
    artifactsDir,
    artifactId: `artifact_${createId()}`,
    baseRevision: input.baseRevision,
  });
  if (diffArtifact.isEmpty && observedSideEffectEventTypes.length === 0) {
    return { created: false, reason: "empty_diff_without_side_effects" };
  }

  const mcpToolRisk = await buildMcpToolRisk(input.observedEvents);
  const sastAdvisory = await runSastAdvisory({
    workspaceDir: input.runtimeWorkspaceDir,
    diffArtifact,
  });

  const gate = await classifyStaticGate({
    runtimeSecurity: input.runtimeSecurity,
    diffArtifact,
    verification: [],
    observedSideEffectEventTypes,
    mcpToolRisk,
    sastAdvisory,
  });

  const reviewDraft = await createChangeReviewDraft({
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    workspaceId,
    runtimeSecurity: input.runtimeSecurity,
    diffArtifact,
    gate,
    mcpToolRisk,
    sastAdvisory,
    sideEffectWarning: diffArtifact.isEmpty && observedSideEffectEventTypes.length > 0
      ? {
          code: "no_code_diff_runtime_side_effects_not_audited",
          message: "No code diff was produced; runtime side effects are not audited by Safe Apply.",
          observedEventTypes: observedSideEffectEventTypes,
          ...(observedSideEffectEvidence.toolNames.length > 0
            ? { observedTools: observedSideEffectEvidence.toolNames }
            : {}),
        }
      : null,
    verification: [],
    artifactsDir,
    createId,
    now: () => completedAt,
    artifactRepository: new ArtifactRepository(),
    executionEventRepository: new ExecutionEventRepository(),
  });
  await materializeChangeReviewFromDraftBestEffort({
    reviewDraftArtifactId: reviewDraft.artifactIds.reviewDraftArtifactId,
    diffArtifactId: reviewDraft.artifactIds.diffArtifactId,
    gateArtifactId: reviewDraft.artifactIds.gateArtifactId,
    now: () => completedAt,
  });

  return {
    created: true,
    ...reviewDraft.artifactIds,
  };
}
