/**
 * CLI streaming orchestrator.
 *
 * Public API:
 *   - getParserForRuntime(runtime, version): returns a per-CLI parser
 *     OR null if the runtime is unknown / version is below MIN_VERSION.
 *   - irToLeaderEvent(ir): re-exported from ./ir-to-leader-event so
 *     callers don't have to import from two paths.
 *   - CliEventParser, CliIrEvent, ParserResult: re-exported.
 *
 * Caller flow (cli-agent-spawn-service):
 *   const parser = getParserForRuntime(runtimeType, version);
 *   if (parser) {
 *     // line-buffer stdout
 *     // for each line: parser.feedLine(line) → IR events → emit
 *     // on exit: parser.finalize(exitCode) → final IR events → emit
 *   } else {
 *     // black-box mode (current behavior) — accumulate stdout, no
 *     // streaming visibility
 *   }
 */
import type { AgentRuntimeType } from "../agent-profile-service";

import type { CliEventParser } from "./ir";
import { makeClaudeParser } from "./parsers/claude";
import { makeCodexParser } from "./parsers/codex";
import { makeOpencodeParser } from "./parsers/opencode";

export { type CliIrEvent, type CliEventParser, type ParserResult } from "./ir";
export { irToLeaderEvent, mintToolUseId } from "./ir-to-leader-event";

/**
 * Minimum CLI version a parser was verified against. Below this we
 * disable streaming and fall back to black-box mode — running a
 * parser against a CLI version it wasn't tested with risks silent
 * mis-mapping (e.g. event field renamed, type added). Version-bump
 * triggers a re-verification pass.
 *
 *
 * Codex round-4 [C2] — claude is gated behind opt-in env var
 * `CLI_STREAMING_CLAUDE_ENABLED=1`. Reason: claude can emit
 * `control_request` (permission prompt) events that block the
 * process waiting for `control_response` on stdin. The current
 * spawn wiring uses `stdio: ["ignore", "pipe", "pipe"]` — stdin is
 * not connected — so a control_request would hang the run. Until
 * the stdin responder is implemented, claude streaming is off by
 * default. codex/opencode have no analogous gate (no control_request
 * concept).
 */
export const CLI_PARSER_MIN_VERSION: Record<Exclude<AgentRuntimeType, "ucm">, string | null> = {
  "codex": "0.129.0",
  "claude-code": "2.1.137",
  // opencode parser implemented for the verified text-event schema;
  // tool events are best-effort. Set a min version so it activates;
  // real-world use will surface schema gaps fast and we tighten then.
  "opencode": "1.14.39",
  // kiro-cli chat has no machine-readable stream format — null keeps
  // streaming permanently off; kiro runs black-box (accumulated stdout).
  "kiro": null,
};

function isClaudeStreamingExplicitlyDisabled(): boolean {
  const v = process.env.CLI_STREAMING_CLAUDE_ENABLED;
  return v === "0" || v === "false";
}

/**
 * Master kill-switch. Set to "false" via env to disable streaming
 * entirely (revert to black-box for ALL CLI teammates) without a
 * deploy. Used as an escape hatch if a parser regression slips into
 * production.
 */
export function isStreamingEnabled(): boolean {
  const v = process.env.CLI_STREAMING_ENABLED;
  if (v === undefined || v === null || v === "") return true;
  return v !== "false" && v !== "0";
}

/**
 * Returns a fresh parser instance for the given runtime, OR null if:
 *  - runtime is "ucm" (no parser needed — Magister teammates emit events
 *    natively),
 *  - the parser is unknown for this runtime,
 *  - the installed CLI version is below MIN_VERSION,
 *  - the kill-switch env var disabled streaming.
 *
 * Each call returns a NEW parser instance (parsers carry per-stream
 * state — buffers, tool-id sets — so they must not be shared).
 */
export function getParserForRuntime(
  runtime: AgentRuntimeType,
  cliVersion: string | null,
): CliEventParser | null {
  if (!isStreamingEnabled()) {
    // Codex round-4 [I] — log the reason once per disabled spawn so
    // operators don't have to trace silent fallbacks.
    if (runtime !== "ucm") {
      logStreamingDisabledOnce(runtime, "CLI_STREAMING_ENABLED=false");
    }
    return null;
  }
  if (runtime === "ucm") return null;
  // claude streaming is now ON by
  // default. The control_request stdin responder is wired in
  // cli-agent-spawn-service: stdio[0]="pipe" when streaming is
  // active, and the IR control_request handler writes a
  // `control_response { decision: "approve" }` to stdin. The CLI
  // still runs headless from Magister's perspective, so Safe Apply marks
  // the resulting diff for human review.
  // The env var still acts as a kill switch — set
  // CLI_STREAMING_CLAUDE_ENABLED=0 to force black-box for diagnostics.
  if (runtime === "claude-code" && isClaudeStreamingExplicitlyDisabled()) {
    logStreamingDisabledOnce(runtime, "CLI_STREAMING_CLAUDE_ENABLED=0 explicit kill-switch");
    return null;
  }
  const minVersion = CLI_PARSER_MIN_VERSION[runtime];
  if (!minVersion) {
    logStreamingDisabledOnce(runtime, "no parser registered for runtime");
    return null;
  }
  if (!cliVersion) {
    logStreamingDisabledOnce(runtime, "CLI version unknown (probe failed?)");
    return null;
  }
  if (!versionAtLeast(cliVersion, minVersion)) {
    logStreamingDisabledOnce(runtime, `CLI version ${cliVersion} below MIN_VERSION ${minVersion}`);
    return null;
  }

  switch (runtime) {
    case "codex":
      return makeCodexParser();
    case "claude-code":
      return makeClaudeParser();
    case "opencode":
      return makeOpencodeParser();
    default:
      return null;
  }
}

const _streamingDisabledLogged = new Set<string>();
function logStreamingDisabledOnce(runtime: AgentRuntimeType, reason: string): void {
  const key = `${runtime}:${reason}`;
  if (_streamingDisabledLogged.has(key)) return;
  _streamingDisabledLogged.add(key);
  console.log(`[cli-streaming] ${runtime} streaming disabled — ${reason}`);
}

/**
 * Compare two semver-ish strings ("1.14.39" vs "1.14.0"). Returns
 * true iff `actual >= minimum`. Falls back to lexicographic when the
 * version string isn't pure-numeric (so e.g. "2.1.137 (Claude Code)"
 * is normalised by stripping non-numeric trailers).
 */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = parseVersion(actual);
  const minParts = parseVersion(minimum);
  for (let i = 0; i < Math.max(actualParts.length, minParts.length); i++) {
    const a = actualParts[i] ?? 0;
    const m = minParts[i] ?? 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal counts as "at least"
}

function parseVersion(v: string): number[] {
  const cleaned = v.match(/\d+(?:\.\d+)*/);
  if (!cleaned) return [];
  return cleaned[0].split(".").map((p) => Number.parseInt(p, 10) || 0);
}
