import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "task-media-repo-test-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "control.sqlite");
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  await rm(tempDir, { recursive: true, force: true });
});

test("TaskMediaRepository scopes lookups by taskId and mediaId", async () => {
  const { TaskMediaRepository } = await import("../../src/repositories/task-media-repository");
  const repo = new TaskMediaRepository();

  await repo.create({
    id: "media_one",
    taskId: "task_a",
    requestId: "req_a",
    roleRuntimeId: "rt_leader_a",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    filename: "shot.png",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 67,
    contentHash: "hash-one",
    storagePath: join(tempDir, "shot.png"),
    width: 1,
    height: 1,
    durationMs: null,
    caption: "Current UI",
    display: "inline",
    status: "ready",
    metadataJson: null,
    createdAt: new Date(1),
    deletedAt: null,
    retainedUntil: null,
  });

  const found = await repo.getByTaskIdAndId("task_a", "media_one");
  expect(found?.filename).toBe("shot.png");
  expect(found?.storagePath).toContain("shot.png");

  await repo.create({
    id: "media_one",
    taskId: "task_b",
    requestId: "req_b",
    roleRuntimeId: "rt_leader_b",
    sourceToolCallId: "tu_media_b",
    sourceType: "tool_path",
    filename: "other.png",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 67,
    contentHash: "hash-two",
    storagePath: join(tempDir, "other.png"),
    width: null,
    height: null,
    durationMs: null,
    caption: null,
    display: "inline",
    status: "ready",
    metadataJson: null,
    createdAt: new Date(2),
    deletedAt: null,
    retainedUntil: null,
  });

  expect((await repo.listByTaskId("task_a")).map((m) => m.filename)).toEqual(["shot.png"]);
  expect((await repo.getByTaskIdAndId("task_b", "media_one"))?.filename).toBe("other.png");

  await repo.markDeleted("task_a", "media_one", new Date(3));
  expect((await repo.getByTaskIdAndId("task_a", "media_one"))?.status).toBe("deleted");
});

test("listByTaskIdAndRequestId scopes media to a single turn (requestId)", async () => {
  const { TaskMediaRepository } = await import("../../src/repositories/task-media-repository");
  const repo = new TaskMediaRepository();

  const base = {
    roleRuntimeId: "rt",
    sourceToolCallId: "tu",
    sourceType: "tool_path" as const,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 1,
    contentHash: "h",
    width: null,
    height: null,
    durationMs: null,
    caption: null,
    display: "inline",
    status: "ready",
    metadataJson: null,
    deletedAt: null,
    retainedUntil: null,
  };

  // Prior turn (req_1) and current turn (req_2) under the same task.
  await repo.create({ ...base, id: "m_prior", taskId: "task_x", requestId: "req_1", filename: "prior.png", storagePath: join(tempDir, "prior.png"), createdAt: new Date(1) });
  await repo.create({ ...base, id: "m_cur_a", taskId: "task_x", requestId: "req_2", filename: "cur_a.png", storagePath: join(tempDir, "cur_a.png"), createdAt: new Date(2) });
  await repo.create({ ...base, id: "m_cur_b", taskId: "task_x", requestId: "req_2", filename: "cur_b.png", storagePath: join(tempDir, "cur_b.png"), createdAt: new Date(3) });
  // Same requestId value but different task — must NOT leak across tasks.
  await repo.create({ ...base, id: "m_other", taskId: "task_y", requestId: "req_2", filename: "other.png", storagePath: join(tempDir, "other.png"), createdAt: new Date(4) });

  const rows = await repo.listByTaskIdAndRequestId("task_x", "req_2");
  expect(rows.map((m) => m.filename)).toEqual(["cur_a.png", "cur_b.png"]);
});

