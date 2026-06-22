import { describe, expect, test } from "bun:test";

import { extractCurrentRequestAnswer } from "../../src/services/process-task-intent-service";

// Regression coverage for the "stuck chat shows previous prompt's
// answer" bug (observed 2026-04-30 on task_1777526199920_yl5kfm).
//
// The leader's session checkpoint accumulates ALL turns across the
// session — including prior prompts + their responses. The OLD
// finalAnswer extractor walked the whole checkpoint and used "last
// assistant text wins" semantics. When the CURRENT prompt's response
// was empty (qwen3.5-plus quirk after a short tool result), the
// extractor reached back into the prior prompt and surfaced that
// stale text as the new prompt's finalAnswer.
//
// extractCurrentRequestAnswer scopes the search to messages AFTER
// the last non-meta user message — i.e. the current request's
// response window only.

describe("extractCurrentRequestAnswer", () => {
  test("returns null when there is no user message", () => {
    expect(extractCurrentRequestAnswer([])).toBeNull();
    expect(
      extractCurrentRequestAnswer([
        { type: "assistant", content: [{ type: "text", text: "stranded" }] },
      ]),
    ).toBeNull();
  });

  test("scopes to the current prompt's response, ignoring prior turns", () => {
    // Prompt 1: short Q+A
    // Prompt 2: tool_use + empty assistant response (the bug
    // scenario). Old code returned the prompt-1 text; new code
    // returns null so the caller surfaces an empty-response
    // fallback.
    const messages = [
      { type: "user", content: "成都" },
      {
        type: "assistant",
        content: [{ type: "text", text: "成都今天阴天 15-23°C" }],
      },
      { type: "user", content: "当前工作目录是什么" },
      {
        type: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } },
        ],
      },
      { type: "tool_result", toolUseId: "t1", content: "/opt/acme/..." },
      { type: "assistant", content: [] }, // empty turn-2 response (the bug)
    ];
    expect(extractCurrentRequestAnswer(messages)).toBeNull();
  });

  test("returns the current request's text when present", () => {
    const messages = [
      { type: "user", content: "你好" },
      { type: "assistant", content: [{ type: "text", text: "OLD ANSWER" }] },
      { type: "user", content: "什么是 git?" },
      { type: "assistant", content: [{ type: "text", text: "NEW ANSWER about git" }] },
    ];
    expect(extractCurrentRequestAnswer(messages)).toBe("NEW ANSWER about git");
  });

  test("ignores isMeta user messages (Session Progress / Previous summary)", () => {
    // The compaction flow injects user messages with isMeta:true that
    // carry [Session Progress] or [Previous conversation summary]
    // bodies. Those should NOT be treated as the current prompt
    // boundary.
    const messages = [
      { type: "user", content: "what's the current dir" },
      {
        type: "user",
        content: "[Session Progress]\nfoo",
        isMeta: true,
      },
      {
        type: "assistant",
        content: [{ type: "text", text: "/some/dir" }],
      },
    ];
    expect(extractCurrentRequestAnswer(messages)).toBe("/some/dir");
  });

  test("joins multiple text blocks in the same assistant message — last block wins", () => {
    // Some providers emit multiple text blocks in one assistant
    // message. Last-block-wins matches the original extractor's
    // semantics for the success path.
    const messages = [
      { type: "user", content: "tell me a story" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "first part" },
          { type: "text", text: "final part" },
        ],
      },
    ];
    expect(extractCurrentRequestAnswer(messages)).toBe("final part");
  });

  test("ignores assistant tool_use blocks — only text counts", () => {
    const messages = [
      { type: "user", content: "ping" },
      {
        type: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "x", input: {} },
        ],
      },
      { type: "tool_result", toolUseId: "t1", content: "ok" },
      { type: "assistant", content: [{ type: "text", text: "pong" }] },
    ];
    expect(extractCurrentRequestAnswer(messages)).toBe("pong");
  });

  test("returns null when there ARE messages after the user prompt but none have text", () => {
    // Mirrors the qwen empty-response bug exactly: a tool ran, but
    // the follow-up turn produced no text and no further tool calls.
    const messages = [
      { type: "user", content: "current dir" },
      {
        type: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } },
        ],
      },
      { type: "tool_result", toolUseId: "t1", content: "/opt/acme" },
      { type: "assistant", content: [] },
    ];
    expect(extractCurrentRequestAnswer(messages)).toBeNull();
  });
});
