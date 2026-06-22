import { readFile } from "node:fs/promises";

import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { ArtifactRepository } from "../repositories/artifact-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getRunContext } from "./get-run-context-service";
import type { TaskManagerCoordinationAction } from "./planner-hints";
import { coerceGroundedManagerReply } from "./conversation-shortcut-service";
import { getTaskOrchestrationReadModel } from "./orchestration-read-model-service";

type QueueFeishuTaskCreatedSummaryInput = {
  bindingId: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  taskState: string;
  latestRunId?: string;
};

type QueueFeishuApprovalResolvedSummaryInput = {
  bindingId: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  approvalId: string;
  approvalType: string;
  approvalState: string;
  actorId?: string | null;
};

type QueueFeishuOrchestrationSummaryInput = {
  bindingId: string;
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  taskState: "COMPLETED" | "BLOCKED";
  stopReason: string;
  roleId?: string;
  roleRuntimeId?: string;
};

type FeishuRoleProgress = {
  roleId: string;
  state: string;
  executorId?: string;
  runId?: string;
  summary?: string;
};

type FeishuManagerPlan = {
  taskType: "conversation" | "coding" | "mixed";
  coordinationAction?: TaskManagerCoordinationAction;
  executionMode?: "immediate" | "bounded_execution" | "long_running";
  confidence?: "high" | "medium" | "low";
  needsHuman?: boolean;
  warnings?: string[];
  plannedCapabilities: string[];
  capabilityProgress: FeishuRoleProgress[];
  completedCapabilities: string[];
  pendingCapabilities: string[];
  blockedCapabilities: string[];
  nextCapability: string | null;
};

type FeishuTraceItem = {
  kind: "message" | "tool_call" | "tool_result" | "subagent" | "decision";
  text: string;
  roleId?: string;
  source?: string;
  executorId?: string;
  sessionId?: string;
  attemptCount?: number;
};

type RecentRunTraceEvent = {
  type: string;
  message?: string;
  source?: string;
  payloadJson?: string | null;
};

type TraceRuntimeMetadata = {
  roleId?: string | null;
  executorId?: string | null;
  sessionId?: string | null;
  attemptCount?: number | null;
};

type QueuedFeishuOutboundEvent<TPayload> = {
  eventId: string;
  payload: TPayload;
};

type OrchestrationSummaryPayload = Awaited<ReturnType<typeof buildOrchestrationSummaryPayload>>;

function trimSentence(value: string, limit = 180) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function extractStructuredOutcome(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const outcomeMatch =
    normalized.match(/\bOutcome\b\s*[:：]?\s*([\s\S]*)$/i) ??
    normalized.match(/(?:^|\s)结论\s*[:：]?\s*([\s\S]*)$/u) ??
    normalized.match(/(?:^|\s)结果\s*[:：]?\s*([\s\S]*)$/u);

  if (!outcomeMatch?.[1]) {
    return null;
  }

  const outcome = collapseWhitespace(outcomeMatch[1]);
  return outcome.length > 0 ? outcome : null;
}

function normalizeAnswerForDigest(value: string) {
  const normalized = collapseWhitespace(value);
  if (!normalized) {
    return normalized;
  }

  const structuredOutcome = extractStructuredOutcome(normalized);
  if (structuredOutcome) {
    return structuredOutcome;
  }

  return normalized;
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

function parseOutboundEventIdFromDeliveryPayload(payloadJson?: string | null) {
  const payload = parsePayload(payloadJson);
  const outboundEventId = payload?.outboundEventId;
  return typeof outboundEventId === "string" && outboundEventId.trim().length > 0
    ? outboundEventId
    : null;
}

function readRunTraceSummary(event: RecentRunTraceEvent, payload: Record<string, unknown> | null) {
  const eventMessage = typeof event.message === "string" && event.message.trim().length > 0 ? event.message.trim() : null;
  if (eventMessage) {
    return eventMessage;
  }

  const payloadMessage = readPayloadString(payload, [
    "message",
    "summary",
    "lastMessage",
    "lastMessagePreview",
    "text",
    "detail",
  ]);
  if (payloadMessage) {
    return payloadMessage;
  }

  if (event.type === "run.blocked") {
    const blockedReason = readPayloadString(payload, ["blockedReason", "reason"]);
    const nextCapability = readPayloadString(payload, ["nextCapability"]);

    if (blockedReason && nextCapability) {
      return `Run blocked: ${blockedReason}; next capability ${nextCapability}`;
    }

    if (blockedReason) {
      return `Run blocked: ${blockedReason}`;
    }
  }

  return null;
}

function isOrchestrationSummaryPayload(payload: Record<string, unknown> | null): payload is OrchestrationSummaryPayload {
  if (!payload) {
    return false;
  }

  return (
    payload.channel === "feishu" &&
    (payload.kind === "task_orchestration_completed" || payload.kind === "task_orchestration_blocked") &&
    typeof payload.taskId === "string" &&
    typeof payload.stopReason === "string"
  );
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

function classifyTaskTraceFromEvent(
  event: Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>[number],
  runtimeMetadata?: TraceRuntimeMetadata,
): FeishuTraceItem | null {
  const payload = parsePayload(event.payloadJson);

  if (event.type === "task.manager.plan_created") {
    const childRuns = Array.isArray(payload?.childRuns)
      ? payload.childRuns
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => item.roleId)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    return {
      kind: childRuns.length > 0 ? "subagent" : "decision",
      text:
        childRuns.length > 0
          ? `Leader 派生了 ${childRuns.join("、")} 这些内部工作项`
          : readPayloadString(payload, ["message", "summary"]) ?? "Leader 决定直接完成当前任务",
      source: "task_manager",
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "task.work_items.updated") {
    const summary = readPayloadString(payload, ["message", "summary"]);
    return summary
      ? {
          kind: "decision",
          text: summary,
          source: "task_manager",
          ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
          ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
          ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
          ...(typeof runtimeMetadata?.attemptCount === "number"
            ? { attemptCount: runtimeMetadata.attemptCount }
            : {}),
        }
      : null;
  }

  if (event.type === "task.orchestration.transition" || event.type === "task.orchestration.stopped") {
    const summary = readPayloadString(payload, ["message", "summary"]);
    return summary
      ? {
          kind: "decision",
          text: summary,
          ...(typeof payload?.roleId === "string" ? { roleId: payload.roleId } : {}),
          source: "task_manager",
          ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
          ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
          ...(typeof runtimeMetadata?.attemptCount === "number"
            ? { attemptCount: runtimeMetadata.attemptCount }
            : {}),
        }
      : null;
  }

  if (event.type === "executor_session.started") {
    const summary =
      readPayloadString(payload, ["message", "summary"]) ??
      (typeof payload?.command === "string" ? `执行器已启动：${payload.command}` : null);
    return summary
      ? {
          kind: "tool_call",
          text: trimSentence(summary, 160),
          ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
          ...(typeof payload?.source === "string" ? { source: payload.source } : {}),
          ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
          ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
          ...(typeof runtimeMetadata?.attemptCount === "number"
            ? { attemptCount: runtimeMetadata.attemptCount }
            : {}),
        }
      : null;
  }

  if (event.type === "executor_session.completed" || event.type === "executor_session.failed") {
    const summary =
      readPayloadString(payload, ["summary", "message", "lastMessage", "lastMessagePreview"]) ??
      readPayloadString(payload, ["error"]);
    return summary
      ? {
          kind: "tool_result",
          text: trimSentence(normalizeAnswerForDigest(summary), 160),
          ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
          ...(typeof payload?.source === "string" ? { source: payload.source } : {}),
          ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
          ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
          ...(typeof runtimeMetadata?.attemptCount === "number"
            ? { attemptCount: runtimeMetadata.attemptCount }
            : {}),
        }
      : null;
  }

  return null;
}

function classifyRunTraceFromEvent(
  event: RecentRunTraceEvent,
  runtimeMetadata?: TraceRuntimeMetadata,
): FeishuTraceItem | null {
  const payload = parsePayload(event.payloadJson);
  const summary = readRunTraceSummary(event, payload);
  if (!summary) {
    return null;
  }

  if (event.type === "run.started") {
    return {
      kind: "tool_call",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "run.progressed" || event.type === "run.message") {
    return {
      kind: "message",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "run.completed" || event.type === "run.failed") {
    return {
      kind: "tool_result",
      text: trimSentence(normalizeAnswerForDigest(summary), 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "run.blocked") {
    return {
      kind: "decision",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "tool.call") {
    return {
      kind: "tool_call",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "tool.result" || event.type === "tool.error") {
    return {
      kind: "tool_result",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (event.type === "approval.requested" || event.type === "run.started") {
    return {
      kind: "message",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  if (
    event.type === "executor_session.started" ||
    event.type === "executor_session.completed" ||
    event.type === "executor_session.failed"
  ) {
    return {
      kind: event.type === "executor_session.started" ? "tool_call" : "tool_result",
      text: trimSentence(summary, 160),
      ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
      ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
      ...(typeof runtimeMetadata?.attemptCount === "number"
        ? { attemptCount: runtimeMetadata.attemptCount }
        : {}),
    };
  }

  return {
    kind: "message",
    text: trimSentence(summary, 160),
    ...(runtimeMetadata?.roleId ? { roleId: runtimeMetadata.roleId } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(runtimeMetadata?.executorId ? { executorId: runtimeMetadata.executorId } : {}),
    ...(runtimeMetadata?.sessionId ? { sessionId: runtimeMetadata.sessionId } : {}),
    ...(typeof runtimeMetadata?.attemptCount === "number"
      ? { attemptCount: runtimeMetadata.attemptCount }
      : {}),
  };
}

async function collectRecentTrace(taskId: string): Promise<FeishuTraceItem[]> {
  const [executionEvents, roleRuntimes] = await Promise.all([
    new ExecutionEventRepository().listByTaskId(taskId),
    new RoleRuntimeRepository().listByTaskId(taskId),
  ]);

  const runtimeMetadataById = new Map(
    roleRuntimes.map((runtime) => [
      runtime.id,
      {
        roleId: runtime.roleId,
        executorId: runtime.activeExecutorId,
        sessionId: runtime.currentSessionId,
        attemptCount: runtime.attemptCount,
      } satisfies TraceRuntimeMetadata,
    ]),
  );

  const taskTraces = [...executionEvents]
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .map((event) => classifyTaskTraceFromEvent(event, runtimeMetadataById.get(event.roleRuntimeId ?? "")))
    .filter((item): item is FeishuTraceItem => Boolean(item))
    .slice(0, 4);

  const runContexts = await Promise.all(
    [...roleRuntimes]
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, 3)
      .map(async (runtime) => ({
        runtimeMetadata: {
          roleId: runtime.roleId,
          executorId: runtime.activeExecutorId,
          sessionId: runtime.currentSessionId,
          attemptCount: runtime.attemptCount,
        } satisfies TraceRuntimeMetadata,
        context: await getRunContext(runtime.id),
      })),
  );

  const runTraces = runContexts.flatMap(({ runtimeMetadata, context }) =>
    (context?.recentEvents ?? [])
      .map((event) => classifyRunTraceFromEvent(event, runtimeMetadata))
      .filter((item): item is FeishuTraceItem => Boolean(item))
      .slice(0, 2),
  );

  const deduped = [...taskTraces, ...runTraces].filter((item, index, all) => {
    const key = `${item.kind}:${item.roleId ?? ""}:${item.source ?? ""}:${item.text}`;
    return all.findIndex((candidate) => {
      const candidateKey = `${candidate.kind}:${candidate.roleId ?? ""}:${candidate.source ?? ""}:${candidate.text}`;
      return candidateKey === key;
    }) === index;
  });

  return deduped.slice(0, 6);
}

function readEventLatestAnswer(
  event: Awaited<ReturnType<ExecutionEventRepository["listByTaskId"]>>[number],
  roleId?: string,
) {
  const payload = parsePayload(event.payloadJson);
  const rawAnswer = readPayloadString(payload, [
    "lastMessage",
    "summary",
    "message",
    "lastMessagePreview",
    "dispatchMessage",
    "error",
  ]);

  if (roleId === "leader" && rawAnswer) {
    const structuredPayload = parsePayload(rawAnswer);
    const structuredReply = readPayloadString(structuredPayload, ["reply"]);
    if (structuredReply) {
      return structuredReply;
    }
  }

  return rawAnswer;
}

function looksTruncatedAnswer(value: string) {
  const normalized = value.trim();
  return normalized.endsWith("...") || normalized.endsWith("…");
}

async function readArtifactAnswer(
  artifact: Awaited<ReturnType<ArtifactRepository["listByTaskId"]>>[number] | undefined,
) {
  if (!artifact) {
    return null;
  }

  if (artifact.storageKind !== "file") {
    return null;
  }

  if (artifact.artifactType !== "execution_note" && artifact.artifactType !== "review") {
    return null;
  }

  try {
    const content = (await readFile(artifact.storageRef, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

async function resolvePreferredLatestAnswer(taskId: string, fallback: string | null) {
  const [task, events, runtimes, artifacts] = await Promise.all([
    new TaskRepository().getById(taskId),
    new ExecutionEventRepository().listByTaskId(taskId),
    new RoleRuntimeRepository().listByTaskId(taskId),
    new ArtifactRepository().listByTaskId(taskId),
  ]);

  const runtimeRoleById = new Map(runtimes.map((runtime) => [runtime.id, runtime.roleId]));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const terminalEvents = [...events]
    .filter((event) => event.type === "executor_session.completed" || event.type === "executor_session.failed")
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());

  const pickTerminalEvent = (
    matcher: (event: (typeof terminalEvents)[number]) => boolean,
  ) => {
    return terminalEvents.find((event) => {
      if (!matcher(event)) {
        return false;
      }

      const roleId = event.roleRuntimeId ? runtimeRoleById.get(event.roleRuntimeId) : undefined;
      const answerWithRole = readEventLatestAnswer(event, roleId);
      if (answerWithRole && answerWithRole.trim().length > 0) {
        return true;
      }

      return Boolean(event.artifactId);
    });
  };

  const preferredEvent =
    pickTerminalEvent((event) => {
      if (event.type !== "executor_session.completed") {
        return false;
      }
      const roleId = event.roleRuntimeId ? runtimeRoleById.get(event.roleRuntimeId) : undefined;
      return roleId !== "leader";
    }) ??
    pickTerminalEvent((event) => event.type === "executor_session.completed") ??
    pickTerminalEvent((event) => event.type === "executor_session.failed");

  let preferred =
    preferredEvent
      ? readEventLatestAnswer(
          preferredEvent,
          preferredEvent.roleRuntimeId ? runtimeRoleById.get(preferredEvent.roleRuntimeId) : undefined,
        )
      : null;
  if (preferred && preferred.trim().length > 0) {
    preferred = preferred.trim();
  } else {
    preferred = null;
  }

  const preferredArtifact =
    preferredEvent?.artifactId && typeof preferredEvent.artifactId === "string"
      ? artifactById.get(preferredEvent.artifactId)
      : undefined;
  const preferredArtifactAnswer = await readArtifactAnswer(preferredArtifact);

  const finalAnswer =
    (!preferred || looksTruncatedAnswer(preferred)) && preferredArtifactAnswer
      ? preferredArtifactAnswer
      : preferred ?? fallback;
  const groundedManagerAnswer = task
    ? coerceGroundedManagerReply({
        task: {
          title: task.title,
          description: null,
        },
        observations: events
          .filter((event) => event.type === "tool.result")
          .filter((event) => (event.roleRuntimeId ? runtimeRoleById.get(event.roleRuntimeId) === "leader" : false))
          .map((event) => {
            const payload = parsePayload(event.payloadJson);
            return {
              toolName: readPayloadString(payload, ["toolName"]) ?? "unknown",
              ok: true,
              result: payload?.result,
              summary:
                readPayloadString(payload, ["resultSummary", "message"]) ?? "manager tool result",
            };
          }),
        reply: finalAnswer,
      })
    : null;
  const preferredGroundedAnswer = groundedManagerAnswer ?? finalAnswer;
  if (!preferredGroundedAnswer) {
    return null;
  }

  return normalizeAnswerForDigest(preferredGroundedAnswer);
}

async function buildOrchestrationDigest(taskId: string, stopReason: string) {
  const orchestration = await getTaskOrchestrationReadModel(taskId);
  const trace = await collectRecentTrace(taskId);

  const capabilityProgress: FeishuRoleProgress[] = orchestration.roleProgress.map((capability) => ({
    roleId: capability.roleId,
    state: capability.state,
    ...(capability.executorId ? { executorId: capability.executorId } : {}),
    ...(capability.runId ? { runId: capability.runId } : {}),
    ...(capability.summary ? { summary: trimSentence(normalizeAnswerForDigest(capability.summary)) } : {}),
  }));
  const latestRunId =
    orchestration.roleProgress.find(
      (capability) =>
        capability.runId && capability.state !== "COMPLETED" && capability.state !== "FAILED",
    )?.runId ??
    orchestration.roleProgress.find((capability) => capability.runId)?.runId ??
    null;

  const plannedCapabilities =
    orchestration.managerPlan?.childRuns.map((childRun) => childRun.roleId) ??
    capabilityProgress.filter((capability) => capability.roleId !== "leader").map((capability) => capability.roleId);
  const latestAnswer = await resolvePreferredLatestAnswer(taskId, orchestration.latestAnswer);
  const completedCapabilities = orchestration.completedCapabilities;
  const pendingCapabilities = orchestration.pendingCapabilities;
  const blockedCapabilities = orchestration.blockedCapabilities;
  const nextCapability = orchestration.nextCapability;

  const isConversationalCompletion =
    stopReason === "task_completed" &&
    orchestration.managerPlan?.taskType === "conversation" &&
    (orchestration.managerPlan?.decisionMode === "direct_answer" ||
      orchestration.managerPlan?.decisionMode === "tool_answer" ||
      orchestration.managerPlan?.decisionMode === "clarify");
  const isClarification =
    orchestration.managerPlan?.taskType === "conversation" &&
    orchestration.managerPlan?.coordinationAction === "clarify";

  const nextActionByReason: Record<string, string> = {
    task_completed: "查看结果后，直接回复下一步要做什么。",
    no_eligible_runtime: "请在控制台打开阻塞链路，确认为什么没有可执行的下一工作项。",
    review_changes_requested: "请先处理 reviewer 反馈，再继续后续工作项。",
    dispatch_failed: "请检查失败的执行器配置后重试。",
    run_not_found: "请在控制台检查链路状态，当前运行时引用已丢失，需要人工修复。",
  };

  return {
    ...(latestAnswer ? { latestAnswer } : {}),
    ...(latestRunId ? { latestRunId } : {}),
    ...(capabilityProgress.length > 0 ? { roleProgress: capabilityProgress } : {}),
    ...(trace.length > 0 ? { trace } : {}),
    managerPlan: {
      taskType:
        orchestration.managerPlan?.taskType ??
        (capabilityProgress.some((capability) => capability.roleId === "reviewer" || capability.roleId === "lander")
          ? "mixed"
          : capabilityProgress.length > 0
            ? "coding"
            : "conversation"),
      ...(orchestration.managerPlan?.confidence
        ? { confidence: orchestration.managerPlan.confidence }
        : {}),
      ...(orchestration.managerPlan?.coordinationAction
        ? { coordinationAction: orchestration.managerPlan.coordinationAction }
        : {}),
      ...(orchestration.managerPlan?.executionMode
        ? { executionMode: orchestration.managerPlan.executionMode }
        : {}),
      ...(typeof orchestration.managerPlan?.needsHuman === "boolean"
        ? { needsHuman: orchestration.managerPlan.needsHuman }
        : {}),
      ...(orchestration.managerPlan?.warnings && orchestration.managerPlan.warnings.length > 0
        ? { warnings: orchestration.managerPlan.warnings }
        : {}),
      plannedCapabilities: plannedCapabilities.length > 0
        ? plannedCapabilities
        : capabilityProgress
            .filter((capability) => capability.roleId !== "leader")
            .map((capability) => capability.roleId),
      capabilityProgress,
      completedCapabilities,
      pendingCapabilities,
      blockedCapabilities,
      nextCapability,
    } satisfies FeishuManagerPlan,
    nextAction:
      isConversationalCompletion
        ? isClarification
          ? "直接回复我缺失的信息，我会接着继续。"
          : "你可以继续追问，或者直接给 Leader 一个具体任务。"
        : nextActionByReason[stopReason] ??
      (nextCapability ? `继续推进 ${nextCapability} 工作项。` : "请在控制台查看该任务并决定下一步。"),
  };
}

async function findExistingQueuedOrchestrationSummary(
  input: QueueFeishuOrchestrationSummaryInput,
): Promise<QueuedFeishuOutboundEvent<OrchestrationSummaryPayload> | null> {
  const targetKind =
    input.taskState === "COMPLETED"
      ? "task_orchestration_completed"
      : "task_orchestration_blocked";
  const events = await new ExecutionEventRepository().listByTaskId(input.taskId);
  const deliveryStateByOutboundEventId = new Map<string, "delivered" | "failed">();

  for (const event of events) {
    if (event.type !== "channel.outbound.delivered" && event.type !== "channel.outbound.failed") {
      continue;
    }
    const outboundEventId = parseOutboundEventIdFromDeliveryPayload(event.payloadJson);
    if (!outboundEventId) {
      continue;
    }
    deliveryStateByOutboundEventId.set(
      outboundEventId,
      event.type === "channel.outbound.delivered" ? "delivered" : "failed",
    );
  }

  const matchedEvent = [...events]
    .filter((event) => event.type === "channel.outbound.queued")
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .find((event) => {
      const payload = parsePayload(event.payloadJson);
      if (!isOrchestrationSummaryPayload(payload)) {
        return false;
      }
      if (
        payload.kind !== targetKind ||
        payload.taskId !== input.taskId ||
        payload.bindingId !== input.bindingId
      ) {
        return false;
      }

      if (input.roleRuntimeId) {
        const payloadRoleRuntimeId = typeof payload.roleRuntimeId === "string"
          ? payload.roleRuntimeId
          : undefined;
        if (payloadRoleRuntimeId && payloadRoleRuntimeId !== input.roleRuntimeId) {
          return false;
        }
      }

      return deliveryStateByOutboundEventId.get(event.id) !== "failed";
    });

  if (!matchedEvent) {
    return null;
  }

  const payload = parsePayload(matchedEvent.payloadJson);
  if (!isOrchestrationSummaryPayload(payload)) {
    return null;
  }

  return {
    eventId: matchedEvent.id,
    payload,
  };
}

function buildTaskCreatedPayload(input: QueueFeishuTaskCreatedSummaryInput) {
  return {
    channel: "feishu" as const,
    kind: "task_created" as const,
    bindingId: input.bindingId,
    taskId: input.taskId,
    title: "👌",
    taskTitle: input.taskTitle,
    taskState: input.taskState,
    ...(input.latestRunId ? { latestRunId: input.latestRunId } : {}),
  };
}

function buildApprovalResolvedPayload(input: QueueFeishuApprovalResolvedSummaryInput) {
  return {
    channel: "feishu" as const,
    kind: "approval_resolved" as const,
    bindingId: input.bindingId,
    taskId: input.taskId,
    approvalId: input.approvalId,
    title: `Approval ${input.approvalState}`,
    summary: `${input.taskTitle} ${input.approvalType} approval was ${input.approvalState}.`,
    taskTitle: input.taskTitle,
    approvalType: input.approvalType,
    approvalState: input.approvalState,
    ...(input.actorId ? { actorId: input.actorId } : {}),
  };
}

async function buildOrchestrationSummaryPayload(input: QueueFeishuOrchestrationSummaryInput) {
  const completed = input.taskState === "COMPLETED";
  const digest = await buildOrchestrationDigest(input.taskId, input.stopReason);
  const isConversation = digest.managerPlan.taskType === "conversation";
  return {
    channel: "feishu" as const,
    kind: completed
      ? ("task_orchestration_completed" as const)
      : ("task_orchestration_blocked" as const),
    bindingId: input.bindingId,
    taskId: input.taskId,
    title: completed ? "Task completed" : "Task blocked",
    summary: completed
      ? isConversation
        ? digest.managerPlan.coordinationAction === "clarify"
          ? `${input.taskTitle} 还缺一条关键信息，我已经直接追问你了。`
          : `${input.taskTitle} 已得到回复。`
        : `${input.taskTitle} 已完成，等待你确认下一步。`
      : isConversation
        ? `${input.taskTitle} 暂时没法继续，我需要你补充信息或确认。`
        : `${input.taskTitle} 已阻塞，需要处理。`,
    taskTitle: input.taskTitle,
    taskState: input.taskState,
    stopReason: input.stopReason,
    ...digest,
    ...(input.roleId ? { roleId: input.roleId } : {}),
    ...(input.roleRuntimeId ? { roleRuntimeId: input.roleRuntimeId } : {}),
  };
}

export async function queueFeishuTaskCreatedSummary(
  input: QueueFeishuTaskCreatedSummaryInput,
): Promise<QueuedFeishuOutboundEvent<ReturnType<typeof buildTaskCreatedPayload>>> {
  const observabilityAdapter = new LocalObservabilityAdapter();
  const payload = buildTaskCreatedPayload(input);
  const eventId = `event_${crypto.randomUUID()}`;

  await observabilityAdapter.recordEvent({
    id: eventId,
    type: "channel.outbound.queued",
    taskId: input.taskId,
    conversationBindingId: input.bindingId,
    workspaceId: input.workspaceId,
    severity: "info",
    occurredAt: new Date(),
    payloadJson: JSON.stringify(payload),
  });

  return {
    eventId,
    payload,
  };
}

export async function queueFeishuApprovalResolvedSummary(
  input: QueueFeishuApprovalResolvedSummaryInput,
): Promise<QueuedFeishuOutboundEvent<ReturnType<typeof buildApprovalResolvedPayload>>> {
  const observabilityAdapter = new LocalObservabilityAdapter();
  const payload = buildApprovalResolvedPayload(input);
  const eventId = `event_${crypto.randomUUID()}`;

  await observabilityAdapter.recordEvent({
    id: eventId,
    type: "channel.outbound.queued",
    taskId: input.taskId,
    approvalId: input.approvalId,
    conversationBindingId: input.bindingId,
    workspaceId: input.workspaceId,
    severity: "info",
    occurredAt: new Date(),
    payloadJson: JSON.stringify(payload),
  });

  return {
    eventId,
    payload,
  };
}

export async function queueFeishuOrchestrationSummary(
  input: QueueFeishuOrchestrationSummaryInput,
): Promise<QueuedFeishuOutboundEvent<Awaited<ReturnType<typeof buildOrchestrationSummaryPayload>>>> {
  const existing = await findExistingQueuedOrchestrationSummary(input);
  if (existing) {
    return existing;
  }

  const observabilityAdapter = new LocalObservabilityAdapter();
  const payload = await buildOrchestrationSummaryPayload(input);
  const eventId = `event_${crypto.randomUUID()}`;

  await observabilityAdapter.recordEvent({
    id: eventId,
    type: "channel.outbound.queued",
    taskId: input.taskId,
    conversationBindingId: input.bindingId,
    workspaceId: input.workspaceId,
    severity: input.taskState === "BLOCKED" ? "warn" : "info",
    occurredAt: new Date(),
    payloadJson: JSON.stringify(payload),
  });

  return {
    eventId,
    payload,
  };
}
