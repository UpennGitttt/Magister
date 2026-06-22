import { afterEach, beforeEach, expect, test } from "bun:test";

import { buildApp } from "../../src/app";
import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import {
  createFeishuFetchMock,
  createFeishuTestHarness,
  type FeishuTestHarness,
} from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "feishu-outbound-delivery-db",
    outboundStyle: "compact",
  });
});

afterEach(() => {
  harness.cleanup();
});

test("POST /feishu/outbound/deliver delivers queued Feishu events and is idempotent on replay", async () => {
  const fetchMock = createFeishuFetchMock({
    reactionId: "reaction_ok_123",
    defaultMessageId: "om_text_message_123",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:00:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_delivery",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_delivery",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_delivery_ack",
  });

  await eventRepository.create({
    id: "event_outbound_queue_1",
    type: "channel.outbound.queued",
    taskId: "task_delivery_1",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_delivery",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_created",
      bindingId: "feishu:tenant_alpha:oc_chat_delivery",
      taskId: "task_delivery_1",
      title: "👌",
      taskTitle: "Review operator console",
      taskState: "BLOCKED",
    }),
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(firstResponse.statusCode).toBe(200);
  expect(firstResponse.json()).toMatchObject({
    ok: true,
    data: {
      deliveredCount: 1,
      failedCount: 0,
      deliveries: [
        {
          outboundEventId: "event_outbound_queue_1",
          bindingId: "feishu:tenant_alpha:oc_chat_delivery",
          chatId: "oc_chat_delivery",
          kind: "task_created",
          providerMessageId: "reaction_ok_123",
        },
      ],
    },
  });
  const reactionRequests = outboundRequests.filter((request) =>
    request.url === "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_delivery_ack/reactions",
  );
  expect(reactionRequests).toHaveLength(1);
  const deliveryRequest = reactionRequests[0];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_delivery_ack/reactions",
  );
  expect(JSON.parse(String(deliveryRequest?.init?.body ?? "{}"))).toEqual({
    reaction_type: {
      emoji_type: "OK",
    },
  });

  const secondResponse = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(secondResponse.statusCode).toBe(200);
  expect(secondResponse.json()).toMatchObject({
    ok: true,
    data: {
      deliveredCount: 0,
      failedCount: 0,
      deliveries: [],
    },
  });

  const events = await eventRepository.listAll();
  const deliveredEvents = events.filter((event) => event.type === "channel.outbound.delivered");

  expect(deliveredEvents).toHaveLength(1);
  expect(JSON.parse(String(deliveredEvents[0]?.payloadJson))).toMatchObject({
    channel: "feishu",
    outboundEventId: "event_outbound_queue_1",
    bindingId: "feishu:tenant_alpha:oc_chat_delivery",
    chatId: "oc_chat_delivery",
    kind: "task_created",
    title: "👌",
    providerMessageId: "reaction_ok_123",
  });
});

test("POST /feishu/outbound/deliver uses a top-level send when the channel session requires visibility", async () => {
  process.env.MAGISTER_WEB_PUBLIC_BASE_URL = "https://console.example.com/";
  const fetchMock = createFeishuFetchMock({
    topLevelMessageId: "om_visible_top_level_message",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:25:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_visible_route",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_visible_route",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_visible_route",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_visible_route",
    continuityMode: "top_level_preferred",
    currentTaskId: "task_route_visible_delivery",
    latestInboundMessageId: "om_visible_route_inbound",
    latestAnswerSummary: "Latest answer summary",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_visible_route",
    type: "channel.outbound.queued",
    taskId: "task_route_visible_delivery",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_visible_route",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_alpha:oc_chat_visible_route",
      taskId: "task_route_visible_delivery",
      title: "Task completed",
      summary: "Visible sessions should use a top-level send.",
      taskTitle: "Check visible delivery routing",
      taskState: "COMPLETED",
      latestAnswer: "This should be sent to the top level.",
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

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const topLevelSendRequests = outboundRequests.filter((request) =>
    request.url.includes("/messages?receive_id_type=chat_id"),
  );
  expect(topLevelSendRequests.length).toBeGreaterThanOrEqual(1);
  const lastTopLevelSendRequest = topLevelSendRequests[topLevelSendRequests.length - 1];
  expect(lastTopLevelSendRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
  expect(JSON.parse(String(lastTopLevelSendRequest?.init?.body ?? "{}"))).toMatchObject({
    receive_id: "oc_chat_visible_route",
    msg_type: "text",
  });

});

test("POST /feishu/outbound/deliver renders manager plan fields for orchestration summaries", async () => {
  process.env.MAGISTER_WEB_PUBLIC_BASE_URL = "https://console.example.com/";
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_message_456",
    defaultMessageId: "om_reply_message_456",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:10:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_plan",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_plan",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_plan",
  });

  await eventRepository.create({
    id: "event_outbound_queue_2",
    type: "channel.outbound.queued",
    taskId: "task_delivery_2",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_plan",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_alpha:oc_chat_plan",
      taskId: "task_delivery_2",
      title: "Task completed",
      summary: "The task finished successfully.",
      taskTitle: "Refine the agent orchestration digest",
      taskState: "COMPLETED",
      latestAnswer: "Manager completed the plan and the coder implemented the fix.",
      nextAction: "Review the result and decide the next operator step.",
      managerPlan: {
        taskType: "mixed",
        confidence: "low",
        needsHuman: true,
        warnings: ["Manager inferred a mixed path from ambiguous wording and recommends operator review."],
        plannedCapabilities: ["architect", "coder", "reviewer"],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "COMPLETED",
            executorId: "codex",
            summary: "Seeded architect, coder, and reviewer follow-up lanes.",
          },
          {
            roleId: "architect",
            state: "COMPLETED",
            executorId: "codex",
            summary: "Produced the implementation outline.",
          },
          {
            roleId: "coder",
            state: "COMPLETED",
            executorId: "codex",
            summary: "Implemented the requested changes.",
          },
          {
            roleId: "reviewer",
            state: "QUEUED",
            executorId: "model",
            runId: "runtime_reviewer_queued",
            summary: "Waiting for review.",
          },
        ],
        completedCapabilities: ["leader", "architect", "coder"],
        pendingCapabilities: ["reviewer"],
        blockedCapabilities: [],
        nextCapability: "reviewer",
      },
      trace: [
        {
          kind: "tool_result",
          text: "Implemented the requested changes.",
          roleId: "coder",
          source: "codex",
          executorId: "codex",
          sessionId: "session_coder_trace_1",
          attemptCount: 2,
        },
        {
          kind: "subagent",
          text: "任务经理派生了 architect、coder、reviewer 这些内部工作项",
          source: "task_manager",
        },
        {
          kind: "message",
          text: "Queued reviewer after coder finished and prepared the next retry window.",
          roleId: "reviewer",
          source: "scheduler",
          executorId: "model",
          sessionId: "session_reviewer_trace_1",
          attemptCount: 1,
        },
        {
          kind: "tool_call",
          text: "Ran the integration test suite before handing off to reviewer.",
          roleId: "coder",
          source: "bun_test",
          executorId: "codex",
          sessionId: "session_coder_trace_1",
          attemptCount: 2,
        },
      ],
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const replyRequests = outboundRequests.filter((request) =>
    request.url === "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_plan/reply",
  );
  expect(replyRequests).toHaveLength(1);
  const deliveryRequest = replyRequests[0];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_plan/reply",
  );
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
    msg_type?: string;
  };
  expect(deliveryBody.msg_type).toBe("text");
  const content = JSON.parse(String(deliveryBody.content)) as { text?: string };
  expect(content.text).toBeDefined();
  const text = content.text ?? "";
  expect(text).toContain("✅ Leader 已完成这个任务");
  expect(text).not.toContain("任务经理");
  expect(text).toContain("任务：Refine the agent orchestration digest");
  expect(text).toContain("结论：Manager completed the plan and the coder implemented the fix.");
  expect(text).toContain("进展：完成 3，待继续 1");
  expect(text).toContain("当前执行：reviewer QUEUED（model）");
  expect(text).toContain("下一工作项：reviewer");
  expect(text).toContain("人工关注：当前链路存在歧义，建议你确认后继续。");
  expect(text).toContain("提醒：Manager inferred a mixed path from ambiguous wording and recommends operator review.");
  expect(text).toContain("下一步：Review the result and decide the next operator step.");
  expect(text).toContain(
    "详情：https://console.example.com/?view=workbench&taskId=task_delivery_2&runId=runtime_reviewer_queued",
  );
  expect(text).toContain("任务ID：task_delivery_2");
  expect(text).not.toContain("内部工作项进展：");
  expect(text).not.toContain("最近观测：");
  expect(text).not.toContain("内部执行时间线：");
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      deliveries: [
        {
          providerMessageId: "om_reply_message_456",
        },
      ],
    },
  });
});

test("POST /feishu/outbound/deliver separates manager-loop observations from manager and subagent tool timelines in verbose diagnostics", async () => {
  const previousVerboseDiagnostics = process.env.MAGISTER_FEISHU_VERBOSE_INCLUDE_DIAGNOSTICS;
  process.env.MAGISTER_FEISHU_OUTBOUND_STYLE = "verbose";
  process.env.MAGISTER_FEISHU_VERBOSE_INCLUDE_DIAGNOSTICS = "true";

  try {
    const fetchMock = createFeishuFetchMock({
      replyMessageId: "om_reply_manager_loop_visibility_1",
      defaultMessageId: "om_reply_manager_loop_visibility_1",
    });
    const outboundRequests = fetchMock.requests;
    harness.installFetchStub(fetchMock.fetch);

    const bindingRepository = new ConversationBindingRepository();
    const eventRepository = new ExecutionEventRepository();
    const app = buildApp();
    const now = new Date("2026-04-18T03:30:00.000Z");

    await bindingRepository.create({
      id: "feishu:tenant_alpha:oc_chat_manager_loop_visibility",
      channel: "feishu",
      accountId: "tenant_alpha",
      chatId: "oc_chat_manager_loop_visibility",
      workspaceId: "workspace_main",
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
      lastPlatformMessageId: "om_parent_manager_loop_visibility",
    });

    await eventRepository.create({
      id: "event_outbound_queue_manager_loop_visibility_1",
      type: "channel.outbound.queued",
      taskId: "task_delivery_manager_loop_visibility_1",
      conversationBindingId: "feishu:tenant_alpha:oc_chat_manager_loop_visibility",
      workspaceId: "workspace_main",
      severity: "info",
      occurredAt: now,
      payloadJson: JSON.stringify({
        channel: "feishu",
        kind: "task_orchestration_completed",
        bindingId: "feishu:tenant_alpha:oc_chat_manager_loop_visibility",
        taskId: "task_delivery_manager_loop_visibility_1",
        title: "Task completed",
        summary: "Manager validated context before coder execution.",
        taskTitle: "Keep manager loop visibility readable",
        taskState: "COMPLETED",
        latestAnswer: "Manager validated context before coder execution.",
        nextAction: "Review manager observations, then continue coder follow-up.",
        managerPlan: {
          taskType: "coding",
          confidence: "high",
          plannedCapabilities: ["coder"],
          capabilityProgress: [
            {
              roleId: "leader",
              state: "COMPLETED",
              executorId: "model",
              summary: "Manager finished loop decisions.",
            },
            {
              roleId: "coder",
              state: "QUEUED",
              executorId: "codex",
              summary: "Coder is queued for implementation.",
            },
          ],
          completedCapabilities: ["leader"],
          pendingCapabilities: ["coder"],
          blockedCapabilities: [],
          nextCapability: "coder",
        },
        trace: [
          {
            kind: "decision",
            text: "任务经理决定先通过工具验证环境。",
            roleId: "leader",
            source: "task_manager",
            executorId: "model",
            sessionId: "session_manager_trace_1",
            attemptCount: 1,
          },
          {
            kind: "subagent",
            text: "任务经理派生了 coder 这些内部工作项",
            source: "task_manager",
          },
          {
            kind: "tool_call",
            text: "读取 README.md",
            roleId: "leader",
            source: "model",
            executorId: "model",
            sessionId: "session_manager_trace_1",
            attemptCount: 1,
          },
          {
            kind: "tool_result",
            text: "已确认仓库结构。",
            roleId: "leader",
            source: "model",
            executorId: "model",
            sessionId: "session_manager_trace_1",
            attemptCount: 1,
          },
          {
            kind: "tool_call",
            text: "读取 README.md",
            roleId: "coder",
            source: "codex",
            executorId: "codex",
            sessionId: "session_coder_trace_1",
            attemptCount: 2,
          },
          {
            kind: "tool_result",
            text: "已确认仓库结构。",
            roleId: "coder",
            source: "codex",
            executorId: "codex",
            sessionId: "session_coder_trace_1",
            attemptCount: 2,
          },
        ],
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/outbound/deliver",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const deliveryRequest = outboundRequests[1];
    expect(deliveryRequest?.url).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_manager_loop_visibility/reply",
    );
    const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
      content?: string;
      msg_type?: string;
    };
    expect(deliveryBody.msg_type).toBe("text");
    const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
    const text = content.text ?? "";

    expect(text).toContain("最近观测：");
    expect(text).toContain(
      "Leader 观察：Leader 决定先通过工具验证环境。；Leader 派生了 coder 这些内部工作项",
    );
    expect(text).toContain("内部执行时间线：");
    expect(text).toContain(
      "- 工具调用：leader · [model / 第1次 / session_manager_trace_1] 读取 README.md · model",
    );
    expect(text).toContain(
      "- 工具结果：leader · [model / 第1次 / session_manager_trace_1] 已确认仓库结构。 · model",
    );
    expect(text).toContain(
      "- 工具调用：coder · [codex / 第2次 / session_coder_trace_1] 读取 README.md · codex",
    );
    expect(text).toContain(
      "- 工具结果：coder · [codex / 第2次 / session_coder_trace_1] 已确认仓库结构。 · codex",
    );
    expect(text).not.toContain("Leader 观察：读取 README.md");
  } finally {
    if (previousVerboseDiagnostics === undefined) {
      delete process.env.MAGISTER_FEISHU_VERBOSE_INCLUDE_DIAGNOSTICS;
    } else {
      process.env.MAGISTER_FEISHU_VERBOSE_INCLUDE_DIAGNOSTICS = previousVerboseDiagnostics;
    }
  }
});

test("POST /feishu/outbound/deliver renders conversational completions without operator-style next steps", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_message_conversation_1",
    defaultMessageId: "om_reply_message_conversation_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:20:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_conversation",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_conversation",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_conversation",
  });

  await eventRepository.create({
    id: "event_outbound_queue_conversation",
    type: "channel.outbound.queued",
    taskId: "task_delivery_conversation",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_conversation",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_alpha:oc_chat_conversation",
      taskId: "task_delivery_conversation",
      title: "Task completed",
      summary: "当前目录是什么 已得到回复。",
      taskTitle: "当前目录是什么",
      taskState: "COMPLETED",
      latestAnswer: `当前目录是 ${process.cwd()}。`,
      nextAction: "你可以继续追问，或者直接给任务经理一个具体任务。",
      managerPlan: {
        taskType: "conversation",
        confidence: "high",
        plannedCapabilities: [],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "COMPLETED",
            executorId: "system",
            summary: `当前目录是 ${process.cwd()}。`,
          },
        ],
        completedCapabilities: ["leader"],
        pendingCapabilities: [],
        blockedCapabilities: [],
        nextCapability: null,
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_conversation/reply",
  );
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
    msg_type?: string;
  };
  expect(deliveryBody.msg_type).toBe("text");
  const content = JSON.parse(String(deliveryBody.content)) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain(`当前目录是 ${process.cwd()}。`);
  expect(text).toContain("你可以继续追问，或者直接给 Leader 一个具体任务。");
  expect(text).not.toContain("任务：");
  expect(text).not.toContain("结论：");
  expect(text).not.toContain("已完成工作项：");
  expect(text).not.toContain("Review the result and decide the next operator step.");
});

test("POST /feishu/outbound/deliver renders clarifications as a short task-manager follow-up", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_message_clarify_1",
    defaultMessageId: "om_reply_message_clarify_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:25:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_clarify",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_clarify",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_clarify",
  });

  await eventRepository.create({
    id: "event_outbound_queue_clarify",
    type: "channel.outbound.queued",
    taskId: "task_delivery_clarify",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_clarify",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_alpha:oc_chat_clarify",
      taskId: "task_delivery_clarify",
      title: "Task completed",
      summary: "今天天气如何 还缺一条关键信息，我已经直接追问你了。",
      taskTitle: "今天天气如何",
      taskState: "COMPLETED",
      latestAnswer: "要查天气，请告诉我城市，例如“上海今天天气如何”。",
      nextAction: "直接回复我缺失的信息，我会接着继续。",
      managerPlan: {
        taskType: "conversation",
        confidence: "high",
        coordinationAction: "clarify",
        plannedCapabilities: [],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "COMPLETED",
            executorId: "system",
            summary: "要查天气，请告诉我城市，例如“上海今天天气如何”。",
          },
        ],
        completedCapabilities: ["leader"],
        pendingCapabilities: [],
        blockedCapabilities: [],
        nextCapability: null,
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_clarify/reply",
  );
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
    msg_type?: string;
  };
  expect(deliveryBody.msg_type).toBe("text");
  const content = JSON.parse(String(deliveryBody.content)) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("要查天气，请告诉我城市");
  expect(text).toContain("直接回复我缺失的信息，我会接着继续。");
  expect(text).not.toContain("任务：");
  expect(text).not.toContain("结论：");
  expect(text).not.toContain("已完成工作项：");
});

test("POST /feishu/outbound/deliver renders blocked tasks in a compact format", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_message_blocked_1",
    defaultMessageId: "om_reply_message_blocked_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:30:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_blocked",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_blocked",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_blocked",
  });

  await eventRepository.create({
    id: "event_outbound_queue_blocked",
    type: "channel.outbound.queued",
    taskId: "task_delivery_blocked",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_blocked",
    workspaceId: "workspace_main",
    severity: "warn",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_blocked",
      bindingId: "feishu:tenant_alpha:oc_chat_blocked",
      taskId: "task_delivery_blocked",
      title: "Task blocked",
      summary: "你能看到哪些文件呢 blocked during orchestration and needs attention.",
      taskTitle: "你能看到哪些文件呢",
      taskState: "BLOCKED",
      latestAnswer: "Codex exited with code 1 while dispatching the manager run",
      nextAction: "Open the blocked lane in the console and inspect why no next runtime was eligible.",
      managerPlan: {
        taskType: "coding",
        confidence: "high",
        plannedCapabilities: ["leader"],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "FAILED",
            executorId: "codex",
            summary: "Codex exited with code 1 while dispatching the manager run",
          },
        ],
        completedCapabilities: [],
        pendingCapabilities: [],
        blockedCapabilities: ["leader"],
        nextCapability: null,
      },
      trace: [
        {
          kind: "tool_result",
          text: "Codex exited with code 1 while dispatching the manager run",
          roleId: "leader",
          source: "codex",
          executorId: "codex",
          sessionId: "session_manager_blocked_1",
          attemptCount: 1,
        },
      ],
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_blocked/reply",
  );
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content)) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("⚠️ 任务链路已阻塞");
  expect(text).toContain("任务：你能看到哪些文件呢");
  expect(text).toContain("原因：Codex exited with code 1 while dispatching the manager run");
  expect(text).toContain("当前执行：leader FAILED（codex）");
  expect(text).toContain("阻塞工作项：leader");
  expect(text).toContain("处理建议：Open the blocked lane in the console and inspect why no next runtime was eligible.");
  expect(text).toContain("任务ID：task_delivery_blocked");
  expect(text).not.toContain("结论：");
  expect(text).not.toContain("Leader 判断：");
  expect(text).not.toContain("内部工作项进展：");
  expect(text).not.toContain("最近观测：");
});

test("POST /feishu/outbound/deliver defaults to verbose formatting when style is not configured", async () => {
  delete process.env.MAGISTER_FEISHU_OUTBOUND_STYLE;
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_message_default_verbose_1",
    defaultMessageId: "om_reply_message_default_verbose_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T06:40:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_default_verbose",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_default_verbose",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_default_verbose",
  });

  await eventRepository.create({
    id: "event_outbound_queue_default_verbose",
    type: "channel.outbound.queued",
    taskId: "task_delivery_default_verbose",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_default_verbose",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "task_orchestration_completed",
      bindingId: "feishu:tenant_alpha:oc_chat_default_verbose",
      taskId: "task_delivery_default_verbose",
      title: "Task completed",
      summary: "The task finished successfully.",
      taskTitle: "检查默认格式",
      taskState: "COMPLETED",
      latestAnswer: "Manager completed the plan and the coder implemented the fix.",
      nextAction: "Review the result and decide the next operator step.",
      managerPlan: {
        taskType: "mixed",
        confidence: "high",
        plannedCapabilities: ["coder", "reviewer"],
        capabilityProgress: [
          {
            roleId: "leader",
            state: "COMPLETED",
            executorId: "codex",
            summary: "Manager seeded coder and reviewer lanes.",
          },
          {
            roleId: "reviewer",
            state: "QUEUED",
            executorId: "qoder",
            summary: "Reviewer is queued.",
          },
        ],
        completedCapabilities: ["leader", "coder"],
        pendingCapabilities: ["reviewer"],
        blockedCapabilities: [],
        nextCapability: "reviewer",
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content)) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("✅ Leader 已完成这个任务");
  expect(text).toContain("任务：检查默认格式");
  expect(text).toContain("答复：Manager completed the plan and the coder implemented the fix.");
  expect(text).toContain("下一步：Review the result and decide the next operator step.");
  expect(text).toContain("任务ID：task_delivery_default_verbose");
  expect(text).not.toContain("置信度");
  expect(text).not.toContain("Leader 判断：");
  expect(text).not.toContain("内部工作项进展：");
  expect(text).not.toContain("最近观测：");
});

test("POST /feishu/outbound/deliver renders runtime_trace payloads with expanded details for full verbose sessions", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_full_1",
    defaultMessageId: "om_reply_runtime_trace_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T06:30:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_full",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_full",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_full",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_full",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_full",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_full",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_full",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_full",
      taskId: "task_runtime_trace_full",
      sourceEventId: "event_manager_decision_runtime_trace_full",
      eventType: "manager.decision",
      summary: "任务经理决策：coding / bounded_execution / spawn_work_items",
      roleId: "leader",
      executorId: "model",
      sessionId: "session_manager_runtime_trace_full",
      attemptCount: 1,
      details: {
        taskType: "coding",
        executionMode: "bounded_execution",
        decision: "spawn_work_items",
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  expect(deliveryRequest?.url).toBe(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_runtime_trace_full/reply",
  );
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body)) as {
    content?: string;
    msg_type?: string;
  };
  expect(deliveryBody.msg_type).toBe("text");
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("Leader 决策：coding / bounded_execution / spawn_work_items");
  expect(text).toContain("任务类型：coding");
  expect(text).toContain("执行模式：bounded_execution");
  expect(text).toContain("决策：spawn_work_items");
});

test("POST /feishu/outbound/deliver renders tool runtime_trace payloads with arguments and results in full verbose mode", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_tool_full_1",
    defaultMessageId: "om_reply_runtime_trace_tool_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T06:40:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_full",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_tool_full",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_tool_full",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_full",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_tool_full",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_tool_full",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_full",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_full",
      taskId: "task_runtime_trace_tool_full",
      sourceEventId: "event_tool_call_runtime_trace_tool_full",
      eventType: "tool.call",
      summary: "工具调用：read_file",
      details: {
        toolName: "read_file",
        arguments: {
          path: "apps/api/src/services/create-task-service.ts",
        },
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("工具调用：read_file");
  expect(text).toContain("工具：read_file");
  expect(text).toContain("参数：");
  expect(text).toContain("create-task-service.ts");
});

test("POST /feishu/outbound/deliver renders manager tool runtime_trace payloads as task-manager steps", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_manager_tool_full_1",
    defaultMessageId: "om_reply_runtime_trace_manager_tool_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-18T10:20:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_manager_tool_full",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_manager_tool_full",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_manager_tool_full",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_manager_tool_full",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_manager_tool_full",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_manager_tool_full",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_manager_tool_full",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_manager_tool_full",
      taskId: "task_runtime_trace_manager_tool_full",
      sourceEventId: "event_manager_tool_call_runtime_trace_manager_tool_full",
      eventType: "tool.call",
      summary: "工具调用：time_now",
      roleId: "leader",
      executorId: "model",
      sessionId: "session_manager_loop_1",
      attemptCount: 1,
      details: {
        toolName: "time_now",
        arguments: {},
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("工具调用：time_now");
  expect(text).toContain("执行者：Leader（model）");
  expect(text).toContain("会话：session_manager_loop_1");
});

test("POST /feishu/outbound/deliver renders tool runtime_trace payloads with compact arguments in verbose on mode", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_tool_on_1",
    defaultMessageId: "om_reply_runtime_trace_tool_on_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T06:45:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_on",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_tool_on",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_tool_on",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_on",
    continuityMode: "reply_preferred",
    verboseLevel: "on",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_tool_on",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_tool_on",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_on",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_on",
      taskId: "task_runtime_trace_tool_on",
      sourceEventId: "event_tool_call_runtime_trace_tool_on",
      eventType: "tool.call",
      summary: "工具调用：tavily_web_search",
      details: {
        toolName: "tavily_web_search",
        arguments: {
          query: "搜索一下最近的 ai 新闻",
          topic: "news",
        },
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("工具调用：tavily_web_search");
  expect(text).toContain("工具：tavily_web_search");
  expect(text).toContain("参数：");
  expect(text).toContain("搜索一下最近的 ai 新闻");
  expect(text).toContain("\"topic\":\"news\"");
});

test("POST /feishu/outbound/deliver keeps information-shortcut direct decisions compact in verbose on mode", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_info_direct_on_1",
    defaultMessageId: "om_reply_runtime_trace_info_direct_on_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T06:50:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_info_direct_on",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_info_direct_on",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_info_direct_on",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_direct_on",
    continuityMode: "reply_preferred",
    verboseLevel: "on",
    now,
  });

  const decisionSummary = "任务经理决策：conversation / immediate / direct_answer";
  const renderedDecisionSummary = "Leader 决策：conversation / immediate / direct_answer";

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_info_direct_on",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_info_direct_on",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_direct_on",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_direct_on",
      taskId: "task_runtime_trace_info_direct_on",
      sourceEventId: "event_manager_decision_runtime_trace_info_direct_on",
      eventType: "manager.decision",
      summary: decisionSummary,
      details: {
        taskType: "conversation",
        executionMode: "immediate",
        decision: "direct_answer",
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toBe(renderedDecisionSummary);
  expect(text).not.toContain("任务类型：");
  expect(text).not.toContain("执行模式：");
  expect(text).not.toContain("\n决策：");
});

test("POST /feishu/outbound/deliver renders information-shortcut tool decisions with full detail expansion", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_info_tool_full_1",
    defaultMessageId: "om_reply_runtime_trace_info_tool_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T06:55:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_info_tool_full",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_info_tool_full",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_info_tool_full",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_tool_full",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_info_tool_full",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_info_tool_full",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_tool_full",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_info_tool_full",
      taskId: "task_runtime_trace_info_tool_full",
      sourceEventId: "event_manager_decision_runtime_trace_info_tool_full",
      eventType: "manager.decision",
      summary: "任务经理决策：conversation / immediate / tool_answer",
      details: {
        taskType: "conversation",
        executionMode: "immediate",
        decision: "tool_answer",
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("Leader 决策：conversation / immediate / tool_answer");
  expect(text).toContain("任务类型：conversation");
  expect(text).toContain("执行模式：immediate");
  expect(text).toContain("决策：tool_answer");
  expect(text).not.toContain("决策：direct_answer");
});

test("POST /feishu/outbound/deliver renders tool result runtime_trace payloads with result summaries in full verbose mode", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_tool_result_full_1",
    defaultMessageId: "om_reply_runtime_trace_tool_result_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T07:00:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_full",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_tool_result_full",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_tool_result_full",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_full",
    continuityMode: "reply_preferred",
    verboseLevel: "full",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_tool_result_full",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_tool_result_full",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_full",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_full",
      taskId: "task_runtime_trace_tool_result_full",
      sourceEventId: "event_tool_result_runtime_trace_tool_result_full",
      eventType: "tool.result",
      summary: "工具结果：tavily_web_search",
      details: {
        toolName: "tavily_web_search",
        result: {
          documents: [{ title: "unused details" }],
        },
        resultSummary: "命中 2 条网页，已提炼为一条直接答复。",
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("工具结果：tavily_web_search");
  expect(text).toContain("工具：tavily_web_search");
  expect(text).toContain("结果摘要：命中 2 条网页，已提炼为一条直接答复。");
  expect(text).not.toContain("\"documents\"");
});

test("POST /feishu/outbound/deliver renders compact tool result payloads in verbose on mode when no summary is provided", async () => {
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_runtime_trace_tool_result_on_1",
    defaultMessageId: "om_reply_runtime_trace_tool_result_on_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const bindingRepository = new ConversationBindingRepository();
  const eventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-17T07:05:00.000Z");

  await bindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_on",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_runtime_trace_tool_result_on",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
    lastPlatformMessageId: "om_parent_runtime_trace_tool_result_on",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_on",
    continuityMode: "reply_preferred",
    verboseLevel: "on",
    now,
  });

  await eventRepository.create({
    id: "event_outbound_queue_runtime_trace_tool_result_on",
    type: "channel.outbound.queued",
    taskId: "task_runtime_trace_tool_result_on",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_on",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "runtime_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_runtime_trace_tool_result_on",
      taskId: "task_runtime_trace_tool_result_on",
      sourceEventId: "event_tool_result_runtime_trace_tool_result_on",
      eventType: "tool.result",
      summary: "工具结果：read_file",
      details: {
        toolName: "read_file",
        result: {
          file: "README.md",
          lineCount: 42,
        },
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/feishu/outbound/deliver",
    payload: {},
  });

  expect(response.statusCode).toBe(200);
  const deliveryRequest = outboundRequests[1];
  const deliveryBody = JSON.parse(String(deliveryRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const content = JSON.parse(String(deliveryBody.content ?? "{}")) as { text?: string };
  const text = content.text ?? "";
  expect(text).toContain("工具结果：read_file");
  expect(text).toContain("工具：read_file");
  expect(text).toContain("结果：");
  expect(text).toContain("README.md");
  expect(text).toContain("\"lineCount\":42");
  expect(text).not.toContain("结果摘要：");
});
