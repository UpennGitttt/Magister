import { promises as fs } from "node:fs";
import { join } from "node:path";

import { spawnProcess } from "../../lib/platform/spawn";

export const REPO_STRUCTURE_DEFAULT_FILES_LIMIT = 200;
export const REPO_STRUCTURE_DEFAULT_DEPTH = 2;

export interface RepoStructureInput {
  workspaceDir: string;
  filesLimit?: number;
  depth?: number;
}

export interface RepoStructureResult {
  /** Whether the workspace is a git checkout (drives the head listing). */
  isGitRepo: boolean;
  /** Truncated `git ls-files` head, joined by newlines. Empty when not a git repo. */
  gitFilesHead: string;
  /** Tree-style directory listing capped at `depth`, joined by newlines. */
  topDirsTree: string;
  /** Soft caps actually applied (so callers can surface "truncated to N" hints). */
  appliedLimits: {
    filesLimit: number;
    depth: number;
  };
}

/**
 * Lightweight orientation tool for the leader. Outputs a header of
 * `git ls-files` plus a shallow directory tree of the workspace.
 *
 * Deliberately NOT RepoMap (Aider-style tree-sitter + PageRank) — that
 * adds ~800 LOC + heavy deps. The decisions doc parks RepoMap to a
 * later phase pending evidence this tool is insufficient.
 *
 * Failures surface as `isGitRepo: false` + empty `gitFilesHead`; the
 * directory tree fallback still gives the leader something useful.
 */
export async function executeRepoStructureTool(
  input: RepoStructureInput,
): Promise<RepoStructureResult> {
  const filesLimit = Math.max(
    1,
    Math.floor(input.filesLimit ?? REPO_STRUCTURE_DEFAULT_FILES_LIMIT),
  );
  const depth = Math.max(
    1,
    Math.min(4, Math.floor(input.depth ?? REPO_STRUCTURE_DEFAULT_DEPTH)),
  );

  const isGitRepo = await isInsideGitWorkTree(input.workspaceDir);
  let gitFilesHead = "";
  if (isGitRepo) {
    gitFilesHead = await safeGitLsFiles(input.workspaceDir, filesLimit);
  }
  const topDirsTree = await buildTopDirsTree(input.workspaceDir, depth);

  return {
    isGitRepo,
    gitFilesHead,
    topDirsTree,
    appliedLimits: { filesLimit, depth },
  };
}

/**
 * Use git itself rather than checking for a `.git` directory — in a
 * git worktree (the spawn-teammate isolation path) `.git` is a FILE
 * pointing at the parent repo, not a directory. The directory-only
 * check would silently fall back to "not a git repo" and emit no
 * `git ls-files` head, which is the worst possible outcome (teammate
 * gets a tree dump but no file index). `git rev-parse` answers
 * correctly for plain checkouts, worktrees, and submodules alike.
 * (Codex review 2026-05-14.)
 */
async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  try {
    const proc = spawnProcess(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd,
      env: process.env as Record<string, string>,
    });
    const exit = await proc.exited;
    if (exit !== 0) return false;
    return (await proc.stdoutText()).trim() === "true";
  } catch {
    return false;
  }
}

async function safeGitLsFiles(cwd: string, limit: number): Promise<string> {
  const proc = spawnProcess(["git", "ls-files"], {
    cwd,
    env: process.env as Record<string, string>,
  });
  const exit = await proc.exited;
  if (exit !== 0) return "";
  const all = (await proc.stdoutText()).split("\n");
  const cleaned = all.filter((line) => line.length > 0);
  const head = cleaned.slice(0, limit);
  if (cleaned.length > limit) {
    head.push(`... (${cleaned.length - limit} more files omitted)`);
  }
  return head.join("\n");
}

const SKIP_TREE_DIRS = new Set([
  ".git",
  "node_modules",
  ".magister",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".bun",
]);

async function buildTopDirsTree(root: string, depth: number): Promise<string> {
  const lines: string[] = [];
  await walk(root, "", depth, lines);
  return lines.join("\n");
}

async function walk(
  dir: string,
  prefix: string,
  remainingDepth: number,
  out: string[],
): Promise<void> {
  if (remainingDepth <= 0) return;
  let entries: { name: string; isDir: boolean }[];
  try {
    // `withFileTypes: true` returns Dirent.isDirectory() === false
    // for symbolic links — even when the target is a real directory.
    // That gives us a side benefit: symlink-based traversal escapes
    // from the workspace can't happen here because we simply don't
    // recurse through symlinks. Not a security guarantee (single-user
    // threat model), just a useful default.
    const raw = await fs.readdir(dir, { withFileTypes: true });
    entries = raw
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => !SKIP_TREE_DIRS.has(e.name))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const label = e.isDir ? `${e.name}/` : e.name;
    out.push(`${prefix}${connector}${label}`);
    if (e.isDir) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      await walk(join(dir, e.name), childPrefix, remainingDepth - 1, out);
    }
  }
}

export function formatRepoStructureResult(result: RepoStructureResult): string {
  const sections: string[] = [];
  if (result.isGitRepo && result.gitFilesHead) {
    sections.push(`# git ls-files (head, ≤${result.appliedLimits.filesLimit})`);
    sections.push(result.gitFilesHead);
  } else {
    sections.push("# (workspace is not a git repository)");
  }
  sections.push("");
  sections.push(`# directory tree (depth ${result.appliedLimits.depth})`);
  sections.push(result.topDirsTree || "(empty)");
  return sections.join("\n");
}
