/**
 * Conversation domain model — the deterministic source of truth for the
 * chat UI, replacing the flat `messages: Message[]` array that has 17
 * uncoordinated mutation sites in ChatArea.tsx.
 *
 * See `docs/specs/2026-04-25-chat-data-flow-refactor.md` §3.1 + §3.4.
 *
 * Invariants (enforced by the projector + chatStore, NOT representable
 * via TS alone):
 *  - `Exchange.id === requestId` once the backend has confirmed the prompt
 *    submission. Until then, an "optimistic" exchange uses a temporary
 *    client-generated id; `chatStore.bindRequestId` rewrites it.
 *  - Every part inside `AssistantResponse.parts` has a deterministic id
 *    derived from the request scope, so replay produces identical state:
 *      text part:        `${requestId}:text:${ordinal}`  (ordinal = count
 *                        of preceding sealed text parts in this exchange)
 *      tool part:        `${requestId}:tool:${toolUseId}`
 *      model-error part: the durable execution_events row id
 *  - The active streaming text part (the one being written into right now)
 *    is the LAST `text` part with `sealed: false`. There is at most one
 *    per exchange at a time. tool_use_start seals the active text part;
 *    a subsequent text_delta opens a fresh one.
 *  - Tool grouping ("Used N tools" collapsed view) is a render-time
 *    concern. The model only stores parts in arrival order.
 */

import type { TextBuffer } from "./textBuffer";

export type Conversation = {
  taskId: string;
  /** Append-only. Order is the order user submitted prompts. */
  exchanges: Exchange[];
};

export type UserAttachmentMeta = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type Exchange = {
  /** requestId from the backend; matches the value stamped on every event. */
  id: string;
  /**
   * Lifecycle status. UI is "waiting" iff at least one Exchange has
   * status !== "complete" && !== "failed".
   *  - pending:   user just submitted; no events received yet
   *  - streaming: at least one event received; turn still in progress
   *  - complete:  task:completed received for this requestId
   *  - failed:    task:failed received for this requestId
   */
  status: "pending" | "streaming" | "complete" | "failed";
  user: {
    content: string;
    /** Files staged with this turn. Set by ChatInput before send;
     *  rendered as chips in the user bubble so the user sees their
     *  upload was registered. Optimistic-only — survives until page
     *  reload, then disappears (backend doesn't yet surface
     *  per-turn attachment metadata in snapshots). */
    attachments?: Array<UserAttachmentMeta>;
    /** Wall-clock ms when the user submitted the prompt. Surfaces in
     *  the per-message header strip as "2m ago". Optimistic exchanges
     *  set this at create time; projector-seeded exchanges (snapshot
     *  replay / late-arriving requestId) inherit it from the first
     *  event's timestamp. Optional — header gracefully omits time
     *  when missing. */
    createdAtMs?: number;
    /** Provenance set: requestIds whose prompt content is currently
     *  included in `content`. Single source of truth for deduping the
     *  three independent paths that can write user-text:
     *    - bindRequestId (optimistic exchange gets its real id)
     *    - hydrateUserPrompts (/messages backfill on cold load)
     *    - applyPromptMerged (mailbox prompt folded from a sibling
     *      orphan exchange)
     *  Each path appends its requestId here when it adds content and
     *  skips the write when its requestId is already listed. Without
     *  this, the order in which the three paths happen to run can
     *  produce duplicated content, lost prompts, or mismatched
     *  attribution depending on race timing. */
    hydratedRequestIds?: string[];
  };
  response: AssistantResponse;
  /**
   * User-visible response timing for this exchange. `elapsedMs` means
   * "agent worked time": wall time minus approval pauses.
   */
  timing?: ExchangeTiming;
  /**
   * Highest `(requestId, seq)` already applied — drives event-level
   * deduplication on reconnect. seq < lastAppliedSeq is dropped silently.
   */
  lastAppliedSeq: number;
  /**
   * Buffered plan exit awaiting its `plan_proposed` partner. Only set
   * when `leader.plan_mode_exited` arrives BEFORE `leader.plan_proposed`
   * due to live-path event reorder (the live `applyWireEvent` doesn't
   * sort by seq — see plan-mode spec §10.4). Cleared once a PlanPart
   * exists and the buffered status is applied. Per-exchange because
   * exchanges are already keyed by requestId.
   */
  pendingPlanExit?: {
    status: "approved" | "cancelled" | "revised";
    feedback?: string;
  };
  /**
   * Plan-mode phase for THIS exchange. Drives the header PLAN MODE
   * badge so the user sees the lane is active even before the plan
   * itself is proposed (PLANNING) or after it's resolved (done).
   * Default `idle`. Updated by the projector on plan events:
   *   - `leader.plan_mode_entered`   → planning
   *   - `leader.plan_proposed`       → awaiting_approval
   *   - `leader.plan_mode_exited`    → done (approved/cancelled) | planning (revised)
   */
  planPhase?: "idle" | "planning" | "awaiting_approval" | "done";
};

export type ExchangeTiming = {
  startedAtMs?: number;
  completedAtMs?: number;
  wallMs?: number;
  pausedMs?: number;
  elapsedMs?: number;
  activePauseStartsById?: Record<string, number>;
  activePauseStartedAtMs?: number;
};

export type AssistantResponse = {
  parts: ResponsePart[];
};

export type ResponsePart =
  | TextPart
  | ThinkingPart
  | MediaPart
  | ToolPart
  | ModelErrorPart
  | PlanPart
  | TodoListPart
  | SystemPart;

/**
 * Live structured todo list emitted by the leader via the `update_plan`
 * tool. Each `update_plan` tool_call event becomes one TodoListPart
 * snapshot in its turn position — the leader is told to pass the
 * COMPLETE list every call, so each part stands alone.
 *
 * Renders inline as a checkable list (□ pending, ▶ in_progress,
 * ✔ completed, ⊘ cancelled). Items in `in_progress` show their
 * `activeForm` (gerund) instead of `content` (imperative).
 *
 * Source of truth is the `leader.tool_call` event's structured `input`
 * field — no separate persistence. Replays on snapshot reload.
 *
 * Spec: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md
 */
export type TodoItem = {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
};

export type TodoListPart = {
  kind: "todo_list";
  /** Stable: `${requestId}:todo_list:${toolUseId}` */
  id: string;
  /** Source toolUseId — for keying / debugging. */
  toolUseId: string;
  /** Full snapshot from this update_plan call. */
  todos: TodoItem[];
};

/**
 * Streaming reasoning / thinking content emitted by the model BEFORE
 * the visible answer. Modern thinking-capable models (Anthropic
 * extended thinking, DeepSeek-R1, Kimi-K2-thinking, Qwen3-thinking,
 * GLM-thinking) emit reasoning tokens during the same first-byte
 * window that previously looked like a frozen UI — surfacing them
 * eliminates the "stuck" feeling without changing actual model
 * latency.
 *
 * Spec: docs/specs/2026-04-28-thinking-stream-spec.md
 *
 * Streaming behavior mirrors TextPart: a TextBuffer drives char-level
 * animation while `sealed === false`, then on seal the buffer is
 * disposed and `content` becomes canonical. The renderer collapses
 * the block 1.5s after seal and replaces "🤔 Thinking..." with
 * "🤔 Thought for X.Xs".
 *
 * `firstDeltaSeq` / `sealedSeq` are captured from event seq numbers,
 * NOT from `performance.now()`, so projector replay stays
 * deterministic. The renderer derives elapsed time from local
 * wall-clock (mountedAt → sealedAt) for live sessions and falls
 * back to "🤔 Thought for a moment" on cold-load snapshot replay
 * where wall-clock for the original streaming isn't available.
 */
export type ThinkingPart = {
  kind: "thinking";
  /** Stable: `${requestId}:thinking:${ordinal}` */
  id: string;
  content: string;
  sealed: boolean;
  buffer: TextBuffer | null;
  /** Event seq of the first thinking_delta — informational. */
  firstDeltaSeq?: number;
  /** Event seq when sealed — informational. */
  sealedSeq?: number;
};

/**
 * Loop-level system notice — surfaces auxiliary leader events that
 * affect what the user sees but aren't model output. Currently used
 * for context compaction, doom-loop detection, max-turns hits, and
 * runtime recovery notices.
 * Renders as a small bordered notice between text/tool parts; clicking
 * the headline expands `detail` for the full payload.
 *
 * Compaction was a regression from the legacy ChatArea — old render
 * showed the pre/post token deltas; the chatStore-driven render
 * stopped surfacing them entirely. Doom-loop and max-turns are new
 * coverage: previously the loop emitted these and immediately exited
 * with task:failed, leaving the user with "the chat just stopped" and
 * no signal as to why.
 */
export type SystemPart = {
  kind: "system";
  /** Stable: `${requestId}:system:${eventId}` (durable execution_events row id). */
  id: string;
  /**
   * `compaction` / `doom_loop` / `max_turns` / `recovery` /
   * `recovery_blocked` are backend-emitted notices that arrive via
   * the event projector. `status` is local-only: pushed by the chat
   * `/status` slash command via `pushLocalDiagnostic` so the user
   * gets the workspace + session snapshot inline in the conversation
   * instead of navigating to a separate panel. The status variant
   * renders always-expanded (no chevron) — it IS the body.
   */
  variant:
    | "compaction"
    | "doom_loop"
    | "max_turns"
    | "recovery"
    | "recovery_blocked"
    | "status"
    | "async_teammate"
    | "model_switched";
  headline: string;
  detail?: string;
};

/**
 * A plan submitted by the agent via `exit_plan_mode`. Carries the full
 * markdown plan + lifecycle status mutated by `leader.plan_mode_exited`
 * events. Renderer treats it as its own first-class part (not a
 * `ToolPart`) because the full markdown can exceed the truncated
 * `inputSummary` size and we want a dedicated approve/revise/cancel
 * UI affordance, not the generic tool-call expand chevron.
 *
 * See `docs/specs/2026-04-26-plan-mode-spec.md` §10.1.
 */
export type PlanPart = {
  kind: "plan";
  /** Stable: `${requestId}:plan:${ordinal}` */
  id: string;
  /** Full markdown plan body. */
  plan: string;
  /** Lifecycle status, mutated by `leader.plan_mode_exited` events. */
  status: "awaiting_approval" | "approved" | "cancelled" | "revised";
  /** Populated when status === "revised" — the user feedback that
   *  triggered the revision. */
  feedback?: string;
};

export type TextPart = {
  kind: "text";
  /** Stable: `${requestId}:text:${ordinal}` */
  id: string;
  /**
   * Once `sealed === true`, `content` is the canonical text and `buffer`
   * is null. While `sealed === false`, the visible text comes from
   * `buffer.getSnapshot()` and `content` may be empty (it is filled when
   * the part is sealed via `seal()`).
   */
  content: string;
  sealed: boolean;
  /**
   * Per-text-part streaming buffer with a STABLE reference for the part's
   * lifetime. NEVER mutate the buffer reference under a live
   * `useSyncExternalStore` subscription — when this part is sealed and the
   * next text part is created, the new part gets its own fresh buffer.
   *
   * `null` once sealed (frees the RAF animator state).
   */
  buffer: TextBuffer | null;
  /**
   * Wall-clock ms when the FIRST delta for this part arrived (from
   * `event.timestamp`). Used by the message-header strip to render a
   * relative "2m ago"-style timestamp. Optional — pre-header replays
   * (snapshot rows with no timestamp) fall back to header-less mode.
   */
  createdAtMs?: number;
  /** Agent role/name authoring this part (e.g. "leader", "coder").
   *  Sourced from the wire `agent` envelope. */
  agentRole?: string;
  agentName?: string;
};

export type MediaPart = {
  kind: "media";
  /** Stable: `${requestId}:media:${mediaId}` */
  id: string;
  mediaId: string;
  mediaKind: "image" | "video";
  mimeType: string;
  filename: string;
  sizeBytes: number;
  /** Relative authenticated API URL, derived at projection time. */
  url: string;
  caption?: string;
  display: "inline" | "attachment";
  width?: number;
  height?: number;
  durationMs?: number;
  createdAtMs?: number;
  agentRole?: string;
  agentName?: string;
};

export type ToolPart = {
  kind: "tool";
  /** Stable: `${requestId}:tool:${toolUseId}` */
  id: string;
  /** From the backend tool_use protocol; same id parent and result share. */
  toolUseId: string;
  name: string;
  /** Tool arguments as the agent sent them. */
  input: unknown;
  /** null until `leader.tool_result` for this toolUseId arrives. */
  result: ToolResult | null;
  /** Wall-clock ms when the tool_call event arrived. Header timestamp. */
  createdAtMs?: number;
  /** Agent role/name that issued the call (from wire `agent` envelope). */
  agentRole?: string;
  agentName?: string;
  /**
   * Set when the bash danger gate triggers: the loop pauses on
   * `command-approval-service.waitForApproval` until the user clicks
   * Approve/Reject (or it times out). The renderer surfaces an inline
   * approve/reject affordance so the user doesn't have to navigate to
   * the dashboard ApprovalPanel mid-conversation. Cleared by the
   * projector when `leader.tool_result` for the same `toolUseId`
   * arrives — at that point the gate has resolved one way or another.
   */
  pendingApproval?: {
    approvalId: string;
    reason: string;
    command: string;
    // Surface tool kind + subject so the approval card can label the
    // task/time-window trust checkboxes accurately ("Trust this server …"
    // for MCP vs. "Trust this command kind …" for bash) and so the trust
    // ledger key matches what the server will derive.
    toolKind?: "bash" | "mcp_tool";
    subjectKey?: string | null;
    // Sandbox-elevation v4.3 §4.1 §4.6 — v4 fields surfaced via the
    // approval payload's `escalation` blob. The card renders:
    //   - per-path color tags from `additionalPermissions.entries`
    //   - red banner for `denyReadRequestedButUnsupported`
    //   - sanitized justification in a grey-bordered block
    // All fields optional; v3 approvals (legacy or no v4 elevation)
    // just omit them and the card falls back to the simple layout.
    justification?: string;
    sandboxMode?: "use_default" | "with_additional_permissions" | "require_escalated";
    additionalPermissions?: {
      network?: { enabled?: boolean };
      file_system?: {
        entries: Array<{
          path: string;
          access: "read" | "write";
          sensitivity: "safe" | "caution" | "critical";
          sensitivityReason: string;
        }>;
      };
    };
    denyReadRequestedButUnsupported?: Array<{
      path: string;
      classification: "safe" | "caution" | "critical";
    }>;
  };

  // ── teammate transcript fields ──────────
  // These are populated only when `name === "spawn_teammate"` and a
  // teammate was actually spawned (i.e. depth=1 events with
  // matching `parentToolUseId` arrived). The flat parts array stays
  // flat — the spawn_teammate ToolPart IS the container for its
  // own teammate's events. Codex round-1 §0.1/A1.

  /** roleRuntimeId of the spawned teammate. Set on `leader.teammate_spawned`. */
  teammateRunId?: string;
  /** Logical role of the teammate (e.g. "coder", "reviewer"). */
  teammateRole?: string;
  /** Display name (defaults to roleId capitalised). */
  teammateName?: string;
  /** Runtime used by the teammate, e.g. "ucm", "codex", "opencode". */
  teammateRuntime?: string;
  /** Model configured for the teammate when the backend exposes it. */
  teammateModel?: string;
  /** Timestamp from `leader.teammate_spawned`, used for duration display. */
  teammateStartedAtMs?: number;
  /** Timestamp from `leader.teammate_completed`, used for duration display. */
  teammateCompletedAtMs?: number;
  /**
   * Lifecycle: spawned (event seen, no events yet) →
   * running (first nested event arrived) →
   * completed | failed | cancelled (terminal event seen).
   */
  teammateStatus?: "spawned" | "running" | "completed" | "failed" | "cancelled";
  /** Number of unique tool calls observed inside the teammate transcript. */
  teammateToolCount?: number;
  /** Last human-meaningful nested message/result/error observed in the transcript. */
  teammateLastMessage?: string;
  /**
   * Token usage emitted by the teammate's `leader.teammate_completed`
   * payload (built-in Magister teammates) or surfaced via the CLI usage
   * pipeline (claude-code / codex / opencode → recordUsage). Surfaced
   * inline in the spawn_teammate chip row so the user can see
   * delegation cost without opening the transcript drawer.
   */
  teammateInputTokens?: number;
  teammateOutputTokens?: number;
  teammateCacheReadTokens?: number;
  /** Failure reason derived from `leader.teammate_completed` when status is failed. */
  teammateFailureReason?: string;
  /** Suggested next action derived from completion payload or local fallback. */
  teammateNextAction?: string;
  /**
   * The teammate's nested events as ResponsePart[] in arrival order.
   * Bounded by TRANSCRIPT_MEMORY_CAP (default 500 — see projector).
   * Inline body renders first-50 + elision-marker + last-10 once
   * length exceeds TRANSCRIPT_INLINE_CAP (default 100). Beyond memory
   * cap, the sidechain drawer fetches via the lazy-load endpoint.
   */
  transcript?: ResponsePart[];
  /**
   * Raw event count seen so far. Used by the inline body to decide
   * "render all" vs "first-50 + elision + last-10" and to surface
   * "(N events)" in the collapsed header. Distinct from
   * `transcript.length` because some events (e.g. tool_call+result
   * pairs) may produce only one part.
   */
  transcriptEventCount?: number;
  /**
   * Final summary text from `leader.teammate_completed.summary`. UI
   * only — the leader's tool_result already received the (possibly-
   * truncated) finalText through `capLeaderTeammateText` (Step 1).
   */
  teammateSummary?: string;
};

export type ToolResult = {
  isError: boolean;
  /** Stringified output. Frontend displays it as a code block. */
  output: string;
};

export type ModelErrorPart = {
  kind: "model-error";
  /** Stable: the durable execution_events row id. */
  id: string;
  message: string;
};

/**
 * Wire shape — what the backend serialises into SSE / snapshot payloads.
 * The projector consumes these. We keep this loose (Record<string, unknown>
 * for `data`) because the backend evolves event payloads independently.
 */

/**
 * agent envelope stamped by the backend on every
 * broadcast and (post-Step-0b migration) persisted on every
 * execution_events row. Frontend uses `depth` to route teammate events
 * into nested transcripts and `parentToolUseId` to pair them to the
 * owning `spawn_teammate` ToolPart with zero cross-event state.
 */
export type WireEventAgent = {
  /** roleRuntimeId of the emitting agent. */
  id: string;
  /** Logical role: "leader" | "coder" | "reviewer" | ... */
  role: string;
  /** Display name. */
  name: string;
  /** 0 = leader, 1+ = nested teammate. */
  depth: number;
  /** Parent agent's roleRuntimeId (set on teammates). */
  parentId?: string;
  /**
   * The leader's `spawn_teammate` tool_use_id that produced this
   * teammate runtime. Set on every event a teammate emits. The
   * frontend uses this to find the parent ToolPart in the leader
   * exchange.
   */
  parentToolUseId?: string;
};

export type WireEvent = {
  type: string;
  requestId: string;
  /** Monotonic per execution_events table; used for ordering + dedup. */
  seq: number;
  /** ISO timestamp; informational only. Order comes from seq. */
  timestamp?: string;
  data: Record<string, unknown>;
  /**
   * present on events stamped by the backend
   * projector (post-Step-0a). Older live events without this field
   * are treated as depth-0 (leader).
   */
  agent?: WireEventAgent;
};

/**
 * Snapshot replay shape — what arrives on `task.snapshot` via SSE.
 * Each event is the raw execution_events row (id, type, requestId,
 * payloadJson, occurredAt, seq).
 */
export type SnapshotEvent = {
  id: string;
  type: string;
  requestId: string | null;
  seq: number;
  occurredAt?: string;
  payloadJson?: string | null;
  /**
   * Some legacy snapshot rows arrive with `data` instead of `payloadJson`
   * (older serialiser path). The projector reads either.
   */
  data?: Record<string, unknown>;
  /**
   * agent envelope decoded from the row's
   * `agent_json` column (post-Step-0b migration). For pre-migration
   * rows this is undefined and the projector falls back to
   * `roleRuntimeId` heuristic for depth derivation.
   */
  agent?: WireEventAgent;
  /**
   * Legacy fallback for pre-migration rows (no `agent_json`). The
   * projector compares this against the leader's runId to decide
   * whether the event came from a teammate.
   */
  roleRuntimeId?: string | null;
};
