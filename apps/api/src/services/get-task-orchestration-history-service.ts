import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";
import {
  deriveCoordinationAction,
  mapLegacyPlanningModeToDecisionMode,
  type TaskManagerDecisionMode,
} from "./task-manager-decision-service";
import type { TaskManagerCoordinationAction } from "./planner-hints";

export type TaskOrchestrationHistoryEventType =
  | "task.manager.plan_created"
  | "task.work_items.updated"
  | "task.orchestration.transition"
  | "task.orchestration.waiting"
  | "task.orchestration.stopped";

export type TaskOrchestrationHistoryItem = {
  id: string;
  sourceEventType: string;
  type: TaskOrchestrationHistoryEventType;
  occurredAt: string;
  summary: string;
  latestAnswer?: string;
  nextCapability?: string;
  roleRuntimeId?: string;
  roleId?: string;
  taskState?: string;
  transition?: string;
  action?: string;
  stopReason?: string;
  waitReason?: string;
  nextWakeupAt?: string;
  nextRoleId?: string;
  createdRoleIds?: string[];
  managerPlan?: {
    decisionMode?: TaskManagerDecisionMode;
    coordinationAction?: TaskManagerCoordinationAction;
    planningMode?: string;
    executionMode?: "immediate" | "bounded_execution" | "long_running";
    taskType: string;
    goal?: string;
    needsHuman?: boolean;
    confidence?: string;
    stopCondition?: string;
    source?: string;
    warnings?: string[];
    detectedSignals?: string[];
    childRuns: Array<{
      subagentType: string;
      roleId: string;
      state: string;
      dependsOn: string[];
      goal?: string;
      executionKind?: "delegated_subagent";
      whyThisInvocation?: string;
      whyThisWorkItem?: string;
      completionSignal?: string;
      handoffNotes?: string;
      primaryAdapterId?: string;
      routingStrategy?: string;
      fallbackAdapterId?: string;
      executorClass?: string;
    }>;
  };
  workItems?: Array<{
    subagentType: string;
    roleId: string;
    state?: string;
    dependsOn: string[];
    goal?: string;
    executionKind?: "delegated_subagent";
    whyThisInvocation?: string;
    whyThisWorkItem?: string;
    completionSignal?: string;
    handoffNotes?: string;
    runtimeState?: string;
    executionStatus?: string;
    runId?: string;
    executorId?: string;
    primaryAdapterId?: string;
    routingStrategy?: string;
    fallbackAdapterId?: string;
    executorClass?: string;
    summary?: string;
  }>;
};

export type TaskOrchestrationHistory = {
  taskId: string;
  items: TaskOrchestrationHistoryItem[];
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

function readString(payload: Record<string, unknown> | null, keys: string[]) {
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

function readStringArray(payload: Record<string, unknown> | null, key: string) {
  if (!payload) {
    return [];
  }

  const candidate = payload[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function readInvocationTarget(record: Record<string, unknown>) {
  const subagentType =
    typeof record.subagentType === "string" && record.subagentType.trim().length > 0
      ? record.subagentType.trim()
      : null;
  const roleId =
    typeof record.roleId === "string" && record.roleId.trim().length > 0
      ? record.roleId.trim()
      : null;

  return subagentType ?? roleId;
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

function parseManagerPlan(
  payload: Record<string, unknown> | null,
): TaskOrchestrationHistoryItem["managerPlan"] | undefined {
  if (!payload) {
    return undefined;
  }

  const managerPlanSource =
    payload.managerPlan && typeof payload.managerPlan === "object"
      ? (payload.managerPlan as Record<string, unknown>)
      : payload;
  const taskType = typeof managerPlanSource.taskType === "string" ? managerPlanSource.taskType : null;
  const childRunsCandidate = managerPlanSource.childRuns;

  if (!taskType || !Array.isArray(childRunsCandidate)) {
    return undefined;
  }

  const normalizedDecisionMode =
    managerPlanSource.decisionMode === "direct_answer" ||
    managerPlanSource.decisionMode === "tool_answer" ||
    managerPlanSource.decisionMode === "clarify" ||
    managerPlanSource.decisionMode === "heuristic" ||
    managerPlanSource.decisionMode === "explicit_hints"
      ? managerPlanSource.decisionMode
      : typeof managerPlanSource.planningMode === "string"
        ? mapLegacyPlanningModeToDecisionMode(managerPlanSource.planningMode)
        : undefined;
  const normalizedCoordinationAction =
    managerPlanSource.coordinationAction === "direct_answer" ||
    managerPlanSource.coordinationAction === "tool_answer" ||
    managerPlanSource.coordinationAction === "clarify" ||
    managerPlanSource.coordinationAction === "assign" ||
    managerPlanSource.coordinationAction === "handoff" ||
    managerPlanSource.coordinationAction === "send_message"
      ? managerPlanSource.coordinationAction
      : deriveCoordinationAction({
          decisionMode: normalizedDecisionMode,
          childRunCount: childRunsCandidate.length,
        });
  const normalizedExecutionMode =
    managerPlanSource.executionMode === "immediate" ||
    managerPlanSource.executionMode === "bounded_execution" ||
    managerPlanSource.executionMode === "long_running"
      ? managerPlanSource.executionMode
      : undefined;

  return {
    ...(normalizedDecisionMode ? { decisionMode: normalizedDecisionMode } : {}),
    ...(normalizedCoordinationAction ? { coordinationAction: normalizedCoordinationAction } : {}),
    ...(typeof managerPlanSource.planningMode === "string"
      ? { planningMode: managerPlanSource.planningMode }
      : {}),
    ...(normalizedExecutionMode ? { executionMode: normalizedExecutionMode } : {}),
    taskType,
    ...(typeof managerPlanSource.goal === "string" ? { goal: managerPlanSource.goal } : {}),
    ...(typeof managerPlanSource.needsHuman === "boolean"
      ? { needsHuman: managerPlanSource.needsHuman }
      : {}),
    ...(typeof managerPlanSource.confidence === "string"
      ? { confidence: managerPlanSource.confidence }
      : {}),
    ...(typeof managerPlanSource.stopCondition === "string"
      ? { stopCondition: managerPlanSource.stopCondition }
      : {}),
    ...(typeof managerPlanSource.source === "string" ? { source: managerPlanSource.source } : {}),
    ...(Array.isArray(managerPlanSource.warnings)
      ? {
          warnings: managerPlanSource.warnings.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        }
      : {}),
    ...(Array.isArray(managerPlanSource.detectedSignals)
      ? {
          detectedSignals: managerPlanSource.detectedSignals.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        }
      : {}),
    childRuns: childRunsCandidate.flatMap((childRun) => {
      if (!childRun || typeof childRun !== "object") {
        return [];
      }

      const record = childRun as Record<string, unknown>;
      const invocationTarget = readInvocationTarget(record);
      if (!invocationTarget || typeof record.state !== "string") {
        return [];
      }

      const whyThisInvocation = readInvocationWhy(record);

      return [
        {
          subagentType: invocationTarget,
          roleId: invocationTarget,
          state: record.state,
          dependsOn: Array.isArray(record.dependsOn)
            ? record.dependsOn.filter((value): value is string => typeof value === "string")
            : [],
          ...(typeof record.goal === "string" ? { goal: record.goal } : {}),
          executionKind: "delegated_subagent" as const,
          ...(whyThisInvocation
            ? { whyThisInvocation, whyThisWorkItem: whyThisInvocation }
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

function parseWorkItems(payload: Record<string, unknown> | null) {
  if (!payload || !Array.isArray(payload.workItems)) {
    return undefined;
  }

  const workItems = payload.workItems.flatMap((workItem) => {
    if (!workItem || typeof workItem !== "object") {
      return [];
    }

    const record = workItem as Record<string, unknown>;
    const invocationTarget = readInvocationTarget(record);
    if (!invocationTarget) {
      return [];
    }

    const whyThisInvocation = readInvocationWhy(record);

    return [
      {
        subagentType: invocationTarget,
        roleId: invocationTarget,
        dependsOn: Array.isArray(record.dependsOn)
          ? record.dependsOn.filter((value): value is string => typeof value === "string")
          : [],
        ...(typeof record.state === "string" ? { state: record.state } : {}),
        ...(typeof record.goal === "string" ? { goal: record.goal } : {}),
        executionKind: "delegated_subagent" as const,
        ...(whyThisInvocation
          ? { whyThisInvocation, whyThisWorkItem: whyThisInvocation }
          : {}),
        ...(typeof record.completionSignal === "string"
          ? { completionSignal: record.completionSignal }
          : {}),
        ...(typeof record.handoffNotes === "string"
          ? { handoffNotes: record.handoffNotes }
          : {}),
        ...(typeof record.runtimeState === "string" ? { runtimeState: record.runtimeState } : {}),
        ...(typeof record.executionStatus === "string"
          ? { executionStatus: record.executionStatus }
          : {}),
        ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
        ...(typeof record.executorId === "string" ? { executorId: record.executorId } : {}),
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
        ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
      },
    ];
  });

  return workItems.length > 0 ? workItems : undefined;
}

function readHistorySummary(
  type: TaskOrchestrationHistoryEventType,
  payload: Record<string, unknown> | null,
) {
  if (type === "task.manager.plan_created") {
    return (
      readString(payload, ["message", "summary"]) ??
      `Manager planned delegated subagent work items: ${
        readStringArray(payload, "createdRoleIds").join(", ") || "the next delegated subagent steps"
      }`
    );
  }

  if (type === "task.work_items.updated") {
    return (
      readString(payload, ["message", "summary"]) ??
      `Work items updated for delegated subagent execution: ${
        readStringArray(payload, "createdRoleIds").join(", ") || "none"
      }`
    );
  }

  if (type === "task.orchestration.transition") {
    const transition = readString(payload, ["transition"]) ?? "advance";
    const nextRoleId = readString(payload, ["nextRoleId"]);
    return (
      readString(payload, ["message", "summary"]) ??
      `Task orchestration ${transition}${nextRoleId ? ` to ${nextRoleId}` : ""}`
    );
  }

  if (type === "task.orchestration.waiting") {
    return (
      readString(payload, ["message", "summary"]) ??
      `Task orchestration is waiting${readString(payload, ["waitReason"]) ? ` for ${readString(payload, ["waitReason"])}` : ""}`
    );
  }

  return (
    readString(payload, ["message", "summary"]) ??
    `Task orchestration stopped${readString(payload, ["stopReason"]) ? ` because ${readString(payload, ["stopReason"])}` : ""}`
  );
}

function buildCanonicalHistoryItem(input: {
  id: string;
  sourceEventType: string;
  type: TaskOrchestrationHistoryEventType;
  occurredAt: Date;
  payloadJson?: string | null;
}): TaskOrchestrationHistoryItem {
  const payload = parsePayload(input.payloadJson);
  const item: TaskOrchestrationHistoryItem = {
    id: input.id,
    sourceEventType: input.sourceEventType,
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    summary: readHistorySummary(input.type, payload),
  };
  const roleRuntimeId = readString(payload, ["roleRuntimeId"]);
  const roleId = readString(payload, ["roleId"]);
  const taskState = readString(payload, ["taskState"]);
  const transition = readString(payload, ["transition"]);
  const action = readString(payload, ["action"]);
  const stopReason = readString(payload, ["stopReason"]);
  const waitReason = readString(payload, ["waitReason"]);
  const nextWakeupAt = readString(payload, ["nextWakeupAt"]);
  const nextRoleId = readString(payload, ["nextRoleId"]);
  const nextCapability = readString(payload, ["nextCapability", "nextRoleId"]);
  const createdRoleIds = readStringArray(payload, "createdRoleIds");
  const latestAnswer = readString(payload, ["latestAnswer"]);
  const managerPlan = parseManagerPlan(payload);
  const workItems = parseWorkItems(payload);

  if (roleRuntimeId) {
    item.roleRuntimeId = roleRuntimeId;
  }
  if (roleId) {
    item.roleId = roleId;
  }
  if (taskState) {
    item.taskState = taskState;
  }
  if (transition) {
    item.transition = transition;
  }
  if (action) {
    item.action = action;
  }
  if (stopReason) {
    item.stopReason = stopReason;
  }
  if (waitReason) {
    item.waitReason = waitReason;
  }
  if (nextWakeupAt) {
    item.nextWakeupAt = nextWakeupAt;
  }
  if (nextRoleId) {
    item.nextRoleId = nextRoleId;
  }
  if (nextCapability) {
    item.nextCapability = nextCapability;
  }
  if (createdRoleIds.length > 0) {
    item.createdRoleIds = createdRoleIds;
  }
  if (latestAnswer) {
    item.latestAnswer = latestAnswer;
  }
  if (managerPlan) {
    item.managerPlan = managerPlan;
  }
  if (workItems) {
    item.workItems = workItems;
  }

  return item;
}

function expandLegacyManagerFollowupEvent(input: {
  id: string;
  occurredAt: Date;
  payloadJson?: string | null;
}): TaskOrchestrationHistoryItem[] {
  const payload = parsePayload(input.payloadJson);
  const createdRoleIds = readStringArray(payload, "createdRoleIds");
  const nextRoleId = readString(payload, ["nextRoleId"]);
  const nextCapability = readString(payload, ["nextCapability", "nextRoleId"]);
  const roleRuntimeId = readString(payload, ["roleRuntimeId"]);
  const latestAnswer = readString(payload, ["latestAnswer"]);
  const managerPlan = parseManagerPlan(payload);
  const workItems = parseWorkItems(payload);

  const summary =
    readString(payload, ["message", "summary"]) ??
    "Manager planned delegated subagent follow-up work items";

  const planCreated: TaskOrchestrationHistoryItem = {
    id: `${input.id}:plan`,
    sourceEventType: "manager.followups_seeded",
    type: "task.manager.plan_created" as const,
    occurredAt: input.occurredAt.toISOString(),
    summary,
  };
  if (roleRuntimeId) {
    planCreated.roleRuntimeId = roleRuntimeId;
  }
  if (createdRoleIds.length > 0) {
    planCreated.createdRoleIds = createdRoleIds;
  }
  if (nextCapability) {
    planCreated.nextCapability = nextCapability;
  }
  if (latestAnswer) {
    planCreated.latestAnswer = latestAnswer;
  }
  if (managerPlan) {
    planCreated.managerPlan = managerPlan;
  }

  const workItemsUpdated: TaskOrchestrationHistoryItem = {
    id: `${input.id}:work_items`,
    sourceEventType: "manager.followups_seeded",
    type: "task.work_items.updated" as const,
    occurredAt: input.occurredAt.toISOString(),
    summary:
      readString(payload, ["message", "summary"]) ??
      `Work items updated for delegated subagent execution: ${createdRoleIds.join(", ") || "none"}`,
  };
  if (roleRuntimeId) {
    workItemsUpdated.roleRuntimeId = roleRuntimeId;
  }
  if (createdRoleIds.length > 0) {
    workItemsUpdated.createdRoleIds = createdRoleIds;
  }
  if (nextRoleId) {
    workItemsUpdated.nextRoleId = nextRoleId;
  }
  if (nextCapability) {
    workItemsUpdated.nextCapability = nextCapability;
  }
  if (latestAnswer) {
    workItemsUpdated.latestAnswer = latestAnswer;
  }
  if (managerPlan) {
    workItemsUpdated.managerPlan = managerPlan;
  }
  if (workItems) {
    workItemsUpdated.workItems = workItems;
  }

  return [planCreated, workItemsUpdated];
}

export async function getTaskOrchestrationHistory(taskId: string): Promise<TaskOrchestrationHistory | null> {
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const task = await taskRepository.getById(taskId);
  if (!task) {
    return null;
  }

  const events = await executionEventRepository.listByTaskId(taskId);
  const items: TaskOrchestrationHistoryItem[] = events.flatMap((event) => {
    if (event.type === "task.manager.plan_created") {
      return [
        buildCanonicalHistoryItem({
          id: event.id,
          sourceEventType: event.type,
          type: "task.manager.plan_created",
          occurredAt: event.occurredAt,
          payloadJson: event.payloadJson,
        }),
      ];
    }

    if (event.type === "task.work_items.updated") {
      return [
        buildCanonicalHistoryItem({
          id: event.id,
          sourceEventType: event.type,
          type: "task.work_items.updated",
          occurredAt: event.occurredAt,
          payloadJson: event.payloadJson,
        }),
      ];
    }

    if (event.type === "task.orchestration.transition") {
      return [
        buildCanonicalHistoryItem({
          id: event.id,
          sourceEventType: event.type,
          type: "task.orchestration.transition",
          occurredAt: event.occurredAt,
          payloadJson: event.payloadJson,
        }),
      ];
    }

    if (event.type === "task.orchestration.stopped") {
      return [
        buildCanonicalHistoryItem({
          id: event.id,
          sourceEventType: event.type,
          type: "task.orchestration.stopped",
          occurredAt: event.occurredAt,
          payloadJson: event.payloadJson,
        }),
      ];
    }

    if (event.type === "task.orchestration.waiting") {
      return [
        buildCanonicalHistoryItem({
          id: event.id,
          sourceEventType: event.type,
          type: "task.orchestration.waiting",
          occurredAt: event.occurredAt,
          payloadJson: event.payloadJson,
        }),
      ];
    }

    if (event.type === "manager.followups_seeded") {
      return expandLegacyManagerFollowupEvent({
        id: event.id,
        occurredAt: event.occurredAt,
        payloadJson: event.payloadJson,
      });
    }

    return [];
  });

  return {
    taskId: task.id,
    items: items.sort((left, right) => {
      const timeDiff = new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }

      return left.id.localeCompare(right.id);
    }),
  };
}
