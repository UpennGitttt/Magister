import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  computeTokenBudget,
  estimateTokenCount,
  getAutocompactThreshold,
  isOverBudget,
} from "../../../../src/services/manager-automation/autonomous-loop/token-budget";
import type { LeaderMessage } from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

describe("estimateTokenCount", () => {
  test("ASCII text uses ~4 chars/token ratio", () => {
    const msgs: LeaderMessage[] = [
      { type: "user", content: "abcdefghijklmnopqrstuvwxyzabcdef" }, // 32 chars
    ];
    expect(estimateTokenCount(msgs)).toBe(8);
  });

  test("CJK / non-ASCII counts each codepoint as ~1 token", () => {
    // 32 Chinese chars — should be ~32 tokens, not 8.
    const msgs: LeaderMessage[] = [
      { type: "user", content: "重构认证模块的目标是替换旧的会话机制以满足合规要求支持长" }, // 26 chars
    ];
    const est = estimateTokenCount(msgs);
    // Allow ±2 — the heuristic is approximate but must be in the
    // CJK ballpark, NOT the ASCII undercount of ~7.
    expect(est).toBeGreaterThanOrEqual(24);
    expect(est).toBeLessThanOrEqual(28);
  });

  test("mixed ASCII + CJK adds correctly", () => {
    const msgs: LeaderMessage[] = [
      { type: "user", content: "hello 你好 world 世界" },
      // ASCII: "hello  world  " = 14 chars → 4 tokens (rounded up)
      // Fat: "你好" + "世界" = 4 codepoints → 4 tokens
      // Total ≈ 8
    ];
    const est = estimateTokenCount(msgs);
    expect(est).toBeGreaterThanOrEqual(7);
    expect(est).toBeLessThanOrEqual(9);
  });

  test("empty message list returns 0", () => {
    expect(estimateTokenCount([])).toBe(0);
  });

  test("image block uses fixed cost, not base64 char length", () => {
    // A realistic 1 MB PNG base64-encodes to ~1.3M chars. The flat
    // JSON.stringify(content) path would charge ~325k estimated
    // tokens, instantly tripping compaction on any turn with an
    // attached image. The block walker assigns ~1600 tokens (real
    // vision-model rate) instead.
    const fakeBigBase64 = "A".repeat(1_300_000); // simulate 1 MB image
    const msgs: LeaderMessage[] = [
      {
        type: "user",
        content: [
          { type: "text", text: "look at this image" },
          { type: "image", mediaType: "image/png", data: fakeBigBase64 },
        ],
      },
    ];
    const est = estimateTokenCount(msgs);
    // ~5 tokens for "look at this image" + ~1600 for the image.
    // Generous bounds — must NOT be in the 100k+ range that flat
    // base64 stringify would have produced.
    expect(est).toBeLessThan(3000);
    expect(est).toBeGreaterThan(1500);
  });

  test("multiple image blocks sum independently", () => {
    const msgs: LeaderMessage[] = [
      {
        type: "user",
        content: [
          { type: "image", mediaType: "image/png", data: "a" },
          { type: "image", mediaType: "image/png", data: "b" },
          { type: "image", mediaType: "image/png", data: "c" },
        ],
      },
    ];
    const est = estimateTokenCount(msgs);
    // 3 × 1600 = 4800
    expect(est).toBeGreaterThanOrEqual(4500);
    expect(est).toBeLessThanOrEqual(5100);
  });

  test("regression: 21 turns of CJK conversation no longer estimates as 0.25× actual", () => {
    // Synthesize the kind of context a long Chinese chat builds up.
    // 100 chars/turn × 21 turns × user+assistant = 4200 fat chars.
    // Old estimator: 4200 / 4 = 1050 tokens (way under 111k cap).
    // New estimator: ~4200 tokens. Still under 111k for this size,
    // but the RATIO is now correct so a real conversation passing
    // 30k chars trips the threshold instead of silently overflowing.
    const turn = "在这次对话中我们需要详细讨论关于 Plan Mode 的实现细节并且这段文字相当长以测试估算器的准确性测试一下";
    const msgs: LeaderMessage[] = [];
    for (let i = 0; i < 21; i++) {
      msgs.push({ type: "user", content: turn });
      msgs.push({ type: "assistant", content: [{ type: "text", text: turn }] });
    }
    const est = estimateTokenCount(msgs);
    // Old `chars / 4` estimator would have given ~1050 tokens for
    // this transcript. The new estimator counts CJK at ~1
    // token/codepoint, putting it ~2x higher — enough that real
    // conversations near the 111k available-input ceiling actually
    // trip compaction.
    expect(est).toBeGreaterThan(1900);
  });
});

describe("isOverBudget", () => {
  test("respects availableForInput threshold", () => {
    const budget = computeTokenBudget(128_000, undefined);
    // 128k - 15% reserve = ~108_800 available
    expect(isOverBudget(50_000, budget)).toBe(false);
    expect(isOverBudget(120_000, budget)).toBe(true);
  });
});

describe("computeTokenBudget", () => {
  test("default context window applies when undefined", () => {
    const b = computeTokenBudget(undefined, undefined);
    expect(b.totalBudget).toBe(128_000);
    // 15% of 128k > default max output 4096
    expect(b.reserveForOutput).toBe(Math.floor(128_000 * 0.15));
    expect(b.availableForInput).toBe(128_000 - b.reserveForOutput);
  });

  test("explicit max output > 15% reserve wins", () => {
    const b = computeTokenBudget(50_000, 16_000);
    // 15% of 50k = 7500, but explicit 16k is bigger → reserve = 16k
    expect(b.reserveForOutput).toBe(16_000);
    expect(b.availableForInput).toBe(50_000 - 16_000);
  });
});

describe("getAutocompactThreshold (proactive compaction trigger)", () => {
  // Previously this function was dead code — defined but never called
  // by the loop. Wired up so compaction can fire BEFORE the hard
  // `availableForInput` ceiling, reducing cumulative token cost on
  // long sessions where each turn re-sends the full history.

  const ORIG_THRESHOLD = process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD;
  const ORIG_RATIO = process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO;

  beforeEach(() => {
    delete process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD;
    delete process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO;
  });

  afterEach(() => {
    if (ORIG_THRESHOLD === undefined) {
      delete process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD;
    } else {
      process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD = ORIG_THRESHOLD;
    }
    if (ORIG_RATIO === undefined) {
      delete process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO;
    } else {
      process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = ORIG_RATIO;
    }
  });

  test("default is 70% of availableForInput (raised 2026-05-27)", () => {
    // Leader at 261k context window: budget.availableForInput ≈ 222k,
    // so default proactive threshold ≈ 155k.
    const budget = computeTokenBudget(261_072, 16_384);
    const t = getAutocompactThreshold(budget);
    expect(t).toBe(Math.floor(budget.availableForInput * 0.7));
  });

  test("scales with the configured context window", () => {
    // 1M context: proactive trigger ~595k, leaving headroom before
    // the hard cap.
    const big = computeTokenBudget(1_000_000, 16_384);
    expect(getAutocompactThreshold(big)).toBe(
      Math.floor(big.availableForInput * 0.7),
    );

    // Small context (legacy 128k claude-style).
    const small = computeTokenBudget(128_000, 4096);
    expect(getAutocompactThreshold(small)).toBe(
      Math.floor(small.availableForInput * 0.7),
    );

    // Bigger budget always = bigger threshold.
    expect(getAutocompactThreshold(big)).toBeGreaterThan(
      getAutocompactThreshold(small),
    );
  });

  test("MAGISTER_LEADER_AUTOCOMPACT_RATIO overrides the default fraction", () => {
    process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = "0.5";
    const budget = computeTokenBudget(200_000, 16_384);
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.5),
    );
  });

  test("invalid ratio (not in (0, 1)) falls back to default", () => {
    process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = "1.5";
    const budget = computeTokenBudget(100_000, 16_384);
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );

    process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = "-0.2";
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );

    process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = "not-a-number";
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );
  });

  test("MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD (absolute) wins over ratio + default", () => {
    process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD = "50000";
    process.env.MAGISTER_LEADER_AUTOCOMPACT_RATIO = "0.9";
    const budget = computeTokenBudget(1_000_000, 16_384);
    // Absolute wins → 50k regardless of budget size.
    expect(getAutocompactThreshold(budget)).toBe(50_000);
  });

  test("invalid absolute threshold (≤ 0 or NaN) falls through to ratio", () => {
    process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD = "0";
    const budget = computeTokenBudget(200_000, 16_384);
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );

    process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD = "-100";
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );

    process.env.MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD = "garbage";
    expect(getAutocompactThreshold(budget)).toBe(
      Math.floor(budget.availableForInput * 0.7),
    );
  });

  test("threshold is below the hard cap so proactive fires first", () => {
    // Sanity check the contract: threshold < availableForInput,
    // otherwise the proactive trigger is never reached before
    // isOverBudget already kicks in.
    const budget = computeTokenBudget(261_072, 16_384);
    expect(getAutocompactThreshold(budget)).toBeLessThan(budget.availableForInput);
  });
});
