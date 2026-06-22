import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { verifyFeishuApprovalAction, type FeishuApprovalResolution } from "../integrations/feishu/feishu-approval-card";
import { ConversationBindingRepository } from "../repositories/conversation-binding-repository";
import { TaskRepository } from "../repositories/task-repository";
import { getApproval, resolveApproval } from "./approval-service";
import { dispatchQueuedFeishuOutboundEventBestEffort } from "./dispatch-feishu-outbound-event-service";
import { queueFeishuApprovalResolvedSummary } from "./queue-feishu-outbound-summary-service";

export async function resolveFeishuApprovalCallback(input: {
  approvalId: string;
  bindingId: string;
  resolution: FeishuApprovalResolution;
  expiresAt: string;
  signedToken: string;
  actorId?: string;
  comment?: string;
}) {
  const config = parseFeishuConfigFromEnv();
  if (!config.verificationToken) {
    return {
      ok: false as const,
      code: "invalid_feishu_config",
      message: "Feishu verification token is not configured",
    };
  }

  const verification = verifyFeishuApprovalAction({
    approvalId: input.approvalId,
    bindingId: input.bindingId,
    resolution: input.resolution,
    expiresAt: input.expiresAt,
    signedToken: input.signedToken,
    secret: config.verificationToken,
  });

  if (!verification.ok) {
    return verification;
  }

  const taskRepository = new TaskRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const approval = await getApproval(input.approvalId);

  if (!approval) {
    return {
      ok: false as const,
      code: "approval_not_found",
      message: `Approval not found: ${input.approvalId}`,
    };
  }

  const [task, binding] = await Promise.all([
    taskRepository.getById(approval.taskId),
    conversationBindingRepository.getById(input.bindingId),
  ]);

  if (!task) {
    return {
      ok: false as const,
      code: "task_not_found",
      message: `Task not found for approval: ${approval.taskId}`,
    };
  }

  if (!binding) {
    return {
      ok: false as const,
      code: "conversation_binding_not_found",
      message: `Conversation binding not found: ${input.bindingId}`,
    };
  }

  if (task.rootChannelBindingId !== input.bindingId) {
    return {
      ok: false as const,
      code: "approval_binding_mismatch",
      message: "Approval callback binding does not match the task root channel binding",
    };
  }

  const resolved = await resolveApproval({
    approvalId: input.approvalId,
    resolution: input.resolution,
    source: "feishu",
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.comment ? { comment: input.comment } : {}),
  });

  if (!resolved) {
    return {
      ok: false as const,
      code: "approval_not_found",
      message: `Approval not found: ${input.approvalId}`,
    };
  }

  const queuedSummary = await queueFeishuApprovalResolvedSummary({
    bindingId: binding.id,
    workspaceId: binding.workspaceId,
    taskId: task.id,
    taskTitle: task.title,
    approvalId: resolved.id,
    approvalType: resolved.approvalType,
    approvalState: resolved.state,
    ...(resolved.resolvedBy ? { actorId: resolved.resolvedBy } : {}),
  });

  await dispatchQueuedFeishuOutboundEventBestEffort({
    eventId: queuedSummary.eventId,
    kind: queuedSummary.payload.kind,
    taskId: task.id,
    bindingId: binding.id,
    workspaceId: binding.workspaceId,
    failureType: "channel.outbound.approval_delivery_failed",
  });

  return {
    ok: true as const,
    approval: resolved,
    taskId: task.id,
    bindingId: binding.id,
  };
}
