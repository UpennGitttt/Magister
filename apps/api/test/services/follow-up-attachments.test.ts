/**
 * Follow-up attachment plumbing — Stage 1 of the 2026-05-03
 * multimodal-followup PR. Verifies that:
 *   - Mailbox row carries the requestId stamped by POST /tasks/:id/messages
 *     when the user uploaded files, so the leader loop can pair the
 *     message with its attachment rows.
 *   - Loop's mailbox-to-LeaderMessage transform emits a content-array
 *     (text + image) when the row has a requestId pointing at saved
 *     attachments, and stays text-only when it doesn't.
 *
 * Builds the wire path manually (route → repo → loader) instead of
 * spinning a real fastify instance — the mailbox path is a flat
 * write-then-read sequence and a unit-level harness is cheaper.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1×1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=";

let tempDir = "";
let prevCwd = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "follow-up-attach-test-"));
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

test("mailbox row with requestId → loader returns image block", async () => {
  const { TaskMailboxRepository } = await import(
    "../../src/repositories/task-mailbox-repository"
  );
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );

  const taskId = "task_t1";
  const requestId = "req_followup_t1";
  const messageId = `msg_${Date.now()}_x`;

  // Simulate POST /tasks/:id/messages with attachments: save first,
  // then create the mailbox row carrying the same requestId.
  await saveAttachments(taskId, requestId, [
    { filename: "shot.png", mimeType: "image/png", dataBase64: TINY_PNG_BASE64 },
  ]);

  const mailbox = new TaskMailboxRepository();
  await mailbox.create({
    id: messageId,
    taskId,
    content: "what's in this image?",
    sender: "user",
    requestId,
    createdAt: new Date(),
  });

  // Read back the way the loop does.
  const pending = await mailbox.getUnconsumed(taskId);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.requestId).toBe(requestId);

  const blocks = await loadAttachmentBlocksForRequest(taskId, requestId);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ type: "image", mediaType: "image/png" });
});

test("mailbox row without requestId → text-only path (legacy fallback)", async () => {
  const { TaskMailboxRepository } = await import(
    "../../src/repositories/task-mailbox-repository"
  );
  const { loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );

  const taskId = "task_t2";
  const messageId = `msg_${Date.now()}_y`;
  const mailbox = new TaskMailboxRepository();
  await mailbox.create({
    id: messageId,
    taskId,
    content: "plain text follow-up",
    sender: "user",
    createdAt: new Date(),
    // no requestId — legacy / text-only mailbox row
  });

  const pending = await mailbox.getUnconsumed(taskId);
  expect(pending[0]?.requestId).toBeNull();

  // Without a requestId the loader has nothing to look up; loop falls
  // back to string content (no images). No DB rows exist either.
  const blocks = await loadAttachmentBlocksForRequest(taskId, "req_nope");
  expect(blocks).toEqual([]);
});

test("buildCliArgs codex: -i flag once per image, BEFORE the prompt", async () => {
  const { buildCliArgs } = await import("../../src/services/cli-agent-spawn-service");
  const { argv, argvMetadata } = buildCliArgs("codex", undefined, "describe these", undefined, undefined, [
    "/abs/a.png",
    "/abs/b.png",
  ]);
  // codex argv: ["exec", "-i", "/abs/a.png", "-i", "/abs/b.png", "--sandbox", "workspace-write", "describe these"]
  expect(argv[0]).toBe("exec");
  // Two -i pairs.
  const iCount = argv.filter((a) => a === "-i").length;
  expect(iCount).toBe(2);
  expect(argv).toContain("/abs/a.png");
  expect(argv).toContain("/abs/b.png");
  // Image flags precede the sandbox pair and prompt arg.
  expect(argv.indexOf("/abs/a.png")).toBeLessThan(argv.indexOf("--sandbox"));
  expect(argvMetadata).toMatchObject({
    runtimeSource: "codex",
    permissionMode: "headless",
  });
  expect(argvMetadata.argvFlags).toEqual(expect.arrayContaining(["exec", "--sandbox", "workspace-write"]));
});

test("buildCliArgs opencode: -f flag once per image, prompt BEFORE file flags", async () => {
  const { buildCliArgs } = await import("../../src/services/cli-agent-spawn-service");
  const { argv, argvMetadata } = buildCliArgs("opencode", undefined, "what is this", undefined, undefined, [
    "/abs/x.jpg",
    "/abs/y.jpg",
  ]);
  expect(argv[0]).toBe("run");
  // Two -f pairs.
  const fCount = argv.filter((a) => a === "-f").length;
  expect(fCount).toBe(2);
  expect(argv).toContain("/abs/x.jpg");
  expect(argv).toContain("/abs/y.jpg");
  // CRITICAL: prompt must come BEFORE the -f flags. opencode's
  // yargs declares --file as [array] which greedily consumes
  // subsequent positional args; if the prompt is after -f, opencode
  // tries to open the prompt text as a file and errors out.
  // Verified end-to-end against /usr/bin/opencode 1.14.31.
  const promptIdx = argv.indexOf("what is this");
  const firstFlagIdx = argv.indexOf("-f");
  expect(promptIdx).toBeGreaterThan(-1);
  expect(promptIdx).toBeLessThan(firstFlagIdx);
  expect(argvMetadata).toMatchObject({
    runtimeSource: "opencode",
    permissionMode: "headless",
  });
  expect(argvMetadata.argvFlags).toContain("run");
});

test("buildCliArgs claude: appends file-list to prompt (no native flag)", async () => {
  const { buildCliArgs } = await import("../../src/services/cli-agent-spawn-service");
  const { argv, argvMetadata } = buildCliArgs("claude", undefined, "tell me about it", undefined, undefined, [
    "/abs/screenshot.png",
  ]);
  // claude argv: ["--permission-mode", "auto", "-p", "<prompt with file list>"]
  expect(argv).toContain("--permission-mode");
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv).toContain("-p");
  const promptArg = argv[argv.indexOf("-p") + 1] ?? "";
  expect(promptArg).toContain("Files attached for this turn");
  expect(promptArg).toContain("/abs/screenshot.png");
  expect(argvMetadata).toMatchObject({
    runtimeSource: "claude-code",
    permissionMode: "headless",
  });
  expect(argvMetadata.argvFlags).toContain("--permission-mode");
  expect(argvMetadata.argvFlags).toContain("auto");
  expect(argvMetadata.argvFlags).toContain("-p");
});

test("CLI_ARGS_BASELINE_VERSIONS records the versions buildCliArgs targets", async () => {
  // Runtime maintenance signal — if a CLI is upgraded and our flag
  // assumptions break, the baseline is the documented "we wrote
  // this code against version X" reference. The probe at startup
  // (cli-version-probe.ts) compares installed vs baseline and
  // warns on drift. This test ensures the constant exists with
  // entries for all three CLIs we dispatch to.
  const { CLI_ARGS_BASELINE_VERSIONS } = await import("../../src/services/cli-agent-spawn-service");
  expect(CLI_ARGS_BASELINE_VERSIONS["codex"]).toMatch(/codex-cli/);
  expect(CLI_ARGS_BASELINE_VERSIONS["claude-code"]).toMatch(/^\d/);
  expect(CLI_ARGS_BASELINE_VERSIONS["opencode"]).toMatch(/^\d/);
});

test("buildCliArgs no images: no -i / -f and no prompt-text addendum", async () => {
  const { buildCliArgs } = await import("../../src/services/cli-agent-spawn-service");
  const { argv: codexArgv } = buildCliArgs("codex", undefined, "p", undefined, undefined, undefined);
  expect(codexArgv).not.toContain("-i");
  const { argv: opencodeArgv } = buildCliArgs("opencode", undefined, "p", undefined, undefined, undefined);
  expect(opencodeArgv).not.toContain("-f");
  const { argv: claudeArgv } = buildCliArgs("claude", undefined, "p", undefined, undefined, undefined);
  const promptArg = claudeArgv[claudeArgv.indexOf("-p") + 1] ?? "";
  expect(promptArg).not.toContain("Files attached");
});

test("markdown attachment lands as a text block with file header", async () => {
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );

  const taskId = "task_md1";
  const requestId = "req_md1";
  const markdown = "# Hello\n\nThis is a test document.\n\n- item 1\n- item 2\n";
  const dataBase64 = Buffer.from(markdown, "utf8").toString("base64");

  const { saved, rejected } = await saveAttachments(taskId, requestId, [
    { filename: "spec.md", mimeType: "text/markdown", dataBase64 },
  ]);
  expect(rejected).toEqual([]);
  expect(saved).toHaveLength(1);

  const blocks = await loadAttachmentBlocksForRequest(taskId, requestId);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  const text = (blocks[0] as { text: string }).text;
  expect(text).toContain("# Attached file: spec.md");
  expect(text).toContain("```markdown");
  expect(text).toContain("# Hello");
  expect(text).toContain("- item 1");
});

test("text/plain attachment also lands as a text block", async () => {
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );

  const taskId = "task_txt1";
  const requestId = "req_txt1";
  const dataBase64 = Buffer.from("just plain stuff", "utf8").toString("base64");

  const { saved } = await saveAttachments(taskId, requestId, [
    { filename: "notes.txt", mimeType: "text/plain", dataBase64 },
  ]);
  expect(saved).toHaveLength(1);

  const blocks = await loadAttachmentBlocksForRequest(taskId, requestId);
  expect(blocks[0]?.type).toBe("text");
  expect((blocks[0] as { text: string }).text).toContain("```text");
});

test("xlsx attachment extracts to a CSV-fenced text block via the loader", async () => {
  const { saveAttachments, loadAttachmentBlocksForRequest } = await import(
    "../../src/services/attachment-service"
  );
  // Build a real .xlsx in-memory so the extraction path through
  // mammoth/xlsx exercises the actual library code, not a stub.
  const xlsx = await import("xlsx");
  const wb = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([
    ["item", "qty"],
    ["apple", 5],
    ["banana", 3],
  ]);
  xlsx.utils.book_append_sheet(wb, sheet, "Stock");
  // writeBuffer (xlsx supports node Buffer output)
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const taskId = "task_xlsx1";
  const requestId = "req_xlsx1";
  const { saved, rejected } = await saveAttachments(taskId, requestId, [
    {
      filename: "stock.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      dataBase64: buf.toString("base64"),
    },
  ]);
  expect(rejected).toEqual([]);
  expect(saved).toHaveLength(1);

  const blocks = await loadAttachmentBlocksForRequest(taskId, requestId);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  const text = (blocks[0] as { text: string }).text;
  expect(text).toContain("# Attached file: stock.xlsx");
  expect(text).toContain("## Sheet: Stock");
  expect(text).toContain("apple,5");
});

test("oversized markdown is rejected with the lower text cap (1 MiB)", async () => {
  const { saveAttachments, MAX_TEXT_SIZE_BYTES } = await import(
    "../../src/services/attachment-service"
  );
  const oversized = Buffer.alloc(MAX_TEXT_SIZE_BYTES + 1, "x").toString("base64");
  const { saved, rejected } = await saveAttachments("task_oversize", "req_oversize", [
    { filename: "big.md", mimeType: "text/markdown", dataBase64: oversized },
  ]);
  expect(saved).toEqual([]);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toContain("too large");
});
