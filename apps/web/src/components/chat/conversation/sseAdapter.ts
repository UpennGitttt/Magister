/**
 * SSE → chatStore adapter. Single entry point so the wiring in
 * ChatArea is a one-liner (`attachChatStoreSSEAdapter(stream, taskId)`)
 * during the PR 2 shadow phase.
 *
 * Behavior:
 *  - Translates each named SSE event into a `WireEvent` and feeds it
 *    to `chatStore.applyWireEvent(taskId, event)`.
 *  - Translates `task.snapshot` events into a hydrate call.
 *  - The legacy `messages` flow in ChatArea is UNAFFECTED. This adapter
 *    is purely additive — chatStore runs as a shadow until the PR 3
 *    renderer cutover.
 *
 * Spec: docs/specs/2026-04-25-chat-data-flow-refactor.md §4 PR 2.
 */

import { parseWireEvent, useChatStore } from "../../../stores/chatStore";
import { useTaskStore } from "../../../stores/taskStore";
import { useUiStore } from "../../../stores/uiStore";
import type { SnapshotEvent } from "./types";

// Per-tab SSE telemetry. Toggle on by typing
//   localStorage.setItem("magister.sseProfile", "1"); location.reload()
// in DevTools console. Off by default — keeps logs clean for normal use.
function profileEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem("magister.sseProfile") === "1";
  } catch {
    return false;
  }
}

// Prompt-send timestamps keyed by taskId. ChatInput.markPromptSent()
// stamps the moment the user clicked Send (or the moment we kicked off
// the network call, equivalent for telemetry purposes). The SSE adapter
// reads the most recent stamp for this task on first stream_delta and
// prints `prompt→first-delta=<ms>` — the user-perceived "wait after I
// hit send" number, which is the actual ChatGPT-vs-us comparison.
//
// Module-scoped Map. One stamp per taskId (last wins) — sufficient for
// single-user single-tab profiling and avoids the requestId chicken-
// and-egg (POST /tasks hasn't returned a requestId yet at send time).
const promptSendTimes = new Map<string, number>();

export function markPromptSent(taskId: string): void {
  if (!profileEnabled()) return;
  promptSendTimes.set(taskId, performance.now());
  console.info(`[magister.sse] ${taskId.slice(-8)} prompt sent at t=0`);
}

type StreamMetrics = {
  taskId: string;
  openedAt: number;
  snapshotAt: number | null;
  firstStreamDeltaAt: number | null;
  lastStreamDeltaAt: number | null;
  streamDeltaCount: number;
  /** Inter-delta intervals in ms; capped at 200 samples to avoid leak. */
  interDeltaSamples: number[];
  toolCallCount: number;
  turnCompleteCount: number;
};

function startMetrics(taskId: string): StreamMetrics {
  return {
    taskId,
    openedAt: performance.now(),
    snapshotAt: null,
    firstStreamDeltaAt: null,
    lastStreamDeltaAt: null,
    streamDeltaCount: 0,
    interDeltaSamples: [],
    toolCallCount: 0,
    turnCompleteCount: 0,
  };
}

function recordEventForMetrics(metrics: StreamMetrics, type: string): void {
  const t = performance.now();
  if (type === "leader.stream_delta") {
    if (metrics.firstStreamDeltaAt === null) {
      metrics.firstStreamDeltaAt = t;
      // Two distinct numbers, both useful:
      //   prompt→first-delta = user-perceived wait after hitting Send
      //     (network RTT + backend setup + model first byte + SSE relay)
      //     This is what to compare to ChatGPT.
      //   open→first-delta = how long since this SSE was opened
      //     (less meaningful — includes user think+type time)
      // The prior version only printed open→first-delta which led to
      // confusing 16s / 46s / 71s numbers (those were stream-uptime,
      // not response latency).
      const promptSentAt = promptSendTimes.get(metrics.taskId);
      if (promptSentAt !== undefined) {
        const sinceSend = (t - promptSentAt).toFixed(0);
        console.info(`[magister.sse] ${metrics.taskId.slice(-8)} prompt→first-delta=${sinceSend}ms`);
        promptSendTimes.delete(metrics.taskId); // consumed
      } else {
        const sinceOpen = (t - metrics.openedAt).toFixed(0);
        console.info(`[magister.sse] ${metrics.taskId.slice(-8)} open→first-delta=${sinceOpen}ms (no prompt-send mark)`);
      }
    } else if (metrics.lastStreamDeltaAt !== null) {
      const interval = t - metrics.lastStreamDeltaAt;
      if (metrics.interDeltaSamples.length < 200) {
        metrics.interDeltaSamples.push(interval);
      }
    }
    metrics.lastStreamDeltaAt = t;
    metrics.streamDeltaCount += 1;
  } else if (type === "leader.tool_call") {
    metrics.toolCallCount += 1;
  } else if (type === "leader.turn_complete") {
    metrics.turnCompleteCount += 1;
    // Per-turn rollup: median + p95 of inter-delta intervals.
    const samples = metrics.interDeltaSamples.slice().sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const total = metrics.lastStreamDeltaAt && metrics.firstStreamDeltaAt
      ? (metrics.lastStreamDeltaAt - metrics.firstStreamDeltaAt) / 1000
      : 0;
    const rate = total > 0 ? (metrics.streamDeltaCount / total).toFixed(1) : "n/a";
    console.info(
      `[magister.sse] ${metrics.taskId.slice(-8)} turn ${metrics.turnCompleteCount} done — `
      + `${metrics.streamDeltaCount} deltas, ${total.toFixed(2)}s, ${rate}/s, `
      + `median=${median.toFixed(0)}ms p95=${p95.toFixed(0)}ms, tool_calls=${metrics.toolCallCount}`,
    );
    // Reset per-turn counters for the next turn (keep openedAt fixed).
    metrics.streamDeltaCount = 0;
    metrics.interDeltaSamples = [];
    metrics.firstStreamDeltaAt = null;
    metrics.lastStreamDeltaAt = null;
    metrics.toolCallCount = 0;
  }
}

const STREAM_EVENT_TYPES = [
  "leader.stream_delta",
  "leader.tool_call",
  "leader.tool_result",
  "leader.turn_complete",
  "leader.model_error",
  "leader.session_complete",
  "task:completed",
  "task:failed",
  "task:cancelled",
  // Plan mode (spec docs/specs/2026-04-26-plan-mode-spec.md §10.2). Without
  // these in the allowlist the projector never sees plan_proposed and
  // PlanCard would never render.
  "leader.plan_mode_entered",
  "leader.plan_proposed",
  "leader.plan_mode_exited",
  // teammate spawn lifecycle.
  // teammate_spawned populates the spawn_teammate ToolPart's
  // teammateRunId/teammateName fields; teammate_completed flips
  // status + populates summary. Without these in the allowlist
  // the projector would see depth=1 events arriving with no
  // matching ToolPart container.
  "leader.teammate_spawned",
  "leader.teammate_completed",
  "leader.async_teammate_consumed",
  // Dangerous-command approval gate. Pairs with the most recent
  // tool_call so the renderer can surface inline Approve/Reject without
  // forcing the user to navigate to the dashboard mid-conversation.
  "leader.approval_requested",
  "leader.approval_resolved",
  // Loop-level system notices — context compaction (regression from
  // legacy ChatArea), doom-loop self-block, and max-turns exit. The
  // last two used to leave the user with a silently-failed task; this
  // surfaces the cause inline.
  "leader.messages_compacted",
  "leader.doom_loop_detected",
  "leader.max_turns",
  // Runtime recovery first-pass UX: concise notices for requeue/block
  // events when they are tied to a requestId in live or replayed data.
  "task.orchestration.transition",
  "task.orchestration.stopped",
] as const;

type Detacher = () => void;

/**
 * Attach chatStore handlers to an open EventSource. Returns a function
 * that detaches them — call from the useEffect cleanup.
 *
 * IMPORTANT: this adapter does NOT take ownership of the EventSource.
 * The caller (ChatArea's existing SSE useEffect) keeps owning open/
 * close. We just observe.
 */
export function attachChatStoreSSEAdapter(
  stream: EventSource,
  taskId: string,
): Detacher {
  const store = useChatStore.getState();
  const metrics: StreamMetrics | null = profileEnabled() ? startMetrics(taskId) : null;
  if (metrics) {
    console.info(`[magister.sse] ${taskId.slice(-8)} stream opened`);
  }

  // Live event handler — common to all the leader.*/task:* events.
  const handleEvent = (event: Event) => {
    const me = event as MessageEvent<string>;
    let payload: unknown;
    try {
      payload = JSON.parse(me.data);
    } catch {
      return; // malformed wire payload — drop
    }
    const eventType = (event as Event & { type: string }).type;
    if (metrics) recordEventForMetrics(metrics, eventType);

    // Auto-clear the planMode toggle whenever the leader exits plan
    // mode (approved / cancelled / revised). Without this, the user
    // clicks Approve, types a follow-up like "and also fix Y", and the
    // persisted-localStorage `planMode=true` forces planFirst on the
    // next POST /tasks, putting the model back into PLANNING for what
    // should have been a normal turn —
    // it looks like the chat is "stuck in plan mode" and Approve
    // didn't actually take effect.
    if (eventType === "leader.plan_mode_exited") {
      try {
        useUiStore.getState().setPlanMode(false);
      } catch {
        // never block event apply on a UI-store hiccup
      }
    }

    const wire = parseWireEvent(eventType, payload);
    if (!wire) return;

    store.applyWireEvent(taskId, wire);
  };

  // Snapshot handler — replay everything as a SnapshotEvent[].
  const handleSnapshot = (event: Event) => {
    const me = event as MessageEvent<string>;
    let payload: { events?: unknown; attachments?: unknown };
    try {
      payload = JSON.parse(me.data);
    } catch {
      return;
    }
    if (metrics) {
      metrics.snapshotAt = performance.now();
      const ms = (metrics.snapshotAt - metrics.openedAt).toFixed(0);
      console.info(`[magister.sse] ${taskId.slice(-8)} snapshot received in ${ms}ms`);
    }
    if (!payload.events || !Array.isArray(payload.events)) return;
    const events: SnapshotEvent[] = payload.events
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .map((row) => {
        // decode the persisted agent envelope so
        // snapshot replay emits the same WireEvent shape as live SSE.
        // Pre-migration rows have `agentJson === null` and we fall
        // back to `roleRuntimeId` for depth derivation.
        let agent: SnapshotEvent["agent"];
        if (typeof row.agentJson === "string" && row.agentJson.length > 0) {
          try {
            const parsed = JSON.parse(row.agentJson) as Record<string, unknown>;
            if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
              agent = parsed as SnapshotEvent["agent"];
            }
          } catch {
            // Malformed agent_json → leave undefined; legacy fallback below.
          }
        }
        return {
          id: typeof row.id === "string" ? row.id : "",
          type: typeof row.type === "string" ? row.type : "",
          requestId: typeof row.requestId === "string" ? row.requestId : null,
          seq: typeof row.seq === "number" ? row.seq : 0,
          ...(typeof row.occurredAt === "string" ? { occurredAt: row.occurredAt } : {}),
          ...(typeof row.payloadJson === "string" ? { payloadJson: row.payloadJson } : {}),
          ...(row.data && typeof row.data === "object"
            ? { data: row.data as Record<string, unknown> }
            : {}),
          ...(agent ? { agent } : {}),
          ...(typeof row.roleRuntimeId === "string"
            ? { roleRuntimeId: row.roleRuntimeId }
            : {}),
        };
      })
      .filter((row) => row.id && row.type);
    useChatStore.getState().hydrateFromSnapshot(taskId, events);

    // Attachment metadata: the snapshot frame carries `attachments[]`
    // keyed by upload `requestId`. Hydrate after exchanges so the
    // chip-render logic finds matching exchange ids. Defensive — older
    // backends without this field pass through harmlessly via the
    // early-return.
    if (Array.isArray(payload.attachments)) {
      const attachments = (payload.attachments as Array<Record<string, unknown>>)
        .filter((a) => typeof a.filename === "string" && typeof a.mimeType === "string")
        .map((a) => ({
          requestId: typeof a.requestId === "string" ? a.requestId : null,
          filename: a.filename as string,
          mimeType: a.mimeType as string,
          sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
        }));
      if (attachments.length > 0) {
        useChatStore.getState().hydrateAttachments(taskId, attachments);
      }
    }
  };

  stream.addEventListener("task.snapshot", handleSnapshot);
  for (const t of STREAM_EVENT_TYPES) {
    stream.addEventListener(t, handleEvent);
  }

  // Reconnect-aware refetch. EventSource auto-reconnects on transient
  // network blips (browser default 3-5s retry). On the initial open
  // the server delivers `task.snapshot` which hydrates everything. On
  // a RECONNECT after a prior `error`, the server SHOULD re-send the
  // snapshot — but if events were missed between disconnect and
  // reconnect (e.g. task:failed fired during the window), the
  // exchange status stays "running" / badge stays "EXECUTING" forever.
  //
  // Belt-and-suspenders: detect reconnect (open-after-error) and
  // refetch the task list (scoped to the SAME workspace the user is
  // viewing — codex review HIGH 1: an unscoped refetch would replace
  // the workspace-scoped task list ChatPage maintains with a global
  // list, surprising the operator).
  //
  // The snapshot replay still does the heavy lifting for in-conversation
  // state; this just handles the cross-cutting "is the task still alive"
  // signal at the task-list badge layer.
  let hadError = false;
  const onError = () => { hadError = true; };
  const onOpen = () => {
    if (!hadError) return;
    hadError = false;
    // Find this task's workspaceId from the current store snapshot so
    // we re-fetch with the right scope. If the task isn't in the store
    // (rare — usually means the user just switched and we're racing
    // the initial fetch), fall through to unscoped — it'll converge.
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
    const workspaceId = task?.workspaceId ?? null;
    // Fire-and-forget — `fetchTasks` swallows its own errors via
    // useTaskStore (sets the `error` field instead of throwing). Use
    // an explicit `.catch(noop)` so a future change to that contract
    // doesn't produce an unhandled rejection here. (codex review LOW.)
    useTaskStore
      .getState()
      .fetchTasks(workspaceId ? { workspaceId } : undefined)
      .catch(() => {});
  };
  stream.addEventListener("error", onError);
  stream.addEventListener("open", onOpen);

  return () => {
    stream.removeEventListener("task.snapshot", handleSnapshot);
    stream.removeEventListener("error", onError);
    stream.removeEventListener("open", onOpen);
    for (const t of STREAM_EVENT_TYPES) {
      stream.removeEventListener(t, handleEvent);
    }
  };
}
