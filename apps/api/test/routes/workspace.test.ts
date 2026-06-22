import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-workspace-route-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `workspace-route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("workspace summary returns key control-plane counters", async () => {
  const now = new Date("2026-04-10T10:30:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const approvalRepository = new ApprovalRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_workspace_active",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Active task",
    description: "Active task",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await taskRepository.create({
    id: "task_workspace_blocked",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Blocked task",
    description: "Blocked task",
    state: "BLOCKED",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_workspace_failed",
    taskId: "task_workspace_active",
    roleId: "coder",
    state: "FAILED",
    activeExecutorId: "codex",
    currentSessionId: "session_workspace_failed",
    attemptCount: 1,
    updatedAt: now,
  });

  await approvalRepository.create({
    id: "approval_workspace_pending",
    taskId: "task_workspace_blocked",
    roleRuntimeId: "runtime_workspace_failed",
    approvalType: "merge",
    state: "pending",
    requestedAt: now,
  });

  await executionEventRepository.create({
    id: "event_workspace_1",
    type: "task.blocked",
    taskId: "task_workspace_blocked",
    roleRuntimeId: "runtime_workspace_failed",
    severity: "error",
    occurredAt: new Date("2026-04-10T10:31:00.000Z"),
    payloadJson: JSON.stringify({ message: "Awaiting approval" }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/workspace/summary",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      activeTaskCount: 1,
      blockedTaskCount: 1,
      failedRunCount: 1,
      pendingApprovalCount: 1,
      degradedAdapterCount: 1,
      taskQueue: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_workspace_active",
          title: "Active task",
          source: "cli",
          state: "IN_PROGRESS",
        }),
        expect.objectContaining({
          taskId: "task_workspace_blocked",
          title: "Blocked task",
          source: "cli",
          state: "BLOCKED",
          latestBlocker: "Awaiting approval",
        }),
      ]),
      attentionItems: expect.arrayContaining([
        expect.objectContaining({
          type: "approval_pending",
          taskId: "task_workspace_blocked",
          severity: "warn",
        }),
        expect.objectContaining({
          type: "task_blocked",
          taskId: "task_workspace_blocked",
          severity: "error",
        }),
        expect.objectContaining({
          type: "executor_degraded",
          adapterId: expect.any(String),
          severity: "warn",
        }),
      ]),
      recentImportantEvents: [
        {
          id: "event_workspace_1",
          type: "task.blocked",
          severity: "error",
        },
      ],
    },
  });
});

test("workspace summary exposes readable orchestration decision and stop events", async () => {
  const now = new Date("2026-04-10T12:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_workspace_orchestration",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Orchestration task",
    description: "Orchestration task",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_workspace_orchestration",
    taskId: "task_workspace_orchestration",
    roleId: "leader",
    state: "RUNNING",
    activeExecutorId: "codex",
    currentSessionId: "session_workspace_orchestration",
    attemptCount: 1,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_workspace_coder",
    taskId: "task_workspace_orchestration",
    roleId: "coder",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_workspace_coder",
    attemptCount: 1,
    updatedAt: new Date("2026-04-10T12:01:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_workspace_plan",
    type: "task.manager.plan_created",
    taskId: "task_workspace_orchestration",
    roleRuntimeId: "runtime_workspace_orchestration",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:00:30.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder, reviewer",
      taskType: "mixed",
      confidence: "medium",
      warnings: ["Manager inferred a mixed path from the task wording."],
      detectedSignals: ["coding", "review"],
      source: "manager_completed",
      childRuns: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Flag any reviewer risk introduced by the change.",
          primaryAdapterId: "codex",
          routingStrategy: "agent_only",
          executorClass: "coding_agent",
        },
        {
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          whyThisWorkItem: "Review starts once implementation is ready.",
          completionSignal: "Reviewer returns an approval or change request.",
          handoffNotes: "Focus on regression and rollout risk.",
          primaryAdapterId: "qoder",
          routingStrategy: "fallback_model",
          fallbackAdapterId: "model",
          executorClass: "coding_agent",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_workspace_coder_completed",
    type: "executor_session.completed",
    taskId: "task_workspace_orchestration",
    roleRuntimeId: "runtime_workspace_coder",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:01:40.000Z"),
    payloadJson: JSON.stringify({
      lastMessagePreview: "Coder implemented the orchestration summary integration.",
    }),
  });

  await executionEventRepository.create({
    id: "event_workspace_transition",
    type: "task.orchestration.transition",
    taskId: "task_workspace_orchestration",
    roleRuntimeId: "runtime_workspace_orchestration",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:01:00.000Z"),
    payloadJson: JSON.stringify({
      message: "Task orchestration advanced from manager to coder",
      transition: "advance",
      reason: "Manager seeded the next lane",
      state: "running",
      taskState: "IN_PROGRESS",
      roleId: "leader",
      roleRuntimeId: "runtime_workspace_orchestration",
      nextRoleId: "coder",
      createdRoleIds: ["architect", "coder", "reviewer"],
    }),
  });

  await executionEventRepository.create({
    id: "event_workspace_work_items",
    type: "task.work_items.updated",
    taskId: "task_workspace_orchestration",
    roleRuntimeId: "runtime_workspace_orchestration",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:01:30.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager refreshed work items after coder progress",
      source: "dispatch_progressed",
      workItems: [
        {
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "Patch lands and local validation passes.",
          handoffNotes: "Flag any reviewer risk introduced by the change.",
          runtimeState: "COMPLETED",
          executionStatus: "completed",
        },
        {
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          whyThisWorkItem: "Review starts once implementation is ready.",
          completionSignal: "Reviewer returns an approval or change request.",
          handoffNotes: "Focus on regression and rollout risk.",
          runtimeState: "IDLE",
          executionStatus: "ready",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_workspace_stop",
    type: "task.orchestration.stopped",
    taskId: "task_workspace_orchestration",
    roleRuntimeId: "runtime_workspace_orchestration",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:02:00.000Z"),
    payloadJson: JSON.stringify({
      message: "Task orchestration stopped for manual review",
      stopReason: "Missing configuredModel",
      state: "blocked",
      taskState: "BLOCKED",
      roleId: "leader",
      roleRuntimeId: "runtime_workspace_orchestration",
      nextRoleId: "reviewer",
      nextRunId: "runtime_workspace_review",
      dispatchCode: "executor_provider_missing",
      dispatchMessage: "Configure reviewer before dispatching the run.",
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/workspace/summary",
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json();

  expect(payload.ok).toBe(true);
  expect(payload.data.attentionItems).toEqual([]);
  expect(payload.data.taskQueue).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        taskId: "task_workspace_orchestration",
        title: "Orchestration task",
        latestAnswer: "Task orchestration stopped for manual review",
        nextWorkItemSummary: "下一步：reviewer · 为什么：Review starts once implementation is ready.",
        nextWorkItemWhyThisWorkItem: "Review starts once implementation is ready.",
        nextCapability: "reviewer",
        leaderConfidence: "medium",
        leaderWarnings: ["Manager inferred a mixed path from the task wording."],
        managerConfidence: "medium",
        plannerConfidence: "medium",
        source: "cli",
        state: "IN_PROGRESS",
      }),
    ]),
  );
  expect(payload.data.recentImportantEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "event_workspace_plan",
        type: "task.manager.plan_created",
        severity: "info",
        summary: "Manager planned delegated subagent work items for coder, reviewer",
        managerPlan: expect.objectContaining({
          decisionMode: null,
          coordinationAction: "assign",
          planningMode: null,
          taskType: "mixed",
          goal: null,
          needsHuman: null,
          confidence: "medium",
          stopCondition: null,
          source: "manager_completed",
          warnings: ["Manager inferred a mixed path from the task wording."],
          detectedSignals: ["coding", "review"],
          childRuns: expect.arrayContaining([
            expect.objectContaining({
              roleId: "coder",
              state: "CREATED",
              dependsOn: [],
              whyThisWorkItem: "Implementation is the next blocking step.",
              completionSignal: "Patch lands and local validation passes.",
              handoffNotes: "Flag any reviewer risk introduced by the change.",
              primaryAdapterId: "codex",
              routingStrategy: "agent_only",
              executorClass: "coding_agent",
            }),
            expect.objectContaining({
              roleId: "reviewer",
              state: "QUEUED",
              dependsOn: ["coder"],
              whyThisWorkItem: "Review starts once implementation is ready.",
              completionSignal: "Reviewer returns an approval or change request.",
              handoffNotes: "Focus on regression and rollout risk.",
              primaryAdapterId: "qoder",
              routingStrategy: "fallback_model",
              fallbackAdapterId: "model",
              executorClass: "coding_agent",
            }),
          ]),
          capabilityProgress: expect.arrayContaining([
            expect.objectContaining({
              roleId: "leader",
              state: "RUNNING",
              executorId: "codex",
            }),
            expect.objectContaining({
              roleId: "coder",
              state: "COMPLETED",
              executorId: "codex",
              summary: "Coder implemented the orchestration summary integration.",
            }),
          ]),
          completedCapabilities: ["coder"],
          pendingCapabilities: ["reviewer"],
          blockedCapabilities: [],
          nextCapability: "reviewer",
          workItems: expect.arrayContaining([
            expect.objectContaining({
              roleId: "coder",
              runtimeState: "COMPLETED",
              executionStatus: "completed",
              whyThisWorkItem: "Implementation is the next blocking step.",
              completionSignal: "Patch lands and local validation passes.",
              handoffNotes: "Flag any reviewer risk introduced by the change.",
            }),
            expect.objectContaining({
              roleId: "reviewer",
              runtimeState: "IDLE",
              executionStatus: "ready",
              whyThisWorkItem: "Review starts once implementation is ready.",
              completionSignal: "Reviewer returns an approval or change request.",
              handoffNotes: "Focus on regression and rollout risk.",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        id: "event_workspace_transition",
        type: "task.orchestration.transition",
        severity: "info",
        summary: "Task orchestration advanced from manager to coder",
        orchestrationDecision: expect.objectContaining({
          transition: "advance",
          reason: "Manager seeded the next lane",
          state: "running",
          taskState: "IN_PROGRESS",
          roleId: "leader",
          roleRuntimeId: "runtime_workspace_orchestration",
          nextRoleId: "coder",
          createdRoleIds: ["architect", "coder", "reviewer"],
        }),
      }),
      expect.objectContaining({
        id: "event_workspace_work_items",
        type: "task.work_items.updated",
        severity: "info",
        summary: "Manager refreshed work items after coder progress",
        managerPlan: expect.objectContaining({
          workItems: expect.arrayContaining([
            expect.objectContaining({
              roleId: "coder",
              runtimeState: "COMPLETED",
              executionStatus: "completed",
              whyThisWorkItem: "Implementation is the next blocking step.",
              completionSignal: "Patch lands and local validation passes.",
              handoffNotes: "Flag any reviewer risk introduced by the change.",
            }),
            expect.objectContaining({
              roleId: "reviewer",
              runtimeState: "IDLE",
              executionStatus: "ready",
              whyThisWorkItem: "Review starts once implementation is ready.",
              completionSignal: "Reviewer returns an approval or change request.",
              handoffNotes: "Focus on regression and rollout risk.",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        id: "event_workspace_stop",
        type: "task.orchestration.stopped",
        severity: "info",
        summary: "Task orchestration stopped for manual review",
        orchestrationStop: expect.objectContaining({
          stopReason: "Missing configuredModel",
          state: "blocked",
          taskState: "BLOCKED",
          roleId: "leader",
          roleRuntimeId: "runtime_workspace_orchestration",
          nextRoleId: "reviewer",
          nextRunId: "runtime_workspace_review",
          dispatchCode: "executor_provider_missing",
          dispatchMessage: "Configure reviewer before dispatching the run.",
        }),
      }),
    ]),
  );
});

test("workspace insights returns failures, pull requests, memory candidates, and executor slots", async () => {
  const now = new Date("2026-04-10T11:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  process.env.MAGISTER_MODEL_CODEX = "gpt-5.3-codex";

  await taskRepository.create({
    id: "task_workspace_insights",
    workspaceId: "workspace_main",
    source: "web",
    title: "Ship orchestration console",
    description: "Ship orchestration console",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_workspace_failed",
    taskId: "task_workspace_insights",
    roleId: "reviewer",
    state: "FAILED",
    activeExecutorId: "qoder",
    currentSessionId: "session_failed",
    attemptCount: 2,
    updatedAt: now,
  });

  await artifactRepository.create({
    id: "artifact_workspace_pr",
    taskId: "task_workspace_insights",
    roleRuntimeId: "runtime_workspace_failed",
    artifactType: "pull_request",
    title: "PR #42",
    storageKind: "url",
    storageRef: "https://github.com/example/repo/pull/42",
    summary: "Desktop console redesign PR",
    createdAt: now,
  });

  await executionEventRepository.create({
    id: "event_workspace_failure",
    type: "executor_session.failed",
    taskId: "task_workspace_insights",
    roleRuntimeId: "runtime_workspace_failed",
    severity: "error",
    payloadJson: JSON.stringify({ message: "Reviewer lane hit a flaky command" }),
    occurredAt: new Date("2026-04-10T11:03:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_workspace_memory",
    type: "memory.candidate_created",
    taskId: "task_workspace_insights",
    roleRuntimeId: "runtime_workspace_failed",
    severity: "info",
    payloadJson: JSON.stringify({
      title: "Reviewer prefers patch-first handoffs",
      summary: "Preserve patch artifacts when reviewer fails.",
      scope: "project",
      status: "candidate",
    }),
    occurredAt: new Date("2026-04-10T11:04:00.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/workspace/insights",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      recentFailures: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_workspace_insights",
          roleId: "reviewer",
          executorId: "qoder",
          summary: "Reviewer lane hit a flaky command",
        }),
      ]),
      recentPullRequests: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_workspace_insights",
          runId: "runtime_workspace_failed",
          title: "PR #42",
          url: "https://github.com/example/repo/pull/42",
        }),
      ]),
      recentMemoryCandidates: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_workspace_insights",
          title: "Reviewer prefers patch-first handoffs",
          scope: "project",
        }),
      ]),
      executorSlots: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          configuredModel: "gpt-5.3-codex",
          status: "configured",
        }),
        expect.objectContaining({
          adapterId: "opencode",
          status: "unconfigured",
        }),
        expect.objectContaining({
          adapterId: "qoder",
          status: "unconfigured",
        }),
        expect.objectContaining({
          adapterId: "claude_code",
          status: "unconfigured",
        }),
      ]),
    },
  });

  delete process.env.MAGISTER_MODEL_CODEX;
});

test("workspace summary exposes artifact retention worker status for operators", async () => {
  const now = new Date("2026-04-10T12:30:00.000Z");
  const executionEventRepository = new ExecutionEventRepository();

  process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED = "true";
  process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS = "90000";
  process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS = "45000";

  await executionEventRepository.create({
    id: "event_workspace_retention_tick",
    type: "worker.artifact_retention.tick",
    severity: "info",
    occurredAt: now,
    payloadJson: JSON.stringify({
      message: "Artifact retention scanned 2 terminal tasks and cleaned 1",
      windowStart: "2026-04-10T12:28:45.000Z",
      windowEnd: "2026-04-10T12:30:00.000Z",
      scannedTaskCount: 2,
      eligibleTaskCount: 1,
      cleanedTaskIds: ["task_workspace_retention_1"],
      deletedArtifactIds: ["artifact_workspace_retention_log_1"],
      failedTaskIds: ["task_workspace_retention_failed_1"],
    }),
  });

  await executionEventRepository.create({
    id: "event_workspace_retention_failed",
    type: "worker.artifact_retention.failed",
    taskId: "task_workspace_retention_failed_1",
    severity: "error",
    occurredAt: new Date("2026-04-10T12:29:30.000Z"),
    payloadJson: JSON.stringify({
      message: "Artifact retention failed for task task_workspace_retention_failed_1",
      failedTaskId: "task_workspace_retention_failed_1",
      error: "simulated retention failure",
      trigger: "artifact_retention_worker",
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/workspace/summary",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      artifactRetention: {
        enabled: true,
        inFlight: false,
        intervalMs: 90000,
        graceMs: 45000,
        lastTickAt: "2026-04-10T12:30:00.000Z",
        lastWindowStart: "2026-04-10T12:28:45.000Z",
        lastScannedTaskCount: 2,
        lastEligibleTaskCount: 1,
        lastCleanedTaskIds: ["task_workspace_retention_1"],
        lastFailedTaskIds: ["task_workspace_retention_failed_1"],
        lastFailureAt: "2026-04-10T12:29:30.000Z",
        lastFailureTaskId: "task_workspace_retention_failed_1",
        lastFailureMessage: "simulated retention failure",
      },
    },
  });

  delete process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED;
  delete process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS;
  delete process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS;
});
