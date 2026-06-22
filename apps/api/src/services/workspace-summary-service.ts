import { ApprovalRepository } from "../repositories/approval-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { TaskSummaryStore } from "../observability/task-summary-store";
import { getAdapterHealthList } from "./adapter-health-service";
import { getArtifactRetentionStatus } from "./artifact-retention-service";
import type { TaskSummary } from "./materialize-task-summary-service";
import { getTaskOrchestrationReadModel } from "./orchestration-read-model-service";

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

function readPayloadString(
  value: Record<string, unknown> | null | undefined,
  keys: string[],
) {
  if (!value) {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function readPayloadStringArray(
  value: Record<string, unknown> | null | undefined,
  key: string,
) {
  if (!value) {
    return [];
  }

  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function buildNextWorkItemSummary(nextPlannedWorkItem: {
  roleId: string;
  whyThisWorkItem?: string | null;
  goal?: string | null;
}) {
  const role = nextPlannedWorkItem.roleId.trim();
  if (!role) {
    return null;
  }

  const why =
    nextPlannedWorkItem.whyThisWorkItem?.trim() ||
    nextPlannedWorkItem.goal?.trim() ||
    "待补充";

  return `下一步：${role} · 为什么：${why}`;
}

function isOrchestrationEvent(type: string) {
  return (
    type === "task.orchestration.transition" ||
    type === "task.orchestration.waiting" ||
    type === "task.orchestration.stopped" ||
    type === "task.manager.plan_created" ||
    type === "task.work_items.updated"
  );
}

type OrchestrationReadModel = Awaited<ReturnType<typeof getTaskOrchestrationReadModel>>;
type TaskBlockedNarrative = NonNullable<TaskSummary["blockedNarrative"]>;

function buildManagerPlanFromReadModel(orchestration: OrchestrationReadModel) {
  return orchestration.managerPlan
      ? {
          decisionMode: orchestration.managerPlan.decisionMode ?? null,
          coordinationAction: orchestration.managerPlan.coordinationAction ?? null,
          planningMode: orchestration.managerPlan.planningMode ?? null,
        executionMode: orchestration.managerPlan.executionMode ?? null,
        taskType: orchestration.managerPlan.taskType,
        goal: orchestration.managerPlan.goal ?? null,
        needsHuman:
          typeof orchestration.managerPlan.needsHuman === "boolean"
            ? orchestration.managerPlan.needsHuman
            : null,
        confidence: orchestration.managerPlan.confidence ?? null,
        stopCondition: orchestration.managerPlan.stopCondition ?? null,
        source: orchestration.managerPlan.source ?? null,
        warnings: orchestration.managerPlan.warnings ?? [],
        detectedSignals: orchestration.managerPlan.detectedSignals ?? [],
        childRuns: orchestration.managerPlan.childRuns.map((childRun) => ({
          roleId: childRun.roleId,
          state: childRun.state,
          dependsOn: childRun.dependsOn,
          ...(childRun.goal ? { goal: childRun.goal } : {}),
          ...(childRun.whyThisWorkItem ? { whyThisWorkItem: childRun.whyThisWorkItem } : {}),
          ...(childRun.completionSignal ? { completionSignal: childRun.completionSignal } : {}),
          ...(childRun.handoffNotes ? { handoffNotes: childRun.handoffNotes } : {}),
          ...(childRun.primaryAdapterId ? { primaryAdapterId: childRun.primaryAdapterId } : {}),
          ...(childRun.routingStrategy ? { routingStrategy: childRun.routingStrategy } : {}),
          ...(childRun.fallbackAdapterId ? { fallbackAdapterId: childRun.fallbackAdapterId } : {}),
          ...(childRun.executorClass ? { executorClass: childRun.executorClass } : {}),
        })),
        capabilityProgress: orchestration.roleProgress.map((capability) => ({
          roleId: capability.roleId,
          state: capability.state,
          ...(capability.executorId ? { executorId: capability.executorId } : {}),
          ...(capability.runId ? { runId: capability.runId } : {}),
          ...(capability.summary ? { summary: capability.summary } : {}),
        })),
        completedCapabilities: orchestration.completedCapabilities,
        pendingCapabilities: orchestration.pendingCapabilities,
        blockedCapabilities: orchestration.blockedCapabilities,
        nextCapability: orchestration.nextCapability,
        workItems: orchestration.workItems.map((workItem) => ({
          roleId: workItem.roleId,
          state: workItem.state,
          dependsOn: workItem.dependsOn,
          runtimeState: workItem.runtimeState,
          executionStatus: workItem.executionStatus,
          ...(workItem.goal ? { goal: workItem.goal } : {}),
          ...(workItem.whyThisWorkItem ? { whyThisWorkItem: workItem.whyThisWorkItem } : {}),
          ...(workItem.completionSignal ? { completionSignal: workItem.completionSignal } : {}),
          ...(workItem.handoffNotes ? { handoffNotes: workItem.handoffNotes } : {}),
          ...(workItem.primaryAdapterId ? { primaryAdapterId: workItem.primaryAdapterId } : {}),
          ...(workItem.routingStrategy ? { routingStrategy: workItem.routingStrategy } : {}),
          ...(workItem.fallbackAdapterId ? { fallbackAdapterId: workItem.fallbackAdapterId } : {}),
          ...(workItem.executorClass ? { executorClass: workItem.executorClass } : {}),
          ...(workItem.runId ? { runId: workItem.runId } : {}),
          ...(workItem.executorId ? { executorId: workItem.executorId } : {}),
          ...(workItem.summary ? { summary: workItem.summary } : {}),
        })),
      }
    : null;
}

export type WorkspaceSummary = {
  activeTaskCount: number;
  blockedTaskCount: number;
  failedRunCount: number;
  pendingApprovalCount: number;
  degradedAdapterCount: number;
  artifactRetention: {
    enabled: boolean;
    inFlight: boolean;
    intervalMs: number;
    graceMs: number;
    lastTickAt: string | null;
    lastWindowStart: string | null;
    lastScannedTaskCount: number;
    lastEligibleTaskCount: number;
    lastCleanedTaskIds: string[];
    lastDeletedArtifactIds: string[];
    lastFailedTaskIds: string[];
    lastFailureAt: string | null;
    lastFailureTaskId: string | null;
    lastFailureMessage: string | null;
  };
  taskQueue: Array<{
    taskId: string;
    title: string;
    state: string;
    source: string;
    workspaceId: string;
    updatedAt: string;
    latestAnswer?: string | null;
    nextWorkItemSummary?: string | null;
    nextWorkItemWhyThisWorkItem?: string | null;
    executionMode?: string | null;
    nextCapability?: string | null;
    waitReason?: string | null;
    nextWakeupAt?: string | null;
    blockedNarrative?: TaskBlockedNarrative;
    latestBlocker?: string;
    approvalState?: string;
    leaderConfidence?: string | null;
    leaderWarnings?: string[];
    managerConfidence?: string | null;
    managerWarnings?: string[];
    plannerConfidence?: string | null;
    needsHuman?: boolean | null;
  }>;
  attentionItems: Array<{
    id: string;
    type:
      | "approval_pending"
      | "task_blocked"
      | "manager_attention"
      | "planner_attention"
      | "executor_degraded";
    severity: "info" | "warn" | "error";
    occurredAt: string;
    title: string;
    summary: string;
    taskId?: string | null;
    runId?: string | null;
    roleId?: string | null;
    adapterId?: string | null;
  }>;
  recentImportantEvents: Array<{
    id: string;
    type: string;
    severity?: string | null;
    occurredAt: string;
    taskId?: string | null;
    taskTitle?: string | null;
    summary?: string | null;
    roleId?: string | null;
    executorId?: string | null;
    orchestrationDecision?: {
      transition: string | null;
      reason: string | null;
      state: string | null;
      taskState: string | null;
      roleId: string | null;
      roleRuntimeId: string | null;
      nextRoleId: string | null;
      createdRoleIds: string[];
    } | null;
    managerPlan?: {
      decisionMode: string | null;
      coordinationAction: string | null;
      planningMode: string | null;
      taskType: string | null;
      goal: string | null;
      needsHuman: boolean | null;
      confidence: string | null;
      stopCondition: string | null;
      source: string | null;
      warnings: string[];
      detectedSignals: string[];
      childRuns: Array<{
        roleId: string;
        state: string;
        dependsOn: string[];
        goal?: string;
        whyThisWorkItem?: string;
        completionSignal?: string;
        handoffNotes?: string;
        primaryAdapterId?: string;
        routingStrategy?: string;
        fallbackAdapterId?: string;
        executorClass?: string;
      }>;
      capabilityProgress?: Array<{
        roleId: string;
        state: string;
        executorId?: string | null;
        runId?: string | null;
        summary?: string | null;
      }>;
      completedCapabilities?: string[];
      pendingCapabilities?: string[];
      blockedCapabilities?: string[];
      nextCapability?: string | null;
      workItems?: Array<{
        roleId: string;
        state: string;
        dependsOn: string[];
        runtimeState: string;
        executionStatus: string;
        goal?: string;
        whyThisWorkItem?: string;
        completionSignal?: string;
        handoffNotes?: string;
        primaryAdapterId?: string;
        routingStrategy?: string;
        fallbackAdapterId?: string;
        executorClass?: string;
        runId?: string | null;
        executorId?: string | null;
        summary?: string | null;
      }>;
    } | null;
    orchestrationStop?: {
      stopReason: string | null;
      state: string | null;
      taskState: string | null;
      roleId: string | null;
      roleRuntimeId: string | null;
      nextRoleId: string | null;
      nextRunId: string | null;
      dispatchCode: string | null;
      dispatchMessage: string | null;
    } | null;
  }>;
};

export async function getWorkspaceSummary(): Promise<WorkspaceSummary> {
  const taskRepository = new TaskRepository();
  const taskSummaryStore = new TaskSummaryStore();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const approvalRepository = new ApprovalRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const [tasks, roleRuntimes, approvals, summaryEvents, adapters, artifactRetention] = await Promise.all([
    taskRepository.listAll(),
    roleRuntimeRepository.listAll(),
    approvalRepository.listAll(),
    executionEventRepository.listForWorkspaceSummary(),
    getAdapterHealthList(),
    getArtifactRetentionStatus(executionEventRepository),
  ]);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskSummaries = (
    await Promise.all(tasks.map((task) => taskSummaryStore.get(task.id)))
  ).filter((summary): summary is NonNullable<typeof summary> => summary !== null);
  const taskSummaryById = new Map(taskSummaries.map((task) => [task.id, task]));
  const runtimeById = new Map(roleRuntimes.map((runtime) => [runtime.id, runtime]));
  const orchestrationTaskIds = [
    ...new Set(
      taskSummaries
        .map((task) => task.id)
        .filter((taskId) => taskId.length > 0),
    ),
  ];
  const orchestrationByTaskId = new Map<string, OrchestrationReadModel>();
  await Promise.all(
    orchestrationTaskIds.map(async (taskId) => {
      orchestrationByTaskId.set(taskId, await getTaskOrchestrationReadModel(taskId));
    }),
  );
  const taskQueue = [...taskSummaries]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .map((task) => {
      const orchestration = orchestrationByTaskId.get(task.id);
      const nextPlannedWorkItem =
        (orchestration?.nextCapability
          ? orchestration.workItems.find((item) => item.roleId === orchestration.nextCapability)
          : null) ??
        orchestration?.workItems[0] ??
        null;
      return {
        taskId: task.id,
        title: task.title,
        state: task.state,
        source: task.source,
        workspaceId: task.workspaceId,
        updatedAt: task.updatedAt.toISOString(),
        ...(task.latestAnswer ? { latestAnswer: task.latestAnswer } : {}),
        ...(nextPlannedWorkItem ? { nextWorkItemSummary: buildNextWorkItemSummary(nextPlannedWorkItem) } : {}),
        ...(nextPlannedWorkItem?.whyThisWorkItem
          ? { nextWorkItemWhyThisWorkItem: nextPlannedWorkItem.whyThisWorkItem }
          : {}),
        ...(orchestration?.managerPlan?.executionMode
          ? { executionMode: orchestration.managerPlan.executionMode }
          : task.executionMode
            ? { executionMode: task.executionMode }
            : {}),
        ...(task.nextCapability ? { nextCapability: task.nextCapability } : {}),
        ...(task.waitReason
          ? { waitReason: task.waitReason }
          : {}),
        ...(task.nextWakeupAt
          ? { nextWakeupAt: task.nextWakeupAt }
          : {}),
        ...(task.blockedNarrative ? { blockedNarrative: task.blockedNarrative } : {}),
        ...(task.latestBlocker ? { latestBlocker: task.latestBlocker } : {}),
        ...(task.approvalState ? { approvalState: task.approvalState } : {}),
        ...(task.leaderConfidence ? { leaderConfidence: task.leaderConfidence } : {}),
        ...(task.leaderWarnings?.length ? { leaderWarnings: task.leaderWarnings } : {}),
        ...(task.managerConfidence ? { managerConfidence: task.managerConfidence } : {}),
        ...(task.managerWarnings?.length ? { managerWarnings: task.managerWarnings } : {}),
        ...(task.plannerConfidence ? { plannerConfidence: task.plannerConfidence } : {}),
        ...(typeof task.needsHuman === "boolean" ? { needsHuman: task.needsHuman } : {}),
      };
    });
  const attentionItems = [
    ...approvals
      .filter((approval) => approval.state === "pending")
      .map((approval) => {
        const task = taskSummaryById.get(approval.taskId);
        return {
          id: `approval:${approval.id}`,
          type: "approval_pending" as const,
          severity: "warn" as const,
          occurredAt: approval.requestedAt.toISOString(),
          title: task?.title ?? approval.id,
          summary: `Approval ${approval.approvalType} is waiting on a human decision.`,
          taskId: approval.taskId,
          ...(approval.roleRuntimeId ? { runId: approval.roleRuntimeId } : {}),
        };
      }),
    ...taskSummaries
      .filter((task) => task.state === "BLOCKED" || Boolean(task.latestBlocker))
      .map((task) => ({
        id: `blocked:${task.id}`,
        type: "task_blocked" as const,
        severity: "error" as const,
        occurredAt: task.updatedAt.toISOString(),
        title: task.title,
        summary: task.blockedNarrative?.message ?? task.latestBlocker ?? "Task is blocked and needs inspection.",
        taskId: task.id,
        ...(task.latestRunId ? { runId: task.latestRunId } : {}),
      })),
    ...taskSummaries
      .filter((task) => task.needsHuman || task.plannerConfidence === "low")
      .map((task) => ({
        id: `manager:${task.id}`,
        type: "manager_attention" as const,
        severity: "warn" as const,
        occurredAt: task.updatedAt.toISOString(),
        title: task.title,
        summary:
          task.managerWarnings?.[0] ??
          task.plannerWarnings?.[0] ??
          "Manager flagged this task for human confirmation before widening the plan.",
        taskId: task.id,
        ...(task.latestRunId ? { runId: task.latestRunId } : {}),
      })),
    ...adapters
      .filter((adapter) => adapter.healthState === "degraded")
      .map((adapter) => ({
        id: `adapter:${adapter.adapterId}`,
        type: "executor_degraded" as const,
        severity: "warn" as const,
        occurredAt: new Date().toISOString(),
        title: adapter.displayName,
        summary: `${adapter.displayName} is degraded and may stall queued work items.`,
        adapterId: adapter.adapterId,
      })),
  ].sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());

  return {
    activeTaskCount: tasks.filter((task) => task.state === "IN_PROGRESS").length,
    blockedTaskCount: tasks.filter((task) => task.state === "BLOCKED").length,
    failedRunCount: roleRuntimes.filter((runtime) => runtime.state === "FAILED").length,
    pendingApprovalCount: approvals.filter((approval) => approval.state === "pending").length,
    degradedAdapterCount: adapters.filter((adapter) => adapter.healthState === "degraded").length,
    artifactRetention,
    taskQueue,
    attentionItems,
    recentImportantEvents: summaryEvents
      .filter((event) => event.severity === "warn" || event.severity === "error" || isOrchestrationEvent(event.type))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, 5)
      .map((event) => {
        const payload = parsePayload(event.payloadJson);
        const runtime = event.roleRuntimeId ? runtimeById.get(event.roleRuntimeId) : null;
        const task = event.taskId ? taskById.get(event.taskId) : null;
        const orchestration = event.taskId ? orchestrationByTaskId.get(event.taskId) : null;
        const summary =
          readPayloadString(payload, [
            "message",
            "summary",
            "error",
            "lastMessage",
            "lastMessagePreview",
            "reason",
            "stopReason",
            "dispatchMessage",
          ]) ??
          orchestration?.latestAnswer ??
          null;
        const orchestrationDecision =
          event.type === "task.orchestration.transition"
            ? {
                transition: readPayloadString(payload, ["transition"]),
                reason: readPayloadString(payload, ["reason", "message"]),
                state: readPayloadString(payload, ["state"]),
                taskState: readPayloadString(payload, ["taskState"]),
                roleId: readPayloadString(payload, ["roleId"]) ?? runtime?.roleId ?? null,
                roleRuntimeId: readPayloadString(payload, ["roleRuntimeId"]) ?? event.roleRuntimeId ?? null,
                nextRoleId: readPayloadString(payload, ["nextRoleId"]),
                createdRoleIds: readPayloadStringArray(payload, "createdRoleIds"),
              }
            : null;
        const managerPlan = orchestration ? buildManagerPlanFromReadModel(orchestration) : null;
        const orchestrationStop =
          event.type === "task.orchestration.stopped"
            ? {
                stopReason: readPayloadString(payload, ["stopReason", "reason", "message"]),
                state: readPayloadString(payload, ["state"]),
                taskState: readPayloadString(payload, ["taskState"]),
                roleId: readPayloadString(payload, ["roleId"]) ?? runtime?.roleId ?? null,
                roleRuntimeId: readPayloadString(payload, ["roleRuntimeId"]) ?? event.roleRuntimeId ?? null,
                nextRoleId: readPayloadString(payload, ["nextRoleId"]),
                nextRunId: readPayloadString(payload, ["nextRunId"]),
                dispatchCode: readPayloadString(payload, ["dispatchCode"]),
                dispatchMessage: readPayloadString(payload, ["dispatchMessage"]),
              }
            : null;

        return {
          id: event.id,
          type: event.type,
          severity: event.severity,
          occurredAt: event.occurredAt.toISOString(),
          taskId: event.taskId,
          taskTitle: task?.title ?? null,
          summary,
          roleId: runtime?.roleId ?? null,
          executorId: runtime?.activeExecutorId ?? null,
          orchestrationDecision,
          managerPlan,
          orchestrationStop,
        };
      }),
  };
}
