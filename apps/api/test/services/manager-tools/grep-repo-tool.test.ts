/**
 * Regression suite for the original 2026-05-03 grep-on-binary
 * incident. The walker descended into `.local/control-plane.sqlite`
 * (143 MB binary file) and returned megabytes of bytes-as-text mixed
 * with recursive event payload that poisoned the next model turn.
 *
 * What we test here:
 * 1. SKIP_DIR_NAMES catches `.local/`, `.magister/`, `node_modules/` —
 *    no read of files inside them, even when they exist and contain
 *    matches.
 * 2. Per-file binary-extension skip catches `.sqlite` / `.db` etc.
 *    sitting at the workspace root or anywhere not in a skip dir.
 * 3. Per-file content sniff catches text-extension files whose actual
 *    payload is binary (e.g. NUL-byte-laden `.log`).
 * 4. Result size caps stop runaway noise — head limit, total chars.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeGrepRepoTool } from "../../../src/services/manager-tools/grep-repo-tool";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "grep-tool-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test("does NOT walk into .local/ even with matching content (the original incident)", async () => {
  await mkdir(path.join(workspace, ".local"));
  await writeFile(path.join(workspace, ".local", "fake.log"), "spawn_teammate appears here\n");
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "real.ts"), "spawn_teammate(role)\n");

  const r = await executeGrepRepoTool({
    workspaceDir: workspace,
    query: "spawn_teammate",
    path: ".",
  });
  expect(r.matches.some((m) => m.path.startsWith(".local"))).toBe(false);
  expect(r.matches.some((m) => m.path.startsWith("src"))).toBe(true);
});

test("does NOT walk into .magister/ or node_modules/", async () => {
  await mkdir(path.join(workspace, ".magister"));
  await writeFile(path.join(workspace, ".magister", "log.txt"), "secret_token here\n");
  await mkdir(path.join(workspace, "node_modules"));
  await writeFile(path.join(workspace, "node_modules", "junk.js"), "secret_token also\n");
  await writeFile(path.join(workspace, "real.txt"), "secret_token in workspace root\n");

  const r = await executeGrepRepoTool({
    workspaceDir: workspace,
    query: "secret_token",
    path: ".",
  });
  expect(r.matches.length).toBe(1);
  expect(r.matches[0]!.path).toBe("real.txt");
});

test("skips files with binary extensions even outside skip dirs", async () => {
  // Mimic the SQLite that started this whole mess, but at workspace
  // root so the dir-skip can't help us — only the per-file extension
  // check.
  const sqliteBytes = Buffer.concat([
    Buffer.from("SQLite format 3\0"),
    Buffer.from([0, 0, 0, 0, 0, 0, 0]),
    Buffer.from("spawn_teammate matches inside but we should never read this\n"),
  ]);
  await writeFile(path.join(workspace, "control-plane.sqlite"), sqliteBytes);
  await writeFile(path.join(workspace, "real.ts"), "spawn_teammate(role)\n");

  const r = await executeGrepRepoTool({
    workspaceDir: workspace,
    query: "spawn_teammate",
    path: ".",
  });
  expect(r.matches.some((m) => m.path.endsWith(".sqlite"))).toBe(false);
  expect(r.matches.some((m) => m.path === "real.ts")).toBe(true);
});

test("skips text-named files whose payload is actually binary (NUL bytes)", async () => {
  // .log is text-y by extension; populate it with a NUL byte so
  // isBinaryContent fires.
  const binaryLog = Buffer.concat([
    Buffer.from("spawn_teammate appears here too\n"),
    Buffer.from([0, 0, 0]),
    Buffer.from("rest of binary blob"),
  ]);
  await writeFile(path.join(workspace, "weird.log"), binaryLog);
  await writeFile(path.join(workspace, "real.ts"), "spawn_teammate(role)\n");

  const r = await executeGrepRepoTool({
    workspaceDir: workspace,
    query: "spawn_teammate",
    path: ".",
  });
  expect(r.matches.some((m) => m.path === "weird.log")).toBe(false);
  expect(r.matches.some((m) => m.path === "real.ts")).toBe(true);
});

test("denies grep against .local/ even when called explicitly", async () => {
  await mkdir(path.join(workspace, ".local"));
  await writeFile(path.join(workspace, ".local", "x.txt"), "hello\n");

  let caught: Error | null = null;
  try {
    await executeGrepRepoTool({ workspaceDir: workspace, query: "hello", path: ".local" });
  } catch (err) {
    caught = err as Error;
  }
  expect(caught).not.toBeNull();
  expect(caught!.message).toMatch(/off-limits|Magister-internal/i);
});

test("caps result size — long line truncated, large match-set bounded", async () => {
  // 800-char line: should be truncated to MAX_LINE_CHARS (500).
  const longLine = "x".repeat(800) + "needle" + "y".repeat(800);
  await writeFile(path.join(workspace, "long.txt"), longLine + "\n");
  // 1000 matching short lines: head-limit (250) caps the count.
  const many = Array.from({ length: 1000 }, () => "needle here").join("\n");
  await writeFile(path.join(workspace, "many.txt"), many + "\n");

  const r = await executeGrepRepoTool({ workspaceDir: workspace, query: "needle", path: "." });
  expect(r.matches.length).toBeLessThanOrEqual(250);
  // long.txt's snippet (if it landed) must be truncated.
  const longHit = r.matches.find((m) => m.path === "long.txt");
  if (longHit) {
    expect(longHit.snippet.length).toBeLessThanOrEqual(520);
    expect(longHit.snippet).toContain("[line truncated]");
  }
  expect((r as { truncated?: boolean }).truncated).toBe(true);
});

test("walker does NOT follow symlinks (kimi review C1)", async () => {
  // A symlink at the workspace root with a benign name pointing to
  // /etc/passwd would otherwise be opened and grepped. Verify the
  // walker skips symlinks entirely. We can't safely create a symlink
  // to /etc/passwd in the test, so use an outside tempdir instead.
  const { mkdtemp, symlink, writeFile } = await import("node:fs/promises");
  const outside = await mkdtemp(path.join((await import("node:os")).tmpdir(), "grep-outside-"));
  await writeFile(path.join(outside, "external-secret.txt"), "external_match found here\n");
  await symlink(path.join(outside, "external-secret.txt"), path.join(workspace, "trap.txt"));
  await writeFile(path.join(workspace, "real.ts"), "external_match in real file\n");

  const r = await executeGrepRepoTool({
    workspaceDir: workspace,
    query: "external_match",
    path: ".",
  });
  expect(r.matches.some((m) => m.path === "trap.txt")).toBe(false);
  expect(r.matches.some((m) => m.path === "real.ts")).toBe(true);
  await rm(outside, { recursive: true, force: true });
});

test("walker skips files larger than MAX_FILE_BYTES (kimi review M2)", async () => {
  // A 3 MB text file is over the 2 MB cap. Without the cap, the
  // entire file would be read into memory before result-set caps
  // even apply.
  const huge = "x".repeat(3 * 1024 * 1024) + "\nneedle in haystack\n";
  await writeFile(path.join(workspace, "huge.log"), huge);
  await writeFile(path.join(workspace, "small.txt"), "needle in small\n");
  const r = await executeGrepRepoTool({ workspaceDir: workspace, query: "needle", path: "." });
  expect(r.matches.some((m) => m.path === "huge.log")).toBe(false);
  expect(r.matches.some((m) => m.path === "small.txt")).toBe(true);
});

test("ordinary text files in the workspace match correctly (sanity)", async () => {
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "src", "a.ts"), "alpha\nbeta\ngamma\n");
  await writeFile(path.join(workspace, "src", "b.ts"), "gamma\ndelta\n");
  const r = await executeGrepRepoTool({ workspaceDir: workspace, query: "gamma", path: "." });
  const paths = r.matches.map((m) => m.path).sort();
  expect(paths).toEqual([path.join("src", "a.ts"), path.join("src", "b.ts")]);
});
