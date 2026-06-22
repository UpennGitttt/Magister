/**
 * pure mapper from CLI IR → Magister
 * `LeaderLoopEvent`. Centralising the policy here means N CLI
 * parsers don't each duplicate "what does a tool_call look like as
 * an SSE event"; future CLIs add a parser, mapping reuses.
 */
import { randomUUID } from "node:crypto";

import type { LeaderLoopEvent } from "../manager-automation/autonomous-loop/autonomous-types";

import type { CliIrEvent } from "./ir";

export function irToLeaderEvent(ir: CliIrEvent): LeaderLoopEvent | null {
  const ts = new Date().toISOString();
  switch (ir.kind) {
    case "text_delta":
      return {
        type: "leader.stream_delta",
        timestamp: ts,
        data: { type: "text_delta", text: ir.text },
      };
    case "thinking_delta":
      return {
        type: "leader.stream_delta",
        timestamp: ts,
        data: { type: "thinking_delta", text: ir.text },
      };
    case "tool_call":
      return {
        type: "leader.tool_call",
        timestamp: ts,
        data: {
          toolUseId: ir.id,
          toolName: ir.name,
          input: ir.input,
          inputSummary: safeStringify(ir.input).slice(0, 2_000),
        },
      };
    case "tool_result":
      return {
        type: "leader.tool_result",
        timestamp: ts,
        data: {
          toolUseId: ir.id,
          isError: ir.isError === true,
          // The teammate transcript view needs the readable output;
          // 8KB cap matches Step 1 §6 outputSummary policy.
          outputSummary: ir.output.slice(0, 8_000),
        },
      };
    case "final_result":
      return {
        type: "leader.session_complete",
        timestamp: ts,
        data: {
          reason: ir.reason ?? "completed",
          // The leader's tool_result for the parent spawn_teammate
          // is constructed elsewhere (capLeaderTeammateText). Here we
          // just record the final text for the transcript / drawer.
          finalText: ir.text,
        },
      };
    case "control_request":
      // No analogous leader event today. Surface as a system notice
      // so the user sees "claude paused for permission" if it slips
      // past the --dangerously-skip-permissions guard. The caller
      // (cli-agent-spawn-service) is responsible for ALSO writing a
      // control_response back to stdin if it wants the run to
      // proceed.
      return {
        type: "leader.system_notice",
        timestamp: ts,
        data: {
          subtype: "cli_control_request",
          message: `CLI requested user input: ${ir.subtype}`,
          requestId: ir.requestId,
          payload: ir.payload,
        },
      };
    case "system":
      return {
        type: "leader.system_notice",
        timestamp: ts,
        data: { subtype: "cli_system", message: ir.message },
      };
    case "usage":
      // Token usage flows through `spawnCliAgent`'s `onUsage` callback
      // (side-channel for recordUsage()), not the leader-event stream.
      // Return null so the IR is consumed without surfacing to the UI.
      return null;
    default: {
      // Exhaustiveness — TS will yell if a new IR kind is added
      // without handling here.
      const _exhaustive: never = ir;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Codex's `command_execution` items have synthetic ids like
 * `item_0`. Claude's tool_use blocks have provider ids like
 * `toolu_xxx`. Opencode's parts have `prt_xxx`. To keep parents
 * paired with results across CLIs we use the CLI's id directly —
 * but if a parser ever needs to mint one (e.g. text_delta with no
 * stable id), call `mintToolUseId()`.
 */
export function mintToolUseId(): string {
  return `tu_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
