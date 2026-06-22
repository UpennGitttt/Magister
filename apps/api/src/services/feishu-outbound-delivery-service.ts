import { createFeishuClient } from "../integrations/feishu/feishu-client";
import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { ChannelOutboundDeliveryClaimRepository } from "../repositories/channel-outbound-delivery-claim-repository";
import { ConversationBindingRepository } from "../repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { ChannelSessionService } from "./channel-session-service";

type FeishuQueuedPayload = {
  channel: "feishu";
  kind: string;
  bindingId?: string;
  taskId?: string;
  sourceEventId?: string;
  eventType?: string;
  latestRunId?: string;
  title?: string;
  summary?: string;
  taskTitle?: string;
  taskState?: string;
  stopReason?: string;
  latestAnswer?: string;
  nextAction?: string;
  managerPlan?: {
    taskType?: string;
    coordinationAction?: string;
    confidence?: string;
    needsHuman?: boolean;
    warnings?: string[];
    plannedCapabilities?: string[];
    capabilityProgress?: Array<{
      roleId?: string;
      state?: string;
      executorId?: string;
      runId?: string;
      summary?: string;
    }>;
    completedCapabilities?: string[];
    pendingCapabilities?: string[];
    blockedCapabilities?: string[];
    nextCapability?: string | null;
  };
  roleProgress?: Array<{
    roleId?: string;
    state?: string;
    executorId?: string;
    runId?: string;
    summary?: string;
  }>;
  trace?: Array<{
    kind?: string;
    text?: string;
    roleId?: string;
    source?: string;
    executorId?: string;
    sessionId?: string;
    attemptCount?: number;
  }>;
  roleId?: string;
  executorId?: string;
  sessionId?: string;
  attemptCount?: number;
  details?: Record<string, unknown>;
};

type FeishuTransportMessage = {
  outboundEventId: string;
  bindingId: string;
  chatId: string;
  replyToMessageId?: string;
  deliveryMode: FeishuDeliveryMode;
  verboseLevel?: "off" | "on" | "full";
  workspaceId: string;
  payload: FeishuQueuedPayload;
};

type FeishuTransportResult = {
  providerMessageId: string;
};

type FeishuOutboundTransport = (
  input: FeishuTransportMessage,
) => Promise<FeishuTransportResult>;

type DeliverQueuedFeishuOutboundEventsInput = {
  eventIds?: string[];
  limit?: number;
  transport?: FeishuOutboundTransport;
};

type DeliveryRecord = {
  outboundEventId: string;
  bindingId: string;
  chatId: string;
  kind: string;
  providerMessageId: string;
};

type FailureRecord = {
  outboundEventId: string;
  bindingId: string;
  chatId?: string;
  code: string;
  message: string;
};

type FeishuDeliveryMode =
  | "reaction_only"
  | "reply_preferred"
  | "top_level_preferred"
  | "always_visible_ack";

function parseQueuedPayload(payloadJson?: string | null): FeishuQueuedPayload | null {
  if (!payloadJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    if (parsed.channel !== "feishu" || typeof parsed.kind !== "string") {
      return null;
    }

    const managerPlan = parsed.managerPlan as Record<string, unknown> | null | undefined;

    return {
      channel: "feishu",
      kind: parsed.kind,
      ...(typeof parsed.bindingId === "string" ? { bindingId: parsed.bindingId } : {}),
      ...(typeof parsed.taskId === "string" ? { taskId: parsed.taskId } : {}),
      ...(typeof parsed.sourceEventId === "string" ? { sourceEventId: parsed.sourceEventId } : {}),
      ...(typeof parsed.eventType === "string" ? { eventType: parsed.eventType } : {}),
      ...(typeof parsed.latestRunId === "string" ? { latestRunId: parsed.latestRunId } : {}),
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
      ...(typeof parsed.taskTitle === "string" ? { taskTitle: parsed.taskTitle } : {}),
      ...(typeof parsed.taskState === "string" ? { taskState: parsed.taskState } : {}),
      ...(typeof parsed.stopReason === "string" ? { stopReason: parsed.stopReason } : {}),
      ...(typeof parsed.latestAnswer === "string" ? { latestAnswer: parsed.latestAnswer } : {}),
      ...(typeof parsed.nextAction === "string" ? { nextAction: parsed.nextAction } : {}),
      ...(typeof parsed.roleId === "string" ? { roleId: parsed.roleId } : {}),
      ...(typeof parsed.executorId === "string" ? { executorId: parsed.executorId } : {}),
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.attemptCount === "number" ? { attemptCount: parsed.attemptCount } : {}),
      ...(parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details)
        ? { details: parsed.details as Record<string, unknown> }
        : {}),
      ...(managerPlan && typeof managerPlan === "object"
        ? {
            managerPlan: {
              ...(typeof managerPlan["taskType"] === "string" ? { taskType: managerPlan["taskType"] } : {}),
              ...(typeof managerPlan["coordinationAction"] === "string"
                ? { coordinationAction: managerPlan["coordinationAction"] }
                : {}),
              ...(typeof managerPlan["confidence"] === "string"
                ? { confidence: managerPlan["confidence"] }
                : {}),
              ...(typeof managerPlan["needsHuman"] === "boolean"
                ? { needsHuman: managerPlan["needsHuman"] }
                : {}),
              ...(Array.isArray(managerPlan["warnings"])
                ? {
                    warnings: managerPlan["warnings"].filter(
                      (value): value is string => typeof value === "string" && value.trim().length > 0,
                    ),
                  }
                : {}),
              ...(Array.isArray(managerPlan["plannedCapabilities"])
                ? {
                    plannedCapabilities: managerPlan["plannedCapabilities"].filter(
                      (value): value is string => typeof value === "string" && value.trim().length > 0,
                    ),
                  }
                : {}),
              ...(Array.isArray(managerPlan["capabilityProgress"])
                ? {
                    capabilityProgress: managerPlan["capabilityProgress"]
                      .filter(
                        (value): value is Record<string, unknown> =>
                          Boolean(value) && typeof value === "object",
                      )
                      .map((value) => ({
                        ...(typeof value.roleId === "string" ? { roleId: value.roleId } : {}),
                        ...(typeof value.state === "string" ? { state: value.state } : {}),
                        ...(typeof value.executorId === "string" ? { executorId: value.executorId } : {}),
                        ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
                        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
                      })),
                  }
                : {}),
              ...(Array.isArray(managerPlan["completedCapabilities"])
                ? {
                    completedCapabilities: managerPlan["completedCapabilities"].filter(
                      (value): value is string => typeof value === "string" && value.trim().length > 0,
                    ),
                  }
                : {}),
              ...(Array.isArray(managerPlan["pendingCapabilities"])
                ? {
                    pendingCapabilities: managerPlan["pendingCapabilities"].filter(
                      (value): value is string => typeof value === "string" && value.trim().length > 0,
                    ),
                  }
                : {}),
              ...(Array.isArray(managerPlan["blockedCapabilities"])
                ? {
                    blockedCapabilities: managerPlan["blockedCapabilities"].filter(
                      (value): value is string => typeof value === "string" && value.trim().length > 0,
                    ),
                  }
                : {}),
              ...((typeof managerPlan["nextCapability"] === "string" || managerPlan["nextCapability"] === null)
                ? { nextCapability: managerPlan["nextCapability"] }
                : {}),
            },
          }
        : {}),
      ...(Array.isArray(parsed.roleProgress)
        ? {
            roleProgress: parsed.roleProgress
              .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
              .map((value) => ({
                ...(typeof value.roleId === "string" ? { roleId: value.roleId } : {}),
                ...(typeof value.state === "string" ? { state: value.state } : {}),
                ...(typeof value.executorId === "string" ? { executorId: value.executorId } : {}),
                ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
                ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
              })),
          }
        : {}),
      ...(Array.isArray(parsed.trace)
        ? {
            trace: parsed.trace
              .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
              .map((value) => ({
                ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
                ...(typeof value.text === "string" ? { text: value.text } : {}),
                ...(typeof value.roleId === "string" ? { roleId: value.roleId } : {}),
                ...(typeof value.source === "string" ? { source: value.source } : {}),
                ...(typeof value.executorId === "string" ? { executorId: value.executorId } : {}),
                ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
                ...(typeof value.attemptCount === "number" ? { attemptCount: value.attemptCount } : {}),
              }))
              .filter((value) => typeof value.text === "string" && value.text.trim().length > 0),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseTerminalOutboundEventId(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return typeof parsed.outboundEventId === "string" ? parsed.outboundEventId : null;
  } catch {
    return null;
  }
}

type FeishuOutboundStyle = "compact" | "verbose";
type FeishuVerboseLevel = "off" | "on" | "full";

function resolveFeishuOutboundStyle(): FeishuOutboundStyle {
  const raw = process.env.MAGISTER_FEISHU_OUTBOUND_STYLE?.trim().toLowerCase();
  return raw === "compact" ? "compact" : "verbose";
}

function resolveFeishuVerboseDiagnosticsEnabled() {
  const raw = process.env.MAGISTER_FEISHU_VERBOSE_INCLUDE_DIAGNOSTICS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveFeishuVerboseLevel(input?: string | null): FeishuVerboseLevel {
  const normalized = input?.trim().toLowerCase();
  if (normalized === "on" || normalized === "full") {
    return normalized;
  }

  return "off";
}

function resolvePublicWebBaseUrl() {
  const raw = process.env.MAGISTER_WEB_PUBLIC_BASE_URL?.trim();
  if (!raw) {
    return null;
  }

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function resolveDetailRunId(payload: FeishuQueuedPayload) {
  if (payload.latestRunId) {
    return payload.latestRunId;
  }

  const capabilityProgress = payload.managerPlan?.capabilityProgress ?? payload.roleProgress ?? [];
  const activeRunId =
    capabilityProgress.find(
      (capability) => capability.runId && capability.state !== "COMPLETED" && capability.state !== "FAILED",
    )?.runId ??
    capabilityProgress.find((capability) => capability.runId)?.runId;

  return activeRunId ?? null;
}

function buildTaskDetailUrl(taskId?: string, runId?: string | null) {
  if (!taskId) {
    return null;
  }

  const base = resolvePublicWebBaseUrl();
  if (!base) {
    return null;
  }

  const url = new URL(base.toString());
  url.searchParams.set("view", "workbench");
  url.searchParams.set("taskId", taskId);
  if (runId) {
    url.searchParams.set("runId", runId);
  }
  return url.toString();
}

function collapseWhitespace(value: string) {
  return normalizeCoordinatorLabel(value).replace(/\s+/g, " ").trim();
}

function normalizeCoordinatorLabel(value: string) {
  return value
    .replace(/给任务经理/g, "给 Leader ")
    .replace(/任务经理(决策|判断|观察|提醒|决定|派生|需要|已|暂时|准备)/g, "Leader $1")
    .replace(/任务经理/g, "Leader");
}

function truncateLine(value: string, limit = 220) {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function stringifyRuntimeTraceDetail(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatFeishuRuntimeTraceMessage(
  payload: FeishuQueuedPayload,
  verboseLevel: FeishuVerboseLevel,
) {
  const lines: string[] = [];
  const summary = payload.summary ? collapseWhitespace(payload.summary) : "运行时事件";
  lines.push(summary);

  const details = payload.details ?? null;
  const isManagerToolEvent =
    payload.roleId === "leader" &&
    (payload.eventType === "tool.call" ||
      payload.eventType === "tool.result" ||
      payload.eventType === "tool.error");
  const managerActorLine = isManagerToolEvent
    ? `执行者：Leader${payload.executorId ? `（${payload.executorId}）` : ""}`
    : null;
  const managerSessionLine =
    isManagerToolEvent && verboseLevel === "full" && payload.sessionId
      ? `会话：${payload.sessionId}`
      : null;

  if (payload.eventType === "tool.call" && details) {
    const toolName =
      typeof details.toolName === "string" && details.toolName.trim().length > 0
        ? details.toolName.trim()
        : null;
    const argumentsValue =
      Object.prototype.hasOwnProperty.call(details, "arguments") ? details.arguments : null;

    if (toolName) {
      lines.push(`工具：${toolName}`);
    }
    if (managerActorLine) {
      lines.push(managerActorLine);
    }
    if (managerSessionLine) {
      lines.push(managerSessionLine);
    }
    if (argumentsValue !== null) {
      lines.push(`参数：${truncateLine(stringifyRuntimeTraceDetail(argumentsValue), 1200)}`);
    }
    return lines.join("\n");
  }

  if (payload.eventType === "tool.result" && details) {
    const toolName =
      typeof details.toolName === "string" && details.toolName.trim().length > 0
        ? details.toolName.trim()
        : null;
    const resultValue =
      Object.prototype.hasOwnProperty.call(details, "result") ? details.result : null;
    const resultSummary =
      typeof details.resultSummary === "string" && details.resultSummary.trim().length > 0
        ? details.resultSummary.trim()
        : null;

    if (toolName) {
      lines.push(`工具：${toolName}`);
    }
    if (managerActorLine) {
      lines.push(managerActorLine);
    }
    if (managerSessionLine) {
      lines.push(managerSessionLine);
    }
    if (resultSummary) {
      lines.push(`结果摘要：${truncateLine(resultSummary, 1200)}`);
    } else if (resultValue !== null) {
      lines.push(`结果：${truncateLine(stringifyRuntimeTraceDetail(resultValue), 1200)}`);
    }
    return lines.join("\n");
  }

  if (payload.eventType === "tool.error" && details) {
    const toolName =
      typeof details.toolName === "string" && details.toolName.trim().length > 0
        ? details.toolName.trim()
        : null;
    const errorCode =
      typeof details.errorCode === "string" && details.errorCode.trim().length > 0
        ? details.errorCode.trim()
        : null;
    const errorMessage =
      typeof details.errorMessage === "string" && details.errorMessage.trim().length > 0
        ? details.errorMessage.trim()
        : null;

    if (toolName) {
      lines.push(`工具：${toolName}`);
    }
    if (managerActorLine) {
      lines.push(managerActorLine);
    }
    if (managerSessionLine) {
      lines.push(managerSessionLine);
    }
    if (errorCode) {
      lines.push(`错误码：${errorCode}`);
    }
    if (errorMessage) {
      lines.push(`错误：${truncateLine(errorMessage, 1200)}`);
    }
    return lines.join("\n");
  }

  if (verboseLevel !== "full") {
    return lines.join("\n");
  }

  if (payload.eventType === "manager.decision" && details) {
    const taskType =
      typeof details.taskType === "string" && details.taskType.trim().length > 0
        ? details.taskType.trim()
        : null;
    const executionMode =
      typeof details.executionMode === "string" && details.executionMode.trim().length > 0
        ? details.executionMode.trim()
        : null;
    const decision =
      typeof details.decision === "string" && details.decision.trim().length > 0
        ? details.decision.trim()
        : null;

    if (taskType) {
      lines.push(`任务类型：${taskType}`);
    }
    if (executionMode) {
      lines.push(`执行模式：${executionMode}`);
    }
    if (decision) {
      lines.push(`决策：${decision}`);
    }
    return lines.join("\n");
  }

  if (details) {
    const renderedDetails = truncateLine(stringifyRuntimeTraceDetail(details), 1200);
    if (renderedDetails) {
      lines.push(`详情：${renderedDetails}`);
    }
  }

  return lines.join("\n");
}

function buildProgressLine(payload: FeishuQueuedPayload) {
  const completedCount = payload.managerPlan?.completedCapabilities?.length ?? 0;
  const pendingCount = payload.managerPlan?.pendingCapabilities?.length ?? 0;
  const blockedCount = payload.managerPlan?.blockedCapabilities?.length ?? 0;
  const parts: string[] = [];
  if (completedCount > 0) {
    parts.push(`完成 ${completedCount}`);
  }
  if (pendingCount > 0) {
    parts.push(`待继续 ${pendingCount}`);
  }
  if (blockedCount > 0) {
    parts.push(`阻塞 ${blockedCount}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return `进展：${parts.join("，")}`;
}

function buildCurrentRuntimeLine(payload: FeishuQueuedPayload) {
  const capabilityProgress = payload.managerPlan?.capabilityProgress ?? payload.roleProgress;
  if (!capabilityProgress || capabilityProgress.length === 0) {
    return null;
  }

  const activeRole =
    capabilityProgress.find((role) => typeof role.state === "string" && role.state !== "COMPLETED") ??
    capabilityProgress[capabilityProgress.length - 1];
  if (!activeRole?.roleId) {
    return null;
  }

  const state = activeRole.state ?? "UNKNOWN";
  const executor = activeRole.executorId ? `（${activeRole.executorId}）` : "";
  return `当前执行：${activeRole.roleId} ${state}${executor}`;
}

function hasNonManagerCapabilities(payload: FeishuQueuedPayload) {
  const plannedCapabilities = payload.managerPlan?.plannedCapabilities ?? [];
  const hasPlannedNonManager = plannedCapabilities.some(
    (capability) => capability && capability !== "leader",
  );

  const capabilityProgress = payload.managerPlan?.capabilityProgress ?? payload.roleProgress ?? [];
  const hasProgressNonManager = capabilityProgress.some(
    (capability) => capability.roleId && capability.roleId !== "leader",
  );

  return hasPlannedNonManager || hasProgressNonManager;
}

function shouldRenderDirectAnswer(payload: FeishuQueuedPayload) {
  if (payload.taskState !== "COMPLETED" || !payload.latestAnswer) {
    return false;
  }

  const coordinationAction = payload.managerPlan?.coordinationAction;
  if (
    coordinationAction === "direct_answer" ||
    coordinationAction === "tool_answer" ||
    coordinationAction === "clarify"
  ) {
    return true;
  }

  if (payload.managerPlan?.taskType === "conversation") {
    return true;
  }

  return !hasNonManagerCapabilities(payload);
}

function formatFeishuTextMessageCompact(payload: FeishuQueuedPayload) {
  if (payload.kind === "task_created") {
    return "👌";
  }

  const isDirectAnswer = shouldRenderDirectAnswer(payload);
  const isBlocked = payload.taskState === "BLOCKED";
  const isClarification = payload.managerPlan?.coordinationAction === "clarify";
  const detailUrl = buildTaskDetailUrl(payload.taskId, resolveDetailRunId(payload));

  if (isDirectAnswer) {
    const directAnswer = payload.latestAnswer ?? payload.summary ?? "";
    const lines = [truncateLine(directAnswer, 520)];
    if (payload.nextAction) {
      lines.push("", truncateLine(payload.nextAction, 280));
    }
    if (detailUrl) {
      lines.push(`详情：${detailUrl}`);
    }
    return lines.join("\n");
  }

  const lines: string[] = [];

  if (isBlocked) {
    lines.push("⚠️ 任务链路已阻塞");
    if (payload.taskTitle) {
      lines.push(`任务：${payload.taskTitle}`);
    }
    const reason = payload.latestAnswer ?? payload.summary;
    if (reason) {
      lines.push(`原因：${truncateLine(reason, 260)}`);
    }
    const runtime = buildCurrentRuntimeLine(payload);
    if (runtime) {
      lines.push(runtime);
    }
    if (payload.managerPlan?.blockedCapabilities && payload.managerPlan.blockedCapabilities.length > 0) {
      lines.push(`阻塞工作项：${payload.managerPlan.blockedCapabilities.join("、")}`);
    }
    if (payload.nextAction) {
      lines.push(`处理建议：${truncateLine(payload.nextAction, 260)}`);
    }
    if (detailUrl) {
      lines.push(`详情：${detailUrl}`);
    }
    if (payload.taskId) {
      lines.push(`任务ID：${payload.taskId}`);
    }
    return lines.join("\n");
  }

  const headline =
    payload.taskState === "COMPLETED"
      ? isClarification
        ? "ℹ️ Leader 需要你补充信息"
        : "✅ Leader 已完成这个任务"
      : payload.taskState === "BLOCKED"
        ? "⚠️ Leader 需要你关注这个任务"
        : normalizeCoordinatorLabel(payload.title ?? "Leader 进展更新");
  lines.push(headline);

  if (payload.taskTitle) {
    lines.push(`任务：${payload.taskTitle}`);
  }

  const answer = payload.latestAnswer ?? payload.summary;
  if (answer) {
    lines.push(`${isClarification ? "回复" : "结论"}：${truncateLine(answer, 260)}`);
  }

  const progressLine = buildProgressLine(payload);
  if (progressLine) {
    lines.push(progressLine);
  }

  const runtimeLine = buildCurrentRuntimeLine(payload);
  if (runtimeLine) {
    lines.push(runtimeLine);
  }

  if (payload.managerPlan?.nextCapability) {
    lines.push(`下一工作项：${payload.managerPlan.nextCapability}`);
  }

  if (payload.managerPlan?.needsHuman) {
    lines.push("人工关注：当前链路存在歧义，建议你确认后继续。");
  }

  if (payload.managerPlan?.warnings && payload.managerPlan.warnings.length > 0) {
    lines.push(`提醒：${truncateLine(payload.managerPlan.warnings[0]!, 220)}`);
  }

  if (payload.nextAction) {
    lines.push(`下一步：${truncateLine(payload.nextAction, 260)}`);
  }

  if (detailUrl) {
    lines.push(`详情：${detailUrl}`);
  }

  if (payload.taskId) {
    lines.push(`任务ID：${payload.taskId}`);
  }

  return lines.join("\n");
}

function formatFeishuTextMessageVerbose(payload: FeishuQueuedPayload) {
  if (payload.kind === "task_created") {
    return "👌";
  }

  const isDirectAnswer = shouldRenderDirectAnswer(payload);
  const isBlocked = payload.taskState === "BLOCKED";
  const isClarification = payload.managerPlan?.coordinationAction === "clarify";
  const includeDiagnostics = resolveFeishuVerboseDiagnosticsEnabled();
  const detailUrl = buildTaskDetailUrl(payload.taskId, resolveDetailRunId(payload));

  if (isDirectAnswer) {
    const directAnswer = payload.latestAnswer ?? payload.summary ?? "";
    const lines = [normalizeCoordinatorLabel(directAnswer)];
    if (payload.nextAction) {
      lines.push("", normalizeCoordinatorLabel(payload.nextAction));
    }
    if (detailUrl) {
      lines.push(`详情：${detailUrl}`);
    }
    return lines.join("\n");
  }

  const lines: string[] = [];

  if (isBlocked) {
    lines.push("⚠️ Leader 暂时卡住了这个任务");
    if (payload.taskTitle) {
      lines.push(`任务：${payload.taskTitle}`);
    }
    if (payload.latestAnswer) {
      lines.push(`原因：${normalizeCoordinatorLabel(payload.latestAnswer)}`);
    } else if (payload.summary) {
      lines.push(`原因：${normalizeCoordinatorLabel(payload.summary)}`);
    }
    if (payload.nextAction) {
      lines.push(`处理建议：${normalizeCoordinatorLabel(payload.nextAction)}`);
    }

    if (includeDiagnostics && payload.trace && payload.trace.length > 0) {
      const traceLabelByKind: Record<string, string> = {
        message: "消息",
        tool_call: "工具调用",
        tool_result: "工具结果",
        subagent: "内部工作项",
        decision: "Leader 决策",
      };
      const topTrace = payload.trace
        .filter((trace) => trace.kind === "tool_result" || trace.kind === "tool_call" || trace.kind === "message")
        .slice(0, 2);
      if (topTrace.length > 0) {
        lines.push("最近观测：");
        for (const trace of topTrace) {
          const kind = trace.kind ? traceLabelByKind[trace.kind] ?? trace.kind : "观测";
          const role = trace.roleId ? `${trace.roleId} · ` : "";
          const tags = [
            trace.executorId,
            typeof trace.attemptCount === "number" ? `第${trace.attemptCount}次` : null,
            trace.sessionId,
          ].filter((value): value is string => Boolean(value));
          const tagLabel = tags.length > 0 ? ` [${tags.join(" / ")}]` : "";
          lines.push(`- ${kind}：${role}${normalizeCoordinatorLabel(trace.text ?? "")}${tagLabel}`);
        }
      }
    }

    if (detailUrl) {
      lines.push(`详情：${detailUrl}`);
    }
    if (payload.taskId) {
      lines.push(`任务ID：${payload.taskId}`);
    }
    return lines.join("\n");
  }

  const headline =
    payload.taskState === "COMPLETED"
        ? isClarification
          ? "ℹ️ Leader 需要你补充一点信息"
          : "✅ Leader 已完成这个任务"
        : payload.taskState === "BLOCKED"
          ? "⚠️ Leader 需要你关注这个任务"
          : normalizeCoordinatorLabel(payload.title ?? "Leader 进展更新");

  lines.push(headline);

  if (payload.taskTitle) {
    lines.push(`任务：${payload.taskTitle}`);
  }

  if (payload.summary) {
    lines.push(`结论：${normalizeCoordinatorLabel(payload.summary)}`);
  }

  if (payload.latestAnswer) {
    lines.push(`答复：${normalizeCoordinatorLabel(payload.latestAnswer)}`);
  }

  const capabilityProgress = payload.managerPlan?.capabilityProgress ?? payload.roleProgress;

  if (includeDiagnostics && payload.managerPlan) {
    const taskType = payload.managerPlan.taskType ? `类型 ${payload.managerPlan.taskType}` : null;
    const planned =
      payload.managerPlan.plannedCapabilities && payload.managerPlan.plannedCapabilities.length > 0
        ? `内部工作项 ${payload.managerPlan.plannedCapabilities.join(" -> ")}`
        : null;
    const summary = [taskType, planned].filter((item): item is string => Boolean(item)).join("，");
    if (summary) {
      lines.push(`Leader 判断：${summary}`);
    }

    if (payload.managerPlan.taskType) {
      // no-op: folded into the summary line above
    }
    if (payload.managerPlan.completedCapabilities && payload.managerPlan.completedCapabilities.length > 0) {
      lines.push(`已完成工作项：${payload.managerPlan.completedCapabilities.join("、")}`);
    }
    if (payload.managerPlan.pendingCapabilities && payload.managerPlan.pendingCapabilities.length > 0) {
      lines.push(`待继续工作项：${payload.managerPlan.pendingCapabilities.join("、")}`);
    }
    if (payload.managerPlan.blockedCapabilities && payload.managerPlan.blockedCapabilities.length > 0) {
      lines.push(`阻塞工作项：${payload.managerPlan.blockedCapabilities.join("、")}`);
    }
    if (payload.managerPlan.nextCapability) {
      lines.push(`下一步：Leader 准备推进 ${payload.managerPlan.nextCapability}`);
    }
    if (payload.managerPlan.needsHuman) {
      lines.push("人工关注：Leader 判断当前链路存在歧义，建议你确认后再继续。");
    }
    if (payload.managerPlan.warnings && payload.managerPlan.warnings.length > 0) {
      lines.push(`Leader 提醒：${normalizeCoordinatorLabel(payload.managerPlan.warnings.join("；"))}`);
    }
  }

  if (includeDiagnostics && capabilityProgress && capabilityProgress.length > 0) {
    lines.push("内部工作项进展：");
    for (const role of capabilityProgress) {
      const roleLabel = role.roleId ?? "unknown";
      const state = role.state ?? "UNKNOWN";
      const executor = role.executorId ? `（${role.executorId}）` : "";
      const summary = role.summary ? `：${role.summary}` : "";
      lines.push(`- ${roleLabel} ${state}${executor}${summary}`);
    }
  }

  if (includeDiagnostics && payload.trace && payload.trace.length > 0) {
    const traceLabelByKind: Record<string, string> = {
      message: "消息",
      tool_call: "工具调用",
      tool_result: "工具结果",
      subagent: "内部工作项",
      decision: "Leader 决策",
    };

    const managerTrace = payload.trace.filter(
      (trace) =>
        trace.kind === "decision" ||
        trace.kind === "subagent" ||
        (trace.kind === "message" && trace.source === "task_manager"),
    );
    const executionTrace = payload.trace
      .filter((trace) => !managerTrace.includes(trace))
      .sort((left, right) => {
        const rank = (trace: NonNullable<FeishuQueuedPayload["trace"]>[number]) => {
          if (trace.kind === "tool_call") return 0;
          if (trace.kind === "tool_result") return 1;
          if (trace.kind === "message") return 2;
          return 3;
        };

        const leftRank = rank(left);
        const rightRank = rank(right);
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        const leftAttempt = typeof left.attemptCount === "number" ? left.attemptCount : Number.MAX_SAFE_INTEGER;
        const rightAttempt = typeof right.attemptCount === "number" ? right.attemptCount : Number.MAX_SAFE_INTEGER;
        if (leftAttempt !== rightAttempt) {
          return leftAttempt - rightAttempt;
        }

        const leftSession = left.sessionId ?? "";
        const rightSession = right.sessionId ?? "";
        if (leftSession !== rightSession) {
          return leftSession.localeCompare(rightSession);
        }

        const leftRole = left.roleId ?? "";
        const rightRole = right.roleId ?? "";
        return leftRole.localeCompare(rightRole);
      });

    const formatTraceLine = (trace: NonNullable<FeishuQueuedPayload["trace"]>[number]) => {
      const kind = trace.kind ? traceLabelByKind[trace.kind] ?? trace.kind : "观测";
      const role = trace.roleId ?? (trace.source === "task_manager" ? "leader" : null);
      const roleLabel = role ? `${role} · ` : "";
      const traceTags = [
        trace.executorId,
        typeof trace.attemptCount === "number" ? `第${trace.attemptCount}次` : null,
        trace.sessionId,
      ].filter((value): value is string => Boolean(value));
      const traceLabel = traceTags.length > 0 ? `[${traceTags.join(" / ")}] ` : "";
      const source = trace.source ? ` · ${trace.source}` : "";
      return `- ${kind}：${roleLabel}${traceLabel}${normalizeCoordinatorLabel(trace.text ?? "")}${source}`;
    };

    lines.push("最近观测：");
    if (managerTrace.length > 0) {
      const managerSummary = managerTrace
        .map((trace) => trace.text)
        .filter((value): value is string => Boolean(value))
        .slice(0, 2)
        .join("；");
      if (managerSummary) {
        lines.push(`Leader 观察：${normalizeCoordinatorLabel(managerSummary)}`);
      }
    }
    if (executionTrace.length > 0) {
      lines.push("内部执行时间线：");
      for (const trace of executionTrace) {
        lines.push(formatTraceLine(trace));
      }
    }
  }

  if (payload.nextAction) {
    lines.push(`下一步：${normalizeCoordinatorLabel(payload.nextAction)}`);
  }

  if (detailUrl) {
    lines.push(`详情：${detailUrl}`);
  }

  if (payload.taskId) {
    lines.push(`任务ID：${payload.taskId}`);
  }

  return lines.join("\n");
}

function formatFeishuTextMessage(
  payload: FeishuQueuedPayload,
  options?: {
    verboseLevel?: FeishuVerboseLevel | undefined;
  },
) {
  if (payload.kind === "runtime_trace") {
    return formatFeishuRuntimeTraceMessage(
      payload,
      resolveFeishuVerboseLevel(options?.verboseLevel),
    );
  }

  return resolveFeishuOutboundStyle() === "verbose"
    ? formatFeishuTextMessageVerbose(payload)
    : formatFeishuTextMessageCompact(payload);
}

function createStubFeishuTransport(): FeishuOutboundTransport {
  const config = parseFeishuConfigFromEnv();
  if (!config.appId || !config.appSecret) {
    throw new Error("Feishu outbound delivery requires appId and appSecret.");
  }

  const client = createFeishuClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  return async ({ payload, chatId, replyToMessageId, deliveryMode, verboseLevel }) => {
    if (payload.kind === "task_created") {
      // DEAD PATH (Task 8 / S9): nothing queues a `task_created` outbound
      // payload anymore — `queueFeishuTaskCreatedSummary` has no callers,
      // and the single-card streaming session is now the sole inbound
      // acknowledgement (it eager-creates a "⏳ Thinking…" card). The old
      // "已收到，正在处理" text/reaction ack here produced a redundant
      // second message per turn. Kept only as a defensive reaction-only
      // ack should some future caller re-introduce a task_created queue;
      // it never sends ack TEXT. If `replyToMessageId` is absent there is
      // nothing to react to, so we no-op (no provider message).
      if (replyToMessageId) {
        try {
          const result = await client.addMessageReaction({
            messageId: replyToMessageId,
            emojiType: "OK",
          });
          return { providerMessageId: result.reactionId };
        } catch {
          /* best-effort — fall through to no-op */
        }
      }
      return { providerMessageId: "" };
    }

    const text = formatFeishuTextMessage(payload, { verboseLevel });
    if (deliveryMode === "top_level_preferred") {
      const result = await client.sendTextMessage({
        chatId,
        text,
      });
      return {
        providerMessageId: result.messageId,
      };
    }

    if (replyToMessageId) {
      try {
        const reply = await client.replyTextMessage({
          messageId: replyToMessageId,
          text,
        });
        return {
          providerMessageId: reply.messageId,
        };
      } catch {
        // Fall back to a direct chat send when the reply target is stale or unavailable.
      }
    }

    const result = await client.sendTextMessage({
      chatId,
      text,
    });
    return {
      providerMessageId: result.messageId,
    };
  };
}

export async function deliverQueuedFeishuOutboundEvents(
  input: DeliverQueuedFeishuOutboundEventsInput = {},
) {
  const eventRepository = new ExecutionEventRepository();
  const bindingRepository = new ConversationBindingRepository();
  const outboundClaimRepository = new ChannelOutboundDeliveryClaimRepository();
  const channelSessionService = new ChannelSessionService();
  const observabilityAdapter = new LocalObservabilityAdapter();
  const transport = input.transport ?? createStubFeishuTransport();
  const events = await eventRepository.listAll();
  const deliveredOrFailedIds = new Set(
    events
      .filter(
        (event) =>
          event.type === "channel.outbound.delivered" || event.type === "channel.outbound.failed",
      )
      .map((event) => parseTerminalOutboundEventId(event.payloadJson))
      .filter((outboundEventId): outboundEventId is string => Boolean(outboundEventId)),
  );

  const pendingEvents = events
    .filter((event) => event.type === "channel.outbound.queued")
    .filter((event) => {
      const payload = parseQueuedPayload(event.payloadJson);
      if (!payload) {
        return false;
      }

      if (deliveredOrFailedIds.has(event.id)) {
        return false;
      }

      if (input.eventIds && !input.eventIds.includes(event.id)) {
        return false;
      }

      return true;
    })
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

  const limitedEvents =
    typeof input.limit === "number" ? pendingEvents.slice(0, input.limit) : pendingEvents;

  const deliveries: DeliveryRecord[] = [];
  const failures: FailureRecord[] = [];

  for (const event of limitedEvents) {
    const claim = await outboundClaimRepository.acquireClaim({
      outboundEventId: event.id,
    });
    if (!claim.acquired) {
      continue;
    }

    const payload = parseQueuedPayload(event.payloadJson);
    const bindingId = event.conversationBindingId ?? payload?.bindingId;

    if (!payload || !bindingId) {
      await outboundClaimRepository.finalizeClaim({
        outboundEventId: event.id,
        claimToken: claim.claimToken,
        state: "failed",
      });
      failures.push(
        await recordFailedDelivery({
          observabilityAdapter,
          event,
          bindingId: bindingId ?? "unknown",
          code: "invalid_outbound_payload",
          message: "Feishu outbound payload is missing channel metadata or binding id.",
        }),
      );
      continue;
    }

    const binding = await bindingRepository.getById(bindingId);
    if (!binding || binding.channel !== "feishu") {
      await outboundClaimRepository.finalizeClaim({
        outboundEventId: event.id,
        claimToken: claim.claimToken,
        state: "failed",
      });
      failures.push(
        await recordFailedDelivery({
          observabilityAdapter,
          event,
          bindingId,
          code: "conversation_binding_not_found",
          message: "Conversation binding was not found for the queued Feishu delivery.",
        }),
      );
      continue;
    }

    let deliveryMode: FeishuDeliveryMode | undefined;
    try {
      const session = await channelSessionService.getByBindingId(bindingId);
      deliveryMode = channelSessionService.resolveDeliveryMode({
        session,
        kind: payload.kind,
        hasReplyToMessageId: Boolean(binding.lastPlatformMessageId),
      });
      // Normalize the wider verbose-level union (off|on|full|low|high)
      // down to what this legacy transport accepts (off|on|full). The
      // newer "low"/"high" vocabulary maps to "on"/"full" respectively
      // — they're the same axis, just different names.
      const rawLevel = channelSessionService.resolveVerboseLevel(session);
      const verboseLevel: "off" | "on" | "full" =
        rawLevel === "low" ? "on" : rawLevel === "high" ? "full" : (rawLevel as "off" | "on" | "full");
      const result = await transport({
        outboundEventId: event.id,
        bindingId,
        chatId: binding.chatId,
        ...(
          binding.lastPlatformMessageId &&
          (deliveryMode === "reply_preferred" || deliveryMode === "reaction_only")
            ? { replyToMessageId: binding.lastPlatformMessageId }
            : {}
        ),
        deliveryMode,
        verboseLevel,
        workspaceId: event.workspaceId ?? binding.workspaceId,
        payload,
      });

      if (!(deliveryMode === "reaction_only" && payload.kind === "task_created")) {
        await channelSessionService.recordOutboundDelivery({
          bindingId,
          channel: "feishu",
          workspaceId: event.workspaceId ?? binding.workspaceId,
          latestDeliveredMessageId: result.providerMessageId,
          latestAnswerSummary:
            payload.latestAnswer ?? payload.summary ?? payload.title ?? payload.taskTitle ?? null,
        });
      }

      const finalized = await outboundClaimRepository.finalizeClaim({
        outboundEventId: event.id,
        claimToken: claim.claimToken,
        state: "delivered",
      });
      if (!finalized) {
        continue;
      }

      deliveries.push(
        await recordDeliveredEvent({
          observabilityAdapter,
          event,
          payload,
          bindingId,
          chatId: binding.chatId,
          providerMessageId: result.providerMessageId,
          deliveryMode,
        }),
      );
    } catch (error) {
      const finalized = await outboundClaimRepository.finalizeClaim({
        outboundEventId: event.id,
        claimToken: claim.claimToken,
        state: "failed",
      });
      if (!finalized) {
        continue;
      }

      failures.push(
        await recordFailedDelivery({
          observabilityAdapter,
          event,
          bindingId,
          chatId: binding.chatId,
          code: "delivery_failed",
          message: error instanceof Error ? error.message : "Unknown outbound delivery failure",
          ...(deliveryMode ? { deliveryMode } : {}),
        }),
      );
    }
  }

  return {
    deliveredCount: deliveries.length,
    failedCount: failures.length,
    deliveries,
    failures,
  };
}

async function recordDeliveredEvent(input: {
  observabilityAdapter: LocalObservabilityAdapter;
  event: {
    id: string;
    taskId: string | null;
    conversationBindingId: string | null;
    workspaceId: string | null;
  };
  payload: FeishuQueuedPayload;
  bindingId: string;
  chatId: string;
  providerMessageId: string;
  deliveryMode: FeishuDeliveryMode;
}) {
  const deliveredPayload = {
    channel: "feishu" as const,
    outboundEventId: input.event.id,
    bindingId: input.bindingId,
    chatId: input.chatId,
    kind: input.payload.kind,
    ...(input.payload.title ? { title: input.payload.title } : {}),
    ...(input.payload.summary ? { summary: input.payload.summary } : {}),
    ...(input.payload.taskTitle ? { taskTitle: input.payload.taskTitle } : {}),
    ...(input.payload.taskState ? { taskState: input.payload.taskState } : {}),
    ...(input.payload.stopReason ? { stopReason: input.payload.stopReason } : {}),
    ...(input.payload.latestAnswer ? { latestAnswer: input.payload.latestAnswer } : {}),
    ...(input.payload.nextAction ? { nextAction: input.payload.nextAction } : {}),
    ...(input.payload.roleProgress ? { roleProgress: input.payload.roleProgress } : {}),
    providerMessageId: input.providerMessageId,
    deliveryMode: input.deliveryMode,
  };

  await input.observabilityAdapter.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: "channel.outbound.delivered",
    taskId: input.event.taskId ?? undefined,
    conversationBindingId: input.event.conversationBindingId ?? input.bindingId,
    workspaceId: input.event.workspaceId ?? undefined,
    severity: "info",
    occurredAt: new Date(),
    payloadJson: JSON.stringify(deliveredPayload),
  });

  return {
    outboundEventId: input.event.id,
    bindingId: input.bindingId,
    chatId: input.chatId,
    kind: input.payload.kind,
    providerMessageId: input.providerMessageId,
  };
}

async function recordFailedDelivery(input: {
  observabilityAdapter: LocalObservabilityAdapter;
  event: {
    id: string;
    taskId: string | null;
    conversationBindingId: string | null;
    workspaceId: string | null;
  };
  bindingId: string;
  chatId?: string;
  code: string;
  message: string;
  deliveryMode?: FeishuDeliveryMode;
}) {
  const failurePayload = {
    channel: "feishu" as const,
    outboundEventId: input.event.id,
    bindingId: input.bindingId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    code: input.code,
    message: input.message,
    ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
  };

  await input.observabilityAdapter.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: "channel.outbound.failed",
    taskId: input.event.taskId ?? undefined,
    conversationBindingId: input.event.conversationBindingId ?? input.bindingId,
    workspaceId: input.event.workspaceId ?? undefined,
    severity: "warn",
    occurredAt: new Date(),
    payloadJson: JSON.stringify(failurePayload),
  });

  return {
    outboundEventId: input.event.id,
    bindingId: input.bindingId,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    code: input.code,
    message: input.message,
  };
}
