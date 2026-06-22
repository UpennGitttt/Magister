import { describe, expect, test } from "bun:test";

import {
  derivePlanStateFromMessages,
  detectPlanResponse,
  findOpenPlanRequestId,
  isInPlanMode,
  PLAN_TOKEN_APPROVED,
  PLAN_TOKEN_CANCELLED,
  PLAN_TOKEN_REVISED_PREFIX,
  stripSentinelFromMessages,
  syntheticSubstituteFor,
  systemPromptAddendumFor,
  transitionPlanState,
} from "../../../../src/services/manager-automation/autonomous-loop/plan-mode-state";
import type { LeaderMessage } from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

// ──────────────────────────────────────────────────────────────────────
// detectPlanResponse
// ──────────────────────────────────────────────────────────────────────

describe("detectPlanResponse", () => {
  test("__PLAN_APPROVED__ → kind: approved", () => {
    expect(detectPlanResponse(PLAN_TOKEN_APPROVED)).toEqual({ kind: "approved" });
  });

  test("__PLAN_CANCELLED__ → kind: cancelled", () => {
    expect(detectPlanResponse(PLAN_TOKEN_CANCELLED)).toEqual({ kind: "cancelled" });
  });

  test("__PLAN_REVISED__:foo → kind: revised with feedback", () => {
    expect(detectPlanResponse(`${PLAN_TOKEN_REVISED_PREFIX}make it shorter`))
      .toEqual({ kind: "revised", feedback: "make it shorter" });
  });

  test("trimmed: leading/trailing whitespace ignored", () => {
    expect(detectPlanResponse(`   ${PLAN_TOKEN_APPROVED}   `)).toEqual({ kind: "approved" });
  });

  test("case-sensitive — lowercase doesn't trigger", () => {
    expect(detectPlanResponse("__plan_approved__")).toBeNull();
  });

  test("prose containing the sentinel as substring doesn't trigger (exact-trim match)", () => {
    expect(detectPlanResponse("here is the plan __PLAN_APPROVED__ and more")).toBeNull();
  });

  test("multi-phrase prose that's not in the whitelist returns null", () => {
    // "looks good" and "go ahead" each match individually but the
    // combined phrase isn't in the set — exact-match keeps NL strict.
    expect(detectPlanResponse("looks good go ahead")).toBeNull();
    expect(detectPlanResponse("")).toBeNull();
  });

  test("empty revised feedback is allowed (just `__PLAN_REVISED__:`)", () => {
    expect(detectPlanResponse(PLAN_TOKEN_REVISED_PREFIX)).toEqual({ kind: "revised", feedback: "" });
  });

  // F9 (audit 2026-05-08) — natural-language approval/cancel fallback.
  // Users typing directly in the chat textbox should get the same
  // behavior as clicking the PlanCard buttons.
  describe("natural-language fallback (F9)", () => {
    test("English approve phrases", () => {
      for (const phrase of ["approve", "approved", "lgtm", "ok", "okay", "yes", "go ahead", "ship it", "looks good", "perfect"]) {
        expect(detectPlanResponse(phrase)).toEqual({ kind: "approved" });
      }
    });

    test("Chinese approve phrases", () => {
      for (const phrase of ["同意", "批准", "好的", "好", "可以", "继续", "行", "通过"]) {
        expect(detectPlanResponse(phrase)).toEqual({ kind: "approved" });
      }
    });

    test("English cancel phrases", () => {
      for (const phrase of ["cancel", "no", "stop", "abort", "never mind"]) {
        expect(detectPlanResponse(phrase)).toEqual({ kind: "cancelled" });
      }
    });

    test("Chinese cancel phrases", () => {
      for (const phrase of ["取消", "不要", "算了", "停"]) {
        expect(detectPlanResponse(phrase)).toEqual({ kind: "cancelled" });
      }
    });

    test("case-insensitive + trailing punctuation tolerated", () => {
      expect(detectPlanResponse("Approve")).toEqual({ kind: "approved" });
      expect(detectPlanResponse("APPROVED")).toEqual({ kind: "approved" });
      expect(detectPlanResponse("approve!")).toEqual({ kind: "approved" });
      expect(detectPlanResponse("approved.")).toEqual({ kind: "approved" });
      expect(detectPlanResponse("好的。")).toEqual({ kind: "approved" });
    });

    test("trailing emoji stripped", () => {
      expect(detectPlanResponse("approve 👍")).toEqual({ kind: "approved" });
      expect(detectPlanResponse("ok ✅")).toEqual({ kind: "approved" });
    });

    test("long messages don't NL-match — pass through to model", () => {
      // Length cap protects against false-positives in revision-style feedback.
      expect(
        detectPlanResponse("approve, but also rename the helper file before committing"),
      ).toBeNull();
      expect(
        detectPlanResponse("ok looks good but please double-check the migration order first"),
      ).toBeNull();
    });

    test("substring-only (e.g. 'okay let me think') doesn't match", () => {
      // "okay" alone is in the set, but "okay let me think" is a longer
      // distinct phrase — exact-match keeps it from triggering.
      expect(detectPlanResponse("okay let me think")).toBeNull();
    });

    test("doesn't shadow REVISED prefix (sentinel takes precedence)", () => {
      expect(detectPlanResponse(`${PLAN_TOKEN_REVISED_PREFIX}make ok`))
        .toEqual({ kind: "revised", feedback: "make ok" });
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// derivePlanStateFromMessages
// ──────────────────────────────────────────────────────────────────────

function user(text: string): LeaderMessage {
  return { type: "user", content: text };
}
function assistantWithToolUse(name: string, id: string): LeaderMessage {
  return {
    type: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}
function toolResult(id: string, content = "ok"): LeaderMessage {
  return { type: "tool_result", toolUseId: id, content };
}

describe("derivePlanStateFromMessages", () => {
  test("empty / no plan tools → IDLE", () => {
    expect(derivePlanStateFromMessages([])).toBe("IDLE");
    expect(derivePlanStateFromMessages([user("hi"), { type: "assistant", content: [{ type: "text", text: "hi" }] }]))
      .toBe("IDLE");
  });

  test("after enter_plan_mode tool_use → PLANNING", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      toolResult("tu_e1"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("PLANNING");
  });

  test("after exit_plan_mode tool_use → AWAITING_APPROVAL", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      toolResult("tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      toolResult("tu_x1"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("AWAITING_APPROVAL");
  });

  test("re-entry while PLANNING is a no-op (still PLANNING)", () => {
    const msgs: LeaderMessage[] = [
      user("a"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      assistantWithToolUse("enter_plan_mode", "tu_e2"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("PLANNING");
  });

  test("re-entry while AWAITING_APPROVAL stays AWAITING_APPROVAL", () => {
    const msgs: LeaderMessage[] = [
      user("a"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      assistantWithToolUse("enter_plan_mode", "tu_e2"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("AWAITING_APPROVAL");
  });

  // Substitute-aware derivation: closes Codex BLOCKER 5 — without this,
  // a session restored after the user already approved would re-derive
  // AWAITING_APPROVAL and halt again.

  test("substitute '[user approved the plan]' resets state to IDLE", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      toolResult("tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      toolResult("tu_x1"),
      user("[user approved the plan]"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("IDLE");
  });

  test("substitute '[user cancelled the plan]' resets state to IDLE", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      user("[user cancelled the plan]"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("IDLE");
  });

  test("substitute '[user requested revision: ...]' moves state back to PLANNING", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      user("[user requested revision: skip step 2]"),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("PLANNING");
  });

  test("substring-only matches are ignored — model quoting an example shouldn't trip the derivation", () => {
    const msgs: LeaderMessage[] = [
      user("refactor X"),
      assistantWithToolUse("enter_plan_mode", "tu_e1"),
      assistantWithToolUse("exit_plan_mode", "tu_x1"),
      // Real prose mentioning the marker — wrapped in surrounding text.
      user("Earlier you said '[user approved the plan]' but I'm changing my mind."),
    ];
    expect(derivePlanStateFromMessages(msgs)).toBe("AWAITING_APPROVAL");
  });
});

// ──────────────────────────────────────────────────────────────────────
// findOpenPlanRequestId — used by the resume path to thread the
// original proposal's requestId into the loop so plan_mode_exited
// lands in the same exchange as the open PlanCard.
// ──────────────────────────────────────────────────────────────────────

describe("findOpenPlanRequestId", () => {
  function ev(type: string, requestId: string) {
    return { type, payloadJson: JSON.stringify({ requestId }) };
  }

  test("no plan events → null", () => {
    expect(findOpenPlanRequestId([])).toBe(null);
    expect(findOpenPlanRequestId([{ type: "leader.text_delta", payloadJson: "{}" }])).toBe(null);
  });

  test("plan_proposed without exit → returns its requestId", () => {
    expect(findOpenPlanRequestId([ev("leader.plan_proposed", "req_A")])).toBe("req_A");
  });

  test("plan_proposed followed by matching exit → null (closed)", () => {
    expect(
      findOpenPlanRequestId([
        ev("leader.plan_proposed", "req_A"),
        ev("leader.plan_mode_exited", "req_A"),
      ]),
    ).toBe(null);
  });

  test("two plan cycles, second still open → returns the second's requestId", () => {
    expect(
      findOpenPlanRequestId([
        ev("leader.plan_proposed", "req_A"),
        ev("leader.plan_mode_exited", "req_A"),
        ev("leader.plan_proposed", "req_B"),
      ]),
    ).toBe("req_B");
  });

  test("exit with mismatched requestId does NOT close the open plan", () => {
    expect(
      findOpenPlanRequestId([
        ev("leader.plan_proposed", "req_A"),
        ev("leader.plan_mode_exited", "req_OTHER"),
      ]),
    ).toBe("req_A");
  });

  test("malformed payloadJson is skipped without throwing", () => {
    expect(
      findOpenPlanRequestId([
        { type: "leader.plan_proposed", payloadJson: "{not-json" },
        ev("leader.plan_proposed", "req_C"),
      ]),
    ).toBe("req_C");
  });
});

// ──────────────────────────────────────────────────────────────────────
// transitionPlanState
// ──────────────────────────────────────────────────────────────────────

describe("transitionPlanState", () => {
  test("IDLE + plan_mode_entered → PLANNING", () => {
    expect(transitionPlanState("IDLE", "leader.plan_mode_entered")).toBe("PLANNING");
  });
  test("PLANNING + plan_proposed → AWAITING_APPROVAL", () => {
    expect(transitionPlanState("PLANNING", "leader.plan_proposed")).toBe("AWAITING_APPROVAL");
  });
  test("AWAITING_APPROVAL + plan_mode_exited (approved) → IDLE", () => {
    expect(transitionPlanState("AWAITING_APPROVAL", "leader.plan_mode_exited", "approved")).toBe("IDLE");
  });
  test("AWAITING_APPROVAL + plan_mode_exited (cancelled) → IDLE", () => {
    expect(transitionPlanState("AWAITING_APPROVAL", "leader.plan_mode_exited", "cancelled")).toBe("IDLE");
  });
  test("AWAITING_APPROVAL + plan_mode_exited (revised) → PLANNING", () => {
    expect(transitionPlanState("AWAITING_APPROVAL", "leader.plan_mode_exited", "revised")).toBe("PLANNING");
  });
  test("re-entry while in PLANNING is a no-op", () => {
    expect(transitionPlanState("PLANNING", "leader.plan_mode_entered")).toBe("PLANNING");
  });
  test("isInPlanMode mapping", () => {
    expect(isInPlanMode("IDLE")).toBe(false);
    expect(isInPlanMode("PLANNING")).toBe(true);
    expect(isInPlanMode("AWAITING_APPROVAL")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// stripSentinelFromMessages
// ──────────────────────────────────────────────────────────────────────

describe("stripSentinelFromMessages", () => {
  test("replaces last user-message text with synthetic substitute", () => {
    const msgs: LeaderMessage[] = [
      user("first"),
      { type: "assistant", content: [{ type: "text", text: "ack" }] },
      user(PLAN_TOKEN_APPROVED),
    ];
    const out = stripSentinelFromMessages(msgs, { kind: "approved" });
    expect(out).toEqual([
      user("first"),
      { type: "assistant", content: [{ type: "text", text: "ack" }] },
      user("[user approved the plan]"),
    ]);
  });

  test("does not mutate input", () => {
    const original: LeaderMessage[] = [user(PLAN_TOKEN_CANCELLED)];
    const out = stripSentinelFromMessages(original, { kind: "cancelled" });
    expect(original[0]).toEqual(user(PLAN_TOKEN_CANCELLED));
    expect(out[0]).toEqual(user("[user cancelled the plan]"));
  });

  test("revise carries feedback into the substitute", () => {
    const msgs: LeaderMessage[] = [user(`${PLAN_TOKEN_REVISED_PREFIX}make it shorter`)];
    const out = stripSentinelFromMessages(msgs, { kind: "revised", feedback: "make it shorter" });
    expect(out[0]).toEqual(user("[user requested revision: make it shorter]"));
  });
});

// ──────────────────────────────────────────────────────────────────────
// syntheticSubstituteFor + systemPromptAddendumFor sanity
// ──────────────────────────────────────────────────────────────────────

describe("substitutes / addenda", () => {
  test("approved produces deterministic substrings", () => {
    expect(syntheticSubstituteFor({ kind: "approved" })).toBe("[user approved the plan]");
    expect(systemPromptAddendumFor({ kind: "approved" })).toContain("Execute it now");
  });
  test("cancelled addendum tells model to stop", () => {
    expect(systemPromptAddendumFor({ kind: "cancelled" })).toContain("Stop");
  });
  test("revised addendum carries feedback verbatim", () => {
    const text = systemPromptAddendumFor({ kind: "revised", feedback: "use option B" });
    expect(text).toContain("use option B");
    expect(text).toContain("call exit_plan_mode again");
  });
});
