/**
 * Chat conversation store — per-task `Conversation` state machine.
 *
 * Replaces the chaotic `messages: Message[]` flow in ChatArea (17
 * mutation sites). Spec: docs/specs/2026-04-25-chat-data-flow-refactor.md
 * §3.1, §3.4, §4 PR 2.
 *
 * Lives separately from `taskStore` to avoid the past tangle:
 *  - taskStore owns the sidebar list + `isWaitingForResponse`-style
 *    flags. It is migration-frozen during PR 2 and shrinks in PR 3.
 *  - chatStore owns the message-stream state per task: the projected
 *    Conversation, the optimistic exchange while we wait for the
 *    backend's requestId, and the per-text-part streaming buffers.
 *
 * Key contract (spec §3.4):
 *  - The projector (`conversation/projector.ts`) is the only function
 *    that decides part identity and part order. This store is a thin
 *    layer around it: it stores Conversation by taskId and routes
 *    inbound events through the projector.
 *  - Events arriving for unknown requestIds are dropped silently
 *    (handled inside the projector).
 *  - Optimistic exchanges are created with a local nonce id and
 *    rewritten to the server's requestId via `bindRequestId` once the
 *    POST /tasks response lands.
 *  - Per-text-part TextBuffer instances are created lazily on first
 *    text_delta arrival (or seeded by snapshot replay) and disposed
 *    when the part is sealed. Buffer references are stable for a
 *    part's lifetime.
 */

import { create } from "zustand";

import {
  applyEvent,
  applyEvents,
  createOptimisticExchange,
  projectSnapshot,
  seedSnapshotConversation,
} from "../components/chat/conversation/projector";

// RAF coalescing for nested teammate
// stream_delta events. A teammate spawning 100+ deltas/sec generates
// hundreds of React commits if applied synchronously; that's the
// 50-fps-with-3-parallel-teammates budget killer. Module-scope so the
// queue survives across applyWireEvent calls. Leader-level deltas
// (depth=0 / no agent) keep the existing synchronous path so the
// user-visible "token-by-token" feel for the assistant's own reply
// is preserved — only the usually-collapsed teammate transcripts
// batch.
const pendingNestedDeltas = new Map<string, WireEvent[]>();
let nestedFlushScheduled = false;

// FE1 fix: per-exchange fast-path dedup watermark, keyed by
// `${taskId}:${requestId}`. This replaces the in-place `ex.lastAppliedSeq`
// mutation that the fast path previously used to prevent re-delivery of
// leader text_delta events. Storing it separately means the projector's
// exchange-level `lastAppliedSeq` is ONLY advanced by full projector
// commits — so queued nested/thinking deltas with lower seq numbers are
// NOT dedup-dropped when the fast path handles a higher-seq leader delta.
// Cleared by resetForTests().
const fastPathSeqWatermark = new Map<string, number>();

function scheduleNestedFlush(): void {
  if (nestedFlushScheduled) return;
  nestedFlushScheduled = true;
  // 1-frame coalesce window. RAF in browsers; setTimeout fallback
  // for SSR / test environments.
  const fn = () => {
    nestedFlushScheduled = false;
    flushPendingNestedDeltas();
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 16);
  }
}

function flushPendingNestedDeltas(): void {
  if (pendingNestedDeltas.size === 0) return;
  const entries = Array.from(pendingNestedDeltas.entries());
  pendingNestedDeltas.clear();
  nestedFlushScheduled = false;
  useChatStore.setState((state) => {
    let conversations = state.conversations;
    for (const [taskId, events] of entries) {
      const conv = conversations[taskId];
      if (!conv) continue;
      let next = conv;
      for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
        const after = applyEvent(next, ev);
        next = ensureTextBuffers(after, ev);
      }
      if (next !== conv) {
        conversations = { ...conversations, [taskId]: next };
      }
    }
    if (conversations === state.conversations) return state;
    return { conversations };
  });
}

function flushPendingDeltasForTask(taskId: string): void {
  const events = pendingNestedDeltas.get(taskId);
  if (!events || events.length === 0) return;
  pendingNestedDeltas.delete(taskId);
  useChatStore.setState((state) => {
    const conv = state.conversations[taskId];
    if (!conv) return state;
    let next = conv;
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      const after = applyEvent(next, ev);
      next = ensureTextBuffers(after, ev);
    }
    if (next === conv) return state;
    return { conversations: { ...state.conversations, [taskId]: next } };
  });
}

/**
 * Soft cap on how many exchanges we hydrate into the frontend store.
 * ChatArea windows to last 15; we keep a bit more (30) so the user
 * can scroll up a few without immediate fallback. Older exchanges
 * live in the DB and the trace panel can drill deeper on demand.
 * Without this cap, opening a 172k-event task kicks off a multi-second
 * chunked replay that pegs the main thread (input lag, scroll jumps,
 * typing not echoing).
 */
const MAX_HYDRATED_EXCHANGES = 30;

/**
 * Drop events from older requestIds when a task has more
 * exchanges than MAX_HYDRATED_EXCHANGES. Keeps all events for the
 * most-recent exchanges, drops the rest. Order-preserving:
 * exchanges are identified by first-seen-seq, so "most recent"
 * = highest first-seen-seq.
 */
function capEventsByExchangeWindow(
  events: SnapshotEvent[],
  maxExchanges: number,
): SnapshotEvent[] {
  if (events.length === 0) return events;
  const firstSeqByRequest = new Map<string, number>();
  for (const ev of events) {
    if (!ev.requestId) continue;
    if (!firstSeqByRequest.has(ev.requestId)) {
      firstSeqByRequest.set(ev.requestId, ev.seq);
    }
  }
  if (firstSeqByRequest.size <= maxExchanges) return events;
  // Sort requestIds by first-seen-seq DESC, take the top N.
  const recent = [...firstSeqByRequest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxExchanges)
    .map(([rid]) => rid);
  const recentSet = new Set(recent);
  return events.filter((ev) => ev.requestId && recentSet.has(ev.requestId));
}

import { TextBuffer } from "../components/chat/conversation/textBuffer";
import type {
  Conversation,
  Exchange,
  ResponsePart,
  SnapshotEvent,
  SystemPart,
  TextPart,
  WireEvent,
} from "../components/chat/conversation/types";

type ChatState = {
  /**
   * Per-task Conversation. Lazy-created on first `beginExchange`/`hydrate`.
   * The synthesized key `_pending:${localId}` holds in-flight optimistic
   * exchanges that haven't been bound to a real taskId yet.
   */
  conversations: Record<string, Conversation>;

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Optimistic exchange creation. Called by ChatInput on user submit,
   * BEFORE the backend's taskId/requestId are known. Pass the
   * currently-selected taskId if you have one (follow-up turn within an
   * active chat) or `null` for a fresh chat where the taskId will only
   * be known after `createTask` returns.
   *
   * Returns the local nonce id. Call `bindRequestId(localId, taskId,
   * requestId)` when both backend ids arrive — that atomically:
   *   - migrates the exchange out of the `_pending:*` placeholder if any
   *   - rewrites the local id to the canonical requestId
   *   - merges with a remote-arriving-first exchange if a race occurred
   */
  beginExchange: (
    taskId: string | null,
    prompt: string,
    attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number }>,
  ) => string;

  /**
   * Reconcile a local optimistic exchange to the canonical taskId +
   * requestId from the backend. The lookup is by `localId` ONLY — the
   * caller never has to track which conversation key the exchange was
   * placed under, eliminating the stale-closure rebirth-dance bug
   * present in the previous design.
   */
  bindRequestId: (localId: string, taskId: string, requestId: string) => void;

  /**
   * Roll back an optimistic exchange (used when createTask fails).
   * Looks up by `localId` across all conversations including the
   * pending-placeholder bucket.
   */
  rollbackOptimistic: (localId: string) => void;

  // ── Event ingest ────────────────────────────────────────────────

  /** Apply a single live SSE event. */
  applyWireEvent: (taskId: string, event: WireEvent) => void;

  /**
   * Cold-load / reconnect hydration. Replaces the conversation for
   * this task with the projection of `events`. Use a stable input set
   * (sorted, deduped at the API layer is fine — projector dedupes
   * again by (requestId, seq)).
   */
  hydrateFromSnapshot: (taskId: string, events: SnapshotEvent[]) => void;

  /**
   * Cold-load attachment metadata. The snapshot frame carries
   * `attachments[]` keyed by upload `requestId`; this method
   * groups them and stamps each matching exchange's
   * `user.attachments` field. Idempotent — calling twice with the
   * same input is a no-op. Survives a page reload so the
   * user-bubble file chips render after refresh, not just in the
   * optimistic chatStore window.
   */
  hydrateAttachments: (
    taskId: string,
    attachments: Array<{
      requestId: string | null;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }>,
  ) => void;

  /**
   * Cold-load user-prompt reconciliation. The execution_events stream
   * doesn't carry user prompts (only leader.* and task:*), so on a
   * fresh page load the projector produces exchanges with empty
   * `user.content`. This method walks the API `/messages` response and
   * binds user prompts to exchanges.
   *
   * Binding strategy:
   *   - PREFERRED: when prompts carry `requestId` (stamped by backend
   *     onto user-role LeaderMessage at creation), look up the exchange
   *     whose `id === requestId` and bind directly. If multiple prompts
   *     resolve to the same exchange (one leader run absorbed multiple
   *     mailbox prompts), concatenate with a separator.
   *   - FALLBACK: when EVERY prompt is missing `requestId` (old task
   *     whose checkpoint predates the field), fall back to tail-pair —
   *     i-th-from-end prompt → i-th-from-end exchange. Sound for
   *     historical sessions where the off-by-N problem isn't a regression
   *     vs prior behavior.
   *
   * Idempotent: calling twice with the same input is a no-op (only
   * fills empty `user.content`, never overwrites a populated one).
   */
  hydrateUserPrompts: (
    taskId: string,
    prompts: Array<{ content: string; requestId?: string }>,
  ) => void;

  // ── Selectors (callable; React reads via useChatStore selectors) ─

  /**
   * The exchange the user is currently waiting on, if any. Returns the
   * latest non-terminal exchange. Replaces the global
   * `isWaitingForResponse` derived flag.
   */
  pendingExchangeId: (taskId: string) => string | null;

  // ── Local-only diagnostics ──────────────────────────────────────

  /**
   * Clear all exchanges from a conversation (local-only, used by /clear).
   * Disposes any live TextBuffer instances to avoid leaks.
   */
  clearExchanges: (conversationKey: string) => void;

  /**
   * Push a synthetic complete Exchange into the conversation. Used by
   * the chat `/status` slash command (and future inline-diagnostic
   * slash commands) so the user sees the report INLINE in the chat
   * log rather than navigating to a separate page.
   *
   * The exchange is local-only — not persisted to the backend, not
   * matched by execution_events. It survives within the chatStore
   * memory only; a page reload drops it (acceptable for ephemeral
   * diagnostic output).
   *
   * `conversationKey` matches `beginExchange` semantics: the live
   * taskId for an active session, or `null` to mint a transient
   * `_pending` bucket (lets `/status` work in the pre-first-message
   * compose state too).
   */
  pushLocalDiagnostic: (
    conversationKey: string | null,
    userText: string,
    systemPart: SystemPart,
  ) => void;

  // ── Test/debug ──────────────────────────────────────────────────

  /**
   * Did this taskId ever receive at least one event with a requestId?
   * Used by the renderer (PR 3) to decide between the new
   * Exchange-based render path (returns true) and the legacy fallback
   * for pre-PR-1 tasks whose execution_events all have NULL requestId
   * (returns false).
   */
  hasModernEvents: (taskId: string) => boolean;

  /** Force all non-terminal exchanges to "complete". Used by the
   *  fallback poll when SSE missed the terminal event. */
  forceCompleteTask: (taskId: string) => void;

  /** Reset all in-memory state. Test-only. */
  resetForTests: () => void;
};

// Module-level nonce — local id for optimistic exchanges.
let nonceCounter = 0;
function localExchangeId(): string {
  nonceCounter++;
  return `local_${Date.now().toString(36)}_${nonceCounter.toString(36)}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: {},

  beginExchange: (taskId, prompt, attachments) => {
    const id = localExchangeId();
    const conversationKey = taskId ?? `_pending:${id}`;
    set((state) => {
      const existing = state.conversations[conversationKey] ?? { taskId: conversationKey, exchanges: [] };
      const next: Conversation = {
        ...existing,
        exchanges: [...existing.exchanges, createOptimisticExchange(id, prompt, attachments)],
      };
      return { conversations: { ...state.conversations, [conversationKey]: next } };
    });
    return id;
  },

  bindRequestId: (localId, taskId, requestId) => {
    set((state) => {
      // Find the exchange wherever it was placed — by localId only.
      // Don't trust the caller to track which conversation key it lives
      // under; that's the rebirth-dance bug the old API had.
      let sourceKey: string | null = null;
      let sourceIdx = -1;
      for (const [key, conv] of Object.entries(state.conversations)) {
        const idx = conv.exchanges.findIndex((e) => e.id === localId);
        if (idx >= 0) {
          sourceKey = key;
          sourceIdx = idx;
          break;
        }
      }
      if (!sourceKey || sourceIdx < 0) return state; // already reconciled / not found

      const sourceConv = state.conversations[sourceKey]!;
      const local = sourceConv.exchanges[sourceIdx]!;

      // Same-key migration (caller already had the right taskId).
      if (sourceKey === taskId) {
        const remoteIdx = sourceConv.exchanges.findIndex(
          (e, i) => i !== sourceIdx && e.id === requestId,
        );
        if (remoteIdx < 0) {
          // Common case: no race — rewrite local id to requestId. Also
          // stamp the requestId onto user.hydratedRequestIds so the
          // subsequent /messages hydrate pass treats this exchange as
          // already-having-the-canonical-initial-prompt and skips it.
          const rewritten: Exchange = {
            ...local,
            id: requestId,
            user: {
              ...local.user,
              hydratedRequestIds: dedupAppend(local.user.hydratedRequestIds, requestId),
            },
          };
          return {
            conversations: {
              ...state.conversations,
              [taskId]: {
                ...sourceConv,
                exchanges: replaceAt(sourceConv.exchanges, sourceIdx, rewritten),
              },
            },
          };
        }
        // Race: backend events created an exchange for `requestId` before
        // we got POST /tasks back. Merge local user prompt into remote
        // (which holds response state we don't want to drop). Also
        // carry attachments forward — `remote` was seeded from events
        // with no attachments; `local` may have them from ChatInput.
        const remote = sourceConv.exchanges[remoteIdx]!;
        const merged: Exchange = {
          ...remote,
          user: {
            ...remote.user,
            content: local.user.content || remote.user.content,
            ...(local.user.attachments ? { attachments: local.user.attachments } : {}),
            hydratedRequestIds: dedupAppend(remote.user.hydratedRequestIds, requestId),
          },
        };
        const dropped = sourceConv.exchanges.filter((_, i) => i !== sourceIdx);
        const remoteAdjustedIdx = remoteIdx > sourceIdx ? remoteIdx - 1 : remoteIdx;
        return {
          conversations: {
            ...state.conversations,
            [taskId]: {
              ...sourceConv,
              exchanges: replaceAt(dropped, remoteAdjustedIdx, merged),
            },
          },
        };
      }

      // Cross-key migration (sourceKey === `_pending:${localId}` originally,
      // taskId is the real task we should land in). Atomic: remove from
      // pending bucket, place in real conversation (creating it if absent),
      // and on a race-with-remote case merge as above.
      const newConversations: Record<string, Conversation> = { ...state.conversations };

      // Drop from source. If pending bucket empty after, delete the key.
      const sourceAfter = sourceConv.exchanges.filter((_, i) => i !== sourceIdx);
      if (sourceAfter.length === 0 && sourceKey.startsWith("_pending:")) {
        delete newConversations[sourceKey];
      } else {
        newConversations[sourceKey] = { ...sourceConv, exchanges: sourceAfter };
      }

      // Place in destination conversation.
      const destConv = newConversations[taskId] ?? { taskId, exchanges: [] };
      const destRemoteIdx = destConv.exchanges.findIndex((e) => e.id === requestId);

      if (destRemoteIdx < 0) {
        // No race — append rewritten exchange. Seed
        // hydratedRequestIds so the subsequent /messages hydrate skips
        // this exchange (its prompt was set by the local optimistic).
        const rewritten: Exchange = {
          ...local,
          id: requestId,
          user: {
            ...local.user,
            hydratedRequestIds: dedupAppend(local.user.hydratedRequestIds, requestId),
          },
        };
        newConversations[taskId] = {
          ...destConv,
          exchanges: [...destConv.exchanges, rewritten],
        };
      } else {
        // Race: merge prompt into remote (which holds response state).
        // Carry attachments forward + seed hydratedRequestIds same as
        // the same-key branch above.
        const remote = destConv.exchanges[destRemoteIdx]!;
        const merged: Exchange = {
          ...remote,
          user: {
            ...remote.user,
            content: local.user.content || remote.user.content,
            ...(local.user.attachments ? { attachments: local.user.attachments } : {}),
            hydratedRequestIds: dedupAppend(remote.user.hydratedRequestIds, requestId),
          },
        };
        newConversations[taskId] = {
          ...destConv,
          exchanges: replaceAt(destConv.exchanges, destRemoteIdx, merged),
        };
      }
      return { conversations: newConversations };
    });
  },

  rollbackOptimistic: (localId) => {
    set((state) => {
      // Find by localId across all conversations.
      for (const [key, conv] of Object.entries(state.conversations)) {
        const idx = conv.exchanges.findIndex((e) => e.id === localId);
        if (idx < 0) continue;
        disposePartBuffers(conv.exchanges[idx]!.response.parts);
        const exchanges = conv.exchanges.filter((_, i) => i !== idx);
        const next = { ...state.conversations };
        if (exchanges.length === 0 && key.startsWith("_pending:")) {
          delete next[key];
        } else {
          next[key] = { ...conv, exchanges };
        }
        return { conversations: next };
      }
      return state;
    });
  },

  applyWireEvent: (taskId, event) => {
    // RAF-coalesce nested teammate
    // stream_delta events. A single teammate can fire 100+ deltas/sec;
    // committing each synchronously triggers a React re-render every
    // delta, which kills the 50-fps budget when 3 teammates run in
    // parallel. Queue them and flush once per frame. Leader deltas
    // (depth=0) and all non-stream_delta events keep the synchronous
    // path so the user-visible "token-by-token" assistant reply
    // doesn't regress. The text_delta cap is gated on `agent.depth > 0`
    // because that's exactly where the high-volume teammate streams
    // live (always inside a usually-collapsed transcript anyway).
    // Extended coalescing: ALSO RAF-batch leader-level thinking_delta.
    // Thinking arrives at ~140/sec from kimi-k2.6 and similar reasoning
    // models. The user reads thinking at far lower cadence; per-delta
    // React commits on a heavy session starve the main thread and the
    // deltas appear bursty anyway. Text deltas (the actual assistant response)
    // keep the synchronous path so the canonical answer stays
    // token-by-token smooth.
    if (event.type === "leader.stream_delta") {
      const isNested = !!(event.agent && event.agent.depth > 0);
      const innerType = typeof event.data?.type === "string" ? event.data.type : null;
      const isThinking = innerType === "thinking_delta";
      if (isNested || isThinking) {
        const queue = pendingNestedDeltas.get(taskId) ?? [];
        queue.push(event);
        pendingNestedDeltas.set(taskId, queue);
        scheduleNestedFlush();
        return;
      }

      // Leader text_delta decoupling (mobile streaming perf).
      //
      // The COMMON case — every token after the first of a text segment —
      // appends to an already-open, already-buffered text part. The
      // animated leaf reads from `part.buffer.getSnapshot()` via
      // useSyncExternalStore, so feeding the buffer is the ONLY work the
      // UI needs. Running the projector here would rebuild the Exchange
      // tree and mint a new `conversations` reference every token, which
      // forces ChatArea (subscribed to the whole conversation object) to
      // re-render every token across up to 15 non-virtualized exchanges —
      // the entire source of the reported mobile lag.
      //
      // So: if this delta targets an EXISTING unsealed leader text part
      // that ALREADY owns a buffer, feed the buffer directly and return
      // WITHOUT a store commit. No new conversation identity → no
      // re-render. The part's canonical `content` is reconciled from the
      // buffer's full text at seal time (see ensureTextBuffers).
      //
      // The FIRST delta of a part (no part / no buffer yet) falls through
      // to the normal commit path below, which creates the text part and
      // attaches+seeds the buffer (mounting StreamingTextPart).
      if (innerType === "text_delta") {
        const fed = tryFastAppendLeaderDelta(taskId, event);
        if (fed) return; // buffer fed; no store mutation
      }
    }

    flushPendingDeltasForTask(taskId);

    set((state) => {
      const conv = state.conversations[taskId] ?? { taskId, exchanges: [] };
      const before = conv;
      const after = applyEvent(conv, event);

      // Side-effect dispatch lives here, NOT in the projector:
      //  - lazy-create a TextBuffer when a fresh unsealed text part appears
      //  - feed text_delta strings to the active part's buffer so the leaf
      //    re-renders via useSyncExternalStore
      //  - dispose buffer references on sealed parts
      const next = ensureTextBuffers(after, event);

      if (next === before) return state; // no observable change
      return { conversations: { ...state.conversations, [taskId]: next } };
    });
  },

  hydrateUserPrompts: (taskId, prompts) => {
    set((state) => {
      const conv = state.conversations[taskId];
      if (!conv || conv.exchanges.length === 0) return state;

      const next: Exchange[] = conv.exchanges.slice();
      let mutated = false;

      // Pass 1 — requestId-based direct binding. Every prompt that has
      // a backend-stamped requestId resolves to a single exchange by id.
      // Two cases:
      //   (a) `p.requestId === ex.id`: this prompt IS the exchange's
      //       canonical initial. If existing content is empty → set; if
      //       a fold (`task.prompt_merged`) has already appended other
      //       prompts → PREPEND so the canonical initial appears first.
      //   (b) `p.requestId !== ex.id`: shouldn't normally reach hydrate
      //       (the leader run uses its own requestId for the initial
      //       prompt and source-requestIds for folded mailbox prompts;
      //       the projector handles those via prompt_merged). Defensive
      //       no-op — append it to keep content visible if a future
      //       backend change emits this shape, but rely on
      //       hydratedRequestIds for dedup.
      // Idempotency via user.hydratedRequestIds — set by bindRequestId,
      // by this method, and by applyPromptMerged. Same requestId never
      // writes twice across reloads or paths.
      const PROMPT_SEPARATOR = "\n\n---\n\n";
      const indexByRequestId = new Map<string, number>();
      for (let i = 0; i < next.length; i++) {
        indexByRequestId.set(next[i]!.id, i);
      }
      for (const p of prompts) {
        if (!p.requestId) continue;
        const idx = indexByRequestId.get(p.requestId);
        if (idx === undefined) continue; // exchange not in window
        const ex = next[idx]!;
        const hydrated = ex.user.hydratedRequestIds ?? [];
        if (hydrated.includes(p.requestId)) continue; // already bound
        const existing = ex.user.content;
        const isCanonical = p.requestId === ex.id;
        const newContent = !existing
          ? p.content
          : isCanonical
            ? p.content + PROMPT_SEPARATOR + existing
            : existing + PROMPT_SEPARATOR + p.content;
        next[idx] = {
          ...ex,
          user: {
            ...ex.user,
            content: newContent,
            hydratedRequestIds: [...hydrated, p.requestId],
          },
        };
        mutated = true;
      }

      // Pass 2 — legacy tail-pair backfill for prompts WITHOUT
      // requestId. Pre-fix checkpoints stored user messages without the
      // field; mixed sessions can have both (one new turn + many old
      // turns from prior runs). Walk the still-empty exchanges from the
      // tail and pair with the legacy prompts from the tail. Same
      // algorithm as the pre-fix path. Documented limitation: when one
      // legacy leader run absorbed multiple mailbox prompts the
      // pairing slides off by N — but this is no regression vs the
      // pre-fix behavior, and historical sessions are unaffected by
      // post-fix mailbox batching.
      const legacyPrompts = prompts.filter((p) => !p.requestId);
      if (legacyPrompts.length > 0) {
        let pi = legacyPrompts.length - 1;
        let ei = next.length - 1;
        while (pi >= 0 && ei >= 0) {
          const ex = next[ei]!;
          if (!ex.user.content) {
            const prompt = legacyPrompts[pi];
            if (prompt) {
              next[ei] = { ...ex, user: { ...ex.user, content: prompt.content } };
              mutated = true;
            }
            pi--;
          }
          ei--;
        }
      }

      if (!mutated) return state;
      return {
        conversations: {
          ...state.conversations,
          [taskId]: { ...conv, exchanges: next },
        },
      };
    });
  },

  hydrateFromSnapshot: (taskId, events) => {
    // FE1: clear this task's fast-path watermark before hydrating. A stale
    // watermark left by the pre-reconnect live stream (advanced to some high
    // seq) would otherwise dedup-drop the redelivered live tail once snapshot
    // hydration replaces this conversation with a (possibly lower)
    // lastAppliedSeq — silently losing text after a reconnect.
    for (const key of fastPathSeqWatermark.keys()) {
      if (key.startsWith(`${taskId}:`)) fastPathSeqWatermark.delete(key);
    }
    // chunked snapshot replay.
    //
    // Tail-only hydration for pathological tasks. For tasks with
    // hundreds of thousands of events, even chunked rIC replay churns
    // the main thread for tens of seconds: input lag, scroll jumping,
    // typing not echoing. The user only ever sees the most recent
    // exchanges anyway (ChatArea windows to 15). So before applying
    // anything, drop events from older requestIds beyond a soft cap.
    // Older exchanges still live in the DB (the trace panel + lazy-load
    // endpoint can fetch them), they just don't burn CPU on every page
    // load.
    const events_for_hydrate = capEventsByExchangeWindow(
      events,
      MAX_HYDRATED_EXCHANGES,
    );

    const seed = seedSnapshotConversation(taskId, events_for_hydrate);
    const all = seed.wireEvents;

    // Single-shot hydration. Chunked setState calls compete with the
    // user's beginExchange setState (typing a follow-up): each chunk
    // produces a new conversation reference, ChatArea re-renders, and
    // the user-typed optimistic exchange's commit is delayed. With
    // cap=30 exchanges the event total is bounded (~thousands worst-
    // case, not hundreds-of-thousands), so applying everything in one
    // setState is fast enough (under ~100ms) and frees main thread
    // immediately afterwards.
    set((state) => {
      const existing = state.conversations[taskId];
      const projected = applyEvents(seed.conversation, all);

      // Brand-new task safety net: the FIRST snapshot for a just-
      // created task arrives BEFORE any live events have been emitted,
      // so `projected.exchanges` is empty. The merge path below would
      // then collapse to `[...[], ...extraLocals]` and the
      // `extraLocals` filter only keeps `local_*` ids — but
      // bindRequestId already rewrote the optimistic exchange's id to
      // the real requestId. Net effect: the user's just-typed bubble
      // disappears for 1-2s until the first live event lands and
      // rebuilds the exchange. Symptom reported as "content
      // shows briefly then vanishes then reappears". Treat an empty
      // snapshot over a non-empty local conversation as a no-op —
      // the next live event will populate things correctly. This is
      // also the right call for "snapshot trimmed to zero" edge
      // cases (transient reconnects, server-side purges) where
      // wiping local optimistic state is worse than keeping it.
      if (
        existing
        && existing.exchanges.length > 0
        && projected.exchanges.length === 0
      ) {
        return state;
      }

      // Merge: preserve user prompts from local optimistic exchanges
      // that the snapshot can't reconstruct. Match by id (after
      // bindRequestId has rewritten the optimistic id, both sides
      // share the requestId).
      if (existing && existing.exchanges.length > 0) {
        const merged: Exchange[] = projected.exchanges.map((projectedEx) => {
          const local = existing.exchanges.find((le) => le.id === projectedEx.id);
          if (local && !projectedEx.user.content) {
            return { ...projectedEx, user: local.user };
          }
          return projectedEx;
        });
        const projectedIds = new Set(projected.exchanges.map((e) => e.id));
        // Carry forward optimistic exchanges that the snapshot cannot
        // know about yet. There are two race shapes:
        //   - unbound: id still has the `local_` nonce shape because
        //     bindRequestId has not rewritten it to a real requestId.
        //   - bound-but-unacknowledged: POST /tasks returned and
        //     bindRequestId rewrote the id, but the reconnect snapshot
        //     was read just before any event for that requestId landed.
        //     These still have lastAppliedSeq=0.
        //
        // Bound exchanges that already saw server events
        // (lastAppliedSeq>0) and were dropped by the new snapshot
        // window cap MUST NOT be re-appended — that's how older turns
        // were ending up at the bottom of the chat after an SSE
        // reconnect (snapshot redelivered, cap had shifted forward,
        // dropped turn got pushed past the latest one and ChatArea's
        // tail-window picked it up as "most recent").
        // "the bottom content suddenly becomes a previous message
        // again." Optimistic locals are still kept so the user's
        // just-typed bubble survives a transient reconnect.
        const extraLocals = existing.exchanges.filter(
          (le) => !projectedIds.has(le.id) && (le.id.startsWith("local_") || le.lastAppliedSeq === 0),
        );
        // Dispose buffers on any pre-hydration exchanges that get
        // replaced by snapshot data — they're stale.
        for (const oldEx of existing.exchanges) {
          if (projectedIds.has(oldEx.id)) {
            disposePartBuffers(oldEx.response.parts);
          }
        }
        // Also dispose buffers for windowed-out exchanges we're
        // dropping entirely — otherwise their TextBuffer subscribers
        // leak across re-hydrations.
        const keptIds = new Set([
          ...projectedIds,
          ...extraLocals.map((e) => e.id),
        ]);
        for (const oldEx of existing.exchanges) {
          if (!keptIds.has(oldEx.id)) {
            disposePartBuffers(oldEx.response.parts);
          }
        }
        return {
          conversations: {
            ...state.conversations,
            [taskId]: {
              taskId,
              exchanges: [...merged, ...extraLocals],
            },
          },
        };
      }

      return {
        conversations: {
          ...state.conversations,
          [taskId]: projected,
        },
      };
    });
  },

  hydrateAttachments: (taskId, attachments) => {
    if (!attachments || attachments.length === 0) return;
    // Group by requestId — null requestIds (legacy uploads
    // pre-mailbox-migration) are silently dropped since we have
    // no way to associate them with an exchange.
    const byRequest = new Map<string, Array<{ filename: string; mimeType: string; sizeBytes: number }>>();
    for (const a of attachments) {
      if (!a.requestId) continue;
      const list = byRequest.get(a.requestId) ?? [];
      list.push({ filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes });
      byRequest.set(a.requestId, list);
    }
    if (byRequest.size === 0) return;

    set((state) => {
      const conv = state.conversations[taskId];
      if (!conv) return state;
      let touched = false;
      const nextExchanges = conv.exchanges.map((ex) => {
        const list = byRequest.get(ex.id);
        if (!list) return ex;
        // Idempotency: if user.attachments already has the same
        // filenames in the same order, skip — avoids unnecessary
        // re-renders on duplicate hydrate calls.
        const existing = ex.user.attachments;
        if (
          existing
          && existing.length === list.length
          && existing.every((e, i) => e.filename === list[i]!.filename)
        ) {
          return ex;
        }
        touched = true;
        return { ...ex, user: { ...ex.user, attachments: list } };
      });
      if (!touched) return state;
      return {
        conversations: {
          ...state.conversations,
          [taskId]: { ...conv, exchanges: nextExchanges },
        },
      };
    });
  },

  pendingExchangeId: (taskId) => {
    const conv = get().conversations[taskId];
    if (!conv) return null;
    for (let i = conv.exchanges.length - 1; i >= 0; i--) {
      const ex = conv.exchanges[i]!;
      if (ex.status !== "complete" && ex.status !== "failed") return ex.id;
    }
    return null;
  },

  hasModernEvents: (taskId) => {
    // True iff at least one exchange has applied a real server event
    // (lastAppliedSeq > 0). A pure-optimistic exchange from beginExchange
    // — pending bind, no events yet — does NOT count, so the
    // legacy-fallback render keeps showing pre-PR-1 history when the user
    // types a follow-up on a legacy task and SSE hasn't responded yet.
    const conv = get().conversations[taskId];
    if (!conv) return false;
    return conv.exchanges.some((ex) => ex.lastAppliedSeq > 0);
  },

  forceCompleteTask: (taskId) => {
    set((state) => {
      const conv = state.conversations[taskId];
      if (!conv) return state;
      let touched = false;
      const nextExchanges = conv.exchanges.map((ex) => {
        if (ex.status === "complete" || ex.status === "failed") return ex;
        touched = true;
        return { ...ex, status: "complete" as const };
      });
      if (!touched) return state;
      return {
        conversations: {
          ...state.conversations,
          [taskId]: { ...conv, exchanges: nextExchanges },
        },
      };
    });
  },

  clearExchanges: (conversationKey) => {
    set((state) => {
      const existing = state.conversations[conversationKey];
      if (!existing) return state;
      // Dispose TextBuffer instances to prevent leaks.
      for (const ex of existing.exchanges) {
        disposePartBuffers(ex.response.parts);
      }
      return {
        conversations: {
          ...state.conversations,
          [conversationKey]: { ...existing, exchanges: [] },
        },
      };
    });
  },

  pushLocalDiagnostic: (conversationKey, userText, systemPart) => {
    const id = localExchangeId();
    const key = conversationKey ?? `_pending:${id}`;
    const now = Date.now();
    set((state) => {
      const existing =
        state.conversations[key] ?? { taskId: key, exchanges: [] };
      // Synthetic "complete" exchange: user bubble shows the slash
      // command the user typed, response is just the SystemPart with
      // the inline report. lastAppliedSeq stays at 0 — there's no
      // backend event stream to coordinate with — so legacy-fallback
      // gating via `hasModernEvents` is unaffected (it requires
      // lastAppliedSeq > 0, which a local diagnostic never has).
      const exchange: Exchange = {
        id,
        status: "complete",
        user: { content: userText },
        response: { parts: [systemPart] },
        timing: {
          startedAtMs: now,
          completedAtMs: now,
          wallMs: 0,
          pausedMs: 0,
          elapsedMs: 0,
        },
        lastAppliedSeq: 0,
      };
      return {
        conversations: {
          ...state.conversations,
          [key]: { ...existing, exchanges: [...existing.exchanges, exchange] },
        },
      };
    });
  },

  resetForTests: () => {
    nonceCounter = 0;
    pendingNestedDeltas.clear();
    nestedFlushScheduled = false;
    fastPathSeqWatermark.clear();
    set({ conversations: {} });
  },
}));

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  return [...arr.slice(0, idx), value, ...arr.slice(idx + 1)];
}

function dedupAppend(arr: string[] | undefined, value: string): string[] {
  if (!arr || arr.length === 0) return [value];
  return arr.includes(value) ? arr : [...arr, value];
}

function disposePartBuffers(parts: ResponsePart[]): void {
  for (const p of parts) {
    if ((p.kind === "text" || p.kind === "thinking") && p.buffer) {
      try { p.buffer.dispose(); } catch { /* swallow */ }
    }
    // Codex round-3 [C4] / recurse into a
    // ToolPart's transcript so nested teammate text buffers also
    // get disposed when the parent exchange / conversation tears
    // down. Without this, every spawned teammate leaks one
    // TextBuffer per text segment for the lifetime of the page.
    if (p.kind === "tool" && p.transcript && p.transcript.length > 0) {
      disposePartBuffers(p.transcript);
    }
  }
}

/**
 * Fast path for the 2nd..Nth leader (depth 0) text_delta of a segment.
 *
 * Returns `true` IFF the delta was fully handled by feeding the active
 * text part's buffer — meaning the caller must NOT commit a new
 * `conversations` reference (the whole point: no per-token re-render).
 *
 * Conditions to take the fast path (all must hold):
 *  - the target exchange exists, and
 *  - its LAST response part is an unsealed text part that ALREADY owns a
 *    buffer (i.e. the first delta has already created+seeded it), and
 *  - the event is not a stale re-delivery (`seq > lastAppliedSeq`) — this
 *    preserves event-level dedup for the buffer just like the projector
 *    does for `content`.
 *
 * Returns `false` for the first delta of a part (no part / no buffer yet)
 * and for any out-of-shape case, so the caller runs the normal
 * projector+commit path (which creates the part and attaches the buffer).
 *
 * The buffer mutation is safe to perform outside `set()`: TextBuffer is a
 * non-React animator with its own internal mutable state, observed only
 * through useSyncExternalStore. Its reference is unchanged.
 */
function tryFastAppendLeaderDelta(taskId: string, event: WireEvent): boolean {
  const conv = useChatStore.getState().conversations[taskId];
  if (!conv) return false;
  const ex = conv.exchanges.find((e) => e.id === event.requestId);
  if (!ex) return false;

  // FE1 fix: use a SEPARATE fast-path watermark instead of ex.lastAppliedSeq.
  //
  // Previously, this function mutated ex.lastAppliedSeq in place to prevent
  // re-delivery of leader text_delta events. That contaminated the exchange-
  // level dedup used by the projector for ALL event types: when a queued
  // nested/thinking delta (seq=N) was flushed after a leader text_delta
  // (seq=M, M>N) had already advanced lastAppliedSeq to M, the projector
  // saw N <= M and silently dropped the queued event — causing teammate
  // transcripts and thinking content to go missing (FE1).
  //
  // Fix: maintain a separate per-exchange watermark in fastPathSeqWatermark
  // (keyed by "taskId:requestId"). This allows the fast path to deduplicate
  // re-delivered text_delta events without affecting lastAppliedSeq, which
  // the projector uses as the global dedup watermark for ALL events on the
  // exchange. The two watermarks now advance independently:
  //   - fastPathSeqWatermark: only text_deltas handled by this fast path
  //   - ex.lastAppliedSeq: only events that went through the projector commit
  const fpKey = `${taskId}:${event.requestId}`;
  const fpWatermark = fastPathSeqWatermark.get(fpKey) ?? 0;

  // Stale re-delivery guard (using the fast-path-only watermark, NOT
  // ex.lastAppliedSeq — that would corrupt nested/thinking dedup).
  if (event.seq <= fpWatermark) return true; // consumed (dropped), no commit

  // Also check the projector watermark: if the projector has already
  // applied this seq (e.g. via a full commit on reconnect), skip it too.
  if (event.seq <= ex.lastAppliedSeq) return true;

  const parts = ex.response.parts;
  const last = parts[parts.length - 1];
  if (!last || last.kind !== "text" || last.sealed || !last.buffer) return false;
  const text = typeof event.data.text === "string" ? event.data.text : "";
  if (!text) {
    // Advance watermark even for empty text so re-deliveries are still dropped.
    if (event.seq > fpWatermark) fastPathSeqWatermark.set(fpKey, event.seq);
    return true; // nothing to append; still no commit needed
  }
  last.buffer.appendDelta(text);
  // Advance the fast-path-only watermark. Monotonic: only ever forward.
  if (event.seq > fpWatermark) fastPathSeqWatermark.set(fpKey, event.seq);
  return true;
}

/**
 * After the pure projector produces a new Conversation, this helper
 * dispatches all TextBuffer side-effects:
 *  - For a freshly-opened text part (no buffer yet), create one and
 *    seed with the part's current content (so a mid-stream snapshot
 *    paints immediately rather than typing-out a second time).
 *  - For an existing buffer on an unsealed text part, append just the
 *    delta string from this event (the projector has already extended
 *    the part's `content`; we make the visible buffer catch up).
 *  - For a sealed text part with a stale buffer ref, dispose it and
 *    blank the field. (The projector sets `buffer: null` on seal but a
 *    pre-seal buffer attached by chatStore needs explicit cleanup.)
 *
 * Returns either the input conversation unchanged (no buffer-side
 * mutation needed) OR a copy with the active part's buffer field
 * updated.
 *
 * IMPORTANT (spec §3.5): we never mutate the buffer reference under a
 * live `useSyncExternalStore` subscription — once a part has a buffer,
 * that buffer instance lives until the part is sealed.
 */
function ensureTextBuffers(conv: Conversation, event: WireEvent): Conversation {
  const exchangeIdx = conv.exchanges.findIndex((e) => e.id === event.requestId);
  if (exchangeIdx < 0) return conv;
  const ex = conv.exchanges[exchangeIdx]!;

  // depth>0 events route INTO a teammate
  // ToolPart's transcript (codex round-1 [M] B2 fix). The streaming
  // text part lives nested in `toolPart.transcript[]`, not in
  // `exchange.response.parts[]`. Without this branch, teammate
  // streaming text never gets a TextBuffer attached → typewriter
  // smoothing breaks AND the buffer is never disposed.
  if (event.agent && event.agent.depth > 0 && event.agent.parentToolUseId) {
    return ensureNestedTeammateTextBuffer(conv, event, exchangeIdx, ex);
  }

  const parts = ex.response.parts;
  if (parts.length === 0) return conv;

  const lastIdx = parts.length - 1;
  const last = parts[lastIdx];
  // Active unsealed text part — attach (lazy) or append (existing).
  // Only the LAST part can be the live streaming segment, and only text
  // parts run through the TextBuffer animator (thinking parts render
  // part.content directly — see render.tsx ThinkingBlock; skipping a
  // buffer for thinking also saves the wasted RAF loop).
  if (last && last.kind === "text" && !last.sealed) {
    if (!last.buffer) {
      const buffer = new TextBuffer();
      buffer.seed(last.content);
      return replaceLastTextPart(conv, exchangeIdx, ex, parts, lastIdx, { ...last, buffer });
    }
    // Buffer exists. If this event is the matching stream delta, push
    // just the delta (the projector already updated last.content; we
    // ensure the visible buffer catches up). Note: with the fast path
    // in applyWireEvent, 2nd..Nth leader text deltas no longer reach
    // here — this remains for the first-delta-with-buffer and replay
    // paths.
    if (event.type === "leader.stream_delta") {
      const inner = event.data;
      const innerKind = typeof inner.type === "string" ? inner.type : "";
      const text = typeof inner.text === "string" ? inner.text : "";
      if (innerKind === "text_delta" && text) last.buffer.appendDelta(text);
    }
    return conv;
  }

  // No active streaming text part (last is a tool / thinking / sealed
  // part). Reconcile EVERY sealed text part that still owns a live
  // buffer — not just `last`. A tool boundary seals the text part AND
  // appends the tool part in the SAME projector pass; in particular a
  // bare `leader.tool_call` with no preceding `tool_use_start` leaves
  // the sealed text part BEFORE the last index. Scanning only `last`
  // would strand its buffer: `content` truncated to the first delta (the
  // rest lives only in the buffer, since 2nd..Nth deltas take the fast
  // path and bypass content accumulation) and the RAF animator leaks.
  return reconcileSealedTextBuffers(conv, exchangeIdx, ex, parts);
}

/**
 * Backfill canonical `content` from the buffer's full text and dispose
 * the buffer for ALL sealed text parts that still own a live buffer —
 * anywhere in the parts list, not only the last (see ensureTextBuffers
 * for why non-last sealed text parts occur). Defensively keeps the
 * longer of buffer-full-text vs accumulated content so a path that DID
 * accumulate (snapshot replay) is never truncated. Returns the SAME
 * conversation reference when nothing needed reconciling, preserving
 * identity for the common no-op case (no spurious re-render).
 */
function reconcileSealedTextBuffers(
  conv: Conversation,
  exchangeIdx: number,
  ex: Exchange,
  parts: ResponsePart[],
): Conversation {
  let changed = false;
  const newParts = parts.map((p) => {
    if (p.kind === "text" && p.sealed && p.buffer) {
      const full = p.buffer.getFullText();
      const content = full.length >= p.content.length ? full : p.content;
      try { p.buffer.dispose(); } catch { /* swallow */ }
      changed = true;
      return { ...p, content, buffer: null };
    }
    return p;
  });
  if (!changed) return conv;
  const updatedExchange: Exchange = { ...ex, response: { parts: newParts } };
  return {
    ...conv,
    exchanges: replaceAt(conv.exchanges, exchangeIdx, updatedExchange),
  };
}

function replaceLastTextPart(
  conv: Conversation,
  exchangeIdx: number,
  ex: Exchange,
  parts: ResponsePart[],
  lastIdx: number,
  replacement: TextPart,
): Conversation {
  const newParts = [...parts.slice(0, lastIdx), replacement];
  const updatedExchange: Exchange = { ...ex, response: { parts: newParts } };
  return {
    ...conv,
    exchanges: replaceAt(conv.exchanges, exchangeIdx, updatedExchange),
  };
}

/**
 * attach a TextBuffer to the latest text
 * part inside a teammate's nested transcript when a depth>0 stream
 * delta arrives. Mirrors the top-level path but operates one level
 * deeper inside the matching ToolPart.transcript[]. Without this,
 * teammate-streamed text never gets a buffer (codex round-1 [M] B2).
 */
function ensureNestedTeammateTextBuffer(
  conv: Conversation,
  event: WireEvent,
  exchangeIdx: number,
  ex: Exchange,
): Conversation {
  const parentToolUseId = event.agent?.parentToolUseId;
  if (!parentToolUseId) return conv;
  const toolIdx = ex.response.parts.findIndex(
    (p) => p.kind === "tool" && p.toolUseId === parentToolUseId,
  );
  if (toolIdx < 0) return conv;
  const toolPart = ex.response.parts[toolIdx]!;
  if (toolPart.kind !== "tool") return conv;
  const transcript = toolPart.transcript;
  if (!transcript || transcript.length === 0) return conv;

  const lastIdx = transcript.length - 1;
  const last = transcript[lastIdx];
  if (!last || last.kind !== "text") return conv;

  // Active unsealed text part — attach (lazy) or append delta.
  if (!last.sealed) {
    if (!last.buffer) {
      const buffer = new TextBuffer();
      buffer.seed(last.content);
      return replaceTranscriptTextPart(
        conv, exchangeIdx, ex, toolIdx, toolPart, transcript, lastIdx,
        { ...last, buffer },
      );
    }
    if (event.type === "leader.stream_delta") {
      const inner = event.data;
      const innerKind = typeof inner.type === "string" ? inner.type : "";
      const text = typeof inner.text === "string" ? inner.text : "";
      if (innerKind === "text_delta" && text) last.buffer.appendDelta(text);
    }
    return conv;
  }

  // Sealed but stale buffer — dispose. Prevents leak when a teammate's
  // streaming text part is sealed (e.g. on tool boundary or completion).
  if (last.sealed && last.buffer) {
    try { last.buffer.dispose(); } catch { /* swallow */ }
    return replaceTranscriptTextPart(
      conv, exchangeIdx, ex, toolIdx, toolPart, transcript, lastIdx,
      { ...last, buffer: null },
    );
  }
  return conv;
}

function replaceTranscriptTextPart(
  conv: Conversation,
  exchangeIdx: number,
  ex: Exchange,
  toolIdx: number,
  toolPart: import("../components/chat/conversation/types").ToolPart,
  transcript: ResponsePart[],
  lastIdx: number,
  replacement: TextPart,
): Conversation {
  const newTranscript = [...transcript.slice(0, lastIdx), replacement];
  const newToolPart = { ...toolPart, transcript: newTranscript };
  const newParts = ex.response.parts.slice();
  newParts[toolIdx] = newToolPart;
  const updatedExchange: Exchange = { ...ex, response: { parts: newParts } };
  return {
    ...conv,
    exchanges: replaceAt(conv.exchanges, exchangeIdx, updatedExchange),
  };
}

// ──────────────────────────────────────────────────────────────────
// Convenience wire-format adapter
// ──────────────────────────────────────────────────────────────────

/**
 * Wrap a parsed SSE event payload into a `WireEvent`. The SSE handler
 * should call this once per `MessageEvent` and feed the result into
 * `useChatStore.getState().applyWireEvent(taskId, ...)`.
 *
 * Returns null if the payload is malformed (missing requestId/seq) —
 * callers drop those silently.
 */
export function parseWireEvent(
  type: string,
  rawData: unknown,
): WireEvent | null {
  if (!rawData || typeof rawData !== "object") return null;
  const data = rawData as Record<string, unknown>;
  const requestId = typeof data.requestId === "string" ? data.requestId : null;
  if (!requestId) return null;
  const seq = typeof data.seq === "number" ? data.seq : null;
  if (seq == null) return null;
  const innerData = (data.data && typeof data.data === "object")
    ? (data.data as Record<string, unknown>)
    : data;
  // backend stamps every broadcast with an `agent`
  // envelope (post-Step-0a). Preserve it through into the WireEvent so
  // the projector can route depth>0 events into TeammateTranscript
  // sub-trees. parseWireEvent used to silently drop this — that was
  // the proximate cause of teammate transcripts flooding the main
  // chat panel.
  const agent = (data.agent && typeof data.agent === "object")
    ? (data.agent as WireEvent["agent"])
    : undefined;
  return {
    type,
    requestId,
    seq,
    ...(typeof data.timestamp === "string" ? { timestamp: data.timestamp } : {}),
    data: innerData,
    ...(agent ? { agent } : {}),
  };
}

// Re-export so callers don't have to import from two paths.
export { applyEvents };
