/**
 * Cli streaming intermediate
 * representation. Each per-CLI parser turns vendor-specific JSON
 * lines into this normalized shape; one shared mapper
 * (`ir-to-leader-event.ts`) converts IR to Magister's `LeaderLoopEvent`s
 * which then flow through the same projector path as Magister teammates.
 *
 * The IR is intentionally narrow — only the event kinds Magister cares
 * about for transcript display. Vendor-specific details (codex's
 * `aggregated_output`, claude's `cache_creation_tokens`, opencode's
 * `snapshot`) are dropped at parse time, NOT carried through.
 */

export type CliIrEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | {
      kind: "tool_call";
      /** Stable id assigned by the CLI; used to pair with tool_result. */
      id: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      /** Matches the corresponding `tool_call.id`. */
      id: string;
      output: string;
      isError?: boolean;
    }
  | { kind: "final_result"; text: string; reason?: string }
  | {
      kind: "control_request";
      requestId: string;
      subtype: string;
      payload: unknown;
    }
  | { kind: "system"; message: string }
  | {
      /** Token-usage record extracted from a CLI's terminal event
       *  (claude-code "result", codex "turn.completed", opencode
       *  "step_finish"). Goes to the side-channel `onUsage` callback
       *  on `spawnCliAgent` — not translated to a leader event, since
       *  recordUsage() takes a different shape than LeaderLoopEvent. */
      kind: "usage";
      runtime: "claude-code" | "codex" | "opencode";
      /** Model id the CLI reported; null when absent in the wire payload. */
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      nonCachedInputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
      rawUsage?: unknown;
    };

export type ParserResult =
  | { ok: true; events: CliIrEvent[] }
  | { ok: false; reason: string };

export interface CliEventParser {
  /**
   * Feed one line of stdout. Returns 0..N IR events. Returning
   * `ok: false` signals a parse failure for THIS line (e.g.
   * malformed JSON); the caller can log and continue or fall back
   * to black-box mode for the rest of the run.
   */
  feedLine(line: string): ParserResult;
  /**
   * Called when the child process exits. Returns any final IR
   * events the parser was holding (typically `final_result`).
   */
  finalize(exitCode: number): ParserResult;
}
