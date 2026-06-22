import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-task-orchestration-history-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `task-orchestration-history-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /tasks/:taskId/orchestration-history returns the canonical orchestration timeline", async () => {
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T13:00:00.000Z");

  await taskRepository.create({
    id: "task_history_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Render orchestration history",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: "event_history_plan",
    type: "task.manager.plan_created",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_manager_history_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T13:00:01.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent child runs for coder and reviewer",
      planningMode: "explicit_hints",
      taskType: "mixed",
      goal: "Implement the feature and review the result.",
      needsHuman: false,
      confidence: "high",
      stopCondition: "review_ready",
      source: "manager_completed",
      warnings: [],
      detectedSignals: ["explicit_hints"],
      childRuns: [
        {
          subagentType: "coder",
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          executionKind: "delegated_subagent",
          whyThisInvocation: "Implementation is the next blocking step.",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Call out any review risk introduced by the fix.",
          executorClass: "coding_agent",
        },
        {
          subagentType: "reviewer",
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          executionKind: "delegated_subagent",
          whyThisInvocation: "Review should start after code lands.",
          whyThisWorkItem: "Review should start after code lands.",
          completionSignal: "Reviewer returns an approval or change request.",
          handoffNotes: "Focus on regression and rollout risk.",
          executorClass: "model",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_history_work_items",
    type: "task.work_items.updated",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_manager_history_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T13:00:02.000Z"),
    payloadJson: JSON.stringify({
      message: "Work items updated for delegated subagent execution: coder, reviewer",
      latestAnswer: "Coder is ready to start, reviewer is waiting.",
      nextCapability: "coder",
      managerPlan: {
        planningMode: "explicit_hints",
        taskType: "mixed",
        goal: "Implement the feature and review the result.",
        needsHuman: false,
        confidence: "high",
        stopCondition: "review_ready",
        source: "manager_completed",
        warnings: [],
        detectedSignals: ["explicit_hints"],
        childRuns: [
          {
            subagentType: "coder",
            roleId: "coder",
            state: "CREATED",
            dependsOn: [],
            executionKind: "delegated_subagent",
            whyThisInvocation: "Implementation is the next blocking step.",
            whyThisWorkItem: "Implementation is the next blocking step.",
            completionSignal: "Patch lands and local validation passes.",
            handoffNotes: "Call out any review risk introduced by the fix.",
            executorClass: "coding_agent",
          },
          {
            subagentType: "reviewer",
            roleId: "reviewer",
            state: "QUEUED",
            dependsOn: ["coder"],
            executionKind: "delegated_subagent",
            whyThisInvocation: "Review should start after code lands.",
            whyThisWorkItem: "Review should start after code lands.",
            completionSignal: "Reviewer returns an approval or change request.",
            handoffNotes: "Focus on regression and rollout risk.",
            executorClass: "model",
          },
        ],
      },
      workItems: [
        {
          subagentType: "coder",
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          whyThisInvocation: "Implementation is the next blocking step.",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Call out any review risk introduced by the fix.",
          runtimeState: "CREATED",
          executionStatus: "ready",
          executorClass: "coding_agent",
        },
        {
          subagentType: "reviewer",
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          whyThisInvocation: "Review should start after code lands.",
          whyThisWorkItem: "Review should start after code lands.",
          completionSignal: "Reviewer returns an approval or change request.",
          handoffNotes: "Focus on regression and rollout risk.",
          runtimeState: "QUEUED",
          executionStatus: "waiting_on_dependencies",
          executorClass: "model",
        },
      ],
      createdRoleIds: ["coder", "reviewer"],
      nextRoleId: "coder",
    }),
  });

  await executionEventRepository.create({
    id: "event_history_transition",
    type: "task.orchestration.transition",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_manager_history_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T13:00:03.000Z"),
    payloadJson: JSON.stringify({
      message: "Task orchestration advanced to coder",
      transition: "advance",
      reason: "manager_completed",
      action: "dispatch",
      state: "IN_PROGRESS",
      taskState: "IN_PROGRESS",
      taskId: "task_history_1",
      workspaceId: "workspace_main",
      roleRuntimeId: "runtime_manager_history_1",
      roleId: "leader",
      nextRoleId: "coder",
      createdRoleIds: ["coder", "reviewer"],
    }),
  });

  await executionEventRepository.create({
    id: "event_history_waiting",
    type: "task.orchestration.waiting",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_manager_history_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T13:00:03.500Z"),
    payloadJson: JSON.stringify({
      message: "Wait for ci_status until 2026-04-11T14:00:00.000Z",
      action: "wait",
      stopReason: "sleep_until",
      state: "WAITING",
      taskState: "WAITING",
      taskId: "task_history_1",
      workspaceId: "workspace_main",
      roleRuntimeId: "runtime_manager_history_1",
      roleId: "leader",
      waitReason: "ci_status",
      nextWakeupAt: "2026-04-11T14:00:00.000Z",
    }),
  });

  await executionEventRepository.create({
    id: "event_history_stopped",
    type: "task.orchestration.stopped",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_reviewer_history_1",
    workspaceId: "workspace_main",
    severity: "warn",
    occurredAt: new Date("2026-04-11T13:00:04.000Z"),
    payloadJson: JSON.stringify({
      message: "Task orchestration stopped because reviewer requested changes",
      action: "block",
      stopReason: "review_changes_requested",
      state: "BLOCKED",
      taskState: "BLOCKED",
      taskId: "task_history_1",
      workspaceId: "workspace_main",
      roleRuntimeId: "runtime_reviewer_history_1",
      roleId: "reviewer",
      nextRoleId: "lander",
    }),
  });

  await executionEventRepository.create({
    id: "event_history_noise",
    type: "executor_session.completed",
    taskId: "task_history_1",
    roleRuntimeId: "runtime_coder_history_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T13:00:05.000Z"),
    payloadJson: JSON.stringify({
      message: "Noise event should not appear in orchestration history.",
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_history_1/orchestration-history",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      taskId: "task_history_1",
      items: [
        {
          type: "task.manager.plan_created",
          summary: "Manager planned delegated subagent child runs for coder and reviewer",
          managerPlan: {
            coordinationAction: "assign",
            planningMode: "explicit_hints",
            taskType: "mixed",
            goal: "Implement the feature and review the result.",
            confidence: "high",
            stopCondition: "review_ready",
            warnings: [],
            detectedSignals: ["explicit_hints"],
            childRuns: [
              expect.objectContaining({
                subagentType: "coder",
                roleId: "coder",
                executionKind: "delegated_subagent",
                whyThisInvocation: "Implementation is the next blocking step.",
                whyThisWorkItem: "Implementation is the next blocking step.",
                completionSignal: "Patch lands and local validation passes.",
                handoffNotes: "Call out any review risk introduced by the fix.",
              }),
              expect.objectContaining({
                subagentType: "reviewer",
                roleId: "reviewer",
                executionKind: "delegated_subagent",
                whyThisInvocation: "Review should start after code lands.",
                whyThisWorkItem: "Review should start after code lands.",
                completionSignal: "Reviewer returns an approval or change request.",
                handoffNotes: "Focus on regression and rollout risk.",
              }),
            ],
          },
        },
        {
          type: "task.work_items.updated",
          summary: "Work items updated for delegated subagent execution: coder, reviewer",
          latestAnswer: "Coder is ready to start, reviewer is waiting.",
          nextCapability: "coder",
          managerPlan: {
            coordinationAction: "assign",
            planningMode: "explicit_hints",
            taskType: "mixed",
            confidence: "high",
          },
          workItems: [
            {
              subagentType: "coder",
              roleId: "coder",
              executionStatus: "ready",
              executionKind: "delegated_subagent",
              whyThisInvocation: "Implementation is the next blocking step.",
              whyThisWorkItem: "Implementation is the next blocking step.",
              completionSignal: "Patch lands and local validation passes.",
              handoffNotes: "Call out any review risk introduced by the fix.",
            },
            {
              subagentType: "reviewer",
              roleId: "reviewer",
              executionStatus: "waiting_on_dependencies",
              executionKind: "delegated_subagent",
              whyThisInvocation: "Review should start after code lands.",
              whyThisWorkItem: "Review should start after code lands.",
              completionSignal: "Reviewer returns an approval or change request.",
              handoffNotes: "Focus on regression and rollout risk.",
            },
          ],
        },
        {
          type: "task.orchestration.transition",
          summary: "Task orchestration advanced to coder",
        },
        {
          type: "task.orchestration.waiting",
          summary: "Wait for ci_status until 2026-04-11T14:00:00.000Z",
          action: "wait",
          stopReason: "sleep_until",
          taskState: "WAITING",
        },
        {
          type: "task.orchestration.stopped",
          summary: "Task orchestration stopped because reviewer requested changes",
        },
      ],
    },
  });
});

test("GET /tasks/:taskId/timeline aliases orchestration history for mobile detail views", async () => {
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T14:00:00.000Z");

  await taskRepository.create({
    id: "task_history_timeline_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Render timeline alias",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: "event_history_timeline_transition",
    type: "task.orchestration.transition",
    taskId: "task_history_timeline_1",
    roleRuntimeId: "runtime_history_timeline_manager_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T14:00:01.000Z"),
    payloadJson: JSON.stringify({
      message: "Task orchestration advanced to coder",
      transition: "advance",
      reason: "manager_completed",
      action: "dispatch",
      state: "IN_PROGRESS",
      taskState: "IN_PROGRESS",
      roleId: "leader",
      nextRoleId: "coder",
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_history_timeline_1/timeline",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      taskId: "task_history_timeline_1",
      items: [
        expect.objectContaining({
          type: "task.orchestration.transition",
          summary: "Task orchestration advanced to coder",
        }),
      ],
    },
  });
});

test("GET /tasks/:taskId/orchestration-history expands legacy manager.followups_seeded events with invocation metadata", async () => {
  const taskRepository = new TaskRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const app = buildApp();
  const now = new Date("2026-04-11T15:00:00.000Z");

  await taskRepository.create({
    id: "task_history_legacy_seeded_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Render legacy followup expansion",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: "event_history_legacy_seeded",
    type: "manager.followups_seeded",
    taskId: "task_history_legacy_seeded_1",
    roleRuntimeId: "runtime_manager_history_legacy_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-11T15:00:01.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager automation seeded coder follow-up lanes",
      taskType: "coding",
      createdRoleIds: ["coder"],
      nextRoleId: "coder",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          executionKind: "delegated_subagent",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Highlight any residual rollout risk for operators.",
        },
      ],
      workItems: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          executionKind: "delegated_subagent",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Highlight any residual rollout risk for operators.",
          runtimeState: "CREATED",
          executionStatus: "ready",
        },
      ],
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_history_legacy_seeded_1/orchestration-history",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      taskId: "task_history_legacy_seeded_1",
      items: [
        {
          sourceEventType: "manager.followups_seeded",
          type: "task.manager.plan_created",
          summary: "Manager automation seeded coder follow-up lanes",
          createdRoleIds: ["coder"],
          managerPlan: {
            taskType: "coding",
            childRuns: [
              {
                subagentType: "coder",
                roleId: "coder",
                executionKind: "delegated_subagent",
                whyThisInvocation: "Implementation is the next blocking step.",
                whyThisWorkItem: "Implementation is the next blocking step.",
                completionSignal: "Patch lands and local validation passes.",
                handoffNotes: "Highlight any residual rollout risk for operators.",
              },
            ],
          },
        },
        {
          sourceEventType: "manager.followups_seeded",
          type: "task.work_items.updated",
          summary: "Manager automation seeded coder follow-up lanes",
          createdRoleIds: ["coder"],
          nextRoleId: "coder",
          managerPlan: {
            taskType: "coding",
          },
          workItems: [
            {
              subagentType: "coder",
              roleId: "coder",
              executionKind: "delegated_subagent",
              executionStatus: "ready",
              whyThisInvocation: "Implementation is the next blocking step.",
              whyThisWorkItem: "Implementation is the next blocking step.",
              completionSignal: "Patch lands and local validation passes.",
              handoffNotes: "Highlight any residual rollout risk for operators.",
            },
          ],
        },
      ],
    },
  });
});
