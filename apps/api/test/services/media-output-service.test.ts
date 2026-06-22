import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevCwd = "";
let prevDbPath: string | undefined;

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
]);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "media-output-svc-test-"));
  prevCwd = process.cwd();
  process.chdir(tempDir);
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "control.sqlite");
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  await rm(tempDir, { recursive: true, force: true });
});

test("createOutboundMediaFromPath copies a PNG into the task media store and returns metadata-only event payload", async () => {
  const { createOutboundMediaFromPath, toMediaSentPayload } = await import(
    "../../src/services/media-output-service"
  );
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "screenshot.png"), TINY_PNG);

  const result = await createOutboundMediaFromPath({
    taskId: "task_media",
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "screenshot.png",
    caption: "Current screen",
    display: "inline",
  });

  expect(result.kind).toBe("image");
  expect(result.mimeType).toBe("image/png");
  expect(result.width).toBe(1);
  expect(result.height).toBe(1);
  expect(result.storagePath).toContain("/.magister/media/outbound/task_media/");
  expect(await readFile(result.storagePath)).toEqual(TINY_PNG);

  const payload = toMediaSentPayload(result);
  expect(payload).toMatchObject({
    mediaId: result.id,
    kind: "image",
    mimeType: "image/png",
    filename: "screenshot.png",
    caption: "Current screen",
    display: "inline",
  });
  expect(JSON.stringify(payload)).not.toContain("storagePath");
  expect(JSON.stringify(payload)).not.toContain("iVBOR");
});

test("createOutboundMediaFromPath detects video/mp4 from file bytes", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "demo.bin"), TINY_MP4);

  const result = await createOutboundMediaFromPath({
    taskId: "task_media",
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "demo.bin",
  });

  expect(result.kind).toBe("video");
  expect(result.mimeType).toBe("video/mp4");
});

test("createOutboundMediaFromPath rejects symlinks that resolve outside the workspace", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  const outsideDir = join(tempDir, "outside");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "outside.png"), TINY_PNG);
  await symlink(join(outsideDir, "outside.png"), join(workspaceDir, "link.png"));

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "link.png",
  })).rejects.toThrow(/outside allowed media roots/);
});

test("createOutboundMediaFromPath rejects obvious secret paths before copying", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(join(workspaceDir, "config"), { recursive: true });
  await writeFile(join(workspaceDir, "config", "secrets.json"), TINY_PNG);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "config/secrets.json",
  })).rejects.toThrow(/sensitive path/);
});

test("createOutboundMediaFromPath rejects unsupported media bytes", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "notes.txt"), "hello");

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    requestId: "req_media",
    roleRuntimeId: "rt_leader",
    sourceToolCallId: "tu_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "notes.txt",
  })).rejects.toThrow(/Unsupported media type/);
});

test("createOutboundMediaFromPath rejects .magister/uploads of other tasks (cross-task exfil)", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  // Simulate a different task's inbound user upload sitting under
  // <cwd>/.magister/uploads/. The leader must NOT be able to send it
  // back to chat by passing the path to send_media.
  const otherUpload = join(tempDir, ".magister", "uploads", "other-task", "secret.png");
  await mkdir(join(tempDir, ".magister", "uploads", "other-task"), { recursive: true });
  await writeFile(otherUpload, TINY_PNG);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir,
    path: otherUpload,
  })).rejects.toThrow(/outside allowed media roots/);
});

test("createOutboundMediaFromPath rejects .magister/memory paths", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const memoryPath = join(tempDir, ".magister", "memory", "user.md");
  await mkdir(join(tempDir, ".magister", "memory"), { recursive: true });
  await writeFile(memoryPath, TINY_PNG);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir,
    path: memoryPath,
  })).rejects.toThrow(/outside allowed media roots/);
});

test("createOutboundMediaFromPath rejects credential-shaped basenames inside the workspace", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "aws-credentials.png"), TINY_PNG);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "aws-credentials.png",
  })).rejects.toThrow(/sensitive path/);
});

test("createOutboundMediaFromPath rejects .netrc / .npmrc / .pem inside the workspace", async () => {
  const { createOutboundMediaFromPath } = await import("../../src/services/media-output-service");
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, ".netrc"), TINY_PNG);
  await writeFile(join(workspaceDir, "client.pem"), TINY_PNG);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir,
    path: ".netrc",
  })).rejects.toThrow(/sensitive path/);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir,
    path: "client.pem",
  })).rejects.toThrow(/sensitive path/);
});

test("createOutboundMediaFromPath rejects files above the hard media cap before copying", async () => {
  const { createOutboundMediaFromPath, MAX_OUTBOUND_VIDEO_BYTES } = await import(
    "../../src/services/media-output-service"
  );
  await mkdir(join(tempDir, "workspace"), { recursive: true });
  const hugePath = join(tempDir, "workspace", "huge.mp4");
  await writeFile(hugePath, "");
  await truncate(hugePath, MAX_OUTBOUND_VIDEO_BYTES + 1);

  await expect(createOutboundMediaFromPath({
    taskId: "task_media",
    sourceType: "tool_path",
    workspaceDir: join(tempDir, "workspace"),
    path: hugePath,
  })).rejects.toThrow(/Media file too large/);
});
