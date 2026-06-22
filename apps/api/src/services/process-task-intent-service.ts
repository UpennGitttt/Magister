import { homedir } from "node:os";

import { eq } from "@magister/db";
import { createDb, getRawSqlite, tasks, roleRuntimes, executionEvents } from "@magister/db";
import type { ProviderConfig, ModelProfile, ExecutorBinding } from "../providers/types";
export type { ProviderConfig, ModelProfile, ExecutorBinding } from "../providers/types";
import type {
  EmptyResponseDiagnostic,
  LeaderLoopEvent,
  LeaderMessage,
} from "./manager-automation/autonomous-loop/autonomous-types";
import { TaskRepository } from "../repositories/task-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { ConversationBindingRepository } from "../repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { getMagisterEnv } from "../lib/env";
import { ChannelSessionService } from "./channel-session-service";
import { LeaderSessionStore } from "./leader-session-store";
import {
  buildLeaderRuntimeModelConfig,
  resolveLeaderRuntimeTools,
  runLeaderRuntime,
  type LeaderRuntimeConfig,
} from "./manager-automation/autonomous-loop/manager-autonomous-runtime";
import {
  resolveLeaderWorkerMode,
  runLeaderRuntimeInWorker,
} from "./leader-runtime-worker-service";
import { createEventProjector } from "./leader-event-projector";
import {
  createInitialLeaderHardeningStatus,
  type LeaderHardeningStatus,
} from "./leader-hardening-status-service";
import { findOpenPlanRequestId } from "./manager-automation/autonomous-loop/plan-mode-state";
import { resolveWorkspaceBaseDir } from "./runtime-workspace-service";
import { createWorktree, removeWorktree } from "./worktree-service";
import { isSafeApplySideEffectEvidenceCandidate } from "./safe-apply/side-effect-evidence-service";
import {
  buildUcmRuntimeSecurity,
  createRuntimeSafeApplyReviewDraft,
} from "./safe-apply/runtime-review-draft-service";
import { resolveExecutionSandboxConfig } from "./safe-apply/execution-sandbox-service";
import {
  readExecutorConfigFile,
  type ExecutorConfigFile,
} from "./executor-config-service";
import {
  agentConfigModelProfileFields,
  resolveAgentForRole,
  type ResolvedAgentConfig,
} from "./agent-resolution-service";
import { getAgentProfile } from "./agent-profile-service";
import {
  appendAgentSkills,
  appendMemoryBlock,
  LEADER_SYSTEM_PROMPT,
} from "./manager-automation/teammate-system-prompts";
import { parseTavilyWebSearchConfigFromEnv } from "./tavily-web-search-service";
import {
  deliverLeaderAnswerToFeishu,
} from "./deliver-feishu-reply-service";
import { wsHub } from "../ws/hub";
import { taskEventBus } from "../sse/task-event-bus";
import { calculateTurnTiming } from "./turn-timing-service";
import {
  classifyExecutionPolicy,
  buildSystemPromptWithPolicy,
  resolveAvailableRoles,
} from "./leader-execution-policy-service";

type ProcessTaskIntentInput = {
  prompt: string;
  source: "cli" | "web" | "feishu";
  workspaceId: string;
  channelBindingId?: string;
  rootChannelBindingId?: string;
  createdBy?: string;
  /** Spec §3, §11: when true, the next leader turn's system prompt
   *  carries a plan-first addendum. Per-message; not persisted. */
  planFirst?: boolean;
  /** User-uploaded attachments for THIS turn (Phase 1: images
   *  only). Each entry is the raw base64 file payload + mime type
   *  + display name. Decoded and persisted to the upload pool by
   *  `attachment-service.saveAttachments`; the leader's user
   *  message for this turn picks them up via
   *  `loadAttachmentBlocksForRequest` and inlines them as `image`
   *  content blocks. */
  attachments?: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
  /** MCP-rendered prompt messages from `POST /mcp/prompts/render`.
   *  Frontend slash menu submits these alongside the typed prompt
   *  text. Projected via `projectPromptMessages` into first-turn
   *  blocks (joined with image attachments) + assistant preamble
   *  (prepended to restoredMessages). Phase 2 of MCP integration. */
  promptMessages?: Array<{ role: "user" | "assistant"; content: any }>;
  /** Goal mode (Ralph loop). When set, the new task is created
   *  with `goal_status='active'` and the worker auto-injects
   *  continuation mailbox rows after each turn until the model
   *  calls `mark_goal_complete`, the user pauses/cancels, or
   *  `maxWallSeconds` is hit. Only honored on new-session creates;
   *  follow-up messages on an existing task ignore this. */
  goal?: {
    objective: string;
    maxWallSeconds?: number;
    /** Soft token budget — when exceeded, the v2 continuation
     *  template injects a "wrap up" steering message rather than
     *  hard-stopping. NULL/omitted = no token cap. */
    tokenBudget?: number;
  };
  /** Spec §5 — when a task is derived from an existing trace
   *  (future: related-task chains, scheduled spawns, recovery-
   *  derived follow-ups), pass the originating trace_id here. The
   *  new task's `trace_id` will inherit it. If omitted, the new
   *  task becomes its own root (trace_id = task.id). */
  parentTraceId?: string;
  /** Planner-side hints from the task manager. Used only to TIGHTEN
   *  the execution policy (never to relax it). See applyHintsTightenOnly. */
  plannerHints?: ManagerHintsPayload;
  /** Task-manager-side hints. Same tighten-only semantics as plannerHints. */
  taskManagerHints?: ManagerHintsPayload;
};

/** Shared hint payload type used by plannerHints and taskManagerHints.
 *  Fields mirror managerHintsSchema in routes/tasks.ts.
 *  exactOptionalPropertyTypes: fields with `| undefined` are intentional here. */
type ManagerHintsPayload = {
  taskType?: "conversation" | "coding" | "mixed" | undefined;
  goal?: string | undefined;
  needsHuman?: boolean | undefined;
  stopCondition?: "reply_sent" | "implementation_ready" | "review_ready" | "landing_ready" | undefined;
  coordinationAction?: "direct_answer" | "tool_answer" | "clarify" | "assign" | "handoff" | "send_message" | undefined;
  childRuns?: Array<{ roleId: string; dependsOn?: string[] | undefined; goal?: string | undefined }> | undefined;
  [key: string]: unknown;
};

export type TaskJob = {
  taskId: string;
  runId: string;
  requestId: string;
  /** Wall-clock moment this user-visible turn was submitted. */
  requestStartedAtMs?: number;
  workspaceId: string;
  prompt: string;
  restoredMessages?: LeaderMessage[];
  channelBindingId?: string;
  previousConversationContext?: string;
  /** Plan-first system-prompt addendum for THIS turn. */
  planFirst?: boolean;
  /** MCP-rendered prompt messages — projected into first-turn blocks
   *  + assistant preamble in executeLeaderLoop. Phase 2. */
  promptMessages?: Array<{ role: "user" | "assistant"; content: any }>;
  /** Planner/taskManager hints — threaded for tighten-only policy classification. */
  plannerHints?: ManagerHintsPayload;
  taskManagerHints?: ManagerHintsPayload;
};

type TaskIntentResult = {
  taskId: string;
  runId: string;
  requestId: string;
  action: "new_session" | "resumed_session";
  reason: string;
  status: "queued" | "completed";
  turnCount?: number;
  finalAnswer?: string;
};

type CheckpointMessage = {
  type: string;
  isMeta?: boolean;
  content?: unknown;
};

/**
 * Pull the assistant's text response for the CURRENT request out of
 * a session checkpoint that may carry many prior prompts/responses.
 *
 * Algorithm:
 *  1. Walk backwards to the LAST non-meta user message — that's the
 *     current request's prompt.
 *  2. Collect assistant text after it (joining if the model emitted
 *     multiple text blocks; "last wins" was the prior bug — when
 *     turn 1 emits tool_use only and turn 2 emits empty content, a
 *     "last wins" walk over the whole checkpoint mistakenly grabbed
 *     a PRIOR prompt's text).
 *  3. Returns `null` when the current request produced no text.
 *     Caller decides whether to fall back to yielded messages or
 *     surface an "(empty model response)" message.
 *
 * Skipped: `isMeta: true` user messages (the [Session Progress] /
 * [Previous conversation summary] blocks the loop injects).
 */
export function extractCurrentRequestAnswer(
  messages: CheckpointMessage[],
): string | null {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.type === "user" && m.isMeta !== true) {
      lastUserIdx = i;
      break;
    }
  }
  // No user prompt found — no current request to extract a response
  // for. Return null so caller can surface a fallback message.
  if (lastUserIdx === -1) return null;
  let answer: string | undefined;
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.type !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        && (block as { text: string }).text.length > 0
      ) {
        answer = (block as { text: string }).text;
      }
    }
  }
  return answer ?? null;
}

/**
 * Pick the finalAnswer to surface for a leader-loop turn that just
 * ended (cleanly or otherwise). The cascade is:
 *
 *   1. Use the latest checkpoint for `runId` ONLY if its
 *      `requestId` matches the current turn — otherwise it's a
 *      stale checkpoint from a prior turn and walking it would
 *      stamp the prior answer onto this turn's task:failed event
 *      ("ghost prompt" bug). Within the matching checkpoint, scope
 *      to messages AFTER the last non-meta user message via
 *      `extractCurrentRequestAnswer`.
 *
 *   2. Fall back to the loop's yielded messages, also scoped via
 *      `extractCurrentRequestAnswer`. This catches the case where
 *      the loop ran but the checkpoint hasn't been persisted yet.
 *      Last-text-wins (the pre-fix behavior) here would also leak
 *      stale answers from prior turns that linger in `result.messages`.
 *
 *   3. Final fallback: model produced no text at all this turn (a
 *      qwen quirk after short tool outputs). Surface a clear retry
 *      message rather than a blank exchange.
 *
 * Pure function so the regression test for the "ghost prompt" bug
 * can pin behavior without spinning up `LeaderSessionStore`,
 * task DB, and the leader runtime.
 */
/**
 * Build a human-readable fallback when the loop terminated on an
 * empty turn. We have a structured diagnostic from the loop telling
 * us what tool result preceded the empty response — the most useful
 * signal is `lastToolResultLength`, since the canonical poison
 * vector is one outsized tool result that pushed the model into
 * degenerate output.
 *
 * The 20_000-char threshold matches Layer 3b's `MAX_RESULT_SIZE_CHARS`
 * grep cap  — any tool result that big has saturated
 * the per-tool defenses, which is the same point at which models
 * empirically start emitting empty responses.
 */
const LARGE_TOOL_RESULT_CHARS = 20_000;

function buildEmptyResponseFallback(diagnostic: EmptyResponseDiagnostic): string {
  const parts: string[] = [
    "The model returned an empty response on this turn (no text, no tool call).",
  ];
  const len = diagnostic.lastToolResultLength;
  if (diagnostic.lastToolName !== null && len !== null) {
    if (len >= LARGE_TOOL_RESULT_CHARS) {
      parts.push(
        `The preceding \`${diagnostic.lastToolName}\` returned ${(len / 1024).toFixed(0)} KB of output — large tool results are a common trigger for empty model turns. Try narrowing the call (a more specific path, head_limit, etc.).`,
      );
    } else if (diagnostic.lastToolWasError) {
      parts.push(
        `The preceding \`${diagnostic.lastToolName}\` call returned an error; the model may have given up rather than recovering. Try rephrasing the request.`,
      );
    } else {
      parts.push(
        `The preceding tool was \`${diagnostic.lastToolName}\` (${len} chars output). Send a follow-up message to nudge the model.`,
      );
    }
  } else {
    parts.push(
      "No prior tool call on this turn — the model produced nothing in response to your prompt directly. Often a transient model-side issue; retrying the same prompt usually works.",
    );
  }
  parts.push(
    `[diagnostic: turn ${diagnostic.turnCount}, ~${(diagnostic.contextTokensEstimate / 1000).toFixed(1)} K tokens in context]`,
  );
  return parts.join(" ");
}

/**
 * P3 — terminal reason → user-visible diagnostic. The leader loop
 * tracks WHY a turn ended (`LeaderTerminal.reason`), but until now
 * the chat surface only saw the model's last text or a generic
 * fallback. When a turn ends abnormally (network drop mid-stream,
 * tool execution aborted, max-turns cap, etc.) the user has no idea
 * what happened — they just see silence.
 *
 * This banner is prepended to the model's text answer when the
 * turn ended for a non-completed reason, OR replaces it entirely
 * when there's no text at all. The model's own text (if any) still
 * shows because we never want to lose useful in-progress
 * communication.
 */
function buildTerminalReasonBanner(
  reason: string | undefined,
  turnCount: number | undefined,
): string | null {
  if (!reason || reason === "completed") return null;
  const turnInfo = turnCount ? ` (turn ${turnCount})` : "";
  switch (reason) {
    case "aborted_streaming":
      return `⚠️ Stream interrupted${turnInfo} — connection dropped or user cancelled mid-response. Retry to continue.`;
    case "aborted_tools":
      return `⚠️ Tool execution aborted${turnInfo} — usually means the run was cancelled. Retry to continue.`;
    case "max_turns":
      return `⚠️ Hit max turn limit${turnInfo}. The model didn't reach a stopping point — increase \`MAGISTER_LEADER_MAX_TURNS\` if this is a long-running task, or review the conversation to see where the loop got stuck.`;
    case "model_error":
      return `❌ Model API error${turnInfo}. The provider returned an error after retries — check the run trace for the underlying cause.`;
    case "prompt_too_long":
      return `❌ Prompt too long${turnInfo}. Conversation history exceeded the model's context window even after compaction. Start a new task or switch to a model with a larger context.`;
    case "image_error":
      return `❌ Image processing failed${turnInfo}. The attached image couldn't be processed by this model — switch to a vision-capable model (e.g. claude-sonnet-4-5, gpt-4o, qwen-vl-plus).`;
    case "blocking_limit":
      return `⚠️ Blocked by safety limit${turnInfo} — likely a doom-loop / repeated tool-call detector. Try a different approach.`;
    case "stop_hook_prevented":
    case "hook_stopped":
      return `⚠️ Run stopped by a configured hook${turnInfo}.`;
    case "plan_awaiting_approval":
      // Plan is submitted; the user just needs to act on it.
      return `📋 Plan submitted${turnInfo} — click **Approve / Revise / Cancel** on the plan card above to continue.`;
    case "plan_cancelled":
      return `🛑 Plan cancelled${turnInfo} — no changes were made. Send a new message to continue.`;
    default:
      return `⚠️ Run ended unexpectedly${turnInfo} (reason: ${reason}).`;
  }
}

export function pickFinalAnswer(input: {
  checkpoint: { requestId: string | null; messages: unknown[] } | null;
  requestId: string;
  yieldedMessages: unknown[];
  emptyResponse?: EmptyResponseDiagnostic;
  /** P3 — when set and not "completed", the loop terminated for a
   *  reason we want the user to see. Banner is prepended to text
   *  answer (if any) or used as the full answer (if not). */
  terminalReason?: string;
  turnCount?: number;
}): string {
  let finalAnswer: string | undefined;

  if (input.checkpoint && input.checkpoint.requestId === input.requestId) {
    const extracted = extractCurrentRequestAnswer(
      input.checkpoint.messages as unknown as CheckpointMessage[],
    );
    if (extracted !== null) finalAnswer = extracted;
  }

  if (!finalAnswer) {
    const extracted = extractCurrentRequestAnswer(
      input.yieldedMessages as unknown as CheckpointMessage[],
    );
    if (extracted !== null) finalAnswer = extracted;
  }

  const banner = buildTerminalReasonBanner(input.terminalReason, input.turnCount);

  if (finalAnswer === undefined || !finalAnswer.trim()) {
    if (banner) {
      // Non-completed reason + no text: surface the banner as the
      // primary answer. If we ALSO have an emptyResponse diagnostic
      // (qwen-style empty-text turn), append it for context.
      finalAnswer = input.emptyResponse
        ? `${banner}\n\n${buildEmptyResponseFallback(input.emptyResponse)}`
        : banner;
    } else {
      finalAnswer = input.emptyResponse
        ? buildEmptyResponseFallback(input.emptyResponse)
        // No diagnostic — the loop finished cleanly but extraction
        // returned nothing. Usually the message log was truncated mid-
        // request or the assistant turn predates our requestId scoping;
        // surface a generic retry message rather than the diagnostic
        // shape (which would be misleading without real data).
        : "The model returned no response for this request. Retry, or send a follow-up message to continue.";
    }
  } else if (banner) {
    // Have text + non-completed reason: prepend the banner so the
    // user knows the run didn't finish cleanly even though there's
    // partial output to read.
    finalAnswer = `${banner}\n\n${finalAnswer}`;
  }
  return finalAnswer;
}

const DEFAULT_FEISHU_LEADER_SESSION_TTL_MS = 30 * 60 * 1000;
const PREVIOUS_CONTEXT_MAX_CHARS = 1200;
// 12-char URL-safe ID. Alphabet is the standard `A-Za-z0-9_-` set (64 chars)
// so each char carries 6 bits → 72 bits of entropy. Spec §7 #2 requires
// nanoid(12); nanoid isn't a dependency here, so the inline impl shapes its
// output identically.
const REQUEST_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Build the user-facing prompt the Ralph loop auto-injects when a
 *  goal-mode turn completes without `mark_goal_complete` being
 *  called. Render-side filters this out of user bubbles by the
 *  `<<goal_continuation>>` sentinel prefix (matches the existing
 *  PLAN_TOKEN_* filtering pattern in render.tsx). */
const GOAL_CONTINUATION_SENTINEL = "<<goal_continuation>>";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Build the goal-mode continuation message that the Ralph loop
 * auto-injects as a user-meta mailbox row after each iteration.
 *
 * Build the structured goal continuation prompt. Wraps the objective
 * in `<untrusted_objective>` tags, surfaces live budget telemetry,
 * embeds plan.md when present, surfaces last evaluator blocker,
 * injects budget steering when soft cap is reached, and enforces
 * completion-audit checklist before mark_goal_complete.
 *
 * Iteration count is intentionally NOT surfaced. Still tracked in DB.
 */
function buildGoalContinuationPrompt(input: {
  objective: string;
  iteration: number;
  elapsedSeconds: number;
  tokensUsed: number;
  wallCapSeconds?: number | null;
  tokenBudget?: number | null;
  planMd?: string | null;
  lastVerifierBlocker?: string | null;
  goalId?: string | null;
  /** User subgoals to surface in the continuation prompt alongside
   *  plan.md's main acceptance criteria. */
  subgoals?: string[] | null;
  /** Pick the objective_updated template instead of normal
   *  continuation for this one iteration. */
  objectiveJustEdited?: boolean;
}): string {
  // Lazy require keeps this file's module-init graph the same as before;
  // the goal-mode subdirectory is a new dependency landing in phase 2.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildGoalContinuationV2 } = require("./goal-mode/continuation-template") as typeof import("./goal-mode/continuation-template");
  return buildGoalContinuationV2({
    objective: input.objective,
    elapsedSeconds: input.elapsedSeconds,
    wallCapSeconds: input.wallCapSeconds ?? null,
    tokensUsed: input.tokensUsed,
    tokenBudget: input.tokenBudget ?? null,
    planMd: input.planMd ?? null,
    lastVerifierBlocker: input.lastVerifierBlocker ?? null,
    goalId: input.goalId ?? null,
    subgoals: input.subgoals ?? null,
    ...(input.objectiveJustEdited ? { objectiveJustEdited: true } : {}),
  });
}

function generateRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const byte of bytes) {
    id += REQUEST_ID_ALPHABET[byte & 63];
  }
  return id;
}

function parseFeishuLeaderSessionTtlMs(): number {
  const parsed = Number(process.env.MAGISTER_LEADER_SESSION_TTL_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_FEISHU_LEADER_SESSION_TTL_MS;
}

function isFeishuSessionExpired(lastInteractionAt: Date | null | undefined, now: Date): boolean {
  if (!lastInteractionAt) {
    return false;
  }
  return now.getTime() - lastInteractionAt.getTime() > parseFeishuLeaderSessionTtlMs();
}

function truncatePreviousContext(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= PREVIOUS_CONTEXT_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, PREVIOUS_CONTEXT_MAX_CHARS)}...`;
}

function extractLatestAssistantText(messages: LeaderMessage[]): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    if (message.type !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        latest = block.text.trim();
      }
    }
  }
  return latest;
}

function readAnswerLikeString(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.finalAnswer,
    record.latestAnswer,
    record.reply,
    record.answer,
    record.summary,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (Array.isArray(record.messages)) {
    const messageAnswer = extractLatestAssistantText(record.messages as LeaderMessage[]);
    if (messageAnswer) {
      return messageAnswer;
    }
  }

  return null;
}

async function resolvePreviousConversationContext(input: {
  taskId: string;
  runId: string;
  sessionStore: LeaderSessionStore;
  eventRepository: ExecutionEventRepository;
}): Promise<string | undefined> {
  const checkpoint = await input.sessionStore.getLatestCheckpoint(input.runId);
  if (checkpoint) {
    const fromCheckpoint = extractLatestAssistantText(checkpoint.messages);
    if (fromCheckpoint) {
      return truncatePreviousContext(fromCheckpoint);
    }
  }

  const events = await input.eventRepository.listByTaskId(input.taskId);
  const sorted = [...events].sort(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
  );

  for (const event of sorted) {
    if (!event.payloadJson) {
      continue;
    }
    try {
      const payload = JSON.parse(event.payloadJson) as unknown;
      const answer = readAnswerLikeString(payload);
      if (answer) {
        return truncatePreviousContext(answer);
      }
    } catch {
      // Best-effort context enrichment only.
    }
  }

  return undefined;
}

/**
 * Spin up a FeishuChatSession for the given (requestId, taskId,
 * bindingId). Resolves verbose level from the channel session;
 * skips entirely on `off`. Idempotent per requestId.
 *
 * Replaces the deleted `feishu-streaming-projector.startStreamingForTask`
 * — the new session class is keyed on REQUEST (not task) so resume
 * turns get their own card.
 */
async function startFeishuSessionForRequest(input: {
  requestId: string;
  taskId: string;
  bindingId: string;
}): Promise<void> {
  const sessionRepo = new ChannelSessionService();
  const channelSession = await sessionRepo.getByBindingId(input.bindingId);
  const verboseLevel = sessionRepo.resolveVerboseLevel(channelSession);
  // The class union allows "off"/"on"/"full"/"low"/"high" but the
  // session class only knows "off"/"low"/"high". Normalize legacy
  // values inline.
  const normalized: "off" | "low" | "high" =
    verboseLevel === "off" ? "off"
      : verboseLevel === "low" || verboseLevel === "on" ? "low"
        : "high";
  if (normalized === "off") return;

  const bindingRepo = new ConversationBindingRepository();
  const binding = await bindingRepo.getById(input.bindingId);
  if (!binding || binding.channel !== "feishu") return;

  const { feishuChatSessionRegistry, buildFeishuClientIfConfigured } = await import(
    "./feishu/feishu-chat-session"
  );
  const client = buildFeishuClientIfConfigured();
  if (!client) return;
  feishuChatSessionRegistry.start({
    requestId: input.requestId,
    taskId: input.taskId,
    bindingId: input.bindingId,
    chatId: binding.chatId,
    verboseLevel: normalized,
    client,
  });
}

async function deliverAsyncFeishuFinalAnswer(input: {
  job: TaskJob;
  finalAnswer?: string;
}): Promise<void> {
  if (!input.job.channelBindingId || !input.finalAnswer?.trim()) {
    return;
  }

  const observability = new LocalObservabilityAdapter();

  try {
    const bindingRepository = new ConversationBindingRepository();
    const binding = await bindingRepository.getById(input.job.channelBindingId);
    if (!binding || binding.channel !== "feishu") {
      return;
    }

    const sessionService = new ChannelSessionService();
    const session = await sessionService.getByBindingId(input.job.channelBindingId);

    // Skip the notification card ONLY if a streaming session actually
    // ran for this requestId — the streaming card already carries the
    // full answer + done footer. If verbose=high but no streaming
    // session was ever started (async-worker code path, or the
    // streaming setup failed silently), still deliver the notification
    // so the user isn't left with no answer at all.
    // Codex re-review P2 — the delivery gate must be consulted REGARDLESS
    // of the current verbose level. If verbose was toggled to "off"
    // mid-turn AFTER a card was already delivered, gating this behind
    // `verboseLevel !== "off"` would skip the check and fire a plain-text
    // fallback despite the delivered card → double-delivery. Move the
    // await + delivered early-return OUTSIDE the verbose guard. (When no
    // session ever started, awaitCardDecision resolves immediately and
    // hasDeliveredCardFor is false, so the no-session path is unchanged.)
    const { feishuChatSessionRegistry } = await import("./feishu/feishu-chat-session");
    // Codex P0: taskEventBus.publish() does NOT await async listeners,
    // so the streaming session's eager createCard + sendCardRef can
    // still be IN FLIGHT here. Await the card-creation DECISION so the
    // hasDeliveredCardFor() read below is authoritative — otherwise we
    // can read it as false mid-flight and double-deliver (card + text).
    await feishuChatSessionRegistry.awaitCardDecision(input.job.requestId);
    if (feishuChatSessionRegistry.hasDeliveredCardFor(input.job.requestId)) {
      return;
    }

    await deliverLeaderAnswerToFeishu({
      bindingId: input.job.channelBindingId,
      workspaceId: binding.workspaceId,
      taskId: input.job.taskId,
      answer: input.finalAnswer,
      chatId: binding.chatId,
      ...(session?.latestInboundMessageId
        ? { replyToMessageId: session.latestInboundMessageId }
        : {}),
    });
  } catch (error) {
    await observability.recordEvent({
      id: `event_${crypto.randomUUID()}`,
      type: "channel.outbound.failed",
      taskId: input.job.taskId,
      conversationBindingId: input.job.channelBindingId,
      workspaceId: input.job.workspaceId,
      severity: "warn",
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        channel: "feishu",
        kind: "leader_answer",
        bindingId: input.job.channelBindingId,
        message:
          error instanceof Error
            ? error.message
            : "Failed to deliver async leader answer to Feishu",
      }),
    });
  }
}

/**
 * Persist + broadcast + bus-publish the terminal event for a sync
 * Feishu task (the sync paths bypass `processTaskExecution`'s full
 * lifecycle). Without this, the `execution_events` table never gets
 * the terminal row → web task-detail replay leaves the exchange stuck
 * "working" forever, even though `tasks.state` is DONE.
 *
 * Mirrors the publication block in `processTaskExecution` (~line 1683
 * onward) but without the timing/MCP-failure-reflection extras that
 * only apply to async-worker runs.
 */
async function publishSyncTerminalEvent(input: {
  taskId: string;
  runId: string;
  requestId: string;
  requestStartedAtMs: number;
  reason: "completed" | "failed" | string;
  finalAnswer?: string;
  errorMessage?: string;
  eventRepository: ExecutionEventRepository;
  taskRepository: TaskRepository;
}): Promise<{ finalState: "DONE" | "FAILED" | "CANCELLED" }> {
  // CANCELLED detection: the /stop route stamps state=CANCELLED before
  // calling ac.abort(). The loop returns reason="aborted_streaming"
  // (NOT "completed"), so without re-reading we'd mis-stamp FAILED on
  // top of the user's CANCELLED — feels like cancel was lost. Mirrors
  // the async-worker path (process-task-intent-service.ts ~line 1483).
  let finalState: "DONE" | "FAILED" | "CANCELLED";
  if (input.reason === "completed") {
    finalState = "DONE";
  } else if (input.reason.startsWith("aborted")) {
    try {
      const cur = await input.taskRepository.getById(input.taskId);
      finalState = cur?.state === "CANCELLED" ? "CANCELLED" : "FAILED";
    } catch {
      finalState = "FAILED";
    }
  } else {
    finalState = "FAILED";
  }
  // Emit `task:cancelled` (NOT `task:failed`) when the user cancelled —
  // FeishuChatSession's terminal handler renders these with distinct
  // footers (⏹ vs ❌) and other consumers can treat them differently.
  const terminalType =
    finalState === "DONE"
      ? "task:completed"
      : finalState === "CANCELLED"
        ? "task:cancelled"
        : "task:failed";
  const terminalTimestamp = new Date().toISOString();
  const completedAtMs = Date.parse(terminalTimestamp);
  // Timing breakdown — async-path parity (the web TaskDetail uses
  // `timing` for the duration badge). Defensive: a failure here
  // shouldn't block the terminal publish.
  let timing: ReturnType<typeof calculateTurnTiming> | undefined;
  try {
    const events = await input.eventRepository.listByTaskIdAndTypes(input.taskId, [
      "leader.approval_requested",
      "leader.approval_resolved",
    ]);
    timing = calculateTurnTiming({
      requestId: input.requestId,
      startedAtMs: input.requestStartedAtMs,
      completedAtMs,
      events,
    });
  } catch {
    /* best-effort */
  }
  const terminalData = {
    taskId: input.taskId,
    requestId: input.requestId,
    state: finalState,
    finalAnswer: input.finalAnswer ?? null,
    ...(input.errorMessage ? { error: input.errorMessage } : {}),
    ...(timing ? { timing } : {}),
  };
  let terminalSeq: number | undefined;
  try {
    terminalSeq = await input.eventRepository.create({
      id: `terminal_${terminalType.replace(":", "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: terminalType,
      taskId: input.taskId,
      roleRuntimeId: input.runId,
      requestId: input.requestId,
      occurredAt: new Date(terminalTimestamp),
      payloadJson: JSON.stringify(terminalData),
    });
  } catch (err) {
    // Persisting is required for web replay, but if the write fails
    // we still want the in-process subscribers (FeishuChatSession) to
    // get the terminal event. Log and fall through.
    // eslint-disable-next-line no-console
    console.warn(
      "[process-task-intent] sync terminal event persist failed:",
      err instanceof Error ? err.message : err,
    );
  }
  const broadcastPayload = {
    type: terminalType,
    requestId: input.requestId,
    data: terminalData,
    timestamp: terminalTimestamp,
    ...(terminalSeq !== undefined ? { seq: terminalSeq } : {}),
  };
  wsHub.broadcast(input.taskId, broadcastPayload);
  taskEventBus.publish(input.taskId, broadcastPayload);
  // M5 Phase 3 failure reflection — parity with async path
  // (process-task-intent-service.ts ~line 1783). Best-effort.
  if (finalState !== "DONE") {
    try {
      const { fireFailureReflection } = await import(
        "./memory/memory-failure-reflection"
      );
      fireFailureReflection({
        kind: "task_failed",
        taskId: input.taskId,
        summary:
          (typeof input.finalAnswer === "string" && input.finalAnswer.length > 0)
            ? input.finalAnswer
            : (input.errorMessage ?? input.reason ?? "task ended in non-completed state"),
      });
    } catch {
      /* best-effort */
    }
  }
  // Clear task-scoped approval trust on terminal so the process-memory
  // ledger doesn't leak.
  try {
    const { clearTaskApprovalTrust } = await import("./command-approval-service");
    clearTaskApprovalTrust(input.taskId);
  } catch { /* best-effort */ }
  return { finalState };
}

function resolveApiConfigFromFile(
  config: ExecutorConfigFile,
  adapterId: string,
): { provider: ProviderConfig; model: ModelProfile; binding: ExecutorBinding } | null {
  const bindingRecord = config.bindings[adapterId];
  if (!bindingRecord) return null;

  const modelRecord = config.models[bindingRecord.modelRef];
  if (!modelRecord) return null;

  const providerRef =
    bindingRecord.providerRef ||
    (bindingRecord.executionMode === "api"
      ? modelRecord.providerRefs?.api
      : modelRecord.providerRefs?.cli);
  if (!providerRef) return null;

  const providerRecord = config.providers[providerRef];
  if (!providerRecord) return null;

  const provider = {
    id: providerRef,
    ...(providerRecord.label ? { label: providerRecord.label } : {}),
    vendor: providerRecord.vendor ?? "unknown",
    transport: providerRecord.transport,
    apiDialect: providerRecord.apiDialect as ProviderConfig["apiDialect"],
    ...(providerRecord.baseUrl ? { baseUrl: providerRecord.baseUrl } : {}),
    auth: providerRecord.auth ?? { kind: "none" as const },
    ...(providerRecord.headers ? { headers: providerRecord.headers } : {}),
    ...(providerRecord.requestOverrides ? { requestOverrides: providerRecord.requestOverrides } : {}),
    ...(providerRecord.quirks ? { quirks: providerRecord.quirks } : {}),
  } as ProviderConfig;

  const model = {
    id: bindingRecord.modelRef,
    ...(modelRecord.label ? { label: modelRecord.label } : {}),
    ...(modelRecord.vendor ? { vendor: modelRecord.vendor } : {}),
    modelName: modelRecord.modelName,
    ...(modelRecord.fallbacks ? { fallbacks: modelRecord.fallbacks } : {}),
    ...(modelRecord.contextWindow ? { contextWindow: modelRecord.contextWindow } : {}),
    ...(modelRecord.maxOutputTokens ? { maxOutputTokens: modelRecord.maxOutputTokens } : {}),
    ...(modelRecord.providerRefs ? { providerRefs: modelRecord.providerRefs } : {}),
    ...(modelRecord.defaultReasoning ? { defaultReasoning: modelRecord.defaultReasoning } : {}),
    ...(modelRecord.requestOverrides ? { requestOverrides: modelRecord.requestOverrides } : {}),
    ...(modelRecord.capabilityHints ? { capabilityHints: modelRecord.capabilityHints } : {}),
  } as ModelProfile;

  const binding: ExecutorBinding = {
    adapterId,
    executionMode: bindingRecord.executionMode,
    modelRef: bindingRecord.modelRef,
    ...(bindingRecord.providerRef ? { providerRef: bindingRecord.providerRef } : {}),
    ...(bindingRecord.timeoutMs ? { timeoutMs: bindingRecord.timeoutMs } : {}),
    ...(bindingRecord.commandPath ? { commandPath: bindingRecord.commandPath } : {}),
    ...(bindingRecord.sandboxMode ? { sandboxMode: bindingRecord.sandboxMode } : {}),
  };

  return { provider, model, binding };
}

function normalizeReasoningMode(
  mode: string | undefined,
): "off" | "auto" | "on" | undefined {
  if (mode === "off" || mode === "auto" || mode === "on") {
    return mode;
  }
  return undefined;
}

function normalizeReasoningEffort(
  effort: string | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  return undefined;
}

export function buildApiConfigFromAgent(
  agentConfig: ResolvedAgentConfig,
): {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  fallbackProvider?: ProviderConfig;
  fallbackModelProfile?: ModelProfile;
} {
  const providerRecord = agentConfig.provider!;

  const toProviderConfig = (record: typeof providerRecord): ProviderConfig => ({
    id: record.id,
    ...(record.label ? { label: record.label } : {}),
    vendor: record.vendor ?? "unknown",
    transport: record.transport,
    apiDialect: record.apiDialect as ProviderConfig["apiDialect"],
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    auth: record.auth ?? { kind: "none" as const },
    ...(record.headers ? { headers: record.headers } : {}),
    ...(record.requestOverrides ? { requestOverrides: record.requestOverrides } : {}),
    ...(record.quirks ? { quirks: record.quirks } : {}),
  }) as ProviderConfig;

  const provider = toProviderConfig(providerRecord);

  // Cross-provider fallback wiring. Surface the fallback provider to
  // the streaming caller so the fallback model gets dispatched to the
  // right baseUrl + auth (otherwise it would POST to the primary's URL).
  const fallbackProviderRecord = agentConfig.fallback?.provider;
  const fallbackProvider =
    fallbackProviderRecord && fallbackProviderRecord.id !== provider.id
      ? toProviderConfig(fallbackProviderRecord)
      : undefined;

  const reasoningMode = normalizeReasoningMode(agentConfig.reasoning?.mode);
  const reasoningEffort = normalizeReasoningEffort(agentConfig.reasoning?.effort);
  const modelId = `${agentConfig.agent.roleId}_agent_binding`;

  // Wire the agent's fallback model into ModelProfile.fallbacks so
  // the streaming caller's retry-down-the-chain path engages.
  const fallbackModelName = agentConfig.fallback?.modelName?.trim();
  const model: ModelProfile = {
    id: modelId,
    modelName: agentConfig.modelName,
    providerRefs: { api: provider.id },
    ...(fallbackModelName && fallbackModelName !== agentConfig.modelName
      ? { fallbacks: [fallbackModelName] }
      : {}),
    // S4 — context/output + capabilityHints (vision) via the shared projection.
    ...agentConfigModelProfileFields(agentConfig),
    ...(reasoningMode
      ? {
          defaultReasoning: {
            mode: reasoningMode,
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          },
        }
      : {}),
  };

  const binding: ExecutorBinding = {
    adapterId: agentConfig.agent.roleId,
    executionMode: "api",
    modelRef: model.id,
    providerRef: provider.id,
  };

  // PR2 wiring: build a real ModelProfile for the fallback from its OWN
  // resolved capability/limits (agentConfig.fallback, populated in
  // agent-resolution from config.models[fallbackModelName]) instead of
  // letting the streaming caller synthesize one from the primary. This is
  // what makes a fallback attempt apply the fallback model's true vision
  // capability (strip images for a text-only fallback) + output limit.
  const fallbackModelProfile: ModelProfile | undefined =
    fallbackModelName && fallbackModelName !== agentConfig.modelName
      ? {
          id: `${modelId}_fallback`,
          modelName: fallbackModelName,
          providerRefs: { api: (fallbackProvider ?? provider).id },
          ...(agentConfig.fallback?.capabilityHints
            ? { capabilityHints: agentConfig.fallback.capabilityHints }
            : {}),
          ...(typeof agentConfig.fallback?.maxOutputTokens === "number"
            ? { maxOutputTokens: agentConfig.fallback.maxOutputTokens }
            : {}),
          ...(typeof agentConfig.fallback?.contextWindow === "number"
            ? { contextWindow: agentConfig.fallback.contextWindow }
            : {}),
        }
      : undefined;

  return {
    provider,
    model,
    binding,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    ...(fallbackModelProfile ? { fallbackModelProfile } : {}),
  };
}

/**
 * Apply a per-task model override to a resolved apiConfig. Swaps the
 * model name and re-derives the provider from the model's
 * `providerRefs.api` so edits to executors.json (moving a model between
 * providers) don't strand tasks on stale provider references.
 *
 * Falls back to the original apiConfig (with a warning) when the
 * override is missing/stale, the override model has no api providerRef,
 * or the provider doesn't exist in config — so a broken override never
 * blocks task execution.
 *
 * The fallback chain is intentionally dropped on override: the
 * agent-level fallback pair is paired with the agent's default model,
 * so carrying it under a different model is misleading.
 *
 * @param apiConfig  The fully-resolved apiConfig (provider + model + binding).
 * @param override   Task's `modelOverride` column. Null/empty = no-op.
 * @param config     Executor config file (provides models + providers maps).
 */
export function applyModelOverrideToApiConfig(
  apiConfig: { provider: ProviderConfig; model: ModelProfile; binding: ExecutorBinding },
  override: string | null | undefined,
  config: ExecutorConfigFile,
): { provider: ProviderConfig; model: ModelProfile; binding: ExecutorBinding } {
  const trimmed = typeof override === "string" ? override.trim() : "";
  if (!trimmed) return apiConfig;

  const modelRecord = config.models[trimmed];
  if (!modelRecord) {
    console.warn(`[model-switch] override "${trimmed}" not in config.models; using default`);
    return apiConfig;
  }
  const providerId = modelRecord.providerRefs?.api;
  if (!providerId) {
    console.warn(`[model-switch] model "${trimmed}" has no providerRefs.api; using default`);
    return apiConfig;
  }
  const providerRecord = config.providers[providerId];
  if (!providerRecord) {
    console.warn(`[model-switch] provider "${providerId}" missing for override "${trimmed}"; using default`);
    return apiConfig;
  }

  const provider: ProviderConfig = {
    id: providerId,
    ...(providerRecord.label ? { label: providerRecord.label } : {}),
    vendor: providerRecord.vendor ?? "unknown",
    transport: providerRecord.transport,
    apiDialect: providerRecord.apiDialect as ProviderConfig["apiDialect"],
    ...(providerRecord.baseUrl ? { baseUrl: providerRecord.baseUrl } : {}),
    auth: providerRecord.auth ?? { kind: "none" as const },
    ...(providerRecord.headers ? { headers: providerRecord.headers } : {}),
    ...(providerRecord.requestOverrides ? { requestOverrides: providerRecord.requestOverrides } : {}),
    ...(providerRecord.quirks ? { quirks: providerRecord.quirks } : {}),
  } as ProviderConfig;

  // Preserve every model-record field except the ones we explicitly
  // re-derive. Notable consumers:
  //   - openai-compat-plugin.ts:343 spreads `modelProfile.requestOverrides`
  //     into the request body (temperature, top_p, etc) — dropping these
  //     silently neuters per-model tuning.
  //   - The streaming caller's retry chain reads `model.fallbacks` —
  //     preserving model-level fallbacks (which belong to the picked
  //     model, NOT the previous agent) gives the override-model its
  //     own fallback chain.
  //   - `defaultReasoning` and `capabilityHints` are surface used by
  //     reasoning gating and vision-attachment checks.
  const model: ModelProfile = {
    id: apiConfig.model.id,
    modelName: trimmed,
    providerRefs: { api: providerId },
    ...(typeof modelRecord.contextWindow === "number"
      ? { contextWindow: modelRecord.contextWindow }
      : {}),
    ...(typeof modelRecord.maxOutputTokens === "number"
      ? { maxOutputTokens: modelRecord.maxOutputTokens }
      : {}),
    ...(modelRecord.label ? { label: modelRecord.label } : {}),
    ...(modelRecord.vendor ? { vendor: modelRecord.vendor } : {}),
    ...(Array.isArray(modelRecord.fallbacks) && modelRecord.fallbacks.length > 0
      ? { fallbacks: modelRecord.fallbacks }
      : {}),
    ...(modelRecord.defaultReasoning ? { defaultReasoning: modelRecord.defaultReasoning } : {}),
    ...(modelRecord.requestOverrides ? { requestOverrides: modelRecord.requestOverrides } : {}),
    ...(modelRecord.capabilityHints ? { capabilityHints: modelRecord.capabilityHints } : {}),
  };

  const binding: ExecutorBinding = {
    ...apiConfig.binding,
    modelRef: model.id,
    providerRef: provider.id,
  };

  console.log(`[model-switch] applied override modelName="${trimmed}" provider="${providerId}" dialect="${providerRecord.apiDialect}"`);
  return { provider, model, binding };
}

export function resolveApiConfigFromRoleRouting(
  config: ExecutorConfigFile,
): { provider: ProviderConfig; model: ModelProfile; binding: ExecutorBinding } | null {
  // `leader` is canonical. `manager` remains a legacy compatibility
  // fallback for old executor config files that have not been migrated.
  const leaderRoute = config.roleRouting.leader ?? config.roleRouting.manager;
  if (leaderRoute) {
    const result = resolveApiConfigFromFile(config, leaderRoute.adapterId);
    if (result) return result;
    console.warn(
      `[role-routing] Route for leader points to adapterId "${leaderRoute.adapterId}" but no matching binding/model/provider found, falling back`,
    );
  }

  // Fall back to first available binding
  for (const adapterId of Object.keys(config.bindings)) {
    const result = resolveApiConfigFromFile(config, adapterId);
    if (result) {
      console.warn(`[role-routing] Using fallback binding "${adapterId}" for role`);
      return result;
    }
  }

  console.warn('[role-routing] No binding found for any adapter');
  return null;
}

export async function processTaskIntent(
  input: ProcessTaskIntentInput,
): Promise<TaskIntentResult> {
  // Lazy import to avoid circular dependency
  const { taskWorker } = await import("./task-worker");

  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionService = new ChannelSessionService();
  const sessionStore = new LeaderSessionStore();
  const executionEventRepository = new ExecutionEventRepository();
  const observability = new LocalObservabilityAdapter();
  const now = new Date();
  const requestId = generateRequestId();

  // Feishu source stays synchronous — its reply delivery depends on finalAnswer
  const isSyncSource = input.source === "feishu";
  let previousConversationContext: string | undefined;

  // 1. Check for active session to resume
  if (input.channelBindingId) {
    const previousSessionSnapshot = await sessionService.getByBindingId(input.channelBindingId);
    await sessionService.ensureForBinding({
      bindingId: input.channelBindingId,
      channel: "feishu",
      workspaceId: input.workspaceId,
    });
    const activeSession = await sessionService.getActiveLeaderSession(input.channelBindingId);
    if (activeSession) {
      const runId = activeSession.sessionId;
      const sessionExpired =
        input.source === "feishu"
          ? isFeishuSessionExpired(previousSessionSnapshot?.updatedAt, now)
          : false;

      if (!sessionExpired) {
        const isActive = await sessionStore.isSessionActive(
          runId,
          previousSessionSnapshot?.updatedAt,
        );
        // Resume even when no checkpoint exists yet — covers the
        // "cancel during turn 1" case where the user clicked Stop
        // before any `leader.session_checkpoint` event landed.
        // Previously isActive=false (no checkpoint = inactive) fell
        // through to creating a new task, jumping the chat UI to a
        // fresh task surface and losing the prior conversation view.
        // Now: if activeSession + non-expired, RESUME with whatever
        // checkpoint we have (may be null → restoredMessages empty;
        // leader starts a new turn on the SAME task surface so the
        // user perceives continuation). Terminal states (DONE / FAILED
        // / CANCELLED) are still resumable here — each resume spawns
        // a fresh leader runtime + AbortController via executeLeaderLoop,
        // so prior cancellation state doesn't carry forward.
        const sessionUsable = isActive || activeSession !== null;
        if (sessionUsable) {
          const checkpoint = await sessionStore.getLatestCheckpoint(runId);
          if (checkpoint || activeSession) {
            const job: TaskJob = {
              taskId: activeSession.taskId,
              runId,
              requestId,
              requestStartedAtMs: now.getTime(),
              workspaceId: input.workspaceId,
              prompt: input.prompt,
              ...(checkpoint ? { restoredMessages: checkpoint.messages } : {}),
              channelBindingId: input.channelBindingId,
              ...(input.planFirst === true ? { planFirst: true } : {}),
              ...(input.plannerHints ? { plannerHints: input.plannerHints } : {}),
              ...(input.taskManagerHints ? { taskManagerHints: input.taskManagerHints } : {}),
            };

            if (isSyncSource) {
              // Feishu resume path: spin up a fresh FeishuChatSession
              // keyed on THIS requestId (not the taskId, since taskId
              // is shared across resume turns). Each user prompt gets
              // its own card; no cross-turn state leakage.
              if (input.source === "feishu" && input.channelBindingId) {
                try {
                  await startFeishuSessionForRequest({
                    requestId,
                    taskId: activeSession.taskId,
                    bindingId: input.channelBindingId,
                  });
                } catch {
                  /* swallow — task continues regardless */
                }
              }
              // Feishu: run synchronously so caller gets finalAnswer
              const result = await executeLeaderLoop(job);
              // Publish the terminal event with FULL lifecycle parity
              // (persist + WS broadcast + bus + CANCELLED detection +
              // timing + failure reflection). Returns the derived
              // finalState so we don't have to re-derive below.
              const { finalState: terminalFinalState } = await publishSyncTerminalEvent({
                taskId: activeSession.taskId,
                runId,
                requestId,
                requestStartedAtMs: now.getTime(),
                reason: result.reason,
                ...(typeof result.finalAnswer === "string" ? { finalAnswer: result.finalAnswer } : {}),
                ...(result.reason !== "completed" ? { errorMessage: "loop exited non-completed" } : {}),
                eventRepository: executionEventRepository,
                taskRepository: taskRepo,
              });
              // Use the finalState the helper derived (already accounts
              // for CANCELLED via re-read). Map to runtime state.
              const finalState = terminalFinalState;
              // DP1: non-atomic terminal write — acceptable race under single-operator threat model; see docs
              await taskRepo.update(activeSession.taskId, {
                state: finalState,
                updatedAt: new Date(),
                completedAt: new Date(),
              });
              await runtimeRepo.update(runId, {
                state:
                  finalState === "DONE"
                    ? "COMPLETED"
                    : finalState === "CANCELLED"
                      ? "CANCELLED"
                      : "FAILED",
                completedAt: new Date(),
                updatedAt: new Date(),
              });
              return {
                taskId: activeSession.taskId,
                runId,
                requestId,
                action: "resumed_session",
                status: "completed",
                ...result,
              };
            }

            // Stamp EXECUTING synchronously BEFORE enqueue. POST /tasks
            // returns immediately and the frontend ChatInput.fetchTasks
            // races the worker — without this the sidebar/header would
            // briefly show the prior turn's terminal state (DONE/PAUSED/
            // FAILED) while live events were already streaming. The
            // worker's processTaskExecution also calls update() on
            // start (defense in depth for crash-recovery requeue), but
            // doing it here too closes the user-visible race window.
            await taskRepo.update(activeSession.taskId, {
              state: "EXECUTING",
              updatedAt: new Date(),
              completedAt: null,
            });
            await runtimeRepo.update(runId, {
              state: "RUNNING",
              updatedAt: new Date(),
              completedAt: null,
            });

            // Async: enqueue and return immediately
            taskWorker.enqueue(job);
            return {
              taskId: activeSession.taskId,
              runId,
              requestId,
              action: "resumed_session",
              reason: "queued",
              status: "queued",
            };
          }
        }
      }

      previousConversationContext = await resolvePreviousConversationContext({
        taskId: activeSession.taskId,
        runId,
        sessionStore,
        eventRepository: executionEventRepository,
      });
    }
  }

  // 2. Create new task and runtime
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runId = `rt_leader_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await taskRepo.create({
    id: taskId,
    workspaceId: input.workspaceId,
    source: input.source,
    title: input.prompt.slice(0, 200),
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    // Spec §5 — root-level trace identifier. Root task uses its own
    // id; derived tasks (future: related-task chains, scheduled spawns)
    // can pass `parentTraceId` on the input to inherit a parent's trace.
    // spawn_teammate doesn't create new tasks today, so this is a
    // single-task tree for now.
    traceId: input.parentTraceId ?? taskId,
    ...(input.rootChannelBindingId ?? input.channelBindingId
      ? { rootChannelBindingId: input.rootChannelBindingId ?? input.channelBindingId }
      : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    // Goal mode (Ralph loop) — persisted on new-session creates
    // only. Follow-up messages on an existing task can't change a
    // task's goal-ness; that's a separate state-management op
    // (PATCH /tasks/:id/goal).
    ...(input.goal
      ? {
          goalObjective: input.goal.objective,
          goalStatus: "active" as const,
          goalStartedAt: now.getTime(),
          goalIterations: 0,
          goalTokensUsed: 0,
          // Mint goal_id + token budget on creation. plan_path is
          // backfilled after initializePlan() returns.
          goalId: crypto.randomUUID(),
          ...(input.goal.maxWallSeconds != null
            ? { goalMaxWallSeconds: input.goal.maxWallSeconds }
            : {}),
          ...(input.goal.tokenBudget != null
            ? { goalTokenBudget: input.goal.tokenBudget }
            : {}),
        }
      : {}),
  });

  // Goal-mode plan-file initialization. Lives after taskRepo.create
  // so we have a persisted row + goal_id. Failure is non-fatal:
  // continuation template degrades gracefully without plan.md.
  if (input.goal) {
    try {
      const createdTask = await taskRepo.getById(taskId);
      const goalId = createdTask?.goalId;
      if (goalId) {
        const { initializePlan, persistPlanLocation } = await import(
          "./goal-mode/plan-file-service"
        );
        const location = await initializePlan({
          taskId,
          workspaceId: input.workspaceId,
          objective: input.goal.objective,
          goalId,
        });
        await persistPlanLocation(taskId, location, goalId);
      }
    } catch (err) {
      await observability.recordEvent({
        id: `event_${crypto.randomUUID()}`,
        type: "goal.plan_init_failed",
        taskId,
        severity: "warn",
        occurredAt: new Date(),
        payloadJson: JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  await observability.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: "task.created",
    taskId,
    occurredAt: now,
    payloadJson: JSON.stringify({ source: input.source, prompt: input.prompt.slice(0, 200) }),
  });

  // Persist any attachments the user uploaded with this prompt
  // (Phase 1: images). Files land under
  // `<cwd>/.magister/uploads/<taskId>/`; metadata rows index by
  // (taskId, requestId). The leader runtime later loads these
  // back via `loadAttachmentBlocksForRequest` and inlines them
  // as `LeaderContentBlock[]` in the first user message.
  if (input.attachments && input.attachments.length > 0) {
    const { saveAttachments } = await import("./attachment-service");
    const { rejected } = await saveAttachments(taskId, requestId, input.attachments);
    if (rejected.length > 0) {
      // Don't abort task creation — surface rejections in an
      // event so the dashboard can show the user which files
      // were dropped without killing the prompt itself.
      await observability.recordEvent({
        id: `event_${crypto.randomUUID()}`,
        type: "task.attachment_rejected",
        taskId,
        occurredAt: new Date(),
        severity: "warn",
        payloadJson: JSON.stringify({ rejected, requestId }),
      });
    }
  }

  // No "正在处理" processing-notification card here. The single-card
  // streaming session (started below via startFeishuSessionForRequest)
  // eager-creates a "⏳ Thinking…" card as the sole, immediate outbound
  // acknowledgement, then streams in place (Task 8 / S9). The old
  // processing card produced a redundant second card per turn.

  // 3. Track session on channel binding — MUST run before the
  // streaming projector starts. The projector resolves the binding
  // via `channel_sessions.currentTaskId`; setting that pointer here
  // is what makes resolveTaskBinding(taskId) actually find a match.
  // Earlier ordering had the projector running first and silently
  // returning early because no channel session pointed at the task
  // yet.
  if (input.channelBindingId) {
    await sessionService.ensureForBinding({
      bindingId: input.channelBindingId,
      channel: "feishu",
      workspaceId: input.workspaceId,
      currentTaskId: taskId,
    });
    await sessionService.recordLeaderSession({
      bindingId: input.channelBindingId,
      currentLeaderSessionId: runId,
      currentTaskId: taskId,
    });
  }

  if (input.source === "feishu" && input.channelBindingId) {
    // Start the FeishuChatSession AFTER the channel session pointer
    // is set (the session looks up `currentTaskId` for verbose level
    // + chat resolution). Keyed on requestId so each prompt gets a
    // fresh card, even when taskId is reused across resume turns.
    try {
      await startFeishuSessionForRequest({
        requestId,
        taskId,
        bindingId: input.channelBindingId,
      });
    } catch (err) {
      await observability.recordEvent({
        id: `event_${crypto.randomUUID()}`,
        type: "feishu.session.start_failed",
        taskId,
        conversationBindingId: input.channelBindingId,
        workspaceId: input.workspaceId,
        severity: "warn",
        occurredAt: new Date(),
        payloadJson: JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  const job: TaskJob = {
    taskId,
    runId,
    requestId,
    requestStartedAtMs: now.getTime(),
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    ...(input.channelBindingId ? { channelBindingId: input.channelBindingId } : {}),
    ...(previousConversationContext ? { previousConversationContext } : {}),
    ...(input.planFirst === true ? { planFirst: true } : {}),
    ...(input.promptMessages && input.promptMessages.length > 0
      ? { promptMessages: input.promptMessages }
      : {}),
    ...(input.plannerHints ? { plannerHints: input.plannerHints } : {}),
    ...(input.taskManagerHints ? { taskManagerHints: input.taskManagerHints } : {}),
  };

  if (isSyncSource) {
    // Feishu: run synchronously so caller gets finalAnswer for reply delivery
    const result = await executeLeaderLoop(job);
    // Full-lifecycle terminal publish (persist + broadcast + bus +
    // CANCELLED detection + timing + failure reflection). Returns the
    // derived finalState — use it to keep tasks/runtime rows aligned
    // with what was published.
    const { finalState } = await publishSyncTerminalEvent({
      taskId,
      runId,
      requestId,
      requestStartedAtMs: now.getTime(),
      reason: result.reason,
      ...(typeof result.finalAnswer === "string" ? { finalAnswer: result.finalAnswer } : {}),
      ...(result.reason !== "completed" ? { errorMessage: "loop exited non-completed" } : {}),
      eventRepository: executionEventRepository,
      taskRepository: taskRepo,
    });

    // DP1: non-atomic terminal write — acceptable race under single-operator threat model; see docs
    await taskRepo.update(taskId, {
      state: finalState,
      updatedAt: new Date(),
      completedAt: new Date(),
    });
    await runtimeRepo.update(runId, {
      state:
        finalState === "DONE"
          ? "COMPLETED"
          : finalState === "CANCELLED"
            ? "CANCELLED"
            : "FAILED",
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      taskId,
      runId,
      requestId,
      action: "new_session",
      status: "completed",
      ...result,
    };
  }

  // Async: enqueue and return immediately
  taskWorker.enqueue(job);

  return {
    taskId,
    runId,
    requestId,
    action: "new_session",
    reason: "queued",
    status: "queued",
  };
}

/**
 * Background execution entry point called by TaskWorker.
 * Runs the leader loop and updates task/runtime state on completion.
 */
export async function processTaskExecution(job: TaskJob): Promise<void> {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const executionStartedAtMs = Date.now();
  const requestStartedAtMs = job.requestStartedAtMs ?? executionStartedAtMs;

  const buildTiming = async (completedAtMs: number) => {
    try {
      const events = await executionEventRepository.listByTaskIdAndTypes(job.taskId, [
        "leader.approval_requested",
        "leader.approval_resolved",
      ]);
      return calculateTurnTiming({
        requestId: job.requestId,
        startedAtMs: requestStartedAtMs,
        completedAtMs,
        events,
      });
    } catch (err) {
      console.warn(
        "[turn-timing] Failed to load execution events for timing:",
        err instanceof Error ? err.message : String(err),
      );
      return calculateTurnTiming({
        requestId: job.requestId,
        startedAtMs: requestStartedAtMs,
        completedAtMs,
        events: [],
      });
    }
  };

  // Cancel-while-queued race: if the user clicked Cancel before
  // taskWorker.processNext picked this job up (no AC was registered
  // yet, so ac.abort() in the cancel route no-op'd), the cancel
  // route's `state=CANCELLED` is the only signal we have. Without
  // this short-circuit, the EXECUTING write below would overwrite
  // CANCELLED and the loop would run as if nothing had happened.
  const preExisting = await taskRepo.getById(job.taskId);
  if (preExisting?.state === "CANCELLED") {
    await runtimeRepo.update(job.runId, {
      state: "CANCELLED",
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    return;
  }

  // Reset state to EXECUTING for the duration of this run. New tasks
  // are already created with state="EXECUTING" in the new-session
  // branch, but follow-up turns on existing tasks (DONE / PAUSED /
  // FAILED from a prior run) used to skip this — leaving the chat
  // header / sidebar showing the stale terminal state while the loop
  // emitted live events. Final state is written below in the
  // try/catch tail (DONE / PAUSED / FAILED).
  await taskRepo.update(job.taskId, {
    state: "EXECUTING",
    updatedAt: new Date(),
    completedAt: null,
  });
  await runtimeRepo.update(job.runId, {
    state: "RUNNING",
    updatedAt: new Date(),
    completedAt: null,
  });

  try {
    const result = await executeLeaderLoop(job);

    // Detect plan-mode halt: leader exit_plan_mode submits a plan,
    // halts naturally (turn ends with no further tool_use), and
    // returns `reason: "completed"`. Marking the task DONE in that
    // state is misleading — the task is WAITING ON USER APPROVAL,
    // not finished. Use PAUSED so the UI shows it as halted, and
    // skip `completedAt` so reentry recovery doesn't think it
    // crossed a terminal boundary.
    //
    // Per-turn signal: THIS run's `leader.session_complete.reason`. The
    // loop explicitly emits `plan_awaiting_approval` when it halted at
    // AWAITING_APPROVAL after `exit_plan_mode` and emits `plan_cancelled`
    // when the cancel hard-stop fired. Any other reason (or no
    // session_complete at all — the natural turn_complete path doesn't
    // emit one) means the loop made forward progress and this turn is
    // genuinely done, even if a stale `plan_proposed` from an earlier
    // turn never got matched with a `plan_mode_exited` (e.g. the model
    // ignored the plan and proceeded directly on a less-instruction-
    // following provider).
    let haltedAwaitingApproval = false;
    if (result.reason === "completed") {
      try {
        const sessionCompleteEvents = await executionEventRepository.listByTaskIdAndType(
          job.taskId,
          "leader.session_complete",
          20,
        );
        const thisTurnSessionComplete = sessionCompleteEvents
          .find(
            (e) =>
              e.type === "leader.session_complete"
              && e.requestId === job.requestId,
          );
        if (thisTurnSessionComplete?.payloadJson) {
          try {
            const payload = JSON.parse(thisTurnSessionComplete.payloadJson) as { reason?: string };
            haltedAwaitingApproval = payload.reason === "plan_awaiting_approval";
          } catch {
            // Malformed payload — fall back to DONE.
          }
        }
      } catch {
        // Best-effort lookup — fall back to DONE if the read fails.
      }
    }

    // Cancel detection: the cancel route stamps state=CANCELLED before
    // calling ac.abort(). The loop returns reason="aborted_streaming"
    // (NOT "completed"), so without this branch we'd write "FAILED" and
    // overwrite the user-visible CANCELLED — feels like cancel was lost.
    // Re-read state at the end to detect this.
    let userCancelled = false;
    if (result.reason && result.reason.startsWith("aborted")) {
      try {
        const cur = await taskRepo.getById(job.taskId);
        userCancelled = cur?.state === "CANCELLED";
      } catch {
        // Best-effort — fall through to FAILED if lookup fails.
      }
    }

    const baseFinalState: "DONE" | "FAILED" | "PAUSED" | "CANCELLED" = haltedAwaitingApproval
      ? "PAUSED"
      : userCancelled
      ? "CANCELLED"
      : result.reason === "completed"
      ? "DONE"
      : "FAILED";

    type FinalState = "DONE" | "FAILED" | "PAUSED" | "CANCELLED" | "AWAITING_TEAMMATES";

    // ── Ralph loop hook ─────────────────────────────────────────
    // Goal mode: when a task carries a `goal_objective` and the
    // turn finished cleanly (model emitted no further tool_use) but
    // the model didn't call `mark_goal_complete`, auto-write a
    // continuation mailbox message and re-enqueue. This is the
    // outer Ralph loop — the inner leader loop sees the new
    // mailbox row on the next turn the same way it sees a typed
    // user follow-up. No new top-level loop.
    let finalState: FinalState = baseFinalState;
    let ralphReenqueued = false;
    if (baseFinalState === "DONE") {
      // Active background teammates take precedence over Ralph: if any
      // are still running or have pending completion mailbox rows, let
      // them finish first. Their completion injection re-enqueues the
      // leader; on that next turn, Ralph can fire again if the goal is
      // still active and the model didn't call mark_goal_complete.
      // Without this guard, Ralph would self-enqueue past
      // AWAITING_TEAMMATES — the second enqueue would no-op (queue
      // dedup) and the teammate completion would lose its wake signal.
      let hasPendingBackground = false;
      try {
        const activeTeammates = await runtimeRepo.listActiveBackgroundTeammates(job.taskId);
        const { TaskMailboxRepository: MailboxRepo } = await import("../repositories/task-mailbox-repository");
        const pendingCompletions = await new MailboxRepo()
          .countUnconsumedTeammateCompletions(job.taskId);
        hasPendingBackground = activeTeammates.length > 0 || pendingCompletions > 0;
      } catch {
        // Best-effort — if lookup fails, fall through (Ralph may fire,
        // worst case we get a duplicate enqueue which is itself a no-op).
      }

      const taskAfter = await taskRepo.getById(job.taskId);
      const goalActive = taskAfter?.goalObjective && taskAfter.goalStatus === "active";

      if (goalActive && !hasPendingBackground) {
        const startedAt = taskAfter.goalStartedAt ?? Date.now();
        const wallSeconds = Math.floor((Date.now() - startedAt) / 1000);
        const wallExceeded =
          taskAfter.goalMaxWallSeconds != null
          && wallSeconds >= taskAfter.goalMaxWallSeconds;
        // Token budget hard stop. Continuation template steers at
        // 0.85x and warns at 1.0x. If the model keeps going past
        // 1.5x without calling mark_goal_complete, treat as runaway.
        const BUDGET_HARD_STOP_RATIO = 1.5;
        const tokenBudgetExceeded =
          taskAfter.goalTokenBudget != null
          && taskAfter.goalTokenBudget > 0
          && (taskAfter.goalTokensUsed ?? 0)
            >= taskAfter.goalTokenBudget * BUDGET_HARD_STOP_RATIO;

        if (wallExceeded || tokenBudgetExceeded) {
          // Hard safety: out of wall-time OR token budget. Cancel the goal
          // (not the task — task itself completed its turn fine).
          const exceededAt = new Date();
          await taskRepo.update(job.taskId, {
            goalStatus: "cancelled",
            goalCompletedAt: exceededAt.getTime(),
            updatedAt: exceededAt,
          });
          // Record an event so dashboards can distinguish wall vs
          // budget cancels from user-initiated ones.
          await executionEventRepository.create({
            id: `event_${crypto.randomUUID()}`,
            type: "goal.budget_exhausted",
            taskId: job.taskId,
            severity: "warn",
            occurredAt: exceededAt,
            payloadJson: JSON.stringify({
              reason: wallExceeded ? "wall_time" : "token_budget",
              wallSeconds,
              wallCapSeconds: taskAfter.goalMaxWallSeconds ?? null,
              tokensUsed: taskAfter.goalTokensUsed ?? 0,
              tokenBudget: taskAfter.goalTokenBudget ?? null,
              iterations: taskAfter.goalIterations ?? 0,
            }),
          });
          // finalState stays DONE — the task ran a clean turn; the
          // goal just exhausted its budget. UI surfaces this via
          // goal_status, not task state.
        } else {
          // Continuation: write a mailbox row, re-enqueue.
          const { TaskMailboxRepository } = await import(
            "../repositories/task-mailbox-repository"
          );
          const mailbox = new TaskMailboxRepository();
          const nextIter = (taskAfter.goalIterations ?? 0) + 1;
          // Pull plan.md so the model sees the
          // current acceptance-criteria + iteration log embedded in
          // the continuation. NULL when the plan-init hook failed or
          // the file got deleted; the template handles that case.
          let planMd: string | null = null;
          if (taskAfter.workspaceId) {
            try {
              const { readPlan } = await import("./goal-mode/plan-file-service");
              planMd = await readPlan(job.taskId, taskAfter.workspaceId);
            } catch {
              // Silent — degrade to no plan section. The continuation
              // still works without the plan.
            }
          }
          // Surface the last evaluator BLOCKED reason ONCE, then clear.
          // Surfacing every iteration would loop on stale critique.
          const lastVerifierBlocker =
            taskAfter.goalLastVerifierVerdict === "BLOCKED"
              ? (taskAfter.goalLastVerifierBlocker ?? null)
              : null;
          if (lastVerifierBlocker) {
            // Mirror the blocker into plan.md's iteration log so the
            // human + future evaluator runs see the trail.
            if (taskAfter.workspaceId) {
              try {
                const { appendBlocker } = await import("./goal-mode/plan-file-service");
                await appendBlocker(
                  job.taskId,
                  taskAfter.workspaceId,
                  nextIter,
                  lastVerifierBlocker,
                );
              } catch {
                // Best-effort.
              }
            }
            try {
              const { clearVerdict } = await import("./goal-mode/evaluator-verifier-service");
              await clearVerdict(job.taskId);
            } catch {
              // Best-effort.
            }
          }
          // Surface any user-added subgoals as "Additional criteria".
          const { parseSubgoals } = await import("./goal-mode/subgoal-service");
          const subgoals = parseSubgoals(taskAfter.goalSubgoals ?? null);
          // If the user edited the objective since the last turn, render
          // the objective_updated template for this iteration only.
          const objectiveJustEdited = typeof taskAfter.goalObjectiveEditedAt === "number"
            && taskAfter.goalObjectiveEditedAt > 0;
          const continuationMsg = buildGoalContinuationPrompt({
            objective: taskAfter.goalObjective!,
            iteration: nextIter,
            elapsedSeconds: wallSeconds,
            tokensUsed: taskAfter.goalTokensUsed ?? 0,
            wallCapSeconds: taskAfter.goalMaxWallSeconds ?? null,
            tokenBudget: taskAfter.goalTokenBudget ?? null,
            planMd,
            lastVerifierBlocker,
            goalId: taskAfter.goalId ?? null,
            subgoals: subgoals.length > 0 ? subgoals : null,
            ...(objectiveJustEdited ? { objectiveJustEdited: true } : {}),
          });
          await mailbox.create({
            id: `msg_goal_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
            taskId: job.taskId,
            sender: "user",
            content: continuationMsg,
            createdAt: new Date(),
          });
          await taskRepo.update(job.taskId, {
            goalIterations: nextIter,
            // Clear the objective-edited trigger after consuming it.
            ...(objectiveJustEdited ? { goalObjectiveEditedAt: null } : {}),
            updatedAt: new Date(),
          });
          // Fresh-context per iteration. Rewrite the latest checkpoint
          // with a trimmed message tail so the next leader run resumes
          // with only the last few turns + a conversation summary
          // anchor pointing the model at plan.md. plan.md is
          // already embedded in the continuation message above,
          // so dropping older turns loses no durable knowledge.
          // MAGISTER_GOAL_FRESH_CONTEXT=0 opts out.
          try {
            const { LeaderSessionStore } = await import("./leader-session-store");
            const { trimForFreshContext, isFreshContextEnabled } = await import(
              "./goal-mode/fresh-context-service"
            );
            if (isFreshContextEnabled()) {
              const store = new LeaderSessionStore();
              const ckpt = await store.getLatestCheckpoint(job.runId);
              if (ckpt) {
                const trim = trimForFreshContext(ckpt.messages, { tailTurns: 3 });
                if (trim.trimmed) {
                  await store.writeCheckpoint({
                    sessionId: ckpt.sessionId,
                    taskId: job.taskId,
                    runId: job.runId,
                    requestId: ckpt.requestId ?? generateRequestId(),
                    turnCount: ckpt.turnCount,
                    messages: trim.messages,
                    // Pass through the completeness fields — otherwise this
                    // fresh-context rewrite downgrades a complete checkpoint
                    // into a legacy-shaped one (latest wins), so resume would
                    // reclassify policy and reset the doom-loop window.
                    ...(ckpt.executionPolicy !== undefined
                      ? { executionPolicy: ckpt.executionPolicy }
                      : {}),
                    ...(ckpt.doomState !== undefined ? { doomState: ckpt.doomState } : {}),
                  });
                }
              }
            }
          } catch {
            // Fresh-context trim is best-effort. The next iteration
            // will run with full accumulated context if this fails
            // — same as pre-phase-5 behavior.
          }
          // Re-enqueue: same runId, same workspaceId, no prompt
          // (the loop will pull the mailbox we just wrote). State
          // stays EXECUTING — don't transition to DONE.
          //
          // Use `requeueAfterCurrent` (NOT `enqueue`) — we're still
          // inside the worker's `runOne` for this taskId, so
          // `active.has(taskId)` is true and a synchronous `enqueue`
          // gets silently dropped by the idempotency guard. The
          // deferred variant fires after the active-set release in
          // `runOne.finally`.
          const { taskWorker } = await import("./task-worker");
          taskWorker.requeueAfterCurrent({
            taskId: job.taskId,
            runId: job.runId,
            requestId: generateRequestId(),
            requestStartedAtMs: Date.now(),
            workspaceId: job.workspaceId,
            prompt: "", // mailbox supplies the actual prompt
            ...(job.channelBindingId ? { channelBindingId: job.channelBindingId } : {}),
          });
          ralphReenqueued = true;
        }
      }
    }
    if (ralphReenqueued) {
      // The next worker tick (just-enqueued job) re-stamps state
      // EXECUTING and runs another turn. Leave the runtime row
      // alone too — it stays RUNNING because the same runId is
      // continuing.
      return;
    }
    // ─────────────────────────────────────────────────────────────

    // ── Async teammate check ─────────────────────────────────────
    // If the leader turn ended cleanly (DONE) but there are still
    // background teammates running (spawned with wait: false), the task
    // is not actually finished — it is waiting for those teammates.
    // Transition to AWAITING_TEAMMATES instead of DONE so the UI shows
    // the task as still live and the completion injector can wake it.
    // AWAITING_TEAMMATES is NOT a terminal state; do not add it to
    // TERMINAL_TASK_STATES anywhere.
    if (finalState === "DONE") {
      try {
        const activeTeammates = await runtimeRepo.listActiveBackgroundTeammates(job.taskId);
        // Race fix: also count unconsumed teammate-completion mailbox
        // rows. A teammate that finished after the leader's turn started
        // but before the turn ended would already have role_runtime set
        // to COMPLETED (so listActiveBackgroundTeammates returns 0) BUT
        // its mailbox row may not yet be processed. Without this check,
        // the task would transition to DONE and the completion injection
        // would be orphaned (reenqueue is no-op for DONE state).
        const { TaskMailboxRepository: MailboxRepo } = await import("../repositories/task-mailbox-repository");
        const pendingCompletions = await new MailboxRepo()
          .countUnconsumedTeammateCompletions(job.taskId);
        if (activeTeammates.length > 0 || pendingCompletions > 0) {
          finalState = "AWAITING_TEAMMATES";
        }
      } catch (err) {
        // Best-effort — if lookup fails, fall through to DONE.
        console.warn(
          `[process-task] Background teammate check failed for ${job.taskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // ─────────────────────────────────────────────────────────────

    // Goal cleanup on terminal failure / cancel: if the turn ended
    // FAILED or CANCELLED while a goal was still active, the goal
    // would be left orphaned (status=active forever even though
    // the task is dead). Sync goal_status to a matching terminal
    // value so the UI doesn't show "Active goal" on a FAILED task.
    let goalCleanupPatch: { goalStatus?: "cancelled"; goalCompletedAt?: number } = {};
    if (finalState === "FAILED" || finalState === "CANCELLED") {
      const taskBeforeTerminal = await taskRepo.getById(job.taskId);
      if (
        taskBeforeTerminal?.goalObjective
        && taskBeforeTerminal.goalStatus === "active"
      ) {
        goalCleanupPatch = { goalStatus: "cancelled", goalCompletedAt: Date.now() };
      }
    }

    // Treat PAUSED like a "completed turn" for the wire — the FRONTEND
    // needs to mark the exchange complete (clear thinking dots, allow
    // PlanCard to render approve buttons). The task itself is in
    // PAUSED state per the DB write above; no `task:paused` wire type
    // is needed because the SessionList renders `task.state` directly.
    // CANCELLED gets its own `task:cancelled` event so consumers can
    // distinguish a user-initiated stop from a model/runtime failure
    // (Feishu chat session renders these with ⏹ vs ❌ footer).
    const terminalType =
      finalState === "DONE" || finalState === "PAUSED" || finalState === "AWAITING_TEAMMATES"
        ? "task:completed"
        : finalState === "CANCELLED"
          ? "task:cancelled"
          : "task:failed";
    const terminalTimestamp = new Date().toISOString();
    const terminalCompletedAtMs = Date.parse(terminalTimestamp);
    const terminalTiming = await buildTiming(terminalCompletedAtMs);
    const terminalData = {
      taskId: job.taskId,
      requestId: job.requestId,
      state: finalState,
      finalAnswer: result.finalAnswer ?? null,
      timing: terminalTiming,
    };

    // DP1: PRIMARY ASYNC TERMINAL WRITE — atomic transaction.
    // task-state update + runtime-state update + terminal-event insert
    // are committed together so a mid-flight process death cannot leave
    // the task terminal without its runtime/event (or vice-versa).
    //
    // Implementation note: drizzle-orm's bun-sqlite driver is synchronous
    // (BaseSQLiteDatabase<'sync', ...>). Its `db.transaction(async cb)`
    // overload does NOT wait for async callbacks — it runs them synchronously
    // and the SQLite native transaction commits before any awaited microtasks
    // fire. To get real atomicity we use the raw bun:sqlite
    // `database.transaction(() => {...})` wrapper (synchronous) with drizzle's
    // synchronous `.run()` call on each statement. The seq is pre-allocated
    // via `allocSeq()` (pure in-memory increment) before the transaction so it
    // is available inside the sync callback.
    //
    // Persist the terminal event so the snapshot replay sees it AND so we
    // get a stable `seq` to stamp on the broadcast payloads. Without seq,
    // the frontend chatStore (PR 2) can't dedup terminal events properly
    // and would silently drop them — leaving exchanges stuck "streaming".
    const terminalEventId = `terminal_${terminalType.replace(":", "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Pre-allocate the seq before entering the synchronous transaction so
    // the in-memory counter advances atomically with the insert.
    const terminalSeq = await executionEventRepository.allocSeq();
    const taskUpdatePayload = {
      state: finalState,
      updatedAt: new Date(),
      // Only stamp completedAt for terminal states, not for plan-mode
      // pauses, Ralph re-enqueues, or AWAITING_TEAMMATES (task is still
      // live — we'll write completedAt when it eventually reaches DONE).
      ...(finalState === "PAUSED" || finalState === "AWAITING_TEAMMATES"
        ? {}
        : { completedAt: new Date() }),
      ...goalCleanupPatch,
    };
    const runtimeUpdatePayload = {
      state:
        finalState === "DONE" || finalState === "AWAITING_TEAMMATES"
          ? "COMPLETED"
          : finalState === "PAUSED"
          ? "PAUSED"
          : finalState === "CANCELLED"
          ? "CANCELLED"
          : "FAILED",
      ...(finalState === "PAUSED" ? {} : { completedAt: new Date() }),
      updatedAt: new Date(),
    };
    const terminalEventRow = {
      id: terminalEventId,
      type: terminalType,
      taskId: job.taskId,
      roleRuntimeId: job.runId,
      requestId: job.requestId,
      occurredAt: new Date(terminalTimestamp),
      payloadJson: JSON.stringify(terminalData),
      seq: terminalSeq,
    };
    // Execute all three writes inside one native SQLite transaction.
    // `.run()` is the synchronous execution path on each drizzle statement;
    // it runs immediately inside the native callback without a microtask hop.
    // `as any` casts are needed because Drizzle's set/values types are strict
    // about nullable columns that differ from the inferred payload type — the
    // runtime shape is correct (repo methods accept the same object shapes).
    const db = createDb();
    const sqlite = getRawSqlite();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sqlite.transaction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.update(tasks).set(taskUpdatePayload as any).where(eq(tasks.id, job.taskId)).run();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.update(roleRuntimes).set(runtimeUpdatePayload as any).where(eq(roleRuntimes.id, job.runId)).run();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.insert(executionEvents).values(terminalEventRow as any).run();
    })();

    await deliverAsyncFeishuFinalAnswer({
      job,
      ...(result.finalAnswer !== undefined ? { finalAnswer: result.finalAnswer } : {}),
    });
    wsHub.broadcast(job.taskId, {
      type: terminalType,
      requestId: job.requestId,
      data: terminalData,
      timestamp: terminalTimestamp,
      seq: terminalSeq,
    });
    // M5 Phase 3 — failure reflection on the GRACEFUL terminal path
    // (loop returned with finalState=FAILED rather than throwing).
    // The catch block below covers the throw path; this hook covers
    // the case where the loop politely surfaced a failure reason
    // (maxTurns, model error, abort, etc.).
    if (finalState === "FAILED") {
      try {
        const { fireFailureReflection } = await import(
          "./memory/memory-failure-reflection"
        );
        fireFailureReflection({
          kind: "task_failed",
          taskId: job.taskId,
          summary:
            typeof result.finalAnswer === "string" && result.finalAnswer.length > 0
              ? result.finalAnswer
              : (result.reason ?? "task ended in FAILED state"),
        });
      } catch {
        // Best-effort.
      }
    }

    taskEventBus.publish(job.taskId, {
      type: terminalType,
      requestId: job.requestId,
      data: terminalData,
      timestamp: terminalTimestamp,
      seq: terminalSeq,
    });

    // Drop the task's approval trust ledger on terminal. Best-effort.
    try {
      const { clearTaskApprovalTrust } = await import("./command-approval-service");
      clearTaskApprovalTrust(job.taskId);
    } catch { /* best-effort */ }
  } catch (err) {
    // DP1: non-atomic terminal write — acceptable race under single-operator threat model; see docs
    await taskRepo.update(job.taskId, {
      state: "FAILED",
      updatedAt: new Date(),
      completedAt: new Date(),
    });
    await runtimeRepo.update(job.runId, {
      state: "FAILED",
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    const failTimestamp = new Date().toISOString();
    const failCompletedAtMs = Date.parse(failTimestamp);
    const failData = {
      taskId: job.taskId,
      requestId: job.requestId,
      state: "FAILED",
      error: err instanceof Error ? err.message : String(err),
      timing: await buildTiming(failCompletedAtMs),
    };
    const failSeq = await executionEventRepository.create({
      id: `terminal_task_failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "task:failed",
      taskId: job.taskId,
      roleRuntimeId: job.runId,
      requestId: job.requestId,
      occurredAt: new Date(failTimestamp),
      payloadJson: JSON.stringify(failData),
    });
    wsHub.broadcast(job.taskId, {
      type: "task:failed",
      requestId: job.requestId,
      data: failData,
      timestamp: failTimestamp,
      seq: failSeq,
    });
    taskEventBus.publish(job.taskId, {
      type: "task:failed",
      requestId: job.requestId,
      data: failData,
      timestamp: failTimestamp,
      seq: failSeq,
    });

    // M5 Phase 3: fire failure-driven reflection. The memory extractor
    // decides whether anything from this failure should land as a
    // durable `feedback/*.md` entry. Fire-and-forget — never blocks
    // the failure-emit path; the extractor's own logging surfaces
    // outcomes via `[memory] failure-reflection-*`. Doom-loop and
    // other intra-loop terminal conditions are already covered here:
    // they abort the loop, which surfaces as a throw on this path.
    try {
      const { fireFailureReflection } = await import(
        "./memory/memory-failure-reflection"
      );
      fireFailureReflection({
        kind: "task_failed",
        taskId: job.taskId,
        summary: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Memory module might be uninitialized in some tests / legacy
      // paths — never re-raise from the reflection import.
    }

    try {
      const { clearTaskApprovalTrust } = await import("./command-approval-service");
      clearTaskApprovalTrust(job.taskId);
    } catch { /* best-effort */ }

    throw err;
  }
}

type ExecuteLeaderLoopInput = {
  taskId: string;
  runId: string;
  requestId: string;
  workspaceId: string;
  prompt: string;
  restoredMessages?: LeaderMessage[];
  channelBindingId?: string;
  previousConversationContext?: string;
  /** Plan-first system-prompt addendum for THIS turn. */
  planFirst?: boolean;
  /** MCP-rendered prompt messages — projected into first-turn blocks
   *  + assistant preamble. Phase 2. */
  promptMessages?: Array<{ role: "user" | "assistant"; content: any }>;
  /** Planner/taskManager hints — tighten-only policy signal. */
  plannerHints?: ManagerHintsPayload;
  taskManagerHints?: ManagerHintsPayload;
};

type ExecuteLeaderLoopResult = {
  reason: string;
  turnCount: number;
  finalAnswer?: string;
};

type LeaderSafeApplyMode = "off" | "optional" | "required";

function resolveLeaderSafeApplyMode(env: NodeJS.ProcessEnv = process.env): LeaderSafeApplyMode {
  const raw = getMagisterEnv("MAGISTER_LEADER_SAFE_APPLY_MODE", env)?.trim().toLowerCase();
  return raw === "optional" || raw === "required" ? raw : "off";
}

function safeBranchSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "unknown";
}

function buildLeaderSafeApplyReviewNotice(created: boolean): string | null {
  if (!created) return null;
  return "Safe Apply review created for this leader turn. Apply it from Patch Reviews to land the patch in the main workspace.";
}

async function executeLeaderLoop(
  input: ExecuteLeaderLoopInput,
): Promise<ExecuteLeaderLoopResult> {
  let workspaceDir: string;
  try {
    workspaceDir = await resolveWorkspaceBaseDir(input.workspaceId);
  } catch {
    return {
      reason: "workspace_error",
      turnCount: 0,
      finalAnswer: "Failed to resolve workspace directory",
    };
  }

  let apiConfig: { provider: ProviderConfig; model: ModelProfile; binding: ExecutorBinding } | null = null;

  try {
    const leaderAgentConfig = await resolveAgentForRole("leader");
    if (
      leaderAgentConfig &&
      leaderAgentConfig.runtimeType === "ucm" &&
      leaderAgentConfig.provider &&
      leaderAgentConfig.modelName.trim().length > 0
    ) {
      apiConfig = buildApiConfigFromAgent(leaderAgentConfig);
    }
  } catch (err) {
    console.warn("[agent-resolution] Failed to resolve leader agent, falling back to legacy:", err instanceof Error ? err.message : String(err));
  }

  if (!apiConfig) {
    try {
      const executorConfig = await readExecutorConfigFile();
      const resolved = resolveApiConfigFromRoleRouting(executorConfig);
      if (resolved) {
        apiConfig = resolved;
      }
    } catch (err) {
      console.warn("[config] Failed to load legacy executor config:", err instanceof Error ? err.message : String(err));
    }
  }

  if (!apiConfig) {
    return {
      reason: "configuration_error",
      turnCount: 0,
      finalAnswer: "No Magister agent configured for leader role",
    };
  }

  // Apply per-task `/model` override (if set on the task row). The
  // override swap is a no-op when null/stale; on success the resolved
  // model+provider are swapped while keeping the binding's adapter id.
  try {
    const task = await new TaskRepository().getById(input.taskId);
    const override = task?.modelOverride ?? null;
    if (override) {
      const executorConfigForOverride = await readExecutorConfigFile();
      apiConfig = applyModelOverrideToApiConfig(apiConfig, override, executorConfigForOverride);
    }
  } catch (err) {
    console.warn("[model-switch] failed to apply task override:", err instanceof Error ? err.message : String(err));
  }

  const leaderApiConfig = apiConfig;

  const tavilyConfig = parseTavilyWebSearchConfigFromEnv();

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const previousConversationContext =
    input.previousConversationContext?.trim().length
      ? input.previousConversationContext.trim()
      : null;

  // ──────────────────────────────────────────────────────────────────
  // System prompt assembly — split into PERSONA + FRAMEWORK sections.
  //
  // PERSONA: the agent's voice, role-specific guidance. User-
  //   overridable via `agent_profiles.systemPromptOverride`. If the
  //   user customizes their leader (e.g. "You are a Rust expert who
  //   writes only safe code"), they replace ONLY this section.
  //
  // FRAMEWORK: capabilities baked into the runtime — plan-mode
  //   workflow, tool-protocol invariants, current date. Always
  //   appended REGARDLESS of persona override, so a custom persona
  //   doesn't silently lose plan-mode self-triggering. Mirrors how
  //   Claude Code keeps its plan-mode reminder out of the user-
  //   editable CLAUDE.md and injects it as a meta system reminder.
  // ──────────────────────────────────────────────────────────────────
  // Leader persona is the source-of-truth `LEADER_SYSTEM_PROMPT`
  // (manager-automation/teammate-system-prompts.ts). The DB row's
  // `system_prompt_override` mirrors that constant and gets auto-
  // upgraded on boot via the hash mechanism in
  // agent-profile-service.ts. The framework protocol below (Runtime
  // context + Plan mode self-trigger) is computed PER-REQUEST because
  // it embeds the date stamp; it never lives in the DB persona.
  const defaultPersona = LEADER_SYSTEM_PROMPT;

  const frameworkProtocol = `## Runtime context
Current date: ${dateStr}.

## Plan mode (self-triggered)
**You are NOT in plan mode by default.** Plan mode is OFF unless either (a) you called \`enter_plan_mode\` earlier this turn, or (b) you see a \`Plan mode is active\` system notice. If neither is true, plan-mode rules below do not apply — proceed normally.

When to enter plan mode: NON-TRIVIAL destructive tasks — multi-file refactors, rewriting an existing module, anything where misunderstanding the user's intent would create real cleanup cost. Call \`enter_plan_mode\` BEFORE making any edits, gather context with read tools, then call \`exit_plan_mode\` with a focused markdown plan (goal, files to change, key steps, risks). The user reviews and approves before execution.

When NOT to enter plan mode: trivial requests (single read, one-line edit, status check, "what's in this file"), or anything that fits in 1-2 tool calls. Default to action — only plan when the work justifies it.

WHEN plan mode is active (and only then): write tools (\`write_file\`, \`edit_file\`, \`git_commit\`, \`git_create_branch\`, \`spawn_teammate\`, write-y \`bash\`) are blocked by the runtime and return errors. Stay read-only until you call \`exit_plan_mode\` and the user approves. The user can also force plan mode via the "Plan first" toggle — when active you'll see the \`Plan mode is active\` notice and MUST follow plan workflow regardless of how trivial the request looks.

## Permissions${process.env.MAGISTER_PERMISSIONS_V4 === "on" ? `

Tool calls run inside a workspace-write sandbox by default. The classes:

- **Read tools** (\`read_file\`, \`list_dir\`, \`grep\`, \`time_now\`, \`web_search\`, \`web_fetch\`, \`repo_structure\`, \`mcp_list_resources\`, \`mcp_read_resource\`): always permitted, no approval, no sandbox needed.
- **Write tools** (\`write_file\`, \`edit_file\`): bounded to the current workspace.
- **\`bash\`**: runs inside bubblewrap by default. Workspace is the only writable root; network access is available.

### Three sandbox modes (v4.3)

Set \`sandbox_permissions\` on the bash tool input to one of:

\`\`\`
"use_default"                  # the common case — bounded to workspace
"with_additional_permissions"  # PREFERRED for specific extra paths
"require_escalated"            # LAST RESORT — fully bypass sandbox
\`\`\`

### \`with_additional_permissions\` (PREFERRED)

Use this when you need to read/write SPECIFIC paths outside the workspace.
Stay sandboxed; widen the bind list for ONE command.

\`\`\`
{
  "command": "cd server && uv sync",
  "sandbox_permissions": "with_additional_permissions",
  "additional_permissions": {
    "file_system": {
      "write": ["${homedir()}/.cache/uv"],
      "read":  ["${homedir()}/.gitconfig"]
    }
  },
  "justification": "uv needs persistent cache so subsequent installs don't re-download"
}
\`\`\`

**Path rules**: absolute paths only (no glob, no \`~\`), read + write combined ≤ 16 per request, no \`\\n\\r\\0\` in path strings. Paths on the critical deny list (e.g. \`/etc/shadow\`, \`~/.ssh/authorized_keys\`, \`/etc/*\` writes) are refused at validation — pick a different approach if you hit one.

### \`request_permissions\` tool (BATCH grant)

When a multi-step task is about to need elevation N times, call
\`request_permissions\` ONCE at the start with the FULL set of paths
+ a reason. Once granted at "Trust for task" scope, subsequent bash
calls automatically inherit the binds — you do NOT need to re-declare
\`additional_permissions\` on every follow-up bash. Re-declare only
for INCREMENTAL paths beyond what was granted.

\`\`\`
request_permissions({
  permissions: {
    file_system: {
      write: ["${homedir()}/.cache/uv"],
      read:  ["${homedir()}/.gitconfig"]
    },
    network: { enabled: true }
  },
  reason: "Set up this Python project — uv sync, run tests, git commit"
})
\`\`\`

If a grant expires mid-task you'll see \`permissionNotices.grantsExpired\`
in a bash tool result — call \`request_permissions\` again to re-establish.

### \`require_escalated\` (LAST RESORT)

Use ONLY when the operation can't be expressed as a set of paths
(e.g. needs to write to dozens of unknown system paths). User
approval required; \`justification\` required.

\`\`\`
{ "command": "...", "sandbox_permissions": "require_escalated", "justification": "..." }
\`\`\`

### Paths that are NEVER grantable

\`/etc/shadow\`, \`/etc/sudoers\`, \`~/.ssh/authorized_keys\`, write to \`~/.ssh/\`, write to any \`/dev/sd*\` block device, write to \`/etc/*\`, Magister's own \`config/secrets.json\`. Don't request these — the server refuses at validation and you'll waste a turn.

### \`prefix_rule\` (optional)

For repeated escalations, include \`prefix_rule: ["npm", "install"]\` to suggest a learnable rule the user can persist.

✗ DON'T request elevation for commands the sandbox already permits. It just slows the user down.` : `

Tool calls run inside a workspace-write sandbox by default. The classes:

- **Read tools** (\`read_file\`, \`list_dir\`, \`grep\`, \`time_now\`, \`web_search\`, \`web_fetch\`, \`repo_structure\`, \`mcp_list_resources\`, \`mcp_read_resource\`): always permitted, no approval, no sandbox needed.
- **Write tools** (\`write_file\`, \`edit_file\`): bounded to the current workspace.
- **\`bash\`**: runs inside bubblewrap by default. Workspace is the only writable root; network access is available.

### When to request bash escalation

Set on the bash tool input when the command needs to:

- Write outside the workspace (modify \`/etc\`, write to \`~/.ssh\`, install global packages)
- Run a destructive operation the user did NOT explicitly ask for
- Operate on system files the sandbox blocks

\`\`\`
sandbox_permissions: "require_escalated"
justification: "<short reason: what + why>"
prefix_rule: [<argv tokens>]   // optional; suggests a learnable rule
\`\`\`

Examples:

- ✓ Standard sandboxed bash (no escalation needed):
  \`{ "command": "ls -la && cat package.json" }\`

- ✓ \`npm install\` needs network + node_modules write — escalate + suggest learnable rule:
  \`{ "command": "npm install", "sandbox_permissions": "require_escalated", "justification": "install dependencies before running tests", "prefix_rule": ["npm","install"] }\`

- ✓ One-shot destructive op the user asked for — escalate without rule:
  \`{ "command": "rm -rf /tmp/old-build-cache", "sandbox_permissions": "require_escalated", "justification": "user asked to wipe stale build cache" }\`

✗ DON'T request escalation for commands the sandbox already permits. It just slows the user down.`}

### prefix_rule guidance

- ≥2 tokens (single-token prefixes are too broad)
- The rule must CATEGORIZE the command, not BE the command
- Good: \`["npm","install"]\`, \`["git","push","origin"]\`, \`["docker","build"]\`, \`["bun","run","test"]\`
- Banned (server rejects): \`["python"]\`, \`["sudo"]\`, \`["bash","-c"]\`, \`["rm"]\`, \`["curl"]\`, \`["chmod"]\`
- If your command uses shell metacharacters (\`|\`, \`&&\`, \`||\`, \`;\`, \`$()\`, backticks, redirects), \`prefix_rule\` will NOT match — request per-call approval instead.

Approved rules persist at the project level by default (scoped to the current cwd). The user can list, revoke, or change scope at Settings → Approval Rules.

### CRITICAL commands (hard-block, no override)

Some commands are HARD-BLOCKED even with \`require_escalated\`: \`rm -rf /\`, fork bombs, \`mkfs\` on \`/dev\` devices, \`dd\` to block devices, \`chmod -R 777 /\`, \`shutdown\` / \`reboot\` host, \`curl | sudo sh\`. The runtime returns \`<tool_use_error>refused: command in CRITICAL deny list</tool_use_error>\`. If the user genuinely needs such an operation, they will run it manually in a terminal — do NOT attempt to bypass.`;

  const leaderAgent = await getAgentProfile("leader");
  const personaOverride = leaderAgent?.systemPromptOverride?.trim();
  const persona = personaOverride || defaultPersona;
  const basePrompt = `${persona}\n\n${frameworkProtocol}`;
  // Inject skills attached to the leader role before any per-turn
  // context. Teammates already get this through
  // `getTeammateSystemPromptWithSkills`; the leader's own prompt is
  // built here so we have to call the helper directly. `appendAgentSkills`
  // degrades silently to `basePrompt` if the role has no bindings or
  // the lookup fails, so this is safe for fresh installs.
  const basePromptWithSkills = await appendAgentSkills("leader", basePrompt);
  // M5 memory: inject the user's accumulated <memories> block right
  // after skills so the trace shows skills → memories → per-turn
  // context (a stable structural order). Degrades silently when
  // memory runtime isn't initialized, so non-leader callers and
  // misconfigured envs never break. The taskId surfaces the current
  // task's scratchpad (project/scratchpad/<id>.md) in full inside
  // the <memories> block so the leader can read/write working notes
  // across turns without re-fetching.
  const basePromptWithMemory = await appendMemoryBlock(
    "leader",
    basePromptWithSkills,
    input.taskId,
  );
  const promptWithContext = previousConversationContext
    ? `${basePromptWithMemory}\n\nPrevious conversation context: ${previousConversationContext}`
    : basePromptWithMemory;
  // Plan-first addendum (spec §3, §11). When the user has flipped the
  // toggle, the leader loop's init code has ALREADY transitioned plan
  // state to PLANNING and emitted `leader.plan_mode_entered` — write
  // tools are gated regardless of whether the model obeys this prompt.
  // The addendum still fires so the model understands the gating it
  // will see and produces a coherent plan rather than thrashing.
  //
  // Wording uses a strong "supersedes any other instructions" clause,
  // an explicit list of blocked tools, and a hard turn-ending
  // constraint ("your turn must end with exit_plan_mode") so smaller
  // models don't end the turn with prose asking "is this plan okay?"
  // instead of submitting it for approval.
  const systemPrompt = input.planFirst === true
    ? `${promptWithContext}\n\n## Plan mode is active\nThe user has indicated they do NOT want you to execute yet — they want to review your plan first. You MUST NOT make any edits, run any non-read-only tools, or otherwise change the system. **This supersedes any other instructions you have received in this prompt.**\n\nBlocked tools (will return errors if called): \`write_file\`, \`edit_file\`, \`git_commit\`, \`git_create_branch\`, \`spawn_teammate\`, write-y \`bash\` commands (anything that mutates files / state).\n\nAllowed tools: \`read_file\`, \`list_dir\`, \`grep\`, \`web_search\`, \`web_fetch\`, read-only \`bash\` (ls, cat, grep, git status/log/diff, …), \`request_human_input\`.\n\n## Workflow\n1. Use read tools to gather just enough context to produce a confident plan — don't over-explore.\n2. Produce a focused markdown plan covering: goal, files to change (with paths), key steps, risks.\n3. Call \`exit_plan_mode\` with the plan as its \`plan\` argument. **Your turn MUST end with this call.** Do not end your turn with prose asking "is this plan okay?" or "should I proceed?" — those questions belong inside the plan submitted via \`exit_plan_mode\`. The user will review and click Approve, Revise, or Cancel.\n\nIf the request is genuinely too vague to plan, end the turn by asking ONE clarifying question (text response), and the user will reply.`
    : promptWithContext;

  // Execution policy: classify at intake (TELEMETRY-ONLY — no enforcement this task).
  // resolveAvailableRoles degrades to [] on error so this never throws.
  // plannerHints / taskManagerHints are passed through and may only TIGHTEN the policy.
  const executionPolicyAvailableRoles = await resolveAvailableRoles();
  const executionPolicy = classifyExecutionPolicy({
    prompt: input.prompt,
    // source is not threaded through ExecuteLeaderLoopInput; use a stable label.
    source: "intake_rules",
    availableRoles: executionPolicyAvailableRoles,
    plannerHints: input.plannerHints,
    taskManagerHints: input.taskManagerHints,
  });
  const systemPromptWithPolicy = buildSystemPromptWithPolicy(systemPrompt, executionPolicy, executionPolicyAvailableRoles);

  // Resume hint for plan mode: if a `leader.plan_proposed` is open
  // (no matching `leader.plan_mode_exited` yet), thread its requestId
  // into the runtime so the next exit event lands in the same exchange
  // as the original PlanCard. Costs a single event-log read on the
  // resume path; cheap and idempotent.
  let initialPlanRequestId: string | null = null;
  if (input.restoredMessages && input.restoredMessages.length > 0) {
      try {
        const eventRepo = new ExecutionEventRepository();
        const planEvents = await eventRepo.listByTaskIdAndTypes(input.taskId, [
          "leader.plan_proposed",
          "leader.plan_mode_exited",
        ]);
        initialPlanRequestId = findOpenPlanRequestId(planEvents);
    } catch (err) {
      console.warn("[plan-mode] Failed to look up open plan requestId:", err instanceof Error ? err.message : String(err));
    }
  }

  const leaderSafeApplyMode = resolveLeaderSafeApplyMode();
  const leaderWorkerMode = resolveLeaderWorkerMode();
  const executionSandboxConfig = resolveExecutionSandboxConfig();
  const leaderHardeningStatus: LeaderHardeningStatus = createInitialLeaderHardeningStatus({
    safeApplyMode: leaderSafeApplyMode,
    workerMode: leaderWorkerMode,
    executionSandboxMode: executionSandboxConfig.mode,
    executionSandboxNetwork: executionSandboxConfig.network,
    workspaceDir,
  });
  let leaderHardeningStateEmitted = false;
  const emitLeaderHardeningState = async (): Promise<void> => {
    if (leaderHardeningStateEmitted) return;
    leaderHardeningStateEmitted = true;
    try {
      const projectEvent = createEventProjector({
        taskId: input.taskId,
        runId: input.runId,
        requestId: input.requestId,
        ...(input.channelBindingId !== undefined ? { channelBindingId: input.channelBindingId } : {}),
        agentRole: "leader",
        agentName: "Leader",
        agentDepth: 0,
      });
      await projectEvent({
        type: "leader.hardening_state",
        timestamp: new Date().toISOString(),
        data: JSON.parse(JSON.stringify(leaderHardeningStatus)) as Record<string, unknown>,
      });
    } catch (err) {
      console.warn(
        "[leader-hardening] failed to emit hardening state:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  let leaderWorkspaceDir = workspaceDir;
  let leaderWorktreeId: string | null = null;
  let leaderBaseRevision: string | null = null;
  let leaderReviewAttempted = false;
  let leaderSafeApplyReviewCreated = false;
  const observedLeaderEvents: LeaderLoopEvent[] = [];
  const maybeCreateLeaderSafeApplyReview = async (): Promise<boolean> => {
    if (!leaderWorktreeId || leaderReviewAttempted) {
      return leaderSafeApplyReviewCreated;
    }
    leaderReviewAttempted = true;
    try {
      const result = await createRuntimeSafeApplyReviewDraft({
        taskId: input.taskId,
        roleRuntimeId: input.runId,
        parentWorkspaceDir: workspaceDir,
        runtimeWorkspaceDir: leaderWorkspaceDir,
        baseRevision: leaderBaseRevision,
        runtimeSecurity: buildUcmRuntimeSecurity({
          runtimeWorkspaceStrategy: "git_worktree",
          permissionSignals: ["magister:tool-permission-hooks", "leader:safe-apply-worktree"],
        }),
        observedEvents: observedLeaderEvents,
      });
      leaderSafeApplyReviewCreated = result.created;
      return leaderSafeApplyReviewCreated;
    } catch (err) {
      console.warn(
        `[safe-apply] leader review draft failed for run ${input.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  try {
    // Reuse the AbortController that taskWorker registered for this
    // taskId — that's the one POST /tasks/:id/cancel can reach via
    // getAbortController(taskId). Without this, executeLeaderLoop
    // built a fresh controller every run and the cancel route
    // aborted a completely different signal: bash-tool, danger-gate
    // wait, model streaming caller, and the per-turn loop check all
    // listened to the runtime's controller, never the worker's, so
    // cancel did literally nothing while still flipping state to
    // CANCELLED — exactly the "cancel doesn't work, both old and new
    // turns appear running" symptom the user reported.
    //
    // The sync Feishu path doesn't go through taskWorker (no
    // registration), so it falls back to a fresh controller — cancel
    // isn't supported there anyway.
    const { getAbortController } = await import("./task-worker");
    const sharedAbortController = getAbortController(input.taskId) ?? new AbortController();

    if (leaderSafeApplyMode !== "off") {
      const candidateWorktreeId = `leader_${safeBranchSegment(input.runId)}_${safeBranchSegment(input.requestId)}`;
      const branchName = `magister-leader-${safeBranchSegment(input.taskId)}-${safeBranchSegment(input.requestId)}`;
      try {
        const { readGitHeadRevision } = await import("./safe-apply/runtime-diff-service");
        leaderBaseRevision = await readGitHeadRevision(workspaceDir).catch(() => null);
        const worktree = createWorktree(workspaceDir, candidateWorktreeId, branchName);
        leaderWorktreeId = candidateWorktreeId;
        leaderWorkspaceDir = worktree.path;
        leaderHardeningStatus.runtimeWorkspace = {
          status: "isolated_worktree",
          workspaceDir: leaderWorkspaceDir,
          baseWorkspaceDir: workspaceDir,
        };
      } catch (err) {
        const message = `Leader Safe Apply isolation required but not available: ${err instanceof Error ? err.message : String(err)}`;
        if (leaderSafeApplyMode === "required") {
          leaderHardeningStatus.runtimeWorkspace = {
            status: "failed",
            workspaceDir,
            baseWorkspaceDir: null,
            failureReason: message,
          };
          if (leaderWorkerMode !== "off") {
            leaderHardeningStatus.workerProcess = {
              status: "failed",
              failureReason: "leader Safe Apply worktree isolation is not active",
            };
          }
          await emitLeaderHardeningState();
          return {
            reason: "configuration_error",
            turnCount: 0,
            finalAnswer: message,
          };
        }
        leaderHardeningStatus.runtimeWorkspace = {
          status: "main_workspace",
          workspaceDir,
          baseWorkspaceDir: null,
          failureReason: message,
        };
        console.warn(`[safe-apply] ${message}`);
      }
    }

    // Pull attachments for THIS request (Phase 1 = images only).
    // Each attachment landed on disk during `processTaskIntent`'s
    // task-creation phase via `saveAttachments`; here we read the
    // bytes back, base64-encode them, and pass as
    // `LeaderContentBlock[]` to the runtime, which inlines them
    // into the first user message. Empty array short-circuits to
    // the existing string-content path with no perf cost.
    const { loadAttachmentBlocksForRequest } = await import("./attachment-service");
    const initialAttachmentBlocks = await loadAttachmentBlocksForRequest(
      input.taskId,
      input.requestId,
    );

    // Phase 2: MCP-rendered prompt projection.
    // - userBlocks → prepend to initialAttachmentBlocks so the
    //   first user message carries the rendered content + any
    //   image attachments + the typed prompt text (in that order).
    // - assistantPreamble → prepend to restoredMessages so the
    //   leader's first model call sees the full multi-turn
    //   priming.
    const { projectPromptMessages } = await import("./prompt-message-projection");
    const projection = projectPromptMessages(input.promptMessages ?? []);
    const mergedAttachmentBlocks = [...projection.userBlocks, ...initialAttachmentBlocks];
    const mergedRestoredMessages =
      projection.assistantPreamble.length > 0
        ? [...projection.assistantPreamble, ...(input.restoredMessages ?? [])]
        : input.restoredMessages;

    const observeLeaderEvent = (event: LeaderLoopEvent) => {
      if (isSafeApplySideEffectEvidenceCandidate(event)) {
        observedLeaderEvents.push(event);
      }
    };

    // AGENTS.md (Codex-style repo collaboration guide). Read once from
    // the leader's workspace root and APPENDED TO THE SYSTEM PROMPT so
    // the model sees repo context on every turn without the content
    // bleeding into the user-visible chat bubble.
    // Degrades silently when absent — most repos won't have one.
    let repoInstructions: string | null = null;
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const agentsContent = await readFile(join(leaderWorkspaceDir, "AGENTS.md"), "utf8");
      const trimmed = agentsContent.trim();
      if (trimmed.length > 0) repoInstructions = trimmed;
    } catch {
      // No AGENTS.md or unreadable — skip.
    }
    const systemPromptWithRepo =
      repoInstructions && repoInstructions.length > 0
        ? `${systemPromptWithPolicy}\n\n<REPO_INSTRUCTIONS>\n${repoInstructions}\n</REPO_INSTRUCTIONS>`
        : systemPromptWithPolicy;

    const runtimeConfig: LeaderRuntimeConfig = {
      taskId: input.taskId,
      runId: input.runId,
      requestId: input.requestId,
      workspaceDir: leaderWorkspaceDir,
      ...(leaderWorktreeId ? { baseWorkspaceDir: workspaceDir } : {}),
      systemPrompt: systemPromptWithRepo,
      initialPrompt: input.prompt,
      apiConfig: leaderApiConfig,
      tavilyConfig,
      abortController: sharedAbortController,
      observeEvent: observeLeaderEvent,
      ...(mergedAttachmentBlocks.length > 0
        ? { initialAttachmentBlocks: mergedAttachmentBlocks }
        : {}),
      ...(mergedRestoredMessages ? { restoredMessages: mergedRestoredMessages } : {}),
      ...(input.channelBindingId ? { channelBindingId: input.channelBindingId } : {}),
      ...(initialPlanRequestId ? { initialPlanRequestId } : {}),
      ...(input.planFirst === true ? { planFirst: true } : {}),
      executionPolicy,
    };

    let result;
    if (leaderWorkerMode !== "off" && leaderWorktreeId) {
      leaderHardeningStatus.workerProcess = leaderWorkerMode === "required"
        ? {
            status: "failed",
            failureReason: "worker process did not start",
          }
        : {
            status: "fallback",
            failureReason: "worker process did not start",
          };
      const workerToolSetup = await resolveLeaderRuntimeTools({
        workspaceDir: leaderWorkspaceDir,
        tavilyConfig,
        baseWorkspaceDir: workspaceDir,
      });
      const {
        abortController: _abortController,
        apiConfig: _parentApiConfig,
        observeEvent: _observeEvent,
        requestApproval: parentRequestApproval,
        tavilyConfig: _tavilyConfig,
        ...workerRuntimeConfig
      } = runtimeConfig;
      result = await runLeaderRuntimeInWorker({
        config: {
          ...workerRuntimeConfig,
          modelRuntime: buildLeaderRuntimeModelConfig(leaderApiConfig),
          maxTurns: workerToolSetup.maxTurns,
        },
        apiConfig: leaderApiConfig,
        tools: workerToolSetup.tools,
        ...(parentRequestApproval ? { requestApproval: parentRequestApproval } : {}),
        signal: sharedAbortController.signal,
        observeEvent: observeLeaderEvent,
        observeWorkerProcessState: (state) => {
          leaderHardeningStatus.workerProcess = state;
        },
        observeWorkerSandboxState: (state) => {
          leaderHardeningStatus.workerSandbox = state;
          if (state.status === "failed") {
            leaderHardeningStatus.workerProcess = {
              status: "failed",
              ...(state.failureReason ? { failureReason: state.failureReason } : {}),
            };
          }
        },
      });
    } else {
      if (leaderWorkerMode === "required") {
        leaderHardeningStatus.workerProcess = {
          status: "failed",
          failureReason: "leader Safe Apply worktree isolation is not active",
        };
        await emitLeaderHardeningState();
        return {
          reason: "configuration_error",
          turnCount: 0,
          finalAnswer: "Leader worker isolation required but leader Safe Apply worktree isolation is not active.",
        };
      }
      if (leaderWorkerMode === "optional") {
        leaderHardeningStatus.workerProcess = {
          status: "fallback",
          failureReason: "leader Safe Apply worktree isolation is not active",
        };
      }
      result = await runLeaderRuntime(runtimeConfig);
    }
    await emitLeaderHardeningState();
    const leaderSafeApplyNotice = buildLeaderSafeApplyReviewNotice(
      await maybeCreateLeaderSafeApplyReview(),
    );

    // Extract final text answer for THIS request's response.
    //
    // The checkpoint contains the full session history (every prior
    // prompt + response on this runId). A naive "last assistant text
    // wins" walk over the entire checkpoint mistakenly picked up
    // text from a PRIOR prompt when the current turn's response was
    // empty (model bug: qwen3.5-plus occasionally emits no text and
    // no tool_use after a short bash result). The user saw the
    // previous prompt's answer attached to the new prompt's
    // task:completed — looked like the chat had stalled.
    //
    // Fix: scope to messages AFTER the last non-meta user message
    // — that's the current request's response window. Skip
    // `isMeta` user messages (the [Session Progress] /
    // [Previous conversation summary] meta blocks the loop injects
    // post-compaction).
    const sessionStore = new LeaderSessionStore();
    const checkpoint = await sessionStore.getLatestCheckpoint(input.runId);

    // M1 (audit 2026-05-08) — `runLeaderRuntime` returns
    // LeaderTerminal.reason = "completed" for BOTH the natural
    // completion AND the plan-mode halts (plan_awaiting_approval,
    // plan_cancelled). The richer reason only lives in the
    // `leader.session_complete` event payload. Look it up here so
    // `pickFinalAnswer` can pick the appropriate banner case
    // (📋 Plan submitted / 🛑 Plan cancelled). Best-effort — fall
    // through to the raw result.reason on read failure.
    let bannerReason: string | undefined = result.reason;
    if (result.reason === "completed") {
      try {
        const eventRepo = new ExecutionEventRepository();
        const sessionCompleteEvents = await eventRepo.listByTaskIdAndType(
          input.taskId,
          "leader.session_complete",
          20,
        );
        const last = sessionCompleteEvents
          .find((e) => e.type === "leader.session_complete" && e.requestId === input.requestId);
        if (last?.payloadJson) {
          const payload = JSON.parse(last.payloadJson) as { reason?: string };
          if (payload.reason === "plan_cancelled" || payload.reason === "plan_awaiting_approval") {
            bannerReason = payload.reason;
          }
        }
      } catch {
        // best-effort
      }
    }

    const baseFinalAnswer = pickFinalAnswer({
      checkpoint,
      requestId: input.requestId,
      yieldedMessages: result.messages,
      ...(result.emptyResponse ? { emptyResponse: result.emptyResponse } : {}),
      // P3 — surface the terminal reason as a banner.
      ...(bannerReason ? { terminalReason: bannerReason } : {}),
      ...(typeof result.turnCount === "number" ? { turnCount: result.turnCount } : {}),
    });
    const finalAnswer = leaderSafeApplyNotice
      ? `${baseFinalAnswer}\n\n${leaderSafeApplyNotice}`
      : baseFinalAnswer;

    return { reason: result.reason, turnCount: result.turnCount, finalAnswer };
  } catch (error) {
    await emitLeaderHardeningState();
    const leaderSafeApplyNotice = buildLeaderSafeApplyReviewNotice(
      await maybeCreateLeaderSafeApplyReview(),
    );
    const baseFinalAnswer = error instanceof Error ? error.message : String(error);
    return {
      reason: "error",
      turnCount: 0,
      finalAnswer: leaderSafeApplyNotice
        ? `${baseFinalAnswer}\n\n${leaderSafeApplyNotice}`
        : baseFinalAnswer,
    };
  } finally {
    if (leaderWorktreeId) {
      try {
        removeWorktree(workspaceDir, leaderWorktreeId);
      } catch (err) {
        console.warn(
          `[safe-apply] failed to remove leader worktree ${leaderWorktreeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
