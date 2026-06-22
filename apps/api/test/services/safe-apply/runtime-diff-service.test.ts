import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRuntimeDiff } from "../../../src/services/safe-apply/runtime-diff-service";

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function shQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function initRepo() {
  const repo = tempDir("safe-apply-diff-repo-");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "safe-apply@example.test"]);
  git(repo, ["config", "user.name", "Safe Apply Test"]);
  writeFileSync(join(repo, "README.md"), "# Initial\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRuntimeDiff stores exact patch bytes and stable sha256 hash", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-artifacts-");
  writeFileSync(join(repo, "README.md"), "# Initial\n\nchanged\n", "utf8");

  const first = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_1",
  });
  const second = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_2",
  });

  const patchBytes = readFileSync(first.storageRef);
  expect(existsSync(first.storageRef)).toBe(true);
  expect(first.diffHash).toBe(createHash("sha256").update(patchBytes).digest("hex"));
  expect(second.diffHash).toBe(first.diffHash);
  expect(first.baseRevision).toEqual(expect.any(String));
  expect(first.diffAlgorithm.command).toEqual([
    "git",
    "diff",
    "--no-color",
    "--binary",
    "--full-index",
    "--find-renames=50%",
    first.baseRevision!,
  ]);
  expect(first.changedFiles).toEqual([
    expect.objectContaining({
      path: "README.md",
      status: "modified",
      additions: 2,
      deletions: 0,
      isBinary: false,
      isExecutable: false,
    }),
  ]);
});

test("collectRuntimeDiff includes staged changes", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-staged-");
  writeFileSync(join(repo, "README.md"), "# Initial\n\nstaged change\n", "utf8");
  git(repo, ["add", "README.md"]);

  const diff = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_staged",
  });

  const patch = readFileSync(diff.storageRef, "utf8");
  expect(diff.isEmpty).toBe(false);
  expect(patch).toContain("staged change");
  expect(diff.changedFiles).toContainEqual(expect.objectContaining({
    path: "README.md",
    status: "modified",
  }));
});

test("collectRuntimeDiff includes untracked files without staging them in the real index", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-untracked-");
  writeFileSync(join(repo, "notes.md"), "new file from runtime\n", "utf8");

  const diff = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_untracked",
  });

  const patch = readFileSync(diff.storageRef, "utf8");
  expect(diff.isEmpty).toBe(false);
  expect(patch).toContain("new file from runtime");
  expect(diff.changedFiles).toContainEqual(expect.objectContaining({
    path: "notes.md",
    status: "added",
    additions: 1,
  }));
  expect(git(repo, ["status", "--short", "--", "notes.md"])).toBe("?? notes.md");
  expect(git(repo, ["diff", "--cached", "--name-only", "--", "notes.md"])).toBe("");
});

test("collectRuntimeDiff marks executable mode changes", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-executable-");
  writeFileSync(join(repo, "script.sh"), "#!/usr/bin/env bash\necho hi\n", "utf8");
  git(repo, ["add", "script.sh"]);
  git(repo, ["commit", "-m", "add script"]);

  chmodSync(join(repo, "script.sh"), 0o755);

  const diff = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_executable",
  });

  expect(diff.changedFiles[0]).toMatchObject({
    path: "script.sh",
    isExecutable: true,
  });
});

test("collectRuntimeDiff marks binary patches", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-binary-");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  git(repo, ["add", "blob.bin"]);
  git(repo, ["commit", "-m", "add binary"]);

  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 9, 8, 7, 6, 5, 4]));

  const diff = await collectRuntimeDiff({
    workspaceDir: repo,
    artifactsDir,
    artifactId: "artifact_diff_binary",
  });

  expect(diff.changedFiles[0]).toMatchObject({
    path: "blob.bin",
    isBinary: true,
  });
});

test("collectRuntimeDiff runs git with a minimal environment", async () => {
  const repo = initRepo();
  const artifactsDir = tempDir("safe-apply-diff-env-");
  const wrapperDir = tempDir("safe-apply-diff-git-wrapper-");
  const binDir = join(wrapperDir, "bin");
  const capturePath = join(wrapperDir, "env.txt");
  writeFileSync(join(repo, "README.md"), "# Initial\n\nenv change\n", "utf8");

  const realGitResult = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" });
  expect(realGitResult.status).toBe(0);
  const realGit = realGitResult.stdout.trim();
  expect(realGit.length).toBeGreaterThan(0);

  const wrapperPath = join(binDir, "git");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      `env >> ${shQuote(capturePath)}`,
      `exec ${shQuote(realGit)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(wrapperPath, 0o755);

  const originalPath = process.env.PATH;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalFeishu = process.env.FEISHU_BOT_SECRET;
  const originalDatabase = process.env.DATABASE_URL;

  try {
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.ANTHROPIC_API_KEY = "sk-inherited-secret";
    process.env.FEISHU_BOT_SECRET = "feishu-secret";
    process.env.DATABASE_URL = "file:secret.sqlite";

    await collectRuntimeDiff({
      workspaceDir: repo,
      artifactsDir,
      artifactId: "artifact_diff_env",
    });
  } finally {
    if (typeof originalPath === "string") process.env.PATH = originalPath;
    else delete process.env.PATH;
    if (typeof originalAnthropic === "string") process.env.ANTHROPIC_API_KEY = originalAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (typeof originalFeishu === "string") process.env.FEISHU_BOT_SECRET = originalFeishu;
    else delete process.env.FEISHU_BOT_SECRET;
    if (typeof originalDatabase === "string") process.env.DATABASE_URL = originalDatabase;
    else delete process.env.DATABASE_URL;
  }

  const captured = readFileSync(capturePath, "utf8");
  expect(captured).toContain("PATH=");
  expect(captured).not.toContain("ANTHROPIC_API_KEY=");
  expect(captured).not.toContain("FEISHU_BOT_SECRET=");
  expect(captured).not.toContain("DATABASE_URL=");
  expect(captured).toContain("GIT_INDEX_FILE=");
});
