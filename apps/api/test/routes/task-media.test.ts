import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../src/app";

let tempDir = "";
let prevDbPath: string | undefined;
let mediaTaskId = "";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=",
  "base64",
);

const TINY_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x69, 0x73, 0x6f, 0x32,
  0x00, 0x00, 0x00, 0x08,
]);

// Successful media responses exercise Fastify injection plus fs streams.
// They are sub-second in isolation, but full-suite CI contention has exceeded
// Bun's default 5s timeout; keep the larger budget explicit and localized.
const STREAMING_MEDIA_TEST_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "task-media-route-test-"));
  mediaTaskId = `task_media_${randomUUID().slice(0, 8)}`;
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "control.sqlite");
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  await rm(join(process.cwd(), ".magister", "media", "outbound", mediaTaskId), {
    recursive: true,
    force: true,
  });
  await rm(tempDir, { recursive: true, force: true });
});

async function seedMedia(input: {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  kind: "image" | "video";
  bytes: Buffer;
}) {
  const { TaskMediaRepository } = await import("../../src/repositories/task-media-repository");
  const dir = join(process.cwd(), ".magister", "media", "outbound", input.taskId, input.id);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, input.filename);
  await writeFile(storagePath, input.bytes);
  await new TaskMediaRepository().create({
    id: input.id,
    taskId: input.taskId,
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    filename: input.filename,
    mimeType: input.mimeType,
    kind: input.kind,
    sizeBytes: input.bytes.byteLength,
    contentHash: `hash-${input.id}`,
    storagePath,
    width: input.kind === "image" ? 1 : null,
    height: input.kind === "image" ? 1 : null,
    durationMs: null,
    caption: null,
    display: "inline",
    status: "ready",
    metadataJson: null,
    createdAt: new Date(),
    deletedAt: null,
    retainedUntil: null,
  });
  return storagePath;
}

test("GET /tasks/:taskId/media/:mediaId serves image media without exposing storage paths", async () => {
  await seedMedia({
    id: "media_png",
    taskId: mediaTaskId,
    filename: "shot.png",
    mimeType: "image/png",
    kind: "image",
    bytes: TINY_PNG,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${mediaTaskId}/media/media_png`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  expect(response.body.length).toBe(TINY_PNG.byteLength);
  expect(response.headers["x-accel-redirect"]).toBeUndefined();
  expect(response.body).not.toContain(tempDir);
}, STREAMING_MEDIA_TEST_TIMEOUT_MS);

test("GET /tasks/:taskId/media/:mediaId supports video byte ranges", async () => {
  await seedMedia({
    id: "media_mp4",
    taskId: mediaTaskId,
    filename: "demo.mp4",
    mimeType: "video/mp4",
    kind: "video",
    bytes: TINY_MP4,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${mediaTaskId}/media/media_mp4`,
    headers: { range: "bytes=4-11" },
  });

  expect(response.statusCode).toBe(206);
  expect(response.headers["content-type"]).toBe("video/mp4");
  expect(response.headers["accept-ranges"]).toBe("bytes");
  expect(response.headers["content-range"]).toBe(`bytes 4-11/${TINY_MP4.byteLength}`);
  expect(response.body).toBe("ftypisom");
}, STREAMING_MEDIA_TEST_TIMEOUT_MS);

test("GET /tasks/:taskId/media/:mediaId rejects invalid ranges", async () => {
  await seedMedia({
    id: "media_mp4",
    taskId: mediaTaskId,
    filename: "demo.mp4",
    mimeType: "video/mp4",
    kind: "video",
    bytes: TINY_MP4,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${mediaTaskId}/media/media_mp4`,
    headers: { range: "bytes=999-1000" },
  });

  expect(response.statusCode).toBe(416);
  expect(response.headers["content-range"]).toBe(`bytes */${TINY_MP4.byteLength}`);
});

test("HEAD /tasks/:taskId/media/:mediaId returns media headers without a body", async () => {
  await seedMedia({
    id: "media_png",
    taskId: mediaTaskId,
    filename: "shot.png",
    mimeType: "image/png",
    kind: "image",
    bytes: TINY_PNG,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "HEAD",
    url: `/tasks/${mediaTaskId}/media/media_png`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("image/png");
  expect(response.headers["content-length"]).toBe(String(TINY_PNG.byteLength));
  expect(response.body).toBe("");
});

test("media route requires the media row to belong to the requested task", async () => {
  await seedMedia({
    id: "media_png",
    taskId: mediaTaskId,
    filename: "shot.png",
    mimeType: "image/png",
    kind: "image",
    bytes: TINY_PNG,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/tasks/other_task/media/media_png",
  });

  expect(response.statusCode).toBe(404);
});

test("media route refuses storage paths outside the outbound media root", async () => {
  const { TaskMediaRepository } = await import("../../src/repositories/task-media-repository");
  const outsideDir = join(tempDir, "outside");
  await mkdir(outsideDir, { recursive: true });
  const storagePath = join(outsideDir, "shot.png");
  await writeFile(storagePath, TINY_PNG);
  await new TaskMediaRepository().create({
    id: "media_outside",
    taskId: mediaTaskId,
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    filename: "shot.png",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: TINY_PNG.byteLength,
    contentHash: "hash-outside",
    storagePath,
    width: 1,
    height: 1,
    durationMs: null,
    caption: null,
    display: "inline",
    status: "ready",
    metadataJson: null,
    createdAt: new Date(),
    deletedAt: null,
    retainedUntil: null,
  });
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: `/tasks/${mediaTaskId}/media/media_outside`,
  });

  expect(response.statusCode).toBe(404);
});
