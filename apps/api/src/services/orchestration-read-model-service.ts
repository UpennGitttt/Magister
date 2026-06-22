import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { extractManagerDecisionOutput } from "./manager-decision-service";
import {
  deriveCoordinationAction,
  mapLegacyPlanningModeToDecisionMode,
  type TaskManagerDecisionMode,
} from "./task-manager-decision-service";
import type { TaskManagerCoordinationAction } from "./planner-hints";

export type SubagentInvocationSummary = {
  roleId: string;
  subagentType: string;
  whyThisInvocation?: string;
  completionSignal?: string;
};

export type OrchestrationChildRun = {
  subagentType?: string;
  roleId: string;
  state: "CREATED" | "QUEUED";
  dependsOn: string[];
  goal?: string;
  whyThisInvocation?: string;
  whyThisWorkItem?: string;
  completionSignal?: string;
  handoffNotes?: string;
  primaryAdapterId?: string;
  routingStrategy?: string;
  fallbackAdapterId?: string;
  executorClass?: string;
};

export type OrchestrationManagerPlan = {
  decisionMode?: TaskManagerDecisionMode;
  coordinationAction?: TaskManagerCoordinationAction;
  planningMode?: "conversational_shortcut" | "information_shortcut" | "heuristic" | "explicit_hints";
  executionMode?: "immediate" | "bounded_execution" | "long_running";
  taskType: "conversation" | "coding" | "mixed";
  goal?: string;
  needsHuman?: boolean;
  confidence?: "high" | "medium" | "low";
  stopCondition?: string;
  source?: string;
  warnings?: string[];
  detectedSignals?: string[];
  childRuns: OrchestrationChildRun[];
};

export type OrchestrationRoleProgress = {
  roleId: string;
  state: string;
  executorId?: string;
  runId?: string;
  summary?: string;
};

type OrchestrationWorkItemDefinition = {
  subagentType?: string;
  roleId: string;
  state: "CREATED" | "QUEUED";
  dependsOn: string[];
  goal?: string;
  whyThisInvocation?: string;
  whyThisWorkItem?: string;
  completionSignal?: string;
  handoffNotes?: string;
  primaryAdapterId?: string;
  routingStrategy?: string;
  fallbackAdapterId?: string;
  executorClass?: string;
};

type StoredWorkItemsSnapshot = {
  managerPlan: OrchestrationManagerPlan | null;
  workItems: OrchestrationWorkItemDefinition[];
  roleProgress: OrchestrationRoleProgress[];
  latestAnswer: string | null;
};

export type TaskOrchestrationReadModel = {
  leaderPlan: OrchestrationManagerPlan | null;
  managerPlan: OrchestrationManagerPlan | null;
  roleProgress: OrchestrationRoleProgress[];
  workItems: Array<{
    subagentType: string;
    roleId: string;
    executionKind: "delegated_subagent";
    subagentInvocation: SubagentInvocationSummary;
    state: "CREATED" | "QUEUED";
    dependsOn: string[];
    primaryAdapterId?: string;
    routingStrategy?: string;
    fallbackAdapterId?: string;
    executorClass?: string;
    goal?: string;
    whyThisInvocation?: string;
    whyThisWorkItem?: string;
    completionSignal?: string;
    handoffNotes?: string;
    runtimeState: string;
    executionStatus:
      | "ready"
      | "waiting_on_dependencies"
      | "running"
      | "completed"
      | "blocked";
    runId?: string;
    executorId?: string;
    summary?: string;
  }>;
  latestAnswer: string | null;
  completedCapabilities: string[];
  pendingCapabilities: string[];
  blockedCapabilities: string[];
  nextCapability: string | null;
};

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

function readPayloadString(payload: Record<string, unknown> | null, keys: string[]) {
  if (!payload) {
    return null;
  }

  for (const key of keys) {
    const candidate = payload[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function readInvocationTarget(record: Record<string, unknown>) {
  const roleId =
    typeof record.roleId === "string" && record.roleId.trim().length > 0
      ? record.roleId.trim()
      : null;
  const subagentType =
    typeof record.subagentType === "string" && record.subagentType.trim().length > 0
      ? record.subagentType.trim()
      : null;

  if (!roleId && !subagentType) {
    return null;
  }

  return {
    roleId: roleId ?? subagentType!,
    subagentType: subagentType ?? roleId!,
  };
}

function readInvocationWhy(record: Record<string, unknown>) {
  const whyThisInvocation =
    typeof record.whyThisInvocation === "string" && record.whyThisInvocation.trim().length > 0
      ? record.whyThisInvocation.trim()
      : null;
  const whyThisWorkItem =
    typeof record.whyThisWorkItem === "string" && record.whyThisWorkItem.trim().length > 0
      ? record.whyThisWorkItem.trim()
      : null;

  return whyThisInvocation ?? whyThisWorkItem;
}

function readLatestAnswerFromEvent(event: { type: string; payloadJson?: string | null } | null) {
  const payload = parsePayload(event?.payloadJson);
  if (!event) {
    return null;
  }

  if (event.type === "executor_session.completed") {
    const structuredDecisionOutput =
      readPayloadString(payload, ["lastMessage", "summary", "message", "lastMessagePreview", "dispatchMessage"]) ??
      null;
    if (structuredDecisionOutput) {
      const extracted = extractManagerDecisionOutput(structuredDecisionOutput);
      const structuredReply = extracted.parsedDecision?.reply;
      if (structuredReply) {
        return structuredReply;
      }
    }

    return readPayloadString(payload, [
      "lastMessage",
      "summary",
      "message",
      "lastMessagePreview",
      "dispatchMessage",
      "error",
    ]);
  }

  if (event.type === "executor_session.failed") {
    return readPayloadString(payload, [
      "message",
      "error",
      "summary",
      "dispatchMessage",
      "lastMessage",
      "lastMessagePreview",
    ]);
  }

  return readPayloadString(payload, [
    "message",
    "summary",
    "dispatchMessage",
    "error",
    "lastMessage",
    "lastMessagePreview",
  ]);
}

function parseManagerPlan(payloadJson?: string | null): OrchestrationManagerPlan | null {
  const payload = parsePayload(payloadJson);
  const taskType = payload?.taskType;
  const childRuns = payload?.childRuns;
  const source = payload?.source;
  const decisionMode = payload?.decisionMode;
  const coordinationAction = payload?.coordinationAction;
  const planningMode = payload?.planningMode;
  const executionMode = payload?.executionMode;
  const goal = payload?.goal;
  const needsHuman = payload?.needsHuman;
  const confidence = payload?.confidence;
  const stopCondition = payload?.stopCondition;
  const warnings = payload?.warnings;
  const detectedSignals = payload?.detectedSignals;

  if (
    (taskType !== "conversation" && taskType !== "coding" && taskType !== "mixed") ||
    !Array.isArray(childRuns)
  ) {
    return null;
  }

  const normalizedDecisionMode =
    decisionMode === "direct_answer" ||
    decisionMode === "tool_answer" ||
    decisionMode === "clarify" ||
    decisionMode === "heuristic" ||
    decisionMode === "explicit_hints"
      ? decisionMode
      : planningMode === "conversational_shortcut" ||
          planningMode === "information_shortcut" ||
          planningMode === "heuristic" ||
          planningMode === "explicit_hints"
        ? mapLegacyPlanningModeToDecisionMode(planningMode)
        : undefined;
  const normalizedCoordinationAction =
    coordinationAction === "direct_answer" ||
    coordinationAction === "tool_answer" ||
    coordinationAction === "clarify" ||
    coordinationAction === "assign" ||
    coordinationAction === "handoff" ||
    coordinationAction === "send_message"
      ? coordinationAction
      : deriveCoordinationAction({
          decisionMode: normalizedDecisionMode,
          childRunCount: childRuns.length,
        });
  const normalizedExecutionMode =
    executionMode === "immediate" ||
    executionMode === "bounded_execution" ||
    executionMode === "long_running"
      ? executionMode
      : childRuns.length === 0
        ? "immediate"
        : "bounded_execution";

  return {
      taskType,
      ...(normalizedDecisionMode ? { decisionMode: normalizedDecisionMode } : {}),
      ...(normalizedCoordinationAction ? { coordinationAction: normalizedCoordinationAction } : {}),
      ...(normalizedExecutionMode ? { executionMode: normalizedExecutionMode } : {}),
      ...(planningMode === "conversational_shortcut" ||
      planningMode === "information_shortcut" ||
      planningMode === "heuristic" ||
      planningMode === "explicit_hints"
        ? { planningMode }
        : {}),
      ...(typeof goal === "string" ? { goal } : {}),
      ...(typeof needsHuman === "boolean" ? { needsHuman } : {}),
      ...(confidence === "high" || confidence === "medium" || confidence === "low"
        ? { confidence }
        : {}),
      ...(typeof stopCondition === "string" ? { stopCondition } : {}),
      ...(typeof source === "string" ? { source } : {}),
      ...(Array.isArray(warnings)
        ? {
            warnings: warnings.filter(
              (warning): warning is string => typeof warning === "string" && warning.trim().length > 0,
            ),
          }
        : {}),
      ...(Array.isArray(detectedSignals)
        ? {
            detectedSignals: detectedSignals.filter(
              (signal): signal is string => typeof signal === "string" && signal.trim().length > 0,
            ),
          }
        : {}),
      childRuns: childRuns.flatMap((childRun) => {
      if (!childRun || typeof childRun !== "object") {
        return [];
      }

      const record = childRun as Record<string, unknown>;
      const invocationTarget = readInvocationTarget(record);
      if (!invocationTarget || (record.state !== "CREATED" && record.state !== "QUEUED")) {
        return [];
      }
      const whyThisInvocation = readInvocationWhy(record);

      return [
        {
          subagentType: invocationTarget.subagentType,
          roleId: invocationTarget.roleId,
          state: record.state,
          dependsOn: Array.isArray(record.dependsOn)
            ? record.dependsOn.filter((item): item is string => typeof item === "string")
            : [],
          ...(typeof record.goal === "string" ? { goal: record.goal } : {}),
          ...(whyThisInvocation
            ? {
                whyThisInvocation,
                whyThisWorkItem: whyThisInvocation,
              }
            : {}),
          ...(typeof record.completionSignal === "string"
            ? { completionSignal: record.completionSignal }
            : {}),
          ...(typeof record.handoffNotes === "string"
            ? { handoffNotes: record.handoffNotes }
            : {}),
          ...(typeof record.primaryAdapterId === "string"
            ? { primaryAdapterId: record.primaryAdapterId }
            : {}),
          ...(typeof record.routingStrategy === "string"
            ? { routingStrategy: record.routingStrategy }
            : {}),
          ...(typeof record.fallbackAdapterId === "string"
            ? { fallbackAdapterId: record.fallbackAdapterId }
            : {}),
          ...(typeof record.executorClass === "string"
            ? { executorClass: record.executorClass }
            : {}),
        },
      ];
    }),
  };
}

function parseWorkItemDefinition(
  input: Record<string, unknown>,
): OrchestrationWorkItemDefinition | null {
  const invocationTarget = readInvocationTarget(input);
  if (!invocationTarget || (input.state !== "CREATED" && input.state !== "QUEUED")) {
    return null;
  }
  const whyThisInvocation = readInvocationWhy(input);

  return {
    subagentType: invocationTarget.subagentType,
    roleId: invocationTarget.roleId,
    state: input.state,
    dependsOn: Array.isArray(input.dependsOn)
      ? input.dependsOn.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof input.goal === "string" ? { goal: input.goal } : {}),
    ...(whyThisInvocation
      ? {
          whyThisInvocation,
          whyThisWorkItem: whyThisInvocation,
        }
      : {}),
    ...(typeof input.completionSignal === "string"
      ? { completionSignal: input.completionSignal }
      : {}),
    ...(typeof input.handoffNotes === "string"
      ? { handoffNotes: input.handoffNotes }
      : {}),
    ...(typeof input.primaryAdapterId === "string"
      ? { primaryAdapterId: input.primaryAdapterId }
      : {}),
    ...(typeof input.routingStrategy === "string"
      ? { routingStrategy: input.routingStrategy }
      : {}),
    ...(typeof input.fallbackAdapterId === "string"
      ? { fallbackAdapterId: input.fallbackAdapterId }
      : {}),
    ...(typeof input.executorClass === "string"
      ? { executorClass: input.executorClass }
      : {}),
  };
}

function getStoredManagerPlanFromEvents(
  events: Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>,
): OrchestrationManagerPlan | null {
  const latestManagerPlanEvent = [...events]
    .filter((event) => event.type === "task.manager.plan_created")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];

  return parseManagerPlan(latestManagerPlanEvent?.payloadJson);
}

export async function getStoredManagerPlan(
  taskId: string,
): Promise<OrchestrationManagerPlan | null> {
  const executionEventRepository = new ExecutionEventRepository();
  const events = await executionEventRepository.listByTaskId(taskId);
  return getStoredManagerPlanFromEvents(events);
}

function getStoredWorkItemsSnapshotFromEvents(
  events: Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>,
): StoredWorkItemsSnapshot | null {
  const latestSnapshotEvent = [...events]
    .filter((event) => event.type === "task.work_items.updated")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];

  const payload = parsePayload(latestSnapshotEvent?.payloadJson);
  if (!payload) {
    return null;
  }

  const managerPlan =
    payload.managerPlan && typeof payload.managerPlan === "object"
      ? parseManagerPlan(JSON.stringify(payload.managerPlan))
      : null;
  const workItems = Array.isArray(payload.workItems)
    ? payload.workItems.flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }

        const parsed = parseWorkItemDefinition(item as Record<string, unknown>);
        return parsed ? [parsed] : [];
      })
    : [];
  const latestAnswer =
    typeof payload.latestAnswer === "string" && payload.latestAnswer.trim().length > 0
      ? payload.latestAnswer.trim()
      : null;
  const roleProgress = Array.isArray(payload.roleProgress)
    ? payload.roleProgress.flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }

        const record = item as Record<string, unknown>;
        if (typeof record.roleId !== "string" || typeof record.state !== "string") {
          return [];
        }

        return [
          {
            roleId: record.roleId,
            state: record.state,
            ...(typeof record.executorId === "string" ? { executorId: record.executorId } : {}),
            ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
            ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          } satisfies OrchestrationRoleProgress,
        ];
      })
    : [];

  if (!managerPlan && workItems.length === 0 && roleProgress.length === 0 && !latestAnswer) {
    return null;
  }

  return {
    managerPlan,
    workItems,
    roleProgress,
    latestAnswer,
  };
}

function uniqueRoleIds(items: string[]) {
  return items.filter((item, index, array) => array.indexOf(item) === index);
}

function getReportingRoleIds(input: {
  workItemDefinitions: OrchestrationWorkItemDefinition[];
  latestRuntimeByRole: Map<string, Awaited<ReturnType<RoleRuntimeRepository["listByTaskId"]>>[number]>;
}) {
  if (input.workItemDefinitions.length > 0) {
    return uniqueRoleIds([
      "leader",
      ...input.workItemDefinitions.map((workItem) => workItem.roleId),
    ]);
  }

  return uniqueRoleIds([
    "leader",
    ...[...input.latestRuntimeByRole.keys()],
  ]);
}

function buildWorkItems(input: {
  workItemDefinitions: OrchestrationWorkItemDefinition[];
  latestRuntimeByRole: Map<string, Awaited<ReturnType<RoleRuntimeRepository["listByTaskId"]>>[number]>;
  roleProgress: OrchestrationRoleProgress[];
}) {
  return input.workItemDefinitions.map((workItem) => {
    const subagentType = workItem.subagentType ?? workItem.roleId;
    const whyThisInvocation = workItem.whyThisInvocation ?? workItem.whyThisWorkItem;
    const runtime = input.latestRuntimeByRole.get(workItem.roleId);
    const runtimeState = runtime?.state ?? "IDLE";
    const dependencyStates = workItem.dependsOn.map(
      (dependencyRoleId) => input.latestRuntimeByRole.get(dependencyRoleId)?.state,
    );
    const dependenciesCompleted = dependencyStates.every((state) => state === "COMPLETED");
    const progress = input.roleProgress.find((item) => item.roleId === workItem.roleId);

    let executionStatus: TaskOrchestrationReadModel["workItems"][number]["executionStatus"];
    if (runtimeState === "COMPLETED") {
      executionStatus = "completed";
    } else if (runtimeState === "FAILED" || runtimeState === "BLOCKED") {
      executionStatus = "blocked";
    } else if (runtimeState === "RUNNING") {
      executionStatus = "running";
    } else if (dependenciesCompleted) {
      executionStatus = "ready";
    } else {
      executionStatus = "waiting_on_dependencies";
    }

    return {
      subagentType,
      roleId: workItem.roleId,
      executionKind: "delegated_subagent" as const,
      subagentInvocation: {
        roleId: workItem.roleId,
        subagentType,
        ...(whyThisInvocation ? { whyThisInvocation } : {}),
        ...(workItem.completionSignal ? { completionSignal: workItem.completionSignal } : {}),
      },
      state: workItem.state,
      dependsOn: workItem.dependsOn,
      ...(workItem.goal ? { goal: workItem.goal } : {}),
      ...(whyThisInvocation ? { whyThisInvocation } : {}),
      ...(workItem.whyThisWorkItem ? { whyThisWorkItem: workItem.whyThisWorkItem } : {}),
      ...(workItem.completionSignal ? { completionSignal: workItem.completionSignal } : {}),
      ...(workItem.handoffNotes ? { handoffNotes: workItem.handoffNotes } : {}),
      ...(workItem.primaryAdapterId ? { primaryAdapterId: workItem.primaryAdapterId } : {}),
      ...(workItem.routingStrategy ? { routingStrategy: workItem.routingStrategy } : {}),
      ...(workItem.fallbackAdapterId ? { fallbackAdapterId: workItem.fallbackAdapterId } : {}),
      ...(workItem.executorClass ? { executorClass: workItem.executorClass } : {}),
      runtimeState,
      executionStatus,
      ...(progress?.runId ? { runId: progress.runId } : {}),
      ...(progress?.executorId ? { executorId: progress.executorId } : {}),
      ...(progress?.summary ? { summary: progress.summary } : {}),
    };
  });
}

async function getTaskOrchestrationReadModelInternal(
  taskId: string,
  options: {
    preferStoredSnapshot: boolean;
  },
): Promise<TaskOrchestrationReadModel> {
  const executionEventRepository = new ExecutionEventRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();

  // Narrow to the orchestration event types this read model actually
  // consumes. The full `listByTaskId` was loading 1000+ stream_deltas
  // per task (~99% of which got filter-discarded in JS) and was the
  // dominant cost of the `/tasks` dashboard call after task_id
  // indexing landed.
  const ORCHESTRATION_EVENT_TYPES = [
    "executor_session.started",
    "executor_session.completed",
    "executor_session.failed",
    "task.manager.plan_created",
    "task.work_items.updated",
    "task.orchestration.stopped",
    "task.orchestration.transition",
  ] as const;
  const [events, runtimes] = await Promise.all([
    executionEventRepository.listByTaskIdAndTypes(taskId, ORCHESTRATION_EVENT_TYPES),
    roleRuntimeRepository.listByTaskId(taskId),
  ]);

  const storedManagerPlan = getStoredManagerPlanFromEvents(events);
  const latestSnapshot = getStoredWorkItemsSnapshotFromEvents(events);
  const storedWorkItemsSnapshot = options.preferStoredSnapshot ? latestSnapshot : null;
  const managerPlan =
    storedWorkItemsSnapshot?.managerPlan ??
    storedManagerPlan ??
    (!storedManagerPlan ? latestSnapshot?.managerPlan ?? null : null);
  const workItemDefinitions =
    storedWorkItemsSnapshot?.workItems.length
      ? storedWorkItemsSnapshot.workItems
      : managerPlan?.childRuns.length
        ? managerPlan.childRuns
        : (latestSnapshot?.workItems ?? []);

  const latestRuntimeByRole = new Map<string, (typeof runtimes)[number]>();
  for (const runtime of [...runtimes].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    if (!latestRuntimeByRole.has(runtime.roleId)) {
      latestRuntimeByRole.set(runtime.roleId, runtime);
    }
  }

  const reportingRoleIds = getReportingRoleIds({
    workItemDefinitions,
    latestRuntimeByRole,
  });

  const roleProgress: OrchestrationRoleProgress[] = [];

  for (const roleId of reportingRoleIds) {
    const runtime = latestRuntimeByRole.get(roleId);
    if (!runtime) {
      continue;
    }

    const runtimeEvents = (await executionEventRepository.listByRoleRuntimeIdAndTypes(runtime.id, [
      "executor_session.completed",
      "executor_session.failed",
      "executor_session.started",
      "task.orchestration.stopped",
      "task.orchestration.transition",
    ])).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const payload = parsePayload(runtimeEvents[0]?.payloadJson);
    const summary = readPayloadString(payload, [
      "lastMessagePreview",
      "summary",
      "message",
      "error",
      "dispatchMessage",
    ]);

    roleProgress.push({
      roleId,
      state: runtime.state,
      ...(runtime.activeExecutorId ? { executorId: runtime.activeExecutorId } : {}),
      ...(runtime.id ? { runId: runtime.id } : {}),
      ...(summary ? { summary } : {}),
    });
  }

  const snapshotRoleProgress = storedWorkItemsSnapshot?.roleProgress ?? latestSnapshot?.roleProgress ?? [];
  if (snapshotRoleProgress.length) {
    for (const storedProgress of snapshotRoleProgress) {
      if (
        reportingRoleIds.includes(storedProgress.roleId) &&
        !roleProgress.some((item) => item.roleId === storedProgress.roleId)
      ) {
        roleProgress.push(storedProgress);
      }
    }
  }

  const workItems = buildWorkItems({
    workItemDefinitions,
    latestRuntimeByRole,
    roleProgress,
  });

  const latestHumanReadableEvent = [...events]
    .filter((event) =>
      ["executor_session.completed", "executor_session.failed", "task.orchestration.stopped"].includes(
        event.type,
      ),
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  const latestAnswer =
    storedWorkItemsSnapshot?.latestAnswer ??
    readLatestAnswerFromEvent(latestHumanReadableEvent ?? null) ??
    null;

  const completedCapabilities = roleProgress
    .filter((item) => item.state === "COMPLETED")
    .map((item) => item.roleId);
  const pendingCapabilities = workItems
    .filter((item) => item.executionStatus === "ready" || item.executionStatus === "waiting_on_dependencies" || item.executionStatus === "running")
    .map((item) => item.roleId);
  const blockedCapabilities = workItems
    .filter((item) => item.executionStatus === "blocked")
    .map((item) => item.roleId);
  const nextCapability =
    workItems.find((item) => item.executionStatus === "ready")?.roleId ??
    workItems.find((item) => item.executionStatus === "running")?.roleId ??
    workItems.find((item) => item.executionStatus === "waiting_on_dependencies")?.roleId ??
    null;

  return {
    leaderPlan: managerPlan,
    managerPlan,
    roleProgress,
    workItems,
    latestAnswer,
    completedCapabilities,
    pendingCapabilities,
    blockedCapabilities,
    nextCapability,
  };
}

export async function getTaskOrchestrationReadModel(
  taskId: string,
): Promise<TaskOrchestrationReadModel> {
  return getTaskOrchestrationReadModelInternal(taskId, {
    preferStoredSnapshot: true,
  });
}

export async function getFreshTaskOrchestrationReadModel(
  taskId: string,
): Promise<TaskOrchestrationReadModel> {
  return getTaskOrchestrationReadModelInternal(taskId, {
    preferStoredSnapshot: false,
  });
}
