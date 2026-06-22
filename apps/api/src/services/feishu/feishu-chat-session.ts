import { randomUUID } from "node:crypto";

import {
  buildFinalCard,
  buildSingleTurnCardInitial,
  formatToolArgsInline,
  formatToolResult,
  renderAnswerBody,
  renderToolsBody,
  toolIcon,
  ANSWER_ELEMENT,
  TOOLS_BODY_ELEMENT,
  type ToolLine,
  type MediaItem,
  type TurnState,
} from "../../integrations/feishu/feishu-cards";
import {
  createFeishuClient,
  FEISHU_SEQUENCE_CONFLICT_CODE,
  type FeishuClient,
} from "../../integrations/feishu/feishu-client";
import { parseFeishuConfigFromEnv } from "../../integrations/feishu/feishu-config";
import { getMagisterEnv } from "../../lib/env";
import {
  enqueue,
  feishuChatKey,
} from "../../integrations/feishu/sequential-queue";
import { taskEventBus, type TaskSSEEvent } from "../../sse/task-event-bus";

/**
 * FeishuChatSession — one instance per user prompt (per requestId).
 *
 * Replaces the old projector + streaming-card module pair. The audit
 * identified five CRITICAL bugs in the previous design:
 *   1. resolveVerboseLevel discarded `off`/`low`/`high` — fixed in
 *      channel-session-service.ts
 *   2. Projector keyed on taskId, so resume turns shared a session —
 *      THIS module fixes by keying on requestId
 *   3. `task:completed` event never fired from sync Feishu — sync
 *      execution now publishes via taskEventBus directly (see
 *      process-task-intent-service.ts wiring)
 *   4. Module-level ACTIVE_CARDS map outlived sessions and threw on
 *      late events — THIS module owns its card id, no shared state
 *   5. resolveVerboseLevel cascade also broke the duplicate-reply
 *      suppression gate
 *
 * Lifecycle:
 *   constructor() — sets up state, subscribes to taskEventBus
 *   first event → lazy `ensureCard()` (locked by Promise so 10
 *     concurrent events still produce ONE card)
 *   each event → mutate state, throttled PATCH to single content
 *     element
 *   terminal event OR explicit close() → settings PATCH disables
 *     streaming_mode, unsubscribes, releases
 *
 * Single instance owned by a registry keyed on requestId. Caller
 * creates via `feishuChatSessionRegistry.start(...)`. Disposal is
 * automatic on terminal events; caller can force via `abort(reason)`.
 */

// Split flush cadences (Codex S3). The ~10 updates/sec Feishu cap is now
// SHARED by the answer + tools elements on a single card. The answer
// stays snappy; tool rows coalesce on a slower beat so a tool-heavy
// turn doesn't starve the answer of the shared rate budget.
const ANSWER_FLUSH_MS = 120;
const TOOLS_FLUSH_MS = 500;
// Per-card token bucket (Codex S3): both elements draw PATCHes from one
// ~10/s budget so a 100ms window can't fire answer + tools_body and blow
// past Feishu's per-card rate ceiling. The sequential-queue only orders;
// it does NOT rate-limit.
const CARD_PATCH_RATE_PER_SEC = 10;
const CARD_PATCH_BURST = 10;
const SESSION_TTL_MS = 30 * 60_000; // close after 30 min idle

/**
 * Classic refill token bucket. `tryTake()` returns true and consumes a
 * token when one is available, false otherwise (caller reschedules).
 * Time source is injectable for deterministic tests.
 */
export class TokenBucket {
  private readonly ratePerSec: number;
  private readonly capacity: number;
  private readonly nowMs: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: { ratePerSec: number; capacity: number; nowMs?: () => number }) {
    this.ratePerSec = opts.ratePerSec;
    this.capacity = opts.capacity;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.tokens = opts.capacity;
    this.lastRefillMs = this.nowMs();
  }

  private refill(): void {
    const now = this.nowMs();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = now;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until at least one token is available. */
  msUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.ratePerSec) * 1000);
  }
}

/**
 * The single media row this finalizer needs. A structural subset of
 * `TaskMediaSelect` (storage_path / kind / filename / caption) so tests
 * can inject a fake without dragging in the full schema type.
 */
export type TurnMediaRow = {
  kind: string;
  filename: string;
  storagePath: string;
  caption?: string | null;
};

/**
 * Injected media dependencies. Production wires the real
 * `TaskMediaRepository` + an fs byte reader; tests pass fakes so the
 * finalize path is exercised with NO mock.module (which has leaked
 * across files in this repo).
 */
export type SessionMediaRepo = {
  listByTaskIdAndRequestId(taskId: string, requestId: string): Promise<TurnMediaRow[]>;
};

export type SessionConfig = {
  requestId: string;
  taskId: string;
  bindingId: string;
  chatId: string;
  verboseLevel: "off" | "low" | "high";
  client: FeishuClient;
  /** Defaults to a real `TaskMediaRepository`. */
  mediaRepo?: SessionMediaRepo;
  /** Reads a stored media file's bytes. Defaults to `fs.readFile`. */
  readMediaBytes?: (storagePath: string) => Promise<Buffer>;
};

/**
 * A PATCH operation in flight or pending retry. Carries the frozen
 * sequence + uuid so a network-layer retry re-sends the IDENTICAL
 * request (Feishu treats same sequence+uuid as idempotent), keeping the
 * per-card sequence gap-free (Codex S4).
 */
type PatchOp = {
  elementId: string;
  content: string;
  sequence: number;
  uuid: string;
};

export class FeishuChatSession {
  private readonly requestId: string;
  private readonly taskId: string;
  private readonly bindingId: string;
  private readonly chatId: string;
  private readonly verboseLevel: "off" | "low" | "high";
  private readonly client: FeishuClient;
  private readonly mediaRepo: SessionMediaRepo | undefined;
  private readonly readMediaBytes: ((storagePath: string) => Promise<Buffer>) | undefined;
  private readonly createdAtMs: number = Date.now();

  // Card state
  // TODO(feishu-card-crash-recovery): Codex P2 (DEFERRED, out of scope
  // here) — card state lives only in-memory. A process crash mid-stream
  // leaves an orphaned "⏳ Thinking…" card with streaming_mode:true that
  // never finalizes. Follow-up: durably persist (cardId, sequence,
  // requestId, taskId) and add a startup recovery pass that finalizes or
  // re-attaches open streaming cards.
  private cardId: string | null = null;
  private cardCreationPromise: Promise<void> | null = null;
  // True only after createCard + sendCardRef both succeeded. The
  // notification-card fallback gate (process-channel-event-service.ts +
  // deliverAsyncFeishuFinalAnswer) consults this to decide whether the
  // user actually saw the streaming card — if not, fall back to the
  // legacy notification card so they aren't left empty-handed.
  private cardDelivered = false;
  // Feishu's createCard reserves sequence=1 internally for the initial
  // card body; the first PATCH must be sequence >= 2 or Feishu rejects
  // it with "sequence number compare failed" and the card stays on
  // the initial "⏳ Thinking…" body forever.
  private sequence = 1;
  // Per-element last-rendered content. A flush PATCHes an element only
  // when its freshly-rendered snapshot differs from what we last sent
  // for THAT element. Tracked separately so answer and tools_body
  // advance independently and a failure on one doesn't stall the other.
  private renderedAnswer: string | null = null;
  private renderedTools: string | null = null;
  // Separate debounce timers so the answer (snappy) and tools_body
  // (coalesced) can flush on different cadences. Both ultimately draw
  // from the shared per-card token bucket before PATCHing.
  private answerFlushTimer: NodeJS.Timeout | null = null;
  private toolsFlushTimer: NodeJS.Timeout | null = null;
  // Per-element in-flight guard — prevents two concurrent PATCHes to the
  // same element (which would race their sequence numbers).
  private answerInFlight = false;
  private toolsInFlight = false;
  // S4 retry bookkeeping: when a PATCH fails at the NETWORK layer we
  // retry with the SAME sequence + uuid (idempotent re-send). The
  // pending op is parked here per element until it succeeds, so the
  // shared sequence counter never advances past an unsettled op (no
  // gap a later terminal updateCard would have to cross).
  private pendingAnswerOp: PatchOp | null = null;
  private pendingToolsOp: PatchOp | null = null;
  // Per-card shared rate limiter (Codex S3) — answer + tools_body draw
  // PATCH grants from this single ~10/s bucket.
  private readonly patchBucket = new TokenBucket({
    ratePerSec: CARD_PATCH_RATE_PER_SEC,
    capacity: CARD_PATCH_BURST,
  });

  // Turn state. Tool activity now accumulates into the collapsible
  // panel (tools_body element) instead of standalone chat messages.
  private answer = "";
  private readonly toolLines: ToolLine[] = [];
  private readonly toolSeen = new Set<string>();
  private mediaItems: MediaItem[] = [];
  // True once a `leader.media_sent` event for THIS turn arrived. The
  // terminal path (close) then resolves this turn's media rows and
  // rebuilds the full card via updateCard. v1: media is inlined ONLY at
  // finalize (full-card rebuild) — NOT streamed mid-turn. Mid-stream
  // add_element insertion is a later optional task (plan Task 7 / S7).
  private hasMediaThisTurn = false;

  // Subscription / lifecycle
  private unsubscribe: () => void = () => {};
  private closed = false;
  private disposeCallback: (() => void) | undefined;

  constructor(config: SessionConfig, onDispose?: () => void) {
    this.requestId = config.requestId;
    this.taskId = config.taskId;
    this.bindingId = config.bindingId;
    this.chatId = config.chatId;
    this.verboseLevel = config.verboseLevel;
    this.client = config.client;
    this.mediaRepo = config.mediaRepo;
    this.readMediaBytes = config.readMediaBytes;
    if (onDispose !== undefined) {
      this.disposeCallback = onDispose;
    }

    // Subscribe per-task. Multiple sessions for the same task (parallel
    // tool branches? rare but possible) each get their own listener
    // and run independently. requestId-level filtering happens inside
    // the handler — we drop events not matching our request.
    const subscribe = taskEventBus.subscribe(config.taskId, (event) => {
      void this.handleEvent(event);
    });
    this.unsubscribe = subscribe;
  }

  /**
   * Lazy card creation. Locked so N concurrent events that all see
   * `cardId === null` share the same `createCard` HTTP call instead
   * of spawning N duplicate cards (the "duplicate thinking-cards"
   * bug). Idempotent — second call returns immediately or awaits the
   * in-flight promise.
   */
  /**
   * Eager card creation, fired by the registry the moment a session
   * starts — before any leader event arrives. This is what makes the
   * single card the *immediate* and *only* outbound acknowledgement:
   * the user sees a "⏳ Thinking…" card right away, which then streams
   * in place. It replaces the old separate "已收到 / 正在处理" ack text
   * + OnIt reaction + processing-notification card (Task 8 / S9). Errors
   * are swallowed here — the lazy `ensureCard()` on the first event (and
   * the notification-card fallback gated on `markRequestDelivered`) still
   * covers the case where this eager attempt failed.
   */
  ensureCardEager(): void {
    void this.ensureCard().catch(() => {
      /* swallowed — lazy ensureCard on first event retries */
    });
  }

  private async ensureCard(): Promise<void> {
    if (this.closed) return;
    if (this.cardId) return;
    if (this.cardCreationPromise) {
      await this.cardCreationPromise;
      return;
    }
    this.cardCreationPromise = (async () => {
      try {
        const { cardId } = await this.client.createCard({
          cardJson: buildSingleTurnCardInitial({
            title: "🧠 Leader",
            summary: "[Working…]",
          }),
          idempotencyKey: `magister-${this.requestId}-${randomUUID()}`,
        });
        // If close() arrived while createCard was in-flight, abandon
        // the card — don't set cardId, don't sendCardRef. Otherwise
        // close() would have skipped finalization (cardId was null at
        // the time) and we'd publish a still-"⏳ Thinking…" card.
        if (this.closed) return;
        this.cardId = cardId;
        // Send the card-ref message so the user actually sees the card.
        // Through the per-chat queue so it interleaves cleanly with
        // any concurrent sends from other code paths.
        await enqueue(feishuChatKey(this.bindingId), () =>
          this.client.sendCardRef({ chatId: this.chatId, cardId }),
        );
        // Mark "card was actually delivered" — the notification-card
        // fallback gate checks this to decide whether the legacy
        // notification path needs to fire (when createCard or
        // sendCardRef failed, we leave the marker unset so the user
        // still receives the answer some other way).
        this.cardDelivered = true;
        feishuChatSessionRegistry.markRequestDelivered(this.requestId);
        // Settle the card-decision (delivered) so the text fallback —
        // which awaits awaitCardDecision() before reading
        // hasDeliveredCardFor() — now reads the gate as TRUE and skips the
        // duplicate plain-text send (Codex P0).
        feishuChatSessionRegistry.settleCardDecision(this.requestId);
      } catch (err) {
        // Settle the card-decision (abandoned/failed) WITHOUT marking
        // delivered — the fallback awaits this, then reads
        // hasDeliveredCardFor() as FALSE and proceeds with ONE text
        // message so the user isn't left empty-handed (Codex P0).
        feishuChatSessionRegistry.settleCardDecision(this.requestId);
        // eslint-disable-next-line no-console
        console.error(
          `[feishu-session ${this.shortId()}] ensureCard failed:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        this.cardCreationPromise = null;
      }
    })();
    await this.cardCreationPromise;
  }

  /**
   * Main event handler. Dispatches by event.type. Verbose-level filter
   * applied per-event so "off" simply ignores everything (and the
   * registry shouldn't have created us in that case anyway). All
   * mutations funnel into `scheduleFlush()` which debounces the PATCH.
   */
  private async handleEvent(event: TaskSSEEvent): Promise<void> {
    if (this.closed) return;
    if (this.verboseLevel === "off") return;
    // Filter by requestId — the bus subscribes per-taskId, but resume
    // turns share a taskId and would otherwise cross-pollute. Latent
    // today (sync path is serial) but a real correctness landmine for
    // any future concurrent path.
    if (event.requestId && event.requestId !== this.requestId) return;

    try {
      // Terminal events: ONLY task-level (task:completed / task:failed /
      // task:cancelled). Do NOT close on `message_complete` or
      // `leader.session_complete` — those fire PER TURN, not per task.
      // Closing on them truncates multi-turn runs because text_delta
      // events from subsequent turns are dropped at the closed guard.
      if (event.type === "task:completed") {
        // AWAITING_TEAMMATES is reported via task:completed (the leader's
        // exchange ended) but the task is still live — keep the Feishu
        // session open. The next turn (woken by teammate completion) will
        // produce more events.
        const state = (event.data as { state?: string } | undefined)?.state;
        if (state === "AWAITING_TEAMMATES") {
          return;
        }
        await this.close("✅ done");
        return;
      }
      if (event.type === "task:failed") {
        const reason = this.extractReason(event);
        await this.close(`❌ failed${reason ? ` · ${reason.slice(0, 120)}` : ""}`);
        return;
      }
      if (event.type === "task:cancelled") {
        await this.close("⏹ cancelled");
        return;
      }

      // Tool call → accumulate a row into the collapsible tools panel
      // (tools_body element). No standalone chat message — the whole
      // turn renders as ONE card. The tools flush runs on its own slower
      // cadence (TOOLS_FLUSH_MS) so tool-heavy turns don't starve the
      // answer of the shared per-card rate budget.
      if (event.type === "leader.tool_call" || event.type === "tool_call") {
        const data = event.data as Record<string, unknown>;
        const toolName = this.readString(data.toolName, data.name, data.tool) ?? "?";
        const args = (data.input ?? data.args ?? {}) as Record<string, unknown>;
        const toolUseId =
          this.readString(data.toolUseId, data.toolCallId) ?? `tool_${this.toolLines.length + 1}`;
        if (this.toolSeen.has(toolUseId)) return;
        this.toolSeen.add(toolUseId);
        this.toolLines.push({
          toolUseId,
          icon: toolIcon(toolName),
          name: toolName,
          argsInline: formatToolArgsInline(toolName, args),
          resultInline: null,
        });
        await this.ensureCard();
        this.scheduleToolsFlush();
        return;
      }

      // Tool result → backfill the result summary onto the matching row
      // (high-verbose only). Renders as a `↳ …` sub-line under the call.
      if (
        (event.type === "leader.tool_result" || event.type === "tool_result") &&
        this.verboseLevel === "high"
      ) {
        const data = event.data as Record<string, unknown>;
        const toolUseId = this.readString(data.toolUseId, data.toolCallId);
        if (!toolUseId) return;
        const line = this.toolLines.find((t) => t.toolUseId === toolUseId);
        if (!line || line.resultInline) return;
        const toolName = this.readString(data.toolName, data.name, data.tool) ?? line.name;
        const rawResult = data.outputSummary ?? data.result ?? data.output;
        const summary = formatToolResult(toolName, rawResult);
        line.resultInline = summary
          ? summary.replace(/\s+/g, " ").trim().slice(0, 240)
          : null;
        this.scheduleToolsFlush();
        return;
      }

      // Outbound media (send_media → leader.media_sent). v1: we only
      // mark that THIS turn produced media; the actual upload + inline
      // happens at finalize (close), rebuilding the full card via
      // updateCard. We do NOT inline mid-stream (S7). The event payload
      // (MediaSentPayload) carries mediaId/kind/filename but NOT the
      // storage path, so the storage bytes are resolved at close() by
      // querying TaskMediaRepository scoped to (taskId, requestId) — so
      // a resumed task that shares a taskId can't pull PRIOR turns'
      // media into this card (S6).
      if (event.type === "leader.media_sent") {
        this.hasMediaThisTurn = true;
        await this.ensureCard();
        return;
      }

      // Text delta → append answer + flush (snappy ANSWER_FLUSH_MS beat)
      if (event.type === "leader.stream_delta") {
        const data = event.data as Record<string, unknown>;
        if (data.type !== "text_delta") return;
        const text = this.readString(data.text, data.delta);
        if (!text) return;
        // Pure delta append. Magister's streaming sources (Anthropic +
        // OpenAI-compat) emit DELTAS (not cumulative snapshots), so a
        // cumulative-merge approach is wrong here — a
        // `previous.includes(next)` branch silently drops a delta
        // whenever the delta happens to be a substring of accumulated
        // text (e.g. the model repeats "独立的" → second mention lost).
        // Simple append — no cumulative-merge (would drop repeated substrings).
        this.answer += text;
        await this.ensureCard();
        this.scheduleAnswerFlush();
        return;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[feishu-session ${this.shortId()}] handleEvent ${event.type} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Schedule a debounced answer flush on the snappy ANSWER_FLUSH_MS beat.
   */
  private scheduleAnswerFlush(): void {
    if (this.answerFlushTimer || this.closed) return;
    this.answerFlushTimer = setTimeout(() => {
      this.answerFlushTimer = null;
      void this.flushElement("answer");
    }, ANSWER_FLUSH_MS);
  }

  /**
   * Schedule a debounced tools_body flush on the slower TOOLS_FLUSH_MS
   * beat so a burst of tool calls coalesces into one PATCH.
   */
  private scheduleToolsFlush(): void {
    if (this.toolsFlushTimer || this.closed) return;
    this.toolsFlushTimer = setTimeout(() => {
      this.toolsFlushTimer = null;
      void this.flushElement("tools");
    }, TOOLS_FLUSH_MS);
  }

  /**
   * Reschedule a flush respecting the shared token bucket — used when
   * the bucket has no token right now (defer just past the refill).
   */
  private deferFlush(which: "answer" | "tools", ms: number): void {
    const delay = Math.max(ms, 5);
    if (which === "answer") {
      if (this.answerFlushTimer || this.closed) return;
      this.answerFlushTimer = setTimeout(() => {
        this.answerFlushTimer = null;
        void this.flushElement("answer");
      }, delay);
    } else {
      if (this.toolsFlushTimer || this.closed) return;
      this.toolsFlushTimer = setTimeout(() => {
        this.toolsFlushTimer = null;
        void this.flushElement("tools");
      }, delay);
    }
  }

  private buildState(): TurnState {
    return { answer: this.answer, tools: this.toolLines, media: this.mediaItems };
  }

  /**
   * Codex P1b — wait (bounded) for a token from the shared per-card
   * bucket, then consume it. The bucket gates ~10 mutations/sec for the
   * WHOLE card; the terminal ops (force flushes + footer + settings +
   * updateCard) MUST draw from it too or a close() can fire ~4 extra
   * mutations in the same 100ms window and blow past Feishu's per-card
   * cap. Bounded so a stuck bucket can't hang close() forever — if the
   * budget never frees up within the cap we proceed anyway (correctness
   * of finalization beats a momentary rate overage at end-of-turn).
   */
  private async acquireToken(maxWaitMs = 2000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (!this.patchBucket.tryTake()) {
      if (Date.now() >= deadline) return;
      const wait = Math.min(this.patchBucket.msUntilNextToken(), deadline - Date.now());
      await new Promise((r) => setTimeout(r, Math.max(wait, 5)));
    }
  }

  /**
   * Codex P1a — single per-card sequence invariant. A new `sequence`
   * must NOT be allocated while ANY prior sequence is still unsettled,
   * across BOTH elements AND the terminal ops. "Unsettled" = a PATCH is
   * in flight on either element, OR a failed PATCH is parked for retry
   * on either element. Allocating ahead of an unsettled op risks a gap:
   * if Feishu never applied seq N (e.g. it failed before server
   * receipt), seq N+1 crosses the gap and Feishu rejects the whole card
   * with code 11402. Holding allocation until the prior op settles keeps
   * the per-card sequence contiguous.
   */
  private hasUnsettledSequence(): boolean {
    return (
      this.answerInFlight ||
      this.toolsInFlight ||
      this.pendingAnswerOp !== null ||
      this.pendingToolsOp !== null
    );
  }

  /**
   * Codex re-review P1 — drive the per-card sequence frontier to a
   * settled state before/after a terminal op. A parked op (prior network
   * failure) still owns its frozen sequence; a terminal partial mutation
   * (footer / settings / updateCard) MUST NOT allocate a higher sequence
   * while that op is unsettled or Feishu rejects the card with 11402 (and
   * the 11402='advance' branch can then mask a genuinely-lost lower
   * update). This re-drives parked ops (force=true, idempotent same-seq
   * re-send) and awaits any in-flight PATCH until `hasUnsettledSequence()`
   * is false OR a bounded attempt budget is exhausted.
   *
   * Returns true if the frontier settled, false if the budget ran out
   * with an op still unsettled (caller must then take the full-card
   * updateCard finalization fallover rather than a partial mutation).
   */
  private async drainSequenceFrontier(): Promise<boolean> {
    const drainStart = Date.now();
    const budgetMs = TOOLS_FLUSH_MS * 4;
    // Minimum spacing between retries of a STILL-failing parked op. Once
    // `closed` is set, deferFlush() no longer schedules its own backoff,
    // so without this the loop would re-drive a persistently-failing op as
    // fast as the event loop allows — thousands of "retry same seq" lines +
    // Feishu API hammering until the wall-clock budget expires. Only sleeps
    // when the op is still parked AFTER the attempt (a clean settle skips it).
    const RETRY_SPACING_MS = 80;
    while (this.hasUnsettledSequence() && Date.now() - drainStart < budgetMs) {
      if (this.pendingAnswerOp && !this.answerInFlight) {
        await this.flushElement("answer", { force: true });
        if (this.pendingAnswerOp) await new Promise((r) => setTimeout(r, RETRY_SPACING_MS));
      } else if (this.pendingToolsOp && !this.toolsInFlight) {
        await this.flushElement("tools", { force: true });
        if (this.pendingToolsOp) await new Promise((r) => setTimeout(r, RETRY_SPACING_MS));
      } else {
        // Only in-flight ops remain — wait for them to land.
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    return !this.hasUnsettledSequence();
  }

  /**
   * Flush a single element (answer or tools_body) to the card.
   *
   * Both elements share the per-card token bucket and the per-card
   * monotonic `sequence`. The sequence is allocated only AFTER a token
   * is granted AND we've confirmed the snapshot actually changed, so an
   * empty/rate-limited cycle never burns a sequence number (Codex S4:
   * no gaps the terminal updateCard would have to cross).
   *
   * Network-layer failures park the op in `pending{Answer,Tools}Op` and
   * retry with the SAME sequence + uuid (idempotent) — the shared
   * counter does NOT advance past an unsettled op.
   */
  private async flushElement(
    which: "answer" | "tools",
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!this.cardId) return;
    if (this.closed && !opts?.force) return;
    if (which === "tools" && this.verboseLevel === "off") return;

    const inFlight = which === "answer" ? this.answerInFlight : this.toolsInFlight;
    if (inFlight) return;

    const elementId = which === "answer" ? ANSWER_ELEMENT : TOOLS_BODY_ELEMENT;
    const pending = which === "answer" ? this.pendingAnswerOp : this.pendingToolsOp;

    // If there's a parked op from a prior network failure, that retry
    // takes priority and re-uses its frozen sequence + uuid.
    let op: PatchOp;
    if (pending) {
      op = pending;
    } else {
      const snapshot =
        which === "answer"
          ? renderAnswerBody(this.buildState())
          : renderToolsBody(this.buildState(), this.verboseLevel);
      const rendered = which === "answer" ? this.renderedAnswer : this.renderedTools;
      if (snapshot === rendered) return; // nothing changed
      // Codex P1a — single per-card sequence invariant. Do NOT allocate a
      // new sequence while ANY prior sequence is unsettled on the OTHER
      // element (in flight or parked-for-retry). The other element's
      // in-flight PATCH owns the current sequence frontier; allocating
      // ahead of it risks a gap if that op fails before Feishu applies
      // it. Defer this flush until the frontier settles.
      if (this.pendingAnswerOp || this.pendingToolsOp || this.answerInFlight || this.toolsInFlight) {
        if (!this.closed) this.deferFlush(which, ANSWER_FLUSH_MS);
        return;
      }
      // Rate gate (shared bucket) BEFORE allocating a sequence so a
      // deferred cycle doesn't burn a number. Codex P1b: close()'s force
      // flush no longer BYPASSES the bucket — it WAITS (bounded) for a
      // token via acquireToken() so terminal mutations still count
      // against the per-card ~10/s cap. Non-force flushes defer as before.
      if (opts?.force) {
        await this.acquireToken();
      } else if (!this.patchBucket.tryTake()) {
        this.deferFlush(which, this.patchBucket.msUntilNextToken());
        return;
      }
      const seq = ++this.sequence;
      op = {
        elementId,
        content: snapshot,
        sequence: seq,
        uuid: `${which === "answer" ? "a" : "t"}_${this.cardId}_${seq}`,
      };
    }

    if (which === "answer") this.answerInFlight = true;
    else this.toolsInFlight = true;

    try {
      await enqueue(feishuChatKey(this.bindingId), () =>
        this.client.patchCardElement({
          cardId: this.cardId!,
          elementId: op.elementId,
          partial: { content: op.content },
          sequence: op.sequence,
          uuid: op.uuid,
        }),
      );
      // Success — clear any parked retry, advance the rendered marker.
      if (which === "answer") {
        this.pendingAnswerOp = null;
        this.renderedAnswer = op.content;
      } else {
        this.pendingToolsOp = null;
        this.renderedTools = op.content;
      }
      if (getMagisterEnv("MAGISTER_FEISHU_DEBUG") === "1") {
        // eslint-disable-next-line no-console
        console.log(
          `[feishu-session ${this.shortId()}] flush ${which} ok seq=${op.sequence} bytes=${op.content.length}${opts?.force ? " force" : ""}`,
        );
      }
      // Re-flush if state advanced during the await.
      if (!this.closed) {
        const next =
          which === "answer"
            ? renderAnswerBody(this.buildState())
            : renderToolsBody(this.buildState(), this.verboseLevel);
        const rendered = which === "answer" ? this.renderedAnswer : this.renderedTools;
        if (next !== rendered) {
          if (which === "answer") this.scheduleAnswerFlush();
          else this.scheduleToolsFlush();
        }
      }
    } catch (err) {
      // Codex P1a — distinguish a duplicate/out-of-order SEQUENCE
      // rejection (Feishu code 11402) from an ambiguous network failure.
      //
      // 11402 = "sequence number compare failed": the server already
      // observed a sequence >= ours for this card (our op effectively
      // landed, or was superseded). Re-sending the SAME seq would loop
      // forever, so treat it as SETTLED — clear the parked op and advance
      // the rendered marker. A later flush allocates the NEXT (higher)
      // sequence cleanly. For any OTHER error (network/transport, no code
      // or non-11402) the op's fate is ambiguous, so park it (frozen seq
      // + uuid) and retry the IDENTICAL request — Feishu dedupes by uuid,
      // and the per-card sequence never advances past this unsettled op.
      const code = (err as { code?: unknown } | undefined)?.code;
      if (code === FEISHU_SEQUENCE_CONFLICT_CODE) {
        if (which === "answer") {
          this.pendingAnswerOp = null;
          this.renderedAnswer = op.content;
        } else {
          this.pendingToolsOp = null;
          this.renderedTools = op.content;
        }
        // eslint-disable-next-line no-console
        console.warn(
          `[feishu-session ${this.shortId()}] flush ${which} seq=${op.sequence} got 11402 (duplicate seq) — treating as applied, advancing`,
        );
        if (!this.closed) {
          if (which === "answer") this.scheduleAnswerFlush();
          else this.scheduleToolsFlush();
        }
      } else {
        if (which === "answer") this.pendingAnswerOp = op;
        else this.pendingToolsOp = op;
        // eslint-disable-next-line no-console
        console.error(
          `[feishu-session ${this.shortId()}] flush ${which} seq=${op.sequence} failed (will retry same seq):`,
          err instanceof Error ? err.message : err,
        );
        const backoff = (which === "answer" ? ANSWER_FLUSH_MS : TOOLS_FLUSH_MS) * 4;
        this.deferFlush(which, backoff);
      }
    } finally {
      if (which === "answer") this.answerInFlight = false;
      else this.toolsInFlight = false;
    }
  }

  /**
   * Close the streaming card. Final flush, then PATCH `/settings` to
   * disable streaming mode.
   * Idempotent — repeat calls after the first one are no-ops.
   */
  async close(footer?: string): Promise<void> {
    if (this.closed) return;
    if (getMagisterEnv("MAGISTER_FEISHU_DEBUG") === "1") {
      // eslint-disable-next-line no-console
      console.log(
        `[feishu-session ${this.shortId()}] close start answerLen=${this.answer.length} tools=${this.toolLines.length}`,
      );
    }
    this.closed = true;
    for (const t of [this.answerFlushTimer, this.toolsFlushTimer]) {
      if (t) clearTimeout(t);
    }
    this.answerFlushTimer = null;
    this.toolsFlushTimer = null;
    try {
      this.unsubscribe();
    } catch {
      /* swallow */
    }
    // If card creation is still in-flight, wait for it to settle so we
    // either finalize the card properly (cardId got set) or know it
    // was abandoned (ensureCard's post-await `if (this.closed) return`
    // bails before setting cardId). Without this `close()` would see
    // cardId=null, skip the entire finalize path, then ensureCard()
    // would resume and leave an orphaned "⏳ Thinking…" card forever.
    if (this.cardCreationPromise) {
      try {
        await this.cardCreationPromise;
      } catch {
        /* swallow */
      }
    }
    // Settle the card-decision unconditionally (Codex P0). Covers:
    //   - card creation never started (no eager create / no events) →
    //     decision is still pending; settling lets a fallback proceed.
    //   - close arrived WHILE createCard was in-flight and ensureCard's
    //     post-await `if (this.closed) return` abandoned the card without
    //     marking delivered → settle so the fallback can fire one text.
    // Idempotent: a prior settle (delivered/failed in ensureCard) is a
    // no-op here.
    feishuChatSessionRegistry.settleCardDecision(this.requestId);
    // Drain BOTH in-flight AND parked-for-retry element flushes before
    // any terminal op so the terminal sequence is strictly greater than
    // every SETTLED element PATCH and never crosses an unsettled gap
    // (Codex P1a). A parked op (prior network failure) still owns its
    // frozen sequence; the terminal updateCard/footer/settings must not
    // allocate past it. Close late rather than mis-order.
    await this.drainSequenceFrontier();
    if (this.cardId) {
      // Final flush of BOTH elements (force=true bypasses the closed
      // guard + token bucket) so the tail of tool_result + text_delta
      // events that arrived after the last throttle window lands. Tools
      // first so the panel reflects the full activity before the answer
      // (carrying the footer) settles last.
      try {
        await this.flushElement("tools", { force: true });
      } catch {
        /* swallow */
      }
      try {
        await this.flushElement("answer", { force: true });
      } catch {
        /* swallow */
      }
      // Codex re-review P1 — the force flushes above can THEMSELVES fail
      // and park an op (frozen seq). Drain AGAIN so any newly-parked op
      // settles before we allocate a terminal sequence. If the frontier
      // STILL can't settle within the bounded budget, do NOT cross it with
      // a partial footer/settings mutation (that would open a sequence gap
      // → 11402, and the 11402='advance' handling can mask a lost lower
      // update). Instead finalize with a SINGLE full-card updateCard above
      // the settled frontier: updateCard rewrites the entire card body
      // (current answer + tools + streaming_mode:false + summary/footer +
      // any media), so a parked partial-element op that never landed is
      // rendered moot by the full rebuild.
      const frontierSettled = await this.drainSequenceFrontier();
      if (!frontierSettled) {
        // eslint-disable-next-line no-console
        console.warn(
          `[feishu-session ${this.shortId()}] sequence frontier still unsettled at close — finalizing via single full-card updateCard above the frontier`,
        );
        try {
          await this.finalizeViaFullCard(this.cardId, footer);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[feishu-session ${this.shortId()}] full-card finalization fallover failed:`,
            err instanceof Error ? err.message : err,
          );
        }
        if (this.disposeCallback) {
          try {
            this.disposeCallback();
          } catch {
            /* swallow — registry cleanup shouldn't fault */
          }
        }
        return;
      }
      // Terminal media path (Task 7, v1 = finalize-only inline media).
      // If this turn produced media, rebuild the WHOLE card via
      // updateCard with the media inlined (img elements for images,
      // markdown link rows for non-image files). This goes through the
      // SAME per-card queue + the NEXT monotonic sequence as the element
      // PATCHes above (already drained), so it can't race/reorder or
      // cross an unsettled sequence gap (S5). updateCard subsumes the
      // footer patch AND the streaming_mode/summary settings PATCH (the
      // rebuilt card_json already carries streaming_mode:false + summary
      // + footer), so the no-media `finalizeCardSettings` path is skipped
      // in this branch.
      let finalizedViaUpdate = false;
      if (this.hasMediaThisTurn) {
        try {
          await this.finalizeWithMedia(this.cardId, footer);
          finalizedViaUpdate = true;
        } catch (err) {
          // updateCard finalize failed — fall through to the legacy
          // settings finalize below so the card at least stops streaming
          // and gets a footer (no-media terminal path is never regressed).
          // eslint-disable-next-line no-console
          console.warn(
            `[feishu-session ${this.shortId()}] media finalize (updateCard) failed, falling back to settings:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (!finalizedViaUpdate) {
        // Append the status footer to the ANSWER element. Build from live
        // state so the close-time tail is included even if the flush above
        // no-op'd. Same `feishuChatKey(bindingId)` lane so it can't race
        // ahead of in-flight content PATCHes (Feishu rejects out-of-order
        // sequences globally, not per-lane).
        if (footer) {
          try {
            const finalAnswer = renderAnswerBody(this.buildState()) + `\n\n*${footer}*`;
            await this.acquireToken(); // Codex P1b — terminal footer counts against the per-card cap
            this.sequence += 1;
            await enqueue(feishuChatKey(this.bindingId), () =>
              this.client.patchCardElement({
                cardId: this.cardId!,
                elementId: ANSWER_ELEMENT,
                partial: { content: finalAnswer },
                sequence: this.sequence,
                uuid: `a_${this.cardId}_close_${this.sequence}`,
              }),
            );
            this.renderedAnswer = finalAnswer;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[feishu-session ${this.shortId()}] close footer failed:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        // Final: disable streaming_mode AND overwrite the header summary
        // (the initial "[Working…]" placeholder must be replaced or the
        // card visually looks stuck even though streaming is off).
        const finalSummary = footer && footer.length > 0 ? footer : "Done";
        try {
          await this.finalizeCardSettings(this.cardId!, finalSummary);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[feishu-session ${this.shortId()}] finalize settings failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    if (this.disposeCallback) {
      try {
        this.disposeCallback();
      } catch {
        /* swallow — registry cleanup shouldn't fault */
      }
    }
  }

  /**
   * Cancel without finalization. Used on task abort.
   */
  async abort(reason: string = "cancelled"): Promise<void> {
    await this.close(`⏹ ${reason}`);
  }

  /**
   * Settings PATCH to disable streaming mode AND update the card-level
   * summary (the header text Feishu shows above the body). Goes through
   * the same per-chat sequential queue + sequence counter as content
   * PATCHes so it doesn't race with an in-flight content update.
   *
   * The card was created with summary "[Working…]" — leaving it on a
   * closed card shows perpetual working state. Pass a final summary
   * that reflects the terminal state.
   */
  private async finalizeCardSettings(
    cardId: string,
    finalSummary: string,
  ): Promise<void> {
    await this.acquireToken(); // Codex P1b — terminal settings PATCH counts against the per-card cap
    this.sequence += 1;
    const seq = this.sequence;
    const uuid = `s_${cardId}_finalize_${seq}`;
    // Same `feishuChatKey(bindingId)` lane as content PATCHes — Feishu's
    // sequence check is global per-card, not per-queue-lane. Using a
    // separate "control" lane caused settings PATCH to arrive before
    // the in-flight content PATCH, triggering "sequence number compare
    // failed" rejections.
    await enqueue(feishuChatKey(this.bindingId), () =>
      this.client.patchCardSettings({
        cardId,
        settings: {
          streaming_mode: false,
          summary: { content: finalSummary },
        },
        sequence: seq,
        uuid,
      }),
    );
  }

  /**
   * Terminal full-card rebuild with this turn's media inlined (Task 7,
   * v1 finalize-only). Called from close() AFTER in-flight element
   * flushes have drained, so the updateCard rides the SAME per-card
   * queue with the NEXT monotonic sequence — no race/reorder vs a late
   * element PATCH and no crossing an unsettled sequence gap (S5).
   *
   * Media is scoped to (taskId, requestId) (S6) so a resumed task that
   * shares a taskId can't pull PRIOR turns' media into this card. Images
   * are uploaded to get an image_key; non-image files render as markdown
   * link rows. A per-item upload failure is logged and skipped — it does
   * not abort finalization.
   */
  private async finalizeWithMedia(cardId: string, footer?: string): Promise<void> {
    // Lazy default deps so production needn't pass them (and the import
    // stays out of test scope when a fake repo/reader is injected).
    let repo = this.mediaRepo;
    if (!repo) {
      const { TaskMediaRepository } = await import(
        "../../repositories/task-media-repository"
      );
      repo = new TaskMediaRepository();
    }
    const readBytes =
      this.readMediaBytes ??
      (async (storagePath: string) => {
        const { readFile } = await import("node:fs/promises");
        return readFile(storagePath);
      });

    const rows = await repo.listByTaskIdAndRequestId(this.taskId, this.requestId);
    const items: MediaItem[] = [];
    for (const row of rows) {
      const caption = row.caption ?? undefined;
      const captionPart = caption !== undefined ? { caption } : {};
      if (row.kind === "image") {
        try {
          const data = await readBytes(row.storagePath);
          const { imageKey } = await this.client.uploadImage({
            data,
            filename: row.filename,
          });
          items.push({ kind: "image", imageKey, filename: row.filename, ...captionPart });
        } catch (err) {
          // Skip this image (don't abort finalize) — the card still
          // finalizes with the answer/tools and any other media.
          // eslint-disable-next-line no-console
          console.warn(
            `[feishu-session ${this.shortId()}] uploadImage failed for ${row.filename}, skipping:`,
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        items.push({ kind: "file", filename: row.filename, ...captionPart });
      }
    }
    this.mediaItems = items;

    const template = this.templateForFooter(footer);
    const finalCard = buildFinalCard({
      state: this.buildState(),
      verboseLevel: this.verboseLevel,
      ...(footer ? { footer } : {}),
      template,
    });

    await this.acquireToken(); // Codex P1b — terminal updateCard counts against the per-card cap
    this.sequence += 1;
    const seq = this.sequence;
    await enqueue(feishuChatKey(this.bindingId), () =>
      this.client.updateCard({
        cardId,
        cardJson: finalCard,
        sequence: seq,
        uuid: `u_${cardId}_finalize_${seq}`,
      }),
    );
  }

  /**
   * Codex re-review P1 — terminal full-card finalization used when the
   * per-card sequence frontier could NOT be settled within the bounded
   * drain budget (a parked element op never landed). A partial mutation
   * (footer/settings PATCH) here would allocate a sequence ahead of the
   * still-unsettled parked op → gap → 11402. A single full-card
   * `updateCard` instead rewrites the ENTIRE card body from live state
   * (answer + tools + streaming_mode:false + summary/footer + any
   * already-resolved media), so whatever the parked partial op carried is
   * subsumed by the rebuild. The terminal sequence is `++this.sequence`,
   * which is strictly greater than every allocated sequence (including the
   * parked op's frozen seq), satisfying Feishu's monotonic check.
   *
   * Note: this does NOT re-resolve media (unlike `finalizeWithMedia`) —
   * it is the can't-settle fallover and uses whatever `this.mediaItems`
   * already holds. The media-resolving terminal path (`finalizeWithMedia`)
   * runs only on the settled-frontier branch.
   */
  private async finalizeViaFullCard(cardId: string, footer?: string): Promise<void> {
    const template = this.templateForFooter(footer);
    const finalCard = buildFinalCard({
      state: this.buildState(),
      verboseLevel: this.verboseLevel,
      ...(footer ? { footer } : {}),
      template,
    });
    await this.acquireToken(); // terminal updateCard counts against the per-card cap
    this.sequence += 1;
    const seq = this.sequence;
    await enqueue(feishuChatKey(this.bindingId), () =>
      this.client.updateCard({
        cardId,
        cardJson: finalCard,
        sequence: seq,
        uuid: `u_${cardId}_fallover_${seq}`,
      }),
    );
  }

  /** Header template inferred from the terminal footer text. */
  private templateForFooter(footer?: string): "blue" | "green" | "red" | "grey" {
    if (!footer) return "green";
    if (footer.includes("❌")) return "red";
    if (footer.includes("⏹")) return "grey";
    return "green";
  }

  private readString(...values: unknown[]): string | null {
    for (const v of values) {
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  }

  private extractReason(event: TaskSSEEvent): string | null {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return null;
    return this.readString(data.error, data.reason);
  }

  private shortId(): string {
    return this.requestId.slice(-8);
  }

  /**
   * Test-only: drain the shared per-card token bucket so a subsequent
   * mutation must wait for refill. Used to deterministically prove
   * terminal ops (force flushes / footer / settings / updateCard) draw
   * from the SAME bucket (Codex P1b) rather than bypassing it.
   */
  __depleteBucketForTests(): void {
    while (this.patchBucket.tryTake()) {
      /* drain to empty */
    }
  }

  /**
   * Diagnostic snapshot — used by registry's status report.
   */
  snapshot() {
    return {
      requestId: this.requestId,
      taskId: this.taskId,
      bindingId: this.bindingId,
      cardId: this.cardId,
      sequence: this.sequence,
      toolCount: this.toolLines.length,
      answerLength: this.answer.length,
      closed: this.closed,
      ageMs: Date.now() - this.createdAtMs,
    };
  }

  /**
   * Auto-close after TTL — safety belt against sessions that never
   * receive a terminal event. Caller should check periodically.
   */
  isExpired(now = Date.now()): boolean {
    return now - this.createdAtMs > SESSION_TTL_MS;
  }
}

/**
 * Registry keyed on requestId. New requests get fresh sessions.
 * Concurrent sessions for the same taskId are allowed (different
 * requestIds → different sessions).
 */
type CardDecision = {
  /** Resolves once createCard/sendCardRef for this requestId is SETTLED (delivered OR abandoned/failed). */
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
};

class FeishuChatSessionRegistry {
  private sessions = new Map<string, FeishuChatSession>();
  /**
   * Per-requestId "card-creation decision settled" promises (Codex P0).
   *
   * `taskEventBus.publish()` does NOT await async listeners, so the
   * text-fallback call sites can read `hasDeliveredCardFor()` as false
   * while a session's eager `createCard` + `sendCardRef` are still IN
   * FLIGHT — sending BOTH a streaming card AND a plain-text fallback
   * (double-delivery on the live channel). The fallback MUST first
   * `await awaitCardDecision(requestId)`, which resolves only once the
   * session has DECIDED (delivered → markRequestDelivered; or failed/
   * abandoned/closed-before-creation → settle without marking). After
   * that await, `hasDeliveredCardFor()` is authoritative.
   *
   * If no session ever started for the requestId there is no decision to
   * wait on, so `awaitCardDecision` resolves immediately (fallback
   * proceeds with the single text message, as before).
   */
  private cardDecisions = new Map<string, CardDecision>();
  /**
   * Tracks (requestId | taskId) values whose streaming card was
   * *actually delivered to the user* (createCard + sendCardRef both
   * succeeded). The notification-card fallback gates on this — if a
   * session was started but creation failed, the legacy notification
   * card still needs to fire so the user isn't left empty-handed.
   * Bounded LRU via delete-then-add on touch (refreshes recency).
   */
  private deliveredKeys = new Set<string>();
  private readonly deliveredHistoryCap = 4096;

  /**
   * Start a session for the given request. If the requestId already
   * has a session, returns the existing one (idempotent — defensive
   * against double-start in retry paths).
   *
   * Does NOT record "ever started" — only an actually-delivered card
   * (via `markRequestDelivered`) flips the notification-fallback gate.
   */
  start(config: SessionConfig): FeishuChatSession {
    const existing = this.sessions.get(config.requestId);
    if (existing) return existing;
    // Register the card-decision promise BEFORE constructing the session
    // (whose eager create can settle it synchronously-fast) so the
    // fallback call sites always observe a pending decision for a started
    // session, never a race where the decision was created after the
    // fallback already checked.
    this.ensureCardDecision(config.requestId);
    const session = new FeishuChatSession(config, () => {
      this.sessions.delete(config.requestId);
      // Settle (in case dispose somehow beat the explicit settle) then
      // drop the decision entry — a later awaitCardDecision with no entry
      // resolves immediately, which is correct (the decision was reached).
      this.settleCardDecision(config.requestId);
      this.cardDecisions.delete(config.requestId);
    });
    this.sessions.set(config.requestId, session);
    // Eager create: post the "⏳ Thinking…" card immediately so it is the
    // sole, instant acknowledgement (no separate 已收到 ack). Fire-and-
    // forget — failures fall back to lazy create on the first event.
    session.ensureCardEager();
    return session;
  }

  private ensureCardDecision(requestId: string): CardDecision {
    const existing = this.cardDecisions.get(requestId);
    if (existing) return existing;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const decision: CardDecision = { promise, resolve, settled: false };
    this.cardDecisions.set(requestId, decision);
    return decision;
  }

  /**
   * Resolve once the createCard/sendCardRef decision for this requestId is
   * SETTLED (delivered OR abandoned/failed/closed-before-creation). The
   * text-fallback call sites await this BEFORE reading
   * `hasDeliveredCardFor()`. If no session ever started for the requestId
   * there's nothing to wait on → resolves immediately. Safe to await
   * multiple times (returns the same settled promise).
   */
  awaitCardDecision(requestId: string): Promise<void> {
    const existing = this.cardDecisions.get(requestId);
    if (!existing) return Promise.resolve();
    return existing.promise;
  }

  /**
   * Called by the session once its card-creation decision is final
   * (success, failure, or abandoned-on-close). Idempotent — a session
   * settling twice (e.g. ensureCard catch + close) is harmless.
   */
  settleCardDecision(requestId: string): void {
    const decision = this.cardDecisions.get(requestId);
    if (!decision || decision.settled) return;
    decision.settled = true;
    decision.resolve();
  }

  /**
   * Called by FeishuChatSession after createCard + sendCardRef both
   * succeed. Marks the requestId only — resume turns (new requestId,
   * same taskId) need their own card-delivered check because the new
   * turn might fall through to the notification card (e.g.,
   * verboseLevel changed to "off" between turns). Marking taskId
   * would incorrectly suppress the new turn's notification.
   */
  markRequestDelivered(requestId: string): void {
    this.rememberDelivered(requestId);
  }

  private rememberDelivered(key: string): void {
    // Delete-then-add refreshes insertion order (LRU-like). Without
    // this a long-running task's taskId would be anchored at its
    // earliest insertion and could be evicted while still in-flight.
    this.deliveredKeys.delete(key);
    this.deliveredKeys.add(key);
    if (this.deliveredKeys.size > this.deliveredHistoryCap) {
      const head = this.deliveredKeys.values().next().value;
      if (typeof head === "string") this.deliveredKeys.delete(head);
    }
  }

  /**
   * Has a streaming card been actually delivered for this requestId or
   * taskId? Notification-card fallback gates on this so the user
   * always gets some output even when card delivery failed.
   */
  hasDeliveredCardFor(key: string): boolean {
    // Touch on access — keeps active task keys at the back of the LRU.
    if (this.deliveredKeys.has(key)) {
      this.deliveredKeys.delete(key);
      this.deliveredKeys.add(key);
      return true;
    }
    return false;
  }

  get(requestId: string): FeishuChatSession | undefined {
    return this.sessions.get(requestId);
  }

  /**
   * Close all sessions tied to the given taskId. Used when a task is
   * cancelled or fails outside the streaming projection path.
   */
  async closeAllForTask(taskId: string, reason: string = "closed"): Promise<void> {
    const matches: FeishuChatSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.snapshot().taskId === taskId) matches.push(session);
    }
    await Promise.all(matches.map((s) => s.close(reason)));
  }

  /**
   * Sweep expired sessions. Caller invokes periodically (server.ts).
   */
  async sweep(): Promise<number> {
    let closed = 0;
    const expired = Array.from(this.sessions.values()).filter((s) => s.isExpired());
    for (const session of expired) {
      await session.close("ttl");
      closed += 1;
    }
    return closed;
  }

  snapshot() {
    return Array.from(this.sessions.values()).map((s) => s.snapshot());
  }

  /** Test helper. */
  __resetForTests(): void {
    this.sessions.clear();
    this.deliveredKeys.clear();
    for (const d of this.cardDecisions.values()) d.resolve();
    this.cardDecisions.clear();
  }
}

export const feishuChatSessionRegistry = new FeishuChatSessionRegistry();

/**
 * Convenience builder — creates the feishu client from env, validates
 * config, returns null if feishu isn't configured (caller treats as
 * "skip"). Avoids every caller having to repeat the parseFeishuConfig
 * dance.
 */
export function buildFeishuClientIfConfigured(): FeishuClient | null {
  const config = parseFeishuConfigFromEnv();
  if (!config.appId || !config.appSecret) return null;
  return createFeishuClient({ appId: config.appId, appSecret: config.appSecret });
}
