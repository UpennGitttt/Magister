import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { LocalObservabilityAdapter } from "../../src/observability/local-observability-adapter";

const tempRoot = join(process.cwd(), ".tmp-observability-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `observability-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("local observability adapter writes events and refreshes read models", async () => {
  const now = new Date("2026-04-10T09:30:00.000Z");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const approvalRepository = new ApprovalRepository();
  const artifactRepository = new ArtifactRepository();

  await taskRepository.create({
    id: "task_obs_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Observe a task end-to-end",
    description: "Observe a task end-to-end",
    state: "IN_PROGRESS",
    createdAt: now,
    updatedAt: now,
  });

  await roleRuntimeRepository.create({
    id: "runtime_obs_1",
    taskId: "task_obs_1",
    roleId: "leader",
    state: "RUNNING",
    activeExecutorId: "codex",
    currentSessionId: "session_obs_1",
    attemptCount: 1,
    updatedAt: now,
  });

  await approvalRepository.create({
    id: "approval_obs_1",
    taskId: "task_obs_1",
    roleRuntimeId: "runtime_obs_1",
    approvalType: "merge",
    state: "PENDING",
    requestedAt: now,
  });

  await artifactRepository.create({
    id: "artifact_obs_1",
    taskId: "task_obs_1",
    roleRuntimeId: "runtime_obs_1",
    artifactType: "pull_request",
    title: "Draft PR",
    storageKind: "url",
    storageRef: "https://github.com/example/repo/pull/1",
    summary: "Ready for review",
    createdAt: now,
  });

  const adapter = new LocalObservabilityAdapter();
  const result = await adapter.recordEvent({
    id: "event_obs_1",
    type: "task.blocked",
    taskId: "task_obs_1",
    roleRuntimeId: "runtime_obs_1",
    severity: "error",
    occurredAt: new Date("2026-04-10T09:31:00.000Z"),
    payloadJson: JSON.stringify({ message: "Waiting on approval" }),
  });

  expect(result.taskSummary).toMatchObject({
    id: "task_obs_1",
    latestRunId: "runtime_obs_1",
    latestBlocker: "Waiting on approval",
    approvalState: "PENDING",
    latestArtifactSummary: "Ready for review",
    prUrl: "https://github.com/example/repo/pull/1",
  });

  expect(result.runSummary).toMatchObject({
    id: "runtime_obs_1",
    taskId: "task_obs_1",
    roleId: "leader",
    executorId: "codex",
    sessionId: "session_obs_1",
    lastError: "Waiting on approval",
  });

  expect(result.event.id).toBe("event_obs_1");
});
