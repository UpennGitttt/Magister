import { afterEach, beforeEach, expect, test } from "bun:test";

import { buildFeishuApprovalCard } from "../../src/integrations/feishu/feishu-approval-card";
import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { buildApp } from "../../src/app";
import {
  createFeishuFetchMock,
  createFeishuTestHarness,
  type FeishuTestHarness,
} from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "channel-callbacks-db",
    includeExecutorConfig: true,
  });
  harness.writeStubExecutorConfig();
  harness.installFetchStub(
    createFeishuFetchMock({
      replyMessageId: "om_reply_message_callback",
      defaultMessageId: "om_reply_message_callback",
    }).fetch,
  );
});

afterEach(() => {
  harness.cleanup();
});

test("POST /channel-callbacks/feishu resolves the shared approval when the signed binding matches the task", async () => {
  const app = buildApp();
  const approvalRepository = new ApprovalRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const now = new Date();

  await conversationBindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_route",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_route",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_callback",
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Ship a merge candidate",
      source: "feishu",
      workspaceId: "workspace_main",
      rootChannelBindingId: "feishu:tenant_alpha:oc_chat_route",
    },
  });

  const created = createResponse.json() as {
    data: { taskId: string; runId: string };
  };

  await approvalRepository.create({
    id: "approval_callback_1",
    taskId: created.data.taskId,
    roleRuntimeId: created.data.runId,
    approvalType: "merge",
    state: "pending",
    requestedAt: now,
  });

  const card = buildFeishuApprovalCard({
    approval: {
      id: "approval_callback_1",
      taskId: created.data.taskId,
      roleRuntimeId: created.data.runId,
      approvalType: "merge",
      state: "pending",
      requestedAt: now.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    },
    bindingId: "feishu:tenant_alpha:oc_chat_route",
    taskTitle: "Ship a merge candidate",
    secret: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    now,
  });

  const approveAction = card.actions[0]!;
  const response = await app.inject({
    method: "POST",
    url: "/channel-callbacks/feishu",
    payload: {
      ...approveAction,
      actorId: "ou_sender_route",
      comment: "ship it",
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      bindingId: "feishu:tenant_alpha:oc_chat_route",
      taskId: created.data.taskId,
      approval: {
        id: "approval_callback_1",
        state: "approved",
        resolvedBy: "ou_sender_route",
      },
    },
  });

  const eventRepository = new ExecutionEventRepository();
  const recordedEvents = await eventRepository.listAll();
  const outboundEvent = recordedEvents.find((event) => {
    if (event.type !== "channel.outbound.queued") {
      return false;
    }
    const payload = JSON.parse(String(event.payloadJson)) as { kind?: string };
    return payload.kind === "approval_resolved";
  });

  expect(outboundEvent).toMatchObject({
    type: "channel.outbound.queued",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_route",
    severity: "info",
    taskId: created.data.taskId,
    approvalId: "approval_callback_1",
  });
  expect(JSON.parse(String(outboundEvent?.payloadJson))).toMatchObject({
    channel: "feishu",
    kind: "approval_resolved",
    title: "Approval approved",
    bindingId: "feishu:tenant_alpha:oc_chat_route",
  });
  const deliveredEvent = recordedEvents.find((event) => {
    if (event.type !== "channel.outbound.delivered") {
      return false;
    }
    const payload = JSON.parse(String(event.payloadJson)) as { kind?: string };
    return payload.kind === "approval_resolved";
  });
  expect(deliveredEvent).toMatchObject({
    type: "channel.outbound.delivered",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_route",
    taskId: created.data.taskId,
  });
  expect(JSON.parse(String(deliveredEvent?.payloadJson))).toMatchObject({
    providerMessageId: "om_reply_message_callback",
  });
});

test("POST /channel-callbacks/feishu rejects mismatched bindings", async () => {
  const app = buildApp();
  const approvalRepository = new ApprovalRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const now = new Date();

  await conversationBindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_expected",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_expected",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Review the architectural change",
      source: "feishu",
      workspaceId: "workspace_main",
      rootChannelBindingId: "feishu:tenant_alpha:oc_chat_expected",
    },
  });

  const created = createResponse.json() as {
    data: { taskId: string; runId: string };
  };

  await conversationBindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_other",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_other",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  await approvalRepository.create({
    id: "approval_callback_2",
    taskId: created.data.taskId,
    roleRuntimeId: created.data.runId,
    approvalType: "review",
    state: "pending",
    requestedAt: now,
  });

  const card = buildFeishuApprovalCard({
    approval: {
      id: "approval_callback_2",
      taskId: created.data.taskId,
      roleRuntimeId: created.data.runId,
      approvalType: "review",
      state: "pending",
      requestedAt: now.toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    },
    bindingId: "feishu:tenant_alpha:oc_chat_other",
    taskTitle: "Review the architectural change",
    secret: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    now,
  });

  const rejectAction = card.actions[1]!;
  const response = await app.inject({
    method: "POST",
    url: "/channel-callbacks/feishu",
    payload: rejectAction,
  });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({
    ok: false,
    error: {
      code: "approval_binding_mismatch",
    },
  });
});
