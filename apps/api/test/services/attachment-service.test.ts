/**
 * attachment-service tests. Each test isolates the upload pool
 * via tempdir + MAGISTER_DB_PATH override so they run in parallel
 * without touching the real `.magister/uploads/` on disk.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevCwd = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "attachment-svc-test-"));
  prevCwd = process.cwd();
  process.chdir(tempDir);
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

// 1×1 transparent PNG, base64 — small enough to stay in tests.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=";

test("saveAttachments writes file + indexes metadata; loadAttachmentBlocksForRequest returns vendor-neutral image block", async () => {
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );

  const result = await saveAttachments("task_t1", "req_a", [
    { filename: "screenshot.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
  ]);
  expect(result.saved).toHaveLength(1);
  expect(result.rejected).toEqual([]);

  // File is on disk under .magister/uploads/<taskId>/
  const onDisk = await stat(result.saved[0]!.storagePath);
  expect(onDisk.isFile()).toBe(true);
  expect(onDisk.size).toBeGreaterThan(0);

  // Block returned by loadAttachmentBlocksForRequest is the
  // vendor-neutral form. Plugins translate to anthropic / openai
  // format separately (covered by plugin tests).
  const blocks = await loadAttachmentBlocksForRequest("task_t1", "req_a");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    type: "image",
    mediaType: "image/png",
  });
  expect(typeof (blocks[0] as { data?: unknown }).data).toBe("string");
  expect((blocks[0] as { data: string }).data.length).toBeGreaterThan(0);
});

test("rejects unknown mime types with a structured reason", async () => {
  // PDF/DOCX/XLSX are now whitelisted (extracted at load time);
  // use a genuinely-not-on-whitelist mime to verify the reject
  // path. application/zip is a reasonable example of "binary the
  // user might try to upload that we don't know how to extract."
  const { saveAttachments } = await import("../../src/services/attachment-service");
  const result = await saveAttachments("task_t1", "req_a", [
    { filename: "weird.zip", mimeType: "application/zip", dataBase64: TINY_PNG_BASE64 },
  ]);
  expect(result.saved).toEqual([]);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]!.reason).toContain("Unsupported mime type");
});

test("rejects oversized files but keeps under-limit ones", async () => {
  const { saveAttachments, MAX_IMAGE_SIZE_BYTES } = await import(
    "../../src/services/attachment-service"
  );
  // Build a too-big base64. base64 inflates 4/3, so source bytes
  // = ceil(b64.length * 3/4). For >10 MiB raw we need >13.33 MiB
  // of base64 chars. Pad with valid base64 chars so decode
  // doesn't fail before the size check.
  const bigBase64 = "A".repeat(MAX_IMAGE_SIZE_BYTES * 4 / 3 + 1024);
  const result = await saveAttachments("task_t1", "req_a", [
    { filename: "small.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    { filename: "huge.png", mimeType: "image/png", dataBase64: bigBase64 },
  ]);
  expect(result.saved).toHaveLength(1);
  expect(result.saved[0]!.filename).toBe("small.png");
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]!.filename).toBe("huge.png");
  expect(result.rejected[0]!.reason).toContain("too large");
});

test("attachments are scoped to (taskId, requestId) — only this turn's blocks are returned", async () => {
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );
  await saveAttachments("task_t1", "req_a", [
    { filename: "from-turn-a.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
  ]);
  await saveAttachments("task_t1", "req_b", [
    { filename: "from-turn-b.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
    { filename: "from-turn-b-2.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
  ]);

  const blocksA = await loadAttachmentBlocksForRequest("task_t1", "req_a");
  const blocksB = await loadAttachmentBlocksForRequest("task_t1", "req_b");
  expect(blocksA).toHaveLength(1);
  expect(blocksB).toHaveLength(2);
});

test("filename is sanitized — path traversal characters replaced", async () => {
  const { saveAttachments } = await import("../../src/services/attachment-service");
  const result = await saveAttachments("task_t1", "req_a", [
    {
      filename: "../../../etc/passwd",
      mimeType: "image/png",
      dataBase64: TINY_PNG_BASE64,
    },
  ]);
  expect(result.saved).toHaveLength(1);
  // Slashes become underscores; the stored path stays under
  // <upload-root>/<taskId>/.
  expect(result.saved[0]!.filename).not.toContain("/");
  expect(result.saved[0]!.storagePath).toContain("/.magister/uploads/task_t1/");
});

test("purgeForTask removes both on-disk files and index rows", async () => {
  const { saveAttachments, purgeForTask, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );
  const { saved } = await saveAttachments("task_t1", "req_a", [
    { filename: "x.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
  ]);
  // File present on disk before purge.
  const before = await readFile(saved[0]!.storagePath).catch(() => null);
  expect(before).not.toBeNull();

  await purgeForTask("task_t1");
  const after = await readFile(saved[0]!.storagePath).catch(() => null);
  expect(after).toBeNull(); // file gone

  const blocks = await loadAttachmentBlocksForRequest("task_t1", "req_a");
  expect(blocks).toEqual([]); // index gone too
});
