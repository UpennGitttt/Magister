import type { LeaderMessage } from "./autonomous-types";

// Proactive-compaction trigger as a RATIO of the available input
// budget. Tunable via env (see getAutocompactThreshold).
const DEFAULT_AUTOCOMPACT_RATIO = 0.7;
// Per-image cost approximation. Vision-model invoices charge
// roughly 1.0-1.6k tokens per image (Claude Sonnet 4 ≈ 1568,
// gpt-4o tile-based ≈ 85-765, qwen-vl-plus ≈ 1k-2k). We pick a
// midpoint that errs slightly high so compaction headroom stays
// safe rather than underestimating an image-heavy turn.
const APPROX_TOKENS_PER_IMAGE = 1600;
// Token estimation: ASCII text is ~4 chars/token, but CJK / emoji
// run ~1 char/token. The earlier flat `chars / 4` undercounted
// CJK-heavy contexts by ~4x — large Chinese/Japanese/Korean
// transcripts blew past the actual context window long before our
// estimator caught up, and compaction never fired (observed: 21
// turns, 2.4M cumulative input tokens, 0 compactions).
//
// Heuristic: count "fat" codepoints (Unicode > 0x7F) as 1 token
// each, ASCII as 1 token per ~4 chars.
const CHARS_PER_TOKEN_ASCII = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const OUTPUT_RESERVE_RATIO = 0.15;

export type TokenBudget = {
  totalBudget: number;
  reserveForOutput: number;
  availableForInput: number;
};

/**
 * Mixed-script-aware token estimator. Counts CJK / emoji / other
 * non-ASCII codepoints at ~1 token each and ASCII at ~4 chars/token,
 * mirroring real tokenizer behavior closely enough to get compaction
 * triggers right for both English and Chinese-heavy conversations.
 *
 * Real tokenizers are a per-model black box; this is a heuristic.
 * It's deliberately conservative (slightly OVERestimates rather than
 * under) so compaction fires a touch early rather than letting the
 * context overflow.
 */
function estimateTextTokens(text: string): number {
  let asciiChars = 0;
  let fatChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) fatChars++;
    else asciiChars++;
  }
  return Math.ceil(asciiChars / CHARS_PER_TOKEN_ASCII) + fatChars;
}

/**
 * Estimate tokens for a user-content block array. Walking the blocks
 * (instead of `JSON.stringify(content)`) matters for image
 * attachments — the base64 `data` field of a 1 MB PNG is ~1.3M chars
 * of ASCII, which the flat-stringify path would charge as ~325k
 * estimated tokens, whereas the real wire cost is ~1.6k tokens for
 * vision models. Without this walk, a single attached image trips
 * compaction immediately on every turn that includes it.
 */
// Cap on the JSON-stringify fallback for unknown blocks. Without
// this, a tool_use with a 100k-char `input` payload would charge
// the full byte count and re-introduce the same overcount bug the
// image walker fixed (kimi P1.5 review M).
const UNKNOWN_BLOCK_TOKEN_CAP = 4000;

function estimateBlockArrayTokens(blocks: ReadonlyArray<{ type: string; [k: string]: unknown }>): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "image") {
      total += APPROX_TOKENS_PER_IMAGE;
    } else if (block.type === "text" && typeof block.text === "string") {
      total += estimateTextTokens(block.text);
    } else if (block.type === "tool_use") {
      // Anthropic-style tool_use: name + JSON input. Real tokens =
      // tool name + serialized input + a small framing overhead.
      // We charge `name` text tokens + `input` text tokens (skipping
      // the JSON braces/quotes). Cap at UNKNOWN_BLOCK_TOKEN_CAP for
      // oversized inputs to keep estimator safe.
      const name = typeof block.name === "string" ? block.name : "";
      const input = block.input != null ? JSON.stringify(block.input) : "";
      total += Math.min(
        UNKNOWN_BLOCK_TOKEN_CAP,
        estimateTextTokens(name) + estimateTextTokens(input),
      );
    } else if (block.type === "tool_result") {
      // tool_result blocks shouldn't appear in user-content arrays
      // typically (they're top-level messages of msg.type ==
      // "tool_result"), but be defensive: stringify the `content`
      // field with the same cap.
      const content = block.content != null
        ? typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content)
        : "";
      total += Math.min(UNKNOWN_BLOCK_TOKEN_CAP, estimateTextTokens(content));
    } else {
      // Future block types (audio, video, document, ...). Fall back
      // to JSON-stringify cost BUT cap to keep a bad block from
      // false-tripping compaction.
      total += Math.min(
        UNKNOWN_BLOCK_TOKEN_CAP,
        estimateTextTokens(JSON.stringify(block)),
      );
    }
  }
  return total;
}

export function estimateTokenCount(messages: LeaderMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.type === "user") {
      if (typeof msg.content === "string") {
        total += estimateTextTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        total += estimateBlockArrayTokens(
          msg.content as ReadonlyArray<{ type: string; [k: string]: unknown }>,
        );
      } else {
        total += estimateTextTokens(JSON.stringify(msg.content));
      }
    } else if (msg.type === "assistant") {
      // Assistant content is always a block array (text / tool_use)
      // with no images today; flat stringify is fine.
      total += estimateTextTokens(JSON.stringify(msg.content));
    } else if (msg.type === "tool_result") {
      // Spec §2 — tool_result.content is now `string | LeaderResultBlock[]`.
      // For block arrays: text blocks contribute their text tokens;
      // image blocks contribute a fixed per-image vision cost
      // (same as the user-attachment estimator path).
      if (typeof msg.content === "string") {
        total += estimateTextTokens(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            total += estimateTextTokens(block.text);
          } else if (block.type === "image") {
            // Fixed approximation matching the user-attachment cost
            // assumption (Anthropic vision pricing rounds to ~1.6k
            // tokens for a typical 1024×768 image). Capped so a
            // mega-image doesn't blow the estimate.
            total += Math.min(UNKNOWN_BLOCK_TOKEN_CAP, 1600);
          }
        }
      }
    }
  }
  return total;
}

export function computeTokenBudget(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): TokenBudget {
  const totalBudget = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserveForOutput = Math.max(
    maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    Math.floor(totalBudget * OUTPUT_RESERVE_RATIO),
  );
  return {
    totalBudget,
    reserveForOutput,
    availableForInput: totalBudget - reserveForOutput,
  };
}

export function isOverBudget(estimatedTokens: number, budget: Pick<TokenBudget, "availableForInput">): boolean {
  return estimatedTokens > budget.availableForInput;
}

/**
 * Proactive compaction threshold — the per-call input-token count
 * above which compaction fires BEFORE we hit the hard
 * `availableForInput` ceiling. Earlier compaction = lower cumulative
 * token cost across long sessions (each turn re-sends the full
 * history; compacting at 70% drops the replayed tail).
 *
 * Resolution order:
 *   1. `MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD` (absolute token count)
 *      — back-compat with the original env knob.
 *   2. `MAGISTER_LEADER_AUTOCOMPACT_RATIO` (fraction of
 *      `availableForInput`).
 *   3. Default 0.6 × `availableForInput`.
 *
 * The hard `isOverBudget` check at `availableForInput` still fires as
 * a last-resort cap — this threshold is the proactive trigger.
 */
export function getAutocompactThreshold(budget: Pick<TokenBudget, "availableForInput">): number {
  const absoluteEnv = process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD;
  if (absoluteEnv) {
    const parsed = Number.parseInt(absoluteEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const ratioEnv = process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO;
  if (ratioEnv) {
    const parsed = Number.parseFloat(ratioEnv);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
      return Math.floor(budget.availableForInput * parsed);
    }
  }
  return Math.floor(budget.availableForInput * DEFAULT_AUTOCOMPACT_RATIO);
}
