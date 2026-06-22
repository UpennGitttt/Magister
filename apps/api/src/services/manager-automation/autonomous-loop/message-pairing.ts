import type { LeaderMessage } from "./autonomous-types";

/**
 * Drop orphan / out-of-order `tool_use` and `tool_result` blocks from a
 * LeaderMessage[] stream so the resulting history satisfies Anthropic
 * API invariants:
 *
 *   "every `tool_use` block must be followed by a corresponding
 *    `tool_result` (with matching `tool_use_id`) — and tool results
 *    must come *after* the declaring tool_use in conversation order"
 *
 * Orphans show up when:
 *   - a tool execution crashes / aborts / times out before producing
 *     a tool_result (the tool_use stays in the assistant message but
 *     nothing answers it)
 *   - compaction or a checkpoint replay drops a tool_result without
 *     dropping the originating tool_use
 *   - a user-initiated cancel races with tool execution
 *   - a corrupt or partial stream replay lands a tool_result before
 *     its declaring tool_use
 *
 * Without sanitization the next API call rejects the history with
 * `tool_use ids found without tool_result`, killing the conversation
 * irrecoverably. Mirrors the existing `pairOpenAIToolMessages` (the
 * OpenAI-compat plugin already does this); this is the Anthropic-shape
 * equivalent operating one level higher in the LeaderMessage model so
 * it can also be reused by the autocompact summary call.
 *
 * Two important wrinkles vs. the openai-compat shape:
 *
 *   1. tool_result blocks can appear in TWO forms — either as a
 *      standalone `LeaderToolResultMessage`, or embedded inside a
 *      `LeaderUserMessage.content` array as a `tool_result` content
 *      block. The latter is produced by `enforceAlternatingTurns` in
 *      the resume pipeline (`leader-session-resume-service.ts:117`)
 *      when it merges consecutive user-role messages. Both forms
 *      must be recognised when looking for an "answer".
 *
 *   2. Forward-pairing matters. Anthropic rejects histories where a
 *      tool_result precedes its declaring tool_use. Existence-only
 *      pairing would let an out-of-order corrupt stream survive
 *      sanitisation and 400 the next API call.
 *
 * Algorithm:
 *   Pass 1: collect `answeredIds` — tool_use_ids that appear in some
 *           tool_result (standalone OR embedded), regardless of order.
 *   Pass 2: walk forward, tracking `seenToolUses` (tool_use_ids
 *           encountered up to this point). Emit:
 *     - assistant message with tool_use blocks filtered: drop a
 *       tool_use whose id is not in `answeredIds` (never answered);
 *       keep one whose id is, and add it to `seenToolUses`. If the
 *       resulting assistant message has no text and no tool_use,
 *       drop it entirely.
 *     - standalone tool_result kept iff its toolUseId is already in
 *       `seenToolUses` (drop orphans + out-of-order).
 *     - user message with embedded tool_result blocks: filter out
 *       embedded tool_results whose tool_use_id isn't in
 *       `seenToolUses`; if the user.content array is now empty,
 *       drop the message.
 *
 * Pure function. Idempotent.
 */
export function pairLeaderToolMessages(messages: LeaderMessage[]): LeaderMessage[] {
  // Pass 1 — forward-walk to compute the set of tool_use_ids that form
  // a *valid forward pair*: a tool_use declared FIRST and answered by
  // a tool_result LATER in the stream. Both shapes of tool_result are
  // recognised — standalone messages and embedded blocks inside
  // `user.content` arrays (the post-merge shape produced by
  // `enforceAlternatingTurns` in the resume pipeline).
  //
  // An out-of-order tool_result (precedes its declaring tool_use) is
  // never valid here, so neither side of the pair survives Pass 2 —
  // including the later tool_use that would otherwise become orphaned
  // by dropping just the tool_result. This is what closes the second
  // half of the Anthropic API invariant: not only every tool_use must
  // have a tool_result, the tool_use must come first.
  const validPairIds = new Set<string>();
  const declaredSoFar = new Set<string>();
  const recordResult = (id: string) => {
    if (declaredSoFar.has(id)) validPairIds.add(id);
  };
  for (const m of messages) {
    if (m.type === "assistant") {
      for (const block of m.content) {
        if (block.type === "tool_use") declaredSoFar.add(block.id);
      }
      continue;
    }
    if (m.type === "tool_result") {
      recordResult(m.toolUseId);
      continue;
    }
    if (m.type === "user" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "tool_result") recordResult(block.tool_use_id);
      }
    }
  }

  // Pass 2 — emit pruned stream. A tool_use block is kept iff its id is
  // in `validPairIds`; a tool_result (standalone OR embedded) is kept
  // iff its toolUseId is in `validPairIds`. Assistant messages that
  // become empty (no text + no surviving tool_use) are dropped; same
  // for user messages whose content array filters to empty.
  const out: LeaderMessage[] = [];
  for (const m of messages) {
    if (m.type === "assistant") {
      const filtered = m.content.filter((block) => {
        if (block.type !== "tool_use") return true;
        return validPairIds.has(block.id);
      });
      const hasText = filtered.some(
        (b) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0,
      );
      const hasToolUse = filtered.some((b) => b.type === "tool_use");
      if (!hasText && !hasToolUse) continue;
      out.push({ ...m, content: filtered });
      continue;
    }

    if (m.type === "tool_result") {
      if (!validPairIds.has(m.toolUseId)) continue;
      out.push(m);
      continue;
    }

    if (m.type === "user" && Array.isArray(m.content)) {
      const filtered = m.content.filter((block) => {
        if (block.type !== "tool_result") return true;
        return validPairIds.has(block.tool_use_id);
      });
      if (filtered.length === 0) continue;
      out.push({ ...m, content: filtered });
      continue;
    }

    out.push(m);
  }

  return out;
}
