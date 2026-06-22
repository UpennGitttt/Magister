import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';

export type WorktreeInfo = {
  path: string;
  branch: string;
  createdAt: number;
};

const activeWorktrees = new Map<string, WorktreeInfo>();

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function createWorktree(
  repoDir: string,
  worktreeId: string,
  branchName: string,
): WorktreeInfo {
  const worktreePath = join(repoDir, '.worktrees', worktreeId);
  mkdirSync(join(repoDir, '.worktrees'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
    cwd: repoDir,
    timeout: 30000,
  });
  const info: WorktreeInfo = {
    path: worktreePath,
    branch: branchName,
    createdAt: Date.now(),
  };
  activeWorktrees.set(worktreeId, info);
  return info;
}

export function removeWorktree(repoDir: string, worktreeId: string): boolean {
  const info = activeWorktrees.get(worktreeId);
  if (!info) return false;
  try {
    execFileSync('git', ['worktree', 'remove', info.path, '--force'], {
      cwd: repoDir,
      timeout: 30000,
    });
  } catch {
    if (existsSync(info.path)) {
      rmSync(info.path, { recursive: true, force: true });
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, timeout: 10000 });
    } catch {}
  }
  try {
    execFileSync('git', ['branch', '-D', info.branch], { cwd: repoDir, timeout: 10000 });
  } catch {}
  activeWorktrees.delete(worktreeId);
  return true;
}

export function getWorktree(worktreeId: string): WorktreeInfo | null {
  return activeWorktrees.get(worktreeId) ?? null;
}

export function listWorktrees(): WorktreeInfo[] {
  return [...activeWorktrees.values()];
}

/**
 * Reclaim orphan leader safe-apply worktrees left behind by a crashed
 * process (F14). `removeWorktree` only acts on worktrees present in the
 * in-memory `activeWorktrees` map — which is ALWAYS empty after a restart
 * — so a `.worktrees/<id>` created by a previous (now-dead) process could
 * never be cleaned and leaked a full repo clone forever.
 *
 * Run this at startup AFTER acquiring the process lock: the lock guarantees
 * no other instance of this checkout is alive, and the empty map guarantees
 * this process owns none of the on-disk worktrees, so every `.worktrees/*`
 * entry git knows about is a reclaimable orphan. Worktrees that ARE in the
 * active map (defensive — should not happen at startup, but in case this is
 * ever called mid-run) are skipped.
 *
 * Dirty / unmerged orphans are still removed: crash recovery resumes from
 * the leader checkpoint (not the worktree), and any safe-apply review draft
 * was already persisted to `change_reviews` before cleanup. A dirty removal
 * is WARN-logged so a lost mid-turn edit leaves a trace.
 *
 * Only worktrees directly under `<repoDir>/.worktrees/` are managed; the
 * main worktree and any unrelated worktrees are left untouched.
 */
export function reconcileOrphanWorktrees(repoDir: string): {
  removed: string[];
  skippedActive: string[];
} {
  const worktreesRoot = canonicalExistingPath(join(repoDir, '.worktrees'));
  const removed: string[] = [];
  const skippedActive: string[] = [];

  let porcelain = '';
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch {
    // Not a git repo / git unavailable — nothing to reconcile.
    return { removed, skippedActive };
  }

  // Porcelain output is blank-line-separated blocks, each like:
  //   worktree <abs-path>
  //   HEAD <sha>
  //   branch refs/heads/<name>   (or `detached`)
  const blocks = porcelain.split('\n\n').filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const wtLine = lines.find((l) => l.startsWith('worktree '));
    if (!wtLine) continue;
    const wtPath = wtLine.slice('worktree '.length).trim();
    const canonicalWtPath = canonicalExistingPath(wtPath);
    // Only manage worktrees that live directly under <repoDir>/.worktrees/.
    if (dirname(canonicalWtPath) !== worktreesRoot) continue;

    const worktreeId = basename(canonicalWtPath);
    if (activeWorktrees.has(worktreeId)) {
      skippedActive.push(worktreeId);
      continue;
    }

    const branchLine = lines.find((l) => l.startsWith('branch '));
    const branch = branchLine
      ? branchLine.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      : null;

    // Capture dirty state for observability before destroying.
    let dirty = false;
    try {
      dirty =
        execFileSync('git', ['status', '--porcelain'], {
          cwd: wtPath,
          encoding: 'utf8',
          timeout: 10000,
        }).trim().length > 0;
    } catch {
      // Worktree dir already gone / corrupt — treat as removable.
    }

    try {
      execFileSync('git', ['worktree', 'remove', wtPath, '--force'], {
        cwd: repoDir,
        timeout: 30000,
      });
    } catch {
      if (existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
      }
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, timeout: 10000 });
      } catch {}
    }
    if (branch) {
      try {
        execFileSync('git', ['branch', '-D', branch], { cwd: repoDir, timeout: 10000 });
      } catch {}
    }

    removed.push(worktreeId);
    if (dirty) {
      console.warn(
        `[worktree-reconcile] removed orphan worktree '${worktreeId}' (branch ${branch ?? 'detached'}) that had UNCOMMITTED changes — likely a crashed mid-turn run; resume uses the leader checkpoint, not this worktree`,
      );
    } else {
      console.log(
        `[worktree-reconcile] reclaimed clean orphan worktree '${worktreeId}' (branch ${branch ?? 'detached'})`,
      );
    }
  }

  return { removed, skippedActive };
}
