/**
 * Plan-mode state model + derivation + token detection.
 *
 * Spec: `docs/specs/2026-04-26-plan-mode-spec.md` §4-§6.
 *
 * State machine:
 *
 *   IDLE  ──enter_plan_mode──▶  PLANNING  ──exit_plan_mode──▶  AWAITING_APPROVAL
 *                                                                  │
 *                              ┌───────────────────────────────────┤
 *                              │approval / cancel                  │revise
 *                              ▼                                   ▼
 *                            IDLE                              PLANNING
 *
 * `inPlanMode` (the gating flag in `LeaderToolUseContext`) is true iff
 * state ∈ {PLANNING, AWAITING_APPROVAL}.
 */

import type { LeaderMessage } from "./autonomous-types";

export type PlanState = "IDLE" | "PLANNING" | "AWAITING_APPROVAL";

export function isInPlanMode(state: PlanState): boolean {
  return state === "PLANNING" || state === "AWAITING_APPROVAL";
}

// ──────────────────────────────────────────────────────────────────────
// Derive state from message history (for resume / recovery)
// ──────────────────────────────────────────────────────────────────────

/**
 * Replay the conversation's tool-use trace + persisted user-side
 * substitutes to derive the current plan state. Used at leader-loop
 * init so any prior crash / restart is resumed in the correct state.
 *
 * Walk messages in order. Transitions:
 *   - assistant tool_use(enter_plan_mode)         → PLANNING (if IDLE)
 *   - assistant tool_use(exit_plan_mode)          → AWAITING_APPROVAL
 *   - user "[user approved the plan]"             → IDLE
 *   - user "[user cancelled the plan]"            → IDLE
 *   - user "[user requested revision: …]"         → PLANNING
 *
 * The bracketed substitutes are exactly what `syntheticSubstituteFor`
 * writes into the message log when the preflight strips a sentinel.
 * Reading them here closes Codex BLOCKER 5: without this, a session
 * restored after approval would re-derive AWAITING_APPROVAL (because
 * the most-recent assistant tool_use was `exit_plan_mode`) and halt
 * again — the approval would be invisible to derivation since
 * approve/cancel/revise outcomes are events, not assistant tool_uses.
 *
 * Substitute prose is unique enough (first-person, bracketed,
 * deterministic) that real user typing won't trip it.
 */
export function derivePlanStateFromMessages(messages: LeaderMessage[]): PlanState {
  let state: PlanState = "IDLE";
  for (const m of messages) {
    if (m.type === "assistant") {
      for (const block of m.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "enter_plan_mode") {
          if (state === "IDLE") state = "PLANNING";
          // re-entry while already PLANNING/AWAITING_APPROVAL is a no-op
        } else if (block.name === "exit_plan_mode") {
          if (state === "PLANNING") state = "AWAITING_APPROVAL";
        }
      }
      continue;
    }
    if (m.type === "user") {
      // Walk individual text blocks (not joined). Resume sanitizer
      // (`leader-session-resume-service.ts:enforceAlternatingTurns`)
      // merges consecutive user-role messages into a single
      // `content: [text, text, ...]` array. If we joined those with
      // `\n` and exact-matched, a checkpointed
      // `[user approved the plan]` followed by a typed-in follow-up
      // (e.g. `继续`) collapses to a single text blob that no longer
      // matches — and `derivePlanStateFromMessages` re-derives
      // AWAITING_APPROVAL → loop halts again, user sees "no
      // response". Per-block matching keeps the signal intact under
      // any merging policy: as long as ONE text block in the merged
      // user message is the substitute, we honor it.
      for (const text of userTextBlocks(m)) {
        const trimmed = text.trim();
        if (trimmed === "[user approved the plan]" || trimmed === "[user cancelled the plan]") {
          state = "IDLE";
          break;
        } else if (trimmed.startsWith("[user requested revision:") && trimmed.endsWith("]")) {
          state = "PLANNING";
          break;
        }
      }
    }
  }
  return state;
}

function userTextBlocks(m: Extract<LeaderMessage, { type: "user" }>): string[] {
  if (typeof m.content === "string") return [m.content];
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
  }
  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Find the open plan's requestId from the durable event log
// ──────────────────────────────────────────────────────────────────────

type PlanEventLike = {
  type: string;
  payloadJson?: string | null;
  occurredAt?: Date | string | null;
};

/**
 * Walk plan events in seq order and return the requestId of the
 * currently-open `leader.plan_proposed` (one without a matching
 * subsequent `leader.plan_mode_exited`), or `null` if no plan is
 * open. Used by the resume path so the loop can re-stamp future
 * `leader.plan_mode_exited` events with the original proposal's
 * requestId — letting the projector apply the status mutation to
 * the existing PlanCard rather than orphaning it in
 * `awaiting_approval`.
 */
export function findOpenPlanRequestId(events: readonly PlanEventLike[]): string | null {
  let open: string | null = null;
  for (const ev of events) {
    if (ev.type !== "leader.plan_proposed" && ev.type !== "leader.plan_mode_exited") continue;
    const payload = parsePayload(ev.payloadJson);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    if (ev.type === "leader.plan_proposed") open = requestId;
    else if (ev.type === "leader.plan_mode_exited" && open === requestId) open = null;
  }
  return open;
}

function parsePayload(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {}
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Token detection
// ──────────────────────────────────────────────────────────────────────

export const PLAN_TOKEN_APPROVED = "__PLAN_APPROVED__";
export const PLAN_TOKEN_CANCELLED = "__PLAN_CANCELLED__";
export const PLAN_TOKEN_REVISED_PREFIX = "__PLAN_REVISED__:";

export type PlanResponse =
  | { kind: "approved" }
  | { kind: "cancelled" }
  | { kind: "revised"; feedback: string };

// F9 (audit 2026-05-08) — natural-language approval/cancel fallback.
// PlanCard's Approve/Revise/Cancel buttons send the explicit sentinels
// (`__PLAN_APPROVED__` etc.) but a user who types directly in the
// chat textbox ("approve", "lgtm", "继续") would otherwise miss the
// preflight, leaving planState=AWAITING_APPROVAL — the model then sits
// behind the plan-safe gate, can only call read-only tools, and the
// turn ends with empty/short prose. Strict short-message exact match
// (after lowercase + trailing punctuation strip + emoji strip) keeps
// false positives down: "approve" alone matches, "approve, but also
// fix Y" doesn't (length cap + non-equality).
const NL_APPROVED_PHRASES = new Set([
  "approve", "approved", "ok", "okay", "k", "lgtm",
  "yes", "y", "yep", "yeah", "go", "go ahead", "ship it", "ship",
  "do it", "looks good", "looks great", "sounds good", "good",
  "perfect", "great", "agreed", "agree",
  "同意", "批准", "好的", "好", "可以", "继续", "行", "通过",
]);

const NL_CANCELLED_PHRASES = new Set([
  "cancel", "cancelled", "canceled", "no", "n", "nope", "stop",
  "abort", "never mind", "nevermind", "abandon", "don't", "dont",
  "取消", "不要", "算了", "停", "中止", "不",
]);

// Length cap on the normalized text. Approval/cancel intent is short;
// anything longer is more likely a substantive follow-up that should
// pass through to the model (which now sees the natural-language text
// and can choose to keep planning, ask a question, or — if it's a
// less-instruction-following model — re-emit `exit_plan_mode`). Avoids
// false-positive matches like a sentence that incidentally starts
// with "ok" but is actually feedback.
const NL_PHRASE_MAX_LENGTH = 25;

function normalizeNLPlanResponse(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // Strip trailing punctuation (incl. CJK forms) and exclamation.
    .replace(/[!?.,。！？、，]+$/u, "")
    // Strip common emoji/symbol blocks (thumbs up, check mark, etc).
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F9FF}]/gu, "")
    .trim();
}

/**
 * Match the user-message text against approval / cancel / revise
 * sentinels. Trim-exact for approve/cancel, prefix for revise so the
 * feedback can be carried in the same message. Case-sensitive on the
 * sentinels (uppercase ASCII). After the sentinel pass, falls back to
 * a small natural-language whitelist so users typing "approve" /
 * "lgtm" / "继续" in the chat textbox get the same effect as clicking
 * the PlanCard Approve button.
 */
export function detectPlanResponse(text: string): PlanResponse | null {
  const trimmed = text.trim();
  if (trimmed === PLAN_TOKEN_APPROVED) return { kind: "approved" };
  if (trimmed === PLAN_TOKEN_CANCELLED) return { kind: "cancelled" };
  if (trimmed.startsWith(PLAN_TOKEN_REVISED_PREFIX)) {
    return {
      kind: "revised",
      feedback: trimmed.slice(PLAN_TOKEN_REVISED_PREFIX.length).trim(),
    };
  }

  const normalized = normalizeNLPlanResponse(trimmed);
  if (normalized.length === 0 || normalized.length > NL_PHRASE_MAX_LENGTH) {
    return null;
  }
  if (NL_APPROVED_PHRASES.has(normalized)) return { kind: "approved" };
  if (NL_CANCELLED_PHRASES.has(normalized)) return { kind: "cancelled" };
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Sentinel substitution (what the model sees instead of the raw token)
// ──────────────────────────────────────────────────────────────────────

export function syntheticSubstituteFor(response: PlanResponse): string {
  switch (response.kind) {
    case "approved": return "[user approved the plan]";
    case "cancelled": return "[user cancelled the plan]";
    case "revised": return `[user requested revision: ${response.feedback}]`;
  }
}

// ──────────────────────────────────────────────────────────────────────
// System-prompt addenda (one-line per turn, after detection)
// ──────────────────────────────────────────────────────────────────────

export function systemPromptAddendumFor(response: PlanResponse): string {
  switch (response.kind) {
    case "approved":
      return "\n\nThe user has approved your plan. Execute it now. Do not re-plan unless you encounter something unexpected.";
    case "revised":
      return `\n\nThe user requested a revision: ${response.feedback}\n\nYou are still in plan mode. Update your plan accordingly and call exit_plan_mode again.`;
    case "cancelled":
      return "\n\nThe user cancelled the plan. Stop. Do not execute. Acknowledge the cancellation and end the turn.";
  }
}

// ──────────────────────────────────────────────────────────────────────
// Apply a detected response to the message stream (sentinel-strip)
// ──────────────────────────────────────────────────────────────────────

/**
 * Replace the trailing user-message text containing the sentinel with
 * the synthetic substitute, leaving the rest of the messages
 * untouched. Returns a fresh array — the input is not mutated.
 *
 * If the last user message has structured content (an array of
 * blocks), only the textual parts are substituted; tool_result blocks
 * pass through.
 */
export function stripSentinelFromMessages(
  messages: LeaderMessage[],
  response: PlanResponse,
): LeaderMessage[] {
  if (messages.length === 0) return messages;
  const lastIdx = lastUserMessageIndex(messages);
  if (lastIdx < 0) return messages;
  const last = messages[lastIdx]!;
  if (last.type !== "user") return messages;

  const replacement = syntheticSubstituteFor(response);
  const out = messages.slice();
  if (typeof last.content === "string") {
    out[lastIdx] = { ...last, content: replacement };
  } else {
    out[lastIdx] = {
      ...last,
      content: last.content.map((block) =>
        block.type === "text"
          ? { ...block, text: replacement }
          : block,
      ),
    };
  }
  return out;
}

function lastUserMessageIndex(messages: LeaderMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === "user") return i;
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────────
// State transition for an emitted plan event
// ──────────────────────────────────────────────────────────────────────

/**
 * Update the state machine in response to one of the three plan events.
 * Pure function; returns the next state. Idempotent: replaying the
 * same event sequence yields the same final state.
 */
export function transitionPlanState(
  current: PlanState,
  eventType: "leader.plan_mode_entered" | "leader.plan_proposed" | "leader.plan_mode_exited",
  reason?: "approved" | "cancelled" | "revised",
): PlanState {
  switch (eventType) {
    case "leader.plan_mode_entered":
      return current === "IDLE" ? "PLANNING" : current;
    case "leader.plan_proposed":
      return current === "PLANNING" ? "AWAITING_APPROVAL" : current;
    case "leader.plan_mode_exited":
      if (reason === "revised") return "PLANNING";
      return "IDLE";
  }
}
