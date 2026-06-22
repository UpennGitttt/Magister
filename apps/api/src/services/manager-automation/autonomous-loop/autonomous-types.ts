import type { z } from "zod";
import type { ExecutionPolicy } from "../../leader-execution-policy-service";
import type { DoomLoopSnapshot } from "./doom-loop-detector";

export type QueryChainTracking = {
  chainId: string;
  depth: number;
};

export type LeaderMessageBase = {
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  /**
   * The requestId of the user prompt that produced this message. Stamped
   * at message creation in process-task-intent-service.ts (initial prompt
   * triggering a run) and in autonomous-loop-service.ts mailbox drain
   * (each consumed pending prompt). Used by GET /tasks/:id/messages so
   * the frontend can bind prompts to exchanges by requestId rather than
   * by tail position — eliminates the off-by-N pairing bug when one
   * leader run absorbs multiple mailbox prompts. Optional because (a)
   * non-user message types (assistant/tool_result) don't need it, (b)
   * pre-fix checkpoints stored messages without it; the read path falls
   * back to tail-pair when this is absent everywhere.
   */
  requestId?: string;
};

export type LeaderUserMessage = LeaderMessageBase & {
  type: "user";
  content: string | LeaderContentBlock[];
};

export type LeaderAssistantMessage = LeaderMessageBase & {
  type: "assistant";
  content: LeaderContentBlock[];
  apiError?: string;
  isApiErrorMessage?: boolean;
};

/**
 * Spec §2 — tool_result block subset.
 *
 * Narrow companion to `LeaderContentBlock` for tool results
 * specifically. Anthropic and OpenAI Responses API both accept
 * `text + image` arrays in tool messages; Magister mirrors that surface
 * in vendor-neutral form. Other LeaderContentBlock variants
 * (`tool_use`, `tool_result`, `thinking`) are intentionally NOT
 * permitted here — they'd be nonsensical inside a tool result.
 */
export type LeaderResultBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

export type LeaderResultContent = string | LeaderResultBlock[];

export type LeaderToolResultMessage = LeaderMessageBase & {
  type: "tool_result";
  toolUseId: string;
  content: LeaderResultContent;
  isError?: boolean;
};

export type LeaderProgressMessage = LeaderMessageBase & {
  type: "progress";
  toolUseId: string;
  data: unknown;
};

export type TombstoneMessage = LeaderMessageBase & {
  type: "tombstone";
  toolUseIds: string[];
};

export type LeaderContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * The tool_call_id as the model originally emitted it on the
       * SSE stream. Kept for incident analysis only — the canonical
       * `id` field above is what Magister uses everywhere (gate, doom-loop,
       * checkpoint, wire format on the next API call). When present
       * and != id, it means Magister rewrote the model's id (typically
       * because the model emitted a colliding `<name>:<idx>` id).
       *
       * Optional because (a) old checkpoints predating canonical-id
       * minting don't carry it, (b) when the model's id is already
       * unique we skip storing it to save space.
       */
      providerToolUseId?: string;
    }
  // Spec §2 — `content` widened from `string` to
  // `string | LeaderResultBlock[]` so tool_result can carry mixed
  // text + image blocks. Plugins decide the wire encoding per dialect
  // (Anthropic passes the array through natively; OpenAI-compat
  // flattens to text + image placeholders until per-dialect upgrade
  // verifies native passthrough).
  | { type: "tool_result"; tool_use_id: string; content: LeaderResultContent; is_error?: boolean }
  // Vendor-neutral image block. Each provider plugin's
  // `convertMessages` translates this into its wire format
  // (Anthropic: `{type:"image", source:{type:"base64", media_type, data}}`,
  //  OpenAI-compat: `{type:"image_url", image_url:{url:"data:<mt>;base64,<data>"}}`,
  //  future Gemini: `{inlineData: {mimeType, data}}`).
  // Holds the base64-encoded image bytes (no `data:` URL prefix
  // — that's wire-format concern, added by the plugin) plus its
  // canonical `image/...` mime type.
  | { type: "image"; mediaType: string; data: string };

export type LeaderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | {
    type: "message_complete";
    content: LeaderContentBlock[];
    isError?: boolean;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      /** Provider-normalized breakdown fields. inputTokens and
       *  outputTokens are inclusive totals; cache/reasoning fields
       *  are diagnostics and must not be added again. */
      nonCachedInputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
      source?: "provider" | "estimated";
      rawUsage?: unknown;
    };
    model?: string;
    provider?: string;
    /** Structured upstream-error context, present only on `isError`
     *  envelopes from a non-OK HTTP response. Surfaced into the
     *  `leader.model_error` event payload for diagnosis. */
    errorDetail?: {
      status: number;
      provider: string;
      model: string;
      body: string;
    };
  };

export type LeaderModelOutputEvent = LeaderStreamEvent | LeaderAssistantMessage;

export type LeaderMessage =
  | LeaderUserMessage
  | LeaderAssistantMessage
  | LeaderToolResultMessage
  | LeaderProgressMessage
  | TombstoneMessage;

export type LeaderTool<Input extends z.ZodType<any> = z.ZodType<any>, Output = unknown> = {
  name: string;
  aliases?: string[];
  /**
   * Tool-level description shown to the model in tool definitions.
   * The plugins fall back to a humanized form of the name when this
   * is omitted. Use `description` for a concise one-paragraph summary
   * including WHEN to call this tool. Per-argument descriptions go on
   * the zod `.describe()` of each schema field (those become the
   * `parameters.<x>.description` in the tool spec).
   */
  description?: string;
  inputSchema: Input;
  /**
   * Optional pre-baked JSON Schema for the tool input. When present,
   * provider plugins use this verbatim instead of running
   * `z.toJSONSchema(inputSchema)`. Lets MCP-bridge tools surface the
   * remote server's actual schema (with named fields like `path`)
   * to the model — `z.record(z.unknown())` round-trips to JSON
   * Schema as `{type:"object", propertyNames:{type:"string"}}`,
   * which models interpret literally and stuff args into a single
   * `propertyNames` field. The Zod `inputSchema` is still used at
   * runtime to parse args coming back from the model; for MCP
   * tools that's a permissive `z.record(z.unknown())`.
   */
  inputJsonSchemaOverride?: Record<string, unknown>;
  call(
    args: z.infer<Input>,
    context: LeaderToolUseContext,
    onProgress?: (data: unknown) => void
  ): Promise<LeaderToolResult<Output>>;
  remoteExecute?(
    toolUse: ToolUseBlock,
    context: LeaderToolUseContext
  ): AsyncGenerator<MessageUpdate, void>;
  isConcurrencySafe(args: z.infer<Input>): boolean;
  isReadOnly(args: z.infer<Input>): boolean;
  /**
   * True iff this tool is safe to call while the leader is in plan
   * mode (state ∈ {PLANNING, AWAITING_APPROVAL}). When `isPlanSafe`
   * is undefined, the tool is treated as UNSAFE (default-deny) —
   * forces explicit opt-in for new tools so the registry can't
   * silently drift toward "everything works in plan mode".
   *
   * See `docs/specs/2026-04-26-plan-mode-spec.md` §8.
   */
  isPlanSafe?(args: z.infer<Input>): boolean;
  checkPermissions?(args: z.infer<Input>, context: LeaderToolUseContext): Promise<LeaderPermissionResult>;
  interruptBehavior?: () => "cancel" | "block";
  maxResultSizeChars?: number;
  /**
   * Wall-time timeout for a single invocation of this tool, in
   * milliseconds. When set, `tool-execution.ts` runs the call under
   * a scoped AbortController that fires at this deadline AND
   * propagates parent (user-cancel) aborts. On timeout the tool
   * receives an aborted signal (via `context.abortController.signal`)
   * AND `Promise.race` jumps out — so even tools that ignore the
   * signal still surface a `[Tool timed out]` tool_result to the
   * leader rather than hanging the loop indefinitely. The tool's
   * promise may keep running as a zombie; that's accepted (parent
   * process is fine with abandoned promises; abort already SIGKILLed
   * any spawned child processes via the existing signal path).
   *
   * Omit (`undefined`) → no timeout. Use for tools whose duration is
   * unbounded by design: `spawn_teammate` (teammate has its own loop),
   * `wait_for_teammate` (the point IS to block), `request_human_input`
   * (waits on human), `mcp_*` (pool layer already manages timeouts).
   *
   * Per-tool defaults (see manager-tools-adapter.ts):
   *   bash               = 5 min  (build / test runs)
   *   read/write/edit/   = 30 sec (pure I/O)
   *   list_dir
   *   grep               = 60 sec (large repo walks)
   *   web_search/fetch   = 30 sec (Tavily latency cap)
   *   time_now           = 5 sec  (should be instant)
   *
   * If the model needs a longer single call (e.g. a 10-minute test
   * suite), it must split the work or accept a partial result;
   * configuring per-call overrides at the input-schema level is
   * deferred until a real use case forces it.
   *
   * added in response to a task hanging 12.5h on a
   * bash that backgrounded a dev server (vite kept fd open → bash
   * never exited → tool.call never resolved → leader idle forever).
   */
  defaultTimeoutMs?: number;

  /**
   * Opt-in flag for the per-call timeout override path in
   * tool-execution.ts. When `true`, the runner reads `input.timeout`
   * (in MILLISECONDS) as a per-call ceiling, capped by the tool's
   * own zod `.max(...)` validator. When `false`/omitted, `input.timeout`
   * is ignored even if present — protects tools that happen to use
   * a `timeout` field with non-ms semantics (request_human_input
   * defines it in seconds, for example) from being aborted at 60ms
   * because the model passed `timeout: 60` meaning seconds.
   *
   * Only bash sets this today. Future tools that adopt a millisecond
   * `timeout` schema can opt in by setting this flag.
   */
  acceptsTimeoutOverride?: boolean;
};

export type LeaderToolResult<T> = {
  data: T;
  contextModifier?: (context: LeaderToolUseContext) => LeaderToolUseContext;
};

export type LeaderPermissionResult = {
  behavior: "allow" | "deny" | "ask";
  message?: string;
  updatedInput?: Record<string, unknown>;
};

export type PreToolUseHookResult = {
  behavior: "allow" | "deny" | "modify";
  message?: string;
  updatedInput?: Record<string, unknown>;
};

export type PreToolUseHook = (
  toolName: string,
  input: Record<string, unknown>,
  context: LeaderToolUseContext
) => Promise<PreToolUseHookResult>;

export type PostToolUseHookResult = {
  modifiedOutput?: unknown;
  message?: string;
};

export type PostToolUseHook = (
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  context: LeaderToolUseContext
) => Promise<PostToolUseHookResult>;

export type LeaderToolUseContext = {
  taskId: string;
  runId: string;
  /**
   * Per-prompt scope identifier. Propagates to spawned teammate runtimes
   * and to checkpoint writes so a crash-recovered run resumes within the
   * same request scope (rather than re-stamping events with a fresh id).
   */
  requestId: string;
  workspaceDir: string;
  abortController: AbortController;
  messages: LeaderMessage[];
  tools: readonly LeaderTool[];
  queryTracking?: QueryChainTracking;
  agentId?: string;
  agentType?: string;
  getInProgressToolUseIDs: () => Set<string>;
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void;
  recordEvent: (event: LeaderLoopEvent) => Promise<void>;
  requestApproval?: (request: LeaderApprovalRequest) => Promise<LeaderApprovalResult>;
  canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<{ behavior: "allow" | "deny" | "ask"; message?: string }>;
  preToolUseHooks?: PreToolUseHook[];
  postToolUseHooks?: PostToolUseHook[];
  callModel?: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>;
  /**
   * Plan mode flag. True iff the leader is currently in PLANNING or
   * AWAITING_APPROVAL state (see `docs/specs/2026-04-26-plan-mode-spec.md`
   * §4). Tools whose `isPlanSafe()` returns false are gated when this
   * is true. Default-false; populated from event-replay during loop
   * init in step 5.
   */
  inPlanMode?: boolean;
  /**
   * 1-indexed leader-loop turn number for the current call. Used by
   * `enter_plan_mode` to stamp `leader.plan_mode_entered` events with
   * a `turnIndex` so the trace can attribute the entry to a specific
   * turn (spec §9). Refreshed on `toolUseContext` per turn.
   */
  turnIndex?: number;
  /**
   * True iff the leader is in AWAITING_APPROVAL specifically (a
   * plan has been submitted and we're waiting on user response).
   * Used by `exit_plan_mode` to reject duplicate calls — without
   * this, an instruction-disobedient model can spam the tool and
   * create multiple PlanCards / dilute the open-plan requestId
   * tracking. Differs from `inPlanMode` which is true for both
   * PLANNING and AWAITING_APPROVAL.
   */
  alreadyAwaitingApproval?: boolean;
  /**
   * True iff the user already approved a plan in this run. The bash
   * danger-command gate (`createApproval` in manager-tools-adapter)
   * should skip when this is set — the user explicitly approved the
   * plan that listed this command, asking again is redundant friction.
   * Set in the leader-loop preflight when a `__PLAN_APPROVED__`
   * sentinel is detected; persists for the rest of the run (process
   * restart resets to false, which is fine — a fresh resume starts in
   * IDLE/AWAITING_APPROVAL until the user acts again).
   */
  planApprovedThisRun?: boolean;
  /**
   * The `tool_use_id` of the in-flight tool call that received this
   * context. Used by `spawn_teammate` to stamp `parentToolUseId` into
   * `leader.teammate_spawned` (and onto every nested teammate event
   * via the projector envelope) so the frontend can pair teammate
   * events to their parent ToolPart with zero cross-event state. Plan
   * v2.1 §Δ.5 / Step 0a — see
   * `docs/plans/2026-05-09-unified-teammate-observability-v2.1.md`.
   *
   * Populated at the call-site in `tool-execution.ts` via spread; not
   * mutation. Nested teammates do NOT inherit the parent's
   * `currentToolUseId` automatically — when a teammate runs its own
   * loop and calls another tool, that tool's call-site re-stamps a
   * fresh value (see Δ.8 for depth-≥2 routing).
   */
  currentToolUseId?: string;
  /** Active execution policy for this turn — threads from LeaderLoopParams. Advisory/telemetry only; no enforcement here. */
  executionPolicy?: ExecutionPolicy;
};

export type LeaderApprovalRequest = {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  message: string;
};

export type LeaderApprovalResult = {
  decision: "approve" | "reject";
  feedback?: string;
};

export type LeaderLoopEvent = {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export type LeaderLoopState = {
  messages: LeaderMessage[];
  toolUseContext: LeaderToolUseContext;
  turnCount: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  transition?: LeaderContinue;
  /** Active execution policy — threaded from LeaderLoopParams. Advisory/telemetry only. */
  executionPolicy?: ExecutionPolicy;
};

export type LeaderContinue = {
  reason:
    | "next_turn"
    | "stop_hook_blocking"
    | "max_output_tokens_recovery"
    | "collapse_drain_retry"
    | "reactive_compact_retry"
    | "max_output_tokens_escalate";
  attempt?: number;
  committed?: number;
};

/**
 * Diagnostic context for the "model returned no text and no tool_use"
 * silent-failure case (originally surfaced as an opaque Chinese
 * fallback string in pickFinalAnswer). Captures what we know about
 * the turn that emitted nothing — most useful field is
 * `lastToolResultLength`, since the typical poison vector is a single
 * gigantic tool result that pushed the model into degenerate output
 * (the 2026-05-03 grep-on-binary incident is the canonical example).
 *
 * `null` means the empty turn had no preceding tool result on this
 * request — usually means the user prompt itself produced an empty
 * response (model bug / refusal / capacity issue), not poisoning.
 */
export type EmptyResponseDiagnostic = {
  contextTokensEstimate: number;
  turnCount: number;
  lastToolName: string | null;
  lastToolResultLength: number | null;
  lastToolWasError: boolean | null;
};

export type LeaderTerminal = {
  reason:
    | "completed"
    | "aborted_streaming"
    | "aborted_tools"
    | "prompt_too_long"
    | "image_error"
    | "model_error"
    | "blocking_limit"
    | "max_turns"
    | "stop_hook_prevented"
    | "hook_stopped";
  turnCount?: number;
  error?: Error;
  /** Set only when the loop terminated on an empty-response turn. */
  emptyResponse?: EmptyResponseDiagnostic;
};

export type LeaderLoopParams = {
  messages: LeaderMessage[];
  systemPrompt: string;
  workspaceDir: string;
  taskId: string;
  runId: string;
  roleId?: string;
  /** Per-prompt scope identifier; threaded through tool context + checkpoints. */
  requestId: string;
  tools: readonly LeaderTool[];
  maxTurns?: number;
  modelOverride?: string;
  abortController: AbortController;
  recordEvent: (event: LeaderLoopEvent) => Promise<void>;
  requestApproval?: (request: LeaderApprovalRequest) => Promise<LeaderApprovalResult>;
  callModel: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>;
  onCheckpoint?: (data: {
    sessionId: string;
    turnCount: number;
    messages: LeaderMessage[];
    executionPolicy?: ExecutionPolicy;
    doomState?: DoomLoopSnapshot;
    terminal?: boolean;
  }) => Promise<void>;
  sessionId?: string;
  autocompactThreshold?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * On resume from a halted plan-mode session, the requestId under
   * which the open `leader.plan_proposed` event was stamped. The loop
   * uses this when emitting `leader.plan_mode_exited` so the projector
   * matches it to the existing PlanPart (which lives in that
   * exchange), instead of stamping the exit event with the resumed
   * loop's fresh requestId — which would land it in a different
   * exchange and leave the PlanCard hanging in `awaiting_approval`.
   * Caller looks this up by scanning durable plan events for the task.
   */
  initialPlanRequestId?: string;
  /**
   * User explicitly toggled "Plan first" for THIS turn (spec §3). When
   * true AND the loop initializes in IDLE, immediately transition to
   * PLANNING and emit a synthetic `leader.plan_mode_entered` so the
   * tool gate is active from turn 1 — without depending on the model
   * obeying the system-prompt instruction to call `enter_plan_mode`.
   * Smaller / less instruction-following models would otherwise
   * silently skip plan mode and fall straight through to write tools.
   */
  planFirst?: boolean;
  /**
   * Optional pre-compact callback. Called BEFORE each LLM autocompact
   * call. Returns extra context strings to append to the summary
   * prompt (e.g. "the agent has previously read these files: ...").
   * If omitted, the loop uses an internal default that surfaces the
   * read-files ledger from execution_events.
   *
   * Errors from this callback are swallowed and logged — compaction
   * proceeds with no extra context rather than failing.
   *
   * Kept as a plain callback rather than a full plugin trigger system
   * since Magister has no plugin scope yet.
   */
  onBeforeCompact?: (input: BeforeCompactInput) => Promise<BeforeCompactResult>;
  /**
   * Optional post-compact callback. Called AFTER a successful LLM
   * autocompact, with the structured result (summaryText,
   * preservedTailTokens, tailStartMessageIdx). Errors swallowed.
   *
   * Post-compact hook; our use case is currently telemetry / artifact
   * persistence, not loop-control.
   */
  onAfterCompact?: (input: AfterCompactInput) => Promise<void>;
  /**
   * Spec §4 — per-turn tool list reload.
   *
   * When provided, the loop calls this callback at the top of each
   * turn to pick up MCP / skill / agent-profile changes made via the
   * UI without requiring task respawn or process restart. The
   * loop content-hashes the returned list against the previous turn's
   * via `hashToolsList`; if unchanged, the previous `tools` array
   * reference is reused byte-for-byte so the provider's prompt cache
   * prefix (system + tools) stays warm.
   *
   * Omitted = static tools for the entire loop (legacy behavior).
   */
  reloadTools?: () => Promise<readonly LeaderTool[]>;
  /** Execution policy classified at intake. Optional — when absent the loop runs without policy telemetry (no enforcement either way). */
  executionPolicy?: ExecutionPolicy;
  /**
   * Resume: start turnCount at this value instead of 1.
   * Allows checkpoint-restore to continue counting turns from where the
   * previous run left off rather than resetting the counter.
   */
  startTurnCount?: number;
  /**
   * Resume: pre-hydrate the doom-loop detector from a prior run's snapshot.
   * Prevents the first N turns of a resumed run from being invisible to the
   * detector (which would reset its sliding window on every resume).
   */
  restoredDoomState?: DoomLoopSnapshot;
};

export type BeforeCompactInput = {
  taskId: string;
  runId: string;
  messages: LeaderMessage[];
  /** The previous summary anchor if one is at messages[0], or null. */
  previousSummary: string | null;
};

export type BeforeCompactResult = {
  /** Strings appended to the summary prompt as extra grounding for
   *  the LLM. Use for ambient facts the model would otherwise lose
   *  in compaction (already-read files, plan items, recent
   *  artifacts, etc.). */
  extraContext?: string[];
};

export type AfterCompactInput = {
  taskId: string;
  runId: string;
  summaryText: string;
  preservedTailTokens: number;
  tailStartMessageIdx: number;
  triggerReason: "hard_cap" | "proactive" | "user_requested";
};

export type LeaderModelCallParams = {
  messages: LeaderMessage[];
  systemPrompt: string;
  tools: readonly LeaderTool[];
  model?: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
};

export type MessageUpdate = {
  message?: LeaderMessage;
  newContext?: LeaderToolUseContext;
};

export type ToolUseBlock = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type Batch = {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
};

export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
