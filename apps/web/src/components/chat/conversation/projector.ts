/**
 * Conversation projector — the pure reducer that maps a stream of backend
 * events to a `Conversation` (Exchange[]).
 *
 * Contract (from spec §3.4):
 *  1. Events are grouped by `requestId`. Events without a known requestId
 *     are dropped at projector entry (stale-filter ordering).
 *  2. Within a group, events apply in `seq` ASC order. Caller is
 *     responsible for sorting — `applyEvents` enforces it.
 *  3. Part identities are stable functions of (requestId, ordinal/toolUseId/
 *     event id), so the projection of the same event log always produces
 *     byte-identical state.
 *  4. Duplicate events (same `(requestId, seq)` already applied) are
 *     dropped — `lastAppliedSeq` per Exchange enforces.
 *  5. Optimistic exchanges live OUTSIDE this projector — chatStore manages
 *     them and merges via `bindRequestId`. The projector handles only
 *     events whose `requestId` already maps to a real exchange (or it
 *     creates a new exchange seeded by the first event's user prompt
 *     when present in `data`).
 *  6. Stale events (different requestId than expected) — handled at
 *     boundary, never partially applied.
 *
 * This file MUST stay pure (no global state, no side effects). All
 * mutation goes through copying. That makes the projector trivially
 * unit-testable AND deterministic across reconnect.
 */

import type {
  AssistantResponse,
  Conversation,
  Exchange,
  MediaPart,
  ModelErrorPart,
  PlanPart,
  ResponsePart,
  SnapshotEvent,
  SystemPart,
  TextPart,
  ThinkingPart,
  TodoItem,
  TodoListPart,
  ToolPart,
  ToolResult,
  WireEvent,
} from "./types";

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Apply a list of events (live or replayed) to a starting conversation.
 * Returns a NEW Conversation; input is never mutated.
 *
 * Caller owns ordering. We sort by seq inside before applying so input
 * order doesn't matter for correctness. (Useful when snapshot replay
 * arrives unsorted alongside a live tail.)
 */
export function applyEvents(
  start: Conversation,
  events: WireEvent[],
): Conversation {
  // Sort defensively (cheap; usually pre-sorted by listByTaskId).
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  let result = start;
  for (const ev of sorted) {
    result = applyEvent(result, ev);
  }
  return result;
}

/**
 * Apply ONE event. Pure. Drops the event if:
 *  - requestId doesn't match any exchange — stale filter (the only way
 *    to create an Exchange is via `chatStore.beginExchange` for the
 *    optimistic flow, or via `projectSnapshot` for cold-load. The
 *    projector NEVER invents one — that would mean accepting a
 *    requestId we have no business knowing about.)
 *  - (requestId, seq) already applied — dedup
 */
export function applyEvent(
  conversation: Conversation,
  event: WireEvent,
): Conversation {
  // task.prompt_merged needs to touch TWO exchanges (delete the orphan
  // optimistic source, append its prompt text to the run's target),
  // which doesn't fit the per-exchange mutateExchange contract. Handle
  // it inline before the standard routing.
  if (event.type === "task.prompt_merged") {
    return applyPromptMerged(conversation, event);
  }

  let exchangeIdx = conversation.exchanges.findIndex((e) => e.id === event.requestId);
  let working = conversation;
  if (exchangeIdx < 0) {
    const maxKnownSeq = conversation.exchanges.reduce(
      (max, exchange) => Math.max(max, exchange.lastAppliedSeq),
      0,
    );
    if (event.seq <= maxKnownSeq) return conversation;
    // No matching exchange yet — seed one. This mirrors `projectSnapshot`
    // pre-seeding by distinct requestId. Critical for follow-up turns
    // initiated outside ChatInput (e.g. PlanCard Approve/Cancel/Revise
    // button posts a sentinel and the backend starts a fresh turn with
    // a new requestId; without this seeding, every event in that turn
    // would land here with no matching exchange and get dropped, leaving
    // the chat visibly stale until the user hard-refreshed and the
    // snapshot path re-seeded the exchanges).
    const eventMs = parseEventTimeMs(event);
    const fresh: Exchange = {
      id: event.requestId,
      status: "streaming",
      user: { content: "", ...(eventMs !== null ? { createdAtMs: eventMs } : {}) },
      response: { parts: [] },
      ...(eventMs !== null ? { timing: { startedAtMs: eventMs, pausedMs: 0 } } : {}),
      lastAppliedSeq: 0,
    };
    working = { ...conversation, exchanges: [...conversation.exchanges, fresh] };
    exchangeIdx = working.exchanges.length - 1;
  }

  const old = working.exchanges[exchangeIdx]!;
  if (event.seq <= old.lastAppliedSeq) return working; // dedup

  const next = mutateExchange(old, event, working.taskId);
  if (next === old && working === conversation) return conversation;

  return {
    ...working,
    exchanges: [
      ...working.exchanges.slice(0, exchangeIdx),
      { ...next, lastAppliedSeq: event.seq },
      ...working.exchanges.slice(exchangeIdx + 1),
    ],
  };
}

/**
 * Fold an orphan-optimistic source exchange into the leader run's
 * target exchange. Emitted by the backend per consumed mailbox prompt
 * (`autonomous-loop-service.ts` mailbox drain) with payload
 * `{sourceRequestId, intoRequestId, content}`.
 *
 * Cases:
 *   1. Source exists + has no leader output → delete source, append its
 *      user.content to target with a separator. The common case (orphan
 *      optimistic exchange that POSTed to mailbox).
 *   2. Source exists + has leader output → defensive: don't delete (the
 *      response would be lost), but DO append `data.content` to target
 *      so the merged prompt still shows up. Shouldn't happen in
 *      practice — a mailbox-consumed source by definition never had its
 *      own run — but the projector is pure so leave-no-trace is cheap.
 *   3. Source missing (pre-fix mailbox row, source out of snapshot
 *      window, or sourceRequestId is null) → just append `data.content`
 *      to target. Fallback for old data + cap-evicted exchanges.
 *
 * Idempotent via lastAppliedSeq on the target — re-applying the same
 * event (snapshot then live) is a no-op.
 */
const PROMPT_MERGE_SEPARATOR = "\n\n---\n\n";

function applyPromptMerged(conversation: Conversation, event: WireEvent): Conversation {
  const data = event.data as {
    sourceRequestId?: string | null;
    intoRequestId?: string;
    content?: string;
  };
  const targetId = data.intoRequestId ?? event.requestId;
  if (!targetId) return conversation;
  const targetIdx = conversation.exchanges.findIndex((e) => e.id === targetId);
  if (targetIdx < 0) return conversation; // target out of cap window — skip
  const target = conversation.exchanges[targetIdx]!;
  if (event.seq <= target.lastAppliedSeq) return conversation; // event-replay dedup

  const sourceId = data.sourceRequestId ?? null;
  // Content-source dedup. If this source has already been folded into
  // the target (e.g. snapshot replay after a live merge), no-op. The
  // earlier substring-includes() check was too broad — a follow-up
  // prompt that happens to be a substring of the initial would get
  // silently dropped. `hydratedRequestIds` is the authoritative tracker.
  if (sourceId && (target.user.hydratedRequestIds ?? []).includes(sourceId)) {
    return {
      ...conversation,
      exchanges: [
        ...conversation.exchanges.slice(0, targetIdx),
        { ...target, lastAppliedSeq: event.seq },
        ...conversation.exchanges.slice(targetIdx + 1),
      ],
    };
  }

  let exchanges = conversation.exchanges;
  let resolvedTargetIdx = targetIdx;
  let foldedContent: string | null = null;
  let foldedAttachments: NonNullable<Exchange["user"]["attachments"]> | undefined;

  if (sourceId) {
    const sourceIdx = exchanges.findIndex((e) => e.id === sourceId);
    if (sourceIdx >= 0) {
      const source = exchanges[sourceIdx]!;
      const sourceHasOutput =
        source.response.parts.length > 0 || source.lastAppliedSeq > 0;
      foldedContent = source.user.content || data.content || "";
      // Carry attachments forward. The mailbox row's attachments live
      // under sourceId server-side (saveAttachments keys by the
      // followUpRequestId at POST time). Without this carry, deleting
      // the source exchange orphans the file chips — the user uploads
      // a file with their queued prompt and on next render it
      // disappears because attachment hydration keys by exchange id.
      if (source.user.attachments && source.user.attachments.length > 0) {
        foldedAttachments = source.user.attachments;
      }
      if (!sourceHasOutput) {
        exchanges = [
          ...exchanges.slice(0, sourceIdx),
          ...exchanges.slice(sourceIdx + 1),
        ];
        if (sourceIdx < targetIdx) resolvedTargetIdx = targetIdx - 1;
      }
    }
  }
  if (foldedContent === null) {
    foldedContent = data.content ?? "";
  }

  const tgt = exchanges[resolvedTargetIdx]!;
  const existing = tgt.user.content;
  const newContent = !foldedContent
    ? existing
    : existing
      ? existing + PROMPT_MERGE_SEPARATOR + foldedContent
      : foldedContent;
  const mergedAttachments = foldedAttachments
    ? [...(tgt.user.attachments ?? []), ...foldedAttachments]
    : tgt.user.attachments;
  const hydrated = tgt.user.hydratedRequestIds ?? [];
  // Track this source as folded so a re-application (snapshot after
  // live, or duplicate event) is a no-op via the early-return above.
  // For null-source events (pre-fix mailbox rows with no minted
  // requestId), we skip tracking — lastAppliedSeq alone handles the
  // replay case without polluting hydratedRequestIds with synthetic keys.
  const nextHydrated = sourceId && !hydrated.includes(sourceId)
    ? [...hydrated, sourceId]
    : hydrated;
  const updated: Exchange = {
    ...tgt,
    user: {
      ...tgt.user,
      content: newContent,
      ...(mergedAttachments && mergedAttachments.length > 0
        ? { attachments: mergedAttachments }
        : {}),
      ...(nextHydrated.length > 0 ? { hydratedRequestIds: nextHydrated } : {}),
    },
    lastAppliedSeq: event.seq,
  };
  return {
    ...conversation,
    exchanges: [
      ...exchanges.slice(0, resolvedTargetIdx),
      updated,
      ...exchanges.slice(resolvedTargetIdx + 1),
    ],
  };
}

/**
 * Snapshot-replay convenience. Takes raw `execution_events` rows
 * (snapshot wire format) and produces a Conversation by:
 *  1. Coercing each row into a WireEvent (parsing payloadJson, falling
 *     back to `data` for legacy rows; dropping rows with no requestId).
 *  2. Sorting by seq.
 *  3. Applying via `applyEvents`.
 *
 * Used by chatStore on cold-load + reconnect. Idempotent: the same
 * SnapshotEvent[] always produces the same Conversation.
 */
export function projectSnapshot(
  taskId: string,
  events: SnapshotEvent[],
): Conversation {
  const { conversation, wireEvents } = seedSnapshotConversation(taskId, events);
  return applyEvents(conversation, wireEvents);
}

/**
 * split out so chatStore can apply
 * snapshot events incrementally (chunked via requestIdleCallback)
 * instead of in one synchronous pass. Returns the seeded conversation
 * (empty exchanges pre-ordered by first seq) plus the sorted WireEvent
 * stream ready to feed into `applyEvents`.
 */
export function seedSnapshotConversation(
  taskId: string,
  events: SnapshotEvent[],
): { conversation: Conversation; wireEvents: WireEvent[] } {
  const parsedRows: Array<{
    ev: SnapshotEvent;
    data: Record<string, unknown>;
    agent?: SnapshotEvent["agent"];
    requestId: string | null;
  }> = [];

  const wireEvents: WireEvent[] = [];
  for (const ev of events) {
    const data = parsePayload(ev);
    if (!data) continue;
    parsedRows.push({
      ev,
      data,
      requestId: ev.requestId,
      ...(ev.agent ? { agent: ev.agent } : {}),
    });
  }

  parsedRows.sort((a, b) => a.ev.seq - b.ev.seq);
  const firstRequestId = parsedRows.find((row) => row.requestId)?.requestId ?? null;
  let latestRequestId: string | null = null;

  // Telemetry-only events the projector no-ops (they never render into the
  // transcript). Excluded from snapshot replay so a requestId carrying ONLY
  // such an event doesn't seed a blank exchange stub. Live SSE already
  // doesn't subscribe to these.
  const NON_RENDERABLE_SNAPSHOT_EVENT_TYPES = new Set(["leader.decision_trace"]);

  for (const row of parsedRows) {
    const { ev, data } = row;
    if (row.requestId) {
      latestRequestId = row.requestId;
    }
    const requestId =
      row.requestId ??
      (isTaskScopedRecoveryNotice(ev.type, data)
        ? latestRequestId ?? firstRequestId
        : null);
    if (!requestId) continue; // legacy NULL-requestId rows stay out of chat replay
    // Drop pure-telemetry events (e.g. decision_trace) from replay — they
    // no-op in the projector, but seeding an exchange for a requestId that
    // has ONLY such events leaves a blank stub in the conversation.
    if (NON_RENDERABLE_SNAPSHOT_EVENT_TYPES.has(ev.type)) continue;
    // forward the agent envelope through to the
    // WireEvent so snapshot replay produces bit-identical events to
    // the live SSE path. Without this, reload-after-streaming loses
    // teammate-depth context that the projector needs for nested
    // routing (codex round-2 review [C] finding). For pre-migration
    // rows where `agentJson` was NULL, the projector treats them as
    // depth=0 (leader) since `agent` is absent — same fallback as
    // legacy live events.
    wireEvents.push({
      type: ev.type,
      requestId,
      seq: ev.seq,
      ...(ev.occurredAt ? { timestamp: ev.occurredAt } : {}),
      data: { ...data, __eventId: ev.id }, // surface event id for model-error part-id derivation
      ...(row.agent ? { agent: row.agent } : {}),
    });
  }

  // applyEvents already sorts internally, but for chunked apply we
  // need the stable sorted order at the seed step so chunks can be
  // sliced safely without per-chunk re-sorting.
  wireEvents.sort((a, b) => a.seq - b.seq);

  // Pre-seed an empty Exchange per distinct requestId — order by the
  // first-seen seq so the conversation list reflects user-prompt order
  // (lower seq = earlier in conversation).
  const seenAt = new Map<string, number>();
  const firstTimeAt = new Map<string, number>();
  for (const we of wireEvents) {
    if (!seenAt.has(we.requestId)) seenAt.set(we.requestId, we.seq);
    if (!firstTimeAt.has(we.requestId)) {
      const ms = parseEventTimeMs(we);
      if (ms !== null) firstTimeAt.set(we.requestId, ms);
    }
  }
  const orderedRequestIds = [...seenAt.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([rid]) => rid);

  const conversation: Conversation = {
    taskId,
    exchanges: orderedRequestIds.map((rid) => {
      const firstMs = firstTimeAt.get(rid);
      return {
        id: rid,
        status: "streaming" as const,
        user: { content: "", ...(firstMs !== undefined ? { createdAtMs: firstMs } : {}) },
        response: { parts: [] },
        lastAppliedSeq: 0,
      };
    }),
  };
  return { conversation, wireEvents };
}

function isTaskScopedRecoveryNotice(
  type: string,
  data: Record<string, unknown>,
): boolean {
  if (type === "task.orchestration.transition") {
    return isRuntimeRecoveryRetry(data);
  }
  if (type === "task.orchestration.stopped") {
    return isRuntimeRecoveryBlocked(data);
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Per-event mutation
// ──────────────────────────────────────────────────────────────────────

function mutateExchange(exchange: Exchange, event: WireEvent, taskId: string): Exchange {
  // teammate routing. Events emitted by
  // a depth>=1 agent (i.e. nested teammate run) carry `agent.depth`
  // and `agent.parentToolUseId` in their wire envelope. Route them
  // into the matching spawn_teammate ToolPart's `transcript[]`
  // instead of the flat `exchange.response.parts[]`. The leader
  // chat surface stays clean — teammate transcripts are nested
  // under their owning ToolPart, default-collapsed in render.
  if (event.agent && event.agent.depth > 0) {
    const timedExchange =
      isApprovalEvent(event.type) ? applyTimingEvent(exchange, event) : exchange;
    return applyTeammateNestedEvent(timedExchange, event, taskId);
  }

  const timedExchange = applyTimingEvent(exchange, event);

  switch (event.type) {
    case "leader.teammate_spawned":
      return applyTeammateSpawned(timedExchange, event);
    case "leader.teammate_completed":
      return applyTeammateCompleted(timedExchange, event);
    case "leader.async_teammate_consumed":
      return applySystemNotice(timedExchange, event, "async_teammate");
    case "leader.stream_delta":
      return applyStreamDelta(timedExchange, event);
    case "leader.tool_call":
      return applyToolCall(timedExchange, event);
    case "leader.tool_result":
      return applyToolResult(timedExchange, event);
    case "leader.media_sent":
      return applyMediaSent(timedExchange, event, taskId);
    case "leader.approval_requested":
      return applyApprovalRequested(timedExchange, event);
    case "leader.approval_resolved":
    case "approval.resolved":
      // `approval.resolved` is emitted by approval-service (the plain
      // /approvals/:id/approve|reject routes used by the web card's
      // button). Semantically the same as command-approval-service's
      // `leader.approval_resolved` — both terminate the same DB row.
      // Without handling both, an approval rejected via the web UI
      // button left the inline card visible forever.
      return applyApprovalResolved(timedExchange, event);
    case "leader.messages_compacted":
      return applySystemNotice(timedExchange, event, "compaction");
    case "leader.doom_loop_detected":
      return applySystemNotice(timedExchange, event, "doom_loop");
    case "leader.max_turns":
      return applySystemNotice(timedExchange, event, "max_turns");
    case "leader.model_switched":
      return applySystemNotice(timedExchange, event, "model_switched");
    case "task.orchestration.transition":
      return isRuntimeRecoveryRetry(event.data)
        ? applySystemNotice(timedExchange, event, "recovery")
        : timedExchange;
    case "task.orchestration.stopped":
      return isRuntimeRecoveryBlocked(event.data)
        ? applySystemNotice(timedExchange, event, "recovery_blocked")
        : timedExchange;
    case "leader.turn_complete":
      return sealActivePart(timedExchange, ["text", "thinking"]);
    case "leader.model_error":
      return applyModelError(timedExchange, event);
    case "leader.plan_mode_entered": {
      // No PlanPart yet, but the badge needs to appear DURING the
      // PLANNING phase too — so we set planPhase here. The badge
      // checker reads this; PlanPart status is the second signal
      // (used for AWAITING_APPROVAL specifically).
      // Also defensively clear any stale `pendingPlanExit` from a
      // prior plan cycle so the next exit's status doesn't get glued
      // onto the upcoming PlanPart from THIS cycle.
      const next: Exchange = { ...timedExchange, planPhase: "planning" };
      delete next.pendingPlanExit;
      return next;
    }
    case "leader.plan_proposed":
      return applyPlanProposed(timedExchange, event);
    case "leader.plan_mode_exited":
      return applyPlanModeExited(timedExchange, event);
    case "task:completed":
    case "leader.session_complete": {
      // AWAITING_TEAMMATES is reported via task:completed (the leader's
      // exchange ended) but the task is still live. Don't freeze in-flight
      // spawn_teammate ToolParts as failed — they're legitimately running
      // in background. Mark the exchange complete but leave teammate
      // status as-is.
      const data = event.data as { state?: string } | undefined;
      const skipTeammateFreeze = data?.state === "AWAITING_TEAMMATES";
      return markTerminal(timedExchange, "complete", undefined, skipTeammateFreeze);
    }
    case "task:failed":
      return markTerminal(timedExchange, "failed");
    case "task:cancelled":
      // Treat user-cancellation as terminal too — the previous fall-
      // through to default left exchanges in `streaming` forever once
      // we started emitting a distinct task:cancelled event. Reusing
      // "complete" status — UI distinguishes via task.state rendering.
      return markTerminal(timedExchange, "complete", "cancelled");
    default:
      return timedExchange;
  }
}

function parseEventTimeMs(event: WireEvent): number | null {
  if (!event.timestamp) return null;
  const ms = Date.parse(event.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTimingPayload(value: unknown): Exchange["timing"] | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const timing: Exchange["timing"] = {};
  const startedAtMs = readNumber(input.startedAtMs);
  const completedAtMs = readNumber(input.completedAtMs);
  const wallMs = readNumber(input.wallMs);
  const pausedMs = readNumber(input.pausedMs);
  const elapsedMs = readNumber(input.elapsedMs);
  if (startedAtMs !== undefined) timing.startedAtMs = startedAtMs;
  if (completedAtMs !== undefined) timing.completedAtMs = completedAtMs;
  if (wallMs !== undefined) timing.wallMs = wallMs;
  if (pausedMs !== undefined) timing.pausedMs = pausedMs;
  if (elapsedMs !== undefined) timing.elapsedMs = elapsedMs;
  return Object.keys(timing).length > 0 ? timing : null;
}

function readApprovalId(event: WireEvent): string | null {
  const approvalId = event.data?.approvalId;
  return typeof approvalId === "string" && approvalId.length > 0 ? approvalId : null;
}

function applyTimingEvent(exchange: Exchange, event: WireEvent): Exchange {
  const eventMs = parseEventTimeMs(event);
  let timing = exchange.timing ?? {};
  let changed = false;

  if (eventMs !== null && timing.startedAtMs === undefined) {
    timing = { ...timing, startedAtMs: eventMs, pausedMs: timing.pausedMs ?? 0 };
    changed = true;
  }

  // Unified pause keys: approval events use the real approvalId,
  // plan-mode awaiting-approval uses a synthetic "plan:<requestId>"
  // id so both kinds participate in the same activePauseStartsById
  // ledger. Without this the leader's plan_proposed → user-decide
  // → plan_mode_exited window keeps counting "Working" even though
  // nothing is executing.
  const approvalId = readApprovalId(event);
  const planPauseId =
    event.type === "leader.plan_proposed" || event.type === "leader.plan_mode_exited"
      ? `plan:${event.requestId}`
      : null;
  const isPauseStart =
    (event.type === "leader.approval_requested" && approvalId) ||
    (event.type === "leader.plan_proposed" && planPauseId);
  const isPauseEnd =
    ((event.type === "leader.approval_resolved" || event.type === "approval.resolved")
      && approvalId) ||
    (event.type === "leader.plan_mode_exited" && planPauseId);
  const pauseKey = approvalId ?? planPauseId ?? null;
  if (isPauseStart && eventMs !== null && pauseKey) {
    const activePauseStartsById = { ...(timing.activePauseStartsById ?? {}) };
    if (activePauseStartsById[pauseKey] === undefined) {
      activePauseStartsById[pauseKey] = eventMs;
    }
    const activePauseStartedAtMs =
      timing.activePauseStartedAtMs === undefined
        ? eventMs
        : Math.min(timing.activePauseStartedAtMs, eventMs);
    timing = {
      ...timing,
      activePauseStartsById,
      activePauseStartedAtMs,
      pausedMs: timing.pausedMs ?? 0,
    };
    changed = true;
  } else if (isPauseEnd && eventMs !== null && pauseKey) {
    const activePauseStartsById = { ...(timing.activePauseStartsById ?? {}) };
    const started = activePauseStartsById[pauseKey];
    if (started !== undefined) {
      delete activePauseStartsById[pauseKey];
      const remainingActiveCount = Object.keys(activePauseStartsById).length;
      const activePauseStartedAtMs = timing.activePauseStartedAtMs ?? started;
      timing = {
        ...timing,
        pausedMs:
          remainingActiveCount === 0
            ? (timing.pausedMs ?? 0) + Math.max(0, eventMs - activePauseStartedAtMs)
            : timing.pausedMs ?? 0,
      };
      if (remainingActiveCount > 0) {
        timing.activePauseStartsById = activePauseStartsById;
        timing.activePauseStartedAtMs = activePauseStartedAtMs;
      } else {
        delete timing.activePauseStartsById;
        delete timing.activePauseStartedAtMs;
      }
      changed = true;
    }
  }

  const terminalTiming = readTimingPayload(event.data?.timing);
  if (terminalTiming) {
    timing = {
      ...timing,
      ...terminalTiming,
    };
    delete timing.activePauseStartedAtMs;
    delete timing.activePauseStartsById;
    changed = true;
  }

  return changed ? { ...exchange, timing } : exchange;
}

function applyStreamDelta(exchange: Exchange, event: WireEvent): Exchange {
  const inner = event.data;
  const innerType = typeof inner.type === "string" ? inner.type : null;

  if (innerType === "thinking_delta") {
    const text = typeof inner.text === "string" ? inner.text : "";
    if (!text) return exchange;
    return appendThinkingDelta(exchange, text, event.seq);
  }

  if (innerType === "text_delta") {
    const text = typeof inner.text === "string" ? inner.text : "";
    if (!text) return exchange;
    // Seal any open thinking part — the model transitioned from
    // reasoning to the visible answer. The renderer collapses the
    // sealed thinking block 1.5s later.
    return appendTextDelta(sealActivePart(exchange, ["thinking"]), text, event);
  }

  // tool_use_start: backend signals an upcoming tool call. We seal the
  // active text AND thinking segments so the next text_delta opens a
  // fresh text part. We do NOT pre-create a tool part here — the
  // matching `leader.tool_call` event carries the input payload and
  // creates the part with full data.
  if (innerType === "tool_use_start") {
    return sealActivePart(exchange, ["text", "thinking"]);
  }

  return exchange;
}

// Bound per-thinking-part memory. Reasoning models (kimi-k2.6,
// qwen3.5-plus, o-series) can stream 100k+ thinking tokens per turn.
// Without a cap a single conversation accumulates tens of MB in memory
// just for thinking traces, which (a) bloats every Zustand state update
// copy and (b) slows React reconciliation of the ThinkingBlock. Cap
// holds the last 80KB; older content gets a truncation prefix (the full
// trace is still in execution_events for replay).
const MAX_THINKING_CONTENT_CHARS = 80_000;
const THINKING_TRUNCATION_PREFIX = "[earlier thinking truncated to fit in-memory cap]\n\n";

function clampThinkingContent(content: string): string {
  if (content.length <= MAX_THINKING_CONTENT_CHARS) return content;
  const tail = content.slice(content.length - MAX_THINKING_CONTENT_CHARS);
  return THINKING_TRUNCATION_PREFIX + tail;
}

function appendThinkingDelta(
  exchange: Exchange,
  text: string,
  seq: number,
): Exchange {
  const parts = exchange.response.parts;
  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];

  if (last && last.kind === "thinking" && !last.sealed) {
    const updated: ThinkingPart = {
      ...last,
      content: clampThinkingContent(last.content + text),
    };
    return withStatus(withParts(exchange, replaceAt(parts, lastIdx, updated)), "streaming");
  }

  // Open a fresh thinking part. If there's an unsealed text part
  // sitting around (out-of-order: thinking arriving after text —
  // unusual but possible), seal it first so the new thinking lands
  // cleanly at the end. chatStore.ensureTextBuffers attaches a
  // TextBuffer on first observation of an unsealed thinking part.
  const sealed = sealActivePart(exchange, ["text"]);
  const ordinal = countThinkingParts(sealed.response.parts);
  const fresh: ThinkingPart = {
    kind: "thinking",
    id: thinkingPartId(sealed.id, ordinal),
    content: text,
    sealed: false,
    buffer: null,
    firstDeltaSeq: seq,
  };
  return withStatus(
    withParts(sealed, [...sealed.response.parts, fresh]),
    "streaming",
  );
}

function appendTextDelta(exchange: Exchange, text: string, event?: WireEvent): Exchange {
  const parts = exchange.response.parts;
  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];

  // Pure path: the projector ONLY produces the new immutable Exchange
  // tree. It does NOT touch the part's TextBuffer (which is a non-React
  // animator with mutable internal state). The buffer side-effect is
  // dispatched in `chatStore.applyWireEvent` AFTER the projector returns,
  // keeping this reducer trivially deterministic + replay-safe.
  if (last && last.kind === "text" && !last.sealed) {
    const updated: TextPart = {
      ...last,
      content: last.content + text,
    };
    return withStatus(withParts(exchange, replaceAt(parts, lastIdx, updated)), "streaming");
  }

  // Open a fresh text part. Stamp createdAtMs / agent identity from
  // the event envelope so the message-header strip can render a per-
  // message speaker+timestamp row above this part.
  const ordinal = countTextParts(parts);
  const eventMs = event ? parseEventTimeMs(event) : null;
  const fresh: TextPart = {
    kind: "text",
    id: textPartId(exchange.id, ordinal),
    content: text,
    sealed: false,
    buffer: null, // chatStore attaches a buffer on first observation
    ...(eventMs !== null ? { createdAtMs: eventMs } : {}),
    ...(event?.agent?.role ? { agentRole: event.agent.role } : {}),
    ...(event?.agent?.name ? { agentName: event.agent.name } : {}),
  };
  return withStatus(withParts(exchange, [...parts, fresh]), "streaming");
}

function applyToolCall(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : "";
  if (!toolUseId) return exchange;
  const name = typeof data.toolName === "string" ? data.toolName : "tool";

  // update_plan renders as an inline TodoListPart, not a generic
  // tool-call row. The structured `input.todos` is the canonical
  // snapshot; the tool_result for update_plan is intentionally
  // suppressed (no pair to show). Spec:
  // docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md
  if (name === "update_plan") {
    return applyUpdatePlanCall(exchange, toolUseId, data);
  }

  const id = toolPartId(exchange.id, toolUseId);

  // Idempotent: if this part already exists (snapshot replay collision),
  // leave it alone.
  if (exchange.response.parts.some((p) => p.kind === "tool" && p.id === id)) {
    return exchange.status === "streaming" ? exchange : { ...exchange, status: "streaming" };
  }

  // Seal active text first (a tool boundary always closes the text segment).
  const sealed = sealActivePart(exchange, ["text", "thinking"]);

  const eventMs = parseEventTimeMs(event);
  const part: ToolPart = {
    kind: "tool",
    id,
    toolUseId,
    name,
    input: data.input ?? data.inputSummary ?? null,
    result: null,
    ...(eventMs !== null ? { createdAtMs: eventMs } : {}),
    ...(event.agent?.role ? { agentRole: event.agent.role } : {}),
    ...(event.agent?.name ? { agentName: event.agent.name } : {}),
  };
  return withStatus(withParts(sealed, [...sealed.response.parts, part]), "streaming");
}

function applyUpdatePlanCall(
  exchange: Exchange,
  toolUseId: string,
  data: WireEvent["data"],
): Exchange {
  const id = `${exchange.id}:todo_list:${toolUseId}`;

  // Idempotent: dedupe on snapshot replay.
  if (exchange.response.parts.some((p) => p.kind === "todo_list" && p.id === id)) {
    return exchange.status === "streaming" ? exchange : { ...exchange, status: "streaming" };
  }

  const todos = extractTodos(data);
  if (todos.length === 0) {
    // Backend emitted update_plan but `input.todos` was unparseable —
    // ignore silently rather than render an empty block. The tool's
    // own validators reject empty/malformed input upstream.
    return exchange;
  }

  // A plan boundary closes any active text/thinking segment, same as a
  // regular tool boundary.
  const sealed = sealActivePart(exchange, ["text", "thinking"]);

  const part: TodoListPart = {
    kind: "todo_list",
    id,
    toolUseId,
    todos,
  };
  return withStatus(withParts(sealed, [...sealed.response.parts, part]), "streaming");
}

function extractTodos(data: WireEvent["data"]): TodoItem[] {
  const raw = (data.input as Record<string, unknown> | undefined)?.todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content : "";
    const activeForm = typeof e.activeForm === "string" ? e.activeForm : "";
    const status = typeof e.status === "string" ? e.status : "";
    if (!content || !status) continue;
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "cancelled"
    ) continue;
    const priorityRaw = typeof e.priority === "string" ? e.priority : undefined;
    const priority =
      priorityRaw === "high" || priorityRaw === "medium" || priorityRaw === "low"
        ? priorityRaw
        : undefined;
    out.push({ content, activeForm, status, ...(priority ? { priority } : {}) });
  }
  return out;
}

function applyToolResult(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const toolUseId = typeof data.toolUseId === "string" ? data.toolUseId : "";
  if (!toolUseId) return exchange;

  const id = toolPartId(exchange.id, toolUseId);
  const idx = exchange.response.parts.findIndex(
    (p) => p.kind === "tool" && p.id === id,
  );
  if (idx < 0) return exchange; // result without a matching call: skip

  const part = exchange.response.parts[idx] as ToolPart;
  if (part.result) return exchange; // already populated — idempotent

  const isError = data.isError === true;
  const output = pickToolOutput(data);
  // Clear any pendingApproval — the gate has resolved either way and
  // showing the buttons after the result lands would be confusing
  // (clicking would 404 on a long-since-expired approval id).
  const { pendingApproval: _drop, ...rest } = part;
  const updated: ToolPart = {
    ...rest,
    result: { isError, output } satisfies ToolResult,
  };
  return withParts(exchange, replaceAt(exchange.response.parts, idx, updated));
}

function applyMediaSent(exchange: Exchange, event: WireEvent, taskId: string): Exchange {
  const data = event.data;
  const mediaId = typeof data.mediaId === "string" ? data.mediaId.trim() : "";
  if (!mediaId) return exchange;
  const rawKind = typeof data.kind === "string" ? data.kind : data.mediaKind;
  const mediaKind = rawKind === "video" ? "video" : rawKind === "image" ? "image" : null;
  if (!mediaKind) return exchange;
  const mimeType = typeof data.mimeType === "string" ? data.mimeType.trim() : "";
  const filename = typeof data.filename === "string" ? data.filename.trim() : "";
  const sizeBytes = readNumber(data.sizeBytes);
  if (!mimeType || !filename || sizeBytes === undefined) return exchange;

  const id = mediaPartId(exchange.id, mediaId);
  if (exchange.response.parts.some((p) => p.kind === "media" && p.id === id)) {
    return exchange.status === "streaming" ? exchange : { ...exchange, status: "streaming" };
  }

  const display = data.display === "attachment" ? "attachment" : "inline";
  const caption = typeof data.caption === "string" && data.caption.trim()
    ? data.caption.trim()
    : undefined;
  const width = readNumber(data.width);
  const height = readNumber(data.height);
  const durationMs = readNumber(data.durationMs);
  const createdAtMs = parseEventTimeMs(event);
  const part: MediaPart = {
    kind: "media",
    id,
    mediaId,
    mediaKind,
    mimeType,
    filename,
    sizeBytes,
    url: `/api/tasks/${encodeURIComponent(taskId)}/media/${encodeURIComponent(mediaId)}`,
    display,
    ...(caption !== undefined ? { caption } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(createdAtMs !== null ? { createdAtMs } : {}),
    ...(event.agent?.role ? { agentRole: event.agent.role } : {}),
    ...(event.agent?.name ? { agentName: event.agent.name } : {}),
  };

  const sealed = sealActivePart(exchange, ["text", "thinking"]);
  return withStatus(withParts(sealed, [...sealed.response.parts, part]), "streaming");
}

/**
 * Pair a `leader.approval_requested` with the most recent ToolPart in
 * this exchange that's still awaiting its result. The backend emits the
 * approval event right after the matching `leader.tool_call` (see
 * manager-tools-adapter.ts bash branch), so "newest unresolved tool"
 * is the correct match. Doesn't fail loudly if there's no candidate —
 * stale snapshots can replay an approval whose tool_result already
 * cleared it; just skip in that case.
 */
function applyApprovalRequested(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const approvalId = typeof data.approvalId === "string" ? data.approvalId : "";
  if (!approvalId) return exchange;
  const reason = typeof data.reason === "string" ? data.reason : "Dangerous command";
  const command = typeof data.command === "string" ? data.command : "";
  // Optional toolKind/subjectKey enriched by the backend
  // (command-approval-service.ts). Older snapshots don't include them;
  // the card falls back to a neutral "Trust this command kind …" label.
  const rawToolKind = typeof data.toolKind === "string" ? data.toolKind : "";
  const toolKind: "bash" | "mcp_tool" | undefined =
    rawToolKind === "bash" || rawToolKind === "mcp_tool" ? rawToolKind : undefined;
  const subjectKey = typeof data.subjectKey === "string" ? data.subjectKey : null;

  // Sandbox-elevation v4.3 §4.1 §4.6 — extract v4 fields from
  // payload.args.escalation (when set by the bash tool dispatcher in
  // manager-tools-adapter.ts). Missing for v3 approvals; the card
  // gracefully degrades.
  const args = data.args as Record<string, unknown> | undefined;
  const escalation = args?.escalation as Record<string, unknown> | undefined;
  const justification = typeof escalation?.justification === "string"
    ? escalation.justification
    : undefined;
  const rawSandboxMode = typeof escalation?.sandbox_permissions === "string"
    ? escalation.sandbox_permissions
    : "";
  const sandboxMode: "use_default" | "with_additional_permissions" | "require_escalated" | undefined =
    rawSandboxMode === "use_default"
      || rawSandboxMode === "with_additional_permissions"
      || rawSandboxMode === "require_escalated"
      ? rawSandboxMode
      : undefined;
  const additionalPermissions = escalation?.additional_permissions as
    {
      network?: { enabled?: boolean };
      file_system?: {
        entries: Array<{
          path: string;
          access: "read" | "write";
          sensitivity: "safe" | "caution" | "critical";
          sensitivityReason: string;
        }>;
      };
    }
    | undefined;
  const denyReadRequestedButUnsupported = escalation?.deny_read_requested_but_unsupported as
    | Array<{ path: string; classification: "safe" | "caution" | "critical" }>
    | undefined;

  const parts = exchange.response.parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && p.kind === "tool" && p.result === null) {
      const updated: ToolPart = {
        ...p,
        pendingApproval: {
          approvalId,
          reason,
          command,
          ...(toolKind ? { toolKind } : {}),
          subjectKey,
          ...(justification ? { justification } : {}),
          ...(sandboxMode ? { sandboxMode } : {}),
          ...(additionalPermissions ? { additionalPermissions } : {}),
          ...(denyReadRequestedButUnsupported && denyReadRequestedButUnsupported.length > 0
            ? { denyReadRequestedButUnsupported }
            : {}),
        },
      };
      return withParts(exchange, replaceAt(parts, i, updated));
    }
  }
  return exchange;
}

// Both event types signal "approval terminal-state reached" and should
// clear the inline card. Used by the depth>0 timing branch and the
// pause-end predicate too.
function isApprovalEvent(type: string): boolean {
  return type === "leader.approval_requested"
    || type === "leader.approval_resolved"
    || type === "approval.resolved";
}

/**
 * Strip `pendingApproval` from whichever ToolPart was carrying the
 * matching approvalId. The card disappears on the next render. Idempotent
 * — if the part already cleared (e.g. tool_result landed before resolve,
 * or this is a duplicate event), we leave the exchange unchanged.
 *
 * Wired for BOTH `leader.approval_resolved` and `approval.resolved`.
 * The plain web reject/approve route writes the latter; without this
 * handling, the projector replayed the request event but never cleared
 * it, so refreshing the chat brought the approval card right back.
 */
function applyApprovalResolved(exchange: Exchange, event: WireEvent): Exchange {
  const approvalId = readApprovalId(event);
  if (!approvalId) return exchange;
  const parts = exchange.response.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p && p.kind === "tool" && p.pendingApproval?.approvalId === approvalId) {
      const { pendingApproval: _drop, ...rest } = p;
      void _drop;
      return withParts(exchange, replaceAt(parts, i, rest as ToolPart));
    }
  }
  return exchange;
}

/**
 * Project loop-level system events (compaction / doom-loop / max-turns)
 * to a SystemPart so the renderer can surface them. Without this, the
 * legacy ChatArea's compaction-notice UX was a regression and silent
 * exits via doom-loop / max-turns left the user staring at a frozen
 * chat with no signal as to why. Idempotent on snapshot replay (id
 * keyed by the durable execution_events row).
 */
function applySystemNotice(
  exchange: Exchange,
  event: WireEvent,
  variant: SystemPart["variant"],
): Exchange {
  const data = event.data;
  const eventId = typeof data.__eventId === "string" ? data.__eventId : null;
  const id = eventId ?? `${exchange.id}:system:${event.seq}`;
  if (exchange.response.parts.some((p) => p.kind === "system" && p.id === id)) {
    return exchange; // dedupe on replay
  }
  const { headline, detail } = formatSystemNotice(variant, data);
  const part: SystemPart = {
    kind: "system",
    id,
    variant,
    headline,
    ...(detail ? { detail } : {}),
  };
  // Seal any in-progress text — system notices are turn-level
  // boundaries, like tool boundaries, and must not split a text
  // segment in two.
  const sealed = sealActivePart(exchange, ["text", "thinking"]);
  return withParts(sealed, [...sealed.response.parts, part]);
}

function formatSystemNotice(
  variant: SystemPart["variant"],
  data: Record<string, unknown>,
): { headline: string; detail?: string } {
  switch (variant) {
    case "compaction": {
      const pre = numericField(data, "preCompactTokens");
      const post = numericField(data, "postCompactTokens");
      const truncated = numericField(data, "truncatedCount");
      const snipped = numericField(data, "snippedCount");
      const dropped = numericField(data, "droppedCount");
      const llm = data.llmCompacted === true;
      const headline = pre !== null && post !== null
        ? `📦 Context compacted (${formatTokens(pre)} → ${formatTokens(post)} tokens)`
        : `📦 Context compacted`;
      const detailLines: string[] = [];
      if (truncated && truncated > 0) detailLines.push(`Truncated ${truncated} large tool result${truncated === 1 ? "" : "s"}`);
      if (snipped && snipped > 0) detailLines.push(`Snipped ${snipped} old tool result${snipped === 1 ? "" : "s"}`);
      if (dropped && dropped > 0) detailLines.push(`Dropped ${dropped} oldest turn${dropped === 1 ? "" : "s"}`);
      if (llm) detailLines.push("LLM summary applied");
      return { headline, ...(detailLines.length > 0 ? { detail: detailLines.join("\n") } : {}) };
    }
    case "doom_loop": {
      const tool = typeof data.toolName === "string" ? data.toolName : "tool";
      const count = numericField(data, "count");
      const message = typeof data.message === "string" ? data.message : "";
      const headline = `🛑 Doom-loop detected — blocked repeated ${tool}${count ? ` (×${count})` : ""}`;
      return { headline, ...(message ? { detail: message } : {}) };
    }
    case "max_turns": {
      const max = numericField(data, "maxTurns");
      const headline = max
        ? `⏱ Max turns reached (${max}) — loop exited`
        : `⏱ Max turns reached — loop exited`;
      return { headline };
    }
    case "recovery":
      return formatRecoveryNotice(data, false);
    case "recovery_blocked":
      return formatRecoveryNotice(data, true);
    case "status":
      // `status` is a LOCAL-only variant produced by the chat
      // `/status` slash command via `pushLocalDiagnostic` — the
      // backend event stream never emits it, so this branch is
      // unreachable in practice. The case exists for exhaustiveness
      // (the discriminated union was later widened) and as a
      // safe fallback if a malformed projector replay ever lands
      // here.
      return { headline: "/status" };
    case "async_teammate": {
      const role = textField(data, ["role"]) ?? "teammate";
      const status = (textField(data, ["status"]) ?? "COMPLETED").toUpperCase();
      const summary = textField(data, ["summary"]);
      const durationMs = numericField(data, "durationMs");
      const durationStr = durationMs !== null
        ? durationMs < 60_000
          ? `${Math.round(durationMs / 1000)}s`
          : `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`
        : null;
      const isOk = status === "COMPLETED";
      const isCancelled = status === "CANCELLED";
      const icon = isOk ? "✓" : isCancelled ? "⏹" : "✗";
      const verb = isOk ? "completed" : isCancelled ? "cancelled" : "failed";
      const headline = durationStr
        ? `${icon} Background ${role} ${verb} (${durationStr})`
        : `${icon} Background ${role} ${verb}`;
      return { headline, ...(summary ? { detail: summary } : {}) };
    }
    case "model_switched": {
      const from = textField(data, ["from"]);
      const to = textField(data, ["to"]);
      const requiresWarning = data.requiresWarning === true;
      const arrow = from ? `${from} → ${to ?? "(default)"}` : `→ ${to ?? "(default)"}`;
      const headline = `🔁 Leader model switched (${arrow})`;
      return {
        headline,
        ...(requiresWarning ? { detail: "Cross-dialect switch — replayed turns may have content downgraded." } : {}),
      };
    }
  }
}

function textField(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function isRuntimeRecoveryRetry(data: Record<string, unknown>): boolean {
  const action = textField(data, ["action", "transition"]);
  const reason = textField(data, ["reason", "recoveryReason"]);
  return action === "retry" && !!reason?.startsWith("runtime_recovery_");
}

function isRuntimeRecoveryBlocked(data: Record<string, unknown>): boolean {
  return textField(data, ["stopReason", "reason"]) === "runtime_recovery_exhausted";
}

function formatRecoveryNotice(
  data: Record<string, unknown>,
  blocked: boolean,
): { headline: string; detail: string } {
  const reason = blocked
    ? textField(data, ["stopReason", "reason", "recoveryReason"])
    : textField(data, ["reason", "recoveryReason"]);
  const previousState = textField(data, ["previousState", "fromState"]);
  const nextState = textField(data, ["state", "taskState", "nextState"]);
  const runId = textField(data, ["runId", "roleRuntimeId"]);
  const detail = [
    reason ? `Reason: ${reason}` : null,
    previousState ? `Previous state: ${previousState}` : null,
    nextState ? `Next state: ${nextState}` : null,
    runId ? `Run: ${runId}` : null,
    blocked ? "Status: user action needed" : "Status: continuing automatically",
  ].filter((line): line is string => !!line).join("\n");
  return {
    headline: blocked
      ? "Blocked by recovery"
      : "Recovered from runtime interruption",
    detail,
  };
}

function numericField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function applyModelError(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const message = typeof data.error === "string" && data.error.trim()
    ? data.error
    : "Model request failed (unknown error)";
  // Use the durable execution_events row id when available; otherwise
  // fall back to a synthesized stable id from (requestId, seq) so replay
  // is still deterministic.
  const eventId = typeof data.__eventId === "string" ? data.__eventId : null;
  const id = eventId ?? `${exchange.id}:model-error:${event.seq}`;

  if (exchange.response.parts.some((p) => p.kind === "model-error" && p.id === id)) {
    return exchange;
  }

  const part: ModelErrorPart = { kind: "model-error", id, message };
  // Seal active text first; a model error closes any in-progress segment.
  const sealed = sealActivePart(exchange, ["text", "thinking"]);
  return withParts(sealed, [...sealed.response.parts, part]);
}

/**
 * Append a `PlanPart` carrying the full markdown plan. If a buffered
 * `pendingPlanExit` is on the exchange (because plan_mode_exited
 * arrived first via live-path reorder), apply the buffered status
 * atomically so the PlanCard renders in its final state, not as
 * "awaiting_approval" → flash → "approved". See spec §10.4.
 */
function applyPlanProposed(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const plan = typeof data.plan === "string" ? data.plan : "";
  if (!plan) return exchange;

  // Stable id derived from requestId + ordinal among existing plan
  // parts in this exchange (typically just "0" — multi-plan revise
  // cycles produce 1, 2, ...).
  const existingPlanCount = exchange.response.parts.filter((p) => p.kind === "plan").length;
  const id = `${exchange.id}:plan:${existingPlanCount}`;

  // Apply buffered exit if we have one — atomic resolution of the
  // out-of-order race.
  const pending = exchange.pendingPlanExit;
  const status: PlanPart["status"] = pending?.status ?? "awaiting_approval";

  const part: PlanPart = {
    kind: "plan",
    id,
    plan,
    status,
    ...(pending?.feedback !== undefined ? { feedback: pending.feedback } : {}),
  };

  // Seal active text first — a plan submission closes any in-progress
  // text from the planning turn.
  const sealed = sealActivePart(exchange, ["text", "thinking"]);
  const next: Exchange = {
    ...sealed,
    response: { parts: [...sealed.response.parts, part] },
    // If we consumed a buffered exit atomically, planPhase reflects
    // the resolved state (`done` for approve/cancel, `planning` for
    // revise — agent goes back to drafting). Otherwise we're now
    // awaiting approval.
    planPhase: pending
      ? (pending.status === "revised" ? "planning" : "done")
      : "awaiting_approval",
  };
  // Clear the buffered exit if we consumed it.
  if (pending) {
    delete next.pendingPlanExit;
  }
  return next;
}

/**
 * Mutate the most-recent `PlanPart` to reflect approve / cancel /
 * revise. If no PlanPart exists yet (live-path reorder), buffer the
 * exit on the exchange so a later plan_proposed can resolve it.
 */
function applyPlanModeExited(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const reason = data.reason;
  if (reason !== "approved" && reason !== "cancelled" && reason !== "revised") {
    return exchange;
  }
  const feedback = typeof data.feedback === "string" ? data.feedback : undefined;

  // Find the most-recent PlanPart in the exchange's response.
  const lastPlanIdx = (() => {
    for (let i = exchange.response.parts.length - 1; i >= 0; i--) {
      if (exchange.response.parts[i]?.kind === "plan") return i;
    }
    return -1;
  })();

  if (lastPlanIdx < 0) {
    // Out-of-order: plan_mode_exited arrived before plan_proposed.
    // Buffer the exit on the exchange so the next plan_proposed can
    // apply it atomically. Reset planPhase to "done" ONLY for terminal
    // exit reasons (approved / rejected / cancelled). `revised` means
    // "leader is going to propose a new plan" — we leave planPhase at
    // its current value so the upcoming plan_proposed event can
    // correctly transition it back to "planning".
    const isTerminalReason = reason !== "revised";
    return {
      ...exchange,
      ...(isTerminalReason ? { planPhase: "done" as const } : {}),
      pendingPlanExit: { status: reason, ...(feedback !== undefined ? { feedback } : {}) },
    };
  }

  const oldPart = exchange.response.parts[lastPlanIdx]!;
  if (oldPart.kind !== "plan") return exchange;

  const newPart: PlanPart = {
    ...oldPart,
    status: reason,
    ...(feedback !== undefined ? { feedback } : {}),
  };
  const newParts = [
    ...exchange.response.parts.slice(0, lastPlanIdx),
    newPart,
    ...exchange.response.parts.slice(lastPlanIdx + 1),
  ];
  return {
    ...exchange,
    response: { parts: newParts },
    // approve/cancel close the plan loop; revise sends the agent back
    // to PLANNING for another iteration.
    planPhase: reason === "revised" ? "planning" : "done",
  };
}

// ──────────────────────────────────────────────────────────────────────
// teammate transcript routing
// ──────────────────────────────────────────────────────────────────────

/**
 * Cap on how many teammate events live in memory inside a single
 * `ToolPart.transcript[]`. Above this we keep first-50 + last-N
 * (the FIFO drop preserves head + tail per Δ.6) so the inline body
 * never exceeds ~60 parts. The drawer reaches further events via
 * the lazy-load endpoint.
 */
const TRANSCRIPT_MEMORY_CAP = 500;
const TRANSCRIPT_HEAD_KEEP = 50;
const TRANSCRIPT_TAIL_KEEP = 10;

/**
 * Codex round-3 [C1] / recursive ToolPart lookup.
 * A depth=2 teammate event arrives with `agent.parentToolUseId` set
 * to the depth=2 spawn_teammate ToolPart's `toolUseId`. That part
 * lives inside a depth=1 ToolPart's `transcript[]`, not at the top
 * level. We need to walk one or more levels deep to find it.
 *
 * Returns a "path" of indices `[topLevelIdx, transcriptIdx, ...]`
 * so the caller can reconstruct the immutable update chain. Bounded
 * by depth budget (4 in practice; way more than typical orchestration
 * needs) to prevent runaway recursion if a malformed event references
 * a non-existent parent.
 */
const FIND_DEPTH_BUDGET = 4;

function findTeammateToolPartByPath(
  parts: ResponsePart[],
  predicate: (p: ToolPart) => boolean,
  depthBudget = FIND_DEPTH_BUDGET,
): { path: number[]; part: ToolPart } | null {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.kind !== "tool") continue;
    if (predicate(p)) return { path: [i], part: p };
    if (depthBudget > 0 && p.transcript && p.transcript.length > 0) {
      const inner = findTeammateToolPartByPath(p.transcript, predicate, depthBudget - 1);
      if (inner) return { path: [i, ...inner.path], part: inner.part };
    }
  }
  return null;
}

function findTeammateToolPart(
  exchange: Exchange,
  predicate: (p: ToolPart) => boolean,
): { idx: number; part: ToolPart } | null {
  // Top-level only — used by applyTeammateSpawned/Completed where
  // the matching ToolPart MUST be a leader-level spawn (depth=0
  // emit, can never be inside a teammate's transcript).
  for (let i = 0; i < exchange.response.parts.length; i++) {
    const p = exchange.response.parts[i];
    if (p && p.kind === "tool" && predicate(p)) {
      return { idx: i, part: p };
    }
  }
  return null;
}

function replaceToolPart(
  exchange: Exchange,
  idx: number,
  part: ToolPart,
): Exchange {
  const next = exchange.response.parts.slice();
  next[idx] = part;
  return { ...exchange, response: { parts: next } };
}

/**
 * Apply an immutable transcript update along a path of indices into
 * a nested ToolPart tree. Used by depth>=2 routing (codex round-3
 * [C1]) — the path comes from `findTeammateToolPartByPath`.
 */
function replaceToolPartByPath(
  parts: ResponsePart[],
  path: number[],
  updater: (p: ToolPart) => ToolPart,
): ResponsePart[] {
  if (path.length === 0) return parts;
  const [head, ...rest] = path;
  if (head === undefined) return parts;
  const target = parts[head];
  if (!target || target.kind !== "tool") return parts;
  const next = parts.slice();
  if (rest.length === 0) {
    next[head] = updater(target);
  } else {
    const innerTranscript = target.transcript ?? [];
    const updatedInner = replaceToolPartByPath(innerTranscript, rest, updater);
    next[head] = { ...target, transcript: updatedInner };
  }
  return next;
}

function textFromInput(input: unknown, keys: string[]): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  return textField(obj, keys);
}

function compactTeammateMessage(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function summarizeNestedTeammateEvent(event: WireEvent): string | null {
  if (event.type === "leader.stream_delta") {
    const innerType = textField(event.data, ["type"]);
    if (innerType === "text_delta" || innerType === "thinking_delta") {
      const text = textField(event.data, ["text"]);
      return text ? compactTeammateMessage(text) : null;
    }
    return null;
  }

  if (event.type === "leader.tool_result") {
    const output = pickToolOutput(event.data);
    return output.trim() ? compactTeammateMessage(output) : null;
  }

  if (event.type === "leader.model_error") {
    return compactTeammateMessage(
      textField(event.data, ["error", "message"]) ?? "Model request failed",
    );
  }

  if (event.type === "leader.messages_compacted") return "Context compacted";
  if (event.type === "leader.doom_loop_detected") {
    return compactTeammateMessage(textField(event.data, ["message"]) ?? "Doom-loop detected");
  }
  if (event.type === "leader.max_turns") return "Max turns reached";
  if (event.type === "task.orchestration.transition" && isRuntimeRecoveryRetry(event.data)) {
    return "Recovered from runtime interruption";
  }
  if (event.type === "task.orchestration.stopped" && isRuntimeRecoveryBlocked(event.data)) {
    return "Blocked by recovery";
  }

  return null;
}

function hasTranscriptToolUseId(parts: ResponsePart[], toolUseId: string): boolean {
  for (const part of parts) {
    if (part.kind !== "tool") continue;
    if (part.toolUseId === toolUseId) return true;
  }
  return false;
}

function stampTeammateSpawnedPart(part: ToolPart, event: WireEvent): ToolPart | null {
  const data = event.data;
  const teammateRunId = typeof data.teammateRunId === "string" ? data.teammateRunId : null;
  if (!teammateRunId) return null;

  const inputRole = textFromInput(part.input, ["role", "roleId", "teammateRole"]);
  const teammateRole =
    textField(data, ["role", "roleId", "teammateRole"])
    ?? inputRole
    ?? textField(data, ["teammateName", "name", "agentName"]);
  const teammateName =
    textField(data, ["teammateName", "name", "agentName"])
    ?? teammateRole;
  const teammateRuntime = textField(data, ["runtimeType", "runtime", "executorClass"]);
  const teammateModel = textField(data, ["modelName", "model", "modelRef", "configuredModel"]);
  const startedAtMs = parseEventTimeMs(event);

  return {
    ...part,
    teammateRunId,
    ...(teammateRole ? { teammateRole } : {}),
    ...(teammateName ? { teammateName } : {}),
    ...(teammateRuntime ? { teammateRuntime } : {}),
    ...(teammateModel ? { teammateModel } : {}),
    ...(startedAtMs !== null ? { teammateStartedAtMs: startedAtMs } : {}),
    teammateStatus: "spawned",
    transcript: part.transcript ?? [],
    transcriptEventCount: part.transcriptEventCount ?? 0,
    teammateToolCount: part.teammateToolCount ?? 0,
  };
}

function stampTeammateCompletedPart(part: ToolPart, event: WireEvent): ToolPart {
  const data = event.data;
  const reason = typeof data.reason === "string" ? data.reason : null;
  const summary = typeof data.summary === "string" ? data.summary : undefined;
  const completedAtMs = parseEventTimeMs(event);
  const status: ToolPart["teammateStatus"] =
    reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
  const failureReason = status === "failed" || status === "cancelled"
    ? textField(data, ["failureReason", "error", "message"])
      ?? (summary && summary.trim() ? compactTeammateMessage(summary) : null)
      ?? (status === "cancelled" ? "Teammate was cancelled" : reason ? `Teammate ended with ${reason}` : "Teammate failed")
    : null;
  const nextAction = status === "failed"
    ? textField(data, ["nextAction", "suggestedNextAction"])
      ?? "Inspect the transcript, fix the blocker, then retry or resume this teammate."
    : null;

  // Pull usage from `data.usage` when the backend stamped it. CLI
  // teammates: extracted by the spawn-service's onUsage callback.
  // Magister teammates: aggregated from token_usage_records by runId.
  // Either way the shape is the same.
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    if (typeof u.inputTokens === "number" && u.inputTokens > 0) inputTokens = u.inputTokens;
    if (typeof u.outputTokens === "number" && u.outputTokens > 0) outputTokens = u.outputTokens;
    if (typeof u.cacheReadTokens === "number" && u.cacheReadTokens > 0) {
      cacheReadTokens = u.cacheReadTokens;
    }
  }

  return {
    ...part,
    teammateStatus: status,
    ...(summary !== undefined ? { teammateSummary: summary } : {}),
    ...(completedAtMs !== null ? { teammateCompletedAtMs: completedAtMs } : {}),
    ...(failureReason ? { teammateFailureReason: failureReason } : {}),
    ...(nextAction ? { teammateNextAction: nextAction } : {}),
    ...(inputTokens !== undefined ? { teammateInputTokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { teammateOutputTokens: outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { teammateCacheReadTokens: cacheReadTokens } : {}),
  };
}

/**
 * `leader.teammate_spawned` arrives at depth=0 (the leader announcing
 * "I just spawned X"). Find the spawn_teammate ToolPart whose
 * `toolUseId` matches the event's `parentToolUseId` field (Step 0a)
 * and stamp the teammate metadata onto it.
 */
function applyTeammateSpawned(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const parentToolUseId = typeof data.parentToolUseId === "string" ? data.parentToolUseId : null;
  const teammateRunId = typeof data.teammateRunId === "string" ? data.teammateRunId : null;
  if (!parentToolUseId || !teammateRunId) return exchange;

  // Match by toolUseId (preferred — comes from Step 0a propagation).
  // Fallback to "most recent spawn_teammate without a teammateRunId
  // yet" for pre-Step-0a tasks (no parentToolUseId in payload).
  const found = findTeammateToolPart(exchange, (p) => p.toolUseId === parentToolUseId)
    ?? findTeammateToolPart(
         exchange,
         (p) => p.name === "spawn_teammate" && !p.teammateRunId,
       );
  if (!found) return exchange;

  const updated = stampTeammateSpawnedPart(found.part, event);
  if (!updated) return exchange;
  return replaceToolPart(exchange, found.idx, updated);
}

/**
 * `leader.teammate_completed` arrives at depth=0. Find the matching
 * spawn_teammate ToolPart by `teammateRunId` and flip its status
 * + populate the summary.
 */
function applyTeammateCompleted(exchange: Exchange, event: WireEvent): Exchange {
  const data = event.data;
  const teammateRunId = typeof data.teammateRunId === "string" ? data.teammateRunId : null;
  if (!teammateRunId) return exchange;

  const found = findTeammateToolPart(exchange, (p) => p.teammateRunId === teammateRunId);
  if (!found) return exchange;

  return replaceToolPart(exchange, found.idx, stampTeammateCompletedPart(found.part, event));
}

/**
 * Any event with `agent.depth > 0` is the teammate's own output.
 * Route it into the matching parent's `transcript[]` instead of
 * the flat exchange parts. The match is by `agent.parentToolUseId`
 * (Step 0a) → ToolPart.toolUseId. depth>=2 falls through here as
 * well; v2.1 inline rendering caps at depth 1 (Δ.8 deferral) — those
 * events get appended to the depth-1 ToolPart's transcript flat.
 */
function applyTeammateNestedEvent(exchange: Exchange, event: WireEvent, taskId: string): Exchange {
  if (event.type === "leader.teammate_spawned") {
    const nestedParentToolUseId =
      typeof event.data.parentToolUseId === "string" ? event.data.parentToolUseId : null;
    if (!nestedParentToolUseId) return exchange;
    const found = findTeammateToolPartByPath(
      exchange.response.parts,
      (p) => p.toolUseId === nestedParentToolUseId,
    );
    if (!found) return exchange;
    const nextParts = replaceToolPartByPath(exchange.response.parts, found.path, (part) => {
      const stamped = stampTeammateSpawnedPart(part, event);
      return stamped ?? part;
    });
    return nextParts === exchange.response.parts ? exchange : { ...exchange, response: { parts: nextParts } };
  }

  if (event.type === "leader.teammate_completed") {
    const teammateRunId =
      typeof event.data.teammateRunId === "string" ? event.data.teammateRunId : null;
    const parentToolUseId = event.agent?.parentToolUseId;
    if (!teammateRunId && !parentToolUseId) return exchange;
    const found = findTeammateToolPartByPath(
      exchange.response.parts,
      (p) => (teammateRunId ? p.teammateRunId === teammateRunId : false)
        || (parentToolUseId ? p.toolUseId === parentToolUseId : false),
    );
    if (!found) return exchange;
    const nextParts = replaceToolPartByPath(
      exchange.response.parts,
      found.path,
      (part) => stampTeammateCompletedPart(part, event),
    );
    return nextParts === exchange.response.parts ? exchange : { ...exchange, response: { parts: nextParts } };
  }

  const parentToolUseId = event.agent?.parentToolUseId;
  if (!parentToolUseId) {
    // No parentToolUseId envelope (pre-Step-0a row, or malformed
    // event) → can't route. Fall back to default flat append so
    // the event isn't silently dropped, mirroring legacy behavior.
    return defaultDispatch(exchange, event, taskId);
  }
  // Codex round-3 [C1] — depth-2+ events arrive with parentToolUseId
  // pointing at a spawn_teammate ToolPart NESTED inside a depth-1
  // teammate's transcript[]. Walk recursively. v2.1 §Δ.8 promised
  // recursive folding in the drawer; the same routing logic applies
  // inline once depth>=2 events arrive.
  const found = findTeammateToolPartByPath(
    exchange.response.parts,
    (p) => p.toolUseId === parentToolUseId,
  );
  if (!found) {
    // Parent not in this exchange (cross-request leak, or pre-spawn
    // event arrived first). Drop — routing the event to the wrong
    // exchange is worse than omitting it.
    return exchange;
  }

  const updateTeammateToolPart = (target: ToolPart): ToolPart => {
    const transcript = target.transcript ?? [];
    const eventCount = (target.transcriptEventCount ?? 0) + 1;
    const nestedToolUseId = typeof event.data.toolUseId === "string" ? event.data.toolUseId : null;
    const toolCountIncrement =
      event.type === "leader.tool_call" &&
      (!nestedToolUseId || !hasTranscriptToolUseId(transcript, nestedToolUseId))
        ? 1
        : 0;
    const teammateToolCount = (target.teammateToolCount ?? 0) + toolCountIncrement;
    const lastMessage = summarizeNestedTeammateEvent(event);

    // Synthetic mini-exchange so we can reuse applyStreamDelta /
    // applyToolCall / applyToolResult logic on transcript[] instead
    // of exchange.response.parts. defaultDispatch (NOT mutateExchange)
    // skips the depth-check at the top so we don't recurse into
    // applyTeammateNestedEvent and infinite-loop.
    const fakeId = `${exchange.id}::teammate::${parentToolUseId}`;
    const fake: Exchange = {
      id: fakeId,
      status: "streaming",
      user: { content: "" },
      response: { parts: transcript },
      lastAppliedSeq: 0,
    };
    const nextFake = defaultDispatch(fake, event, taskId);
    let nextTranscript = nextFake.response.parts;

    // memory cap with middle drop. When the
    // in-memory transcript exceeds MEMORY_CAP, keep first HEAD_KEEP
    // (initial context) + last TAIL_KEEP (most recent activity). The
    // dropped middle is reachable via the sidechain drawer's lazy-load
    // endpoint.
    if (nextTranscript.length > TRANSCRIPT_MEMORY_CAP) {
      const head = nextTranscript.slice(0, TRANSCRIPT_HEAD_KEEP);
      const tail = nextTranscript.slice(nextTranscript.length - TRANSCRIPT_TAIL_KEEP);
      nextTranscript = [...head, ...tail];
    }

    return {
      ...target,
      transcript: nextTranscript,
      transcriptEventCount: eventCount,
      teammateToolCount,
      ...(lastMessage ? { teammateLastMessage: lastMessage } : {}),
      teammateStatus:
        target.teammateStatus === "completed" ||
        target.teammateStatus === "failed" ||
        target.teammateStatus === "cancelled"
        ? target.teammateStatus
        : "running",
    };
  };

  const nextParts = replaceToolPartByPath(exchange.response.parts, found.path, updateTeammateToolPart);
  if (nextParts === exchange.response.parts) return exchange;
  return { ...exchange, response: { parts: nextParts } };
}

/**
 * Dispatch by event.type — the existing top-level switch logic
 * extracted so `applyTeammateNestedEvent` can reuse it without
 * triggering the agent.depth re-routing. Mirrors `mutateExchange`
 * but skips the depth check and the teammate cases (those don't
 * recurse — handled at the top level).
 */
function defaultDispatch(exchange: Exchange, event: WireEvent, taskId: string): Exchange {
  switch (event.type) {
    case "leader.stream_delta":
      return applyStreamDelta(exchange, event);
    case "leader.tool_call":
      return applyToolCall(exchange, event);
    case "leader.tool_result":
      return applyToolResult(exchange, event);
    case "leader.media_sent":
      return applyMediaSent(exchange, event, taskId);
    case "leader.approval_requested":
      return applyApprovalRequested(exchange, event);
    case "leader.approval_resolved":
    case "approval.resolved":
      return applyApprovalResolved(exchange, event);
    case "leader.turn_complete":
      return sealActivePart(exchange, ["text", "thinking"]);
    case "leader.model_error":
      return applyModelError(exchange, event);
    // Codex round-3 [C2] — teammate's leaderLoop emits these too
    // (every teammate IS a leader from its own perspective). Without
    // explicit handling they'd be silently dropped from the
    // transcript view. Surface them as SystemNotice rows so the user
    // sees "teammate compacted its context" / "teammate hit max
    // turns" while drilling into the transcript.
    case "leader.messages_compacted":
      return applySystemNotice(exchange, event, "compaction");
    case "leader.doom_loop_detected":
      return applySystemNotice(exchange, event, "doom_loop");
    case "leader.max_turns":
      return applySystemNotice(exchange, event, "max_turns");
    case "leader.async_teammate_consumed":
      // Surface in nested transcripts too — a teammate that spawns its
      // own background sub-teammates needs the completion chip visible
      // inside its drawer, not just at the top level.
      return applySystemNotice(exchange, event, "async_teammate");
    case "leader.model_switched":
      return applySystemNotice(exchange, event, "model_switched");
    case "task.orchestration.transition":
      return isRuntimeRecoveryRetry(event.data)
        ? applySystemNotice(exchange, event, "recovery")
        : exchange;
    case "task.orchestration.stopped":
      return isRuntimeRecoveryBlocked(event.data)
        ? applySystemNotice(exchange, event, "recovery_blocked")
        : exchange;
    // Lifecycle markers we deliberately do NOT render inside the
    // transcript — they're noise at the per-event level (turn_start
    // is one per turn; decision_trace is internal telemetry;
    // session_complete is handled at the leader level via
    // applyTeammateCompleted). Returning the exchange unchanged
    // keeps them out of the transcript without "dropping" them
    // (they're still in execution_events for the trace panel).
    case "leader.turn_start":
    case "leader.decision_trace":
    case "leader.empty_response_detected":
    case "leader.session_complete":
    case "leader.session_checkpoint":
      return exchange;
    default:
      return exchange;
  }
}

function markTerminal(
  exchange: Exchange,
  status: "complete" | "failed",
  reason: "completed" | "failed" | "cancelled" = status === "failed" ? "failed" : "completed",
  skipTeammateFreeze: boolean = false,
): Exchange {
  if (exchange.status === status) return exchange;
  // Seal any in-progress text part so the final state is consistent.
  const sealed = sealActivePart(exchange, ["text", "thinking"]);
  // Strip any orphan `pendingApproval` from tool parts. If the turn
  // ended (failed/aborted/doom-loop) before the bash danger gate's
  // matching tool_result lands, the inline approval row would otherwise
  // stay forever — clicking it would 404 on the long-since-expired
  // approval id and the user would have no way to dismiss it.
  //
  // Also freeze any non-terminal spawn_teammate ToolParts. If the
  // parent task ends (cancel/fail) before backend emits
  // `leader.teammate_completed` for an in-flight child, the UI's
  // `formatTeammateDuration` falls back to `Date.now()` and the
  // "Working (Xm Ys)" timer ticks indefinitely. Stamp a synthetic
  // completion so the duration shows the elapsed-at-terminal value
  // and the status badge stops claiming "spawned" / "running".
  let parts = sealed.response.parts;
  let mutated = false;
  const teammateTerminalStatus: "failed" | "cancelled" =
    reason === "cancelled" ? "cancelled" : "failed";
  const stampMs = Date.now();

  // Freeze unresolved ToolParts inside a teammate's nested transcript
  // too, not just the top-level parts. A teammate that died mid-run
  // with bash / read_file in flight would otherwise show spinning
  // hourglasses forever inside its drawer.
  function freezeUnresolvedNested(toolParts: ToolPart[]): { parts: ToolPart[]; changed: boolean } {
    let nestedChanged = false;
    const nextParts = toolParts.map((tp) => {
      if (tp.result !== null || tp.name === "spawn_teammate" || tp.pendingApproval) {
        // Recurse into nested teammate transcripts even when this
        // outer part doesn't itself need freezing.
        if (tp.transcript && tp.transcript.length > 0) {
          const nestedToolParts = tp.transcript.filter(
            (rp): rp is ToolPart => rp.kind === "tool",
          );
          if (nestedToolParts.length > 0) {
            const { parts: frozenNested, changed: nc } = freezeUnresolvedNested(nestedToolParts);
            if (nc) {
              nestedChanged = true;
              const otherParts = tp.transcript.filter((rp) => rp.kind !== "tool");
              return { ...tp, transcript: [...otherParts, ...frozenNested] };
            }
          }
        }
        return tp;
      }
      nestedChanged = true;
      return {
        ...tp,
        result: {
          isError: true,
          output: status === "failed"
            ? "Tool call did not complete before the turn terminated."
            : "Tool call was cancelled by the turn ending.",
        } as const,
      };
    });
    return { parts: nextParts, changed: nestedChanged };
  }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.kind !== "tool") continue;
    let next = p;
    let changed = false;
    // Snapshot the "had a pending approval at start of iteration"
    // bit BEFORE we strip it. The orphan-tool-result freeze below
    // skips parts that had an approval so the renderer can show
    // "approval expired with turn" rather than mis-attributing the
    // null result to a tool failure.
    const hadPendingApproval = Boolean(p.pendingApproval && p.result === null);
    if (p.pendingApproval && p.result === null) {
      const { pendingApproval: _drop, ...rest } = next;
      next = rest;
      changed = true;
    }
    // Recurse into nested teammate transcripts for hourglass freeze.
    if (next.transcript && next.transcript.length > 0) {
      const nestedToolParts = next.transcript.filter(
        (rp): rp is ToolPart => rp.kind === "tool",
      );
      if (nestedToolParts.length > 0) {
        const { parts: frozenNested, changed: nc } = freezeUnresolvedNested(nestedToolParts);
        if (nc) {
          const otherParts = next.transcript.filter((rp) => rp.kind !== "tool");
          next = { ...next, transcript: [...otherParts, ...frozenNested] };
          changed = true;
        }
      }
    }
    if (
      !skipTeammateFreeze
      && p.name === "spawn_teammate"
      && p.teammateStartedAtMs !== undefined
      && p.teammateCompletedAtMs === undefined
      && p.teammateStatus !== "completed"
      && p.teammateStatus !== "failed"
      && p.teammateStatus !== "cancelled"
    ) {
      next = {
        ...next,
        teammateStatus: teammateTerminalStatus,
        teammateCompletedAtMs: stampMs,
        ...(next.teammateFailureReason
          ? {}
          : {
              teammateFailureReason: reason === "cancelled"
                ? "Parent task was cancelled before teammate reported completion."
                : "Parent task ended before teammate reported completion.",
            }),
      };
      changed = true;
    }
    // Stamp a synthetic failure result on any other ToolPart that's
    // still showing the running hourglass. If the turn terminates
    // (cancel / fail / max-turns) BEFORE the `leader.tool_result`
    // for an in-flight bash/read_file/grep lands, the renderer keeps
    // spinning indefinitely. Skip spawn_teammate (handled by the
    // dedicated branch above — teammate stamps have richer fields)
    // and skip parts that have a pending approval the operator hasn't
    // decided yet (the pendingApproval-strip branch above will run
    // first; result
    // stays null on purpose so the renderer can show "approval
    // expired with turn" rather than mis-attributing it to a tool
    // failure).
    if (
      next.result === null
      && next.name !== "spawn_teammate"
      && !hadPendingApproval
    ) {
      next = {
        ...next,
        result: {
          isError: true,
          output: status === "failed"
            ? "Tool call did not complete before the turn terminated."
            : "Tool call was cancelled by the turn ending.",
        } as const,
      };
      changed = true;
    }
    if (changed) {
      if (!mutated) {
        parts = [...parts];
        mutated = true;
      }
      parts[i] = next;
    }
  }
  if (mutated) {
    return { ...sealed, status, response: { parts } };
  }
  return { ...sealed, status };
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Seal the LAST part of the exchange iff it is one of `kinds` and is
 * still streaming. Unified across text + thinking so a single call
 * site doesn't have to remember to seal both kinds — that pattern
 * caused a class of bugs where one was sealed and the other was
 * forgotten (e.g. tool_call sealed text but left thinking dangling
 * with a live TextBuffer).
 *
 * The old `sealActiveText(exchange)` is now
 * `sealActivePart(exchange, ["text"])`; new code should call
 * `sealActivePart(exchange, ["text", "thinking"])` whenever a
 * boundary closes any active streaming.
 */
function sealActivePart(
  exchange: Exchange,
  kinds: ReadonlyArray<"text" | "thinking">,
): Exchange {
  const parts = exchange.response.parts;
  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];
  if (!last) return exchange;
  if (last.kind !== "text" && last.kind !== "thinking") return exchange;
  if (!kinds.includes(last.kind)) return exchange;
  if (last.sealed) return exchange;
  // Pure: only flip the `sealed` flag. The buffer reference is kept
  // intact so `chatStore.ensureTextBuffers` can later observe the
  // `(sealed: true, buffer != null)` shape and dispose. The projector
  // itself has no business calling buffer.dispose() — that's a side
  // effect on a non-React object.
  const sealed = { ...last, sealed: true } as TextPart | ThinkingPart;
  return withParts(exchange, replaceAt(parts, lastIdx, sealed));
}

function countTextParts(parts: ResponsePart[]): number {
  let n = 0;
  for (const p of parts) if (p.kind === "text") n++;
  return n;
}

function thinkingPartId(requestId: string, ordinal: number): string {
  return `${requestId}:thinking:${ordinal}`;
}

function countThinkingParts(parts: ResponsePart[]): number {
  let n = 0;
  for (const p of parts) if (p.kind === "thinking") n++;
  return n;
}

function pickToolOutput(data: Record<string, unknown>): string {
  if (typeof data.output === "string") return data.output;
  if (typeof data.outputSummary === "string") return data.outputSummary;
  if (typeof data.result === "string") return data.result;
  if (data.output != null) return JSON.stringify(data.output);
  return "";
}

function parsePayload(ev: SnapshotEvent): Record<string, unknown> | null {
  if (ev.payloadJson) {
    try {
      const parsed = JSON.parse(ev.payloadJson) as Record<string, unknown>;
      return parsed;
    } catch {
      return null;
    }
  }
  if (ev.data && typeof ev.data === "object") return ev.data;
  return null;
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  return [...arr.slice(0, idx), value, ...arr.slice(idx + 1)];
}

// ──────────────────────────────────────────────────────────────────────
// Stable part-id derivation (spec §3.4 #3)
// ──────────────────────────────────────────────────────────────────────

export function textPartId(requestId: string, ordinal: number): string {
  return `${requestId}:text:${ordinal}`;
}

export function toolPartId(requestId: string, toolUseId: string): string {
  return `${requestId}:tool:${toolUseId}`;
}

function mediaPartId(requestId: string, mediaId: string): string {
  return `${requestId}:media:${mediaId}`;
}

// ──────────────────────────────────────────────────────────────────────
// Exchange factory + small chainable helper
// ──────────────────────────────────────────────────────────────────────

/**
 * Create an Exchange for an optimistic submission. `id` is the local
 * nonce; `bindRequestId` later rewrites it.
 */
export function createOptimisticExchange(
  localId: string,
  prompt: string,
  attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number }>,
): Exchange {
  const nowMs = Date.now();
  return {
    id: localId,
    status: "pending",
    user: {
      content: prompt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      createdAtMs: nowMs,
    },
    response: { parts: [] },
    timing: { startedAtMs: nowMs, pausedMs: 0 },
    lastAppliedSeq: 0,
  };
}

function withParts(exchange: Exchange, parts: ResponsePart[]): Exchange {
  return { ...exchange, response: { parts } };
}

function withStatus(exchange: Exchange, status: Exchange["status"]): Exchange {
  return exchange.status === status ? exchange : { ...exchange, status };
}
