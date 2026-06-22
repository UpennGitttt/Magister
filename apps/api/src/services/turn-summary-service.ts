import type { ExecutionEventSelect } from "@magister/db";

import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TokenUsageRepository } from "../repositories/token-usage-repository";
import { calculateTurnTiming, type TurnTiming } from "./turn-timing-service";

export type TurnUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type TurnToolSummary = {
  readCount: number;
  writeCount: number;
  approvalCount: number;
  delegationCount: number;
  failedCount: number;
  totalCount: number;
};

export type TurnSummary = {
  requestId: string;
  status: "running" | "completed" | "failed";
  timing?: TurnTiming;
  usage: TurnUsageSummary | null;
  toolSummary: TurnToolSummary;
};

type EventRow = Pick<
  ExecutionEventSelect,
  "id" | "type" | "requestId" | "occurredAt" | "payloadJson" | "seq"
>;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "list_files",
  "search_files",
  "grep",
  "web_search",
  "web_fetch",
  "get_task_context",
  "get_run_context",
  "read_teammate_transcript",
]);

const WRITE_TOOL_NAMES = new Set([
  "apply_patch",
  "write_file",
  "edit_file",
  "bash",
  "run_command",
  "git_commit",
]);

function readPayload(payloadJson?: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readTimingPayload(value: unknown): TurnTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const startedAtMs = typeof input.startedAtMs === "number" ? input.startedAtMs : undefined;
  const completedAtMs = typeof input.completedAtMs === "number" ? input.completedAtMs : undefined;
  const wallMs = typeof input.wallMs === "number" ? input.wallMs : undefined;
  const pausedMs = typeof input.pausedMs === "number" ? input.pausedMs : undefined;
  const elapsedMs = typeof input.elapsedMs === "number" ? input.elapsedMs : undefined;
  if (
    startedAtMs === undefined ||
    completedAtMs === undefined ||
    wallMs === undefined ||
    pausedMs === undefined ||
    elapsedMs === undefined
  ) {
    return undefined;
  }
  return { startedAtMs, completedAtMs, wallMs, pausedMs, elapsedMs };
}

function summarizeTools(events: EventRow[]): TurnToolSummary {
  const summary: TurnToolSummary = {
    readCount: 0,
    writeCount: 0,
    approvalCount: 0,
    delegationCount: 0,
    failedCount: 0,
    totalCount: 0,
  };
  const failedToolUseIds = new Set<string>();

  for (const event of events) {
    const payload = readPayload(event.payloadJson);
    if (event.type === "leader.approval_requested") {
      summary.approvalCount += 1;
      continue;
    }
    if (
      event.type === "leader.tool_timeout" ||
      (event.type === "leader.tool_result" && payload.isError === true)
    ) {
      const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : event.id;
      if (!failedToolUseIds.has(toolUseId)) {
        failedToolUseIds.add(toolUseId);
        summary.failedCount += 1;
      }
      continue;
    }
    if (event.type !== "leader.tool_call") continue;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    summary.totalCount += 1;
    if (toolName === "spawn_teammate") {
      summary.delegationCount += 1;
    } else if (READ_TOOL_NAMES.has(toolName)) {
      summary.readCount += 1;
    } else if (WRITE_TOOL_NAMES.has(toolName)) {
      summary.writeCount += 1;
    }
  }

  return summary;
}

function terminalStatus(events: EventRow[]): {
  status: TurnSummary["status"];
  terminalEvent?: EventRow;
} {
  let terminalEvent: EventRow | undefined;
  for (const event of events) {
    if (
      event.type === "task:completed" ||
      event.type === "leader.session_complete" ||
      event.type === "task:failed" ||
      event.type === "task:cancelled"
    ) {
      terminalEvent = event;
    }
  }
  if (!terminalEvent) return { status: "running" };
  return {
    // task:cancelled folds into "completed" (matches the projector's
    // markTerminal("complete") treatment) — UI distinguishes via
    // task.state, not turn summary status.
    status: terminalEvent.type === "task:failed" ? "failed" : "completed",
    terminalEvent,
  };
}

function deriveTiming(
  requestId: string,
  events: EventRow[],
  terminalEvent?: EventRow,
): TurnTiming | undefined {
  if (!terminalEvent) return undefined;
  const terminalPayload = readPayload(terminalEvent.payloadJson);
  const fromPayload = readTimingPayload(terminalPayload.timing);
  if (fromPayload) return fromPayload;

  const firstEvent = events[0];
  if (!firstEvent) return undefined;
  return calculateTurnTiming({
    requestId,
    startedAtMs: firstEvent.occurredAt.getTime(),
    completedAtMs: terminalEvent.occurredAt.getTime(),
    events,
  });
}

export async function getTaskTurnSummaries(taskId: string): Promise<TurnSummary[]> {
  const eventRepository = new ExecutionEventRepository();
  const events = await eventRepository.listLatestRequestEvents(taskId);
  const grouped = new Map<string, EventRow[]>();

  for (const event of events) {
    if (!event.requestId) continue;
    const rows = grouped.get(event.requestId) ?? [];
    rows.push(event);
    grouped.set(event.requestId, rows);
  }

  const requestIds = [...grouped.entries()]
    .sort((a, b) => {
      const aSeq = a[1][0]?.seq ?? 0;
      const bSeq = b[1][0]?.seq ?? 0;
      return aSeq - bSeq;
    })
    .map(([requestId]) => requestId);

  const usageRows = await new TokenUsageRepository().listUsageByRequestIds(taskId, requestIds);
  const usageByRequestId = new Map(usageRows.map((row) => [row.requestId, row]));

  return requestIds.map((requestId) => {
    const requestEvents = (grouped.get(requestId) ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const { status, terminalEvent } = terminalStatus(requestEvents);
    const timing = deriveTiming(requestId, requestEvents, terminalEvent);
    return {
      requestId,
      status,
      ...(timing ? { timing } : {}),
      usage: usageByRequestId.get(requestId) ?? null,
      toolSummary: summarizeTools(requestEvents),
    };
  });
}
