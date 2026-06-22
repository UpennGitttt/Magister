import { readFile } from "node:fs/promises";

import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../repositories/runtime-workspace-repository";
import { getRunSummary } from "./get-run-service";
import type { RuntimeContextDocument } from "./build-runtime-context-document-service";
import { getArtifactLifecycleMap } from "./artifact-lifecycle-service";
import { getArtifactProvenanceMap } from "./artifact-provenance-service";
import { getLatestRuntimeContextForRun } from "./get-runtime-context-service";
import type { ArtifactResource } from "./list-task-artifacts-service";
import type { RunSummary } from "./materialize-run-summary-service";
import {
  getTaskOrchestrationReadModel,
  type SubagentInvocationSummary,
} from "./orchestration-read-model-service";
import type { RuntimeContinuityDecision } from "./runtime-continuity-service";
import { resolveRuntimeContinuityDecision } from "./runtime-continuity-service";

type RunContextEvent = {
  id: string;
  type: string;
  severity?: string | null;
  occurredAt: string;
  message?: string;
  source?: string;
  command?: string;
  payloadJson?: string | null;
};

type RunContextMetadata = {
  attemptCount: number;
  semanticRole: "manager_agent" | "delegated_subagent";
  leaderSemanticRole?: "leader_agent" | "delegated_subagent";
  delegationMode?: string | null;
  sessionId?: string | null;
  priorSessionId?: string | null;
  priorWorkdir?: string | null;
  resumePolicy?: string | null;
  resumeAttemptedAt?: string | null;
  resumeFailureReason?: string | null;
  continuityDecision?: RuntimeContinuityDecision | null;
  leaderDecision?: RunSummary["leaderDecision"] | null;
  leaderDecisionProvenance?: {
    source: "structured_decision" | "heuristic_fallback";
    runId: string;
    roleId: string;
    fallbackReason: string | null;
  } | null;
  managerDecision?: RunSummary["managerDecision"] | null;
  managerDecisionProvenance?: {
    source: "structured_decision" | "heuristic_fallback";
    runId: string;
    roleId: string;
    fallbackReason: string | null;
  } | null;
  subagentInvocation?: SubagentInvocationSummary | null;
  subagentInvocations?: SubagentInvocationSummary[];
  runtimeWorkspace?: {
    runId: string;
    taskId: string;
    workspaceId: string;
    roleId: string;
    requestedStrategy?: string | null;
    strategy: string;
    decisionReason?: string | null;
    fallbackReason?: string | null;
    status: string;
    baseWorkspaceDir: string;
    workspaceDir: string;
    metadataPath: string;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string | null;
  } | null;
  workspaceStrategyOverride?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

type RunNextAction = {
  kind: "retry" | "inspect" | "continue";
  message: string;
};

export type RunContext = {
  run: RunSummary;
  metadata: RunContextMetadata;
  recentEvents: RunContextEvent[];
  artifacts: ArtifactResource[];
  runtimeContextArtifactId: string | null;
  runtimeContextSummary: RuntimeContextDocument | null;
  nextAction: RunNextAction;
};

function buildManagerDecisionProvenance(run: RunSummary) {
  if (run.roleId !== "leader" || !run.managerDecision) {
    return null;
  }

  return {
    source: run.managerDecision.parsedDecision ? "structured_decision" : "heuristic_fallback",
    runId: run.id,
    roleId: run.roleId,
    fallbackReason: run.managerDecision.fallbackReason,
  } as const;
}

function normalizeSubagentInvocation(input: {
  subagentType?: unknown;
  roleId?: unknown;
  whyThisInvocation?: unknown;
  whyThisWorkItem?: unknown;
  completionSignal?: unknown;
}): SubagentInvocationSummary | null {
  const roleIdCandidate =
    typeof input.roleId === "string" && input.roleId.trim().length > 0
      ? input.roleId.trim()
      : null;
  const subagentTypeCandidate =
    typeof input.subagentType === "string" && input.subagentType.trim().length > 0
      ? input.subagentType.trim()
      : null;
  if (!roleIdCandidate && !subagentTypeCandidate) {
    return null;
  }
  const roleId = roleIdCandidate ?? subagentTypeCandidate!;
  const subagentType = subagentTypeCandidate ?? roleIdCandidate!;

  const whyThisInvocation =
    typeof input.whyThisInvocation === "string" && input.whyThisInvocation.trim().length > 0
      ? input.whyThisInvocation.trim()
      : typeof input.whyThisWorkItem === "string" && input.whyThisWorkItem.trim().length > 0
        ? input.whyThisWorkItem.trim()
        : null;
  const completionSignal =
    typeof input.completionSignal === "string" && input.completionSignal.trim().length > 0
      ? input.completionSignal.trim()
      : null;

  return {
    roleId,
    subagentType,
    ...(whyThisInvocation ? { whyThisInvocation } : {}),
    ...(completionSignal ? { completionSignal } : {}),
  };
}

function collectUniqueSubagentInvocations(
  invocations: Array<SubagentInvocationSummary | null | undefined>,
) {
  const seen = new Set<string>();

  return invocations.flatMap((invocation) => {
    if (!invocation) {
      return [];
    }

    const invocationKey = `${invocation.roleId}:${invocation.subagentType}`;
    if (seen.has(invocationKey)) {
      return [];
    }

    seen.add(invocationKey);
    return [invocation];
  });
}

function getManagerDecisionSubagentInvocations(run: RunSummary) {
  if (run.roleId !== "leader" || !run.managerDecision?.parsedDecision) {
    return [] as SubagentInvocationSummary[];
  }

  return collectUniqueSubagentInvocations(
    run.managerDecision.parsedDecision.childWorkItems.map((childWorkItem) =>
      normalizeSubagentInvocation({
        subagentType: childWorkItem.subagentType,
        roleId: childWorkItem.roleId,
        whyThisInvocation: childWorkItem.whyThisInvocation,
        whyThisWorkItem: childWorkItem.whyThisWorkItem,
        completionSignal: childWorkItem.completionSignal,
      }),
    ),
  );
}

function parsePayload(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readLatestRunNoteArtifactContent(
  artifacts: Awaited<ReturnType<ArtifactRepository["listByRoleRuntimeId"]>>,
) {
  const noteArtifact = [...artifacts]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .find(
      (artifact) =>
        artifact.storageKind === "file" &&
        (artifact.artifactType === "execution_note" || artifact.artifactType === "review"),
    );

  if (!noteArtifact) {
    return null;
  }

  try {
    const content = (await readFile(noteArtifact.storageRef, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export async function getRunContext(runId: string): Promise<RunContext | null> {
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const artifactRepository = new ArtifactRepository();
  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();

  const [run, runtime, events, artifacts, runtimeWorkspace] = await Promise.all([
    getRunSummary(runId),
    roleRuntimeRepository.getById(runId),
    executionEventRepository.listByRoleRuntimeId(runId),
    artifactRepository.listByRoleRuntimeId(runId),
    runtimeWorkspaceRepository.getByRunId(runId),
  ]);

  if (!run || !runtime) {
    return null;
  }

  const latestRunNote = await readLatestRunNoteArtifactContent(artifacts);
  const runtimeContext = await getLatestRuntimeContextForRun(runId);
  const orchestration = await getTaskOrchestrationReadModel(run.taskId);
  const artifactProvenance = await getArtifactProvenanceMap(artifacts.map((artifact) => artifact.id));
  const artifactLifecycle = getArtifactLifecycleMap(artifacts);
  const continuityDecision = resolveRuntimeContinuityDecision({
    adapterId: runtime.activeExecutorId ?? run.executorId ?? null,
    priorSessionId: runtime.priorSessionId,
    priorWorkdir: runtime.priorWorkdir,
    resumePolicy:
      runtime.resumePolicy === "resume_first" || runtime.resumePolicy === "rehydrate_only"
        ? runtime.resumePolicy
        : null,
    nativeResumeAttempted: Boolean(runtime.resumeAttemptedAt),
    resumeFailureReason: runtime.resumeFailureReason,
  });

  const recentEvents = [...events]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 8)
    .map((event) => {
      const payload = parsePayload(event.payloadJson);
      const payloadWithFallback =
        payload &&
        typeof payload === "object" &&
        (event.type === "executor_session.completed" || event.type === "executor_session.failed") &&
        (!("lastMessage" in payload) || typeof payload.lastMessage !== "string" || payload.lastMessage.trim().length === 0) &&
        latestRunNote
          ? { ...payload, lastMessage: latestRunNote }
          : payload;
      const serializedPayload = payloadWithFallback ? JSON.stringify(payloadWithFallback) : event.payloadJson ?? null;

      return {
        id: event.id,
        type: event.type,
        severity: event.severity,
        occurredAt: event.occurredAt.toISOString(),
        ...(typeof payloadWithFallback?.message === "string" && payloadWithFallback.message.length > 0
          ? { message: payloadWithFallback.message }
          : {}),
        ...(typeof payloadWithFallback?.source === "string" && payloadWithFallback.source.length > 0
          ? { source: payloadWithFallback.source }
          : {}),
        ...(typeof payloadWithFallback?.command === "string" && payloadWithFallback.command.length > 0
          ? { command: payloadWithFallback.command }
          : {}),
        ...(serializedPayload ? { payloadJson: serializedPayload } : {}),
      };
    });

  const latestError = recentEvents.find((event) => event.severity === "error");
  const latestErrorPayload = latestError
    ? parsePayload(events.find((event) => event.id === latestError.id)?.payloadJson)
    : null;

  const nextAction: RunNextAction =
    runtime.state === "FAILED"
      ? {
          kind: "retry",
          message:
            typeof latestErrorPayload?.suggestion === "string" &&
            latestErrorPayload.suggestion.length > 0
              ? latestErrorPayload.suggestion
              : "Inspect the failure and retry the run",
        }
      : runtime.state === "RUNNING"
        ? {
            kind: "continue",
            message: "Monitor recent observations while the run continues",
          }
        : {
            kind: "inspect",
            message: "Inspect recent events and artifacts for this run",
          };
  const orchestrationSubagentInvocations = collectUniqueSubagentInvocations(
    orchestration.workItems.map((workItem) => workItem.subagentInvocation),
  );
  const managerDecisionSubagentInvocations = getManagerDecisionSubagentInvocations(run);
  const subagentInvocations = collectUniqueSubagentInvocations([
    ...managerDecisionSubagentInvocations,
    ...orchestrationSubagentInvocations,
  ]);
  const subagentInvocation =
    run.roleId === "leader"
      ? null
      : subagentInvocations.find((invocation) => invocation.roleId === run.roleId) ??
        subagentInvocations.find((invocation) => invocation.subagentType === run.roleId) ??
        null;

  return {
    run,
    metadata: {
      attemptCount: runtime.attemptCount,
      semanticRole: run.roleId === "leader" ? "manager_agent" : "delegated_subagent",
      leaderSemanticRole: run.roleId === "leader" ? "leader_agent" : "delegated_subagent",
      delegationMode: runtime.delegationMode,
      sessionId: runtime.currentSessionId,
      priorSessionId: runtime.priorSessionId,
      priorWorkdir: runtime.priorWorkdir,
      resumePolicy: runtime.resumePolicy,
      workspaceStrategyOverride: runtime.workspaceStrategyOverride ?? null,
      resumeAttemptedAt: runtime.resumeAttemptedAt?.toISOString() ?? null,
      resumeFailureReason: runtime.resumeFailureReason,
      continuityDecision,
      leaderDecision: run.leaderDecision ?? run.managerDecision ?? null,
      leaderDecisionProvenance: buildManagerDecisionProvenance(run),
      managerDecision: run.managerDecision ?? null,
      managerDecisionProvenance: buildManagerDecisionProvenance(run),
      ...(subagentInvocation ? { subagentInvocation } : {}),
      ...(subagentInvocations.length > 0 ? { subagentInvocations } : {}),
      runtimeWorkspace: runtimeWorkspace
        ? {
            runId: runtimeWorkspace.runId,
            taskId: runtimeWorkspace.taskId,
            workspaceId: runtimeWorkspace.workspaceId,
            roleId: runtimeWorkspace.roleId,
            requestedStrategy: runtimeWorkspace.requestedStrategy ?? null,
            strategy: runtimeWorkspace.strategy,
            decisionReason: runtimeWorkspace.decisionReason ?? null,
            fallbackReason: runtimeWorkspace.fallbackReason ?? null,
            status: runtimeWorkspace.status,
            baseWorkspaceDir: runtimeWorkspace.baseWorkspaceDir,
            workspaceDir: runtimeWorkspace.workspaceDir,
            metadataPath: runtimeWorkspace.metadataPath,
            createdAt: runtimeWorkspace.createdAt.toISOString(),
            updatedAt: runtimeWorkspace.updatedAt.toISOString(),
            finishedAt: runtimeWorkspace.finishedAt?.toISOString() ?? null,
          }
        : null,
      startedAt: runtime.startedAt?.toISOString() ?? null,
      completedAt: runtime.completedAt?.toISOString() ?? null,
    },
    recentEvents,
    artifacts: artifacts
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
      })),
    runtimeContextArtifactId: runtimeContext.runtimeContextArtifactId,
    runtimeContextSummary: runtimeContext.runtimeContextSummary,
    nextAction,
  };
}
