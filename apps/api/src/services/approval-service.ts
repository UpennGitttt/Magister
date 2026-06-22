import { ApprovalRepository } from "../repositories/approval-repository";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";

export type ApprovalResource = {
  id: string;
  taskId: string;
  roleRuntimeId?: string | null;
  approvalType: string;
  state: string;
  requestedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
};

function toApprovalResource(approval: {
  id: string;
  taskId: string;
  roleRuntimeId: string | null;
  approvalType: string;
  state: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}): ApprovalResource {
  return {
    id: approval.id,
    taskId: approval.taskId,
    roleRuntimeId: approval.roleRuntimeId,
    approvalType: approval.approvalType,
    state: approval.state,
    requestedAt: approval.requestedAt.toISOString(),
    resolvedAt: approval.resolvedAt?.toISOString() ?? null,
    resolvedBy: approval.resolvedBy,
  };
}

export async function listApprovals() {
  const approvalRepository = new ApprovalRepository();
  const approvals = await approvalRepository.listAll();

  return approvals
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
    .map(toApprovalResource);
}

export async function getApproval(approvalId: string) {
  const approvalRepository = new ApprovalRepository();
  const approval = await approvalRepository.getById(approvalId);
  return approval ? toApprovalResource(approval) : null;
}

export async function resolveApproval(input: {
  approvalId: string;
  resolution: "approved" | "rejected";
  actorId?: string;
  source: "web" | "feishu" | "cli";
  comment?: string;
}) {
  const approvalRepository = new ApprovalRepository();
  const observabilityAdapter = new LocalObservabilityAdapter();

  const approval = await approvalRepository.getById(input.approvalId);
  if (!approval) {
    return null;
  }
  if (approval.state !== "pending") {
    // Already resolved (by the other channel or by timeout). Return
    // the current state without re-firing the resolution side-effects.
    return toApprovalResource(approval);
  }

  const resolvedAt = new Date();
  const landed = await approvalRepository.resolve(input.approvalId, {
    state: input.resolution,
    resolvedAt,
    payloadJson: JSON.stringify({
      source: input.source,
      comment: input.comment,
      resolution: input.resolution,
    }),
    ...(input.actorId ? { resolvedBy: input.actorId } : {}),
  });
  if (!landed) {
    // CAS lost — another channel resolved between getById and the
    // CAS update. Re-read + return whatever they chose.
    const current = await approvalRepository.getById(input.approvalId);
    return current ? toApprovalResource(current) : null;
  }

  await observabilityAdapter.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: "approval.resolved",
    taskId: approval.taskId,
    roleRuntimeId: approval.roleRuntimeId,
    approvalId: approval.id,
    severity: "info",
    occurredAt: resolvedAt,
    // Include `approvalId` in payload too — task-blocked-narrative-service
    // matches resolutions to requests by reading parsePayload(...).approvalId.
    payloadJson: JSON.stringify({
      approvalId: approval.id,
      source: input.source,
      actorId: input.actorId,
      comment: input.comment,
      resolution: input.resolution,
    }),
  });

  // Emit the canonical `leader.approval_resolved` event + WS/SSE
  // publish. Consumers throughout the codebase key on this event type.
  // The `approval.resolved` event above stays for back-compat.
  try {
    const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
    const { wsHub } = await import("../ws/hub");
    const { taskEventBus } = await import("../sse/task-event-bus");
    const eventRepo = new ExecutionEventRepository();
    const canonicalEventId = `event_${crypto.randomUUID()}`;
    const canonicalPayload = {
      approvalId: approval.id,
      toolName: approval.approvalType,
      decision: input.resolution,
      // Provenance — distinguishes from the command-approval-service
      // emit so debugging can tell which path the resolve came in
      // through.
      emittedBy: "approval-service",
    };
    const seq = await eventRepo.create({
      id: canonicalEventId,
      type: "leader.approval_resolved",
      taskId: approval.taskId,
      approvalId: approval.id,
      occurredAt: resolvedAt,
      payloadJson: JSON.stringify(canonicalPayload),
    });
    const wirePayload = {
      type: "leader.approval_resolved",
      requestId: "",
      data: canonicalPayload,
      timestamp: resolvedAt.toISOString(),
      seq,
    };
    wsHub.broadcast(approval.taskId, wirePayload);
    taskEventBus.publish(approval.taskId, wirePayload);
  } catch (err) {
    // Best-effort. The approval.resolved event above already landed,
    // and the narrative-service dual-match (commit 29f04b9) covers
    // the no-broadcast case for the chat banner. WS/SSE failure here
    // only delays card clear until the next reload.
    // eslint-disable-next-line no-console
    console.warn(
      "[approval-service] leader.approval_resolved canonical emit failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const updated = await approvalRepository.getById(input.approvalId);
  return updated ? toApprovalResource(updated) : null;
}
