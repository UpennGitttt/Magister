import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeWorkspaceRepository } from "../repositories/runtime-workspace-repository";
import {
  resolveWorkspaceAllocationDecision,
  type WorkspaceAllocationDecision,
  type WorkspaceAllocationStrategy,
} from "./workspace-allocation-manager";

type RuntimeWorkspaceStatus = "running" | "completed" | "failed";
type RuntimeWorkspaceStrategy = "workspace_root" | "git_worktree";

type RuntimeWorkspaceMetadata = {
  runId: string;
  taskId: string;
  roleId: string;
  workspaceId: string;
  status: RuntimeWorkspaceStatus;
  requestedStrategy?: RuntimeWorkspaceStrategy;
  strategy: RuntimeWorkspaceStrategy;
  decisionReason?: string;
  fallbackReason?: string;
  baseWorkspaceDir: string;
  workspaceDir: string;
  baseRevision: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type RuntimeWorkspaceLease = {
  runId: string;
  taskId: string;
  roleId: string;
  workspaceId: string;
  requestedStrategy: RuntimeWorkspaceStrategy;
  strategy: RuntimeWorkspaceStrategy;
  decisionReason: string;
  fallbackReason: string | null;
  baseWorkspaceDir: string;
  workspaceDir: string;
  baseRevision: string | null;
  artifactsBaseDir: string;
  codexHomeDir: string;
  metadataPath: string;
};

// Retention policy (overridable via env):
//   - TTL: 30 days. Workspaces older than this are removed, no exceptions.
//   - Cap:  50 most-recently-modified workspaces. Anything beyond this rank
//     is removed even if it's still under TTL — keeps the disk footprint
//     bounded regardless of test-run frequency.
// Either rule cutting alone is enough for a workspace to go.
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RUNTIME_WORKSPACES = 50;

function normalizePathCandidate(value: string | undefined | null) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function parseWorkspacePathMapFromEnv() {
  const raw = process.env.MAGISTER_WORKSPACE_PATH_MAP?.trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, string> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        continue;
      }
      const candidate = normalizePathCandidate(value);
      if (candidate) {
        next[workspaceId] = candidate;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listCleanupEligibleRuntimeWorkspaceRunIds(
  repository = new RuntimeWorkspaceRepository(),
) {
  const records = await repository.listAll();
  return records
    .filter((record) => record.status !== "running" && Boolean(record.finishedAt))
    .map((record) => record.runId);
}

async function runGitCommand(cwd: string, args: string[]) {
  return await new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
      });
    });
  });
}

async function isGitRepository(path: string) {
  const result = await runGitCommand(path, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

async function isGitWorkspaceDirty(path: string) {
  const result = await runGitCommand(path, ["status", "--porcelain"]);
  return result.ok && result.stdout.trim().length > 0;
}

async function getGitHeadRevision(path: string) {
  const result = await runGitCommand(path, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() || null : null;
}

async function writeMetadata(path: string, metadata: RuntimeWorkspaceMetadata) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(metadata, null, 2), "utf8");
}

async function readMetadata(path: string) {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as RuntimeWorkspaceMetadata;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function persistRuntimeWorkspaceRecord(input: RuntimeWorkspaceMetadata & { metadataPath: string }) {
  const repository = new RuntimeWorkspaceRepository();
  await repository.upsert({
    id: `workspace_${input.runId}`,
    runId: input.runId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    roleId: input.roleId,
    requestedStrategy: input.requestedStrategy ?? null,
    strategy: input.strategy,
    decisionReason: input.decisionReason ?? null,
    fallbackReason: input.fallbackReason ?? null,
    status: input.status,
    baseWorkspaceDir: input.baseWorkspaceDir,
    workspaceDir: input.workspaceDir,
    baseRevision: input.baseRevision,
    metadataPath: input.metadataPath,
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.updatedAt),
    finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
  });
}

function buildWorkspaceControlDirs(baseWorkspaceDir: string, runId: string, taskId: string) {
  const workspaceRoot = join(baseWorkspaceDir, ".magister", "runtime-workspaces");
  return {
    workspaceRoot,
    metadataDir: join(workspaceRoot, "meta"),
    worktreeDir: join(workspaceRoot, "runs", taskId, runId),
    metadataPath: join(workspaceRoot, "meta", `${runId}.json`),
    artifactsBaseDir: join(baseWorkspaceDir, ".magister", "executor-artifacts", runId),
    codexHomeDir: join(baseWorkspaceDir, ".magister", "codex-home", runId),
  };
}

function shouldEnableGitWorktreeIsolation() {
  const raw = process.env.MAGISTER_RUNTIME_WORKTREE_ENABLED?.trim().toLowerCase();
  if (!raw) {
    return true;
  }

  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

const CODING_ROLE_IDS = new Set(["architect", "coder", "lander"]);

// Kimi review I1 — warn (once per (id, mismatched-path) pair) when
// the env override silently shadows a different registry path. The
// usual cause is a leftover MAGISTER_WORKSPACE_PATH_MAP from a
// pre-Path-A setup that the user has since superseded via the UI.
const envShadowWarned = new Set<string>();

export async function resolveWorkspaceBaseDir(workspaceId: string) {
  // Resolution order — env > registry > cwd. Env wins so power
  // users (and existing tests) can pin a workspace path without
  // touching the DB; the registry then handles the common path
  // (Path A picker selection); cwd is the final fallback for
  // single-workspace setups / fresh installs.
  //
  // Tier 1 — explicit env path map.
  const mapped = parseWorkspacePathMapFromEnv()[workspaceId];
  if (mapped) {
    // If the registry has a different path for this id, the env
    // override is silently shadowing it. Log once so the user can
    // notice that their UI change isn't taking effect.
    try {
      const { WorkspaceRepository } = await import("../repositories/workspace-repository");
      const row = await new WorkspaceRepository().getById(workspaceId);
      if (row?.basePath && row.basePath !== mapped) {
        const key = `${workspaceId}|${row.basePath}|${mapped}`;
        if (!envShadowWarned.has(key)) {
          envShadowWarned.add(key);
          console.warn(
            `[workspace] MAGISTER_WORKSPACE_PATH_MAP is shadowing the registered path for "${workspaceId}". Env points at "${mapped}", DB has "${row.basePath}". Unset the env to use the UI choice.`,
          );
        }
      }
    } catch { /* DB not initialized — silent */ }
    return mapped;
  }

  // Tier 2 — workspace root + id subdirectory.
  const workspaceRoot = normalizePathCandidate(process.env.MAGISTER_WORKSPACE_ROOT_DIR);
  if (workspaceRoot) {
    return join(workspaceRoot, workspaceId);
  }

  // Tier 3 (Path A) — workspaces table registry. Lazy-imported so
  // the runtime tests for the older single-workspace path don't
  // need the DB at module-load time.
  try {
    const { WorkspaceRepository } = await import("../repositories/workspace-repository");
    const repo = new WorkspaceRepository();
    const row = await repo.getById(workspaceId);
    if (row?.basePath) return row.basePath;
  } catch {
    // DB unavailable / table not initialized — fall through.
  }

  // Tier 4 — server's own cwd (legacy single-workspace fallback).
  return process.cwd();
}

export async function prepareRuntimeWorkspace(input: {
  taskId: string;
  runId: string;
  roleId: string;
  workspaceId: string;
  requestedStrategy?: WorkspaceAllocationStrategy | null;
}) {
  const baseWorkspaceDir = await resolveWorkspaceBaseDir(input.workspaceId);
  const controlDirs = buildWorkspaceControlDirs(baseWorkspaceDir, input.runId, input.taskId);
  await mkdir(controlDirs.metadataDir, { recursive: true });

  const runtimeWorkspaceRepository = new RuntimeWorkspaceRepository();
  const [gitRepository, workspaceDirty, existingRuntimeWorkspaces] = await Promise.all([
    isGitRepository(baseWorkspaceDir),
    isGitWorkspaceDirty(baseWorkspaceDir),
    runtimeWorkspaceRepository.listAll(),
  ]);
  const hasActiveCodingRun = existingRuntimeWorkspaces.some(
    (record) =>
      record.workspaceId === input.workspaceId &&
      record.runId !== input.runId &&
      record.status === "running" &&
      CODING_ROLE_IDS.has(record.roleId),
  );
  const allocationDecision = resolveWorkspaceAllocationDecision({
    roleId: input.roleId,
    isGitRepository: gitRepository,
    worktreeIsolationEnabled: shouldEnableGitWorktreeIsolation(),
    hasActiveCodingRun,
    workspaceDirty,
    requestedStrategy: input.requestedStrategy ?? null,
  });

  let strategy: RuntimeWorkspaceStrategy = allocationDecision.resolvedStrategy;
  let workspaceDir = baseWorkspaceDir;
  const baseRevision = gitRepository ? await getGitHeadRevision(baseWorkspaceDir) : null;

  if (allocationDecision.resolvedStrategy === "git_worktree") {
    const hasExistingWorktree = await exists(join(controlDirs.worktreeDir, ".git"));
    if (!hasExistingWorktree) {
      await mkdir(join(controlDirs.worktreeDir, ".."), { recursive: true });
      const addResult = await runGitCommand(baseWorkspaceDir, [
        "worktree",
        "add",
        "--detach",
        controlDirs.worktreeDir,
        "HEAD",
      ]);

      if (!addResult.ok) {
        await rm(controlDirs.worktreeDir, { recursive: true, force: true });
        strategy = "workspace_root";
      }
    }

    if (await exists(join(controlDirs.worktreeDir, ".git"))) {
      strategy = "git_worktree";
      workspaceDir = controlDirs.worktreeDir;
    } else {
      strategy = "workspace_root";
    }
  }
  const resolvedAllocationDecision: WorkspaceAllocationDecision =
    strategy === allocationDecision.resolvedStrategy
      ? allocationDecision
      : {
          ...allocationDecision,
          resolvedStrategy: "workspace_root",
          fallbackReason: allocationDecision.fallbackReason ?? "non_git_workspace",
          isolationLevel: "shared",
        };

  const now = new Date().toISOString();
  const metadata = {
    runId: input.runId,
    taskId: input.taskId,
    roleId: input.roleId,
    workspaceId: input.workspaceId,
    status: "running",
    requestedStrategy: resolvedAllocationDecision.requestedStrategy,
    strategy,
    decisionReason: resolvedAllocationDecision.decisionReason,
    baseWorkspaceDir,
    workspaceDir,
    baseRevision,
    createdAt: now,
    updatedAt: now,
    ...(resolvedAllocationDecision.fallbackReason
      ? { fallbackReason: resolvedAllocationDecision.fallbackReason }
      : {}),
  } satisfies RuntimeWorkspaceMetadata;
  await writeMetadata(controlDirs.metadataPath, metadata);
  await persistRuntimeWorkspaceRecord({
    ...metadata,
    metadataPath: controlDirs.metadataPath,
  });

  await cleanupStaleRuntimeWorkspaces(baseWorkspaceDir);

  return {
    runId: input.runId,
    taskId: input.taskId,
    roleId: input.roleId,
    workspaceId: input.workspaceId,
    requestedStrategy: resolvedAllocationDecision.requestedStrategy,
    strategy,
    decisionReason: resolvedAllocationDecision.decisionReason,
    fallbackReason: resolvedAllocationDecision.fallbackReason,
    baseWorkspaceDir,
    workspaceDir,
    baseRevision,
    artifactsBaseDir: controlDirs.artifactsBaseDir,
    codexHomeDir: controlDirs.codexHomeDir,
    metadataPath: controlDirs.metadataPath,
  } satisfies RuntimeWorkspaceLease;
}

export async function finalizeRuntimeWorkspace(input: {
  metadataPath: string;
  status: Exclude<RuntimeWorkspaceStatus, "running">;
}) {
  const metadata = await readMetadata(input.metadataPath);
  if (!metadata) {
    return;
  }

  const now = new Date().toISOString();
  const nextMetadata = {
    ...metadata,
    status: input.status,
    updatedAt: now,
    finishedAt: now,
  } satisfies RuntimeWorkspaceMetadata;
  await writeMetadata(input.metadataPath, nextMetadata);
  await persistRuntimeWorkspaceRecord({
    ...nextMetadata,
    metadataPath: input.metadataPath,
  });
}

/**
 * Cleanup is orphan-tolerant: scans the worktree directory tree directly
 * (`.magister/runtime-workspaces/runs/<taskId>/<runId>/`), not just the
 * metadata index. Earlier the scan-by-metadata approach left ~4GB of
 * orphan worktrees behind whenever a task crashed before its metadata
 * was written, or when DB rows were deleted but disk wasn't.
 *
 * Two retention rules, OR'd:
 *   1. TTL: workspace mtime older than `MAGISTER_RUNTIME_WORKSPACE_TTL_MS`
 *      (default 30 days) → drop.
 *   2. Cap: keep at most `MAGISTER_RUNTIME_WORKSPACE_MAX` most-recently-
 *      modified workspaces (default 50) → drop the rest.
 *
 * Active workspaces (status=running per metadata) are NEVER touched —
 * we don't want to nuke a worktree the agent is currently writing into.
 */
export async function cleanupStaleRuntimeWorkspaces(baseWorkspaceDir: string) {
  const ttlMs = parsePositiveInteger(process.env.MAGISTER_RUNTIME_WORKSPACE_TTL_MS, DEFAULT_TTL_MS);
  const maxKept = parsePositiveInteger(process.env.MAGISTER_RUNTIME_WORKSPACE_MAX, DEFAULT_MAX_RUNTIME_WORKSPACES);
  const workspaceRoot = join(baseWorkspaceDir, ".magister", "runtime-workspaces");
  const runsDir = join(workspaceRoot, "runs");
  const metadataDir = join(workspaceRoot, "meta");

  // Build a quick index of run-id → "is the run currently active?" from
  // metadata. Missing metadata defaults to inactive (orphan handling).
  const activeRunIds = new Set<string>();
  if (await exists(metadataDir)) {
    const metaFiles = await readdir(metadataDir).catch(() => []);
    for (const file of metaFiles) {
      if (!file.endsWith(".json")) continue;
      const metadata = await readMetadata(join(metadataDir, file));
      if (metadata?.status === "running") activeRunIds.add(metadata.runId);
    }
  }

  // Walk runs/<taskId>/<runId> two levels deep, collecting candidates
  // with their last-modified time. If runsDir doesn't exist (e.g. only
  // workspace_root strategy was ever used), candidates stays empty and
  // the metadata-sweep at the bottom still runs.
  type Candidate = { taskDir: string; runDir: string; runId: string; mtimeMs: number };
  const candidates: Candidate[] = [];
  if (await exists(runsDir)) {
    const taskDirs = await readdir(runsDir).catch(() => []);
    for (const taskName of taskDirs) {
      const taskDir = join(runsDir, taskName);
      const runDirs = await readdir(taskDir).catch(() => []);
      for (const runId of runDirs) {
        if (activeRunIds.has(runId)) continue; // never delete an in-flight run
        const runDir = join(taskDir, runId);
        const stats = await stat(runDir).catch(() => null);
        if (!stats || !stats.isDirectory()) continue;
        candidates.push({ taskDir, runDir, runId, mtimeMs: stats.mtimeMs });
      }
    }
  }

  // Sort newest-first so the head of the list is what we keep under the
  // cap rule. TTL is then applied independently.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const now = Date.now();
  const toDelete = candidates.filter((c, idx) => {
    const overTtl = now - c.mtimeMs > ttlMs;
    const overCap = idx >= maxKept;
    return overTtl || overCap;
  });

  for (const c of toDelete) {
    // Try the proper `git worktree remove` path first so the parent
    // repo's .git/worktrees/ index doesn't accumulate stale entries; if
    // git refuses (worktree already corrupt, or never registered), fall
    // back to a plain rm -rf.
    const removeResult = await runGitCommand(baseWorkspaceDir, [
      "worktree",
      "remove",
      "--force",
      c.runDir,
    ]);
    if (!removeResult.ok) {
      await rm(c.runDir, { recursive: true, force: true });
    }

    // Drop the matching metadata file if it exists, and the parent
    // taskDir if it's now empty (otherwise empty taskDirs accumulate).
    await rm(join(metadataDir, `${c.runId}.json`), { force: true });
    const remaining = await readdir(c.taskDir).catch(() => null);
    if (remaining && remaining.length === 0) {
      await rm(c.taskDir, { recursive: true, force: true });
    }
  }

  // Best-effort prune of the parent repo's worktree index — keeps git's
  // own bookkeeping in sync after we deleted directories out from under
  // it via fallback rm.
  if (toDelete.length > 0) {
    await runGitCommand(baseWorkspaceDir, ["worktree", "prune"]);
  }

  // Second pass: prune leftover metadata files past TTL even if they
  // never had a corresponding run directory (e.g. `workspace_root`
  // strategy where the run shared the repo root and no worktree was
  // ever created, or whose run dir was already removed).
  if (await exists(metadataDir)) {
    const metaFiles = await readdir(metadataDir).catch(() => []);
    for (const file of metaFiles) {
      if (!file.endsWith(".json")) continue;
      const metadataPath = join(metadataDir, file);
      const metadata = await readMetadata(metadataPath);
      if (!metadata || metadata.status === "running") continue;
      const finishedAt = metadata.finishedAt ? Date.parse(metadata.finishedAt) : null;
      if (!finishedAt || !Number.isFinite(finishedAt)) continue;
      if (now - finishedAt < ttlMs) continue;
      await rm(metadataPath, { force: true });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Periodic cleanup loop
// ──────────────────────────────────────────────────────────────────────

const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

let cleanupLoopTimer: ReturnType<typeof setInterval> | null = null;
let cleanupLoopInFlight = false;

/**
 * Start a periodic background tick that runs `cleanupStaleRuntimeWorkspaces`
 * against `process.cwd()` (the repo root). Replaces the previous design
 * where cleanup only fired on new task creation — that left disk usage
 * unbounded if no new task ever arrived after a test burst. The 30-day
 * TTL + 50-workspace cap policy is enforced here.
 *
 * Disabled by setting MAGISTER_RUNTIME_WORKSPACE_CLEANUP_ENABLED=false.
 */
export async function startRuntimeWorkspaceCleanupLoop() {
  const enabled = (process.env.MAGISTER_RUNTIME_WORKSPACE_CLEANUP_ENABLED ?? "true")
    .toLowerCase() !== "false";
  if (!enabled || cleanupLoopTimer) return;

  const intervalMs = parsePositiveInteger(
    process.env.MAGISTER_RUNTIME_WORKSPACE_CLEANUP_INTERVAL_MS,
    DEFAULT_CLEANUP_INTERVAL_MS,
  );

  const tick = async () => {
    if (cleanupLoopInFlight) return;
    cleanupLoopInFlight = true;
    try {
      await cleanupStaleRuntimeWorkspaces(process.cwd());
    } catch {
      // Cleanup is best-effort; one failed sweep doesn't block the next.
    } finally {
      cleanupLoopInFlight = false;
    }
  };

  // Run once at startup so a long-stopped server immediately reclaims
  // disk, then schedule.
  await tick();
  cleanupLoopTimer = setInterval(() => { void tick(); }, intervalMs);
}

export async function stopRuntimeWorkspaceCleanupLoop() {
  if (!cleanupLoopTimer) return;
  clearInterval(cleanupLoopTimer);
  cleanupLoopTimer = null;
}
