import { ApprovalRepository } from "../repositories/approval-repository";
import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../repositories/runtime-workspace-repository";
import { TaskRepository } from "../repositories/task-repository";
import type { RuntimeContextDocument } from "./build-runtime-context-document-service";
import { getRunSummary } from "./get-run-service";
import { getLatestRuntimeContextForRun } from "./get-runtime-context-service";
import { getTaskOrchestrationReadModel } from "./orchestration-read-model-service";
import type { RuntimeContinuityDecision } from "./runtime-continuity-service";
import { resolveRuntimeContinuityDecision } from "./runtime-continuity-service";
import type { RunSummary } from "./materialize-run-summary-service";

type TaskGraphNode = {
  id: string;
  kind: "task" | "run";
  label: string;
  state: string;
  roleId?: string;
};

type TaskGraphEdge = {
  source: string;
  target: string;
  kind: "owns" | "depends_on";
};

type RoleLane = {
  roleId: string;
  semanticRole: "manager_agent" | "delegated_subagent";
  leaderSemanticRole?: "leader_agent" | "delegated_subagent";
  state: string;
  runId?: string;
  executorId?: string | null;
  attemptCount: number;
  updatedAt: string;
  lastError?: string;
  latestArtifactSummary?: string;
  approvalState?: string;
  dependsOn?: string[];
  plannedState?: "CREATED" | "QUEUED";
  primaryAdapterId?: string;
  routingStrategy?: string;
  fallbackAdapterId?: string;
  executorClass?: string;
  runtimeContextArtifactId?: string | null;
  runtimeContextSummary?: RuntimeContextDocument | null;
  continuityDecision?: RuntimeContinuityDecision | null;
  workspaceStrategyOverride?: string | null;
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
};

type ManagerToolEvent = {
  type: "tool.call" | "tool.result" | "tool.error";
  toolName: string;
  summary: string;
  occurredAt: string;
  step?: number;
  status?: "in_progress" | "succeeded" | "failed";
  source?: string;
  toolCallId?: string;
  startedAt?: string;
  latencyMs?: number;
  arguments?: Record<string, unknown>;
  result?: unknown;
  resultSummary?: string;
  errorMessage?: string;
};

export type TaskContext = {
  taskGraph: {
    nodes: TaskGraphNode[];
    edges: TaskGraphEdge[];
  };
  roleLanes: RoleLane[];
  leaderSemanticOwner: "leader_agent";
  semanticOwner: "manager_agent";
  currentExecutionRole: string;
  currentResponsibleRole: string;
  managerDecision?: {
    semanticSource: "manager_agent";
    source: "structured_decision" | "heuristic_fallback";
    runId: string;
    roleId: string;
    fallbackReason: string | null;
    decision?: RunSummary["managerDecision"] | null;
    leaderPlan?: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["leaderPlan"] | null;
    managerPlan?: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["managerPlan"] | null;
  } | null;
  leaderPlan?: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["leaderPlan"] | null;
  managerPlan?: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["managerPlan"] | null;
  workItems?: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["workItems"];
  subagentInvocations?: Array<
    Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["workItems"][number]["subagentInvocation"]
  >;
  leaderToolEvents?: ManagerToolEvent[];
  managerToolEvents?: ManagerToolEvent[];
};

function parseEventPayload(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function buildTaskManagerDecisionView(input: {
  managerRunSummary: RunSummary | null;
  managerPlan: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["managerPlan"] | null;
  managerRunId: string | null;
}) {
  const roleId = "leader";

  if (input.managerRunSummary?.managerDecision?.parsedDecision) {
    return {
      semanticSource: "manager_agent" as const,
      source: "structured_decision" as const,
      runId: input.managerRunSummary.id,
      roleId,
      fallbackReason: input.managerRunSummary.managerDecision.fallbackReason,
      decision: input.managerRunSummary.managerDecision,
    };
  }

  if (!input.managerPlan || !input.managerRunId) {
    return null;
  }

  return {
    semanticSource: "manager_agent" as const,
    source: "heuristic_fallback" as const,
    runId: input.managerRunId,
    roleId,
    fallbackReason: input.managerRunSummary?.managerDecision?.fallbackReason ?? null,
    ...(input.managerRunSummary?.managerDecision
      ? { decision: input.managerRunSummary.managerDecision }
      : {}),
    leaderPlan: input.managerPlan,
    managerPlan: input.managerPlan,
  };
}

function parseMessage(payloadJson?: string | null) {
  if (!payloadJson) {
    return undefined;
  }

  try {
    const payload = JSON.parse(payloadJson) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {}

  return undefined;
}

function pickResponsibleRole(
  lanes: RoleLane[],
): string {
  const pendingApprovalLane = lanes.find((lane) => lane.approvalState === "pending");
  if (pendingApprovalLane) {
    return pendingApprovalLane.roleId;
  }

  const failedLane = lanes.find((lane) => lane.state === "FAILED");
  if (failedLane) {
    return failedLane.roleId;
  }

  const activeLane = lanes.find(
    (lane) =>
      lane.state === "RUNNING" ||
      lane.state === "CREATED" ||
      lane.state === "BLOCKED",
  );

  return activeLane?.roleId ?? "leader";
}

function collectSubagentInvocations(
  workItems: Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>["workItems"],
) {
  const seen = new Set<string>();

  return workItems.flatMap((workItem) => {
    const invocation = workItem.subagentInvocation;
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

function collectManagerToolEvents(
  events: Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>,
  managerRunId?: string | null,
) {
  type NormalizedManagerToolEvent = {
    type: ManagerToolEvent["type"];
    toolName: string;
    summary: string;
    occurredAt: Date;
    source?: string;
    toolCallId?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    resultSummary?: string;
    errorMessage?: string;
  };
  type PendingManagerToolCall = {
    step: number;
    occurredAt: Date;
  };

  const normalizedEvents = [...events]
    .filter(
      (event) =>
        event.roleRuntimeId === managerRunId &&
        (event.type === "tool.call" || event.type === "tool.result" || event.type === "tool.error"),
    )
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .flatMap((event) => {
      const payload = parseEventPayload(event.payloadJson);
      const toolName =
        typeof payload?.toolName === "string" && payload.toolName.trim().length > 0
          ? payload.toolName.trim()
          : null;
      if (!toolName) {
        return [];
      }

      const summary =
        typeof payload?.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : `${event.type} ${toolName}`;
      const normalizedType = event.type as ManagerToolEvent["type"];
      const toolCallIdCandidates = [payload?.toolCallId, payload?.tool_call_id, payload?.call_id];
      const toolCallId = toolCallIdCandidates.find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      const source =
        typeof payload?.source === "string" && payload.source.trim().length > 0
          ? payload.source.trim()
          : undefined;

      return [
        {
          type: normalizedType,
          toolName,
          summary,
          occurredAt: event.occurredAt,
          ...(source ? { source } : {}),
          ...(toolCallId ? { toolCallId: toolCallId.trim() } : {}),
          ...(payload && typeof payload.arguments === "object" && payload.arguments && !Array.isArray(payload.arguments)
            ? { arguments: payload.arguments as Record<string, unknown> }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(payload ?? {}, "result")
            ? { result: payload?.result }
            : {}),
          ...(typeof payload?.resultSummary === "string" && payload.resultSummary.trim().length > 0
            ? { resultSummary: payload.resultSummary.trim() }
            : {}),
          ...(typeof payload?.errorMessage === "string" && payload.errorMessage.trim().length > 0
            ? { errorMessage: payload.errorMessage.trim() }
            : {}),
        } satisfies NormalizedManagerToolEvent,
      ];
    });

  const pendingCallsByToolName = new Map<string, PendingManagerToolCall[]>();
  const pendingCallsByToolCallId = new Map<string, PendingManagerToolCall[]>();
  let stepCounter = 0;

  const dropPendingCallFromToolNameQueue = (
    toolName: string,
    pendingCall: PendingManagerToolCall,
  ) => {
    const queue = pendingCallsByToolName.get(toolName);
    if (!queue) {
      return;
    }
    const pendingIndex = queue.indexOf(pendingCall);
    if (pendingIndex >= 0) {
      queue.splice(pendingIndex, 1);
    }
    if (queue.length === 0) {
      pendingCallsByToolName.delete(toolName);
    }
  };

  const dropPendingCallFromToolCallIdQueues = (pendingCall: PendingManagerToolCall) => {
    for (const [toolCallId, queue] of pendingCallsByToolCallId.entries()) {
      const pendingIndex = queue.indexOf(pendingCall);
      if (pendingIndex >= 0) {
        queue.splice(pendingIndex, 1);
      }
      if (queue.length === 0) {
        pendingCallsByToolCallId.delete(toolCallId);
      }
    }
  };

  const enrichedEvents = normalizedEvents.map((event) => {
    if (event.type === "tool.call") {
      stepCounter += 1;
      const pendingCall: PendingManagerToolCall = {
        step: stepCounter,
        occurredAt: event.occurredAt,
      };
      const toolQueue = pendingCallsByToolName.get(event.toolName) ?? [];
      toolQueue.push(pendingCall);
      pendingCallsByToolName.set(event.toolName, toolQueue);
      if (event.toolCallId) {
        const toolCallQueue = pendingCallsByToolCallId.get(event.toolCallId) ?? [];
        toolCallQueue.push(pendingCall);
        pendingCallsByToolCallId.set(event.toolCallId, toolCallQueue);
      }

      return {
        ...event,
        occurredAt: event.occurredAt.toISOString(),
        step: pendingCall.step,
        status: "in_progress" as const,
      } satisfies ManagerToolEvent;
    }

    let matchedPendingCall: PendingManagerToolCall | undefined;
    if (event.toolCallId) {
      const queue = pendingCallsByToolCallId.get(event.toolCallId);
      matchedPendingCall = queue?.shift();
      if (queue && queue.length === 0) {
        pendingCallsByToolCallId.delete(event.toolCallId);
      }
      if (matchedPendingCall) {
        dropPendingCallFromToolNameQueue(event.toolName, matchedPendingCall);
      }
    }

    if (!matchedPendingCall) {
      const queue = pendingCallsByToolName.get(event.toolName);
      matchedPendingCall = queue?.shift();
      if (queue && queue.length === 0) {
        pendingCallsByToolName.delete(event.toolName);
      }
      if (matchedPendingCall) {
        dropPendingCallFromToolCallIdQueues(matchedPendingCall);
      }
    }

    const step = matchedPendingCall?.step ?? ++stepCounter;
    const latencyMs = matchedPendingCall
      ? Math.max(0, event.occurredAt.getTime() - matchedPendingCall.occurredAt.getTime())
      : undefined;

    return {
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      step,
      status: event.type === "tool.result" ? ("succeeded" as const) : ("failed" as const),
      ...(matchedPendingCall ? { startedAt: matchedPendingCall.occurredAt.toISOString() } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    } satisfies ManagerToolEvent;
  });

  return enrichedEvents.sort(
    (left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
  );
}

export async function getTaskContext(taskId: string): Promise<TaskContext | null> {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const approvalRepository = new ApprovalRepository();
  const artifactRepository = new ArtifactRepository();
  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();

  const [task, runtimes, events, approvals, artifacts, runtimeWorkspaces] = await Promise.all([
    taskRepository.getById(taskId),
    roleRuntimeRepository.listByTaskId(taskId),
    executionEventRepository.listByTaskId(taskId),
    approvalRepository.listByTaskId(taskId),
    artifactRepository.listByTaskId(taskId),
    runtimeWorkspaceRepository.listAll(),
  ]);

  if (!task) {
    return null;
  }

  const latestRuntimeByRole = new Map<string, (typeof runtimes)[number]>();

  for (const runtime of [...runtimes].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    if (!latestRuntimeByRole.has(runtime.roleId)) {
      latestRuntimeByRole.set(runtime.roleId, runtime);
    }
  }

  const orchestration = await getTaskOrchestrationReadModel(taskId);
  const managerPlan = orchestration.managerPlan;
  const managerRunId = latestRuntimeByRole.get("leader")?.id ?? null;
  const managerRunSummary = managerRunId ? await getRunSummary(managerRunId) : null;
  const plannedRoleIds = orchestration.workItems.map((item) => item.roleId);
  const reportingRoleIds = orchestration.roleProgress.map((capability) => capability.roleId);
  const roleIds = [
    "leader",
    ...plannedRoleIds,
    ...reportingRoleIds,
  ].filter((roleId, index, array) => array.indexOf(roleId) === index);
  const visibleRuntimeIds = new Set(
    roleIds
      .map((roleId) => latestRuntimeByRole.get(roleId)?.id)
      .filter((runtimeId): runtimeId is string => Boolean(runtimeId)),
  );

  const roleLanes: RoleLane[] = roleIds.map((roleId) => {
    const runtime = latestRuntimeByRole.get(roleId);
    const plannedChildRun = orchestration.workItems.find((childRun) => childRun.roleId === roleId);
    const runtimeEvents = runtime
      ? events
          .filter((event) => event.roleRuntimeId === runtime.id)
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      : [];
    const runtimeApprovals = runtime
      ? approvals
          .filter((approval) => approval.roleRuntimeId === runtime.id)
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
      : [];
    const runtimeArtifacts = runtime
      ? artifacts
          .filter((artifact) => artifact.roleRuntimeId === runtime.id)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      : [];

    return {
      roleId,
      semanticRole: roleId === "leader" ? "manager_agent" : "delegated_subagent",
      leaderSemanticRole: roleId === "leader" ? "leader_agent" : "delegated_subagent",
      state: runtime?.state ?? "IDLE",
      attemptCount: runtime?.attemptCount ?? 0,
      updatedAt: runtime?.updatedAt.toISOString() ?? task.updatedAt.toISOString(),
      ...(runtime?.id ? { runId: runtime.id } : {}),
      ...(runtime?.activeExecutorId ? { executorId: runtime.activeExecutorId } : {}),
      ...(runtimeEvents[0]
        ? { lastError: parseMessage(runtimeEvents[0].payloadJson) ?? runtimeEvents[0].type }
        : {}),
      ...(runtimeArtifacts[0]
        ? {
            latestArtifactSummary:
              runtimeArtifacts[0].summary ?? runtimeArtifacts[0].title,
          }
        : {}),
      ...(runtimeApprovals[0] ? { approvalState: runtimeApprovals[0].state } : {}),
      ...(plannedChildRun ? { dependsOn: plannedChildRun.dependsOn } : {}),
      ...(plannedChildRun ? { plannedState: plannedChildRun.state } : {}),
      ...(plannedChildRun?.primaryAdapterId ? { primaryAdapterId: plannedChildRun.primaryAdapterId } : {}),
      ...(plannedChildRun?.routingStrategy ? { routingStrategy: plannedChildRun.routingStrategy } : {}),
      ...(plannedChildRun?.fallbackAdapterId ? { fallbackAdapterId: plannedChildRun.fallbackAdapterId } : {}),
      ...(plannedChildRun?.executorClass ? { executorClass: plannedChildRun.executorClass } : {}),
    };
  });

  const roleLanesWithRuntimeContext = await Promise.all(
    roleLanes.map(async (lane) => {
      if (!lane.runId) {
        return lane;
      }

      const runtimeContext = await getLatestRuntimeContextForRun(lane.runId);
      const runtime = latestRuntimeByRole.get(lane.roleId);
      const runtimeWorkspace = runtimeWorkspaces.find((workspace) => workspace.runId === lane.runId);
      return {
        ...lane,
        workspaceStrategyOverride: runtime?.workspaceStrategyOverride ?? null,
        runtimeContextArtifactId: runtimeContext.runtimeContextArtifactId,
        runtimeContextSummary: runtimeContext.runtimeContextSummary,
        continuityDecision: runtime
          ? resolveRuntimeContinuityDecision({
              adapterId: runtime.activeExecutorId ?? lane.primaryAdapterId ?? null,
              priorSessionId: runtime.priorSessionId,
              priorWorkdir: runtime.priorWorkdir,
              resumePolicy:
                runtime.resumePolicy === "resume_first" || runtime.resumePolicy === "rehydrate_only"
                  ? runtime.resumePolicy
                  : null,
              nativeResumeAttempted: Boolean(runtime.resumeAttemptedAt),
              resumeFailureReason: runtime.resumeFailureReason,
            })
          : null,
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
      };
    }),
  );

  const taskGraph = {
    nodes: [
      {
        id: task.id,
        kind: "task" as const,
        label: task.title,
        state: task.state,
      },
      ...runtimes
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .filter((runtime) => visibleRuntimeIds.has(runtime.id))
        .map((runtime) => ({
          id: runtime.id,
          kind: "run" as const,
          label: runtime.roleId,
          state: runtime.state,
          roleId: runtime.roleId,
        })),
    ],
    edges: [
      ...runtimes
        .filter((runtime) => visibleRuntimeIds.has(runtime.id))
        .map((runtime) => ({
        source: task.id,
        target: runtime.id,
        kind: "owns" as const,
      })),
      ...(orchestration.workItems.flatMap((childRun) => {
        const targetRuntime = latestRuntimeByRole.get(childRun.roleId);
        if (!targetRuntime) {
          return [];
        }

        return childRun.dependsOn.flatMap((dependencyRoleId) => {
          const dependencyRuntime = latestRuntimeByRole.get(dependencyRoleId);
          if (!dependencyRuntime) {
            return [];
          }

          return [
            {
              source: dependencyRuntime.id,
              target: targetRuntime.id,
              kind: "depends_on" as const,
            },
          ];
        });
      }) ?? []),
    ],
  };
  const subagentInvocations = collectSubagentInvocations(orchestration.workItems);
  const managerToolEvents = collectManagerToolEvents(events, managerRunId);

  return {
    taskGraph,
    roleLanes: roleLanesWithRuntimeContext,
    leaderSemanticOwner: "leader_agent",
    semanticOwner: "manager_agent",
    currentExecutionRole: pickResponsibleRole(roleLanesWithRuntimeContext),
    currentResponsibleRole: pickResponsibleRole(roleLanesWithRuntimeContext),
    managerDecision: buildTaskManagerDecisionView({
      managerRunSummary,
      managerPlan,
      managerRunId,
    }),
    leaderPlan: managerPlan,
    managerPlan,
    workItems: orchestration.workItems,
    ...(subagentInvocations.length > 0 ? { subagentInvocations } : {}),
    ...(managerToolEvents.length > 0 ? { leaderToolEvents: managerToolEvents } : {}),
    ...(managerToolEvents.length > 0 ? { managerToolEvents } : {}),
  };
}
