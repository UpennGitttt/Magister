import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { cleanupTaskArtifacts } from "../../src/services/cleanup-artifacts-service";
import { runArtifactRetentionTick } from "../../src/services/artifact-retention-service";

const tempRoot = join(process.cwd(), ".tmp-artifact-retention-db");
const ORIGINAL_RETENTION_GRACE_MS = process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `artifact-retention-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS = "60000";
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS = ORIGINAL_RETENTION_GRACE_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("runArtifactRetentionTick cleans cleanup-eligible artifacts for stale completed and blocked tasks", async () => {
  const taskRepository = new TaskRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const completedAt = new Date("2026-04-14T08:00:00.000Z");
  const blockedAt = new Date("2026-04-14T08:01:00.000Z");
  const recentAt = new Date("2026-04-14T08:09:30.000Z");
  const now = new Date("2026-04-14T08:10:00.000Z");

  await taskRepository.create({
    id: "task_artifact_retention_completed_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Completed task",
    state: "COMPLETED",
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt,
  });
  await taskRepository.create({
    id: "task_artifact_retention_blocked_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Blocked task",
    state: "BLOCKED",
    createdAt: blockedAt,
    updatedAt: blockedAt,
  });
  await taskRepository.create({
    id: "task_artifact_retention_recent_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Recent terminal task",
    state: "COMPLETED",
    createdAt: recentAt,
    updatedAt: recentAt,
    completedAt: recentAt,
  });

  const completedLogPath = join(tempRoot, "artifact-retention-completed.log");
  const completedReviewPath = join(tempRoot, "artifact-retention-completed-review.md");
  const blockedLogPath = join(tempRoot, "artifact-retention-blocked.log");
  const recentLogPath = join(tempRoot, "artifact-retention-recent.log");

  writeFileSync(completedLogPath, "completed log", "utf8");
  writeFileSync(completedReviewPath, "completed review", "utf8");
  writeFileSync(blockedLogPath, "blocked log", "utf8");
  writeFileSync(recentLogPath, "recent log", "utf8");

  await artifactRepository.create({
    id: "artifact_artifact_retention_completed_log_1",
    taskId: "task_artifact_retention_completed_1",
    artifactType: "execution_log",
    title: "Completed diagnostic log",
    storageKind: "file",
    storageRef: completedLogPath,
    createdAt: new Date("2026-04-14T08:00:05.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_artifact_retention_completed_review_1",
    taskId: "task_artifact_retention_completed_1",
    artifactType: "review",
    title: "Completed review",
    storageKind: "file",
    storageRef: completedReviewPath,
    createdAt: new Date("2026-04-14T08:00:06.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_artifact_retention_blocked_log_1",
    taskId: "task_artifact_retention_blocked_1",
    artifactType: "execution_log",
    title: "Blocked diagnostic log",
    storageKind: "file",
    storageRef: blockedLogPath,
    createdAt: new Date("2026-04-14T08:01:05.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_artifact_retention_recent_log_1",
    taskId: "task_artifact_retention_recent_1",
    artifactType: "execution_log",
    title: "Recent diagnostic log",
    storageKind: "file",
    storageRef: recentLogPath,
    createdAt: new Date("2026-04-14T08:09:35.000Z"),
  });

  const result = await runArtifactRetentionTick({
    now: () => now,
  });

  expect(result.scannedTaskCount).toBe(3);
  expect(result.cleanedTaskIds).toEqual(
    expect.arrayContaining([
      "task_artifact_retention_completed_1",
      "task_artifact_retention_blocked_1",
    ]),
  );
  expect(result.deletedArtifactIds).toEqual(
    expect.arrayContaining([
      "artifact_artifact_retention_completed_log_1",
      "artifact_artifact_retention_blocked_log_1",
    ]),
  );
  expect(existsSync(completedLogPath)).toBe(false);
  expect(existsSync(completedReviewPath)).toBe(true);
  expect(existsSync(blockedLogPath)).toBe(false);
  expect(existsSync(recentLogPath)).toBe(true);
  expect(await artifactRepository.getById("artifact_artifact_retention_completed_log_1")).toBeUndefined();
  expect((await artifactRepository.getById("artifact_artifact_retention_completed_review_1"))?.id).toBe(
    "artifact_artifact_retention_completed_review_1",
  );
  expect(await artifactRepository.getById("artifact_artifact_retention_blocked_log_1")).toBeUndefined();
  expect((await artifactRepository.getById("artifact_artifact_retention_recent_log_1"))?.id).toBe(
    "artifact_artifact_retention_recent_log_1",
  );

  const cleanupEvents = (await executionEventRepository.listAll()).filter(
    (event) => event.type === "task.artifacts.cleaned",
  );
  expect(cleanupEvents).toHaveLength(2);
  expect(cleanupEvents.map((event) => event.taskId)).toEqual(
    expect.arrayContaining([
      "task_artifact_retention_completed_1",
      "task_artifact_retention_blocked_1",
    ]),
  );
});

test("runArtifactRetentionTick uses a grace-overlapped checkpoint window instead of rescanning all terminal tasks", async () => {
  const taskRepository = new TaskRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const oldAt = new Date("2026-04-14T08:00:00.000Z");
  const recentAt = new Date("2026-04-14T08:09:30.000Z");

  await taskRepository.create({
    id: "task_artifact_retention_checkpoint_old_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Old completed task",
    state: "COMPLETED",
    createdAt: oldAt,
    updatedAt: oldAt,
    completedAt: oldAt,
  });
  await taskRepository.create({
    id: "task_artifact_retention_checkpoint_recent_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Recent completed task",
    state: "COMPLETED",
    createdAt: recentAt,
    updatedAt: recentAt,
    completedAt: recentAt,
  });

  const oldLogPath = join(tempRoot, "artifact-retention-checkpoint-old.log");
  const recentLogPath = join(tempRoot, "artifact-retention-checkpoint-recent.log");
  writeFileSync(oldLogPath, "old log", "utf8");
  writeFileSync(recentLogPath, "recent log", "utf8");

  await artifactRepository.create({
    id: "artifact_artifact_retention_checkpoint_old_log_1",
    taskId: "task_artifact_retention_checkpoint_old_1",
    artifactType: "execution_log",
    title: "Old diagnostic log",
    storageKind: "file",
    storageRef: oldLogPath,
    createdAt: new Date("2026-04-14T08:00:05.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_artifact_retention_checkpoint_recent_log_1",
    taskId: "task_artifact_retention_checkpoint_recent_1",
    artifactType: "execution_log",
    title: "Recent diagnostic log",
    storageKind: "file",
    storageRef: recentLogPath,
    createdAt: new Date("2026-04-14T08:09:35.000Z"),
  });

  const firstResult = await runArtifactRetentionTick({
    now: () => new Date("2026-04-14T08:10:00.000Z"),
  });
  expect(firstResult.scannedTaskCount).toBe(2);
  expect(firstResult.cleanedTaskIds).toEqual(["task_artifact_retention_checkpoint_old_1"]);
  expect(existsSync(oldLogPath)).toBe(false);
  expect(existsSync(recentLogPath)).toBe(true);

  const secondResult = await runArtifactRetentionTick({
    now: () => new Date("2026-04-14T08:11:00.000Z"),
  });
  expect(secondResult.scannedTaskCount).toBe(1);
  expect(secondResult.cleanedTaskIds).toEqual(["task_artifact_retention_checkpoint_recent_1"]);
  expect(existsSync(recentLogPath)).toBe(false);

  const tickEvents = (await executionEventRepository.listAll())
    .filter((event) => event.type === "worker.artifact_retention.tick")
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  expect(tickEvents).toHaveLength(2);
  expect(
    tickEvents.map((event) => JSON.parse(event.payloadJson ?? "{}") as Record<string, unknown>),
  ).toEqual([
    expect.objectContaining({
      scannedTaskCount: 2,
      cleanedTaskIds: ["task_artifact_retention_checkpoint_old_1"],
    }),
    expect.objectContaining({
      scannedTaskCount: 1,
      cleanedTaskIds: ["task_artifact_retention_checkpoint_recent_1"],
    }),
  ]);
});

test("runArtifactRetentionTick records task-scoped failures and continues cleaning other eligible tasks", async () => {
  const taskRepository = new TaskRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const now = new Date("2026-04-14T08:20:00.000Z");

  await taskRepository.create({
    id: "task_artifact_retention_failure_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Failing completed task",
    state: "COMPLETED",
    createdAt: new Date("2026-04-14T08:00:00.000Z"),
    updatedAt: new Date("2026-04-14T08:00:00.000Z"),
    completedAt: new Date("2026-04-14T08:00:00.000Z"),
  });
  await taskRepository.create({
    id: "task_artifact_retention_success_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Successful completed task",
    state: "COMPLETED",
    createdAt: new Date("2026-04-14T08:01:00.000Z"),
    updatedAt: new Date("2026-04-14T08:01:00.000Z"),
    completedAt: new Date("2026-04-14T08:01:00.000Z"),
  });

  const failingLogPath = join(tempRoot, "artifact-retention-failing.log");
  const successLogPath = join(tempRoot, "artifact-retention-success.log");
  writeFileSync(failingLogPath, "failing log", "utf8");
  writeFileSync(successLogPath, "success log", "utf8");

  await artifactRepository.create({
    id: "artifact_artifact_retention_failure_log_1",
    taskId: "task_artifact_retention_failure_1",
    artifactType: "execution_log",
    title: "Failing diagnostic log",
    storageKind: "file",
    storageRef: failingLogPath,
    createdAt: new Date("2026-04-14T08:00:05.000Z"),
  });
  await artifactRepository.create({
    id: "artifact_artifact_retention_success_log_1",
    taskId: "task_artifact_retention_success_1",
    artifactType: "execution_log",
    title: "Success diagnostic log",
    storageKind: "file",
    storageRef: successLogPath,
    createdAt: new Date("2026-04-14T08:01:05.000Z"),
  });

  const result = await runArtifactRetentionTick({
    now: () => now,
    cleanupTaskArtifacts: async (taskId) => {
      if (taskId === "task_artifact_retention_failure_1") {
        throw new Error("simulated retention failure");
      }

      return cleanupTaskArtifacts(taskId);
    },
  });

  expect(result.cleanedTaskIds).toEqual(["task_artifact_retention_success_1"]);
  expect(result.failedTaskIds).toEqual(["task_artifact_retention_failure_1"]);
  expect(existsSync(failingLogPath)).toBe(true);
  expect(existsSync(successLogPath)).toBe(false);

  const failureEvents = (await executionEventRepository.listAll()).filter(
    (event) => event.type === "worker.artifact_retention.failed",
  );
  expect(failureEvents).toHaveLength(1);
  expect(failureEvents[0]).toMatchObject({
    taskId: "task_artifact_retention_failure_1",
    severity: "error",
  });
  expect(JSON.parse(failureEvents[0]?.payloadJson ?? "{}")).toMatchObject({
    failedTaskId: "task_artifact_retention_failure_1",
    error: "simulated retention failure",
    trigger: "artifact_retention_worker",
  });

  const latestTickEvent = (await executionEventRepository.listAll())
    .filter((event) => event.type === "worker.artifact_retention.tick")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  expect(JSON.parse(latestTickEvent?.payloadJson ?? "{}")).toMatchObject({
    cleanedTaskIds: ["task_artifact_retention_success_1"],
    failedTaskIds: ["task_artifact_retention_failure_1"],
  });
});
