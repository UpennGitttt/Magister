import { describe, expect, test } from "bun:test";

import { pairLeaderToolMessages } from "../../../../src/services/manager-automation/autonomous-loop/message-pairing";
import type { LeaderMessage } from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

// Compact builders so each test stays legible.
function user(content: string): LeaderMessage {
  return { type: "user", content };
}
function assistantText(text: string): LeaderMessage {
  return { type: "assistant", content: [{ type: "text", text }] };
}
function assistantToolUses(...uses: Array<{ id: string; name?: string }>): LeaderMessage {
  return {
    type: "assistant",
    content: uses.map((u) => ({
      type: "tool_use" as const,
      id: u.id,
      name: u.name ?? "list_dir",
      input: {},
    })),
  };
}
function assistantTextThenToolUse(text: string, toolId: string): LeaderMessage {
  return {
    type: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id: toolId, name: "list_dir", input: {} },
    ],
  };
}
function toolResult(toolUseId: string, content = "ok"): LeaderMessage {
  return { type: "tool_result", toolUseId, content };
}

describe("pairLeaderToolMessages", () => {
  test("pure text conversation passes through unchanged", () => {
    const msgs = [user("hi"), assistantText("hello")];
    expect(pairLeaderToolMessages(msgs)).toEqual(msgs);
  });

  test("fully paired tool_use + tool_result is a no-op", () => {
    const msgs: LeaderMessage[] = [
      user("list /tmp"),
      assistantToolUses({ id: "tu_1" }),
      toolResult("tu_1", "file1, file2"),
      assistantText("found 2 files"),
    ];
    expect(pairLeaderToolMessages(msgs)).toEqual(msgs);
  });

  test("orphan tool_use (no tool_result) is dropped from assistant content", () => {
    const msgs: LeaderMessage[] = [
      user("list /tmp"),
      assistantToolUses({ id: "tu_orphan" }),
      // tool_result never came (tool execution crashed)
      user("nevermind"),
      assistantText("ok"),
    ];
    const out = pairLeaderToolMessages(msgs);
    // The assistant message had only the orphan tool_use, so it's
    // dropped entirely (no text + no answered tool_use).
    expect(out).toEqual([
      user("list /tmp"),
      user("nevermind"),
      assistantText("ok"),
    ]);
  });

  test("orphan tool_use mixed with text: assistant kept, tool_use stripped", () => {
    const msgs: LeaderMessage[] = [
      user("list /tmp"),
      assistantTextThenToolUse("Let me check.", "tu_orphan"),
      // tool_result never came
      user("nevermind"),
    ];
    const out = pairLeaderToolMessages(msgs);
    expect(out).toEqual([
      user("list /tmp"),
      // text preserved, tool_use stripped
      { type: "assistant", content: [{ type: "text", text: "Let me check." }] },
      user("nevermind"),
    ]);
  });

  test("orphan tool_result (no declaring tool_use) is dropped", () => {
    const msgs: LeaderMessage[] = [
      user("hi"),
      assistantText("hello"),
      // Stray tool_result with no matching tool_use — could happen
      // after a partial replay or a corrupt checkpoint.
      toolResult("tu_ghost", "ghost result"),
      user("are you there"),
    ];
    const out = pairLeaderToolMessages(msgs);
    expect(out).toEqual([
      user("hi"),
      assistantText("hello"),
      user("are you there"),
    ]);
  });

  test("multi tool_use with partial answers: only answered ones survive", () => {
    const msgs: LeaderMessage[] = [
      user("do A and B"),
      assistantToolUses({ id: "tu_a" }, { id: "tu_b" }),
      toolResult("tu_a", "did A"),
      // tu_b never produced a tool_result (tool crashed)
      user("ok"),
    ];
    const out = pairLeaderToolMessages(msgs);
    expect(out).toEqual([
      user("do A and B"),
      // tu_b stripped, tu_a kept
      {
        type: "assistant",
        content: [{ type: "tool_use", id: "tu_a", name: "list_dir", input: {} }],
      },
      toolResult("tu_a", "did A"),
      user("ok"),
    ]);
  });

  test("idempotent: running twice produces the same result", () => {
    const msgs: LeaderMessage[] = [
      user("list /tmp"),
      assistantTextThenToolUse("Let me check.", "tu_orphan"),
      user("nevermind"),
    ];
    const once = pairLeaderToolMessages(msgs);
    const twice = pairLeaderToolMessages(once);
    expect(twice).toEqual(once);
  });

  test("preserves order across non-tool messages", () => {
    const msgs: LeaderMessage[] = [
      user("u1"),
      assistantText("a1"),
      user("u2"),
      assistantText("a2"),
      user("u3"),
    ];
    expect(pairLeaderToolMessages(msgs)).toEqual(msgs);
  });

  test("out-of-order tool_result drops BOTH sides of the pair", () => {
    // Anthropic rejects histories where a tool_result appears before
    // the tool_use it answers. Forward-pairing means neither side of
    // an out-of-order pair is valid — dropping just the tool_result
    // would leave the later tool_use unpaired, which would 400 the
    // next API call all the same. This catches corrupt stream replays.
    const msgs: LeaderMessage[] = [
      toolResult("tu_x", "early result"),
      user("hi"),
      assistantToolUses({ id: "tu_x" }),
    ];
    const out = pairLeaderToolMessages(msgs);
    // Both the orphan tool_result AND the later tool_use are dropped;
    // the assistant message had only the (now-dropped) tool_use, so
    // it disappears entirely too.
    expect(out).toEqual([user("hi")]);
  });

  test("recognises tool_result embedded in user.content (resume pipeline shape)", () => {
    // After `enforceAlternatingTurns` in the resume pipeline, consecutive
    // user-role messages get merged into one user message whose `content`
    // array carries embedded `tool_result` blocks. The pair function must
    // recognise this form when checking whether a tool_use was answered,
    // otherwise it would silently drop the (valid) tool_use and the next
    // API call would 400.
    const msgs: LeaderMessage[] = [
      user("list /tmp"),
      assistantToolUses({ id: "tu_resumed" }),
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_resumed", content: "ok" },
          { type: "text", text: "follow-up" },
        ],
      },
    ];
    const out = pairLeaderToolMessages(msgs);
    // tu_resumed is properly answered (embedded), so the assistant
    // tool_use stays, and the user message with the embedded result
    // stays untouched.
    expect(out).toEqual(msgs);
  });

  test("drops embedded tool_result with no declaring tool_use", () => {
    const msgs: LeaderMessage[] = [
      user("hi"),
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_ghost", content: "ghost" },
          { type: "text", text: "real text" },
        ],
      },
    ];
    const out = pairLeaderToolMessages(msgs);
    expect(out).toEqual([
      user("hi"),
      {
        type: "user",
        content: [{ type: "text", text: "real text" }],
      },
    ]);
  });

  test("drops user message entirely when its embedded tool_result was the only block", () => {
    const msgs: LeaderMessage[] = [
      user("hi"),
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_ghost", content: "ghost" },
        ],
      },
      assistantText("ok"),
    ];
    const out = pairLeaderToolMessages(msgs);
    expect(out).toEqual([
      user("hi"),
      assistantText("ok"),
    ]);
  });
});
