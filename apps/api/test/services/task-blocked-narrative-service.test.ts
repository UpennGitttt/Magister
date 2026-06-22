import { describe, expect, test } from "bun:test";

import {
  deriveTaskBlockedNarrative,
  type TaskBlockedNarrativeInput,
} from "../../src/services/task-blocked-narrative-service";

function event(
  type: string,
  payload: Record<string, unknown>,
  occurredAt = "2026-05-12T08:00:00.000Z",
  severity?: "info" | "warn" | "error",
  requestId?: string,
): TaskBlockedNarrativeInput["events"][number] {
  return {
    id: `event_${type}_${occurredAt}`,
    type,
    severity: severity ?? null,
    occurredAt: new Date(occurredAt),
    payloadJson: JSON.stringify(payload),
    ...(requestId ? { requestId } : {}),
  };
}

function input(
  override: Partial<TaskBlockedNarrativeInput>,
): TaskBlockedNarrativeInput {
  return {
    taskState: "EXECUTING",
    approvalState: null,
    recoveryNotice: null,
    events: [],
    ...override,
  };
}

describe("deriveTaskBlockedNarrative", () => {
  test("maps awaiting approval to a concise next action", () => {
    expect(deriveTaskBlockedNarrative(input({
      approvalState: "pending",
    }))).toMatchObject({
      reason: "awaiting_approval",
      status: "waiting",
      severity: "warn",
      message: "Waiting for a human approval.",
      nextAction: "Review the pending approval request.",
    });
  });

  test("maps an unresolved plan proposal to awaiting plan approval", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.plan_proposed", { plan: "## Plan" }, "2026-05-12T08:00:00.000Z"),
      ],
    }))).toMatchObject({
      reason: "awaiting_plan_approval",
      status: "waiting",
      message: "Waiting for plan approval.",
      nextAction: "Approve, revise, or cancel the proposed plan.",
    });
  });

  test("does not keep awaiting plan approval after plan mode exits", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.plan_proposed", { plan: "## Plan" }, "2026-05-12T08:00:00.000Z", undefined, "req_plan"),
        event("leader.plan_mode_exited", { reason: "approved" }, "2026-05-12T08:01:00.000Z", undefined, "req_plan"),
      ],
    }))).toBeNull();
  });

  test("does not close a plan proposal with an exit from another request", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.plan_proposed", { plan: "## Plan" }, "2026-05-12T08:00:00.000Z", undefined, "req_plan_a"),
        event("leader.plan_mode_exited", { reason: "approved" }, "2026-05-12T08:01:00.000Z", undefined, "req_plan_b"),
      ],
    }))).toMatchObject({
      reason: "awaiting_plan_approval",
      status: "waiting",
    });
  });

  test("maps paused and cancelled task states", () => {
    expect(deriveTaskBlockedNarrative(input({ taskState: "PAUSED" }))).toMatchObject({
      reason: "paused_by_user",
      status: "waiting",
      nextAction: "Resume the task when ready.",
    });
    expect(deriveTaskBlockedNarrative(input({ taskState: "CANCELLED" }))).toMatchObject({
      reason: "cancel_requested",
      status: "failed",
      nextAction: "Start a new session or retry if more work is needed.",
    });
  });

  test("maps recovery notices to recovering and blocked states", () => {
    expect(deriveTaskBlockedNarrative(input({
      recoveryNotice: {
        status: "recovered",
        occurredAt: "2026-05-12T08:02:00.000Z",
        reason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        nextState: "IN_PROGRESS",
        requiresUserAction: false,
        runId: "rt_recovered",
      },
    }))).toMatchObject({
      reason: "runtime_recovery_in_progress",
      status: "recovering",
      severity: "info",
      nextAction: "No action needed unless the task stalls again.",
    });

    expect(deriveTaskBlockedNarrative(input({
      recoveryNotice: {
        status: "blocked",
        occurredAt: "2026-05-12T08:03:00.000Z",
        reason: "runtime_recovery_exhausted",
        previousState: "RUNNING",
        nextState: "BLOCKED",
        requiresUserAction: true,
        runId: "rt_blocked",
      },
    }))).toMatchObject({
      reason: "blocked_by_recovery",
      status: "blocked",
      severity: "error",
      nextAction: "Inspect the failed run and retry or start a new session.",
    });
  });

  test("maps executor availability and model/provider failures", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("executor_session.failed", {
          failureCode: "executor_unavailable",
          message: "Codex CLI is unavailable",
        }, "2026-05-12T08:04:00.000Z", "error"),
      ],
    }))).toMatchObject({
      reason: "executor_unavailable",
      status: "blocked",
      nextAction: "Fix executor configuration or choose another runtime.",
    });

    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.model_error", { error: "429 rate limit exceeded" }, "2026-05-12T08:05:00.000Z", "error"),
      ],
    }))).toMatchObject({
      reason: "rate_limited",
      status: "blocked",
      nextAction: "Wait for the provider limit to reset or switch model.",
    });

    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.model_error", { error: "model is currently unavailable" }, "2026-05-12T08:06:00.000Z", "error"),
      ],
    }))).toMatchObject({
      reason: "model_unavailable",
      status: "blocked",
      nextAction: "Switch model/provider or retry after availability recovers.",
    });
  });

  test("maps max turns reached", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.max_turns", { maxTurns: 30, turnCount: 31 }, "2026-05-12T08:07:00.000Z", "warn"),
      ],
    }))).toMatchObject({
      reason: "max_turns_reached",
      status: "blocked",
      message: "The leader stopped after reaching the max-turn limit.",
      nextAction: "Review progress, then continue with a fresh instruction if needed.",
    });
  });

  test("does not keep stale max-turn or failure blockers after progress or completion", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.max_turns", { maxTurns: 30 }, "2026-05-12T08:07:00.000Z", "warn"),
        event("task.orchestration.transition", { transition: "retry" }, "2026-05-12T08:08:00.000Z", "info"),
      ],
    }))).toBeNull();

    expect(deriveTaskBlockedNarrative(input({
      taskState: "DONE",
      events: [
        event("leader.model_error", { error: "429 rate limit exceeded" }, "2026-05-12T08:05:00.000Z", "error"),
      ],
    }))).toBeNull();
  });

  test("keeps an older unresolved approval when a newer approval was resolved", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.approval_requested", { approvalId: "approval_a" }, "2026-05-12T08:00:00.000Z", "warn"),
        event("leader.approval_requested", { approvalId: "approval_b" }, "2026-05-12T08:01:00.000Z", "warn"),
        event("leader.approval_resolved", { approvalId: "approval_b" }, "2026-05-12T08:02:00.000Z", "info"),
      ],
    }))).toMatchObject({
      reason: "awaiting_approval",
      status: "waiting",
    });
  });

  // Regression: an approval terminated via replay-conflict (the operator
  // clicked Approve after the row had already expired/aborted) emits
  // `leader.approval_replay_conflict`, NOT `leader.approval_resolved`.
  // The narrative must treat that as terminal, or the task is stuck on
  // "Waiting for a human approval" forever with no actionable button.
  test("treats a replay conflict as terminating an approval request", () => {
    expect(deriveTaskBlockedNarrative(input({
      events: [
        event("leader.approval_requested", { approvalId: "approval_a" }, "2026-05-12T08:00:00.000Z", "warn"),
        event("leader.approval_replay_conflict", { approvalId: "approval_a", storedOutcome: "expired" }, "2026-05-12T08:01:00.000Z", "warn"),
      ],
    }))).toBeNull();
  });

  // Regression: the abort path resolves the approvals row to a terminal
  // state without (historically) emitting any resolution event. The
  // approvals table is the source of truth — a terminal row must clear
  // the banner even when no resolution event exists.
  test("treats a terminal approvals row as resolving the request without a resolution event", () => {
    expect(deriveTaskBlockedNarrative(input({
      approvals: [{ id: "approval_a", state: "expired" }],
      events: [
        event("leader.approval_requested", { approvalId: "approval_a" }, "2026-05-12T08:00:00.000Z", "warn"),
      ],
    }))).toBeNull();
  });

  test("keeps awaiting approval while the approvals row is still pending", () => {
    expect(deriveTaskBlockedNarrative(input({
      approvals: [{ id: "approval_a", state: "pending" }],
      events: [
        event("leader.approval_requested", { approvalId: "approval_a" }, "2026-05-12T08:00:00.000Z", "warn"),
      ],
    }))).toMatchObject({
      reason: "awaiting_approval",
      status: "waiting",
    });
  });
});
