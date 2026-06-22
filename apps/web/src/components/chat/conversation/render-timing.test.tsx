import "../../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ExchangeView } from "./render";
import type { Exchange, ResponsePart, ToolPart } from "./types";

const TASK_ID = "task_timing_render";

afterEach(() => {
  cleanup();
});

function makeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    id: "req_timing_render",
    status: "streaming",
    user: { content: "Summarize recent commits" },
    response: { parts: [] },
    lastAppliedSeq: 0,
    ...overrides,
  };
}

function withMockedNow<T>(nowMs: number, callback: () => T): T {
  const realDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    return callback();
  } finally {
    Date.now = realDateNow;
  }
}

function teammateTool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    id: "req_timing_render:tool:toolu_spawn",
    toolUseId: "toolu_spawn",
    name: "spawn_teammate",
    input: { role: "coder", goal: "Implement transcript scanner" },
    result: null,
    teammateRunId: "rt_coder",
    teammateRole: "coder",
    teammateName: "Coder",
    teammateStatus: "running",
    transcriptEventCount: 0,
    transcript: [],
    ...overrides,
  } as ToolPart;
}

function regularTool(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    id: "req_timing_render:tool:toolu_search",
    toolUseId: "toolu_search",
    name: "search_files",
    input: { q: "skills" },
    result: { isError: false, output: "ok" },
    ...overrides,
  };
}

describe("Exchange timing row", () => {
  test("shows a live Working timer while the exchange is running", () => {
    const nowMs = 1_000_000;
    const view = withMockedNow(nowMs, () =>
      render(
        <ExchangeView
          taskId={TASK_ID}
          exchange={makeExchange({
            timing: {
              startedAtMs: nowMs - 189_000,
              pausedMs: 0,
            },
          })}
        />,
      ),
    );

    expect(view.getByText(/Working \(3m 09s\)/)).toBeTruthy();
  });

  test("shows final worked duration after completion", () => {
    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          status: "complete",
          timing: {
            startedAtMs: 1_000,
            completedAtMs: 517_000,
            wallMs: 516_000,
            pausedMs: 0,
            elapsedMs: 516_000,
          },
        })}
      />,
    );

    expect(view.getByText(/Worked for 8m 36s/)).toBeTruthy();
  });

  test("shows paused approval state without advancing worked time", () => {
    const nowMs = 1_000_000;
    const view = withMockedNow(nowMs, () =>
      render(
        <ExchangeView
          taskId={TASK_ID}
          exchange={makeExchange({
            timing: {
              startedAtMs: nowMs - 120_000,
              pausedMs: 0,
              activePauseStartedAtMs: nowMs - 30_000,
            },
          })}
        />,
      ),
    );

    expect(view.getByText(/Paused for approval · worked 1m 30s/)).toBeTruthy();
  });

  test("shows timing and tool summary above the assistant response without token or cost metrics", () => {
    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          status: "complete",
          response: {
            parts: [
              {
                kind: "text",
                id: "req_timing_render:text:0",
                content: "Done",
                sealed: true,
                buffer: null,
              },
            ],
          },
          timing: {
            startedAtMs: 1_000,
            completedAtMs: 6_000,
            wallMs: 5_000,
            pausedMs: 0,
            elapsedMs: 5_000,
          },
        })}
        turnSummary={{
          requestId: "req_timing_render",
          status: "completed",
          timing: {
            startedAtMs: 1_000,
            completedAtMs: 6_000,
            wallMs: 5_000,
            pausedMs: 0,
            elapsedMs: 5_000,
          },
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
          },
          toolSummary: {
            readCount: 1,
            writeCount: 0,
            approvalCount: 0,
            delegationCount: 1,
            failedCount: 1,
            totalCount: 2,
          },
        }}
      />,
    );

    const timing = view.getByText("Worked for 5s");
    const answer = view.getByText("Done");
    expect(timing.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.getByText("Tools 2")).toBeTruthy();
    expect(view.getByText("Failed 1")).toBeTruthy();
    expect(view.queryByText(/Tokens/)).toBeNull();
    expect(view.queryByText(/Cost/)).toBeNull();
  });

  test("keeps timing fixed above the assistant response when tools precede text", () => {
    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          status: "complete",
          response: {
            parts: [
              regularTool(),
              {
                kind: "text",
                id: "req_timing_render:text:0",
                content: "Here are the skill details.",
                sealed: true,
                buffer: null,
              },
            ],
          },
          timing: {
            startedAtMs: 1_000,
            completedAtMs: 57_000,
            wallMs: 56_000,
            pausedMs: 0,
            elapsedMs: 56_000,
          },
        })}
      />,
    );

    const tool = view.getByText("search_files");
    const timing = view.getByText("Worked for 56s");
    const answer = view.getByText("Here are the skill details.");

    expect(timing.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timing.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Teammate transcript row", () => {
  test("collapsed row summarizes role, runtime, duration, tool count, and last message", () => {
    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          response: {
            parts: [
              teammateTool({
                teammateStatus: "completed",
                transcriptEventCount: 125,
                teammateRuntime: "codex",
                teammateModel: "gpt-5.3-codex",
                teammateStartedAtMs: 1_000,
                teammateCompletedAtMs: 66_000,
                teammateToolCount: 3,
                teammateLastMessage: "Found the grouping bug in replay.",
              }),
            ],
          },
        })}
      />,
    );

    expect(view.getByText("coder")).toBeTruthy();
    // 2026-05-24 — operator's spawn-card slim-down (commit 198b022)
    // removed the standalone runtime chip; the model chip stays.
    expect(view.getByText("gpt-5.3-codex")).toBeTruthy();
    expect(view.getByText("1m 05s")).toBeTruthy();
    expect(view.getByText("Tools 3")).toBeTruthy();
    expect(view.getByText(/Found the grouping bug/)).toBeTruthy();
  });

  test("failed teammate expansion exposes failure reason and suggested next action", () => {
    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          response: {
            parts: [
              teammateTool({
                teammateStatus: "failed",
                teammateFailureReason: "CLI exited with code 1",
                teammateNextAction: "Inspect the transcript, fix auth, then retry this teammate.",
              }),
            ],
          },
        })}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /coder/i }));

    expect(view.getByText("Failure reason")).toBeTruthy();
    expect(view.getByText("CLI exited with code 1")).toBeTruthy();
    expect(view.getByText("Suggested next action")).toBeTruthy();
    expect(view.getByText("Inspect the transcript, fix auth, then retry this teammate.")).toBeTruthy();
  });

  test("expanded long teammate transcript renders head and tail instead of every event", () => {
    const transcript: ResponsePart[] = Array.from({ length: 120 }, (_, idx) => ({
      kind: "text",
      id: `teammate:text:${idx}`,
      content: `event ${idx}`,
      sealed: true,
      buffer: null,
    }));

    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          response: {
            parts: [
              teammateTool({
                transcript,
                transcriptEventCount: 120,
              }),
            ],
          },
        })}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /coder/i }));

    expect(view.getByText("event 0")).toBeTruthy();
    expect(view.queryByText("event 70")).toBeNull();
    expect(view.getByText("event 119")).toBeTruthy();
    expect(view.getByText(/60 events collapsed \(total 120\)/)).toBeTruthy();
  });

  test("expanded teammate card shows duplicate final output only once", () => {
    const finalText = "UNIQUE_TEAMMATE_FINAL_OUTPUT";
    const transcript: ResponsePart[] = [
      {
        kind: "text",
        id: "teammate:text:intro",
        content: "I inspected the code path.",
        sealed: true,
        buffer: null,
      },
      {
        kind: "text",
        id: "teammate:text:final",
        content: finalText,
        sealed: true,
        buffer: null,
      },
    ];

    const view = render(
      <ExchangeView
        taskId={TASK_ID}
        exchange={makeExchange({
          response: {
            parts: [
              teammateTool({
                teammateStatus: "completed",
                transcript,
                transcriptEventCount: transcript.length,
                teammateSummary: finalText,
                result: { isError: false, output: finalText },
              }),
            ],
          },
        })}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /coder/i }));

    expect(view.getAllByText(finalText)).toHaveLength(1);
    expect(view.getByText("Final summary")).toBeTruthy();
    expect(view.queryByText("Result")).toBeNull();
    expect(view.getByText("I inspected the code path.")).toBeTruthy();
  });
});
