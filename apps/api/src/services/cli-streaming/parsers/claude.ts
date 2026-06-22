/**
 * Claude-code stream-json parser.
 *
 * Schema based on claude-code stream-json output (live capture
 * in apps/api/test/fixtures/cli-events/claude.stream-json with flags
 * `--print --output-format stream-json --include-partial-messages
 * --verbose --dangerously-skip-permissions`).
 *
 * Wire format (one JSON object per line). Notable types:
 *
 *   {type:"system", subtype:"hook_started"|"hook_response"|"init"|"status"|...}
 *     — bookkeeping; we mostly skip but surface init as a minor
 *       system notice.
 *
 *   {type:"stream_event", event:{...Anthropic streaming event}}
 *     - event.type:"message_start"|"content_block_start"|
 *       "content_block_delta"|"content_block_stop"|
 *       "message_delta"|"message_stop"
 *     - text deltas: event.type="content_block_delta",
 *       event.delta.type="text_delta", event.delta.text
 *     - thinking deltas: event.delta.type="thinking_delta",
 *       event.delta.thinking
 *     - tool args: stream_event content blocks of type tool_use can
 *       carry input_json_delta; assemble per-block.
 *
 *   {type:"assistant", message:{content:[{type:"text",text}|
 *     {type:"tool_use",id,name,input}|{type:"thinking",thinking}]}}
 *     — final assembled assistant turn (mirrors stream_events but
 *       canonicalised). We use this for tool_use (since tool_use args
 *       arrive as JSON via stream_events but the canonical input is
 *       only attached on the final assistant message).
 *
 *   {type:"user", message:{content:[{type:"tool_result",
 *     tool_use_id, content}]}}
 *     — tool result for a previous tool_use.
 *
 *   {type:"result", subtype:"success"|"error", result, ...}
 *     — final result.
 *
 *   {type:"control_request", request_id, request:{subtype, ...}}
 *     — permission prompts. With --dangerously-skip-permissions +
 *       IS_SANDBOX=1 these should not arrive; if they do we surface
 *       a system notice + the spawn caller is responsible for replying
 *       on stdin.
 *
 *   {type:"rate_limit_event", ...} — telemetry, ignored.
 *
 * Mapping notes:
 *  - We honor stream_events for text/thinking deltas (live tail UX).
 *  - tool_use is emitted on `assistant` finalisation rather than
 *    accumulating per-delta JSON — simpler and the fixture confirms
 *    `assistant` arrives shortly after the final content_block_stop.
 *  - tool_result emitted on `user` events (claude wraps results in a
 *    user-role message).
 */
import type { CliEventParser, CliIrEvent, ParserResult } from "../ir";
import { normalizeClaudeCliUsage } from "../../token-usage-normalization";

interface ClaudeParserState {
  /**
   * Map from tool_use id → emitted-as-tool_call flag, so we don't
   * double-emit when the same tool_use appears in BOTH a stream_event
   * (open during streaming) AND a final assistant message.
   */
  emittedToolUseIds: Set<string>;
  /** Last text seen via `result` event; used for final_result. */
  lastResultText: string;
  /** Final reason: "completed" if result.subtype="success". */
  finalReason: string | null;
}

export function makeClaudeParser(): CliEventParser {
  const state: ClaudeParserState = {
    emittedToolUseIds: new Set(),
    lastResultText: "",
    finalReason: null,
  };

  function parseEvent(raw: Record<string, unknown>): CliIrEvent[] {
    const type = typeof raw.type === "string" ? raw.type : "";
    switch (type) {
      case "system":
        return parseSystem(raw);
      case "stream_event":
        return parseStreamEvent(raw);
      case "assistant":
        return parseAssistant(raw, state);
      case "user":
        return parseUser(raw);
      case "result":
        return parseResult(raw, state);
      case "control_request":
        return parseControlRequest(raw);
      case "rate_limit_event":
        return [];
      default:
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
          reason: `claude parser: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!raw || typeof raw !== "object") {
        return { ok: false, reason: "claude parser: line is not a JSON object" };
      }
      try {
        return { ok: true, events: parseEvent(raw as Record<string, unknown>) };
      } catch (err) {
        return {
          ok: false,
          reason: `claude parser: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    finalize(exitCode: number): ParserResult {
      const events: CliIrEvent[] = [];
      if (state.lastResultText) {
        events.push({
          kind: "final_result",
          text: state.lastResultText,
          reason: state.finalReason ?? (exitCode === 0 ? "completed" : "failed"),
        });
      } else if (exitCode !== 0) {
        events.push({
          kind: "system",
          message: `claude exited with code ${exitCode} before producing a result event`,
        });
      }
      return { ok: true, events };
    },
  };
}

function parseSystem(raw: Record<string, unknown>): CliIrEvent[] {
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  // init carries useful metadata (model, session_id) but most users
  // don't care about hook lifecycle. Skip silently.
  if (subtype === "init") return [];
  if (subtype === "hook_started" || subtype === "hook_response" || subtype === "status") {
    return [];
  }
  return [];
}

function parseStreamEvent(raw: Record<string, unknown>): CliIrEvent[] {
  const event = raw.event;
  if (!event || typeof event !== "object") return [];
  const e = event as Record<string, unknown>;
  const eventType = typeof e.type === "string" ? e.type : "";

  if (eventType === "content_block_delta") {
    const delta = e.delta;
    if (!delta || typeof delta !== "object") return [];
    const d = delta as Record<string, unknown>;
    const dType = typeof d.type === "string" ? d.type : "";
    if (dType === "text_delta") {
      const text = typeof d.text === "string" ? d.text : "";
      if (!text) return [];
      return [{ kind: "text_delta", text }];
    }
    if (dType === "thinking_delta") {
      const text = typeof d.thinking === "string" ? d.thinking : "";
      if (!text) return [];
      return [{ kind: "thinking_delta", text }];
    }
  }
  // Other stream_event subtypes (message_start/stop, content_block_start/stop)
  // are lifecycle-only; the projector seals via leader.turn_complete which
  // we don't have here. The downstream `final_result` from `result` is the
  // canonical seal point.
  return [];
}

function parseAssistant(raw: Record<string, unknown>, state: ClaudeParserState): CliIrEvent[] {
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) return [];
  const events: CliIrEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const blockType = typeof b.type === "string" ? b.type : "";
    if (blockType === "tool_use") {
      const id = typeof b.id === "string" ? b.id : "";
      const name = typeof b.name === "string" ? b.name : "";
      const input = b.input ?? {};
      if (!id || !name) continue;
      if (state.emittedToolUseIds.has(id)) continue;
      state.emittedToolUseIds.add(id);
      events.push({ kind: "tool_call", id, name, input });
    }
    // text/thinking blocks already streamed via stream_event — we do
    // NOT re-emit them here to avoid duplication. The projector
    // sees the streaming text deltas and seals on turn boundary.
  }
  return events;
}

function parseUser(raw: Record<string, unknown>): CliIrEvent[] {
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) return [];
  const events: CliIrEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const blockType = typeof b.type === "string" ? b.type : "";
    if (blockType === "tool_result") {
      const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
      if (!id) continue;
      // claude tool_result.content can be a string OR a content-block
      // array. Coerce to string for the IR.
      const content = b.content;
      let output = "";
      if (typeof content === "string") {
        output = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const sub of content) {
          if (sub && typeof sub === "object") {
            const s = sub as Record<string, unknown>;
            if (typeof s.text === "string") parts.push(s.text);
          }
        }
        output = parts.join("\n");
      }
      const isError = b.is_error === true;
      events.push({ kind: "tool_result", id, output, isError });
    }
  }
  return events;
}

function parseResult(raw: Record<string, unknown>, state: ClaudeParserState): CliIrEvent[] {
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
  const result = typeof raw.result === "string" ? raw.result : "";
  state.lastResultText = result;
  state.finalReason = subtype === "success" ? "completed" : "failed";

  // Extract token usage. claude-code's `result` event carries the
  // canonical aggregate (`usage.input_tokens`, `output_tokens`,
  // `cache_read_input_tokens`, `cache_creation_input_tokens`) plus a
  // `modelUsage` map keyed by model id ("claude-opus-4-7[1m]" etc.).
  // Surface as a single usage IR — the spawn service routes it to
  // `onUsage` → `recordUsage()` in token_usage_records. Final-result
  // text still emits later from finalize().
  const usageEvents: CliIrEvent[] = [];
  const usage = raw.usage && typeof raw.usage === "object"
    ? (raw.usage as Record<string, unknown>)
    : null;
  if (usage) {
    const normalized = normalizeClaudeCliUsage(usage);
    // Model id: prefer first key in modelUsage (claude reports the
    // exact billed slug, e.g. "claude-opus-4-7[1m]"). Fall back to null.
    let model: string | null = null;
    const modelUsage = raw.modelUsage;
    if (modelUsage && typeof modelUsage === "object") {
      const keys = Object.keys(modelUsage as Record<string, unknown>);
      if (keys.length > 0 && keys[0]) model = keys[0];
    }
    if (normalized && (normalized.inputTokens > 0 || normalized.outputTokens > 0)) {
      usageEvents.push({
        kind: "usage",
        runtime: "claude-code",
        model,
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
      });
    }
  }
  // Emitted on finalize() so we don't double-emit if claude continues
  // streaming after a result event (rare but possible). Usage event is
  // safe to emit immediately — it's keyed by run, not by text.
  return usageEvents;
}

function parseControlRequest(raw: Record<string, unknown>): CliIrEvent[] {
  const requestId = typeof raw.request_id === "string" ? raw.request_id : "";
  const request = raw.request;
  if (!request || typeof request !== "object") return [];
  const r = request as Record<string, unknown>;
  const subtype = typeof r.subtype === "string" ? r.subtype : "unknown";
  return [{
    kind: "control_request",
    requestId,
    subtype,
    payload: request,
  }];
}
