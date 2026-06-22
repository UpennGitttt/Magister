import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SessionSummaryBanner } from "./SessionSummaryBanner";

const ORIGINAL_FETCH = globalThis.fetch;

function compactionEntry(seq: number, summaryText = "Compacted summary text") {
  return {
    seq,
    taskId: "task_1",
    runId: "run_1",
    recordedAt: "2026-05-27T03:00:00.000Z",
    triggerReason: "hard_cap",
    preCompactTokens: 118700,
    postCompactTokens: 30700,
    freedTokens: 88000,
    truncatedCount: 0,
    snippedCount: 0,
    droppedCount: 0,
    llmCompacted: true,
    llmAttempted: true,
    llmFailedThisTurn: false,
    consecutiveLlmFailures: 0,
    breakerOpen: false,
    summaryText,
    summaryPreview: summaryText,
    preservedTailTokens: null,
    tailStartMessageIdx: null,
    summaryRetryCount: null,
  };
}

function installFetchMock(seq = 7) {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        entries: [compactionEntry(seq)],
        stats: {
          total: 1,
          hardCapTriggers: 1,
          proactiveTriggers: 0,
          llmSuccesses: 1,
          llmFailures: 0,
          meanFreedTokens: 88000,
          meanCompressionRatio: 0.26,
        },
        limit: 1,
        taskId: "task_1",
        truncated: false,
        totalMatching: 1,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  installFetchMock();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("SessionSummaryBanner", () => {
  test("can be dismissed without removing the underlying session summary permanently", async () => {
    const view = render(<SessionSummaryBanner taskId="task_1" />);

    await waitFor(() => {
      expect(view.getByRole("region", { name: /Session summary/i })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /Dismiss session summary/i }));

    await waitFor(() => {
      expect(view.queryByRole("region", { name: /Session summary/i })).toBeNull();
    });
  });
});
