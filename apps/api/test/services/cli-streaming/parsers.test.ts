/**
 * Plan v2.1 §3.6 / Step 3 — fixture-driven CLI parser tests.
 *
 * Each fixture in `apps/api/test/fixtures/cli-events/` was captured
 * 2026-05-09 against the live CLI (codex 0.129.0, claude 2.1.137,
 * opencode 1.14.39) by running the equivalent of `<cli> say hi`.
 * Re-capture and re-run if the CLI version is bumped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeCodexParser } from "../../../src/services/cli-streaming/parsers/codex";
import { makeClaudeParser } from "../../../src/services/cli-streaming/parsers/claude";
import { makeOpencodeParser } from "../../../src/services/cli-streaming/parsers/opencode";
import {
  getParserForRuntime,
  isStreamingEnabled,
  versionAtLeast,
} from "../../../src/services/cli-streaming";
import type { CliIrEvent } from "../../../src/services/cli-streaming/ir";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures", "cli-events");

function readLines(name: string): string[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

function feedAll(parser: ReturnType<typeof makeCodexParser>, lines: string[]): CliIrEvent[] {
  const events: CliIrEvent[] = [];
  for (const line of lines) {
    const result = parser.feedLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) events.push(...result.events);
  }
  const final = parser.finalize(0);
  expect(final.ok).toBe(true);
  if (final.ok) events.push(...final.events);
  return events;
}

describe("codex usage parsing", () => {
  test("turn.completed emits a usage IR (input/output + cached + reasoning)", () => {
    const lines = readLines("codex.jsonl");
    const parser = makeCodexParser();
    const events = feedAll(parser, lines);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    if (usage?.kind === "usage") {
      expect(usage.runtime).toBe("codex");
      // Fixture: input_tokens=35431, cached_input_tokens=24320,
      // output_tokens=177, reasoning_output_tokens=62. The parser
      // sums output + reasoning into a single outputTokens (both
      // are billed-output spend).
      expect(usage.inputTokens).toBe(35431);
      expect(usage.outputTokens).toBe(177 + 62);
      expect(usage.reasoningTokens).toBe(62);
      expect(usage.nonCachedInputTokens).toBe(35431 - 24320);
      expect(usage.cacheReadTokens).toBe(24320);
      expect(usage.totalTokens).toBe(35431 + 177 + 62);
    }
  });
});

describe("opencode usage parsing", () => {
  test("step_finish emits a usage IR (tokens.input/output + cache)", () => {
    const lines = readLines("opencode.json");
    const parser = makeOpencodeParser();
    const events = feedAll(parser, lines);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    if (usage?.kind === "usage") {
      expect(usage.runtime).toBe("opencode");
      // Fixture: input=14811, output=42, cache.write=0, cache.read=0.
      expect(usage.inputTokens).toBe(14811);
      expect(usage.outputTokens).toBe(42);
      expect(usage.nonCachedInputTokens).toBe(14811);
      expect(usage.cacheReadTokens).toBe(0);
      expect(usage.cacheWriteTokens).toBe(0);
      expect(usage.reasoningTokens).toBe(0);
      expect(usage.totalTokens).toBe(14853);
    }
  });

  test("step_finish computes inclusive totals from opencode token buckets", () => {
    const parser = makeOpencodeParser();
    const result = parser.feedLine(JSON.stringify({
      type: "step_finish",
      part: {
        reason: "stop",
        tokens: {
          total: 165,
          input: 10,
          output: 20,
          reasoning: 30,
          cache: { read: 100, write: 5 },
        },
      },
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const usage = result.events.find((e) => e.kind === "usage");
      expect(usage).toMatchObject({
        kind: "usage",
        runtime: "opencode",
        inputTokens: 115,
        outputTokens: 50,
        nonCachedInputTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 5,
        reasoningTokens: 30,
        totalTokens: 165,
      });
    }
  });
});

describe("codex parser (fixture: codex.jsonl)", () => {
  test("parses thread/turn lifecycle + agent_message into final_result", () => {
    const lines = readLines("codex.jsonl");
    const parser = makeCodexParser();
    const events = feedAll(parser, lines);

    // Fixture has: thread.started, turn.started, item.started/completed
    // (command_execution), item.completed (agent_message), turn.completed.
    // Expect: tool_call (bash) + tool_result + text_delta + final_result.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("final_result");

    const finalResult = events.find((e) => e.kind === "final_result");
    expect(finalResult?.kind).toBe("final_result");
    if (finalResult?.kind === "final_result") {
      // The fixture's agent_message text is "hi".
      expect(finalResult.text).toBe("hi");
      expect(finalResult.reason).toBe("completed");
    }
  });

  test("invalid JSON line returns ok:false without crashing", () => {
    const parser = makeCodexParser();
    const result = parser.feedLine("not-json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid JSON");
    }
  });

  test("empty line is a no-op", () => {
    const parser = makeCodexParser();
    const result = parser.feedLine("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toEqual([]);
  });

  test("non-zero exitCode without text emits a system warning", () => {
    const parser = makeCodexParser();
    const final = parser.finalize(1);
    expect(final.ok).toBe(true);
    if (final.ok) {
      const sys = final.events.find((e) => e.kind === "system");
      expect(sys).toBeDefined();
    }
  });
});

describe("claude parser (fixture: claude.stream-json)", () => {
  test("parses stream events + assistant + result", () => {
    const lines = readLines("claude.stream-json");
    const parser = makeClaudeParser();
    const events = feedAll(parser, lines);

    const kinds = events.map((e) => e.kind);
    // Fixture has at least one text_delta from content_block_delta.
    expect(kinds).toContain("text_delta");
    // result event sets final reason; finalize emits final_result.
    expect(kinds).toContain("final_result");

    const finalResult = events.find((e) => e.kind === "final_result");
    if (finalResult?.kind === "final_result") {
      // The fixture's result text is "Hi!".
      expect(finalResult.text).toBe("Hi!");
      expect(finalResult.reason).toBe("completed");
    }
  });

  test("result event emits a usage IR with cache breakdown", () => {
    const lines = readLines("claude.stream-json");
    const parser = makeClaudeParser();
    const events = feedAll(parser, lines);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    if (usage?.kind === "usage") {
      expect(usage.runtime).toBe("claude-code");
      // Fixture: input_tokens=6, output_tokens=8, cache_read=18273,
      // cache_creation=25324, modelUsage key "claude-opus-4-7[1m]".
      expect(usage.inputTokens).toBe(6 + 18_273 + 25_324);
      expect(usage.nonCachedInputTokens).toBe(6);
      expect(usage.outputTokens).toBe(8);
      expect(usage.cacheReadTokens).toBe(18273);
      expect(usage.cacheWriteTokens).toBe(25324);
      expect(usage.totalTokens).toBe(6 + 18_273 + 25_324 + 8);
      expect(usage.model).toBe("claude-opus-4-7[1m]");
    }
  });

  test("system events (init/hook/status) emit no IR", () => {
    const parser = makeClaudeParser();
    const r1 = parser.feedLine(
      JSON.stringify({ type: "system", subtype: "init", model: "x" }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.events).toEqual([]);
  });

  test("user message with tool_result emits tool_result IR", () => {
    const parser = makeClaudeParser();
    const r = parser.feedLine(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_abc",
          content: "executed ok",
          is_error: false,
        }],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events).toEqual([{
        kind: "tool_result",
        id: "toolu_abc",
        output: "executed ok",
        isError: false,
      }]);
    }
  });

  test("control_request surfaces as control_request IR", () => {
    const parser = makeClaudeParser();
    const r = parser.feedLine(JSON.stringify({
      type: "control_request",
      request_id: "ctl_1",
      request: { subtype: "permission", tool: "bash" },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events.length).toBe(1);
      expect(r.events[0]?.kind).toBe("control_request");
    }
  });
});

describe("opencode parser (fixture: opencode.json)", () => {
  test("parses step_start/text/step_finish into final_result", () => {
    const lines = readLines("opencode.json");
    const parser = makeOpencodeParser();
    const events = feedAll(parser, lines);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("final_result");

    const finalResult = events.find((e) => e.kind === "final_result");
    if (finalResult?.kind === "final_result") {
      expect(finalResult.text).toBe("Hi!");
      // step_finish.reason was "stop" → mapped to "completed".
      expect(finalResult.reason).toBe("completed");
    }
  });
});

describe("getParserForRuntime + version gate", () => {
  test("ucm runtime returns null", () => {
    expect(getParserForRuntime("ucm", "1.0.0")).toBeNull();
  });

  test("version below minimum returns null", () => {
    expect(getParserForRuntime("codex", "0.128.0")).toBeNull();
    expect(getParserForRuntime("claude-code", "2.0.0")).toBeNull();
  });

  test("version at or above minimum returns a parser", () => {
    expect(getParserForRuntime("codex", "0.129.0")).not.toBeNull();
    expect(getParserForRuntime("codex", "0.130.5")).not.toBeNull();
  });

  test("claude streaming is on by default; CLI_STREAMING_CLAUDE_ENABLED=0 force-disables", () => {
    // Plan v2.1 §3.6 / Step 3 part D — claude streaming is on by
    // default once the control_request stdin responder landed. The
    // env var stays as an explicit kill-switch for diagnostics.
    const prior = process.env.CLI_STREAMING_CLAUDE_ENABLED;
    try {
      delete process.env.CLI_STREAMING_CLAUDE_ENABLED;
      expect(getParserForRuntime("claude-code", "2.1.137")).not.toBeNull();
      process.env.CLI_STREAMING_CLAUDE_ENABLED = "0";
      expect(getParserForRuntime("claude-code", "2.1.137")).toBeNull();
      process.env.CLI_STREAMING_CLAUDE_ENABLED = "false";
      expect(getParserForRuntime("claude-code", "2.1.137")).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.CLI_STREAMING_CLAUDE_ENABLED;
      else process.env.CLI_STREAMING_CLAUDE_ENABLED = prior;
    }
  });

  test("missing version returns null (we don't trust unknown CLIs)", () => {
    expect(getParserForRuntime("codex", null)).toBeNull();
  });

  test("CLI_STREAMING_ENABLED=false disables all parsers", () => {
    const prior = process.env.CLI_STREAMING_ENABLED;
    try {
      process.env.CLI_STREAMING_ENABLED = "false";
      expect(isStreamingEnabled()).toBe(false);
      expect(getParserForRuntime("codex", "0.129.0")).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.CLI_STREAMING_ENABLED;
      else process.env.CLI_STREAMING_ENABLED = prior;
    }
  });
});

describe("versionAtLeast", () => {
  test("equal counts as at-least", () => {
    expect(versionAtLeast("1.0.0", "1.0.0")).toBe(true);
  });
  test("higher returns true", () => {
    expect(versionAtLeast("1.0.1", "1.0.0")).toBe(true);
    expect(versionAtLeast("2.0.0", "1.99.99")).toBe(true);
  });
  test("lower returns false", () => {
    expect(versionAtLeast("0.999.999", "1.0.0")).toBe(false);
  });
  test("strips trailing non-numeric junk", () => {
    expect(versionAtLeast("2.1.137 (Claude Code)", "2.1.0")).toBe(true);
  });
});
