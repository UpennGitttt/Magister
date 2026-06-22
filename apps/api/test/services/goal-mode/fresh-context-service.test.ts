import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  GOAL_FRESH_CONTEXT_ANCHOR,
  isFreshContextEnabled,
  trimForFreshContext,
} from "../../../src/services/goal-mode/fresh-context-service";
import type { LeaderMessage } from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";

let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.MAGISTER_GOAL_FRESH_CONTEXT;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MAGISTER_GOAL_FRESH_CONTEXT;
  else process.env.MAGISTER_GOAL_FRESH_CONTEXT = prevEnv;
});

function userMsg(text: string, isMeta = false): LeaderMessage {
  return { type: "user", content: text, ...(isMeta ? { isMeta: true } : {}) };
}
function assistantMsg(text: string): LeaderMessage {
  return {
    type: "assistant",
    content: [{ type: "text", text }],
  } as LeaderMessage;
}

describe("isFreshContextEnabled", () => {
  test("default enabled when env not set", () => {
    delete process.env.MAGISTER_GOAL_FRESH_CONTEXT;
    expect(isFreshContextEnabled()).toBe(true);
  });

  test("'0' / 'false' / 'off' / 'no' disable", () => {
    for (const v of ["0", "false", "FALSE", " off ", "no"]) {
      expect(isFreshContextEnabled(v)).toBe(false);
    }
  });

  test("'1' / 'true' / random keep enabled", () => {
    for (const v of ["1", "true", "yes", "anything"]) {
      expect(isFreshContextEnabled(v)).toBe(true);
    }
  });
});

describe("trimForFreshContext", () => {
  test("returns input unchanged when env disabled", () => {
    const msgs = [
      userMsg("u1"), assistantMsg("a1"),
      userMsg("u2"), assistantMsg("a2"),
      userMsg("u3"), assistantMsg("a3"),
      userMsg("u4"), assistantMsg("a4"),
    ];
    const result = trimForFreshContext(msgs, { envOverride: "0" });
    expect(result.trimmed).toBe(false);
    expect(result.messages).toBe(msgs);
    expect(result.trimmedTurns).toBe(0);
  });

  test("no-op when message count is at-or-below tail budget", () => {
    const msgs = [
      userMsg("u1"), assistantMsg("a1"),
      userMsg("u2"), assistantMsg("a2"),
    ];
    const result = trimForFreshContext(msgs, { tailTurns: 3 });
    expect(result.trimmed).toBe(false);
    expect(result.messages).toBe(msgs);
  });

  test("trims to tail turns + prepends anchor", () => {
    const msgs = [
      userMsg("u1"), assistantMsg("a1"),
      userMsg("u2"), assistantMsg("a2"),
      userMsg("u3"), assistantMsg("a3"),
      userMsg("u4"), assistantMsg("a4"),
      userMsg("u5"), assistantMsg("a5"),
    ];
    const result = trimForFreshContext(msgs, { tailTurns: 2 });
    expect(result.trimmed).toBe(true);
    expect(result.trimmedTurns).toBe(3);
    // anchor + 2 turns × 2 messages = 5
    expect(result.messages.length).toBe(5);
    // anchor at head
    const head = result.messages[0]!;
    expect(head.type).toBe("user");
    if (head.type === "user") {
      expect(head.isMeta).toBe(true);
      expect(typeof head.content === "string" && head.content.startsWith("[Previous conversation summary]")).toBe(true);
    }
    // last user message is u4 (since tail=2, turns 4 and 5)
    const second = result.messages[1]!;
    if (second.type === "user") {
      expect(second.content).toBe("u4");
    }
  });

  test("strips an existing previous-summary anchor (no stacking)", () => {
    const oldAnchor = userMsg(GOAL_FRESH_CONTEXT_ANCHOR, true);
    const msgs = [
      oldAnchor,
      userMsg("u1"), assistantMsg("a1"),
      userMsg("u2"), assistantMsg("a2"),
      userMsg("u3"), assistantMsg("a3"),
      userMsg("u4"), assistantMsg("a4"),
      userMsg("u5"), assistantMsg("a5"),
    ];
    const result = trimForFreshContext(msgs, { tailTurns: 2 });
    expect(result.trimmed).toBe(true);
    // Only one anchor in the output (our new one), and it is the head
    const anchorCount = result.messages.filter(
      (m) =>
        m.type === "user"
        && typeof m.content === "string"
        && m.content.startsWith("[Previous conversation summary]"),
    ).length;
    expect(anchorCount).toBe(1);
  });
});
