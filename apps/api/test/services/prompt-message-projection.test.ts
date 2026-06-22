import { describe, expect, test } from "bun:test";
import { projectPromptMessages } from "../../src/services/prompt-message-projection";

describe("projectPromptMessages", () => {
  test("single user-role text message → one user text block", () => {
    const result = projectPromptMessages([
      { role: "user", content: { type: "text", text: "Review this PR" } },
    ]);
    expect(result.userBlocks).toEqual([{ type: "text", text: "Review this PR" }]);
    expect(result.assistantPreamble).toEqual([]);
  });

  test("user-role image content → flat LeaderContentBlock.image (mediaType + data)", () => {
    const result = projectPromptMessages([
      { role: "user", content: { type: "image", data: "base64data", mimeType: "image/png" } },
    ]);
    expect(result.userBlocks).toEqual([{ type: "image", mediaType: "image/png", data: "base64data" }]);
  });

  test("user-role audio content → text marker (LeaderContentBlock has no audio variant)", () => {
    const result = projectPromptMessages([
      { role: "user", content: { type: "audio", data: "x", mimeType: "audio/mp3" } },
    ]);
    expect(result.userBlocks).toHaveLength(1);
    expect(result.userBlocks[0]).toMatchObject({ type: "text" });
    expect((result.userBlocks[0] as any).text).toContain("audio");
  });

  test("user-role resource_link → text marker", () => {
    const result = projectPromptMessages([
      { role: "user", content: { type: "resource_link", uri: "file:///x.txt", name: "x.txt", mimeType: "text/plain" } },
    ]);
    expect((result.userBlocks[0] as any).text).toContain("file:///x.txt");
    expect((result.userBlocks[0] as any).text).toContain("x.txt");
  });

  test("user-role embedded resource with text → inlined text block", () => {
    const result = projectPromptMessages([
      {
        role: "user",
        content: {
          type: "resource",
          resource: { uri: "file:///doc.md", text: "# Hello", mimeType: "text/markdown" },
        },
      },
    ]);
    expect((result.userBlocks[0] as any).text).toContain("file:///doc.md");
    expect((result.userBlocks[0] as any).text).toContain("# Hello");
  });

  test("user-role embedded resource with blob → text marker", () => {
    const result = projectPromptMessages([
      {
        role: "user",
        content: {
          type: "resource",
          resource: { uri: "file:///x.bin", blob: "AAAA", mimeType: "application/octet-stream" },
        },
      },
    ]);
    expect((result.userBlocks[0] as any).text).toContain("file:///x.bin");
    expect((result.userBlocks[0] as any).text).toContain("blob");
  });

  test("assistant-role text → prepended as LeaderAssistantMessage in preamble", () => {
    const result = projectPromptMessages([
      { role: "assistant", content: { type: "text", text: "I'll help you review this PR." } },
      { role: "user", content: { type: "text", text: "Thanks!" } },
    ]);
    expect(result.userBlocks).toEqual([{ type: "text", text: "Thanks!" }]);
    expect(result.assistantPreamble).toHaveLength(1);
    expect(result.assistantPreamble[0]).toMatchObject({
      type: "assistant",
      content: [{ type: "text", text: "I'll help you review this PR." }],
    });
  });

  test("multi-message: user + assistant + user — preserves order in preamble vs final user", () => {
    const result = projectPromptMessages([
      { role: "user", content: { type: "text", text: "First user msg" } },
      { role: "assistant", content: { type: "text", text: "Priming reply" } },
      { role: "user", content: { type: "text", text: "Second user msg" } },
    ]);
    // Last user message becomes the FIRST-TURN user blocks (current request);
    // earlier user/assistant turns become the assistantPreamble (historical).
    expect(result.userBlocks).toEqual([{ type: "text", text: "Second user msg" }]);
    // assistantPreamble is the FULL prefix conversation (user + assistant
    // alternating), in order, before the last user message.
    expect(result.assistantPreamble.map((m) => m.type)).toEqual(["user", "assistant"]);
  });

  test("empty input → empty result", () => {
    const result = projectPromptMessages([]);
    expect(result.userBlocks).toEqual([]);
    expect(result.assistantPreamble).toEqual([]);
  });
});
