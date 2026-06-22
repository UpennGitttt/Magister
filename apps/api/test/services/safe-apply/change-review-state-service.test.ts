import { describe, test, expect, mock } from "bun:test";
import { waitForReviewDecision } from "../../../src/services/safe-apply/change-review-state-service";

describe("waitForReviewDecision", () => {
  test("returns immediately when review is already approved", async () => {
    const mockRepo = {
      getById: mock(() => Promise.resolve({ decisionState: "approved", decisionReason: null })),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 5000,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("approved");
  });

  test("returns rejected with reason", async () => {
    const mockRepo = {
      getById: mock(() =>
        Promise.resolve({ decisionState: "rejected", decisionReason: "bad code" }),
      ),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 5000,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("bad code");
  });

  test("returns revision_requested with reason", async () => {
    const mockRepo = {
      getById: mock(() =>
        Promise.resolve({ decisionState: "revision_requested", decisionReason: "needs cleanup" }),
      ),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 5000,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("revision_requested");
    expect(result.reason).toBe("needs cleanup");
  });

  test("returns timeout when deadline expires", async () => {
    const mockRepo = {
      getById: mock(() => Promise.resolve({ decisionState: "pending", decisionReason: null })),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 50,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("timeout");
  });

  test("returns aborted when review not found", async () => {
    const mockRepo = {
      getById: mock(() => Promise.resolve(null)),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 5000,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("aborted");
  });

  test("returns aborted when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const mockRepo = {
      getById: mock(() => Promise.resolve({ decisionState: "pending", decisionReason: null })),
    };
    const result = await waitForReviewDecision("review_1", {
      timeoutMs: 60000,
      signal: controller.signal,
      repo: mockRepo as any,
    });
    expect(result.decision).toBe("aborted");
  });
});
