import { createHmac, timingSafeEqual } from "node:crypto";

import type { ApprovalResource } from "../../services/approval-service";

export type FeishuApprovalResolution = "approved" | "rejected";

export type FeishuApprovalCardAction = {
  approvalId: string;
  bindingId: string;
  resolution: FeishuApprovalResolution;
  expiresAt: string;
  signedToken: string;
};

export type FeishuApprovalCard = {
  kind: "approval_request";
  approvalId: string;
  taskId: string;
  bindingId: string;
  title: string;
  summary: string;
  actions: [FeishuApprovalCardAction, FeishuApprovalCardAction];
};

type BuildFeishuApprovalCardInput = {
  approval: ApprovalResource;
  bindingId: string;
  taskTitle: string;
  secret: string;
  now?: Date;
  ttlMinutes?: number;
};

type VerifyFeishuApprovalActionInput = FeishuApprovalCardAction & {
  secret: string;
  now?: Date;
};

function buildTokenPayload(input: {
  approvalId: string;
  bindingId: string;
  resolution: FeishuApprovalResolution;
  expiresAt: string;
}) {
  return `${input.approvalId}:${input.bindingId}:${input.resolution}:${input.expiresAt}`;
}

function signApprovalAction(input: {
  approvalId: string;
  bindingId: string;
  resolution: FeishuApprovalResolution;
  expiresAt: string;
  secret: string;
}) {
  return createHmac("sha256", input.secret)
    .update(
      buildTokenPayload({
        approvalId: input.approvalId,
        bindingId: input.bindingId,
        resolution: input.resolution,
        expiresAt: input.expiresAt,
      }),
    )
    .digest("hex");
}

function buildAction(input: {
  approvalId: string;
  bindingId: string;
  resolution: FeishuApprovalResolution;
  expiresAt: string;
  secret: string;
}) {
  return {
    approvalId: input.approvalId,
    bindingId: input.bindingId,
    resolution: input.resolution,
    expiresAt: input.expiresAt,
    signedToken: signApprovalAction(input),
  } satisfies FeishuApprovalCardAction;
}

export function buildFeishuApprovalCard(input: BuildFeishuApprovalCardInput): FeishuApprovalCard {
  const now = input.now ?? new Date();
  const ttlMinutes = input.ttlMinutes ?? 30;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const summary = `${input.taskTitle} requires ${input.approval.approvalType} approval.`;

  return {
    kind: "approval_request",
    approvalId: input.approval.id,
    taskId: input.approval.taskId,
    bindingId: input.bindingId,
    title: `Approval needed: ${input.approval.approvalType}`,
    summary,
    actions: [
      buildAction({
        approvalId: input.approval.id,
        bindingId: input.bindingId,
        resolution: "approved",
        expiresAt,
        secret: input.secret,
      }),
      buildAction({
        approvalId: input.approval.id,
        bindingId: input.bindingId,
        resolution: "rejected",
        expiresAt,
        secret: input.secret,
      }),
    ],
  };
}

export function verifyFeishuApprovalAction(input: VerifyFeishuApprovalActionInput) {
  const now = input.now ?? new Date();
  const expiresAtTime = Date.parse(input.expiresAt);
  if (Number.isNaN(expiresAtTime) || expiresAtTime <= now.getTime()) {
    return {
      ok: false as const,
      code: "expired_feishu_callback",
      message: "Feishu approval callback has expired",
    };
  }

  const expectedToken = signApprovalAction({
    approvalId: input.approvalId,
    bindingId: input.bindingId,
    resolution: input.resolution,
    expiresAt: input.expiresAt,
    secret: input.secret,
  });

  const provided = Buffer.from(input.signedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return {
      ok: false as const,
      code: "invalid_feishu_callback_signature",
      message: "Feishu approval callback signature is invalid",
    };
  }

  return {
    ok: true as const,
  };
}
