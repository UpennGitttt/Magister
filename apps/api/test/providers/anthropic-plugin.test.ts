import { test, expect } from "bun:test";

import { anthropicPlugin } from "../../src/providers/plugins/anthropic-plugin";
import type { LeaderMessage } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";

test("convertMessages emits Anthropic-style assistant blocks and user tool_result blocks", () => {
  const input: LeaderMessage[] = [
    { type: "user", content: "hello" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
    },
    { type: "tool_result", toolUseId: "t1", content: "file-a" },
  ];

  // P1.6 — convertMessages adds cache_control: ephemeral on the
  // LAST content block of the LAST user message that comes BEFORE
  // the final message. Here the second-to-last user message is the
  // initial "hello" (we walk past the assistant in between), and
  // its string content gets promoted to a single text block carrying
  // the cache marker.
  expect(anthropicPlugin.convertMessages(input, "system prompt")).toEqual({
    system: "system prompt",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
        ],
      },
      {
        role: "assistant",
        content: [
          // 2026-05-24 — synthetic thinking placeholder. Assistant
          // messages reaching the converter with no thinking block
          // (legacy checkpoint, pre-2026-05-24 sanitizer, or an
          // upstream accumulator bug) get a single-char placeholder
          // prepended so DeepSeek's anthropic-compat + Anthropic
          // extended-thinking don't reject with "content[].thinking
          // in the thinking mode must be passed back." A real
          // thinking block, when present in the source message, is
          // emitted ahead of this placeholder path.
          { type: "thinking", thinking: " " },
          { type: "text", text: "running" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file-a" }],
      },
    ],
  });
});

test("assistant message WITH thinking passes through unchanged (no duplicate placeholder)", () => {
  const input: LeaderMessage[] = [
    { type: "user", content: "go" },
    {
      type: "assistant",
      content: [
        { type: "thinking", thinking: "let me consider..." },
        { type: "text", text: "ok" },
      ],
    },
  ];
  const result = anthropicPlugin.convertMessages(input, "sys");
  const assistant = (result.messages as Array<{ role: string; content: any }>)[1]!;
  expect(assistant.role).toBe("assistant");
  const blocks = assistant.content as Array<{ type: string; thinking?: string; text?: string }>;
  // Real thinking preserved exactly — no placeholder injection.
  expect(blocks.length).toBe(2);
  expect(blocks[0]).toEqual({ type: "thinking", thinking: "let me consider..." });
  expect(blocks[1]).toEqual({ type: "text", text: "ok" });
});

test("assistant message with ONLY tool_use also gets a thinking placeholder", () => {
  // The demo-service task that failed 2026-05-24 had pure-tool_use
  // assistant turns (no text, no thinking). The placeholder must
  // cover this case too, not just text-bearing turns.
  const input: LeaderMessage[] = [
    { type: "user", content: "do it" },
    {
      type: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
      ],
    },
    { type: "tool_result", toolUseId: "t1", content: "out" },
  ];
  const result = anthropicPlugin.convertMessages(input, "sys");
  const assistant = (result.messages as Array<{ role: string; content: any }>)[1]!;
  const blocks = assistant.content as Array<{ type: string }>;
  expect(blocks[0]?.type).toBe("thinking");
  expect(blocks[1]?.type).toBe("tool_use");
});

test("convertMessages adds cache_control to last user-block of prior turn (P1.6)", () => {
  // Rolling-cache test: after turn N completes, the leader builds
  // turn N+1 with the just-arrived user message at the tail. The
  // marker should land on the FINAL block of the LAST user message
  // BEFORE that tail — caching the entire history up to (but not
  // including) the new user turn.
  const input: LeaderMessage[] = [
    { type: "user", content: "first" },
    { type: "assistant", content: [{ type: "text", text: "ack" }] },
    {
      type: "user",
      content: [
        { type: "text", text: "follow-up A" },
        { type: "text", text: "follow-up B" },
      ],
    },
    { type: "assistant", content: [{ type: "text", text: "done" }] },
    // This is the new user turn (the "tail"); marker goes on the
    // PREVIOUS user message (follow-up A/B), specifically on the
    // last block "follow-up B".
    { type: "user", content: "what next?" },
  ];

  const result = anthropicPlugin.convertMessages(input, "sys");
  const msgs = result.messages as Array<{ role: string; content: any }>;
  // The middle user message gets cache_control on its last block.
  const middleUser = msgs[2]!;
  expect(middleUser.role).toBe("user");
  const blocks = middleUser.content as Array<Record<string, unknown>>;
  expect(blocks.length).toBe(2);
  expect(blocks[0]).toEqual({ type: "text", text: "follow-up A" });
  expect(blocks[1]).toEqual({
    type: "text",
    text: "follow-up B",
    cache_control: { type: "ephemeral" },
  });
  // The tail (final) user message should NOT carry a marker.
  const tailUser = msgs[4]!;
  expect(tailUser.content).toBe("what next?");
});

test("rolling cache marker lands on tool_result message when that's the prior user turn (kimi P1.6 info)", () => {
  // tool_result becomes role:"user" after conversion. When the
  // model-driven tool flow ends with a tool_result and the user
  // then types a follow-up, the tool_result is the "prior user
  // turn" — the marker should land on its final block.
  const input: LeaderMessage[] = [
    { type: "user", content: "list files" },
    {
      type: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "list_dir", input: { path: "." } }],
    },
    { type: "tool_result", toolUseId: "t1", content: "file-a\nfile-b" },
    // New user follow-up after the tool flow completes.
    { type: "user", content: "summarize" },
  ];
  const result = anthropicPlugin.convertMessages(input, "sys");
  const msgs = result.messages as Array<{ role: string; content: any }>;
  // msgs[2] is the converted tool_result (role:"user"). Its single
  // block should now carry cache_control.
  const toolResultMsg = msgs[2]!;
  expect(toolResultMsg.role).toBe("user");
  const blocks = toolResultMsg.content as Array<Record<string, unknown>>;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "t1",
    content: "file-a\nfile-b",
    cache_control: { type: "ephemeral" },
  });
  // Tail user message should not carry the marker.
  expect(msgs[3]!.content).toBe("summarize");
});

test("convertTools adds cache_control to the last tool definition", () => {
  const fakeTools = [
    { name: "alpha", description: "a", inputJsonSchemaOverride: { type: "object" } },
    { name: "beta", description: "b", inputJsonSchemaOverride: { type: "object" } },
    { name: "gamma", description: "g", inputJsonSchemaOverride: { type: "object" } },
  ];
  const converted = anthropicPlugin.convertTools(fakeTools as any) as Array<Record<string, unknown>>;
  expect(converted.length).toBe(3);
  expect(converted[0]?.cache_control).toBeUndefined();
  expect(converted[1]?.cache_control).toBeUndefined();
  expect(converted[2]?.cache_control).toEqual({ type: "ephemeral" });
});

test("buildRequestBody emits system as cache-marked block array", () => {
  const body = anthropicPlugin.buildRequestBody({
    messages: [],
    systemPrompt: "you are an agent",
    model: "claude-sonnet-4-5",
    provider: { id: "anthropic", baseUrl: "https://api.anthropic.com", apiDialect: "anthropic_messages" } as any,
    modelProfile: { modelName: "claude-sonnet-4-5" } as any,
  });
  expect(Array.isArray(body.system)).toBe(true);
  const sys = body.system as Array<{ type: string; text: string; cache_control: any }>;
  expect(sys[0]).toEqual({
    type: "text",
    text: "you are an agent",
    cache_control: { type: "ephemeral" },
  });
});

test("sanitizeReplayHistory merges consecutive same-role messages", () => {
  // Note: the orphan-pairing pass now runs first and drops tool_results
  // whose declaring tool_use isn't present in the stream. Updated input
  // to add the declaring tool_use so this test focuses on its actual
  // intent (consecutive same-role merging).
  const input: LeaderMessage[] = [
    { type: "user", content: "first" },
    {
      type: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    { type: "tool_result", toolUseId: "t1", content: "result-1" },
    { type: "assistant", content: [{ type: "text", text: "a1" }] },
    { type: "assistant", content: [{ type: "text", text: "a2" }] },
  ];

  // sanitizeReplayHistory does NOT convert tool_result into a user-role
  // content block — that conversion happens later in convertMessages.
  // tool_result stays as its own LeaderToolResultMessage here.
  expect(anthropicPlugin.sanitizeReplayHistory?.(input)).toEqual([
    { type: "user", content: "first" },
    {
      type: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    { type: "tool_result", toolUseId: "t1", content: "result-1" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "a1" },
        { type: "text", text: "a2" },
      ],
    },
  ]);
});

test("sanitizeReplayHistory drops orphan tool_use before merging", () => {
  // Regression for the Rank 8 fix: the orphan-pairing pass must run
  // BEFORE role-merging, otherwise an orphan tool_use survives into
  // the merged assistant message and the API call rejects with
  // `tool_use ids found without tool_result`.
  const input: LeaderMessage[] = [
    { type: "user", content: "first" },
    {
      type: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "tu_orphan", name: "bash", input: {} },
      ],
    },
    // No tool_result for tu_orphan — agent crashed mid-tool-execution.
    { type: "user", content: "are you there" },
  ];

  expect(anthropicPlugin.sanitizeReplayHistory?.(input)).toEqual([
    { type: "user", content: "first" },
    {
      type: "assistant",
      content: [{ type: "text", text: "let me check" }],
    },
    { type: "user", content: "are you there" },
  ]);
});

test("resolveRequestPath normalizes base URLs with or without /v1", () => {
  expect([
    anthropicPlugin.resolveRequestPath("https://api.example.com/v1", "claude"),
    anthropicPlugin.resolveRequestPath("https://api.example.com", "claude"),
  ]).toEqual(["/messages", "/v1/messages"]);
});

// Image content block translation — Anthropic's wire format wraps
// base64 image bytes as `{type:"image", source:{type:"base64",
// media_type, data}}`. The vendor-neutral LeaderContentBlock form
// `{type:"image", mediaType, data}` must land in that shape.
test("convertMessages translates internal image block to Anthropic image source form", () => {
  const input: LeaderMessage[] = [
    {
      type: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAA" },
      ],
    },
  ];

  const result = anthropicPlugin.convertMessages(input, "sys");
  const userMsg = (result.messages as Array<Record<string, unknown>>).find((m) => m.role === "user");
  expect(userMsg).toBeDefined();
  const blocks = userMsg!.content as Array<Record<string, unknown>>;
  expect(blocks.length).toBe(2);
  expect(blocks[0]).toEqual({ type: "text", text: "what is in this image?" });
  expect(blocks[1]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAA" },
  });
});

test("convertMessages handles tool_result + image side-by-side in user turn", () => {
  // Coexistence check: a user turn can carry tool_result blocks
  // (the tool path) alongside a fresh image attachment. Both
  // must survive into the converted Anthropic content array.
  const input: LeaderMessage[] = [
    {
      type: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
        { type: "image", mediaType: "image/jpeg", data: "AAAA" },
      ],
    },
  ];
  const result = anthropicPlugin.convertMessages(input, "sys");
  const userMsg = (result.messages as Array<Record<string, unknown>>).find((m) => m.role === "user");
  const blocks = userMsg!.content as Array<Record<string, unknown>>;
  expect(blocks.find((b) => b.type === "tool_result")).toMatchObject({
    type: "tool_result",
    tool_use_id: "call_1",
    content: "ok",
  });
  expect(blocks.find((b) => b.type === "image")).toMatchObject({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
  });
});

// ─────────────────────────────────────────────────────────────────
// Spec §2 — tool_result content-block array support (image + text)
// ─────────────────────────────────────────────────────────────────

test("convertMessages: tool_result with LeaderResultBlock[] passes text + image through to Anthropic blocks", () => {
  const msgs: LeaderMessage[] = [
    { type: "user", content: "show me a chart" },
    {
      type: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "chart_tool", input: {} }],
    },
    {
      type: "tool_result",
      toolUseId: "call_1",
      content: [
        { type: "text", text: "Here's the chart:" },
        { type: "image", mediaType: "image/png", data: "iVBORw0K" },
      ],
    },
    { type: "user", content: "explain" },
  ];
  const { messages } = anthropicPlugin.convertMessages(msgs, "sys");
  // Find the user message that carries the tool_result block (Anthropic
  // models tool_results as a `role: "user"` envelope).
  const toolResultMessage = (messages as Array<{ role: string; content: unknown }>)
    .find((m) =>
      m.role === "user"
      && Array.isArray(m.content)
      && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    );
  expect(toolResultMessage).toBeDefined();
  const toolResultBlock = (toolResultMessage!.content as Array<{ type: string; content: unknown }>)
    .find((b) => b.type === "tool_result")!;
  expect(Array.isArray(toolResultBlock.content)).toBe(true);
  const wireBlocks = toolResultBlock.content as Array<Record<string, unknown>>;
  expect(wireBlocks).toHaveLength(2);
  expect(wireBlocks[0]).toMatchObject({ type: "text", text: "Here's the chart:" });
  expect(wireBlocks[1]).toMatchObject({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
  });
});

test("convertMessages: tool_result with string content stays string (no behavior change)", () => {
  const msgs: LeaderMessage[] = [
    { type: "user", content: "hi" },
    {
      type: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "ls", input: {} }],
    },
    { type: "tool_result", toolUseId: "call_1", content: "file_a\nfile_b" },
  ];
  const { messages } = anthropicPlugin.convertMessages(msgs, "sys");
  const toolResultMessage = (messages as Array<{ role: string; content: unknown }>)
    .find((m) =>
      m.role === "user"
      && Array.isArray(m.content)
      && (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    );
  const toolResultBlock = (toolResultMessage!.content as Array<{ type: string; content: unknown }>)
    .find((b) => b.type === "tool_result")!;
  expect(typeof toolResultBlock.content).toBe("string");
  expect(toolResultBlock.content).toBe("file_a\nfile_b");
});

test("convertMessages preserves assistant thinking blocks for multi-turn replay (2026-05-24)", () => {
  // DeepSeek's anthropic-compat endpoint (and Anthropic Claude in
  // extended thinking) rejects history that strips prior assistant
  // thinking blocks with:
  //   "The content[].thinking in the thinking mode must be passed
  //    back to the API"
  // This test pins the convert path to include thinking blocks in
  // assistant content rather than filtering them out.
  const input: LeaderMessage[] = [
    { type: "user", content: "hi" },
    {
      type: "assistant",
      content: [
        { type: "thinking", thinking: "user said hi, I should greet back" },
        { type: "text", text: "hello!" },
      ],
    },
    { type: "user", content: "thanks" },
  ];
  const { messages } = anthropicPlugin.convertMessages(input, "sys");
  const assistant = (messages as Array<{ role: string; content: unknown }>).find(
    (m) => m.role === "assistant",
  )!;
  const assistantBlocks = assistant.content as Array<{ type: string; thinking?: string; text?: string }>;
  const thinkingBlock = assistantBlocks.find((b) => b.type === "thinking");
  expect(thinkingBlock).toBeDefined();
  expect(thinkingBlock!.thinking).toBe("user said hi, I should greet back");
  // text block still present.
  expect(assistantBlocks.find((b) => b.type === "text")?.text).toBe("hello!");
});
