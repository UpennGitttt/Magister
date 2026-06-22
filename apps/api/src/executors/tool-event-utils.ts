export type ParsedToolEvent = {
  type: "tool.call" | "tool.result" | "tool.error";
  toolName: string;
  summary: string;
  toolCallId?: string;
  arguments?: unknown;
  result?: unknown;
  errorMessage?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolEventType(rawType: unknown): ParsedToolEvent["type"] | null {
  if (typeof rawType !== "string") {
    return null;
  }

  const normalized = rawType.trim().toLowerCase();
  if (
    normalized === "tool.started" ||
    normalized === "tool.start" ||
    normalized === "tool.call"
  ) {
    return "tool.call";
  }

  if (
    normalized === "tool.completed" ||
    normalized === "tool.complete" ||
    normalized === "tool.result"
  ) {
    return "tool.result";
  }

  if (normalized === "tool.failed" || normalized === "tool.error") {
    return "tool.error";
  }

  return null;
}

function readToolName(payload: Record<string, unknown>) {
  const nestedTool = isPlainObject(payload.tool) ? payload.tool : null;
  const candidates = [
    nestedTool?.name,
    payload.toolName,
    payload.name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function readToolArguments(payload: Record<string, unknown>) {
  const nestedTool = isPlainObject(payload.tool) ? payload.tool : null;
  if (Object.prototype.hasOwnProperty.call(nestedTool ?? {}, "arguments")) {
    return nestedTool?.arguments;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "arguments")) {
    return payload.arguments;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "params")) {
    return payload.params;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "input")) {
    return payload.input;
  }
  return undefined;
}

function readToolResult(payload: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(payload, "result")) {
    return payload.result;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "output")) {
    return payload.output;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "observation")) {
    return payload.observation;
  }
  return undefined;
}

function readToolErrorMessage(payload: Record<string, unknown>) {
  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (isPlainObject(error) && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message.trim();
  }
  return undefined;
}

function readToolCallId(payload: Record<string, unknown>) {
  const nestedTool = isPlainObject(payload.tool) ? payload.tool : null;
  const candidates = [
    payload.toolCallId,
    payload.tool_call_id,
    payload.call_id,
    nestedTool?.toolCallId,
    nestedTool?.tool_call_id,
    nestedTool?.call_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function buildToolEventSummary(
  type: ParsedToolEvent["type"],
  toolName: string,
  payload: Record<string, unknown>,
) {
  if (type === "tool.call") {
    return `Tool ${toolName} started`;
  }
  if (type === "tool.result") {
    const result = readToolResult(payload);
    if (typeof result === "string" && result.trim().length > 0) {
      return `Tool ${toolName} completed: ${result.trim()}`;
    }
    return `Tool ${toolName} completed`;
  }

  const errorMessage = readToolErrorMessage(payload);
  return errorMessage
    ? `Tool ${toolName} failed: ${errorMessage}`
    : `Tool ${toolName} failed`;
}

function extractToolEventFromPayload(payload: Record<string, unknown>): ParsedToolEvent | null {
  const type = normalizeToolEventType(payload.type);
  if (!type) {
    return null;
  }

  const toolName = readToolName(payload);
  if (!toolName) {
    return null;
  }

  return {
    type,
    toolName,
    summary: buildToolEventSummary(type, toolName, payload),
    ...(readToolCallId(payload) ? { toolCallId: readToolCallId(payload)! } : {}),
    ...(readToolArguments(payload) !== undefined ? { arguments: readToolArguments(payload) } : {}),
    ...(readToolResult(payload) !== undefined ? { result: readToolResult(payload) } : {}),
    ...(readToolErrorMessage(payload) ? { errorMessage: readToolErrorMessage(payload)! } : {}),
  };
}

export function extractExplicitToolEventsFromJsonLines(stdout: string): ParsedToolEvent[] {
  const events: ParsedToolEvent[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }

      const directEvent = extractToolEventFromPayload(parsed);
      if (directEvent) {
        events.push(directEvent);
        continue;
      }

      const nestedItem = isPlainObject(parsed.item) ? parsed.item : null;
      if (!nestedItem) {
        continue;
      }
      const nestedEvent = extractToolEventFromPayload(nestedItem);
      if (nestedEvent) {
        events.push(nestedEvent);
      }
    } catch {
      continue;
    }
  }

  return events;
}
