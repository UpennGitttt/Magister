import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../../src/repositories/runtime-workspace-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-task-graph-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `task-graph-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("task context route exposes role lanes and graph for the operator console", async () => {
  const now = new Date("2026-04-10T13:00:00.000Z");
  const coderRuntimeContextPath = join(tempRoot, "runtime-context-runtime_graph_coder.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const approvalRepository = new ApprovalRepository();
  const artifactRepository = new ArtifactRepository();
  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();

  await taskRepository.create({
    id: "task_graph_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Visualize the agent org",
    description: "Visualize the agent org",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_manager",
    taskId: "task_graph_1",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_coder",
    taskId: "task_graph_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_coder",
    priorSessionId: "session_graph_coder_prior",
    priorWorkdir: "/opt/acme/magister",
    resumePolicy: "resume_first",
    workspaceStrategyOverride: "workspace_root",
    resumeAttemptedAt: new Date("2026-04-10T13:01:50.000Z"),
    resumeFailureReason: "resume_requested",
    attemptCount: 2,
    startedAt: now,
    updatedAt: new Date("2026-04-10T13:02:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_reviewer",
    taskId: "task_graph_1",
    roleId: "reviewer",
    state: "CREATED",
    activeExecutorId: "qoder",
    currentSessionId: "session_graph_reviewer",
    priorSessionId: "session_graph_reviewer_prior",
    priorWorkdir: "/tmp/reviewer-graph-workdir",
    resumePolicy: "rehydrate_only",
    attemptCount: 0,
    updatedAt: new Date("2026-04-10T13:03:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_graph_coder_failed",
    type: "executor_session.failed",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_coder",
    severity: "error",
    occurredAt: new Date("2026-04-10T13:02:10.000Z"),
    payloadJson: JSON.stringify({
      message: "Patch application failed",
    }),
  });

  await approvalRepository.create({
    id: "approval_graph_1",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_reviewer",
    approvalType: "merge",
    state: "pending",
    requestedAt: new Date("2026-04-10T13:03:10.000Z"),
  });

  await artifactRepository.create({
    id: "artifact_graph_1",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    artifactType: "design_doc",
    title: "Org execution plan",
    storageKind: "file",
    storageRef: "/tmp/org-plan.md",
    summary: "Role decomposition ready",
    createdAt: now,
  });

  writeFileSync(
    coderRuntimeContextPath,
    JSON.stringify(
      {
        task: {
          id: "task_graph_1",
          title: "Visualize the agent org",
          state: "IN_PROGRESS",
          source: "cli",
        },
        run: {
          id: "runtime_graph_coder",
          roleId: "coder",
          state: "FAILED",
          attemptCount: 2,
        },
        continuity: {
          priorSessionId: "session_graph_coder_prior",
          priorWorkdir: "/opt/acme/magister",
          resumePolicy: "resume_first",
        },
        managerPlan: {
          taskType: "mixed",
          coordinationAction: "assign",
          plannedCapabilities: ["coder", "reviewer"],
        },
        orchestration: {
          nextCapability: "reviewer",
          completedCapabilities: ["leader"],
          pendingCapabilities: ["reviewer"],
          blockedCapabilities: ["coder"],
        },
        recentEvents: [
          {
            id: "event_graph_coder_failed",
            type: "executor_session.failed",
            occurredAt: new Date("2026-04-10T13:02:10.000Z").toISOString(),
            message: "Patch application failed",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  await artifactRepository.create({
    id: "artifact_graph_runtime_context_coder",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_coder",
    artifactType: "runtime_context",
    title: "Runtime context document",
    storageKind: "file",
    storageRef: coderRuntimeContextPath,
    summary: "Captured runtime context document for the coder run",
    createdAt: new Date("2026-04-10T13:02:20.000Z"),
  });

  await runtimeWorkspaceRepository.upsert({
    id: "workspace_runtime_graph_coder",
    runId: "runtime_graph_coder",
    taskId: "task_graph_1",
    workspaceId: "workspace_main",
    roleId: "coder",
    requestedStrategy: "git_worktree",
    strategy: "workspace_root",
    decisionReason: "dirty_workspace",
    fallbackReason: "non_git_workspace",
    status: "failed",
    baseWorkspaceDir: "/opt/acme/magister",
    workspaceDir: "/opt/acme/magister",
    metadataPath: "/tmp/runtime-workspace-runtime_graph_coder.json",
    createdAt: new Date("2026-04-10T13:01:40.000Z"),
    updatedAt: new Date("2026-04-10T13:02:00.000Z"),
    finishedAt: new Date("2026-04-10T13:02:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_graph_manager_plan",
    type: "task.manager.plan_created",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T13:00:30.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder, reviewer",
      decisionMode: "heuristic",
      coordinationAction: "assign",
      planningMode: "heuristic",
      taskType: "mixed",
      needsHuman: true,
      confidence: "low",
      stopCondition: "review_ready",
      source: "manager_completed",
      warnings: [
        "Heuristic planner ignored incidental architecture wording and kept the narrower coding path until review.",
      ],
      detectedSignals: ["architecture", "coding", "review"],
      childRuns: [
        {
          subagentType: "coder",
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
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
    id: "event_graph_manager_tool_call",
    type: "tool.call",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T13:00:15.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool call: time_now",
      toolName: "time_now",
      toolCallId: "manager-call-1",
      source: "claude_code",
      arguments: {},
    }),
  });

  await executionEventRepository.create({
    id: "event_graph_manager_tool_result",
    type: "tool.result",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T13:00:16.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool result: time_now",
      toolName: "time_now",
      toolCallId: "manager-call-1",
      source: "claude_code",
      arguments: {},
      resultSummary: "Local time 2026-04-10 21:00:16",
    }),
  });

  await executionEventRepository.create({
    id: "event_graph_manager_tool_call_web_search",
    type: "tool.call",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T13:00:17.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool call: web_search",
      toolName: "web_search",
      toolCallId: "manager-call-2",
      source: "claude_code",
      arguments: {
        query: "latest regression signals",
      },
    }),
  });

  await executionEventRepository.create({
    id: "event_graph_manager_tool_error_web_search",
    type: "tool.error",
    taskId: "task_graph_1",
    roleRuntimeId: "runtime_graph_manager",
    severity: "warning",
    occurredAt: new Date("2026-04-10T13:00:20.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager tool error: web_search",
      toolName: "web_search",
      toolCallId: "manager-call-2",
      source: "claude_code",
      arguments: {
        query: "latest regression signals",
      },
      errorMessage: "tavily request timeout",
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_graph_1/context",
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: boolean;
    data: {
      semanticOwner?: string;
      currentExecutionRole?: string;
      currentResponsibleRole: string;
      managerDecision: (Record<string, unknown> & { semanticSource?: string }) | null;
      workItems: Array<Record<string, unknown>>;
      subagentInvocations?: Array<Record<string, unknown>>;
      leaderToolEvents?: Array<Record<string, unknown>>;
      managerToolEvents?: Array<Record<string, unknown>>;
      leaderPlan: Record<string, unknown> | null;
      managerPlan: Record<string, unknown> | null;
      taskGraph: {
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
      roleLanes: Array<Record<string, unknown>>;
    };
  };

  expect(body.ok).toBe(true);
  expect(body.data.semanticOwner).toBe("manager_agent");
  expect(body.data.currentExecutionRole).toBe("reviewer");
  expect(body.data.currentResponsibleRole).toBe("reviewer");
  expect(body.data.managerDecision).toMatchObject({
    semanticSource: "manager_agent",
    source: "heuristic_fallback",
    runId: "runtime_graph_manager",
    roleId: "leader",
    fallbackReason: null,
    leaderPlan: {
      decisionMode: "heuristic",
      coordinationAction: "assign",
      planningMode: "heuristic",
      executionMode: "bounded_execution",
      taskType: "mixed",
    },
    managerPlan: {
      decisionMode: "heuristic",
      coordinationAction: "assign",
      planningMode: "heuristic",
      executionMode: "bounded_execution",
      taskType: "mixed",
    },
  });
  expect(body.data.workItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "coder",
        executionKind: "delegated_subagent",
        subagentInvocation: {
          roleId: "coder",
          subagentType: "coder",
          whyThisInvocation: "Implementation is the next blocking step.",
          completionSignal: "The planned change is implemented.",
        },
        runtimeState: "FAILED",
        executionStatus: "blocked",
      }),
      expect.objectContaining({
        roleId: "reviewer",
        executionKind: "delegated_subagent",
        subagentInvocation: {
          roleId: "reviewer",
          subagentType: "reviewer",
          whyThisInvocation: "Review is required after implementation finishes.",
          completionSignal: "A review outcome is recorded for the operator.",
        },
        runtimeState: "CREATED",
        executionStatus: "waiting_on_dependencies",
      }),
    ]),
  );
  expect(body.data.subagentInvocations).toEqual([
    {
      roleId: "coder",
      subagentType: "coder",
      whyThisInvocation: "Implementation is the next blocking step.",
      completionSignal: "The planned change is implemented.",
    },
    {
      roleId: "reviewer",
      subagentType: "reviewer",
      whyThisInvocation: "Review is required after implementation finishes.",
      completionSignal: "A review outcome is recorded for the operator.",
    },
  ]);
  expect(body.data.managerToolEvents).toEqual([
    {
      type: "tool.error",
      toolName: "web_search",
      summary: "Manager tool error: web_search",
      occurredAt: "2026-04-10T13:00:20.000Z",
      source: "claude_code",
      toolCallId: "manager-call-2",
      step: 2,
      status: "failed",
      startedAt: "2026-04-10T13:00:17.000Z",
      latencyMs: 3000,
      arguments: {
        query: "latest regression signals",
      },
      errorMessage: "tavily request timeout",
    },
    {
      type: "tool.call",
      toolName: "web_search",
      summary: "Manager tool call: web_search",
      occurredAt: "2026-04-10T13:00:17.000Z",
      source: "claude_code",
      toolCallId: "manager-call-2",
      step: 2,
      status: "in_progress",
      arguments: {
        query: "latest regression signals",
      },
    },
    {
      type: "tool.result",
      toolName: "time_now",
      summary: "Manager tool result: time_now",
      occurredAt: "2026-04-10T13:00:16.000Z",
      source: "claude_code",
      toolCallId: "manager-call-1",
      step: 1,
      status: "succeeded",
      startedAt: "2026-04-10T13:00:15.000Z",
      latencyMs: 1000,
      arguments: {},
      resultSummary: "Local time 2026-04-10 21:00:16",
    },
    {
      type: "tool.call",
      toolName: "time_now",
      summary: "Manager tool call: time_now",
      occurredAt: "2026-04-10T13:00:15.000Z",
      source: "claude_code",
      toolCallId: "manager-call-1",
      step: 1,
      status: "in_progress",
      arguments: {},
    },
  ]);
  expect(body.data.leaderToolEvents).toEqual(body.data.managerToolEvents);
  expect(body.data.leaderPlan).toEqual(body.data.managerPlan);
  expect(body.data.managerPlan).toMatchObject({
    decisionMode: "heuristic",
    coordinationAction: "assign",
    planningMode: "heuristic",
    executionMode: "bounded_execution",
    taskType: "mixed",
    needsHuman: true,
    confidence: "low",
    stopCondition: "review_ready",
    source: "manager_completed",
    warnings: [
      "Heuristic planner ignored incidental architecture wording and kept the narrower coding path until review.",
    ],
    detectedSignals: ["architecture", "coding", "review"],
    childRuns: [
      expect.objectContaining({
        subagentType: "coder",
        roleId: "coder",
        whyThisInvocation: "Implementation is the next blocking step.",
      }),
      expect.objectContaining({
        subagentType: "reviewer",
        roleId: "reviewer",
        whyThisInvocation: "Review is required after implementation finishes.",
      }),
    ],
  });
  expect(body.data.taskGraph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "task_graph_1",
        kind: "task",
        label: "Visualize the agent org",
      }),
      expect.objectContaining({
        id: "runtime_graph_manager",
        kind: "run",
        roleId: "leader",
      }),
      expect.objectContaining({
        id: "runtime_graph_coder",
        kind: "run",
        roleId: "coder",
      }),
    ]),
  );
  expect(body.data.taskGraph.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "task_graph_1",
        target: "runtime_graph_manager",
      }),
      expect.objectContaining({
        source: "task_graph_1",
        target: "runtime_graph_coder",
      }),
      expect.objectContaining({
        source: "runtime_graph_coder",
        target: "runtime_graph_reviewer",
        kind: "depends_on",
      }),
    ]),
  );

  expect(body.data.roleLanes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        roleId: "leader",
        state: "COMPLETED",
        semanticRole: "manager_agent",
        executorId: "codex",
      }),
      expect.objectContaining({
        roleId: "coder",
        state: "FAILED",
        semanticRole: "delegated_subagent",
        lastError: "Patch application failed",
        attemptCount: 2,
        workspaceStrategyOverride: "workspace_root",
        runtimeWorkspace: expect.objectContaining({
          runId: "runtime_graph_coder",
          requestedStrategy: "git_worktree",
          strategy: "workspace_root",
          decisionReason: "dirty_workspace",
          fallbackReason: "non_git_workspace",
        }),
        runtimeContextArtifactId: "artifact_graph_runtime_context_coder",
        runtimeContextSummary: expect.objectContaining({
          run: expect.objectContaining({
            id: "runtime_graph_coder",
            roleId: "coder",
          }),
          orchestration: expect.objectContaining({
            nextCapability: "reviewer",
          }),
        }),
        dependsOn: [],
        plannedState: "CREATED",
        primaryAdapterId: "codex",
        routingStrategy: "agent_only",
        executorClass: "coding_agent",
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "resume_first",
          adapterId: "codex",
          priorSessionId: "session_graph_coder_prior",
          priorWorkdir: "/opt/acme/magister",
          adapterSupportsResume: true,
          nativeResumeAttempted: true,
          fallbackToFresh: true,
          reason: "resume_requested",
        },
      }),
      expect.objectContaining({
        roleId: "reviewer",
        state: "CREATED",
        semanticRole: "delegated_subagent",
        approvalState: "pending",
        dependsOn: ["coder"],
        plannedState: "QUEUED",
        primaryAdapterId: "qoder",
        routingStrategy: "fallback_model",
        fallbackAdapterId: "model",
        executorClass: "coding_agent",
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "rehydrate_only",
          adapterId: "qoder",
          priorSessionId: "session_graph_reviewer_prior",
          priorWorkdir: "/tmp/reviewer-graph-workdir",
          adapterSupportsResume: false,
          nativeResumeAttempted: false,
          fallbackToFresh: false,
          reason: "rehydrate_only",
        },
      }),
    ]),
  );
});

test("task context route scopes lanes and graph nodes to the persisted manager plan", async () => {
  const now = new Date("2026-04-10T14:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_graph_scope_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Fix the login redirect bug",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_scope_manager",
    taskId: "task_graph_scope_1",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_scope_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_scope_coder",
    taskId: "task_graph_scope_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_scope_coder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-10T14:01:00.000Z"),
    completedAt: new Date("2026-04-10T14:01:00.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_scope_reviewer",
    taskId: "task_graph_scope_1",
    roleId: "reviewer",
    state: "FAILED",
    activeExecutorId: "qoder",
    currentSessionId: "session_graph_scope_reviewer",
    attemptCount: 1,
    startedAt: new Date("2026-04-10T13:55:00.000Z"),
    updatedAt: new Date("2026-04-10T13:56:00.000Z"),
    completedAt: new Date("2026-04-10T13:56:00.000Z"),
  });

  await executionEventRepository.create({
    id: "event_graph_scope_manager_plan",
    type: "task.manager.plan_created",
    taskId: "task_graph_scope_1",
    roleRuntimeId: "runtime_graph_scope_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T14:00:10.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager planned only coder",
      decisionMode: "heuristic",
      coordinationAction: "assign",
      planningMode: "heuristic",
      taskType: "coding",
      confidence: "high",
      stopCondition: "implementation_ready",
      source: "manager_completed",
      warnings: [],
      detectedSignals: ["coding"],
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

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_graph_scope_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      managerDecision: {
        source: "heuristic_fallback",
        runId: "runtime_graph_scope_manager",
        roleId: "leader",
        fallbackReason: null,
        managerPlan: {
          decisionMode: "heuristic",
          coordinationAction: "assign",
          planningMode: "heuristic",
          executionMode: "bounded_execution",
          taskType: "coding",
        },
      },
      managerPlan: {
        decisionMode: "heuristic",
        coordinationAction: "assign",
        planningMode: "heuristic",
        executionMode: "bounded_execution",
        taskType: "coding",
        confidence: "high",
        stopCondition: "implementation_ready",
        warnings: [],
        detectedSignals: ["coding"],
        childRuns: [
          expect.objectContaining({
            roleId: "coder",
          }),
        ],
      },
      workItems: [
        expect.objectContaining({
          roleId: "coder",
          runtimeState: "COMPLETED",
          executionStatus: "completed",
        }),
      ],
      roleLanes: [
        expect.objectContaining({
          roleId: "leader",
        }),
        expect.objectContaining({
          roleId: "coder",
        }),
      ],
      taskGraph: {
        nodes: [
          expect.objectContaining({
            id: "task_graph_scope_1",
          }),
          expect.objectContaining({
            id: "runtime_graph_scope_manager",
          }),
          expect.objectContaining({
            id: "runtime_graph_scope_coder",
          }),
        ],
      },
    },
  });

  const body = response.json() as {
    data: {
      roleLanes: Array<{ roleId: string }>;
      taskGraph: {
        nodes: Array<{ id: string }>;
      };
    };
  };

  expect(body.data.roleLanes.map((lane) => lane.roleId)).toEqual(["leader", "coder"]);
  expect(body.data.taskGraph.nodes.map((node) => node.id)).not.toContain("runtime_graph_scope_reviewer");
});

test("task context route exposes structured manager decision provenance when the latest manager run parsed successfully", async () => {
  const now = new Date("2026-04-10T14:20:00.000Z");
  const managerOutputPath = join(tempRoot, "manager-output-task_graph_structured_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_graph_structured_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Plan with structured manager decision",
    description: "Plan with structured manager decision",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_structured_manager",
    taskId: "task_graph_structured_1",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_structured_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  writeFileSync(
    managerOutputPath,
    JSON.stringify(
      {
        taskType: "coding",
        executionMode: "bounded_execution",
        decision: "spawn_work_items",
        confidence: "high",
        reply: "Proceeding with implementation.",
        skills: [],
        childWorkItems: [
          {
            roleId: "coder",
            skillId: "implement_code",
            goal: "Implement the planned change.",
            dependsOn: [],
            whyThisWorkItem: "Implementation is the next blocking step.",
            completionSignal: "The planned change is implemented.",
            handoffNotes: "Summarize validation results for the next lane.",
          },
        ],
        waitingFor: null,
        nextWakeupAt: null,
        warnings: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  await artifactRepository.create({
    id: "artifact_graph_structured_manager_plan",
    taskId: "task_graph_structured_1",
    roleRuntimeId: "runtime_graph_structured_manager",
    artifactType: "plan",
    title: "Manager structured plan",
    storageKind: "file",
    storageRef: managerOutputPath,
    summary: "Structured manager decision persisted to the manager plan artifact.",
    createdAt: new Date("2026-04-10T14:20:30.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_graph_structured_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      managerDecision: {
        source: "structured_decision",
        runId: "runtime_graph_structured_manager",
        roleId: "leader",
        fallbackReason: null,
        decision: {
          parsedDecision: {
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            confidence: "high",
            childWorkItems: [
              {
                roleId: "coder",
                skillId: "implement_code",
                goal: "Implement the planned change.",
                dependsOn: [],
                whyThisWorkItem: "Implementation is the next blocking step.",
                completionSignal: "The planned change is implemented.",
                handoffNotes: "Summarize validation results for the next lane.",
              },
            ],
          },
        },
      },
    },
  });
});

test("task context route keeps distinct invocations when roleId differs but subagentType is shared", async () => {
  const now = new Date("2026-04-10T15:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_graph_distinct_invocations_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Split coder invocations",
    description: "Split coder invocations",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_distinct_manager",
    taskId: "task_graph_distinct_invocations_1",
    roleId: "leader",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_distinct_manager",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_distinct_coder_ui",
    taskId: "task_graph_distinct_invocations_1",
    roleId: "coder_ui",
    state: "COMPLETED",
    activeExecutorId: "codex",
    currentSessionId: "session_graph_distinct_coder_ui",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-10T15:00:30.000Z"),
    completedAt: new Date("2026-04-10T15:00:30.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_graph_distinct_coder_api",
    taskId: "task_graph_distinct_invocations_1",
    roleId: "coder_api",
    state: "CREATED",
    activeExecutorId: "qoder",
    currentSessionId: "session_graph_distinct_coder_api",
    attemptCount: 0,
    updatedAt: new Date("2026-04-10T15:00:40.000Z"),
  });

  await executionEventRepository.create({
    id: "event_graph_distinct_plan",
    type: "task.manager.plan_created",
    taskId: "task_graph_distinct_invocations_1",
    roleRuntimeId: "runtime_graph_distinct_manager",
    severity: "info",
    occurredAt: new Date("2026-04-10T15:00:10.000Z"),
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
          whyThisInvocation: "UI implementation starts first.",
          completionSignal: "UI patch is ready.",
        },
        {
          subagentType: "coder",
          roleId: "coder_api",
          state: "QUEUED",
          dependsOn: ["coder_ui"],
          whyThisInvocation: "API implementation follows UI.",
          completionSignal: "API patch is ready.",
        },
      ],
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/tasks/task_graph_distinct_invocations_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      subagentInvocations: [
        {
          roleId: "coder_ui",
          subagentType: "coder",
          whyThisInvocation: "UI implementation starts first.",
          completionSignal: "UI patch is ready.",
        },
        {
          roleId: "coder_api",
          subagentType: "coder",
          whyThisInvocation: "API implementation follows UI.",
          completionSignal: "API patch is ready.",
        },
      ],
      workItems: [
        expect.objectContaining({
          roleId: "coder_ui",
          subagentType: "coder",
          subagentInvocation: {
            roleId: "coder_ui",
            subagentType: "coder",
            whyThisInvocation: "UI implementation starts first.",
            completionSignal: "UI patch is ready.",
          },
        }),
        expect.objectContaining({
          roleId: "coder_api",
          subagentType: "coder",
          subagentInvocation: {
            roleId: "coder_api",
            subagentType: "coder",
            whyThisInvocation: "API implementation follows UI.",
            completionSignal: "API patch is ready.",
          },
        }),
      ],
    },
  });
});
