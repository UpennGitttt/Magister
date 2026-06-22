import { afterEach, beforeEach, expect, test } from "bun:test";

import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import {
  queueFeishuRuntimeTraceEvent,
  queueFeishuRuntimeTraceIfEnabled,
} from "../../src/services/queue-feishu-runtime-trace-service";
import {
  createFeishuFetchMock,
  createFeishuTestHarness,
  type FeishuTestHarness,
} from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "queue-feishu-runtime-trace-db",
  });
});

afterEach(() => {
  harness.cleanup();
});

test("queueFeishuRuntimeTraceEvent stores a runtime_trace outbound payload", async () => {
  const queued = await queueFeishuRuntimeTraceEvent({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace",
    workspaceId: "workspace_main",
    taskId: "task_runtime_trace_1",
    sourceEventId: "event_manager_decision_1",
    eventType: "manager.decision",
    summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
    details: {
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
    },
    roleId: "leader",
    executorId: "model",
    sessionId: "session_manager_trace_1",
    attemptCount: 1,
  });

  expect(queued.payload).toMatchObject({
    channel: "feishu",
    kind: "runtime_trace",
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace",
    taskId: "task_runtime_trace_1",
    sourceEventId: "event_manager_decision_1",
    eventType: "manager.decision",
    summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
    roleId: "leader",
    executorId: "model",
    sessionId: "session_manager_trace_1",
    attemptCount: 1,
    details: {
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
    },
  });

  const events = await new ExecutionEventRepository().listAll();
  const queuedEvent = events.find((event) => event.id === queued.eventId);
  expect(queuedEvent?.type).toBe("channel.outbound.queued");
  expect(JSON.parse(String(queuedEvent?.payloadJson ?? "{}"))).toMatchObject({
    kind: "runtime_trace",
    sourceEventId: "event_manager_decision_1",
    eventType: "manager.decision",
  });
});

test("queueFeishuRuntimeTraceIfEnabled immediately dispatches runtime_trace events for verbose feishu sessions", async () => {
  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-17T10:30:00.000Z");

  harness.installFetchStub(
    createFeishuFetchMock({
      replyMessageId: "om_runtime_trace_immediate_1",
      defaultMessageId: "om_runtime_trace_immediate_1",
    }).fetch,
  );

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_immediate",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_immediate",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_immediate",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_immediate",
    continuityMode: "reply_preferred",
    verboseLevel: "on",
    now,
  });

  const queued = await queueFeishuRuntimeTraceIfEnabled({
    source: "feishu",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_immediate",
    workspaceId: "workspace_main",
    taskId: "task_runtime_trace_immediate",
    sourceEventId: "event_runtime_trace_immediate_1",
    eventType: "manager.decision",
    summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
  });

  expect(queued).not.toBeNull();

  const events = await eventRepository.listAll();
  const deliveredEvent = events.find((event) => event.type === "channel.outbound.delivered");
  expect(deliveredEvent).toBeDefined();
  expect(JSON.parse(String(deliveredEvent?.payloadJson ?? "{}"))).toMatchObject({
    kind: "runtime_trace",
    outboundEventId: queued?.eventId,
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_immediate",
  });
});
