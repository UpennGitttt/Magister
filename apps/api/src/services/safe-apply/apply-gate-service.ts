import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactRepository } from "../../repositories/artifact-repository";
import {
  ChangeReviewConflictError,
  ChangeReviewNotFoundError,
  ChangeReviewRepository,
  type ChangeReviewRow,
} from "../../repositories/change-review-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import { WorkspaceRepository } from "../../repositories/workspace-repository";
import { ApplyLockBusyError, acquireApplyLock } from "./apply-lock-service";

const GIT_COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
] as const;

const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_COMMAND_KILL_GRACE_MS = 2_000;

export class ApplyGateConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApplyGateConflictError";
  }
}

export class ApplyGatePatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApplyGatePatchError";
  }
}

export class ApplyGateApplyFailedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApplyGateApplyFailedError";
  }
}

export type GitResult = {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
};

type GitRunner = (cwd: string, args: string[], input?: Buffer) => Promise<GitResult>;

export type ApplyChangeReviewInput = {
  reviewId: string;
  expectedDiffHash: string;
  actorId?: string | null;
  changeReviewRepository?: ChangeReviewRepository;
  artifactRepository?: ArtifactRepository;
  workspaceRepository?: WorkspaceRepository;
  executionEventRepository?: ExecutionEventRepository;
  gitRunner?: GitRunner;
};

export type ApplyChangeReviewResult = {
  review: ChangeReviewRow;
  idempotent: boolean;
  appliedPatchHash: string;
};

// Lightweight applicability probe for the detail
// endpoint. Mirrors the BASE-revision guard from applyChangeReview
// without taking the apply lock or touching the working tree, so the
// UI can disable the Apply button (and badge the review as "Stale")
// before the operator clicks. Reasons returned line up with the
// codes already used by ApplyGateConflictError so the frontend can
// route them through the same display path.
export type ChangeReviewApplicability =
  | { applicable: true }
  | {
      applicable: false;
      code:
        | "workspace_missing"
        | "base_revision_missing"
        | "base_revision_unreadable"
        | "base_revision_mismatch"
        | "workspace_status_unreadable"
        | "workspace_dirty"
        | "patch_unreadable"
        | "patch_hash_mismatch"
        | "patch_check_failed";
      reason: string;
      currentHead?: string;
      baseRevision?: string | null;
    };

export async function computeChangeReviewApplicability(input: {
  reviewId: string;
  changeReviewRepository?: ChangeReviewRepository;
  artifactRepository?: ArtifactRepository;
  workspaceRepository?: WorkspaceRepository;
  gitRunner?: GitRunner;
}): Promise<ChangeReviewApplicability> {
  const changeReviewRepository = input.changeReviewRepository ?? new ChangeReviewRepository();
  const artifactRepository = input.artifactRepository ?? new ArtifactRepository();
  const workspaceRepository = input.workspaceRepository ?? new WorkspaceRepository();
  const gitRunner = input.gitRunner ?? runGit;

  const review = await changeReviewRepository.getById(input.reviewId);
  if (!review) {
    throw new ChangeReviewNotFoundError(input.reviewId);
  }
  const workspace = await workspaceRepository.getById(review.workspaceId);
  if (!workspace) {
    return {
      applicable: false,
      code: "workspace_missing",
      reason: `Workspace not found: ${review.workspaceId}`,
    };
  }
  if (!review.baseRevision) {
    return {
      applicable: false,
      code: "base_revision_missing",
      reason: "change review does not record a base revision",
    };
  }
  const head = await gitRunner(workspace.basePath, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return {
      applicable: false,
      code: "base_revision_unreadable",
      reason: summarizeGitFailure(head),
      baseRevision: review.baseRevision,
    };
  }
  const current = head.stdout.toString("utf8").trim();
  if (current !== review.baseRevision) {
    return {
      applicable: false,
      code: "base_revision_mismatch",
      reason: `Workspace HEAD ${current || "(unknown)"} does not match review base revision ${review.baseRevision}`,
      currentHead: current,
      baseRevision: review.baseRevision,
    };
  }

  const patchFilePaths = extractPatchFilePaths(review.changedFilesJson);
  const dirty = await getWorkspaceDirtyPaths(workspace.basePath, gitRunner);
  if (!dirty.ok) {
    return {
      applicable: false,
      code: "workspace_status_unreadable",
      reason: dirty.reason,
      currentHead: current,
      baseRevision: review.baseRevision,
    };
  }
  const dirtyPaths = dirty.paths;
  if (dirtyPaths.length > 0) {
    const conflicting = patchFilePaths.size > 0
      ? dirtyPaths.filter((path) => patchFilePaths.has(path))
      : dirtyPaths;
    if (conflicting.length > 0) {
      return {
        applicable: false,
        code: "workspace_dirty",
        reason: `Workspace has local changes that conflict with the patch: ${conflicting.slice(0, 5).join(", ")}`,
        currentHead: current,
        baseRevision: review.baseRevision,
      };
    }
  }

  let patchBytes: Buffer;
  try {
    patchBytes = await readVerifiedPatchBytes(review, artifactRepository);
  } catch (error) {
    if (error instanceof ApplyGatePatchError) {
      return {
        applicable: false,
        code: error.code === "patch_hash_mismatch" ? "patch_hash_mismatch" : "patch_unreadable",
        reason: error.message,
        currentHead: current,
        baseRevision: review.baseRevision,
      };
    }
    throw error;
  }
  const check = await gitRunner(workspace.basePath, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], patchBytes);
  if (!check.ok) {
    return {
      applicable: false,
      code: "patch_check_failed",
      reason: summarizeGitFailure(check),
      currentHead: current,
      baseRevision: review.baseRevision,
    };
  }
  return { applicable: true };
}

export async function applyChangeReview(input: ApplyChangeReviewInput): Promise<ApplyChangeReviewResult> {
  const changeReviewRepository = input.changeReviewRepository ?? new ChangeReviewRepository();
  const artifactRepository = input.artifactRepository ?? new ArtifactRepository();
  const workspaceRepository = input.workspaceRepository ?? new WorkspaceRepository();
  const executionEventRepository = input.executionEventRepository ?? new ExecutionEventRepository();
  const gitRunner = input.gitRunner ?? runGit;

  const firstRead = await changeReviewRepository.getById(input.reviewId);
  if (!firstRead) {
    throw new ChangeReviewNotFoundError(input.reviewId);
  }
  const workspace = await workspaceRepository.getById(firstRead.workspaceId);
  if (!workspace) {
    throw new ApplyGateConflictError("workspace_missing", `Workspace not found: ${firstRead.workspaceId}`);
  }

  let lock: Awaited<ReturnType<typeof acquireApplyLock>> | null = null;
  try {
    lock = await acquireApplyLock({
      workspaceId: workspace.id,
      workspacePath: workspace.basePath,
      reviewId: input.reviewId,
    });
    const review = await changeReviewRepository.getById(input.reviewId);
    if (!review) {
      throw new ChangeReviewNotFoundError(input.reviewId);
    }
    validateReviewEligibility(review, input.expectedDiffHash);

    const patchBytes = await readVerifiedPatchBytes(review, artifactRepository);
    const patchHash = createHash("sha256").update(patchBytes).digest("hex");

    await assertWorkspaceAtBaseRevision(workspace.basePath, review.baseRevision, gitRunner);
    const patchFilePaths = extractPatchFilePaths(review.changedFilesJson);
    await assertWorkspaceClean(workspace.basePath, gitRunner, patchFilePaths);
    const patchPath = await writeApplyPatchFile(workspace.basePath, patchBytes);
    let applyResult: GitResult | null = null;
    try {
      await assertGitApplyCheck(workspace.basePath, patchPath, gitRunner);
      applyResult = await gitRunner(workspace.basePath, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
    } finally {
      await unlink(patchPath).catch(() => undefined);
    }
    if (!applyResult) {
      throw new ApplyGateApplyFailedError("apply_failed", "git apply did not produce a result");
    }
    if (!applyResult.ok) {
      await recordApplyFailureBestEffort({
        review,
        expectedDiffHash: input.expectedDiffHash,
        actorId: input.actorId ?? null,
        failureCode: "apply_failed",
        failureMessage: summarizeGitFailure(applyResult),
        changeReviewRepository,
        executionEventRepository,
      });
      throw new ApplyGateApplyFailedError("apply_failed", summarizeGitFailure(applyResult));
    }

    // Phase 4 known gap: if the process dies after git apply succeeds but
    // before this state update commits, the filesystem is mutated while
    // DB state remains not_applied. Acceptable for single-operator
    // localhost; revisit if Magister ever ships to multi-user contexts.
    const now = new Date();
    const recorded = await changeReviewRepository.recordApplySuccess({
      reviewId: review.id,
      expectedDiffHash: input.expectedDiffHash,
      actorId: input.actorId ?? null,
      appliedPatchHash: patchHash,
    });
    await createExecutionEventBestEffort(executionEventRepository, {
      id: `event_${crypto.randomUUID()}`,
      type: "safe_apply.change_review_applied",
      taskId: recorded.review.taskId,
      roleRuntimeId: recorded.review.roleRuntimeId,
      workspaceId: recorded.review.workspaceId,
      severity: "info",
      payloadJson: JSON.stringify({
        reviewId: recorded.review.id,
        diffHash: recorded.review.diffHash,
        appliedPatchHash: patchHash,
      }),
      occurredAt: recorded.review.appliedAt ?? now,
    });

    return {
      review: recorded.review,
      idempotent: false,
      appliedPatchHash: patchHash,
    };
  } catch (error) {
    if (error instanceof ApplyLockBusyError) {
      throw new ApplyGateConflictError("apply_lock_busy", error.message);
    }
    throw error;
  } finally {
    await lock?.release();
  }
}

async function createExecutionEventBestEffort(
  repository: ExecutionEventRepository,
  event: Parameters<ExecutionEventRepository["create"]>[0],
) {
  try {
    await repository.create(event);
  } catch (error) {
    console.error("[safe-apply] failed to emit execution event", error);
  }
}

function validateReviewEligibility(review: ChangeReviewRow, expectedDiffHash: string) {
  if (review.diffHash !== expectedDiffHash) {
    throw new ApplyGateConflictError("stale_diff_hash", "expectedDiffHash does not match current review diffHash");
  }
  if (review.decisionState !== "approved") {
    throw new ApplyGateConflictError("not_approved", `review is ${review.decisionState}; approved review is required to apply`);
  }
  if (review.applyState === "applied") {
    throw new ApplyGateConflictError("already_applied", "change review has already been applied");
  }
  if (review.applyState === "apply_failed") {
    throw new ApplyGateConflictError("apply_failed", "change review previously failed to apply");
  }
  if (review.applyState !== "not_applied") {
    throw new ApplyGateConflictError("apply_state_invalid", `change review apply state is ${review.applyState}`);
  }
  if (!review.baseRevision) {
    throw new ApplyGateConflictError("base_revision_mismatch", "change review does not record a base revision");
  }
}

async function readVerifiedPatchBytes(review: ChangeReviewRow, artifactRepository: ArtifactRepository) {
  const artifact = await artifactRepository.getById(review.diffArtifactId);
  if (!artifact) {
    throw new ApplyGatePatchError("patch_unreadable", `Runtime diff artifact not found: ${review.diffArtifactId}`);
  }
  if (artifact.artifactType !== "runtime_diff" || artifact.storageKind !== "file") {
    throw new ApplyGatePatchError(
      "patch_unreadable",
      `Change review diff artifact is not a file-backed runtime_diff artifact: ${review.diffArtifactId}`,
    );
  }
  let patchBytes: Buffer;
  try {
    patchBytes = await readFile(artifact.storageRef);
  } catch (error) {
    throw new ApplyGatePatchError(
      "patch_unreadable",
      error instanceof Error ? `Unable to read runtime diff artifact: ${error.message}` : "Unable to read runtime diff artifact.",
    );
  }
  const patchHash = createHash("sha256").update(patchBytes).digest("hex");
  if (patchHash !== review.diffHash) {
    throw new ApplyGatePatchError("patch_hash_mismatch", "Stored patch bytes do not match the reviewed diff hash");
  }
  return patchBytes;
}

async function assertWorkspaceAtBaseRevision(workspacePath: string, baseRevision: string | null, gitRunner: GitRunner) {
  if (!baseRevision) {
    throw new ApplyGateConflictError("base_revision_mismatch", "change review does not record a base revision");
  }
  const head = await gitRunner(workspacePath, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    throw new ApplyGateConflictError("base_revision_unreadable", summarizeGitFailure(head));
  }
  const current = head.stdout.toString("utf8").trim();
  if (current !== baseRevision) {
    throw new ApplyGateConflictError(
      "base_revision_mismatch",
      `Workspace HEAD ${current || "(unknown)"} does not match review base revision ${baseRevision}`,
    );
  }
}

async function assertWorkspaceClean(workspacePath: string, gitRunner: GitRunner, patchFilePaths?: Set<string>) {
  const dirty = await getWorkspaceDirtyPaths(workspacePath, gitRunner);
  if (!dirty.ok) {
    throw new ApplyGateConflictError("workspace_status_unreadable", dirty.reason);
  }
  const dirtyPaths = dirty.paths;
  if (dirtyPaths.length === 0) return;
  if (patchFilePaths && patchFilePaths.size > 0) {
    const conflicting = dirtyPaths.filter((p) => patchFilePaths.has(p));
    if (conflicting.length > 0) {
      throw new ApplyGateConflictError("workspace_dirty", `Workspace has local changes that conflict with the patch: ${conflicting.slice(0, 5).join(", ")}`);
    }
    return;
  }
  throw new ApplyGateConflictError("workspace_dirty", `Workspace has local changes: ${dirtyPaths.slice(0, 5).join(", ")}`);
}

async function getWorkspaceDirtyPaths(
  workspacePath: string,
  gitRunner: GitRunner,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const status = await gitRunner(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) {
    return { ok: false, reason: summarizeGitFailure(status) };
  }
  return {
    ok: true,
    paths: parsePorcelainStatusPaths(status.stdout.toString("utf8"))
      .filter((path) => path.length > 0)
      .filter((path) => !isInternalWorkspacePath(path)),
  };
}

async function assertGitApplyCheck(workspacePath: string, patchPath: string, gitRunner: GitRunner) {
  const result = await gitRunner(workspacePath, ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath]);
  if (!result.ok) {
    throw new ApplyGatePatchError("patch_check_failed", summarizeGitFailure(result));
  }
}

async function writeApplyPatchFile(workspacePath: string, patchBytes: Buffer) {
  const dir = join(workspacePath, ".magister", "safe-apply", "apply");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${crypto.randomUUID()}.patch`);
  await writeFile(path, patchBytes);
  return path;
}

async function recordApplyFailureBestEffort(input: {
  review: ChangeReviewRow;
  expectedDiffHash: string;
  actorId: string | null;
  failureCode: string;
  failureMessage: string;
  changeReviewRepository: ChangeReviewRepository;
  executionEventRepository: ExecutionEventRepository;
}) {
  try {
    const recorded = await input.changeReviewRepository.recordApplyFailure({
      reviewId: input.review.id,
      expectedDiffHash: input.expectedDiffHash,
      actorId: input.actorId,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
    });
    await input.executionEventRepository.create({
      id: `event_${crypto.randomUUID()}`,
      type: "safe_apply.change_review_apply_failed",
      taskId: recorded.review.taskId,
      roleRuntimeId: recorded.review.roleRuntimeId,
      workspaceId: recorded.review.workspaceId,
      severity: "error",
      payloadJson: JSON.stringify({
        reviewId: recorded.review.id,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
      }),
      occurredAt: new Date(),
    });
  } catch (error) {
    console.error("[safe-apply] failed to record apply failure", error);
  }
}

function extractPatchFilePaths(changedFilesJson: string): Set<string> {
  try {
    const parsed = JSON.parse(changedFilesJson);
    if (!Array.isArray(parsed)) return new Set();
    const paths: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === "string") paths.push(entry);
      else if (entry && typeof entry === "object" && typeof entry.path === "string") paths.push(entry.path);
    }
    return new Set(paths.filter((p) => p.length > 0));
  } catch {
    return new Set();
  }
}

// exported so leader-apply-service can apply the same
// "ignore Magister's own bookkeeping under .magister/.local" filter.
export function isInternalWorkspacePath(path: string) {
  return path === ".magister" || path.startsWith(".magister/") || path === ".local" || path.startsWith(".local/");
}

export function parsePorcelainStatusPaths(output: string) {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!isPorcelainStatusEntry(entry)) {
      paths.push(entry);
      continue;
    }
    paths.push(entry.slice(3));
    const status = entry.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      const companion = entries[index + 1];
      if (companion) {
        paths.push(companion);
        index += 1;
      }
    }
  }
  return paths;
}

function isPorcelainStatusEntry(entry: string) {
  if (entry.length < 4 || entry[2] !== " ") return false;
  return /^[ MADRCU?!][ MADRCU?!]$/.test(entry.slice(0, 2));
}

function summarizeGitFailure(result: GitResult) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.toString("utf8").trim();
  const detail = stderr || stdout || `git exited with code ${result.exitCode ?? "unknown"}`;
  return detail.slice(0, 2_000);
}

function buildGitCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_COMMAND_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

// Exported for the Phase 1b-3 leader-apply path so
// commit/apply-R go through the same 30s-timeout + SIGTERM/SIGKILL
// escalation other safe-apply git calls use. Codex v3 HIGH 1.
export async function runGit(cwd: string, args: string[], input?: Buffer): Promise<GitResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = "";
    const child = spawn("git", args, {
      cwd,
      env: buildGitCommandEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stderr += `git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, GIT_COMMAND_KILL_GRACE_MS);
    }, GIT_COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdout),
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
      });
    });
    child.on("close", (code) => {
      finish({
        ok: !timedOut && code === 0,
        stdout: Buffer.concat(stdout),
        stderr,
        exitCode: code,
      });
    });
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
