import { expect, test } from "bun:test";

import {
  buildFeishuApprovalCard,
  verifyFeishuApprovalAction,
} from "../../../src/integrations/feishu/feishu-approval-card";

test("buildFeishuApprovalCard signs both approval actions and verifyFeishuApprovalAction accepts them", () => {
  const card = buildFeishuApprovalCard({
    approval: {
      id: "approval_feishu_1",
      taskId: "task_feishu_1",
      roleRuntimeId: "runtime_feishu_1",
      approvalType: "merge",
      state: "pending",
      requestedAt: "2026-04-11T05:00:00.000Z",
      resolvedAt: null,
      resolvedBy: null,
    },
    bindingId: "feishu:tenant_alpha:oc_chat_1",
    taskTitle: "Ship the task summary page",
    secret: "verification-token",
    now: new Date("2026-04-11T05:00:00.000Z"),
  });

  expect(card).toMatchObject({
    kind: "approval_request",
    approvalId: "approval_feishu_1",
    taskId: "task_feishu_1",
    bindingId: "feishu:tenant_alpha:oc_chat_1",
  });
  expect(card.actions).toHaveLength(2);

  for (const action of card.actions) {
    expect(
      verifyFeishuApprovalAction({
        ...action,
        secret: "verification-token",
        now: new Date("2026-04-11T05:10:00.000Z"),
      }),
    ).toEqual({ ok: true });
  }
});

test("verifyFeishuApprovalAction rejects expired or tampered callback actions", () => {
  const card = buildFeishuApprovalCard({
    approval: {
      id: "approval_feishu_2",
      taskId: "task_feishu_2",
      roleRuntimeId: "runtime_feishu_2",
      approvalType: "review",
      state: "pending",
      requestedAt: "2026-04-11T05:00:00.000Z",
      resolvedAt: null,
      resolvedBy: null,
    },
    bindingId: "feishu:tenant_alpha:oc_chat_2",
    taskTitle: "Review the refactor",
    secret: "verification-token",
    now: new Date("2026-04-11T05:00:00.000Z"),
    ttlMinutes: 5,
  });

  const [approveAction] = card.actions;
  expect(
    verifyFeishuApprovalAction({
      ...approveAction,
      signedToken: `${approveAction.signedToken}tampered`,
      secret: "verification-token",
      now: new Date("2026-04-11T05:01:00.000Z"),
    }),
  ).toMatchObject({
    ok: false,
    code: "invalid_feishu_callback_signature",
  });

  expect(
    verifyFeishuApprovalAction({
      ...approveAction,
      secret: "verification-token",
      now: new Date("2026-04-11T05:06:00.000Z"),
    }),
  ).toMatchObject({
    ok: false,
    code: "expired_feishu_callback",
  });
});
