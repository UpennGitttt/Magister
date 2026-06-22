import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { ChannelSessionService } from "./channel-session-service";
import { dispatchQueuedFeishuOutboundEventBestEffort } from "./dispatch-feishu-outbound-event-service";
import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";

export type FeishuRuntimeTracePayload = {
  channel: "feishu";
  kind: "runtime_trace";
  bindingId: string;
  taskId: string;
  sourceEventId: string;
  eventType: string;
  summary: string;
  details?: Record<string, unknown>;
  roleId?: string;
  executorId?: string;
  sessionId?: string;
  attemptCount?: number;
};

type QueueFeishuRuntimeTraceInput = Omit<FeishuRuntimeTracePayload, "channel" | "kind"> & {
  workspaceId: string;
};

type QueueFeishuRuntimeTraceIfEnabledInput = {
  workspaceId: string;
  taskId: string;
  sourceEventId: string;
  eventType: string;
  summary: string;
  details?: Record<string, unknown> | undefined;
  roleId?: string | undefined;
  executorId?: string | undefined;
  sessionId?: string | undefined;
  attemptCount?: number | undefined;
  source: string;
  rootChannelBindingId?: string | null | undefined;
};

/** Simplified input for leader loop event types. */
type QueueFeishuLeaderEventInput = {
  taskId: string;
  runId: string;
  bindingId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

type QueuedFeishuRuntimeTraceEvent = {
  eventId: string;
  payload: FeishuRuntimeTracePayload;
};

export function formatLeaderEventForTrace(
  eventType: string,
  payload: Record<string, unknown>,
): string | null {
  switch (eventType) {
    case "leader.tool_call":
      return `🔧 ${payload.toolName}: ${payload.inputSummary ?? ""}`;
    case "leader.tool_result":
      return payload.isError
        ? `❌ ${payload.toolName} failed: ${payload.outputSummary ?? ""}`
        : `✅ ${payload.toolName} completed`;
    case "leader.teammate_spawned":
      return `👤 Spawned ${payload.teammateName}: ${payload.goal ?? ""}`;
    case "leader.teammate_completed":
      return `👤 ${payload.teammateRunId} finished: ${payload.reason}`;
    case "leader.session_complete":
      return `📋 Task complete (${payload.totalTurns} turns): ${payload.finalAnswer ?? payload.reason}`;
    case "leader.turn_start":
      return `⏳ Turn ${payload.turnCount}...`;
    default:
      return null;
  }
}

export function shouldDeliverEvent(eventType: string, verboseLevel: string): boolean {
  if (eventType === "leader.session_complete") return true;
  if (verboseLevel === "off") return false;
  // Accept both legacy ("on"/"full") and canonical ("low"/"high") vocab.
  // Without the alias, the FeishuChatSession rewrite's new "low"/"high"
  // values would fall through the prior strict guard and silently
  // map to the "deliver everything" branch.
  if (verboseLevel === "on" || verboseLevel === "low") {
    return ["leader.tool_call", "leader.teammate_spawned", "leader.teammate_completed"].includes(
      eventType,
    );
  }
  if (verboseLevel === "full" || verboseLevel === "high") {
    return true;
  }
  return false;
}

export async function queueFeishuRuntimeTraceEvent(
  input: QueueFeishuRuntimeTraceInput,
): Promise<QueuedFeishuRuntimeTraceEvent> {
  const observabilityAdapter = new LocalObservabilityAdapter();
  const eventId = `event_${crypto.randomUUID()}`;
  const payload: FeishuRuntimeTracePayload = {
    channel: "feishu",
    kind: "runtime_trace",
    bindingId: input.bindingId,
    taskId: input.taskId,
    sourceEventId: input.sourceEventId,
    eventType: input.eventType,
    summary: input.summary,
    ...(input.details ? { details: input.details } : {}),
    ...(input.roleId ? { roleId: input.roleId } : {}),
    ...(input.executorId ? { executorId: input.executorId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(typeof input.attemptCount === "number" ? { attemptCount: input.attemptCount } : {}),
  };

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

export async function queueFeishuRuntimeTraceIfEnabled(
  input: QueueFeishuRuntimeTraceIfEnabledInput | QueueFeishuLeaderEventInput,
): Promise<QueuedFeishuRuntimeTraceEvent | null> {
  // Handle leader loop event shape
  if ("runId" in input) {
    const summary = formatLeaderEventForTrace(input.eventType, input.payload);
    if (summary === null) {
      return null;
    }

    const channelSessionService = new ChannelSessionService();
    const session = await channelSessionService.getByBindingId(input.bindingId);
    const verboseLevel = channelSessionService.resolveVerboseLevel(session);

    if (!shouldDeliverEvent(input.eventType, verboseLevel)) {
      return null;
    }

    const queued = await queueFeishuRuntimeTraceEvent({
      bindingId: input.bindingId,
      workspaceId: input.taskId, // use taskId as workspaceId fallback for leader events
      taskId: input.taskId,
      sourceEventId: input.runId,
      eventType: input.eventType,
      summary,
      details: input.payload,
    });

    const feishuConfig = parseFeishuConfigFromEnv();
    if (feishuConfig.appId && feishuConfig.appSecret) {
      await dispatchQueuedFeishuOutboundEventBestEffort({
        eventId: queued.eventId,
        kind: queued.payload.kind,
        taskId: input.taskId,
        bindingId: input.bindingId,
        workspaceId: input.taskId,
        failureType: "channel.outbound.delivery_failed",
      });
    }

    return queued;
  }

  // Handle original shape
  if (input.source !== "feishu" || !input.rootChannelBindingId) {
    return null;
  }

  const channelSessionService = new ChannelSessionService();
  const session = await channelSessionService.getByBindingId(input.rootChannelBindingId);
  const verboseLevel = channelSessionService.resolveVerboseLevel(session);

  if (verboseLevel === "off") {
    return null;
  }

  const queued = await queueFeishuRuntimeTraceEvent({
    bindingId: input.rootChannelBindingId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    sourceEventId: input.sourceEventId,
    eventType: input.eventType,
    summary: input.summary,
    ...(input.details ? { details: input.details } : {}),
    ...(input.roleId ? { roleId: input.roleId } : {}),
    ...(input.executorId ? { executorId: input.executorId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(typeof input.attemptCount === "number" ? { attemptCount: input.attemptCount } : {}),
  });

  const feishuConfig = parseFeishuConfigFromEnv();
  if (feishuConfig.appId && feishuConfig.appSecret) {
    await dispatchQueuedFeishuOutboundEventBestEffort({
      eventId: queued.eventId,
      kind: queued.payload.kind,
      taskId: input.taskId,
      bindingId: input.rootChannelBindingId,
      workspaceId: input.workspaceId,
      failureType: "channel.outbound.delivery_failed",
    });
  }

  return queued;
}
