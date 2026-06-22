import { afterEach, beforeEach, expect, test } from "bun:test";

import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { deliverQueuedFeishuOutboundEvents } from "../../src/services/feishu-outbound-delivery-service";
import { createFeishuTestHarness, type FeishuTestHarness } from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "feishu-outbound-service-db",
  });
});

afterEach(() => {
  harness.cleanup();
});

test("deliverQueuedFeishuOutboundEvents records a failed event when sender delivery throws", async () => {
  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T06:15:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_beta:oc_chat_failure",
    channel: "feishu",
    accountId: "tenant_beta",
    chatId: "oc_chat_failure",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_failure",
    type: "channel.outbound.queued",
    taskId: "task_delivery_failure",
    conversationBindingId: "feishu:tenant_beta:oc_chat_failure",
    workspaceId: "workspace_main",
    severity: "warn",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_blocked",
      bindingId: "feishu:tenant_beta:oc_chat_failure",
      taskId: "task_delivery_failure",
      title: "Task blocked",
      summary: "The task is blocked and needs attention.",
    }),
  });

  const result = await deliverQueuedFeishuOutboundEvents({
    transport: async () => {
      throw new Error("transport unavailable");
    },
  });

  expect(result).toMatchObject({
    deliveredCount: 0,
    failedCount: 1,
    failures: [
      {
        outboundEventId: "event_outbound_queue_failure",
        bindingId: "feishu:tenant_beta:oc_chat_failure",
        chatId: "oc_chat_failure",
        code: "delivery_failed",
      },
    ],
  });

  const events = await eventRepository.listAll();
  const failedEvents = events.filter((event) => event.type === "channel.outbound.failed");

  expect(failedEvents).toHaveLength(1);
  expect(JSON.parse(String(failedEvents[0]?.payloadJson))).toMatchObject({
    channel: "feishu",
    outboundEventId: "event_outbound_queue_failure",
    bindingId: "feishu:tenant_beta:oc_chat_failure",
    chatId: "oc_chat_failure",
    code: "delivery_failed",
    message: "transport unavailable",
  });
});

test("deliverQueuedFeishuOutboundEvents avoids duplicate delivery when two workers process the same queued event concurrently", async () => {
  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T10:15:00.000Z");
  let transportCallCount = 0;

  await bindingRepository.create({
    id: "feishu:tenant_beta:oc_chat_concurrent_delivery",
    channel: "feishu",
    accountId: "tenant_beta",
    chatId: "oc_chat_concurrent_delivery",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_concurrent_delivery",
    type: "channel.outbound.queued",
    taskId: "task_concurrent_delivery",
    conversationBindingId: "feishu:tenant_beta:oc_chat_concurrent_delivery",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_beta:oc_chat_concurrent_delivery",
      taskId: "task_concurrent_delivery",
      title: "Task completed",
      summary: "Concurrent delivery should be idempotent.",
      taskTitle: "Concurrent delivery check",
      taskState: "COMPLETED",
    }),
  });

  const transport = async () => {
    transportCallCount += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return {
      providerMessageId: `om_concurrent_delivery_${transportCallCount}`,
    };
  };

  await Promise.all([
    deliverQueuedFeishuOutboundEvents({
      transport,
    }),
    deliverQueuedFeishuOutboundEvents({
      transport,
    }),
  ]);

  const events = await eventRepository.listAll();
  const deliveredEvents = events.filter((event) => event.type === "channel.outbound.delivered");

  expect(transportCallCount).toBe(1);
  expect(deliveredEvents).toHaveLength(1);
  expect(JSON.parse(String(deliveredEvents[0]?.payloadJson))).toMatchObject({
    outboundEventId: "event_outbound_queue_concurrent_delivery",
    bindingId: "feishu:tenant_beta:oc_chat_concurrent_delivery",
  });
});

test("deliverQueuedFeishuOutboundEvents records the delivery mode chosen for visible channel sessions", async () => {
  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-13T10:20:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_beta:oc_chat_visible_delivery",
    channel: "feishu",
    accountId: "tenant_beta",
    chatId: "oc_chat_visible_delivery",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_visible_delivery",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_beta:oc_chat_visible_delivery",
    continuityMode: "top_level_preferred",
    currentTaskId: "task_delivery_visible",
    latestInboundMessageId: "om_visible_inbound",
    latestAnswerSummary: "Latest answer summary",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_visible_delivery",
    type: "channel.outbound.queued",
    taskId: "task_delivery_visible",
    conversationBindingId: "feishu:tenant_beta:oc_chat_visible_delivery",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_beta:oc_chat_visible_delivery",
      taskId: "task_delivery_visible",
      title: "Task completed",
      summary: "Visible sessions should surface a top-level message.",
      taskTitle: "Review visible delivery policy",
      taskState: "COMPLETED",
      latestAnswer: "This should appear as a top-level message.",
      nextAction: "No next action.",
      managerPlan: {
        taskType: "conversation",
        confidence: "high",
        plannedCapabilities: [],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "COMPLETED",
            executorId: "system",
            summary: "Delivered a visible completion message.",
          },
        ],
        completedCapabilities: ["leader"],
        pendingCapabilities: [],
        blockedCapabilities: [],
        nextCapability: null,
      },
    }),
  });

  const result = await deliverQueuedFeishuOutboundEvents({
    transport: async ({ payload }) => {
      expect(payload.kind).toBe("task_orchestration_completed");
      return {
        providerMessageId: "om_top_level_visible_delivery",
      };
    },
  });

  const events = await eventRepository.listAll();
  const deliveredEvents = events.filter((event) => event.type === "channel.outbound.delivered");
  const deliveredPayload = JSON.parse(String(deliveredEvents[0]?.payloadJson)) as {
    deliveryMode?: string;
  };

  expect(result).toMatchObject({
    deliveredCount: 1,
    failedCount: 0,
  });
  expect(deliveredPayload).toMatchObject({
    deliveryMode: "top_level_preferred",
  });
});

test("deliverQueuedFeishuOutboundEvents delivers runtime_trace payloads and records them as delivered events", async () => {
  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-17T06:10:00.000Z");
  const payloads: Array<Record<string, unknown>> = [];

  await bindingRepository.create({
    id: "feishu:tenant_beta:oc_chat_runtime_trace_service",
    channel: "feishu",
    accountId: "tenant_beta",
    chatId: "oc_chat_runtime_trace_service",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_service",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_beta:oc_chat_runtime_trace_service",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_service",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_service",
    conversationBindingId: "feishu:tenant_beta:oc_chat_runtime_trace_service",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_beta:oc_chat_runtime_trace_service",
      taskId: "task_runtime_trace_service",
      sourceEventId: "event_manager_decision_runtime_trace_service",
      eventType: "manager.decision",
      summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
      roleId: "leader",
      executorId: "model",
      sessionId: "session_manager_runtime_trace_service",
      attemptCount: 1,
      details: {
        taskType: "coding",
        executionMode: "bounded_execution",
        decision: "spawn_work_items",
      },
    }),
  });

  const result = await deliverQueuedFeishuOutboundEvents({
    transport: async ({ payload }) => {
      payloads.push(payload as unknown as Record<string, unknown>);
      return {
        providerMessageId: "om_runtime_trace_service_1",
      };
    },
  });

  const events = await eventRepository.listAll();
  const deliveredEvent = events.find(
    (event) =>
      event.type === "channel.outbound.delivered" &&
      JSON.parse(String(event.payloadJson ?? "{}")).outboundEventId ===
        "event_outbound_queue_runtime_trace_service",
  );

  expect(result).toMatchObject({
    deliveredCount: 1,
    failedCount: 0,
  });
  expect(payloads).toEqual([
    expect.objectContaining({
      kind: "runtime_trace",
      summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
    }),
  ]);
  expect(JSON.parse(String(deliveredEvent?.payloadJson ?? "{}"))).toMatchObject({
    kind: "runtime_trace",
    outboundEventId: "event_outbound_queue_runtime_trace_service",
    bindingId: "feishu:tenant_beta:oc_chat_runtime_trace_service",
  });
});
