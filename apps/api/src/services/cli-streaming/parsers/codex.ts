/**
 * Codex CLI JSONL parser.
 *
 * Schema based on codex-cli output (live capture in
 * apps/api/test/fixtures/cli-events/codex.jsonl).
 *
 * Wire format (one JSON object per line):
 *   {type:"thread.started", thread_id}
 *   {type:"turn.started"}
 *   {type:"item.started", item:{
 *     id:"item_N", type:"command_execution"|"agent_message"|"reasoning",
 *     command, aggregated_output, exit_code, status:"in_progress"
 *   }}
 *   {type:"item.completed", item:{
 *     id, type, status:"completed"|"failed",
 *     // for command_execution:
 *     command, aggregated_output, exit_code,
 *     // for agent_message:
 *     text,
 *   }}
 *   {type:"turn.completed", usage:{...}}
 *
 * Mapping notes:
 *  - codex does NOT stream agent_message text deltas; the whole text
 *    arrives in a single item.completed. We emit one text_delta with
 *    the full body so downstream rendering still flows through the
 *    streaming text path.
 *  - command_execution.started → tool_call (toolName="bash", input.command)
 *  - command_execution.completed → tool_result (output=aggregated_output,
 *    isError = exit_code !== 0)
 *  - thread.started / turn.started / turn.completed → ignored
 *    (lifecycle bookkeeping, not transcript content)
 *  - reasoning items (when model_reasoning_effort is set) → emit as
 *    thinking_delta when text is present.
 *  - final result: turn.completed has no text; we synthesize a
 *    final_result on finalize() using the last completed agent_message.
 */
import type { CliEventParser, CliIrEvent, ParserResult } from "../ir";
import { normalizeCodexCliUsage } from "../../token-usage-normalization";

interface CodexParserState {
  /** Last agent_message text, used for final_result on finalize. */
  lastAgentText: string;
  /** True once any item.completed (success) was seen. */
  sawAnyCompletion: boolean;
}

export function makeCodexParser(): CliEventParser {
  const state: CodexParserState = {
    lastAgentText: "",
    sawAnyCompletion: false,
  };

  function parseEvent(raw: Record<string, unknown>): CliIrEvent[] {
    const type = typeof raw.type === "string" ? raw.type : "";
    switch (type) {
      case "thread.started":
      case "turn.started":
        return [];
      case "turn.completed":
        // Extract token usage. Codex's `turn.completed` event carries
        // `usage: { input_tokens, output_tokens, cached_input_tokens,
        // reasoning_output_tokens }`. Surface as a usage IR so the
        // spawn service can route it to recordUsage(). The codex
        // event payload doesn't include the model id at this level —
        // it lives on the thread-level config the caller already
        // knows, so we leave model=null and let the dispatch site
        // pass the configured model name through.
        // Final-result text emission stays in finalize() — turn.completed
        // can fire mid-process for multi-turn runs and we don't want
        // to emit final_result prematurely.
        return parseTurnCompletedUsage(raw);
      case "item.started":
        return parseItemStarted(raw.item);
      case "item.completed":
        return parseItemCompleted(raw.item, state);
      default:
        // Unknown event type: skip but don't fail. Codex versions may
        // add new event types; treating unknowns as "skip" keeps
        // parsers forward-compatible.
        return [];
    }
  }

  return {
    feedLine(line: string): ParserResult {
      const trimmed = line.trim();
      if (!trimmed) return { ok: true, events: [] };
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (err) {
        return {
          ok: false,
          reason: `codex parser: invalid JSON line: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!raw || typeof raw !== "object") {
        return { ok: false, reason: "codex parser: line is not a JSON object" };
      }
      try {
        const events = parseEvent(raw as Record<string, unknown>);
        return { ok: true, events };
      } catch (err) {
        return {
          ok: false,
          reason: `codex parser: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    finalize(exitCode: number): ParserResult {
      const events: CliIrEvent[] = [];
      if (state.lastAgentText) {
        events.push({
          kind: "final_result",
          text: state.lastAgentText,
          reason: exitCode === 0 ? "completed" : "failed",
        });
      } else if (!state.sawAnyCompletion) {
        events.push({
          kind: "system",
          message: `codex exited with code ${exitCode} before producing any items`,
        });
      }
      return { ok: true, events };
    },
  };
}

function parseTurnCompletedUsage(raw: Record<string, unknown>): CliIrEvent[] {
  const usage = raw.usage && typeof raw.usage === "object"
    ? (raw.usage as Record<string, unknown>)
    : null;
  if (!usage) return [];
  const normalized = normalizeCodexCliUsage(usage);
  if (!normalized || (normalized.inputTokens === 0 && normalized.outputTokens === 0)) return [];
  return [{
    kind: "usage",
    runtime: "codex",
    model: null,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    ...(normalized.nonCachedInputTokens !== undefined
      ? { nonCachedInputTokens: normalized.nonCachedInputTokens }
      : {}),
    ...(normalized.cacheReadTokens !== undefined ? { cacheReadTokens: normalized.cacheReadTokens } : {}),
    ...(normalized.cacheWriteTokens !== undefined ? { cacheWriteTokens: normalized.cacheWriteTokens } : {}),
    ...(normalized.reasoningTokens !== undefined ? { reasoningTokens: normalized.reasoningTokens } : {}),
    totalTokens: normalized.totalTokens,
    ...(normalized.rawUsage !== undefined ? { rawUsage: normalized.rawUsage } : {}),
  }];
}

function parseItemStarted(item: unknown): CliIrEvent[] {
  if (!item || typeof item !== "object") return [];
  const obj = item as Record<string, unknown>;
  const itemType = typeof obj.type === "string" ? obj.type : "";
  const id = typeof obj.id === "string" ? obj.id : "";
  if (!id) return [];

  if (itemType === "command_execution") {
    const command = typeof obj.command === "string" ? obj.command : "";
    return [{
      kind: "tool_call",
      id,
      name: "bash",
      input: { command },
    }];
  }
  // agent_message and reasoning don't have a meaningful "started"
  // signal — codex emits the whole content in `completed`. Skip the
  // started marker to avoid creating an empty placeholder text part.
  return [];
}

function parseItemCompleted(item: unknown, state: CodexParserState): CliIrEvent[] {
  if (!item || typeof item !== "object") return [];
  const obj = item as Record<string, unknown>;
  const itemType = typeof obj.type === "string" ? obj.type : "";
  const id = typeof obj.id === "string" ? obj.id : "";
  if (!id) return [];

  state.sawAnyCompletion = true;

  if (itemType === "command_execution") {
    const output = typeof obj.aggregated_output === "string" ? obj.aggregated_output : "";
    const exitCode = typeof obj.exit_code === "number" ? obj.exit_code : 0;
    return [{
      kind: "tool_result",
      id,
      output,
      isError: exitCode !== 0,
    }];
  }

  if (itemType === "agent_message") {
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text) return [];
    state.lastAgentText = text;
    // Emit as a single text_delta so the downstream projector
    // creates a TextPart and flows through the streaming text path.
    return [{ kind: "text_delta", text }];
  }

  if (itemType === "reasoning") {
    const text = typeof obj.text === "string" ? obj.text : "";
    if (!text) return [];
    return [{ kind: "thinking_delta", text }];
  }

  return [];
}
