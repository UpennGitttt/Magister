export type TaskBlockedReason =
  | "awaiting_approval"
  | "awaiting_plan_approval"
  | "paused_by_user"
  | "cancel_requested"
  | "runtime_recovery_in_progress"
  | "blocked_by_recovery"
  | "executor_unavailable"
  | "rate_limited"
  | "model_unavailable"
  | "max_turns_reached";

export type TaskBlockedNarrativeStatus =
  | "waiting"
  | "recovering"
  | "blocked"
  | "failed";

export type TaskBlockedNarrative = {
  reason: TaskBlockedReason;
  status: TaskBlockedNarrativeStatus;
  severity: "info" | "warn" | "error";
  message: string;
  nextAction: string | null;
  occurredAt: string | null;
  source: string;
};

export type TaskBlockedNarrativeInput = {
  taskState: string;
  approvalState?: string | null;
  /** Authoritative approval row states (id → state). The narrative
   * decides "is this approval still pending?" from the table, not only
   * from events — terminal paths (abort/expiry) resolve the row without
   * always emitting a `leader.approval_resolved` event. */
  approvals?: Array<{ id: string; state: string }> | null;
  recoveryNotice?: {
    status: "recovered" | "blocked";
    occurredAt: string;
    reason: string;
    previousState: string | null;
    nextState: string | null;
    requiresUserAction: boolean;
    runId: string | null;
  } | null;
  events: Array<{
    id: string;
    type: string;
    severity?: string | null;
    occurredAt: Date;
    payloadJson?: string | null;
    seq?: number | null;
    requestId?: string | null;
  }>;
};

function parsePayload(payloadJson?: string | null) {
  if (!payloadJson) {
    return null;
  }

  try {
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPayloadString(
  payload: Record<string, unknown> | null | undefined,
  keys: string[],
) {
  if (!payload) {
    return null;
  }

  for (const key of keys) {
    const candidate = payload[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return null;
}

function eventTime(event: TaskBlockedNarrativeInput["events"][number] | null | undefined) {
  return event?.occurredAt.getTime() ?? Number.NEGATIVE_INFINITY;
}

function eventIsAfter(
  left: TaskBlockedNarrativeInput["events"][number] | null | undefined,
  right: TaskBlockedNarrativeInput["events"][number] | null | undefined,
) {
  if (!left) return false;
  if (!right) return true;
  const leftTime = eventTime(left);
  const rightTime = eventTime(right);
  if (leftTime !== rightTime) return leftTime > rightTime;
  return (left.seq ?? 0) > (right.seq ?? 0);
}

function latestEvent(
  events: TaskBlockedNarrativeInput["events"],
  predicate: (event: TaskBlockedNarrativeInput["events"][number]) => boolean,
) {
  return [...events]
    .filter(predicate)
    .sort((left, right) => {
      const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return (right.seq ?? 0) - (left.seq ?? 0);
    })[0] ?? null;
}

function buildNarrative(input: TaskBlockedNarrative): TaskBlockedNarrative {
  return input;
}

function unresolvedPlanProposal(events: TaskBlockedNarrativeInput["events"]) {
  const proposals = [...events]
    .filter((event) => event.type === "leader.plan_proposed")
    .sort((left, right) => {
      const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return (right.seq ?? 0) - (left.seq ?? 0);
    });
  for (const proposal of proposals) {
    const proposalRequestId = proposal.requestId ?? null;
    const latestExit = latestEvent(events, (event) => {
      if (event.type !== "leader.plan_mode_exited") return false;
      if (proposalRequestId) return event.requestId === proposalRequestId;
      return true;
    });
    if (!eventIsAfter(latestExit, proposal)) return proposal;
  }
  return null;
}

const TERMINAL_APPROVAL_STATES = new Set(["approved", "rejected", "expired"]);

function unresolvedApprovalRequest(
  events: TaskBlockedNarrativeInput["events"],
  approvals?: TaskBlockedNarrativeInput["approvals"],
) {
  // The approvals table is the source of truth for whether an approval
  // is still pending. Terminal rows (approved/rejected/expired) resolve
  // the request regardless of which — if any — event was projected.
  const terminalApprovalIds = new Set(
    (approvals ?? [])
      .filter((row) => TERMINAL_APPROVAL_STATES.has(row.state.trim().toLowerCase()))
      .map((row) => row.id),
  );
  const requests = [...events]
    .filter((event) => event.type === "leader.approval_requested")
    .sort((left, right) => {
      const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      return (right.seq ?? 0) - (left.seq ?? 0);
    });
  for (const request of requests) {
    const payload = parsePayload(request.payloadJson);
    const approvalId = readPayloadString(payload, ["approvalId"]);
    const requestId = request.requestId ?? null;
    // Authoritative short-circuit: the DB row is already terminal.
    if (approvalId && terminalApprovalIds.has(approvalId)) continue;
    const latestResolved = latestEvent(events, (event) => {
      // Three event shapes terminate the same DB row:
      //  - `leader.approval_resolved`     (command-approval-service)
      //  - `approval.resolved`            (approval-service)
      //  - `leader.approval_replay_conflict` (a resolve attempt that
      //    collided with an already-terminal row — the row is done).
      // Narrative once matched only the first name; any approval
      // resolved via another route left the task stuck in "Waiting for
      // a human approval" forever. Accept all three.
      if (
        event.type !== "leader.approval_resolved" &&
        event.type !== "approval.resolved" &&
        event.type !== "leader.approval_replay_conflict"
      ) {
        return false;
      }
      const resolvedPayload = parsePayload(event.payloadJson);
      const resolvedApprovalId = readPayloadString(resolvedPayload, ["approvalId"]);
      if (approvalId) return resolvedApprovalId === approvalId;
      if (requestId) return event.requestId === requestId;
      return true;
    });
    if (!eventIsAfter(latestResolved, request)) return request;
  }
  return null;
}

function classifyFailureEvent(event: TaskBlockedNarrativeInput["events"][number]) {
  const payload = parsePayload(event.payloadJson);
  const code = readPayloadString(payload, [
    "failureCode",
    "code",
    "errorCode",
    "dispatchCode",
    "reason",
    "stopReason",
  ])?.toLowerCase();
  const message = readPayloadString(payload, [
    "message",
    "error",
    "summary",
    "dispatchMessage",
    "lastMessage",
    "lastMessagePreview",
  ]);
  const haystack = `${code ?? ""} ${message ?? ""}`.toLowerCase();

  if (
    haystack.includes("rate_limit") ||
    haystack.includes("rate limit") ||
    haystack.includes("429") ||
    haystack.includes("too many requests") ||
    haystack.includes("overload")
  ) {
    return buildNarrative({
      reason: "rate_limited",
      status: "blocked",
      severity: "error",
      message: "Provider rate limit or overload stopped this turn.",
      nextAction: "Wait for the provider limit to reset or switch model.",
      occurredAt: event.occurredAt.toISOString(),
      source: event.type,
    });
  }

  if (
    code === "executor_unavailable" ||
    code === "executor_unconfigured" ||
    code === "executor_provider_missing" ||
    code === "executor_auth_failed" ||
    code === "executor_invocation_failed" ||
    haystack.includes("executor unavailable")
  ) {
    return buildNarrative({
      reason: "executor_unavailable",
      status: "blocked",
      severity: "error",
      message: "Executor is unavailable for this task.",
      nextAction: "Fix executor configuration or choose another runtime.",
      occurredAt: event.occurredAt.toISOString(),
      source: event.type,
    });
  }

  if (
    code === "executor_model_missing" ||
    haystack.includes("model unavailable") ||
    haystack.includes("model is currently unavailable") ||
    haystack.includes("model_not_found") ||
    haystack.includes("model not found")
  ) {
    return buildNarrative({
      reason: "model_unavailable",
      status: "blocked",
      severity: "error",
      message: "The selected model or provider is unavailable.",
      nextAction: "Switch model/provider or retry after availability recovers.",
      occurredAt: event.occurredAt.toISOString(),
      source: event.type,
    });
  }

  return null;
}

export function deriveTaskBlockedNarrative(
  input: TaskBlockedNarrativeInput,
): TaskBlockedNarrative | null {
  const upperState = input.taskState.trim().toUpperCase();
  if (upperState === "DONE" || upperState === "COMPLETED") {
    return null;
  }

  if (input.recoveryNotice?.status === "blocked") {
    return buildNarrative({
      reason: "blocked_by_recovery",
      status: "blocked",
      severity: "error",
      message: "Runtime recovery exhausted its retries.",
      nextAction: "Inspect the failed run and retry or start a new session.",
      occurredAt: input.recoveryNotice.occurredAt,
      source: "recovery_notice",
    });
  }

  if (upperState === "CANCELLED") {
    return buildNarrative({
      reason: "cancel_requested",
      status: "failed",
      severity: "warn",
      message: "The task was cancelled.",
      nextAction: "Start a new session or retry if more work is needed.",
      occurredAt: null,
      source: "task.state",
    });
  }

  if (input.recoveryNotice?.status === "recovered") {
    return buildNarrative({
      reason: "runtime_recovery_in_progress",
      status: "recovering",
      severity: "info",
      message: "Runtime recovery requeued this task.",
      nextAction: "No action needed unless the task stalls again.",
      occurredAt: input.recoveryNotice.occurredAt,
      source: "recovery_notice",
    });
  }

  const latestProgress = latestEvent(input.events, (event) =>
    event.type === "task.orchestration.transition" ||
    event.type === "leader.session_complete" ||
    event.type === "task:completed");
  const latestMaxTurns = latestEvent(input.events, (event) => event.type === "leader.max_turns");
  if (latestMaxTurns && !eventIsAfter(latestProgress, latestMaxTurns)) {
    return buildNarrative({
      reason: "max_turns_reached",
      status: "blocked",
      severity: "warn",
      message: "The leader stopped after reaching the max-turn limit.",
      nextAction: "Review progress, then continue with a fresh instruction if needed.",
      occurredAt: latestMaxTurns.occurredAt.toISOString(),
      source: latestMaxTurns.type,
    });
  }

  const latestFailure = latestEvent(input.events, (event) =>
    event.type === "leader.model_error" ||
    event.type === "executor_session.failed" ||
    event.type === "task.orchestration.stopped");
  if (latestFailure && !eventIsAfter(latestProgress, latestFailure)) {
    const narrative = classifyFailureEvent(latestFailure);
    if (narrative) {
      return narrative;
    }
  }

  const planEvent = unresolvedPlanProposal(input.events);
  if (planEvent) {
    return buildNarrative({
      reason: "awaiting_plan_approval",
      status: "waiting",
      severity: "warn",
      message: "Waiting for plan approval.",
      nextAction: "Approve, revise, or cancel the proposed plan.",
      occurredAt: planEvent.occurredAt.toISOString(),
      source: planEvent.type,
    });
  }

  const approvalState = input.approvalState?.trim().toLowerCase() ?? null;
  const approvalEvent = unresolvedApprovalRequest(input.events, input.approvals);
  if (approvalEvent || approvalState === "pending" || approvalState === "requested") {
    return buildNarrative({
      reason: "awaiting_approval",
      status: "waiting",
      severity: "warn",
      message: "Waiting for a human approval.",
      nextAction: "Review the pending approval request.",
      occurredAt: approvalEvent?.occurredAt.toISOString() ?? null,
      source: approvalEvent?.type ?? "approval.state",
    });
  }

  if (upperState === "PAUSED") {
    return buildNarrative({
      reason: "paused_by_user",
      status: "waiting",
      severity: "info",
      message: "The task is paused.",
      nextAction: "Resume the task when ready.",
      occurredAt: null,
      source: "task.state",
    });
  }

  return null;
}
