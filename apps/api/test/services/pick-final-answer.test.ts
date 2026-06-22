import { describe, expect, test } from "bun:test";

import { pickFinalAnswer } from "../../src/services/process-task-intent-service";

// Regression coverage for the "ghost prompt" bug — task:failed
// surfacing a prior turn's answer because the latest checkpoint
// belonged to a different requestId.
//
// Before the fix (commit 1e22d07 in process-task-intent-service.ts):
//   When a turn's loop failed before writing its own checkpoint,
//   `getLatestCheckpoint(runId)` returned the previous turn's
//   checkpoint, and `extractCurrentRequestAnswer` happily walked
//   it — last-non-meta-user-message in the stale checkpoint was
//   the PRIOR prompt's user message; assistant text after it was
//   the PRIOR answer. That answer got stamped onto the failed
//   turn's task:failed event, which the dashboard then rendered
//   as if the new turn had succeeded.
//
// The fix gates checkpoint reads on
// `checkpoint.requestId === input.requestId`. These tests pin
// that gate.

const STALE_USER_MSG = { type: "user", content: "What's the weather?" };
const STALE_ASSISTANT_MSG = {
  type: "assistant",
  content: [{ type: "text", text: "STALE_PRIOR_ANSWER" }],
};

const FRESH_USER_MSG = { type: "user", content: "What is git?" };
const FRESH_ASSISTANT_MSG = {
  type: "assistant",
  content: [{ type: "text", text: "FRESH_CURRENT_ANSWER" }],
};

// The empty-response fallback used to be a single Chinese sentence
// ("(模型这一轮没有生成回复内容，请重试。)"). It's now an English
// diagnostic message — the test asserts the no-diagnostic shape
// since pickFinalAnswer here is called without `emptyResponse`.
const EMPTY_NO_DIAGNOSTIC_HINT = "no response for this request";
const EMPTY_DIAGNOSTIC_HEADER = "empty response on this turn";

describe("pickFinalAnswer (ghost task:failed guard)", () => {
  test("returns the current request's answer when checkpoint requestId matches", () => {
    const answer = pickFinalAnswer({
      checkpoint: {
        requestId: "req_current",
        messages: [STALE_USER_MSG, STALE_ASSISTANT_MSG, FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
      },
      requestId: "req_current",
      yieldedMessages: [],
    });
    expect(answer).toBe("FRESH_CURRENT_ANSWER");
  });

  test("ignores a stale checkpoint whose requestId does NOT match — the ghost-prompt scenario", () => {
    // The pre-fix behavior would happily walk this checkpoint
    // and return STALE_PRIOR_ANSWER. With the requestId guard,
    // the checkpoint is rejected and we fall through to yielded
    // messages — which on a turn that failed before writing
    // anything are empty — landing on the empty-retry fallback.
    const answer = pickFinalAnswer({
      checkpoint: {
        requestId: "req_PRIOR_TURN",
        messages: [STALE_USER_MSG, STALE_ASSISTANT_MSG],
      },
      requestId: "req_CURRENT_TURN",
      yieldedMessages: [],
    });
    expect(answer).not.toBe("STALE_PRIOR_ANSWER");
    expect(answer).toContain(EMPTY_NO_DIAGNOSTIC_HINT);
  });

  test("checkpoint with null requestId (legacy data) is also rejected", () => {
    // Pre-feature-flag-rollout checkpoints had no `requestId`
    // field; LeaderSessionStore parses those as `requestId: null`.
    // Treat null as definitely-not-matching so legacy data can't
    // leak stale answers either.
    const answer = pickFinalAnswer({
      checkpoint: {
        requestId: null,
        messages: [STALE_USER_MSG, STALE_ASSISTANT_MSG],
      },
      requestId: "req_anything",
      yieldedMessages: [],
    });
    expect(answer).toContain(EMPTY_NO_DIAGNOSTIC_HINT);
  });

  test("falls through to yielded messages when checkpoint is missing", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
    });
    expect(answer).toBe("FRESH_CURRENT_ANSWER");
  });

  test("yielded-messages fallback is also scoped to the current request — no stale leak there either", () => {
    // Pre-fix the yielded-messages fallback was a last-text-wins
    // walk over the entire array, so prior-turn assistant text
    // lingering in result.messages could still leak through even
    // when the checkpoint guard rejected the stale checkpoint.
    // The current implementation routes the yielded path through
    // `extractCurrentRequestAnswer` too, scoping to messages
    // AFTER the last non-meta user message.
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_current",
      yieldedMessages: [
        STALE_USER_MSG,
        STALE_ASSISTANT_MSG,
        FRESH_USER_MSG,
        // Current turn produced no text — qwen empty-response quirk.
      ],
    });
    expect(answer).not.toBe("STALE_PRIOR_ANSWER");
    expect(answer).toContain(EMPTY_NO_DIAGNOSTIC_HINT);
  });

  test("answer is empty string OR whitespace also routes to retry message", () => {
    // Trim-only sanity: an empty-but-present text block would
    // bypass `extractCurrentRequestAnswer`'s null check (it
    // requires `text.length > 0`), so the function returns null
    // and we land on retry. Whitespace-only text passes the
    // length check but should still surface retry.
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [
        FRESH_USER_MSG,
        { type: "assistant", content: [{ type: "text", text: "   " }] },
      ],
    });
    expect(answer).toContain(EMPTY_NO_DIAGNOSTIC_HINT);
  });
});

describe("pickFinalAnswer (empty-response diagnostic)", () => {
  test("surfaces oversized-tool-result hypothesis when last tool returned ≥ 50 KB", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      emptyResponse: {
        contextTokensEstimate: 90_000,
        turnCount: 6,
        lastToolName: "grep",
        lastToolResultLength: 142_000,
        lastToolWasError: false,
      },
    });
    expect(answer).toContain(EMPTY_DIAGNOSTIC_HEADER);
    expect(answer).toContain("`grep`");
    expect(answer).toMatch(/large tool results/i);
    expect(answer).toMatch(/turn 6/i);
  });

  test("threshold matches Layer 3b grep cap — 19_999 chars is NOT 'large'", () => {
    // Kimi review M4: threshold lowered to 20_000 to match
    // MAX_RESULT_SIZE_CHARS in grep-repo-tool.ts. A result under
    // the cap should not trigger the poisoning hypothesis.
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      emptyResponse: {
        contextTokensEstimate: 5_000,
        turnCount: 1,
        lastToolName: "grep",
        lastToolResultLength: 19_999,
        lastToolWasError: false,
      },
    });
    // Should land on the generic "send a follow-up" branch, not the
    // large-output hypothesis branch.
    expect(answer).not.toMatch(/large tool results/i);
    expect(answer).toMatch(/send a follow-up/i);
  });

  test("threshold matches Layer 3b grep cap — exactly 20_000 IS 'large'", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      emptyResponse: {
        contextTokensEstimate: 5_000,
        turnCount: 1,
        lastToolName: "grep",
        lastToolResultLength: 20_000,
        lastToolWasError: false,
      },
    });
    expect(answer).toMatch(/large tool results/i);
  });

  test("surfaces tool-error hypothesis when prior tool returned isError", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      emptyResponse: {
        contextTokensEstimate: 5_000,
        turnCount: 2,
        lastToolName: "bash",
        lastToolResultLength: 200,
        lastToolWasError: true,
      },
    });
    expect(answer).toContain("`bash`");
    expect(answer).toMatch(/error/i);
    expect(answer).toMatch(/rephrasing/i);
  });

  test("surfaces no-prior-tool branch when emptyResponse has null tool name", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      emptyResponse: {
        contextTokensEstimate: 1_200,
        turnCount: 1,
        lastToolName: null,
        lastToolResultLength: null,
        lastToolWasError: null,
      },
    });
    expect(answer).toContain(EMPTY_DIAGNOSTIC_HEADER);
    expect(answer).toMatch(/transient model-side issue/i);
  });

  test("when extraction succeeds, emptyResponse is ignored (no false-positive diagnostic)", () => {
    // If the loop yields actual text BUT the runtime also flagged
    // emptyResponse (shouldn't happen in practice, but guard against
    // it), the real text wins — we never overwrite a successful
    // answer with a diagnostic.
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
      emptyResponse: {
        contextTokensEstimate: 5_000,
        turnCount: 1,
        lastToolName: "grep",
        lastToolResultLength: 80_000,
        lastToolWasError: false,
      },
    });
    expect(answer).toBe("FRESH_CURRENT_ANSWER");
  });
});

describe("pickFinalAnswer (P3 — terminal reason banner)", () => {
  test("max_turns reason prepends banner when text exists", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
      terminalReason: "max_turns",
      turnCount: 50,
    });
    expect(answer).toContain("max turn limit");
    expect(answer).toContain("turn 50");
    expect(answer).toContain("FRESH_CURRENT_ANSWER");
    expect(answer.indexOf("max turn limit")).toBeLessThan(answer.indexOf("FRESH_CURRENT_ANSWER"));
  });

  test("aborted_streaming reason replaces blank answer with banner", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG], // no assistant text
      terminalReason: "aborted_streaming",
      turnCount: 3,
    });
    expect(answer).toContain("Stream interrupted");
    expect(answer).toContain("turn 3");
  });

  test("completed reason produces no banner", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
      terminalReason: "completed",
      turnCount: 3,
    });
    expect(answer).toBe("FRESH_CURRENT_ANSWER");
  });

  test("aborted_streaming + emptyResponse diagnostic — banner first, diagnostic appended", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      terminalReason: "aborted_streaming",
      emptyResponse: {
        contextTokensEstimate: 5_000,
        turnCount: 2,
        lastToolName: null,
        lastToolResultLength: null,
        lastToolWasError: null,
      },
    });
    expect(answer).toContain("Stream interrupted");
    expect(answer).toContain("empty response on this turn");
    expect(answer.indexOf("Stream interrupted")).toBeLessThan(answer.indexOf("empty response on this turn"));
  });

  test("unknown reason produces generic fallback banner", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG, FRESH_ASSISTANT_MSG],
      terminalReason: "some_future_reason",
    });
    expect(answer).toContain("Run ended unexpectedly");
    expect(answer).toContain("some_future_reason");
    expect(answer).toContain("FRESH_CURRENT_ANSWER");
  });

  test("model_error reason surfaces as banner", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      terminalReason: "model_error",
    });
    expect(answer).toContain("Model API error");
  });

  test("plan_awaiting_approval reason shows plan-specific banner (Bug-B 2026-05-08)", () => {
    // Was falling through to the generic "Run ended unexpectedly"
    // / "no response" message which misled users into thinking
    // something broke. The plan IS submitted; the user just needs
    // to act on it.
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      terminalReason: "plan_awaiting_approval",
    });
    expect(answer).toContain("Plan submitted");
    expect(answer).toContain("Approve");
    expect(answer).not.toContain("Run ended unexpectedly");
    expect(answer).not.toContain("no response");
  });

  test("plan_cancelled reason shows plan-specific banner", () => {
    const answer = pickFinalAnswer({
      checkpoint: null,
      requestId: "req_x",
      yieldedMessages: [FRESH_USER_MSG],
      terminalReason: "plan_cancelled",
    });
    expect(answer).toContain("Plan cancelled");
    expect(answer).not.toContain("Run ended unexpectedly");
  });
});
