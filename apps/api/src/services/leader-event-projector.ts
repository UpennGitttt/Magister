import type { LeaderLoopEvent } from "./manager-automation/autonomous-loop/autonomous-types";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { wsHub } from "../ws/hub";
import { taskEventBus } from "../sse/task-event-bus";

// UI summary cap raised from 500B → 50KB.
// These payloads are SSE → DB → UI display only; never seen by the
// leader's API call. The old 500-char cap meant users could not read
// a teammate's full output unless they manually opened the trace
// panel. 50KB fits a complete source file or a long bash output.
// Beyond 50KB consumers are expected to call the lazy-load endpoint
// (Step 1 §Δ.1) — design parked for v3.
const MAX_SUMMARY_LENGTH = 50_000;

function truncate(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_SUMMARY_LENGTH) {
    return value.slice(0, MAX_SUMMARY_LENGTH);
  }
  return value;
}

function truncatePayload(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = key.endsWith("Summary") ? truncate(value) : value;
  }
  return result;
}

export function createEventProjector(context: {
  taskId: string;
  runId: string;
  /**
   * Per-prompt scope identifier. Required: every event the projector
   * emits — to wsHub.broadcast AND taskEventBus.publish — is stamped
   * with this so the client-side projector (PR 2) can group events
   * deterministically. Crash recovery threads the recovered requestId
   * from the checkpoint; teammate spawns inherit the parent's value.
   * No silent fallback — callers must pass it.
   */
  requestId: string;
  channelBindingId?: string;
  agentRole?: string;
  agentName?: string;
  agentDepth?: number;
  parentAgentId?: string;
  /**
   * the tool_use_id of the leader's
   * `spawn_teammate` call that produced this teammate runtime. When
   * set, it's stamped into `agentMeta.parentToolUseId` on every event
   * emitted by this projector so the frontend pairs nested teammate
   * events to the parent ToolPart with zero cross-event state.
   * Leader's own projector leaves this undefined (depth 0).
   */
  parentToolUseId?: string;
  /**
   * Root-level trace identifier for the work tree this projector
   * belongs to. Stamped on every emitted event so the trace view can
   * fetch the full tree in a single indexed SELECT. When omitted,
   * falls back to `taskId`. Callers derived from another trace should
   * pass the originating trace_id here.
   */
  traceId?: string;
}): (event: LeaderLoopEvent) => Promise<void> {
  const eventRepository = new ExecutionEventRepository();
  const traceIdCol = context.traceId ?? context.taskId;

  return async (event: LeaderLoopEvent) => {
    const truncatedData = truncatePayload(event.data);
    // Per-event override: if the emitter set `event.data.requestId` to
    // something different from the context's, honor it. Used by the
    // plan-mode wrapper in `autonomous-loop-service.ts` to re-stamp
    // `leader.plan_mode_exited` with the requestId of the original
    // `leader.plan_proposed` so the live and replay projectors apply
    // the status change to the existing PlanCard rather than orphaning
    // it. All other events leave `event.data.requestId` equal to
    // `context.requestId`, so this is a no-op for them.
    const dataRequestId = typeof event.data["requestId"] === "string" ? event.data["requestId"] as string : undefined;
    const requestId = dataRequestId ?? context.requestId;

    const eventId = `leader_${event.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const occurredAt = new Date(event.timestamp);
    const agentMeta = {
      id: context.runId,
      role: context.agentRole ?? "leader",
      name: context.agentName ?? context.agentRole ?? "Leader",
      depth: context.agentDepth ?? 0,
      parentId: context.parentAgentId,
      ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
    };

    // Fast path for `leader.stream_delta`: broadcast first, persist
    // async. Stream deltas dominate event volume (~100× over
    // tool_call) and they were blocking the SSE hot path on every
    // SQLite insert. Net effect on the chat UI: model thinking
    // content was arriving perceptibly late ("all at once at the
    // end" instead of token-by-token). Persistence is best-effort —
    // a crash before the row lands costs us streaming-text replay
    // fidelity, which is recoverable from the next
    // `leader.session_checkpoint` event (those still go through the
    // synchronous path below).
    // persist the agent envelope on every
    // row so snapshot replay emits WireEvents bit-identical to the
    // live SSE path. `parentToolUseId` is also denormalized into its
    // own column for the indexed teammate-transcript lazy-load query.
    const agentJson = JSON.stringify(agentMeta);
    const parentToolUseIdCol = context.parentToolUseId ?? null;

    if (event.type === "leader.stream_delta") {
      const seq = await eventRepository.allocSeq();
      const payload = {
        type: event.type,
        requestId,
        data: truncatedData,
        timestamp: event.timestamp,
        seq,
        agent: agentMeta,
      };
      wsHub.broadcast(context.taskId, payload);
      taskEventBus.publish(context.taskId, payload);
      void eventRepository
        .persistWithSeq(
          {
            id: eventId,
            type: event.type,
            taskId: context.taskId,
            roleRuntimeId: context.runId,
            requestId,
            occurredAt,
            payloadJson: JSON.stringify(truncatedData),
            agentJson,
            parentToolUseId: parentToolUseIdCol,
            traceId: traceIdCol,
          },
          seq,
        )
        .catch((err) => {
          console.warn(
            `[event-projector] DB persist failed for ${event.type} seq=${seq}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      return;
    }

    // Default path: durability matters for non-streaming events
    // (task:completed, plan_proposed, tool_result, etc.) — await
    // the DB write before broadcasting.
    const seq = await eventRepository.create({
      id: eventId,
      type: event.type,
      taskId: context.taskId,
      roleRuntimeId: context.runId,
      requestId,
      occurredAt,
      payloadJson: JSON.stringify(truncatedData),
      agentJson,
      parentToolUseId: parentToolUseIdCol,
      traceId: traceIdCol,
    });

    const payload = {
      type: event.type,
      requestId,
      data: truncatedData,
      timestamp: event.timestamp,
      seq,
      agent: agentMeta,
    };
    wsHub.broadcast(context.taskId, payload);
    taskEventBus.publish(context.taskId, payload);
  };
}
