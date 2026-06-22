import { afterEach, beforeEach, expect, test } from "bun:test";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { queueFeishuOrchestrationSummary } from "../../src/services/queue-feishu-outbound-summary-service";
import { createFeishuTestHarness, type FeishuTestHarness } from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "queue-feishu-outbound-summary-db",
  });
});

afterEach(() => {
  harness.cleanup();
});

test("queueFeishuOrchestrationSummary includes manager plan progress for queued Feishu reports", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T09:40:00.000Z");

  await taskRepository.create({
    id: "task_queue_manager_plan_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "Fix the login redirect bug",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_plan",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_plan_1",
    taskId: "task_queue_manager_plan_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_queue_plan_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_queue_plan_1",
    taskId: "task_queue_manager_plan_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_queue_plan_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_followups_queue_plan_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_manager_plan_1",
    roleRuntimeId: "runtime_manager_queue_plan_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned coder follow-up lanes",
      planningMode: "heuristic",
      taskType: "coding",
      confidence: "high",
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_coder_completed_queue_plan_1",
    type: "executor_session.completed",
    taskId: "task_queue_manager_plan_1",
    roleRuntimeId: "runtime_coder_queue_plan_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Coder finished the implementation.",
      summary: "Implemented the redirect fix and updated the login guard.",
      lastMessagePreview: "Implemented the redirect fix and updated the login guard.",
    }),
  });

  await executionEventRepository.create({
    id: "event_coder_tool_call_queue_plan_1",
    type: "tool.call",
    taskId: "task_queue_manager_plan_1",
    roleRuntimeId: "runtime_coder_queue_plan_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T09:40:10.000Z"),
    payloadJson: JSON.stringify({
      message: "Ran tests for the login redirect fix.",
      source: "bun_test",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_plan",
    workspaceId: "workspace_main",
    taskId: "task_queue_manager_plan_1",
    taskTitle: "Fix the login redirect bug",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "coder",
  });

  expect(queued.payload).toMatchObject({
    channel: "feishu",
    kind: "task_orchestration_completed",
    taskId: "task_queue_manager_plan_1",
    taskState: "COMPLETED",
    latestAnswer: "Implemented the redirect fix and updated the login guard.",
    managerPlan: {
      taskType: "coding",
      confidence: "high",
      plannedCapabilities: ["coder"],
      completedCapabilities: ["leader", "coder"],
      nextCapability: null,
    },
  });
  expect(queued.payload.trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "subagent",
        text: "Leader 派生了 coder 这些内部工作项",
      }),
      expect.objectContaining({
        kind: "tool_result",
        text: "Implemented the redirect fix and updated the login guard.",
      }),
      expect.objectContaining({
        kind: "tool_call",
        roleId: "coder",
        text: "Ran tests for the login redirect fix.",
        source: "bun_test",
        executorId: "codex",
        sessionId: "session_coder_queue_plan_1",
        attemptCount: 1,
      }),
    ]),
  );
});

test("queueFeishuOrchestrationSummary keeps manager tool steps distinct from delegated traces when messages overlap", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-18T03:05:00.000Z");

  await taskRepository.create({
    id: "task_queue_manager_tool_visibility_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "Trace manager loop visibility",
    state: "BLOCKED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_manager_tool_visibility",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_tool_visibility_1",
    taskId: "task_queue_manager_tool_visibility_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "model",
    currentSessionId: "session_manager_tool_visibility_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-18T03:05:20.000Z"),
    completedAt: new Date("2026-04-18T03:05:20.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_tool_visibility_1",
    taskId: "task_queue_manager_tool_visibility_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_tool_visibility_1",
    attemptCount: 2,
    startedAt: now,
    updatedAt: new Date("2026-04-18T03:05:30.000Z"),
    completedAt: new Date("2026-04-18T03:05:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_manager_plan_tool_visibility_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_manager_tool_visibility_1",
    roleRuntimeId: "runtime_manager_tool_visibility_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager delegated coder follow-up work",
      taskType: "coding",
      confidence: "high",
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_tool_call_tool_visibility_1",
    type: "tool.call",
    taskId: "task_queue_manager_tool_visibility_1",
    roleRuntimeId: "runtime_manager_tool_visibility_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-18T03:05:10.000Z"),
    payloadJson: JSON.stringify({
      message: "读取 README.md",
      source: "model",
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_tool_result_tool_visibility_1",
    type: "tool.result",
    taskId: "task_queue_manager_tool_visibility_1",
    roleRuntimeId: "runtime_manager_tool_visibility_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-18T03:05:20.000Z"),
    payloadJson: JSON.stringify({
      message: "已确认仓库结构。",
      source: "model",
    }),
  });

  await executionEventRepository.create({
    id: "event_coder_tool_result_tool_visibility_1",
    type: "tool.result",
    taskId: "task_queue_manager_tool_visibility_1",
    roleRuntimeId: "runtime_coder_tool_visibility_1",
    workspaceId: "workspace_main",
    severity: "error",
    occurredAt: new Date("2026-04-18T03:05:30.000Z"),
    payloadJson: JSON.stringify({
      message: "已确认仓库结构。",
      source: "codex",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_manager_tool_visibility",
    workspaceId: "workspace_main",
    taskId: "task_queue_manager_tool_visibility_1",
    taskTitle: "Trace manager loop visibility",
    taskState: "BLOCKED",
    stopReason: "dispatch_failed",
    roleId: "leader",
  });

  expect(queued.payload.trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "subagent",
        text: "Leader 派生了 coder 这些内部工作项",
        source: "task_manager",
        roleId: "leader",
        executorId: "model",
        sessionId: "session_manager_tool_visibility_1",
        attemptCount: 1,
      }),
      expect.objectContaining({
        kind: "tool_call",
        text: "读取 README.md",
        source: "model",
        roleId: "leader",
        executorId: "model",
        sessionId: "session_manager_tool_visibility_1",
        attemptCount: 1,
      }),
      expect.objectContaining({
        kind: "tool_result",
        text: "已确认仓库结构。",
        source: "model",
        roleId: "leader",
        executorId: "model",
        sessionId: "session_manager_tool_visibility_1",
        attemptCount: 1,
      }),
      expect.objectContaining({
        kind: "tool_result",
        text: "已确认仓库结构。",
        source: "codex",
        roleId: "coder",
        executorId: "codex",
        sessionId: "session_coder_tool_visibility_1",
        attemptCount: 2,
      }),
    ]),
  );

  const overlappingResultEntries =
    queued.payload.trace?.filter((item) => item.kind === "tool_result" && item.text === "已确认仓库结构。") ?? [];
  expect(overlappingResultEntries).toHaveLength(2);
  expect(overlappingResultEntries.map((item) => item.roleId).sort()).toEqual(["coder", "leader"]);
});

test("queueFeishuOrchestrationSummary prefers grounded manager answers for local workspace facts", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-18T18:40:00.000Z");

  await taskRepository.create({
    id: "task_queue_grounded_workspace_answer_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "当前工作目录是啥",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_grounded_workspace_answer",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_grounded_workspace_answer_1",
    taskId: "task_queue_grounded_workspace_answer_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "model",
    currentSessionId: "session_manager_queue_grounded_workspace_answer_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_grounded_workspace_answer_1",
    type: "executor_session.completed",
    taskId: "task_queue_grounded_workspace_answer_1",
    roleRuntimeId: "runtime_manager_queue_grounded_workspace_answer_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-18T18:40:05.000Z"),
    payloadJson: JSON.stringify({
      message:
        '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"当前工作目录（current working directory）是 /app。","confidence":"high","childWorkItems":[],"waitingFor":[],"nextWakeupAt":null,"warnings":[]}',
      lastMessage:
        '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"当前工作目录（current working directory）是 /app。","confidence":"high","childWorkItems":[],"waitingFor":[],"nextWakeupAt":null,"warnings":[]}',
      source: "model",
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_tool_result_queue_grounded_workspace_answer_1",
    type: "tool.result",
    taskId: "task_queue_grounded_workspace_answer_1",
    roleRuntimeId: "runtime_manager_queue_grounded_workspace_answer_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-18T18:40:04.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool result: bash",
      toolName: "bash",
      result: {
        exitCode: 0,
        stdout: "/opt/acme/magister",
        stderr: "",
      },
      resultSummary: "bash exit 0",
      source: "model",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_grounded_workspace_answer",
    workspaceId: "workspace_main",
    taskId: "task_queue_grounded_workspace_answer_1",
    taskTitle: "当前工作目录是啥",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(queued.payload.latestAnswer).toContain("/opt/acme/magister");
});

test("queueFeishuOrchestrationSummary uses conversational follow-up wording for direct answers", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T09:42:00.000Z");

  await taskRepository.create({
    id: "task_queue_conversation_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "当前目录是什么",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_conversation",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_conversation_1",
    taskId: "task_queue_conversation_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "system",
    currentSessionId: null,
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_conversation_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_conversation_1",
    roleRuntimeId: "runtime_manager_queue_conversation_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "任务经理直接回答了当前目录问题",
      planningMode: "conversational_shortcut",
      decisionMode: "direct_answer",
      taskType: "conversation",
      confidence: "high",
      source: "task_manager_direct_answer",
      childRuns: [],
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_tool_call_queue_conversation_1",
    type: "tool.call",
    taskId: "task_queue_conversation_1",
    roleRuntimeId: "runtime_manager_queue_conversation_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T09:42:10.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool call: bash",
      toolName: "bash",
      arguments: {
        command: "pwd",
      },
      source: "model",
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_tool_result_queue_conversation_1",
    type: "tool.result",
    taskId: "task_queue_conversation_1",
    roleRuntimeId: "runtime_manager_queue_conversation_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T09:42:20.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool result: bash",
      toolName: "bash",
      resultSummary: "bash exit 0",
      source: "model",
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_conversation_1",
    type: "executor_session.completed",
    taskId: "task_queue_conversation_1",
    roleRuntimeId: "runtime_manager_queue_conversation_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      summary: `当前目录是 ${process.cwd()}。`,
      lastMessagePreview: `当前目录是 ${process.cwd()}。`,
      source: "task_manager_direct_answer",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_conversation",
    workspaceId: "workspace_main",
    taskId: "task_queue_conversation_1",
    taskTitle: "当前目录是什么",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(queued.payload.summary).toBe("当前目录是什么 已得到回复。");
  expect(queued.payload.nextAction).toBe("你可以继续追问，或者直接给 Leader 一个具体任务。");
  expect(queued.payload.managerPlan).toMatchObject({
    taskType: "conversation",
    coordinationAction: "direct_answer",
    plannedCapabilities: [],
    completedCapabilities: ["leader"],
    nextCapability: null,
  });
  expect(queued.payload.trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool_call",
        roleId: "leader",
        text: "Manager tool call: bash",
      }),
      expect.objectContaining({
        kind: "tool_result",
        roleId: "leader",
        text: "Manager tool result: bash",
      }),
    ]),
  );
  expect((queued.payload.trace ?? []).some((item) => item.kind === "subagent")).toBe(false);
});

test("queueFeishuOrchestrationSummary uses clarification wording when task manager needs more input", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T09:44:00.000Z");

  await taskRepository.create({
    id: "task_queue_conversation_clarify_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "今天天气如何",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_conversation_clarify",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_conversation_clarify_1",
    taskId: "task_queue_conversation_clarify_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "system",
    currentSessionId: null,
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_conversation_clarify_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_conversation_clarify_1",
    roleRuntimeId: "runtime_manager_queue_conversation_clarify_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "任务经理需要先确认天气查询的城市",
      planningMode: "information_shortcut",
      decisionMode: "clarify",
      coordinationAction: "clarify",
      taskType: "conversation",
      confidence: "high",
      source: "task_manager_clarification",
      childRuns: [],
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_conversation_clarify_1",
    type: "executor_session.completed",
    taskId: "task_queue_conversation_clarify_1",
    roleRuntimeId: "runtime_manager_queue_conversation_clarify_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      summary: "要查天气，请告诉我城市，例如“上海今天天气如何”。",
      lastMessagePreview: "要查天气，请告诉我城市，例如“上海今天天气如何”。",
      source: "task_manager_clarification",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_conversation_clarify",
    workspaceId: "workspace_main",
    taskId: "task_queue_conversation_clarify_1",
    taskTitle: "今天天气如何",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(queued.payload.summary).toBe("今天天气如何 还缺一条关键信息，我已经直接追问你了。");
  expect(queued.payload.nextAction).toBe("直接回复我缺失的信息，我会接着继续。");
  expect(queued.payload.managerPlan).toMatchObject({
    taskType: "conversation",
    coordinationAction: "clarify",
  });
});

test("queueFeishuOrchestrationSummary does not advertise stale historical roles outside the persisted manager plan", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T09:45:00.000Z");

  await taskRepository.create({
    id: "task_queue_manager_plan_2",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "Fix the login redirect bug",
    state: "BLOCKED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_plan_2",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_plan_2",
    taskId: "task_queue_manager_plan_2",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_queue_plan_2",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_queue_plan_2",
    taskId: "task_queue_manager_plan_2",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_queue_plan_2",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_reviewer_queue_plan_2",
    taskId: "task_queue_manager_plan_2",
    roleId: "reviewer",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    currentSessionId: "session_reviewer_queue_plan_2",
    attemptCount: 1,
    startedAt: new Date("2026-04-11T09:40:00.000Z"),
    updatedAt: new Date("2026-04-11T09:40:30.000Z"),
    completedAt: new Date("2026-04-11T09:40:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_plan_2",
    type: "task.manager.plan_created",
    taskId: "task_queue_manager_plan_2",
    roleRuntimeId: "runtime_manager_queue_plan_2",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned only coder",
      taskType: "coding",
      confidence: "low",
      needsHuman: true,
      warnings: ["Heuristic planner ignored incidental review wording and kept the narrower coding path."],
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_plan_2",
    workspaceId: "workspace_main",
    taskId: "task_queue_manager_plan_2",
    taskTitle: "Fix the login redirect bug",
    taskState: "BLOCKED",
    stopReason: "dispatch_failed",
    roleId: "coder",
  });

  expect(queued.payload).toMatchObject({
    managerPlan: {
      taskType: "coding",
      confidence: "low",
      needsHuman: true,
      warnings: ["Heuristic planner ignored incidental review wording and kept the narrower coding path."],
      plannedCapabilities: ["coder"],
      completedCapabilities: ["leader", "coder"],
      blockedCapabilities: [],
    },
    roleProgress: [
      expect.objectContaining({ roleId: "leader" }),
      expect.objectContaining({ roleId: "coder" }),
    ],
  });
  expect(queued.payload.roleProgress?.map((item) => item.roleId)).not.toContain("reviewer");
});

test("queueFeishuOrchestrationSummary extracts the outcome section from structured executor notes", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T09:48:00.000Z");

  await taskRepository.create({
    id: "task_queue_structured_note_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "简单介绍一下这个代码库呢",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_structured_note",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_structured_note_1",
    taskId: "task_queue_structured_note_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_structured_note_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_plan_structured_note_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_structured_note_1",
    roleRuntimeId: "runtime_manager_structured_note_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned coder follow-up lanes",
      planningMode: "heuristic",
      taskType: "coding",
      confidence: "high",
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_structured_note_1",
    taskId: "task_queue_structured_note_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_structured_note_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_coder_completed_structured_note_1",
    type: "executor_session.completed",
    taskId: "task_queue_structured_note_1",
    roleRuntimeId: "runtime_coder_structured_note_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T09:48:10.000Z"),
    payloadJson: JSON.stringify({
      summary:
        "Objective 简要介绍代码库。 Actions 查看目录与文档。 Outcome 这是一个多 Agent 编排平台，核心是任务管理、执行器路由和飞书集成。",
      lastMessagePreview:
        "Objective 简要介绍代码库。 Actions 查看目录与文档。 Outcome 这是一个多 Agent 编排平台，核心是任务管理、执行器路由和飞书集成。",
      source: "codex",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_structured_note",
    workspaceId: "workspace_main",
    taskId: "task_queue_structured_note_1",
    taskTitle: "简单介绍一下这个代码库呢",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "coder",
  });

  expect(queued.payload.latestAnswer).toBe(
    "这是一个多 Agent 编排平台，核心是任务管理、执行器路由和飞书集成。",
  );
  expect(queued.payload.roleProgress).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "coder",
        summary: "这是一个多 Agent 编排平台，核心是任务管理、执行器路由和飞书集成。",
      }),
    ]),
  );
});

test("queueFeishuOrchestrationSummary is idempotent for the same task and stop reason", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T10:10:00.000Z");

  await taskRepository.create({
    id: "task_queue_idempotent_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "总结当前架构",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_idempotent",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_idempotent_1",
    taskId: "task_queue_idempotent_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_queue_idempotent_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_idempotent_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_idempotent_1",
    roleRuntimeId: "runtime_manager_queue_idempotent_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      taskType: "conversation",
      confidence: "high",
      source: "manager_completed",
      childRuns: [],
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_idempotent_1",
    type: "executor_session.completed",
    taskId: "task_queue_idempotent_1",
    roleRuntimeId: "runtime_manager_queue_idempotent_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      lastMessage: "这是完整回复",
      source: "codex",
    }),
  });

  const first = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_idempotent",
    workspaceId: "workspace_main",
    taskId: "task_queue_idempotent_1",
    taskTitle: "总结当前架构",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });
  const second = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_idempotent",
    workspaceId: "workspace_main",
    taskId: "task_queue_idempotent_1",
    taskTitle: "总结当前架构",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(second.eventId).toBe(first.eventId);

  const queuedEvents = (await executionEventRepository.listByTaskId("task_queue_idempotent_1")).filter(
    (event) => event.type === "channel.outbound.queued",
  );
  expect(queuedEvents).toHaveLength(1);
});

test("queueFeishuOrchestrationSummary maps run lifecycle events into the trace", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T10:15:00.000Z");

  await taskRepository.create({
    id: "task_queue_run_trace_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "Inspect run lifecycle events",
    state: "BLOCKED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_run_trace",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_run_trace_1",
    taskId: "task_queue_run_trace_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_queue_run_trace_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_queue_run_trace_1",
    taskId: "task_queue_run_trace_1",
    roleId: "coder",
    state: "RUNNING",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_queue_run_trace_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T10:15:10.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_reviewer_queue_run_trace_1",
    taskId: "task_queue_run_trace_1",
    roleId: "reviewer",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_reviewer_queue_run_trace_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T10:15:20.000Z"),
    completedAt: new Date("2026-04-11T10:15:20.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_lander_queue_run_trace_1",
    taskId: "task_queue_run_trace_1",
    roleId: "lander",
    state: "BLOCKED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_lander_queue_run_trace_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T10:15:30.000Z"),
    completedAt: new Date("2026-04-11T10:15:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_coder_run_started_queue_run_trace_1",
    type: "run.started",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_coder_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:15:11.000Z"),
    payloadJson: JSON.stringify({
      message: "Coder run started on the active lane.",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_coder_run_progressed_queue_run_trace_1",
    type: "run.progressed",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_coder_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:15:12.000Z"),
    payloadJson: JSON.stringify({
      message: "Coder is still working through the workspace diff.",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_reviewer_run_message_queue_run_trace_1",
    type: "run.message",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_reviewer_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:15:21.000Z"),
    payloadJson: JSON.stringify({
      message: "Reviewer notes the patch is ready for final verification.",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_reviewer_run_completed_queue_run_trace_1",
    type: "run.completed",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_reviewer_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:15:22.000Z"),
    payloadJson: JSON.stringify({
      message: "Reviewer completed the run without further changes.",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_lander_run_failed_queue_run_trace_1",
    type: "run.failed",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_lander_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "error",
    occurredAt: new Date("2026-04-11T10:15:31.000Z"),
    payloadJson: JSON.stringify({
      message: "Lander failed while preparing the final handoff.",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_lander_run_blocked_queue_run_trace_1",
    type: "run.blocked",
    taskId: "task_queue_run_trace_1",
    roleRuntimeId: "runtime_lander_queue_run_trace_1",
    workspaceId: "workspace_main",
    severity: "warn",
    occurredAt: new Date("2026-04-11T10:15:32.000Z"),
    payloadJson: JSON.stringify({
      message: "Lander is blocked because the final review artifact is missing.",
      blockedReason: "missing_review_artifact",
      nextCapability: "reviewer",
      source: "codex",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_run_trace",
    workspaceId: "workspace_main",
    taskId: "task_queue_run_trace_1",
    taskTitle: "Inspect run lifecycle events",
    taskState: "BLOCKED",
    stopReason: "no_eligible_runtime",
    roleId: "leader",
  });

  expect(queued.payload.trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool_call",
        text: "Coder run started on the active lane.",
        roleId: "coder",
        source: "codex",
      }),
      expect.objectContaining({
        kind: "message",
        text: "Coder is still working through the workspace diff.",
        roleId: "coder",
        source: "codex",
      }),
      expect.objectContaining({
        kind: "message",
        text: "Reviewer notes the patch is ready for final verification.",
        roleId: "reviewer",
        source: "codex",
      }),
      expect.objectContaining({
        kind: "tool_result",
        text: "Reviewer completed the run without further changes.",
        roleId: "reviewer",
        source: "codex",
      }),
      expect.objectContaining({
        kind: "tool_result",
        text: "Lander failed while preparing the final handoff.",
        roleId: "lander",
        source: "codex",
      }),
      expect.objectContaining({
        kind: "decision",
        text: "Lander is blocked because the final review artifact is missing.",
        roleId: "lander",
        source: "codex",
      }),
    ]),
  );
});

test("queueFeishuOrchestrationSummary prefers full non-manager lastMessage as latest answer", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T10:20:00.000Z");

  await taskRepository.create({
    id: "task_queue_latest_answer_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "当前代码仓库用的啥语言",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_latest_answer",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_latest_answer_1",
    taskId: "task_queue_latest_answer_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_manager_queue_latest_answer_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T10:20:20.000Z"),
    completedAt: new Date("2026-04-11T10:20:20.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_coder_queue_latest_answer_1",
    taskId: "task_queue_latest_answer_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_coder_queue_latest_answer_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T10:20:10.000Z"),
    completedAt: new Date("2026-04-11T10:20:10.000Z"),
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_latest_answer_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_latest_answer_1",
    roleRuntimeId: "runtime_manager_queue_latest_answer_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      taskType: "coding",
      confidence: "high",
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_coder_completed_queue_latest_answer_1",
    type: "executor_session.completed",
    taskId: "task_queue_latest_answer_1",
    roleRuntimeId: "runtime_coder_queue_latest_answer_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:20:10.000Z"),
    payloadJson: JSON.stringify({
      lastMessage:
        "Objective 判断语言。 Actions 扫描仓库。 Outcome 主要语言是 TypeScript，前端还有少量 TSX。",
      message: "Objective ... Outcome ...",
      source: "codex",
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_latest_answer_1",
    type: "executor_session.completed",
    taskId: "task_queue_latest_answer_1",
    roleRuntimeId: "runtime_manager_queue_latest_answer_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T10:20:20.000Z"),
    payloadJson: JSON.stringify({
      message: "当前代码仓库用的啥语言 completed orchestration and is now ready for the next operator step.",
      source: "codex",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_latest_answer",
    workspaceId: "workspace_main",
    taskId: "task_queue_latest_answer_1",
    taskTitle: "当前代码仓库用的啥语言",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(queued.payload.latestAnswer).toBe("主要语言是 TypeScript，前端还有少量 TSX。");
});

test("queueFeishuOrchestrationSummary extracts manager reply from structured JSON instead of leaking the raw decision object", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-18T02:20:00.000Z");

  await taskRepository.create({
    id: "task_queue_manager_structured_reply_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "解释一下当前项目的前端",
    state: "COMPLETED",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_manager_structured_reply",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_manager_queue_structured_reply_1",
    taskId: "task_queue_manager_structured_reply_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "model",
    currentSessionId: "session_manager_queue_structured_reply_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_manager_plan_queue_structured_reply_1",
    type: "task.manager.plan_created",
    taskId: "task_queue_manager_structured_reply_1",
    roleRuntimeId: "runtime_manager_queue_structured_reply_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      taskType: "conversation",
      confidence: "low",
      decisionMode: "clarify",
      coordinationAction: "clarify",
      planningMode: "explicit_hints",
      source: "conversational_shortcut",
      childRuns: [],
    }),
  });

  await executionEventRepository.create({
    id: "event_manager_completed_queue_structured_reply_1",
    type: "executor_session.completed",
    taskId: "task_queue_manager_structured_reply_1",
    roleRuntimeId: "runtime_manager_queue_structured_reply_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-18T02:20:30.000Z"),
    payloadJson: JSON.stringify({
      lastMessage: JSON.stringify({
        taskType: "clarify",
        executionMode: "immediate",
        decision: "ask_user",
        reply: "我需要先了解项目范围，然后再解释前端结构。",
        confidence: 0.3,
        childWorkItems: null,
        waitingFor: null,
        nextWakeupAt: null,
        warnings: ["需要先读取运行时合约确认项目结构"],
      }),
      source: "model",
    }),
  });

  const queued = await queueFeishuOrchestrationSummary({
    bindingId: "feishu:tenant_alpha:oc_chat_manager_structured_reply",
    workspaceId: "workspace_main",
    taskId: "task_queue_manager_structured_reply_1",
    taskTitle: "解释一下当前项目的前端",
    taskState: "COMPLETED",
    stopReason: "task_completed",
    roleId: "leader",
  });

  expect(queued.payload.latestAnswer).toBe("我需要先了解项目范围，然后再解释前端结构。");
  expect(queued.payload.latestAnswer).not.toContain("\"taskType\"");
  expect(queued.payload.latestAnswer).not.toContain("\"confidence\"");
});
