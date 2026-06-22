import { describe, expect, test } from "bun:test";

import { calculateTurnTiming } from "../../src/services/turn-timing-service";

function event(
  type: string,
  requestId: string,
  occurredAtMs: number,
  payload: Record<string, unknown> = {},
) {
  return {
    type,
    requestId,
    occurredAt: new Date(occurredAtMs),
    payloadJson: JSON.stringify(payload),
  };
}

describe("turn timing", () => {
  test("subtracts approval wait from user-perceived wall time", () => {
    const startedAtMs = 1_000;
    const completedAtMs = 11_000;

    const timing = calculateTurnTiming({
      requestId: "req_timing",
      startedAtMs,
      completedAtMs,
      events: [
        event("leader.approval_requested", "req_timing", 3_000, {
          approvalId: "approval_1",
        }),
        event("leader.approval_resolved", "req_timing", 7_000, {
          approvalId: "approval_1",
          decision: "approved",
        }),
      ],
    });

    expect(timing.wallMs).toBe(10_000);
    expect(timing.pausedMs).toBe(4_000);
    expect(timing.elapsedMs).toBe(6_000);
  });

  test("treats an unresolved approval as paused until completion", () => {
    const timing = calculateTurnTiming({
      requestId: "req_paused",
      startedAtMs: 10_000,
      completedAtMs: 20_000,
      events: [
        event("leader.approval_requested", "req_paused", 12_500, {
          approvalId: "approval_still_pending",
        }),
      ],
    });

    expect(timing.wallMs).toBe(10_000);
    expect(timing.pausedMs).toBe(7_500);
    expect(timing.elapsedMs).toBe(2_500);
  });

  test("ignores approval events from other request ids", () => {
    const timing = calculateTurnTiming({
      requestId: "req_current",
      startedAtMs: 0,
      completedAtMs: 5_000,
      events: [
        event("leader.approval_requested", "req_other", 1_000, {
          approvalId: "approval_other",
        }),
        event("leader.approval_resolved", "req_other", 4_000, {
          approvalId: "approval_other",
        }),
      ],
    });

    expect(timing.wallMs).toBe(5_000);
    expect(timing.pausedMs).toBe(0);
    expect(timing.elapsedMs).toBe(5_000);
  });

  test("counts overlapping approval waits once", () => {
    const timing = calculateTurnTiming({
      requestId: "req_overlap",
      startedAtMs: 0,
      completedAtMs: 12_000,
      events: [
        event("leader.approval_requested", "req_overlap", 3_000, {
          approvalId: "approval_a",
        }),
        event("leader.approval_requested", "req_overlap", 5_000, {
          approvalId: "approval_b",
        }),
        event("leader.approval_resolved", "req_overlap", 7_000, {
          approvalId: "approval_a",
        }),
        event("leader.approval_resolved", "req_overlap", 9_000, {
          approvalId: "approval_b",
        }),
      ],
    });

    expect(timing.wallMs).toBe(12_000);
    expect(timing.pausedMs).toBe(6_000);
    expect(timing.elapsedMs).toBe(6_000);
  });
});
