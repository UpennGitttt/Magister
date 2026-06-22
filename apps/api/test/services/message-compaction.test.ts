import { describe, expect, test } from "bun:test";
import type { LeaderMessage } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";

describe("estimateTokenCount", () => {
  test("estimates tokens from message content", async () => {
    const { estimateTokenCount } = await import(
      "../../src/services/manager-automation/autonomous-loop/token-budget"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "Hello world" }, // 11 chars
      { type: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ];

    const count = estimateTokenCount(messages);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
  });

  test("handles empty messages", async () => {
    const { estimateTokenCount } = await import(
      "../../src/services/manager-automation/autonomous-loop/token-budget"
    );
    expect(estimateTokenCount([])).toBe(0);
  });
});

describe("snipOldToolResults", () => {
  test("does not snip when fewer turns than threshold", async () => {
    const { snipOldToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "hi" }] },
    ];

    const result = snipOldToolResults(messages, 200);
    expect(result.snippedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("snips tool results in old turns", async () => {
    const { snipOldToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      // Turn 1
      { type: "user", content: "turn 1" },
      { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { type: "tool_result", toolUseId: "t1", content: "long output from turn 1..." },
      // Turn 2
      { type: "user", content: "turn 2" },
      { type: "assistant", content: [{ type: "tool_use", id: "t2", name: "bash", input: {} }] },
      { type: "tool_result", toolUseId: "t2", content: "long output from turn 2..." },
      // Turn 3
      { type: "user", content: "turn 3" },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
      // Turn 4
      { type: "user", content: "turn 4" },
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
    ];

    // preserveTailTokens=50 — calibrated for these fixture sizes:
    // turn 4 ≈ 10 tok, turn 3 ≈ 10 tok, turn 2 ≈ 23 tok (has
    // tool_use + tool_result), turn 1 ≈ 23 tok. Walking from end:
    // 4+3 = 20, +turn2 = 43 ≤ 50 (kept), +turn1 = 66 > 50 (dropped
    // to head). Net: only turn 1 is in the snippable head.
    const result = snipOldToolResults(messages, 50);
    expect(result.snippedCount).toBe(1); // only turn 1's tool_result snipped
    // Turn 1 tool result should be snipped
    const snipped = result.messages.find(
      (m) => m.type === "tool_result" && (m as any).toolUseId === "t1"
    ) as any;
    expect(snipped.content).toContain("snipped");
    // Turn 2 tool result should be intact (within preserved tail)
    const intact = result.messages.find(
      (m) => m.type === "tool_result" && (m as any).toolUseId === "t2"
    ) as any;
    expect(intact.content).toBe("long output from turn 2...");
  });

  test("preserves assistant text in old turns", async () => {
    const { snipOldToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "turn 1" },
      { type: "assistant", content: [{ type: "text", text: "important reasoning" }] },
      { type: "user", content: "turn 2" },
      { type: "assistant", content: [{ type: "text", text: "more reasoning" }] },
      { type: "user", content: "turn 3" },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
      { type: "user", content: "turn 4" },
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
    ];

    const result = snipOldToolResults(messages, 200);
    expect(result.snippedCount).toBe(0); // no tool results to snip
    const firstAssistant = result.messages.find((m) => m.type === "assistant") as any;
    expect(firstAssistant.content[0].text).toBe("important reasoning");
  });
});

describe("autocompact", () => {
  test("does not compact when fewer turns than threshold", async () => {
    const { autocompact } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "hi" }] },
    ];

    async function* fakeModel() {
      yield { type: "assistant" as const, content: [{ type: "text" as const, text: "summary" }] };
    }

    const result = await autocompact(messages, fakeModel as any, "system prompt", { preserveTailTokens: 2_000 });
    expect(result.compacted).toBe(false);
  });

  test("compacts when more turns than the preserved tail can hold", async () => {
    const { autocompact } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push({ type: "user", content: `turn ${i}` });
      messages.push({ type: "assistant", content: [{ type: "text", text: `response ${i}` }] });
    }

    async function* fakeModel() {
      yield { type: "assistant" as const, content: [{ type: "text" as const, text: "This is a summary of turns 1 and 2." }] };
    }

    // preserveTailTokens=15 → tail budget covers ~last 1 turn (each
    // turn here is ~5-7 estimated tokens). The remaining 4 older
    // turns get summarized.
    const result = await autocompact(messages, fakeModel as any, "system prompt", { preserveTailTokens: 15 });
    expect(result.compacted).toBe(true);
    expect(result.summaryText).toContain("summary");
    expect((result.messages[0] as any).content).toContain("[Previous conversation summary]");
    expect((result.messages[0] as any).content).toContain("summary");
  });

  test("returns original messages if model call fails", async () => {
    const { autocompact } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push({ type: "user", content: `turn ${i}` });
      messages.push({ type: "assistant", content: [{ type: "text", text: `response ${i}` }] });
    }

    async function* fakeModel() {
      throw new Error("API error");
    }

    const result = await autocompact(messages, fakeModel as any, "system prompt", { preserveTailTokens: 15 });
    expect(result.compacted).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.messages.length).toBe(10);
  });
});

describe("truncateLargeToolResults", () => {
  test("truncates only oversized tool results and keeps small ones unchanged", async () => {
    const { truncateLargeToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "run tools" },
      { type: "tool_result", toolUseId: "small", content: "short" },
      { type: "tool_result", toolUseId: "big", content: "x".repeat(12) },
    ];

    const result = truncateLargeToolResults(messages, 10);
    expect({
      truncatedCount: result.truncatedCount,
      smallContent: (result.messages[1] as any).content,
      bigWasTruncated: ((result.messages[2] as any).content as string).startsWith("xxxxxxxxxx\n[truncated"),
    }).toEqual({
      truncatedCount: 1,
      smallContent: "short",
      bigWasTruncated: true,
    });
  });

  // Spec §2 — array-shaped tool_result.content (text + image blocks).
  test("array content: text blocks within budget pass through unchanged", async () => {
    const { truncateLargeToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    const messages: LeaderMessage[] = [
      { type: "user", content: "go" },
      {
        type: "tool_result",
        toolUseId: "ok",
        content: [
          { type: "text", text: "short" },
          { type: "image", mediaType: "image/png", data: "AAAA" },
        ],
      },
    ];
    const result = truncateLargeToolResults(messages, 1000);
    expect(result.truncatedCount).toBe(0);
    expect((result.messages[1] as any).content).toHaveLength(2);
  });

  test("array content: budget exhausted on first text block elides subsequent image (codex review #4)", async () => {
    const { truncateLargeToolResults } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    const messages: LeaderMessage[] = [
      { type: "user", content: "go" },
      {
        type: "tool_result",
        toolUseId: "tight",
        content: [
          { type: "text", text: "x".repeat(50) },   // consumes whole 20-char budget
          { type: "image", mediaType: "image/png", data: "AAAA" },
          { type: "text", text: "trailing" },
        ],
      },
    ];
    const result = truncateLargeToolResults(messages, 20);
    expect(result.truncatedCount).toBe(1);
    const newContent = (result.messages[1] as any).content as Array<{ type: string; text?: string; mediaType?: string }>;
    expect(newContent).toHaveLength(3);
    // First text: cut at 20 + truncation marker
    expect(newContent[0]!.type).toBe("text");
    expect(newContent[0]!.text).toMatch(/^x{20}\n\[truncated/);
    // Image after exhaustion: replaced with elided-image placeholder
    expect(newContent[1]!.type).toBe("text");
    expect(newContent[1]!.text).toContain("[image elided during truncation: image/png]");
    // Trailing text after exhaustion: replaced with [truncated]
    expect(newContent[2]!.type).toBe("text");
    expect(newContent[2]!.text).toBe("[truncated]");
  });
});

describe("dropOldestTurns", () => {
  test("keeps at least one turn when asked to drop too many turns", async () => {
    const { dropOldestTurns } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "turn 1" },
      { type: "assistant", content: [{ type: "text", text: "reply 1" }] },
      { type: "user", content: "turn 2" },
      { type: "assistant", content: [{ type: "text", text: "reply 2" }] },
    ];

    const result = dropOldestTurns(messages, 10);
    expect({
      droppedCount: result.droppedCount,
      hasDropMarker: result.messages[0]?.type === "user" && result.messages[0].isMeta === true,
      firstRemainingUser: (result.messages[1] as any).content,
      messageCount: result.messages.length,
    }).toEqual({
      droppedCount: 1,
      hasDropMarker: true,
      firstRemainingUser: "turn 2",
      messageCount: 3,
    });
  });

  test("does not drop a single-turn conversation", async () => {
    const { dropOldestTurns } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );

    const messages: LeaderMessage[] = [
      { type: "user", content: "solo turn" },
      { type: "assistant", content: [{ type: "text", text: "reply" }] },
    ];

    expect(dropOldestTurns(messages, 1)).toEqual({ messages, droppedCount: 0 });
  });
});

describe("shouldAttemptLlmSummary", () => {
  const base = {
    llmAllowed: true,
    forceUserCompact: false,
    preMechTokens: 1000,
    postMechTokens: 1000,
    proactiveThreshold: 100_000,
    overBudget: false,
  };

  test("manual /compact below threshold STILL attempts the summary (the bug fix)", async () => {
    const { shouldAttemptLlmSummary } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    // Sub-threshold conversation (1k << 100k), but user explicitly /compact'd.
    expect(shouldAttemptLlmSummary({ ...base, forceUserCompact: true })).toBe(true);
  });

  test("non-forced, below threshold, not over budget → no summary (mechanical only)", async () => {
    const { shouldAttemptLlmSummary } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    expect(shouldAttemptLlmSummary(base)).toBe(false);
  });

  test("breaker open (llmAllowed=false) → never attempt, even on manual /compact", async () => {
    const { shouldAttemptLlmSummary } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    expect(
      shouldAttemptLlmSummary({ ...base, llmAllowed: false, forceUserCompact: true }),
    ).toBe(false);
  });

  test("post-mechanical still over threshold → attempt (budget-pressure case)", async () => {
    const { shouldAttemptLlmSummary } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    expect(
      shouldAttemptLlmSummary({ ...base, postMechTokens: 120_000 }),
    ).toBe(true);
  });

  test("pre-mech over threshold + tail not tiny → attempt (rolling-summary case)", async () => {
    const { shouldAttemptLlmSummary } = await import(
      "../../src/services/manager-automation/autonomous-loop/message-compaction"
    );
    // Mechanical brought post under hard need, but pre was over and post is
    // still > 50% of threshold → would benefit from a summary.
    expect(
      shouldAttemptLlmSummary({
        ...base,
        preMechTokens: 120_000,
        postMechTokens: 60_000,
      }),
    ).toBe(true);
  });
});
