import { describe, expect, test } from "bun:test";
import type { LeaderMessage } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import {
  repairToolResultPairing,
  sanitizeThinkingBlocks,
  enforceAlternatingTurns,
  sanitizeResumedMessages,
} from "../../src/services/leader-session-resume-service";

describe("repairToolResultPairing", () => {
  test("removes orphaned tool_use blocks without matching tool_result", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t-orphan", name: "bash", input: { command: "ls" } },
        ],
      },
    ];

    const repaired = repairToolResultPairing(messages);
    expect(repaired).toEqual([
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "checking" }] },
    ]);
  });

  test("removes orphaned tool_result without matching tool_use", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "no tools used" }] },
      { type: "tool_result", toolUseId: "missing-tool-use", content: "orphan result" },
    ];

    const repaired = repairToolResultPairing(messages);
    expect(repaired).toEqual([
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "no tools used" }] },
    ]);
  });
});

describe("sanitizeThinkingBlocks (deprecated, now a no-op)", () => {
  // 2026-05-24 — Stripping thinking blocks on resume was the root cause
  // of "content[].thinking in the thinking mode must be passed back"
  // failures against DeepSeek's anthropic-compat endpoint. The function
  // is now a no-op for back-compat; this test pins that behavior so a
  // future refactor can't accidentally re-introduce the strip.
  test("preserves thinking blocks unchanged (no-op after 2026-05-24)", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "analyze" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "working on it" },
          { type: "thinking", thinking: "private chain-of-thought" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } },
        ],
      },
    ];

    expect(sanitizeThinkingBlocks(messages)).toEqual(messages);
  });
});

describe("enforceAlternatingTurns", () => {
  test("merges two consecutive user messages", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "part 1" },
      { type: "user", content: "part 2" },
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
    ];

    const repaired = enforceAlternatingTurns(messages);
    expect(repaired).toEqual([
      {
        type: "user",
        content: [
          { type: "text", text: "part 1" },
          { type: "text", text: "part 2" },
        ],
      },
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);
  });

  test("merges two consecutive assistant messages", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "go" },
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "text", text: "second" }] },
    ];

    const repaired = enforceAlternatingTurns(messages);
    expect(repaired).toEqual([
      { type: "user", content: "go" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  test("merges tool_result followed by user into a single user turn", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "run command" },
      { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } }] },
      { type: "tool_result", toolUseId: "t1", content: "/tmp" },
      { type: "user", content: "now explain it" },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    expect(enforceAlternatingTurns(messages)).toEqual([
      { type: "user", content: "run command" },
      { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } }] },
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "/tmp" },
          { type: "text", text: "now explain it" },
        ],
      },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("CR Finding 4: preserves requestId on tool_result+user merge (mailbox-drained prompt id survives resume)", () => {
    // After Step 3 (LeaderMessageBase.requestId stamping), the mailbox
    // drain creates user messages adjacent to tool_results. The merge
    // must carry the user message's requestId forward, otherwise the
    // /messages endpoint loses prompt-to-exchange identity on the next
    // resume — frontend silently falls back to tail-pair pairing for
    // post-fix mailbox prompts too, reintroducing the bug.
    const messages: LeaderMessage[] = [
      { type: "user", content: "kick off", requestId: "req_initial" },
      { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      { type: "tool_result", toolUseId: "t1", content: "out" },
      { type: "user", content: "follow-up via mailbox", requestId: "req_mailbox_follow_up" },
    ];
    const merged = enforceAlternatingTurns(messages);
    // Locate the merged tool_result+user turn (index 2).
    const mergedTurn = merged[2];
    expect(mergedTurn?.type).toBe("user");
    expect((mergedTurn as { requestId?: string }).requestId).toBe("req_mailbox_follow_up");
  });

  test("CR Finding 4: keeps prev's requestId when current lacks one (defensive fallback)", () => {
    // tool_result has no requestId field at all; current user message
    // here is missing requestId. The merge should produce a clean user
    // turn with no requestId (since neither input has one) — verifies
    // the fallback chain doesn't crash on the undefined-undefined case.
    const messages: LeaderMessage[] = [
      { type: "user", content: "kick off" },
      { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { type: "tool_result", toolUseId: "t1", content: "out" },
      { type: "user", content: "second" },
    ];
    const merged = enforceAlternatingTurns(messages);
    expect(merged[2]?.type).toBe("user");
    expect((merged[2] as { requestId?: string }).requestId).toBeUndefined();
  });
});

describe("sanitizeResumedMessages", () => {
  test("keeps already-clean messages unchanged", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      {
        type: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
      },
      { type: "tool_result", toolUseId: "t1", content: "fileA" },
      { type: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    const sanitized = sanitizeResumedMessages(messages);
    expect(sanitized).toEqual(messages);
  });

  test("preserves thinking blocks in restored messages (2026-05-24 fix)", () => {
    // Required by DeepSeek's anthropic-compat endpoint and Anthropic
    // Claude extended-thinking mode: when the request enables thinking,
    // every assistant turn in the history must carry its thinking
    // content back, or the API rejects with "content[].thinking in the
    // thinking mode must be passed back."
    const messages: LeaderMessage[] = [
      { type: "user", content: "analyze" },
      {
        type: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "public answer" },
        ],
      },
    ];

    expect(sanitizeResumedMessages(messages)).toEqual(messages);
  });
});
