import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { RuntimeWorkspaceRepository } from "../../src/repositories/runtime-workspace-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-run-context-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `run-context-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("run context route exposes metadata, events, artifacts, and next action", async () => {
  const now = new Date("2026-04-10T12:00:00.000Z");
  const runtimeContextPath = join(tempRoot, "runtime-context-runtime_run_context_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const artifactRepository = new ArtifactRepository();
  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();

  await taskRepository.create({
    id: "task_run_context_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Diagnose the run",
    description: "Diagnose the run",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_1",
    taskId: "task_run_context_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_run_context_1",
    priorSessionId: "session_prior_run_context_1",
    priorWorkdir: "/opt/acme/magister",
    resumePolicy: "resume_first",
    workspaceStrategyOverride: "workspace_root",
    resumeAttemptedAt: new Date("2026-04-10T12:00:01.000Z"),
    resumeFailureReason: "resume_requested",
    attemptCount: 2,
    startedAt: now,
    updatedAt: now,
  });

  await executionEventRepository.create({
    id: "event_run_context_plan",
    type: "task.manager.plan_created",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:00:10.000Z"),
    payloadJson: JSON.stringify({
      message: "Manager planned delegated subagent work items for coder, reviewer",
      taskType: "coding",
      source: "manager_completed",
      childRuns: [
        {
          subagentType: "coder",
          roleId: "coder",
          state: "CREATED",
          dependsOn: [],
          whyThisInvocation: "Implementation is the next blocking step.",
          whyThisWorkItem: "Implementation is the next blocking step.",
          completionSignal: "The planned change is implemented.",
        },
        {
          subagentType: "reviewer",
          roleId: "reviewer",
          state: "QUEUED",
          dependsOn: ["coder"],
          whyThisInvocation: "Review is required after implementation finishes.",
          whyThisWorkItem: "Review is required after implementation finishes.",
          completionSignal: "A review outcome is recorded for the operator.",
        },
      ],
    }),
  });

  await executionEventRepository.create({
    id: "event_run_context_1",
    type: "executor_session.failed",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    severity: "error",
    occurredAt: new Date("2026-04-10T12:01:00.000Z"),
    payloadJson: JSON.stringify({
      message: "Tool execution timed out",
      source: "shell",
      suggestion: "Retry with narrower scope",
    }),
  });

  await executionEventRepository.create({
    id: "event_run_context_2",
    type: "tool.invoked",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:00:30.000Z"),
    payloadJson: JSON.stringify({
      tool: "rg",
      command: "rg TODO src",
    }),
  });

  await artifactRepository.create({
    id: "artifact_run_context_1",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    artifactType: "patch",
    title: "Failed patch attempt",
    storageKind: "file",
    storageRef: "/tmp/failed.patch",
    summary: "Partial patch before timeout",
    createdAt: now,
  });
  await executionEventRepository.create({
    id: "event_run_context_artifact_1",
    type: "artifact.created",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    executorSessionId: "session_run_context_1",
    artifactId: "artifact_run_context_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:00:05.000Z"),
    payloadJson: JSON.stringify({
      source: "codex",
      message: "Failed patch captured as artifact",
    }),
  });

  writeFileSync(
    runtimeContextPath,
    JSON.stringify(
      {
        task: {
          id: "task_run_context_1",
          title: "Diagnose the run",
          state: "IN_PROGRESS",
          source: "cli",
        },
        run: {
          id: "runtime_run_context_1",
          roleId: "coder",
          state: "FAILED",
          attemptCount: 2,
        },
        continuity: {
          priorSessionId: "session_prior_run_context_1",
          priorWorkdir: "/opt/acme/magister",
          resumePolicy: "resume_first",
        },
        managerPlan: {
          taskType: "coding",
          coordinationAction: "assign",
          plannedCapabilities: ["coder", "reviewer"],
        },
        orchestration: {
          nextCapability: "coder",
          completedCapabilities: ["leader"],
          pendingCapabilities: ["coder"],
          blockedCapabilities: [],
        },
        recentEvents: [
          {
            id: "event_runtime_context_1",
            type: "task.manager.plan_created",
            occurredAt: now.toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  await artifactRepository.create({
    id: "artifact_runtime_context_1",
    taskId: "task_run_context_1",
    roleRuntimeId: "runtime_run_context_1",
    artifactType: "runtime_context",
    title: "Runtime context document",
    storageKind: "file",
    storageRef: runtimeContextPath,
    summary: "Captured runtime context document for the coder run",
    createdAt: new Date("2026-04-10T12:01:30.000Z"),
  });

  await runtimeWorkspaceRepository.upsert({
    id: "workspace_runtime_run_context_1",
    runId: "runtime_run_context_1",
    taskId: "task_run_context_1",
    workspaceId: "workspace_main",
    roleId: "coder",
    strategy: "workspace_root",
    status: "completed",
    baseWorkspaceDir: "/opt/acme/magister",
    workspaceDir: "/opt/acme/magister",
    metadataPath: "/tmp/runtime-workspace-runtime_run_context_1.json",
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_context_1/context",
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: boolean;
    data: {
      run: {
        id: string;
        roleId: string;
        state: string;
        executorId?: string;
      };
      metadata: {
        attemptCount: number;
        delegationMode: string;
        sessionId: string;
        semanticRole?: string;
        workspaceStrategyOverride?: string | null;
        runtimeWorkspace?: Record<string, unknown>;
        continuityDecision?: Record<string, unknown>;
        subagentInvocation?: Record<string, unknown> | null;
        subagentInvocations?: Array<Record<string, unknown>>;
      };
      recentEvents: Array<{ id: string; type: string; message?: string }>;
      artifacts: Array<{ id: string; artifactType: string; title: string }>;
      runtimeContextArtifactId: string | null;
      runtimeContextSummary: {
        task: {
          id: string;
          title: string;
          state: string;
          source: string;
        };
        run: {
          id: string;
          roleId: string;
          state: string;
          attemptCount: number;
        };
        continuity: {
          priorSessionId: string | null;
          priorWorkdir: string | null;
          resumePolicy: string | null;
        };
        managerPlan: {
          taskType?: string;
          coordinationAction?: string;
          plannedCapabilities: string[];
        } | null;
        orchestration: {
          nextCapability: string | null;
          completedCapabilities: string[];
          pendingCapabilities: string[];
          blockedCapabilities: string[];
        };
      } | null;
      nextAction: {
        kind: string;
        message: string;
      };
    };
  };

  expect(body).toMatchObject({
    ok: true,
    data: {
      run: {
        id: "runtime_run_context_1",
        roleId: "coder",
        state: "FAILED",
        executorId: "codex",
      },
      metadata: {
        attemptCount: 2,
        delegationMode: "delegate_with_context",
        sessionId: "session_run_context_1",
        semanticRole: "delegated_subagent",
        workspaceStrategyOverride: "workspace_root",
        runtimeWorkspace: {
          runId: "runtime_run_context_1",
          strategy: "workspace_root",
          status: "completed",
          baseWorkspaceDir: "/opt/acme/magister",
          workspaceDir: "/opt/acme/magister",
          metadataPath: "/tmp/runtime-workspace-runtime_run_context_1.json",
        },
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "resume_first",
          adapterId: "codex",
          priorSessionId: "session_prior_run_context_1",
          priorWorkdir: "/opt/acme/magister",
          adapterSupportsResume: true,
          nativeResumeAttempted: true,
          fallbackToFresh: true,
          reason: "resume_requested",
        },
        subagentInvocation: {
          subagentType: "coder",
          whyThisInvocation: "Implementation is the next blocking step.",
          completionSignal: "The planned change is implemented.",
        },
        subagentInvocations: [
          {
            subagentType: "coder",
            whyThisInvocation: "Implementation is the next blocking step.",
            completionSignal: "The planned change is implemented.",
          },
          {
            subagentType: "reviewer",
            whyThisInvocation: "Review is required after implementation finishes.",
            completionSignal: "A review outcome is recorded for the operator.",
          },
        ],
      },
      runtimeContextArtifactId: "artifact_runtime_context_1",
      nextAction: {
        kind: "retry",
        message: "Retry with narrower scope",
      },
    },
  });

  expect(body.data.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "artifact_runtime_context_1",
        artifactType: "runtime_context",
        title: "Runtime context document",
        lifecycle: {
          derivedFromArtifactId: null,
          retentionClass: "runtime",
          status: "active",
          cleanupEligible: false,
        },
      }),
      expect.objectContaining({
        id: "artifact_run_context_1",
        artifactType: "patch",
        provenance: {
          sourceEventId: "event_run_context_artifact_1",
          sourceEventType: "artifact.created",
          sourceRoleRuntimeId: "runtime_run_context_1",
          sourceExecutorSessionId: "session_run_context_1",
          sourceWorkspaceId: "workspace_main",
          sourceOccurredAt: "2026-04-10T12:00:05.000Z",
          source: "codex",
        },
        lifecycle: {
          derivedFromArtifactId: null,
          retentionClass: "deliverable",
          status: "final",
          cleanupEligible: false,
        },
      }),
    ]),
  );
  expect(body.data.recentEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "event_run_context_1",
        type: "executor_session.failed",
        message: "Tool execution timed out",
      }),
      expect.objectContaining({
        id: "event_run_context_2",
        type: "tool.invoked",
      }),
    ]),
  );
  expect(body.data.runtimeContextSummary).toMatchObject({
    task: {
      id: "task_run_context_1",
      title: "Diagnose the run",
      state: "IN_PROGRESS",
      source: "cli",
    },
    run: {
      id: "runtime_run_context_1",
      roleId: "coder",
      state: "FAILED",
      attemptCount: 2,
    },
    continuity: {
      priorSessionId: "session_prior_run_context_1",
      priorWorkdir: "/opt/acme/magister",
      resumePolicy: "resume_first",
    },
    managerPlan: {
      taskType: "coding",
      coordinationAction: "assign",
      plannedCapabilities: ["coder", "reviewer"],
    },
    orchestration: {
      nextCapability: "coder",
      completedCapabilities: ["leader"],
      pendingCapabilities: ["coder"],
      blockedCapabilities: [],
    },
  });

  expect(readFileSync(runtimeContextPath, "utf8")).toContain('"runtime_run_context_1"');
});

test("run context route keeps non-codex continuity truth visible when the run rehydrates fresh", async () => {
  const now = new Date("2026-04-10T12:10:00.000Z");
  const runtimeContextPath = join(tempRoot, "runtime-context-runtime_run_context_opencode_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_run_context_opencode_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Continue API-backed coding run",
    description: "Continue API-backed coding run",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_opencode_1",
    taskId: "task_run_context_opencode_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "opencode",
    currentSessionId: "session_run_context_opencode_1",
    priorSessionId: "session_prior_run_context_opencode_1",
    priorWorkdir: "/tmp/opencode-prior-workdir",
    resumePolicy: "rehydrate_only",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-10T12:11:00.000Z"),
    completedAt: new Date("2026-04-10T12:11:00.000Z"),
  });

  writeFileSync(
    runtimeContextPath,
    JSON.stringify(
      {
        task: {
          id: "task_run_context_opencode_1",
          title: "Continue API-backed coding run",
          state: "IN_PROGRESS",
          source: "web",
        },
        run: {
          id: "runtime_run_context_opencode_1",
          roleId: "coder",
          state: "COMPLETED",
          attemptCount: 1,
        },
        continuity: {
          priorSessionId: "session_prior_run_context_opencode_1",
          priorWorkdir: "/tmp/opencode-prior-workdir",
          resumePolicy: "rehydrate_only",
        },
        managerPlan: {
          taskType: "coding",
          coordinationAction: "assign",
          plannedCapabilities: ["coder"],
        },
        orchestration: {
          nextCapability: null,
          completedCapabilities: ["leader", "coder"],
          pendingCapabilities: [],
          blockedCapabilities: [],
        },
        recentEvents: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  await artifactRepository.create({
    id: "artifact_runtime_context_opencode_1",
    taskId: "task_run_context_opencode_1",
    roleRuntimeId: "runtime_run_context_opencode_1",
    artifactType: "runtime_context",
    title: "Runtime context document",
    storageKind: "file",
    storageRef: runtimeContextPath,
    summary: "Captured runtime context document for the coder run",
    createdAt: new Date("2026-04-10T12:11:10.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_context_opencode_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        priorSessionId: "session_prior_run_context_opencode_1",
        priorWorkdir: "/tmp/opencode-prior-workdir",
        resumePolicy: "rehydrate_only",
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "rehydrate_only",
          adapterId: "opencode",
          priorSessionId: "session_prior_run_context_opencode_1",
          priorWorkdir: "/tmp/opencode-prior-workdir",
          adapterSupportsResume: false,
          nativeResumeAttempted: false,
          fallbackToFresh: false,
          reason: "rehydrate_only",
        },
      },
      runtimeContextArtifactId: "artifact_runtime_context_opencode_1",
      runtimeContextSummary: {
        continuity: {
          priorSessionId: "session_prior_run_context_opencode_1",
          priorWorkdir: "/tmp/opencode-prior-workdir",
          resumePolicy: "rehydrate_only",
        },
      },
    },
  });
});

test("run context route exposes a parsed manager decision and its raw fallback metadata", async () => {
  const now = new Date("2026-04-10T12:20:00.000Z");
  const managerOutputPath = join(tempRoot, "manager-output-runtime_run_context_manager_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_run_context_manager_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Plan the next orchestration step",
    description: "Plan the next orchestration step",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_manager_1",
    taskId: "task_run_context_manager_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_run_context_manager_1",
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
        reply: "Proceeding with the implementation plan.",
        skills: [
          {
            skillId: "implement_code",
            goal: "Implement the orchestration follow-up.",
          },
        ],
        childWorkItems: [
          {
            subagentType: "coder",
            roleId: "coder",
            skillId: "implement_code",
            goal: "Implement the orchestration follow-up.",
            dependsOn: [],
            whyThisInvocation: "Implementation is the next blocking step.",
            completionSignal: "The planned change is implemented.",
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
    id: "artifact_run_context_manager_1",
    taskId: "task_run_context_manager_1",
    roleRuntimeId: "runtime_run_context_manager_1",
    artifactType: "plan",
    title: "Manager execution note",
    storageKind: "file",
    storageRef: managerOutputPath,
    summary: "Objective - Plan the next orchestration step Outcome - Ready to dispatch.",
    createdAt: new Date("2026-04-10T12:20:30.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_context_manager_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      run: {
        id: "runtime_run_context_manager_1",
        roleId: "leader",
        managerDecision: {
          parsedDecision: {
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            confidence: "high",
            childWorkItems: [
              {
                subagentType: "coder",
                roleId: "coder",
                skillId: "implement_code",
                goal: "Implement the orchestration follow-up.",
                dependsOn: [],
                whyThisInvocation: "Implementation is the next blocking step.",
                completionSignal: "The planned change is implemented.",
              },
            ],
          },
          rawOutput: expect.stringContaining('"decision": "spawn_work_items"'),
          fallbackReason: null,
        },
        leaderDecision: {
          parsedDecision: {
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            confidence: "high",
          },
          fallbackReason: null,
        },
      },
      metadata: {
        leaderDecision: {
          parsedDecision: {
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            confidence: "high",
          },
          fallbackReason: null,
        },
        leaderDecisionProvenance: {
          source: "structured_decision",
          runId: "runtime_run_context_manager_1",
          roleId: "leader",
          fallbackReason: null,
        },
        managerDecision: {
          parsedDecision: {
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            confidence: "high",
          },
          fallbackReason: null,
        },
        managerDecisionProvenance: {
          source: "structured_decision",
          runId: "runtime_run_context_manager_1",
          roleId: "leader",
          fallbackReason: null,
        },
        subagentInvocations: [
          {
            subagentType: "coder",
            whyThisInvocation: "Implementation is the next blocking step.",
            completionSignal: "The planned change is implemented.",
          },
        ],
      },
    },
  });
});

test("run context route exposes fallback metadata when manager decision JSON is invalid", async () => {
  const now = new Date("2026-04-10T12:30:00.000Z");
  const managerOutputPath = join(tempRoot, "manager-output-runtime_run_context_manager_invalid_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_run_context_manager_invalid_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Plan with invalid output",
    description: "Plan with invalid output",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_manager_invalid_1",
    taskId: "task_run_context_manager_invalid_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_run_context_manager_invalid_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  writeFileSync(
    managerOutputPath,
    "{\"taskType\":\"coding\",\"decision\":\"spawn_work_items\"",
    "utf8",
  );

  await artifactRepository.create({
    id: "artifact_run_context_manager_invalid_1",
    taskId: "task_run_context_manager_invalid_1",
    roleRuntimeId: "runtime_run_context_manager_invalid_1",
    artifactType: "plan",
    title: "Manager execution note",
    storageKind: "file",
    storageRef: managerOutputPath,
    summary: "Objective - Plan the next orchestration step Outcome - Output was invalid JSON.",
    createdAt: new Date("2026-04-10T12:30:30.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_context_manager_invalid_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      run: {
        id: "runtime_run_context_manager_invalid_1",
        roleId: "leader",
        managerDecision: {
          parsedDecision: null,
          rawOutput: "{\"taskType\":\"coding\",\"decision\":\"spawn_work_items\"",
          fallbackReason: "invalid_json",
        },
      },
      metadata: {
        managerDecision: {
          parsedDecision: null,
          rawOutput: "{\"taskType\":\"coding\",\"decision\":\"spawn_work_items\"",
          fallbackReason: "invalid_json",
        },
        managerDecisionProvenance: {
          source: "heuristic_fallback",
          runId: "runtime_run_context_manager_invalid_1",
          roleId: "leader",
          fallbackReason: "invalid_json",
        },
      },
    },
  });
});

test("run context route exposes degraded fallback metadata when the manager artifact file is unreadable", async () => {
  const now = new Date("2026-04-10T12:40:00.000Z");
  const missingManagerOutputPath = join(tempRoot, "missing-manager-output-runtime_run_context_manager_missing_1.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_run_context_manager_missing_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Plan with missing file",
    description: "Plan with missing file",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_manager_missing_1",
    taskId: "task_run_context_manager_missing_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_run_context_manager_missing_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  await artifactRepository.create({
    id: "artifact_run_context_manager_missing_1",
    taskId: "task_run_context_manager_missing_1",
    roleRuntimeId: "runtime_run_context_manager_missing_1",
    artifactType: "plan",
    title: "Manager execution note",
    storageKind: "file",
    storageRef: missingManagerOutputPath,
    summary: "Objective - Plan the next orchestration step Outcome - Fallback summary only.",
    createdAt: new Date("2026-04-10T12:40:30.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_context_manager_missing_1/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      run: {
        id: "runtime_run_context_manager_missing_1",
        roleId: "leader",
        managerDecision: {
          parsedDecision: null,
          rawOutput: "Objective - Plan the next orchestration step Outcome - Fallback summary only.",
          fallbackReason: "artifact_file_unreadable",
          sourceKind: "artifact_summary",
          sourceDegraded: true,
        },
      },
      metadata: {
        managerDecision: {
          parsedDecision: null,
          rawOutput: "Objective - Plan the next orchestration step Outcome - Fallback summary only.",
          fallbackReason: "artifact_file_unreadable",
          sourceKind: "artifact_summary",
          sourceDegraded: true,
        },
        managerDecisionProvenance: {
          source: "heuristic_fallback",
          runId: "runtime_run_context_manager_missing_1",
          roleId: "leader",
          fallbackReason: "artifact_file_unreadable",
        },
      },
    },
  });
});

test("run context route preserves role identity and distinct invocations for shared subagentType", async () => {
  const now = new Date("2026-04-10T12:50:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_run_context_distinct_invocations_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Split coder invocations",
    description: "Split coder invocations",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_distinct_coder_ui",
    taskId: "task_run_context_distinct_invocations_1",
    roleId: "coder_ui",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_run_context_distinct_coder_ui",
    attemptCount: 1,
    startedAt: now,
    updatedAt: new Date("2026-04-10T12:50:20.000Z"),
    completedAt: new Date("2026-04-10T12:50:20.000Z"),
  });

  await roleRuntimeRepository.create({
    id: "runtime_run_context_distinct_coder_api",
    taskId: "task_run_context_distinct_invocations_1",
    roleId: "coder_api",
    state: "CREATED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    currentSessionId: "session_run_context_distinct_coder_api",
    attemptCount: 0,
    startedAt: now,
    updatedAt: new Date("2026-04-10T12:50:30.000Z"),
  });

  await executionEventRepository.create({
    id: "event_run_context_distinct_plan",
    type: "task.manager.plan_created",
    taskId: "task_run_context_distinct_invocations_1",
    roleRuntimeId: "runtime_run_context_distinct_coder_api",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:50:05.000Z"),
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
    url: "/runs/runtime_run_context_distinct_coder_api/context",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      run: {
        id: "runtime_run_context_distinct_coder_api",
        roleId: "coder_api",
      },
      metadata: {
        semanticRole: "delegated_subagent",
        subagentInvocation: {
          roleId: "coder_api",
          subagentType: "coder",
          whyThisInvocation: "API implementation follows UI.",
          completionSignal: "API patch is ready.",
        },
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
      },
    },
  });
});
