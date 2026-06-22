/**
 * OpenCode CLI JSON parser.
 *
 * Schema based on opencode output (live capture in
 * apps/api/test/fixtures/cli-events/opencode.json with flag
 * `--format json`).
 *
 * Wire format (one JSON object per line):
 *   {type:"step_start", part:{type:"step-start", id, messageID, snapshot}}
 *   {type:"text", part:{type:"text", id, text, time:{start,end}}}
 *   {type:"step_finish", part:{type:"step-finish", reason, snapshot,
 *     tokens:{total,input,output,reasoning,cache:{write,read}}}}
 *
 * The fixture only had a trivial "say hi" run — schemas for
 * `tool_use` / `tool_result` events are inferred from opencode's ACP
 * naming convention. If a real run shows a different schema, the
 * parser falls through to the system-notice path (no crash, no event
 * loss in the trace panel).
 *
 * Notes:
 *  - opencode's text events arrive whole, NOT streamed. Like codex,
 *    we emit one text_delta per text part for downstream rendering.
 *  - step_start / step_finish are session bookkeeping. We use
 *    step_finish.reason as the final_result reason.
 */
import type { CliEventParser, CliIrEvent, ParserResult } from "../ir";
import { normalizeOpencodeCliTokens } from "../../token-usage-normalization";

interface OpencodeParserState {
  /** Concatenated text from all text parts. */
  fullText: string;
  /** Reason from the last step_finish (typically "stop"). */
  finalReason: string | null;
  /**
   * Codex round-5 [NEW-3] — track which unknown event types we've
   * already warned about, per parser instance. Avoids spamming
   * system_notice events when an unknown type fires repeatedly.
   * Set is per-parser so different teammate runs each get their
   * own warning slate.
   */
  warnedUnknownTypes: Set<string>;
}

export function makeOpencodeParser(): CliEventParser {
  const state: OpencodeParserState = {
    fullText: "",
    finalReason: null,
    warnedUnknownTypes: new Set(),
  };

  function parseEvent(raw: Record<string, unknown>): CliIrEvent[] {
    const type = typeof raw.type === "string" ? raw.type : "";
    const partRaw = raw.part;
    const part = (partRaw && typeof partRaw === "object")
      ? (partRaw as Record<string, unknown>)
      : null;

    switch (type) {
      case "step_start":
        return [];
      case "step_finish": {
        if (!part) return [];
        const reason = typeof part.reason === "string" ? part.reason : null;
        if (reason) state.finalReason = reason === "stop" ? "completed" : reason;
        // Extract token usage. opencode's `step_finish.part` carries
        // `tokens: { total, input, output, reasoning, cache: { write, read } }`.
        // Surface as a usage IR for spawn-service to route into
        // recordUsage(). Model id may live on `snapshot.modelID` on
        // some opencode versions; check there too.
        const tokens = part.tokens && typeof part.tokens === "object"
          ? (part.tokens as Record<string, unknown>)
          : null;
        if (!tokens) return [];
        const normalized = normalizeOpencodeCliTokens(tokens);
        let model: string | null = null;
        const snapshot = part.snapshot && typeof part.snapshot === "object"
          ? (part.snapshot as Record<string, unknown>)
          : null;
        if (snapshot && typeof snapshot.modelID === "string") {
          model = snapshot.modelID;
        }
        if (!normalized || (normalized.inputTokens === 0 && normalized.outputTokens === 0)) return [];
        return [{
          kind: "usage",
          runtime: "opencode",
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
        }];
      }
      case "text": {
        if (!part) return [];
        const text = typeof part.text === "string" ? part.text : "";
        if (!text) return [];
        state.fullText += text;
        return [{ kind: "text_delta", text }];
      }
      // Inferred shapes — kept here as best-effort for tool events.
      case "tool_use": {
        if (!part) return [];
        const id = typeof part.id === "string" ? part.id : "";
        const name = typeof part.name === "string" ? part.name : "";
        const input = part.input ?? {};
        if (!id || !name) return [];
        return [{ kind: "tool_call", id, name, input }];
      }
      case "tool_result": {
        if (!part) return [];
        const id = typeof part.id === "string" ? part.id : "";
        const output = typeof part.output === "string" ? part.output : "";
        const isError = part.is_error === true;
        if (!id) return [];
        return [{ kind: "tool_result", id, output, isError }];
      }
      default: {
        // Codex round-5 [NEW-3] — when opencode emits a tool/lifecycle
        // event we don't recognise (likely real-world tool_use schema
        // differs from our ACP-convention guess at parsers/opencode.ts
        // top-of-file), surface a one-time system notice so the user/
        // operator sees there's a schema gap rather than the event
        // silently dropping. Bookkeeping types (step_start / text /
        // step_finish / tool_use / tool_result) handled above never
        // reach this branch.
        if (type && !state.warnedUnknownTypes.has(type)) {
          state.warnedUnknownTypes.add(type);
          return [{
            kind: "system",
            message: `opencode parser: unrecognised event type "${type}" — parser shipped with limited tool-event coverage; full schema verification pending. (One notice per type per run.)`,
          }];
        }
        return [];
      }
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
          reason: `opencode parser: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!raw || typeof raw !== "object") {
        return { ok: false, reason: "opencode parser: line is not a JSON object" };
      }
      try {
        return { ok: true, events: parseEvent(raw as Record<string, unknown>) };
      } catch (err) {
        return {
          ok: false,
          reason: `opencode parser: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    finalize(exitCode: number): ParserResult {
      const events: CliIrEvent[] = [];
      if (state.fullText) {
        events.push({
          kind: "final_result",
          text: state.fullText,
          reason: state.finalReason ?? (exitCode === 0 ? "completed" : "failed"),
        });
      } else if (exitCode !== 0) {
        events.push({
          kind: "system",
          message: `opencode exited with code ${exitCode} before producing any text`,
        });
      }
      return { ok: true, events };
    },
  };
}
