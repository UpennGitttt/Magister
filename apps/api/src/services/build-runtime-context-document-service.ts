import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getTaskOrchestrationHistory } from "./get-task-orchestration-history-service";
import { getTaskOrchestrationReadModel } from "./orchestration-read-model-service";

type RuntimeContextTaskSnapshot = {
  id: string;
  workspaceId: string;
  state: string;
  title?: string;
  description?: string | null;
};

type RuntimeContextRuntimeSnapshot = {
  id: string;
  roleId: string;
  state: string;
  attemptCount: number;
  priorSessionId?: string | null;
  priorWorkdir?: string | null;
  resumePolicy?: string | null;
  workspaceStrategyOverride?: string | null;
  delegationMode?: string | null;
};

type RuntimeContextDocumentEvent = {
  id: string;
  type: string;
  occurredAt: string;
  severity?: string | null;
  message?: string;
  source?: string;
  command?: string;
};

export type RuntimeContextDocument = {
  task: {
    id: string;
    title: string;
    state: string;
    source: string;
  };
  run: {
    id: string;
    roleId: string;
    state: string;
    attemptCount: number;
  };
  continuity: {
    priorSessionId: string | null;
    priorWorkdir: string | null;
    resumePolicy: string | null;
    workspaceStrategyOverride?: string | null;
  };
  managerPlan: {
    taskType?: string;
    coordinationAction?: string;
    plannedCapabilities: string[];
  } | null;
  orchestration: {
    nextCapability: string | null;
    completedCapabilities: string[];
    pendingCapabilities: string[];
    blockedCapabilities: string[];
  };
  recentEvents: RuntimeContextDocumentEvent[];
};

export type RuntimeContextDocumentBundle = {
  document: RuntimeContextDocument;
  json: string;
  markdown: string;
  summary: string;
};

function parsePayload(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unique(values: string[]) {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

function dedupeEvents(events: RuntimeContextDocumentEvent[]) {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) {
      return false;
    }
    seen.add(event.id);
    return true;
  });
}

function summarizeRecentEvent(event: {
  type: string;
  payloadJson?: string | null;
  occurredAt: Date;
  id: string;
  severity?: string | null;
}) {
  const payload = parsePayload(event.payloadJson);
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.severity ? { severity: event.severity } : {}),
    ...(typeof payload?.message === "string" && payload.message.trim().length > 0
      ? { message: payload.message.trim() }
      : {}),
    ...(typeof payload?.source === "string" && payload.source.trim().length > 0
      ? { source: payload.source.trim() }
      : {}),
    ...(typeof payload?.command === "string" && payload.command.trim().length > 0
      ? { command: payload.command.trim() }
      : {}),
  };
}

function renderMarkdown(document: RuntimeContextDocument) {
  const managerPlanLines = document.managerPlan
    ? [
        `- Task Type: \`${document.managerPlan.taskType ?? "unknown"}\``,
        `- Coordination Action: \`${document.managerPlan.coordinationAction ?? "unknown"}\``,
        `- Planned Capabilities: ${document.managerPlan.plannedCapabilities.length > 0 ? document.managerPlan.plannedCapabilities.map((capability) => `\`${capability}\``).join(", ") : "`none`"}`,
      ]
    : ["- None"];

  const recentEventLines =
    document.recentEvents.length > 0
      ? document.recentEvents.map((event) => {
          const details = [event.message, event.source, event.command]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .join(" | ");
          return `- ${event.type} @ ${event.occurredAt}${details ? ` - ${details}` : ""}`;
        })
      : ["- None"];

  return [
    "# Runtime Context",
    "",
    "## Task",
    `- Task ID: \`${document.task.id}\``,
    `- Title: ${document.task.title}`,
    `- State: \`${document.task.state}\``,
    `- Source: \`${document.task.source}\``,
    "",
    "## Run",
    `- Run ID: \`${document.run.id}\``,
    `- Role: \`${document.run.roleId}\``,
    `- State: \`${document.run.state}\``,
    `- Attempt Count: \`${document.run.attemptCount}\``,
    "",
    "## Continuity",
    `- Prior Session: ${document.continuity.priorSessionId ? `\`${document.continuity.priorSessionId}\`` : "`none`"}`,
    `- Prior Workdir: ${document.continuity.priorWorkdir ? `\`${document.continuity.priorWorkdir}\`` : "`none`"}`,
    `- Resume Policy: ${document.continuity.resumePolicy ? `\`${document.continuity.resumePolicy}\`` : "`none`"}`,
    `- Workspace Strategy Override: ${document.continuity.workspaceStrategyOverride ? `\`${document.continuity.workspaceStrategyOverride}\`` : "`none`"}`,
    "",
    "## Manager Plan",
    ...managerPlanLines,
    "",
    "## Orchestration",
    `- Next Capability: ${document.orchestration.nextCapability ? `\`${document.orchestration.nextCapability}\`` : "`none`"}`,
    `- Completed: ${document.orchestration.completedCapabilities.length > 0 ? document.orchestration.completedCapabilities.map((capability) => `\`${capability}\``).join(", ") : "`none`"}`,
    `- Pending: ${document.orchestration.pendingCapabilities.length > 0 ? document.orchestration.pendingCapabilities.map((capability) => `\`${capability}\``).join(", ") : "`none`"}`,
    `- Blocked: ${document.orchestration.blockedCapabilities.length > 0 ? document.orchestration.blockedCapabilities.map((capability) => `\`${capability}\``).join(", ") : "`none`"}`,
    "",
    "## Recent Events",
    ...recentEventLines,
  ].join("\n");
}

function buildSummary(document: RuntimeContextDocument) {
  const nextCapability = document.orchestration.nextCapability ?? "none";
  return `Task ${document.task.id} / Run ${document.run.id} / Role ${document.run.roleId} / Next ${nextCapability}`;
}

export async function buildRuntimeContextDocument(input: {
  task: RuntimeContextTaskSnapshot;
  runtime: RuntimeContextRuntimeSnapshot;
}): Promise<RuntimeContextDocumentBundle | null> {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const [taskRecord, runtimeRecord, orchestrationReadModel, orchestrationHistory, recentRunEvents] =
    await Promise.all([
      taskRepository.getById(input.task.id),
      roleRuntimeRepository.getById(input.runtime.id),
      getTaskOrchestrationReadModel(input.task.id),
      getTaskOrchestrationHistory(input.task.id),
      executionEventRepository.listByRoleRuntimeId(input.runtime.id),
    ]);

  const task = taskRecord ?? input.task;
  const runtime = runtimeRecord ?? input.runtime;
  const managerPlan = orchestrationReadModel?.managerPlan ?? null;
  const plannedCapabilities = managerPlan
    ? unique(
        managerPlan.childRuns.length > 0
          ? managerPlan.childRuns.map((childRun) => childRun.roleId)
          : orchestrationReadModel?.workItems.map((workItem) => workItem.roleId) ?? [],
      )
    : [];
  const recentHistoryEvents = orchestrationHistory?.items.slice(-6).map((item) => ({
    id: item.id,
    type: item.type,
    occurredAt: item.occurredAt,
    ...(typeof item.summary === "string" && item.summary.length > 0 ? { message: item.summary } : {}),
    ...(typeof item.roleId === "string" ? { source: item.roleId } : {}),
  })) ?? [];

  const document: RuntimeContextDocument = {
    task: {
      id: task.id,
      title: task.title ?? task.id,
      state: task.state,
      source: typeof taskRecord?.source === "string" && taskRecord.source.trim().length > 0 ? taskRecord.source : "unknown",
    },
    run: {
      id: runtime.id,
      roleId: runtime.roleId,
      state: runtime.state,
      attemptCount: runtime.attemptCount,
    },
    continuity: {
      priorSessionId: runtime.priorSessionId?.trim() ?? null,
      priorWorkdir: runtime.priorWorkdir?.trim() ?? null,
      resumePolicy: runtime.resumePolicy?.trim() ?? null,
      ...(runtime.workspaceStrategyOverride?.trim()
        ? { workspaceStrategyOverride: runtime.workspaceStrategyOverride.trim() }
        : {}),
    },
    managerPlan: managerPlan
      ? {
          ...(typeof managerPlan.taskType === "string" ? { taskType: managerPlan.taskType } : {}),
          ...(typeof managerPlan.coordinationAction === "string"
            ? { coordinationAction: managerPlan.coordinationAction }
            : {}),
          plannedCapabilities,
        }
      : null,
    orchestration: {
      nextCapability: orchestrationReadModel?.nextCapability ?? null,
      completedCapabilities: orchestrationReadModel?.completedCapabilities ?? [],
      pendingCapabilities: orchestrationReadModel?.pendingCapabilities ?? [],
      blockedCapabilities: orchestrationReadModel?.blockedCapabilities ?? [],
    },
    recentEvents: [
      ...recentRunEvents
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        .slice(0, 4)
        .map(summarizeRecentEvent),
      ...recentHistoryEvents,
    ] as RuntimeContextDocumentEvent[],
  };

  document.recentEvents = dedupeEvents(document.recentEvents);

  return {
    document,
    json: `${JSON.stringify(document, null, 2)}\n`,
    markdown: `${renderMarkdown(document)}\n`,
    summary: buildSummary(document),
  };
}
