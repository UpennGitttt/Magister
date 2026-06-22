import { describe, expect, test } from "bun:test";

import {
  isVerdictFresh,
  parseEvaluatorVerdict,
  VERDICT_FRESHNESS_MS,
} from "../../../src/services/goal-mode/evaluator-verifier-service";

describe("parseEvaluatorVerdict", () => {
  test("classifies plain READY on the long-form line", () => {
    const text = "criterion: foo\nVerdict: PASS\n...\nOverall verdict: READY";
    expect(parseEvaluatorVerdict(text)).toEqual({
      verdict: "READY",
      blockerReason: null,
    });
  });

  test("classifies short-form 'VERDICT: READY'", () => {
    expect(parseEvaluatorVerdict("VERDICT: READY")).toEqual({
      verdict: "READY",
      blockerReason: null,
    });
  });

  test("BLOCKED extracts em-dash separator reason", () => {
    const text =
      "Criterion 1: foo\nVerdict: PASS\n...\nOverall verdict: BLOCKED — tests in foo.test.ts fail under linux";
    const v = parseEvaluatorVerdict(text);
    expect(v.verdict).toBe("BLOCKED");
    if (v.verdict === "BLOCKED") {
      expect(v.blockerReason).toContain("tests in foo.test.ts fail");
    }
  });

  test("BLOCKED with hyphen separator also parses", () => {
    expect(parseEvaluatorVerdict("VERDICT: BLOCKED - missing impl of bar()")).toMatchObject({
      verdict: "BLOCKED",
      blockerReason: "missing impl of bar()",
    });
  });

  test("BLOCKED with no reason falls back to placeholder", () => {
    const v = parseEvaluatorVerdict("Overall verdict: BLOCKED");
    expect(v.verdict).toBe("BLOCKED");
    if (v.verdict === "BLOCKED") {
      expect(v.blockerReason).toMatch(/no reason/i);
    }
  });

  test("BLOCKED takes precedence over earlier READY mention", () => {
    // Pathological case where the evaluator discusses individual
    // PASS criteria with the word READY but the final verdict is BLOCKED.
    const text = [
      "Criterion 1: build passes",
      "Verdict: PASS",
      "Evidence: build is READY for shipping",
      "Criterion 2: tests pass",
      "Verdict: FAIL",
      "",
      "Overall verdict: BLOCKED — criterion 2 fails",
    ].join("\n");
    expect(parseEvaluatorVerdict(text).verdict).toBe("BLOCKED");
  });

  test("empty + no-match returns UNCLEAR", () => {
    expect(parseEvaluatorVerdict("").verdict).toBe("UNCLEAR");
    expect(parseEvaluatorVerdict("just some random text").verdict).toBe("UNCLEAR");
  });
});

describe("isVerdictFresh", () => {
  test("verdict within freshness window is fresh", () => {
    const now = Date.now();
    expect(isVerdictFresh(now - 60_000, now)).toBe(true);
  });

  test("verdict at exact boundary is fresh", () => {
    const now = Date.now();
    expect(isVerdictFresh(now - VERDICT_FRESHNESS_MS, now)).toBe(true);
  });

  test("verdict past boundary is stale", () => {
    const now = Date.now();
    expect(isVerdictFresh(now - VERDICT_FRESHNESS_MS - 1, now)).toBe(false);
  });

  test("null/undefined is stale", () => {
    expect(isVerdictFresh(null)).toBe(false);
    expect(isVerdictFresh(undefined)).toBe(false);
  });
});
