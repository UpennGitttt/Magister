import type { LeaderMessage } from "../manager-automation/autonomous-loop/autonomous-types";
import { estimateTokenCount } from "../manager-automation/autonomous-loop/token-budget";
import { identifyTurns } from "../manager-automation/autonomous-loop/message-compaction";

export const OPTIMIZER_CONTEXT_TOKEN_LIMIT = 100_000;
export const OPTIMIZER_KEEP_HEAD_TURNS = 2;
export const OPTIMIZER_KEEP_TAIL_TURNS = 6;

export type SnipResult = {
  messages: LeaderMessage[];
  compressed: boolean;
  inputTokens: number;
};

export function snipForOptimizer(messages: LeaderMessage[]): SnipResult {
  const originalTokens = estimateTokenCount(messages);
  if (originalTokens <= OPTIMIZER_CONTEXT_TOKEN_LIMIT) {
    return { messages, compressed: false, inputTokens: originalTokens };
  }

  const turns = identifyTurns(messages);
  // Not enough turns to bother snipping — pass through.
  if (turns.length <= OPTIMIZER_KEEP_HEAD_TURNS + OPTIMIZER_KEEP_TAIL_TURNS) {
    return { messages, compressed: false, inputTokens: originalTokens };
  }

  const head = turns.slice(0, OPTIMIZER_KEEP_HEAD_TURNS).flat();
  const tail = turns.slice(-OPTIMIZER_KEEP_TAIL_TURNS).flat();
  const middle = turns.slice(OPTIMIZER_KEEP_HEAD_TURNS, -OPTIMIZER_KEEP_TAIL_TURNS).flat();

  // Snip tool_result content in middle turns.
  const snippedMiddle: LeaderMessage[] = middle.map((msg) => {
    if (msg.type !== "tool_result") return msg;
    const contentLen = typeof msg.content === "string"
      ? msg.content.length
      : Array.isArray(msg.content)
        ? msg.content.reduce((acc, b) => acc + (b.type === "text" ? b.text.length : 100), 0)
        : 0;
    return {
      ...msg,
      content: `[tool result snipped: ${contentLen} chars]`,
    };
  });

  const result = [...head, ...snippedMiddle, ...tail];
  return {
    messages: result,
    compressed: true,
    inputTokens: estimateTokenCount(result),
  };
}
