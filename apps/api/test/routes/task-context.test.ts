import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-task-context-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `task-context-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("task context routes expose artifacts and memory-linked view data", async () => {
  const now = new Date("2026-04-10T11:00:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  await taskRepository.create({
    id: "task_context_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Inspect task context",
    description: "Inspect task context",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_context_1",
    taskId: "task_context_1",
    roleId: "architect",
    state: "RUNNING",
    activeExecutorId: "codex",
    currentSessionId: "session_context_1",
    attemptCount: 1,
    updatedAt: now,
  });

  await artifactRepository.create({
    id: "artifact_context_1",
    taskId: "task_context_1",
    roleRuntimeId: "runtime_context_1",
    artifactType: "design_doc",
    title: "Architecture notes",
    storageKind: "file",
    storageRef: "/tmp/architecture-notes.md",
    summary: "Initial architecture notes",
    createdAt: now,
  });

  await executionEventRepository.create({
    id: "event_context_1",
    type: "memory.candidate_created",
    taskId: "task_context_1",
    roleRuntimeId: "runtime_context_1",
    severity: "info",
    occurredAt: new Date("2026-04-10T11:01:00.000Z"),
    payloadJson: JSON.stringify({
      title: "Repo prefers Bun workspaces",
      summary: "Remember Bun-based workspace commands for future tasks",
      scope: "repo",
      status: "candidate",
    }),
  });
  await executionEventRepository.create({
    id: "event_context_artifact_1",
    type: "artifact.created",
    taskId: "task_context_1",
    roleRuntimeId: "runtime_context_1",
    executorSessionId: "session_context_1",
    artifactId: "artifact_context_1",
    workspaceId: "workspace_main",
    severity: "info",
    occurredAt: new Date("2026-04-10T11:00:30.000Z"),
    payloadJson: JSON.stringify({
      source: "codex",
      message: "Architecture notes artifact saved",
    }),
  });

  const app = buildApp();

  const artifactsResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_context_1/artifacts",
  });

  const memoryResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_context_1/memory",
  });

  expect(artifactsResponse.statusCode).toBe(200);
  expect(artifactsResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        {
          id: "artifact_context_1",
          artifactType: "design_doc",
          title: "Architecture notes",
          summary: "Initial architecture notes",
          provenance: {
            sourceEventId: "event_context_artifact_1",
            sourceEventType: "artifact.created",
            sourceRoleRuntimeId: "runtime_context_1",
            sourceExecutorSessionId: "session_context_1",
            sourceWorkspaceId: "workspace_main",
            sourceOccurredAt: "2026-04-10T11:00:30.000Z",
            source: "codex",
          },
          lifecycle: {
            derivedFromArtifactId: null,
            retentionClass: "deliverable",
            status: "final",
            cleanupEligible: false,
          },
        },
      ],
    },
  });

  expect(memoryResponse.statusCode).toBe(200);
  expect(memoryResponse.json()).toMatchObject({
    ok: true,
    data: {
      linkedMemories: {
        project: [
          {
            slot: "linked_artifact",
            summary: "Initial architecture notes",
          },
        ],
        repo: [],
        task: [
          {
            slot: "task_brief",
            summary: "Inspect task context",
          },
        ],
      },
      candidates: [
        {
          id: "event_context_1",
          title: "Repo prefers Bun workspaces",
          scope: "repo",
          status: "candidate",
        },
      ],
    },
  });
});

test("POST /tasks/:taskId/artifacts/cleanup deletes only cleanup-eligible artifacts across the task", async () => {
  const now = new Date("2026-04-10T11:10:00.000Z");
  const logPath = join(tempRoot, "task-cleanup.log");
  const reviewPath = join(tempRoot, "task-review.md");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();

  writeFileSync(logPath, "debug log", "utf8");
  writeFileSync(reviewPath, "review", "utf8");

  await taskRepository.create({
    id: "task_context_cleanup_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Cleanup task artifacts",
    description: "Cleanup task artifacts",
    state: "COMPLETED",
    createdAt: now,
    updatedAt: now,
  });
  await roleRuntimeRepository.create({
    id: "runtime_context_cleanup_1",
    taskId: "task_context_cleanup_1",
    roleId: "reviewer",
    state: "COMPLETED",
    activeExecutorId: "qoder",
    currentSessionId: "session_context_cleanup_1",
    attemptCount: 1,
    updatedAt: now,
    completedAt: now,
  });
  await artifactRepository.create({
    id: "artifact_context_cleanup_log_1",
    taskId: "task_context_cleanup_1",
    roleRuntimeId: "runtime_context_cleanup_1",
    artifactType: "execution_log",
    title: "Reviewer debug log",
    storageKind: "file",
    storageRef: logPath,
    summary: "debug log",
    createdAt: new Date("2026-04-10T11:10:10.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_context_cleanup_review_1",
    taskId: "task_context_cleanup_1",
    roleRuntimeId: "runtime_context_cleanup_1",
    artifactType: "review",
    title: "Reviewer verdict",
    storageKind: "file",
    storageRef: reviewPath,
    summary: "review verdict",
    createdAt: new Date("2026-04-10T11:10:11.000Z"),
  });

  const app = buildApp();
  const cleanupResponse = await app.inject({
    method: "POST",
    url: "/tasks/task_context_cleanup_1/artifacts/cleanup",
  });

  expect(cleanupResponse.statusCode).toBe(200);
  expect(cleanupResponse.json()).toMatchObject({
    ok: true,
    data: {
      scope: "task",
      taskId: "task_context_cleanup_1",
      deletedCount: 1,
      deletedArtifactIds: ["artifact_context_cleanup_log_1"],
      keptArtifactIds: ["artifact_context_cleanup_review_1"],
    },
  });
  expect(existsSync(logPath)).toBe(false);
  expect(existsSync(reviewPath)).toBe(true);

  const artifactsResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_context_cleanup_1/artifacts",
  });
  expect(artifactsResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          id: "artifact_context_cleanup_review_1",
        }),
      ],
    },
  });
  expect((artifactsResponse.json() as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id)).not.toContain(
    "artifact_context_cleanup_log_1",
  );
});
