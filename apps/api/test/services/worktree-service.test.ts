import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorktree,
  listWorktrees,
  reconcileOrphanWorktrees,
  removeWorktree,
} from "../../src/services/worktree-service";

let repoDir = "";

function runGit(args: string[], cwd = repoDir): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "worktree-service-test-"));

  runGit(["init"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "Test User"]);
  writeFileSync(join(repoDir, "README.md"), "# test\n", "utf8");
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "init"]);
});

afterEach(() => {
  removeWorktree(repoDir, "wt-create-path");
  removeWorktree(repoDir, "wt-create-branch");
  removeWorktree(repoDir, "wt-remove");
  removeWorktree(repoDir, "wt-list-1");
  removeWorktree(repoDir, "wt-list-2");
  removeWorktree(repoDir, "wt-active");

  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("createWorktree creates a git worktree at the specified path", () => {
  const info = createWorktree(repoDir, "wt-create-path", "feat/create-path");

  expect(info.path).toBe(join(repoDir, ".worktrees", "wt-create-path"));
  expect(existsSync(info.path)).toBe(true);

  const worktreeList = runGit(["worktree", "list"]);
  expect(worktreeList).toContain(info.path);
});

test("createWorktree creates a new branch", () => {
  const branchName = "feat/new-branch";
  createWorktree(repoDir, "wt-create-branch", branchName);

  const branchList = runGit(["branch", "--list", branchName]);
  expect(branchList).toContain(branchName);
});

test("removeWorktree cleans up the worktree", () => {
  const info = createWorktree(repoDir, "wt-remove", "feat/remove-branch");

  expect(existsSync(info.path)).toBe(true);
  const removed = removeWorktree(repoDir, "wt-remove");

  expect(removed).toBe(true);
  expect(existsSync(info.path)).toBe(false);

  const worktreeList = runGit(["worktree", "list"]);
  expect(worktreeList).not.toContain(info.path);
});

test("listWorktrees returns active worktrees", () => {
  const first = createWorktree(repoDir, "wt-list-1", "feat/list-1");
  const second = createWorktree(repoDir, "wt-list-2", "feat/list-2");

  const active = listWorktrees();
  const activePaths = active.map((entry) => entry.path);

  expect(activePaths).toContain(first.path);
  expect(activePaths).toContain(second.path);
});

// ──────────────────────────────────────────────────────────────────
// F14 — startup orphan reconciliation. removeWorktree only works for
// worktrees in the in-memory `activeWorktrees` map, which is ALWAYS
// empty after a process restart — so a worktree created by a crashed
// previous process leaked under `.worktrees/` forever. reconcile must
// reclaim those, while sparing worktrees this process still owns.
// ──────────────────────────────────────────────────────────────────

test("reconcileOrphanWorktrees reclaims a clean orphan not in the active map", () => {
  // Simulate a worktree left by a crashed previous process: add it via
  // raw git so it's on disk + known to git, but NOT in `activeWorktrees`.
  const orphanPath = join(repoDir, ".worktrees", "orphan-clean");
  runGit(["worktree", "add", "-b", "feat/orphan-clean", orphanPath]);
  expect(existsSync(orphanPath)).toBe(true);

  const result = reconcileOrphanWorktrees(repoDir);

  expect(result.removed).toContain("orphan-clean");
  expect(existsSync(orphanPath)).toBe(false);
  // The throwaway branch is deleted too (no clone left dangling).
  expect(runGit(["branch", "--list", "feat/orphan-clean"])).toBe("");
  expect(runGit(["worktree", "list"])).not.toContain(orphanPath);
});

test("reconcileOrphanWorktrees does NOT remove a worktree the current process owns (in the active map)", () => {
  const active = createWorktree(repoDir, "wt-active", "feat/active-branch");
  expect(existsSync(active.path)).toBe(true);

  const result = reconcileOrphanWorktrees(repoDir);

  expect(result.skippedActive).toContain("wt-active");
  expect(result.removed).not.toContain("wt-active");
  expect(existsSync(active.path)).toBe(true);
});

test("reconcileOrphanWorktrees removes a DIRTY orphan (resume uses the checkpoint, not the worktree)", () => {
  const orphanPath = join(repoDir, ".worktrees", "orphan-dirty");
  runGit(["worktree", "add", "-b", "feat/orphan-dirty", orphanPath]);
  // Leave uncommitted changes behind, as a crashed mid-turn leader would.
  writeFileSync(join(orphanPath, "scratch.txt"), "half-finished edit\n", "utf8");

  const result = reconcileOrphanWorktrees(repoDir);

  expect(result.removed).toContain("orphan-dirty");
  expect(existsSync(orphanPath)).toBe(false);
});

test("reconcileOrphanWorktrees never touches the main worktree (repoDir itself)", () => {
  reconcileOrphanWorktrees(repoDir);
  // Main repo + its tracked file survive.
  expect(existsSync(join(repoDir, "README.md"))).toBe(true);
  expect(runGit(["worktree", "list"])).toContain(repoDir);
});
