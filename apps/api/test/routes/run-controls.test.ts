import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";
import { setResumeLeaderFromCheckpointForTest } from "../../src/services/run-control-service";

const tempRoot = join(process.cwd(), ".tmp-run-controls-db");

function createStubExecutorConfig() {
  return {
    executors: {
      codex: {
        configuredModel: "gpt-5.3-codex",
        commandPath: "__stub__",
      },
      qoder: {
        configuredModel: "qoder-review",
        commandPath: "qoder",
      },
    },
    roleRouting: {
      manager: "codex",
      architect: "codex",
      coder: "codex",
      reviewer: "qoder",
      lander: "codex",
    },
    providers: {},
    models: {},
    bindings: {},
  };
}

function initializeGitWorkspace(path: string) {
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Magister Test"], {
    cwd: path,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "magister-tests@example.com"], {
    cwd: path,
    stdio: "ignore",
  });
  writeFileSync(join(path, "README.md"), "# runtime workspace fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: path, stdio: "ignore" });
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `run-controls-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `run-controls-executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  writeFileSync(
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH,
    JSON.stringify(createStubExecutorConfig()),
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /runs/:runId/artifacts returns artifacts scoped to the run", async () => {
  const now = new Date("2026-04-13T14:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_run_artifacts_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Inspect run artifacts",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_artifacts_1",
    taskId: "task_run_artifacts_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_artifacts_2",
    taskId: "task_run_artifacts_1",
    roleId: "reviewer",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await artifactRepository.create({
    id: "artifact_run_artifacts_runtime_context_1",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_1",
    artifactType: "runtime_context",
    title: "Coder runtime context",
    storageKind: "file",
    storageRef: "/tmp/coder-runtime-context.json",
    summary: "runtime context",
    createdAt: new Date("2026-04-13T14:00:09.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_run_artifacts_0",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_1",
    artifactType: "execution_log",
    title: "Coder stderr old",
    storageKind: "file",
    storageRef: "/tmp/coder-stderr-old.log",
    summary: "stderr log old",
    createdAt: new Date("2026-04-13T14:00:08.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_run_artifacts_1",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_1",
    artifactType: "execution_log",
    title: "Coder stderr",
    storageKind: "file",
    storageRef: "/tmp/coder-stderr.log",
    summary: "stderr log",
    createdAt: new Date("2026-04-13T14:00:10.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_run_artifacts_2",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_2",
    artifactType: "review",
    title: "Reviewer note",
    storageKind: "file",
    storageRef: "/tmp/reviewer-note.md",
    summary: "review note",
    createdAt: new Date("2026-04-13T14:00:20.000Z"),
  });
  await executionEventRepository.create({
    id: "event_run_artifacts_0",
    type: "executor_session.completed",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_1",
    executorSessionId: "session_run_artifacts_1",
    artifactId: "artifact_run_artifacts_0",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-13T14:00:08.500Z"),
    payloadJson: JSON.stringify({
      source: "codex",
      message: "Older coder stderr captured",
    }),
  });
  await executionEventRepository.create({
    id: "event_run_artifacts_1",
    type: "executor_session.completed",
    taskId: "task_run_artifacts_1",
    roleRuntimeId: "runtime_run_artifacts_1",
    executorSessionId: "session_run_artifacts_1",
    artifactId: "artifact_run_artifacts_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-13T14:00:11.000Z"),
    payloadJson: JSON.stringify({
      source: "codex",
      message: "Coder stderr captured",
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_artifacts_1/artifacts",
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: boolean;
    data: {
      runId: string;
      items: Array<Record<string, unknown>>;
    };
  };
  expect(body).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_run_artifacts_1",
    },
  });
  expect(body.data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "artifact_run_artifacts_1",
        roleRuntimeId: "runtime_run_artifacts_1",
        title: "Coder stderr",
        provenance: {
          sourceEventId: "event_run_artifacts_1",
          sourceEventType: "executor_session.completed",
          sourceRoleRuntimeId: "runtime_run_artifacts_1",
          sourceExecutorSessionId: "session_run_artifacts_1",
          sourceWorkspaceId: "workspace_main",
          sourceOccurredAt: "2026-04-13T14:00:11.000Z",
          source: "codex",
        },
        lifecycle: {
          derivedFromArtifactId: "artifact_run_artifacts_runtime_context_1",
          retentionClass: "diagnostic",
          status: "active",
          cleanupEligible: true,
        },
      }),
      expect.objectContaining({
        id: "artifact_run_artifacts_0",
        lifecycle: {
          derivedFromArtifactId: null,
          retentionClass: "diagnostic",
          status: "superseded",
          cleanupEligible: true,
        },
      }),
      expect.objectContaining({
        id: "artifact_run_artifacts_runtime_context_1",
        lifecycle: {
          derivedFromArtifactId: null,
          retentionClass: "runtime",
          status: "active",
          cleanupEligible: false,
        },
      }),
    ]),
  );
});

test("POST /runs/:runId/artifacts/cleanup deletes only cleanup-eligible artifacts for the run", async () => {
  const now = new Date("2026-04-13T14:05:00.000Z");
  const logPath = join(tempRoot, "cleanup-coder-stderr.log");
  const runtimeContextPath = join(tempRoot, "cleanup-runtime-context.json");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  writeFileSync(logPath, "stderr log", "utf8");
  writeFileSync(runtimeContextPath, "{\"ok\":true}", "utf8");

  await taskRepository.create({
    id: "task_run_artifacts_cleanup_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Cleanup run artifacts",
    state: "COMPLETED",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_artifacts_cleanup_1",
    taskId: "task_run_artifacts_cleanup_1",
    roleId: "coder",
    state: "COMPLETED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await artifactRepository.create({
    id: "artifact_run_cleanup_log_1",
    taskId: "task_run_artifacts_cleanup_1",
    roleRuntimeId: "runtime_run_artifacts_cleanup_1",
    artifactType: "execution_log",
    title: "Coder stderr",
    storageKind: "file",
    storageRef: logPath,
    summary: "stderr log",
    createdAt: new Date("2026-04-13T14:05:10.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_run_cleanup_runtime_context_1",
    taskId: "task_run_artifacts_cleanup_1",
    roleRuntimeId: "runtime_run_artifacts_cleanup_1",
    artifactType: "runtime_context",
    title: "Coder runtime context",
    storageKind: "file",
    storageRef: runtimeContextPath,
    summary: "runtime context",
    createdAt: new Date("2026-04-13T14:05:09.000Z"),
  });

  const app = buildApp();
  const cleanupResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_run_artifacts_cleanup_1/artifacts/cleanup",
  });

  expect(cleanupResponse.statusCode).toBe(200);
  expect(cleanupResponse.json()).toMatchObject({
    ok: true,
    data: {
      scope: "run",
      runId: "runtime_run_artifacts_cleanup_1",
      deletedCount: 1,
      deletedArtifactIds: ["artifact_run_cleanup_log_1"],
      keptArtifactIds: ["artifact_run_cleanup_runtime_context_1"],
    },
  });
  expect(existsSync(logPath)).toBe(false);
  expect(existsSync(runtimeContextPath)).toBe(true);

  const listResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_artifacts_cleanup_1/artifacts",
  });
  expect(listResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          id: "artifact_run_cleanup_runtime_context_1",
        }),
      ],
    },
  });
  expect((listResponse.json() as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id)).not.toContain(
    "artifact_run_cleanup_log_1",
  );
});

test("POST /runs/:runId/retry requeues and redispatches a failed run", async () => {
  const now = new Date("2026-04-13T14:10:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();

  await taskRepository.create({
    id: "task_run_retry_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Retry failed run",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_retry_1",
    taskId: "task_run_retry_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_failed_retry_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/runs/runtime_run_retry_1/retry",
    payload: {
      workspaceStrategyOverride: "workspace_root",
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      ok: true,
      runId: "runtime_run_retry_1",
      adapterId: "codex",
      state: "COMPLETED",
    },
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_retry_1/context",
  });

  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        workspaceStrategyOverride: "workspace_root",
        runtimeWorkspace: {
          requestedStrategy: "workspace_root",
          strategy: "workspace_root",
          decisionReason: "operator_override",
          fallbackReason: null,
        },
      },
    },
  });
});

test("POST /runs/:runId/retry clears a persisted workspace override when payload sets null", async () => {
  const now = new Date("2026-04-13T14:11:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const cleanWorkspaceDir = join(tempRoot, "workspace-retry-clear-override");

  mkdirSync(cleanWorkspaceDir, { recursive: true });
  initializeGitWorkspace(cleanWorkspaceDir);
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: cleanWorkspaceDir,
  });

  await taskRepository.create({
    id: "task_run_retry_clear_override_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Retry failed run after clearing workspace override",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_retry_clear_override_1",
    taskId: "task_run_retry_clear_override_1",
    roleId: "coder",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "codex",
    currentSessionId: "session_failed_retry_clear_override_1",
    workspaceStrategyOverride: "workspace_root",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/runs/runtime_run_retry_clear_override_1/retry",
    payload: {
      workspaceStrategyOverride: null,
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      ok: true,
      runId: "runtime_run_retry_clear_override_1",
      adapterId: "codex",
      state: "COMPLETED",
    },
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_retry_clear_override_1/context",
  });

  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        workspaceStrategyOverride: null,
        runtimeWorkspace: {
          requestedStrategy: "git_worktree",
          strategy: "git_worktree",
          decisionReason: "coding_lane_default",
          fallbackReason: null,
        },
      },
    },
  });
});

test("POST /runs/:runId/retry preserves rehydrate-only continuity for non-codex runtimes", async () => {
  const now = new Date("2026-04-13T14:12:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();

  await taskRepository.create({
    id: "task_run_retry_rehydrate_only_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Retry failed reviewer run",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_retry_rehydrate_only_1",
    taskId: "task_run_retry_rehydrate_only_1",
    roleId: "reviewer",
    state: "FAILED",
    delegationMode: "delegate_with_context",
    activeExecutorId: "qoder",
    currentSessionId: "session_failed_retry_rehydrate_only_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/runs/runtime_run_retry_rehydrate_only_1/retry",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      ok: true,
      runId: "runtime_run_retry_rehydrate_only_1",
      adapterId: "qoder",
      state: "COMPLETED",
    },
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_run_retry_rehydrate_only_1/context",
  });

  expect(contextResponse.statusCode).toBe(200);
  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        priorSessionId: "session_failed_retry_rehydrate_only_1",
        resumePolicy: "rehydrate_only",
        resumeAttemptedAt: null,
      },
    },
  });
});

test("POST /runs/:runId/continue resumes orchestration from the provided run", async () => {
  const now = new Date("2026-04-13T14:20:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();

  await taskRepository.create({
    id: "task_run_continue_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Implement and review this change",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_run_continue_manager_1",
    taskId: "task_run_continue_1",
    roleId: "leader",
    state: "COMPLETED",
    delegationMode: "delegate_fresh",
    activeExecutorId: "codex",
    currentSessionId: "session_continue_manager_1",
    attemptCount: 1,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
  });

  // Inject a stub so the test does not invoke the real leader loop
  setResumeLeaderFromCheckpointForTest(async () => ({
    ok: true,
    reason: "resumed",
    turnCount: 0,
  }));

  try {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/runs/runtime_run_continue_manager_1/continue",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        message: expect.any(String),
      },
    });
  } finally {
    setResumeLeaderFromCheckpointForTest();
  }
});
