import type { LeaderMessage, LeaderAssistantMessage, LeaderModelCallParams } from "./autonomous-types";
import { pairLeaderToolMessages } from "./message-pairing";
import { estimateTokenCount } from "./token-budget";

const SNIP_MARKER = "[snipped — see earlier context]";
const DROP_MARKER = "[ earlier turn(s) dropped to fit context window]";
const PREV_SUMMARY_MARKER = "[Previous conversation summary]";

const MIN_PRESERVE_TAIL_TOKENS = 2_000;
const MAX_PRESERVE_TAIL_TOKENS = 30_000;
const DEFAULT_PRESERVE_TAIL_RATIO = 0.3;

/**
 * Identify turn boundaries in messages.
 * A "turn" starts with a user message and includes all assistant/tool_result messages until the next user message.
 */
export function identifyTurns(messages: LeaderMessage[]): LeaderMessage[][] {
  const turns: LeaderMessage[][] = [];
  let current: LeaderMessage[] = [];

  for (const msg of messages) {
    if (msg.type === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

/**
 * Pull a previous-compaction summary out of the message log if the
 * first message is a meta `[Previous conversation summary]` block.
 * Returns the summary text + the messages with the anchor stripped,
 * so the caller can pass the summary to the LLM as a structured
 * "update this anchor" input rather than treating it as ordinary
 * history that gets re-summarized recursively.
 *
 */
export function extractPreviousSummary(
  messages: LeaderMessage[],
): { previousSummary: string | null; rest: LeaderMessage[] } {
  const head = messages[0];
  if (
    head?.type === "user"
    && head.isMeta === true
    && typeof head.content === "string"
    && head.content.startsWith(PREV_SUMMARY_MARKER)
  ) {
    const text = head.content.slice(PREV_SUMMARY_MARKER.length).replace(/^\n+/, "");
    return { previousSummary: text, rest: messages.slice(1) };
  }
  return { previousSummary: null, rest: messages };
}

/**
 * Walk turns from the END, accumulating estimated token count, until
 * the accumulated total would exceed `budgetTokens`. Always keep at
 * least one turn (the most recent), even if it alone overshoots —
 * dropping the user's current request would render the loop useless.
 *
 * Returns the index of the FIRST turn to preserve (offset into the
 * `turns` array). Earlier turns are candidates for compaction /
 * truncation.
 */
function pickTailStart(turns: LeaderMessage[][], budgetTokens: number): number {
  if (turns.length <= 1) return 0;
  let preservedTokens = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turnTokens = estimateTokenCount(turns[i]!);
    // Never accept zero-budget — always keep at least the last turn.
    if (i === turns.length - 1) {
      preservedTokens += turnTokens;
      continue;
    }
    if (preservedTokens + turnTokens > budgetTokens) {
      return i + 1;
    }
    preservedTokens += turnTokens;
  }
  return 0;
}

/**
 * Token budget for the preserved tail. Defaults to ~30% of the
 * available input budget, clamped to [2k, 30k].
 *
 * Env override `MAGISTER_LEADER_PRESERVE_TAIL_TOKENS` (absolute)
 * wins, otherwise we ratio-scale.
 */
export function getPreserveTailBudget(availableForInput: number): number {
  const env = process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS;
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_PRESERVE_TAIL_TOKENS, Math.max(MIN_PRESERVE_TAIL_TOKENS, parsed));
    }
  }
  return Math.min(
    MAX_PRESERVE_TAIL_TOKENS,
    Math.max(
      MIN_PRESERVE_TAIL_TOKENS,
      Math.floor(availableForInput * DEFAULT_PRESERVE_TAIL_RATIO),
    ),
  );
}

/**
 * Replace tool_result content in old turns with a snip marker.
 * Keeps assistant text responses and user messages intact.
 *
 * Uses a token-budgeted tail (`getPreserveTailBudget`) instead of a
 * fixed turn count — protects against a recent oversized tool_result
 * being un-snipped while older small turns get snipped, which the
 * old fixed-N=3 keepRecentTurns rule could do.
 */
export function snipOldToolResults(
  messages: LeaderMessage[],
  preserveTailTokens: number,
): { messages: LeaderMessage[]; snippedCount: number } {
  const turns = identifyTurns(messages);
  if (turns.length <= 1) return { messages, snippedCount: 0 };

  const tailStart = pickTailStart(turns, preserveTailTokens);
  if (tailStart <= 0) return { messages, snippedCount: 0 };

  let snippedCount = 0;
  const result: LeaderMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (i < tailStart) {
      for (const msg of turn) {
        if (msg.type === "tool_result") {
          result.push({ ...msg, content: SNIP_MARKER });
          snippedCount++;
        } else {
          result.push(msg);
        }
      }
    } else {
      result.push(...turn);
    }
  }
  return { messages: result, snippedCount };
}

/**
 * Truncate oversized tool_result payloads while preserving their beginning.
 */
export function truncateLargeToolResults(
  messages: LeaderMessage[],
  maxCharsPerResult = 8000,
): { messages: LeaderMessage[]; truncatedCount: number } {
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if (msg.type !== "tool_result") return msg;

    // Spec §2 — tool_result.content is now `string | LeaderResultBlock[]`.
    if (typeof msg.content === "string") {
      if (msg.content.length <= maxCharsPerResult) return msg;
      truncatedCount++;
      return {
        ...msg,
        content: `${msg.content.slice(0, maxCharsPerResult)}\n[truncated — original was ${msg.content.length} chars]`,
      };
    }

    // Array form: per-block truncation against a shared budget.
    // - text blocks contribute their char length; tail is sliced
    //   when they overflow the remaining budget
    // - image blocks contribute a small fixed overhead (chars for
    //   their placeholder representation downstream)
    // - once the budget is exhausted, BOTH subsequent text AND
    //   subsequent images become text-placeholders (codex review
    //   #4: pre-fix, images after exhaustion silently passed through,
    //   which let an array bloat past the intended ceiling)
    const IMAGE_BLOCK_OVERHEAD = 64;
    let remaining = maxCharsPerResult;
    let truncatedHere = false;
    const newBlocks = msg.content.map((block) => {
      if (remaining <= 0) {
        truncatedHere = true;
        return {
          type: "text" as const,
          text: block.type === "image"
            ? `[image elided during truncation: ${block.mediaType}]`
            : "[truncated]",
        };
      }
      if (block.type === "image") {
        remaining -= IMAGE_BLOCK_OVERHEAD;
        return block;
      }
      if (block.text.length <= remaining) {
        remaining -= block.text.length;
        return block;
      }
      truncatedHere = true;
      const cut = block.text.slice(0, remaining);
      remaining = 0;
      return {
        type: "text" as const,
        text: `${cut}\n[truncated — text block was ${block.text.length} chars]`,
      };
    });
    if (truncatedHere) truncatedCount++;
    return { ...msg, content: newBlocks };
  });

  return { messages: result, truncatedCount };
}

/**
 * Drop the oldest user-centric turns from history and insert a marker.
 */
export function dropOldestTurns(
  messages: LeaderMessage[],
  turnsToDrop = 1,
): { messages: LeaderMessage[]; droppedCount: number } {
  const sourceMessages = messages[0]?.type === "user"
    && messages[0].isMeta
    && typeof messages[0].content === "string"
    && messages[0].content === DROP_MARKER
    ? messages.slice(1)
    : messages;

  const turns = identifyTurns(sourceMessages);
  // Floor: always keep at least the last turn (most recent user request + response)
  const maxDroppable = Math.max(0, turns.length - 1);
  const droppedCount = Math.max(0, Math.min(turnsToDrop, maxDroppable));

  if (droppedCount === 0) {
    return { messages, droppedCount: 0 };
  }

  const remainingMessages = turns.slice(droppedCount).flat();
  return {
    messages: [
      {
        type: "user",
        content: DROP_MARKER,
        isMeta: true,
      },
      ...remainingMessages,
    ],
    droppedCount,
  };
}

/**
 * Structured Markdown summary template. Forces the model to populate
 * deterministic sections so downstream re-compactions can detect /
 * preserve / merge a prior summary, and so post-compact rendering
 * has a stable shape.
 *
 * The previous prose-paragraph prompt loses information (no explicit
 * Next Steps, Blocked, Relevant Files) and produces a different
 * structure each call, making "merge with previous summary"
 * unreliable.
 */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

/**
 * Pattern-match a thrown error to decide whether it's a
 * context-window overflow (retry by halving input) or something else
 * (auth, rate-limit, network — fail fast and let the circuit breaker
 * handle it).
 *
 * Provider error formats vary: OpenAI emits `code:
 * "context_length_exceeded"`, Anthropic returns 400 with
 * "input is too long", qwen-plus and kimi tend to use a generic 400
 * with "max" or "tokens" in the message. Match liberally on token /
 * length / context substrings (case-insensitive).
 *
 * Surface from kimi review of PR3.
 */
function looksLikeContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  const status = (err as { status?: unknown })?.status;
  if (code === "context_length_exceeded") return true;
  if (status === 413) return true;
  // Common substrings across providers.
  return /context.{0,20}length|context.{0,20}window|max.{0,20}token|too.{0,5}(long|many.{0,5}token)|prompt.{0,5}too|exceeds?.{0,5}(context|token|limit)/i.test(msg);
}

function buildSummaryPrompt(previousSummary: string | null, extraContext?: string[]): string {
  const anchor = previousSummary
    ? [
      "Update the anchored summary below using the conversation history above.",
      "Preserve still-true details, remove stale details, and merge in the new facts.",
      "<previous-summary>",
      previousSummary.trim(),
      "</previous-summary>",
    ].join("\n")
    : "Create a new anchored summary from the conversation history above.";
  const extra = extraContext && extraContext.length > 0
    ? "\n\n<additional-context>\n" + extraContext.join("\n\n") + "\n</additional-context>"
    : "";
  return `${anchor}\n\n${SUMMARY_TEMPLATE}${extra}`;
}

export type AutocompactResult = {
  messages: LeaderMessage[];
  compacted: boolean;
  /** Distinguishes "did nothing because nothing to compact" (`failed: false, compacted: false`)
   *  from "tried summarization and the call errored or returned empty"
   *  (`failed: true`). The autonomous loop uses this for the circuit
   *  breaker — only true LLM failures count toward the strike count. */
  failed?: boolean;
  /** Full LLM-generated summary text (without the preserved tail).
   *  Persisted in `leader.messages_compacted` event for resume / debug
   *  rendering, and used as the previous-summary anchor on the NEXT
   *  compaction. */
  summaryText?: string;
  /** Estimated token count of the preserved tail (for telemetry). */
  preservedTailTokens?: number;
  /** Index into the PRE-compact `messages` array where the preserved
   *  tail starts. Useful for resume code that needs to know the
   *  boundary. */
  tailStartMessageIdx?: number;
  /** Number of summary-call retries the summarization needed. 0 =
   *  succeeded on first attempt; 1-2 = had to drop oldest half(s)
   *  to fit the provider context. Surfaced to the loop so the event
   *  payload can carry it for debugging "why is summary getting
   *  shallower". */
  summaryRetryCount?: number;
};

/**
 * LLM-powered conversation summary for messages that exceed the
 * proactive token threshold or hard cap. Replaces older messages
 * with a structured Markdown summary and keeps a token-budgeted tail.
 *
 * Improvements over the prior 500-word-paragraph version:
 * 1. Structured Markdown template (SUMMARY_TEMPLATE) for deterministic
 *    section coverage and re-compaction friendliness.
 * 2. Token-budgeted tail rather than fixed turn count — protects
 *    against a single oversized recent tool_result being preserved
 *    at the expense of older content.
 * 3. Previous-summary anchor — if the message log already starts
 *    with a `[Previous conversation summary]` block, that block is
 *    extracted and passed to the LLM as `<previous-summary>` so it
 *    UPDATES the anchor instead of re-summarizing-the-summary
 *    (avoids recursive drift).
 * 4. Returns `AutocompactResult` with structured telemetry —
 *    `summaryText`, `preservedTailTokens`, `tailStartMessageIdx`,
 *    and a `failed` flag for circuit-breaker accounting.
 */
/**
 * Decide whether to attempt the LLM (semantic) summary during a compaction
 * pass, AFTER the mechanical tool-result truncate/snip steps have run.
 *
 *  - `llmAllowed`: false when the failure breaker is open → never attempt.
 *  - `forceUserCompact`: a MANUAL `/compact` ALWAYS attempts the summary,
 *    regardless of threshold. Without this, the two threshold-keyed
 *    conditions below are both false when the user compacts a conversation
 *    that's below the proactive bar (the common case — people compact
 *    *before* it auto-fires), so only Steps 1-2 (mechanical tool-result
 *    snip/truncate) ran and the user saw "no summary". autocompact() still
 *    no-ops safely if there's nothing above the preserve-tail to summarize.
 *  - `stillNeedsCompaction`: post-mechanical tokens are still over the
 *    proactive bar or over hard budget — the original budget-pressure case.
 *  - `wouldBenefitFromSummary`: pre-mechanical was over the bar and the tail
 *    isn't already tiny — builds rolling summaries future turns inherit even
 *    when mechanical truncation brought tokens back under (P1.7).
 */
export function shouldAttemptLlmSummary(input: {
  llmAllowed: boolean;
  forceUserCompact: boolean;
  preMechTokens: number;
  postMechTokens: number;
  proactiveThreshold: number;
  overBudget: boolean;
}): boolean {
  if (!input.llmAllowed) return false;
  if (input.forceUserCompact) return true;
  const stillNeedsCompaction =
    input.postMechTokens > input.proactiveThreshold || input.overBudget;
  const wouldBenefitFromSummary =
    input.preMechTokens > input.proactiveThreshold
    && input.postMechTokens > Math.floor(input.proactiveThreshold * 0.5);
  return stillNeedsCompaction || wouldBenefitFromSummary;
}

export async function autocompact(
  messages: LeaderMessage[],
  callModel: (params: LeaderModelCallParams) => AsyncGenerator<LeaderAssistantMessage>,
  systemPrompt: string,
  options: {
    preserveTailTokens: number;
    /** Strings appended to the summary prompt under
     *  `<additional-context>...</additional-context>`. Used by the
     *  loop's `onBeforeCompact` hook to inject ambient facts (e.g.
     *  the read-files ledger). */
    extraContext?: string[];
  },
): Promise<AutocompactResult> {
  // Strip the previous summary if one is present at the head of the
  // log; we'll feed it back to the model as an anchor instead of
  // re-summarizing it as ordinary history.
  const { previousSummary, rest: messagesWithoutAnchor } = extractPreviousSummary(messages);

  const turns = identifyTurns(messagesWithoutAnchor);
  if (turns.length <= 1) {
    // Nothing to compact — only one turn (or empty). Not a failure.
    return { messages, compacted: false };
  }

  // Pick the boundary by token budget (not fixed turn count).
  const tailStartTurnIdx = pickTailStart(turns, options.preserveTailTokens);
  if (tailStartTurnIdx <= 0) {
    // Tail budget already covers everything → nothing to summarize.
    return { messages, compacted: false };
  }

  const oldMessages = turns.slice(0, tailStartTurnIdx).flat();
  const recentMessages = turns.slice(tailStartTurnIdx).flat();
  const preservedTailTokens = estimateTokenCount(recentMessages);

  // Sanitize: if oldMessages has orphan tool_use without tool_result
  // (from a crashed tool execution), the summary call itself would
  // 400 with malformed history. pairLeaderToolMessages drops the
  // orphans cleanly.
  let attemptOldMessages = oldMessages;
  let summaryText = "";
  let summaryRetryCount = 0;
  // Cap retries: each retry halves the input passed to the summary
  // call. Two retries = up to a 4x reduction; beyond that we're
  // effectively summarizing nothing useful, so fail-closed.
  const MAX_SUMMARY_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
    const sanitizedOld = pairLeaderToolMessages(attemptOldMessages);
    const summaryMessages: LeaderMessage[] = [
      ...sanitizedOld,
      { type: "user", content: buildSummaryPrompt(previousSummary, options.extraContext) },
    ];

    try {
      const abortController = new AbortController();
      summaryText = "";
      for await (const msg of callModel({
        messages: summaryMessages,
        systemPrompt,
        tools: [],
        signal: abortController.signal,
      })) {
        for (const block of msg.content) {
          if (block.type === "text") {
            summaryText += block.text;
          }
        }
      }
      summaryRetryCount = attempt;
      break; // success — exit retry loop
    } catch (err) {
      // Only retry when the error looks like a context-window
      // overflow — auth (401/403) and rate-limit (429) errors get no
      // benefit from halving the input and just burn quota. (kimi
      // review.) Any other error type fails immediately.
      if (!looksLikeContextOverflow(err)) {
        return { messages, compacted: false, failed: true };
      }
      if (attempt >= MAX_SUMMARY_RETRIES) {
        return { messages, compacted: false, failed: true };
      }
      // Retry strategy: halve `attemptOldMessages` (drop the OLDEST
      // half) and retry. Common cause of summary failure is the
      // call's own prompt being too long for the provider — the
      // older half is the most expendable. Silently proceeds with
      // less context rather than failing entirely.
      const half = Math.floor(attemptOldMessages.length / 2);
      // If we can't halve any further (length ≤ 1), retrying is a
      // no-op that just re-sends the same prompt. Fail immediately
      // rather than burning the remaining attempts. 
      if (half === 0) {
        return { messages, compacted: false, failed: true };
      }
      attemptOldMessages = attemptOldMessages.slice(half);
      console.warn(
        `[autocompact] summary attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}), retrying with ${attemptOldMessages.length}/${oldMessages.length} oldest messages dropped`,
      );
    }
  }

  // Defensive strip — if a confused model echoes the literal
  // `<template>` / `</template>` tags from the prompt back into its
  // response, we don't want them ending up in the persisted summary.
  // Cheap insurance flagged by kimi-k2.6 review.
  summaryText = summaryText.replace(/<\/?template>/gi, "").trim();

  if (!summaryText) {
    // Empty response — also a failure, otherwise we'd happily replace
    // history with nothing.
    return { messages, compacted: false, failed: true };
  }

  // The pre-compact messages are `messages` (with or without the prior
  // anchor). Compute tailStartMessageIdx in the ORIGINAL `messages`
  // array, so callers using it to slice the original log get the
  // right boundary regardless of whether we stripped an anchor.
  const anchorOffset = previousSummary !== null ? 1 : 0;
  const oldMessageCount = oldMessages.length;
  const tailStartMessageIdx = anchorOffset + oldMessageCount;

  const compactedMessages: LeaderMessage[] = [
    {
      type: "user",
      content: `${PREV_SUMMARY_MARKER}\n${summaryText.trim()}`,
      isMeta: true,
    },
    ...recentMessages,
  ];

  return {
    messages: compactedMessages,
    compacted: true,
    summaryText: summaryText.trim(),
    preservedTailTokens,
    tailStartMessageIdx,
    summaryRetryCount,
  };
}

// Internal exports used by tests for round-tripping / boundary checks.
export const __testing = {
  PREV_SUMMARY_MARKER,
  SUMMARY_TEMPLATE,
  pickTailStart,
  buildSummaryPrompt,
};
