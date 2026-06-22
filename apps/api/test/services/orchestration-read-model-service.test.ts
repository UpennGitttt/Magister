import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { getTaskOrchestrationReadModel } from "../../src/services/orchestration-read-model-service";

const tempRoot = join(process.cwd(), ".tmp-orchestration-read-model-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `orchestration-read-model-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("getTaskOrchestrationReadModel returns manager plan, role progress, latest answer, and next capability", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T12:00:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Implement orchestration read model",
    description: "Implement orchestration read model",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_manager",
    taskId: "task_orchestration_read_model_1",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_coder",
    taskId: "task_orchestration_read_model_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_coder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T12:01:00.000Z"),
    completedAt: new Date("2026-04-11T12:01:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_reviewer",
    taskId: "task_orchestration_read_model_1",
    roleId: "reviewer",
    state: "QUEUED",
    delegationMode: "delegate_with_context",
    attemptCount: 0,
    updatedAt: new Date("2026-04-11T12:02:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_orm_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_read_model_1",
    roleRuntimeId: "runtime_orm_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder, reviewer",
      planningMode: "heuristic",
      taskType: "mixed",
      goal: "Implement orchestration read model",
      needsHuman: false,
      stopCondition: "review_ready",
      source: "manager_completed",
      childRuns: [
        {
          subagentType: "coder",
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          goal: "Implement the requested change and produce a usable coding result.",
          whyThisInvocation: "Implementation is the next blocking step.",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "The planned change is implemented.",
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
        {
          subagentType: "reviewer",
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          goal: "Review the produced work and decide whether changes are still required.",
          whyThisInvocation: "Review is required after implementation finishes.",
          whyThisWorkItem: "Review is required after implementation finishes.",
          completionSignal: "A review outcome is recorded for the operator.",
          primaryAdapterId: "qoder",
          routingStrategy: "fallback_model",
          fallbackAdapterId: "model",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_orm_coder_completed",
    type: "executor_session.completed",
    taskId: "task_orchestration_read_model_1",
    roleRuntimeId: "runtime_orm_coder",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T12:01:10.000Z"),
    payloadJson: JSON.stringify({
      summary: "Implemented the shared orchestration view.",
      lastMessagePreview: "Implemented the shared orchestration view.",
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_1");

  expect(readModel.leaderPlan).toEqual(readModel.managerPlan);
  expect(readModel.managerPlan).toMatchObject({
    planningMode: "heuristic",
    taskType: "mixed",
    source: "manager_completed",
    goal: "Implement orchestration read model",
    needsHuman: false,
    stopCondition: "review_ready",
    childRuns: [
      expect.objectContaining({
        subagentType: "coder",
        roleId: "coder",
        state: "CREATED",
        dependsOn: [],
        goal: "Implement the requested change and produce a usable coding result.",
        whyThisInvocation: "Implementation is the next blocking step.",
        whyThisWorkItem: "Implementation is the next blocking step.",
        completionSignal: "The planned change is implemented.",
      }),
      expect.objectContaining({
        subagentType: "reviewer",
        roleId: "reviewer",
        state: "QUEUED",
        dependsOn: ["coder"],
        goal: "Review the produced work and decide whether changes are still required.",
        whyThisInvocation: "Review is required after implementation finishes.",
        whyThisWorkItem: "Review is required after implementation finishes.",
        completionSignal: "A review outcome is recorded for the operator.",
      }),
    ],
  });
  expect(readModel.latestAnswer).toBe("Implemented the shared orchestration view.");
  expect(readModel.nextCapability).toBe("reviewer");
  expect(readModel.roleProgress).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "leader",
        state: "COMPLETED",
        executorId: "codex",
      }),
      expect.objectContaining({
        roleId: "coder",
        state: "COMPLETED",
        executorId: "codex",
        summary: "Implemented the shared orchestration view.",
      }),
      expect.objectContaining({
        roleId: "reviewer",
        state: "QUEUED",
      }),
    ]),
  );
  expect(readModel.completedCapabilities).toEqual(["leader", "coder"]);
  expect(readModel.pendingCapabilities).toEqual(["reviewer"]);
  expect(readModel.blockedCapabilities).toEqual([]);
  expect(readModel.workItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "coder",
        executionKind: "delegated_subagent",
        goal: "Implement the requested change and produce a usable coding result.",
        whyThisWorkItem: "Implementation is the next blocking step.",
        completionSignal: "The planned change is implemented.",
        subagentInvocation: {
          roleId: "coder",
          subagentType: "coder",
          whyThisInvocation: "Implementation is the next blocking step.",
          completionSignal: "The planned change is implemented.",
        },
        runtimeState: "COMPLETED",
        executionStatus: "completed",
      }),
      expect.objectContaining({
        roleId: "reviewer",
        executionKind: "delegated_subagent",
        goal: "Review the produced work and decide whether changes are still required.",
        whyThisWorkItem: "Review is required after implementation finishes.",
        completionSignal: "A review outcome is recorded for the operator.",
        subagentInvocation: {
          roleId: "reviewer",
          subagentType: "reviewer",
          whyThisInvocation: "Review is required after implementation finishes.",
          completionSignal: "A review outcome is recorded for the operator.",
        },
        runtimeState: "QUEUED",
        executionStatus: "ready",
        dependsOn: ["coder"],
      }),
    ]),
  );
});

test("getTaskOrchestrationReadModel prefers full lastMessage over preview for completed sessions", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-12T08:00:00.000Z");
  const fullLastMessage = [
    "Objective",
    "Confirm the current workspace language stack.",
    "",
    "Outcome",
    "当前仓库主语言是 TypeScript，前端是 React + TSX，运行时是 Bun。",
  ].join("\n");

  await taskRepository.create({
    id: "task_orchestration_read_model_last_message",
    workspaceId: "workspace_main",
    source: "web",
    title: "确认语言栈",
    description: "确认并返回完整答案",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_last_message_manager",
    taskId: "task_orchestration_read_model_last_message",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_last_message_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_last_message_coder",
    taskId: "task_orchestration_read_model_last_message",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_last_message_coder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-12T08:01:00.000Z"),
    completedAt: new Date("2026-04-12T08:01:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_orm_last_message_completed",
    type: "executor_session.completed",
    taskId: "task_orchestration_read_model_last_message",
    roleRuntimeId: "runtime_orm_last_message_coder",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-12T08:01:05.000Z"),
    payloadJson: JSON.stringify({
      message: "任务已完成。",
      summary: "任务已完成。",
      lastMessage: fullLastMessage,
      lastMessagePreview: "Objective Confirm the current workspace language stack... ",
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_last_message");

  expect(readModel.latestAnswer).toBe(fullLastMessage);
});

test("getTaskOrchestrationReadModel prefers parsed manager replies over raw JSON decision output", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-15T03:28:18.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_manager_reply",
    workspaceId: "workspace_main",
    source: "web",
    title: "你好",
    description: "Greeting task",
    state: "COMPLETED",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_manager_reply",
    taskId: "task_orchestration_read_model_manager_reply",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_manager_reply",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-15T03:28:57.000Z"),
    completedAt: new Date("2026-04-15T03:28:57.000Z"),
  });

  await executionEventRepository.create({
    id: "event_orm_manager_reply_completed",
    type: "executor_session.completed",
    taskId: "task_orchestration_read_model_manager_reply",
    roleRuntimeId: "runtime_orm_manager_reply",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-15T03:28:57.000Z"),
    payloadJson: JSON.stringify({
      lastMessage:
        "{\"taskType\":\"greeting\",\"executionMode\":\"immediate\",\"decision\":\"direct_answer\",\"reply\":\"你好！我是 Magister 的管理代理，已收到任务。请告诉我下一步要处理的具体事项。\",\"confidence\":0.99,\"childWorkItems\":[],\"waitingFor\":null,\"nextWakeupAt\":null,\"warnings\":[]}",
      summary:
        "{\"taskType\":\"greeting\",\"executionMode\":\"immediate\",\"decision\":\"direct_answer\",\"reply\":\"你好！我是 Magister 的管理代理，已收到任务。请告诉我下一步要处理的具体事项。\",\"confidence\":0.99,\"childWorkItems\":[],\"waitingFor\":null,\"nextWakeupAt\":null,\"warnings\":[]}",
      message:
        "{\"taskType\":\"greeting\",\"executionMode\":\"immediate\",\"decision\":\"direct_answer\",\"reply\":\"你好！我是 Magister 的管理代理，已收到任务。请告诉我下一步要处理的具体事项。\",\"confidence\":0.99,\"childWorkItems\":[],\"waitingFor\":null,\"nextWakeupAt\":null,\"warnings\":[]}",
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_manager_reply");

  expect(readModel.latestAnswer).toBe(
    "你好！我是 Magister 的管理代理，已收到任务。请告诉我下一步要处理的具体事项。",
  );
});

test("getTaskOrchestrationReadModel exposes explicit planner-hint metadata when manager plan was overridden", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-12T10:03:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_hinted_plan",
    workspaceId: "workspace_main",
    source: "web",
    title: "Review, implement, and merge the login redirect fix",
    description: "This wording would normally expand the plan.",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_hinted_manager",
    taskId: "task_orchestration_read_model_hinted_plan",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_hinted_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_orm_hinted_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_read_model_hinted_plan",
    roleRuntimeId: "runtime_orm_hinted_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned a hinted coder-only execution path",
      planningMode: "explicit_hints",
      taskType: "coding",
      source: "manager_completed",
      goal: "Patch the redirect regression and stop after implementation.",
      needsHuman: false,
      stopCondition: "implementation_ready",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
          goal: "Patch the redirect regression and stop after implementation.",
        },
      ],
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_hinted_plan");

  expect(readModel.managerPlan).toMatchObject({
    planningMode: "explicit_hints",
    taskType: "coding",
    goal: "Patch the redirect regression and stop after implementation.",
    stopCondition: "implementation_ready",
    childRuns: [
      expect.objectContaining({
        roleId: "coder",
        goal: "Patch the redirect regression and stop after implementation.",
      }),
    ],
  });
});

test("getTaskOrchestrationReadModel exposes structured manager plan fields for consumer reads", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T12:03:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_structured_plan",
    workspaceId: "workspace_main",
    source: "web",
    title: "Fix the login redirect bug",
    description: "Inspect the auth flow and patch the regression.",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_structured_manager",
    taskId: "task_orchestration_read_model_structured_plan",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_structured_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await executionEventRepository.create({
    id: "event_orm_structured_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_read_model_structured_plan",
    roleRuntimeId: "runtime_orm_structured_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned a coder-only execution path",
      taskType: "coding",
      source: "manager_completed",
      goal: "Fix the login redirect bug",
      needsHuman: false,
      stopCondition: "implementation_ready",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
          goal: "Patch the redirect regression and verify the fix.",
        },
      ],
      workItems: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          goal: "Patch the redirect regression and verify the fix.",
          runtimeState: "CREATED",
          executionStatus: "ready",
        },
      ],
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_structured_plan");

  expect(readModel.managerPlan).toEqual(
    expect.objectContaining({
      taskType: "coding",
      source: "manager_completed",
      goal: "Fix the login redirect bug",
      needsHuman: false,
      stopCondition: "implementation_ready",
      childRuns: [
        expect.objectContaining({
          roleId: "coder",
          state: "CREATED",
          goal: "Patch the redirect regression and verify the fix.",
        }),
      ],
    }),
  );

  expect(readModel.workItems).toEqual([
    expect.objectContaining({
      roleId: "coder",
      goal: "Patch the redirect regression and verify the fix.",
    }),
  ]);
});

test("getTaskOrchestrationReadModel prefers the latest task.work_items.updated snapshot for consumer reads", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T12:10:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_snapshot_preference",
    workspaceId: "workspace_main",
    source: "web",
    title: "Prefer the latest work-item snapshot",
    description: "Prefer the latest work-item snapshot",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_snapshot_manager",
    taskId: "task_orchestration_snapshot_preference",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_snapshot_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_snapshot_coder",
    taskId: "task_orchestration_snapshot_preference",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_snapshot_coder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T12:10:30.000Z"),
    completedAt: new Date("2026-04-11T12:10:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_snapshot_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_snapshot_preference",
    roleRuntimeId: "runtime_snapshot_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder",
      taskType: "coding",
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
    id: "event_snapshot_completed",
    type: "executor_session.completed",
    taskId: "task_orchestration_snapshot_preference",
    roleRuntimeId: "runtime_snapshot_coder",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T12:10:40.000Z"),
    payloadJson: JSON.stringify({
      message: "Coder completed the runtime projection.",
      summary: "Runtime projection should be superseded by the snapshot.",
      lastMessagePreview: "Runtime projection should be superseded by the snapshot.",
    }),
  });

  await executionEventRepository.create({
    id: "event_snapshot_work_items",
    type: "task.work_items.updated",
    taskId: "task_orchestration_snapshot_preference",
    roleRuntimeId: "runtime_snapshot_coder",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T12:11:00.000Z"),
    payloadJson: JSON.stringify({
      message: "Consumer snapshot should win",
      source: "dispatch_progressed",
      latestAnswer: "Snapshot answer should win.",
      nextCapability: "reviewer",
      managerPlan: {
        taskType: "mixed",
        source: "manager_completed",
        goal: "Prefer the latest work-item snapshot",
        needsHuman: false,
        stopCondition: "review_ready",
        childRuns: [
          {
            roleId: "coder",
            state: "CREATED",
            dependsOn: [],
            goal: "Implement the requested change and produce a usable coding result.",
            primaryAdapterId: "codex",
            routingStrategy: "agent_only",
            executorClass: "coding_agent",
          },
          {
            roleId: "reviewer",
            state: "QUEUED",
            dependsOn: ["coder"],
            goal: "Review the produced work and decide whether changes are still required.",
            primaryAdapterId: "qoder",
            routingStrategy: "fallback_model",
            fallbackAdapterId: "model",
            executorClass: "coding_agent",
          },
        ],
      },
      roleProgress: [
        {
          roleId: "leader",
          state: "COMPLETED",
          executorId: "codex",
          runId: "runtime_snapshot_manager",
          summary: "Manager seeded the reviewer lane",
        },
        {
          roleId: "coder",
          state: "COMPLETED",
          executorId: "codex",
          runId: "runtime_snapshot_coder",
          summary: "Coder completed from the snapshot",
        },
        {
          roleId: "reviewer",
          state: "QUEUED",
          executorId: "model",
          runId: "runtime_snapshot_reviewer",
          summary: "Reviewer is waiting on the snapshot",
        },
      ],
      workItems: [
          {
            roleId: "coder",
            state: "CREATED",
            dependsOn: [],
            goal: "Implement the requested change and produce a usable coding result.",
            runtimeState: "COMPLETED",
            executionStatus: "completed",
            summary: "Coder completed from the snapshot",
        },
          {
            roleId: "reviewer",
            state: "QUEUED",
            dependsOn: ["coder"],
            goal: "Review the produced work and decide whether changes are still required.",
            runtimeState: "IDLE",
            executionStatus: "ready",
            primaryAdapterId: "qoder",
          routingStrategy: "fallback_model",
          fallbackAdapterId: "model",
          executorClass: "coding_agent",
          summary: "Reviewer is waiting on the snapshot",
        },
      ],
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_snapshot_preference");

  expect(readModel).toMatchObject({
    latestAnswer: "Snapshot answer should win.",
    nextCapability: "reviewer",
    managerPlan: {
      taskType: "mixed",
      source: "manager_completed",
      childRuns: [
        expect.objectContaining({
          roleId: "coder",
          state: "CREATED",
        }),
        expect.objectContaining({
          roleId: "reviewer",
          state: "QUEUED",
        }),
      ],
    },
    roleProgress: expect.arrayContaining([
      expect.objectContaining({
        roleId: "reviewer",
        state: "QUEUED",
      }),
    ]),
    workItems: expect.arrayContaining([
      expect.objectContaining({
        roleId: "reviewer",
        executionStatus: "ready",
        runtimeState: "IDLE",
      }),
    ]),
  });
});

test("getTaskOrchestrationReadModel hides stale historical roles when a persisted manager plan exists", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T12:05:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_2",
    workspaceId: "workspace_main",
    source: "web",
    title: "Fix the login redirect bug",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm2_manager",
    taskId: "task_orchestration_read_model_2",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm2_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm2_coder",
    taskId: "task_orchestration_read_model_2",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_orm2_coder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T12:05:30.000Z"),
    completedAt: new Date("2026-04-11T12:05:30.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm2_reviewer",
    taskId: "task_orchestration_read_model_2",
    roleId: "reviewer",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    currentSessionId: "session_orm2_reviewer",
    attemptCount: 1,
    startedAt: new Date("2026-04-11T12:04:00.000Z"),
    updatedAt: new Date("2026-04-11T12:04:20.000Z"),
    completedAt: new Date("2026-04-11T12:04:20.000Z"),
  });

  await executionEventRepository.create({
    id: "event_orm2_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_read_model_2",
    roleRuntimeId: "runtime_orm2_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder",
      taskType: "coding",
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

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_2");

  expect(readModel.managerPlan?.childRuns.map((childRun) => childRun.roleId)).toEqual(["coder"]);
  expect(readModel.roleProgress.map((item) => item.roleId)).toEqual(["leader", "coder"]);
  expect(readModel.completedCapabilities).toEqual(["leader", "coder"]);
  expect(readModel.blockedCapabilities).toEqual([]);
  expect(readModel.workItems).toEqual([
    expect.objectContaining({
      roleId: "coder",
      runtimeState: "COMPLETED",
      executionStatus: "completed",
    }),
  ]);
});

test("getTaskOrchestrationReadModel preserves distinct roleId identity when multiple invocations share one subagentType", async () => {
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-11T12:15:00.000Z");

  await taskRepository.create({
    id: "task_orchestration_read_model_distinct_role_ids",
    workspaceId: "workspace_main",
    source: "web",
    title: "Handle split coder lanes",
    description: "Handle split coder lanes",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_distinct_manager",
    taskId: "task_orchestration_read_model_distinct_role_ids",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_distinct_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_distinct_coder_ui",
    taskId: "task_orchestration_read_model_distinct_role_ids",
    roleId: "coder_ui",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_orm_distinct_coder_ui",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-11T12:15:20.000Z"),
    completedAt: new Date("2026-04-11T12:15:20.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_orm_distinct_coder_api",
    taskId: "task_orchestration_read_model_distinct_role_ids",
    roleId: "coder_api",
    state: "QUEUED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    currentSessionId: "session_orm_distinct_coder_api",
    attemptCount: 0,
    updatedAt: new Date("2026-04-11T12:15:40.000Z"),
  });

  await executionEventRepository.create({
    id: "event_orm_distinct_plan",
    type: "task.manager.plan_created",
    taskId: "task_orchestration_read_model_distinct_role_ids",
    roleRuntimeId: "runtime_orm_distinct_manager",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Manager planned two coder invocations with distinct role ids",
      taskType: "coding",
      source: "manager_completed",
      childRuns: [
        {
          subagentType: "coder",
          roleId: "coder_ui",
          state: "CREATED",
          dependsOn: [],
          whyThisInvocation: "UI implementation is the first coding step.",
          completionSignal: "UI patch is ready for API follow-up.",
        },
        {
          subagentType: "coder",
          roleId: "coder_api",
          state: "QUEUED",
          dependsOn: ["coder_ui"],
          whyThisInvocation: "API implementation follows the UI change.",
          completionSignal: "API patch is ready for review.",
        },
      ],
    }),
  });

  const readModel = await getTaskOrchestrationReadModel("task_orchestration_read_model_distinct_role_ids");

  expect(readModel.managerPlan?.childRuns).toEqual([
    expect.objectContaining({
      roleId: "coder_ui",
      subagentType: "coder",
      whyThisInvocation: "UI implementation is the first coding step.",
    }),
    expect.objectContaining({
      roleId: "coder_api",
      subagentType: "coder",
      whyThisInvocation: "API implementation follows the UI change.",
    }),
  ]);
  expect(readModel.workItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "coder_ui",
        subagentType: "coder",
        subagentInvocation: {
          roleId: "coder_ui",
          subagentType: "coder",
          whyThisInvocation: "UI implementation is the first coding step.",
          completionSignal: "UI patch is ready for API follow-up.",
        },
      }),
      expect.objectContaining({
        roleId: "coder_api",
        subagentType: "coder",
        subagentInvocation: {
          roleId: "coder_api",
          subagentType: "coder",
          whyThisInvocation: "API implementation follows the UI change.",
          completionSignal: "API patch is ready for review.",
        },
      }),
    ]),
  );
});
