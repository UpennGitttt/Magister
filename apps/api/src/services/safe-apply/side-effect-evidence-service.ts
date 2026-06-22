import type { LeaderLoopEvent } from "../manager-automation/autonomous-loop/autonomous-types";

type ObservedToolEvent = Pick<LeaderLoopEvent, "type"> & {
  toolName?: string;
  data?: Record<string, unknown>;
};

type ToolSafetyClassification = "read_only" | "mutating" | "unknown";

export type ObservedSideEffectEvidence = {
  eventTypes: string[];
  toolNames: string[];
};

function getToolName(event: ObservedToolEvent): string {
  const direct = event.toolName;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const fromData = event.data?.toolName;
  return typeof fromData === "string" && fromData.length > 0 ? fromData : "";
}

function getToolUseId(event: ObservedToolEvent): string {
  const fromData = event.data?.toolUseId ?? event.data?.toolCallId;
  return typeof fromData === "string" && fromData.length > 0 ? fromData : "";
}

function getToolSafetyClassification(event: ObservedToolEvent): ToolSafetyClassification | null {
  const safety = event.data?.toolSafety;
  if (!safety || typeof safety !== "object") return null;
  const classification = (safety as { classification?: unknown }).classification;
  return classification === "read_only" || classification === "mutating" || classification === "unknown"
    ? classification
    : null;
}

function isCliParsedToolEvent(event: ObservedToolEvent): boolean {
  return event.type === "tool.call" || event.type === "tool.result" || event.type === "tool.error";
}

function isSafeApplySideEffectEvent(event: ObservedToolEvent): boolean {
  if (isCliParsedToolEvent(event)) return true;
  if (event.type === "leader.tool_timeout") return true;

  const toolName = getToolName(event);
  if (event.type === "leader.tool_call") {
    return getToolSafetyClassification(event) !== "read_only";
  }

  if (event.type === "leader.tool_result") {
    return false;
  }

  return toolName === "bash" || toolName.startsWith("mcp.") || toolName.startsWith("mcp__");
}

export function isSafeApplySideEffectEvidenceCandidate(event: ObservedToolEvent): boolean {
  if (isCliParsedToolEvent(event)) return true;
  if (
    event.type === "leader.tool_call" ||
    event.type === "leader.tool_result" ||
    event.type === "leader.tool_timeout"
  ) {
    return true;
  }
  const toolName = getToolName(event);
  return toolName === "bash" || toolName.startsWith("mcp.") || toolName.startsWith("mcp__");
}

export function buildObservedSideEffectEvidence(
  events: readonly ObservedToolEvent[],
): ObservedSideEffectEvidence {
  const readOnlyToolUseIds = new Set<string>();
  const sideEffectToolUseIds = new Set<string>();
  const observedToolCallIds = new Set<string>();
  const eventTypes = new Set<string>();
  const toolNames = new Set<string>();

  const add = (event: ObservedToolEvent) => {
    eventTypes.add(event.type);
    const toolName = getToolName(event);
    if (toolName) toolNames.add(toolName);
  };

  for (const event of events) {
    if (event.type !== "leader.tool_call") continue;
    const toolUseId = getToolUseId(event);
    if (toolUseId) observedToolCallIds.add(toolUseId);
    const classification = getToolSafetyClassification(event);
    if (classification === "read_only") {
      if (toolUseId) readOnlyToolUseIds.add(toolUseId);
    } else {
      if (toolUseId) sideEffectToolUseIds.add(toolUseId);
    }
  }

  for (const event of events) {
    if (isCliParsedToolEvent(event)) {
      add(event);
      continue;
    }

    if (event.type === "leader.tool_call") {
      if (getToolSafetyClassification(event) !== "read_only") add(event);
      continue;
    }

    if (event.type === "leader.tool_result") {
      const toolUseId = getToolUseId(event);
      if (toolUseId && readOnlyToolUseIds.has(toolUseId)) continue;
      if (!toolUseId || sideEffectToolUseIds.has(toolUseId) || !observedToolCallIds.has(toolUseId)) {
        add(event);
      }
      continue;
    }

    if (event.type === "leader.tool_timeout") {
      add(event);
      continue;
    }

    if (isSafeApplySideEffectEvent(event)) {
      add(event);
    }
  }

  return {
    eventTypes: Array.from(eventTypes),
    toolNames: Array.from(toolNames),
  };
}
