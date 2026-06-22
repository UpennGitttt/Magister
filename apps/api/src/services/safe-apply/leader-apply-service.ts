// Phase 1b-3 of the Leader-driven review autonomy RFC
// (docs/plans/2026-05-24-leader-review-autonomy-v3.md).
//
// applyChangeReviewAsLeader: Leader's privileged apply tool. Lands a
// reviewed patch on disk + commits it + writes the apply result back
// to the change_review row. Dormant in production until a workspace
// flips to `review_policy_json={"mode":"leader-driven"}`.
//
// Threading the codex-v3-reviewed design:
//
//   1. Verdict gate (high-confidence APPROVE required)
//   2. Atomic claim: apply_state='applying'
//   3. Apply lock acquisition with bounded retry (5/15/30s)
//   4. HEAD verification (expectedWorkspaceHead vs current)
//   5. Base-revision verification (review.baseRevision vs current)
//   6. Workspace clean check
//   7. git apply --check
//   8. git apply (real); on failure, attempt git apply -R; failed
//      reverse → partially_applied
//   9. git add + git commit (NO --no-verify, via runGit so the
//      timeout + SIGKILL escalation applies)
//   10. on commit failure → git apply -R; failed reverse → partially_applied
//   11. final atomic DB write: apply_state='applied' + decision_state='approved'
//       + leader_apply_commit_sha
//
// Crash recovery: see reconcileOrphanApplyingReviews — runs at every
// API boot, reverts apply_state='applying' rows older than the lock TTL.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, lt, sql } from "@magister/db";
import { changeReviews, createDb } from "@magister/db";

import { ArtifactRepository } from "../../repositories/artifact-repository";
import { ChangeReviewRepository, type ChangeReviewRow } from "../../repositories/change-review-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import { WorkspaceRepository } from "../../repositories/workspace-repository";
import { ApplyLockBusyError, acquireApplyLock } from "./apply-lock-service";
import {
  runGit,
  isInternalWorkspacePath,
  parsePorcelainStatusPaths,
  type GitResult,
} from "./apply-gate-service";
import { getReviewerVerdictForReview } from "./reviewer-verdict-service";

export type ApplyChangeReviewAsLeaderInput = {
  reviewId: string;
  reasoning: string;
  expectedDiffHash: string;
  expectedWorkspaceHead?: string;
  decidedBy: string; // "leader:<role_runtime_id>"
};

export type ApplyChangeReviewAsLeaderResult =
  | { ok: true; commitSha: string; warnings: string[] }
  | { ok: false; code: ApplyFailureCode; message: string };

export type ApplyFailureCode =
  | "not_found"
  | "verdict_required"
  | "verdict_insufficient"
  | "race_lost"
  | "lock_busy"
  | "head_drift"
  | "base_revision_mismatch"
  | "workspace_dirty"
  | "patch_check_failed"
  | "apply_failed"
  | "commit_failed"
  | "partially_applied"
  | "db_drift"
  | "workspace_missing"
  | "diff_unreadable";

const LOCK_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const APPLY_ORPHAN_TTL_MS = 10 * 60 * 1000; // matches apply-lock TTL

function summarizeGitFailure(r: GitResult): string {
  const stderr = (r.stderr ?? "").toString().trim();
  return stderr.length > 0 ? stderr.slice(0, 500) : `git exited with code ${r.exitCode}`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Try to atomically claim the 'applying' slot. Returns true iff
 * UPDATE ... WHERE id=? AND assignee='leader' AND decision_state='pending'
 *                AND apply_state='not_applied' AND diff_hash=$expectedDiffHash
 * affected exactly one row.
 */
async function claimApplyingSlot(input: {
  reviewId: string;
  decidedBy: string;
  expectedDiffHash: string;
}): Promise<boolean> {
  const db = createDb();
  const now = new Date();
  // Codex v3 5-审 BLOCKER fix: re-read after UPDATE cannot prove
  // *this* caller won the race because two calls from the same
  // role_runtime would both see `decidedBy=self`. Use drizzle
  // bun-sqlite's `{ changes }` count — only `changes === 1` proves
  // OUR UPDATE was the one that flipped the row.
  const result = await db
    .update(changeReviews)
    .set({
      applyState: "applying",
      decidedBy: input.decidedBy,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeReviews.id, input.reviewId),
        eq(changeReviews.assignee, "leader"),
        inArray(changeReviews.decisionState, ["pending"]),
        eq(changeReviews.applyState, "not_applied"),
        eq(changeReviews.diffHash, input.expectedDiffHash),
      ),
    );
  const changes = (result as unknown as { changes?: number }).changes ?? 0;
  return changes === 1;
}

async function revertApplyingSlot(reviewId: string, decidedBy: string): Promise<void> {
  const db = createDb();
  const now = new Date();
  // Only revert if WE still own the claim — otherwise the row may
  // have been advanced by a later step (success path) or by a
  // reconciler.
  await db
    .update(changeReviews)
    .set({ applyState: "not_applied", decidedBy: null, updatedAt: now })
    .where(
      and(
        eq(changeReviews.id, reviewId),
        eq(changeReviews.applyState, "applying"),
        eq(changeReviews.decidedBy, decidedBy),
      ),
    );
}

async function markPartiallyApplied(input: {
  reviewId: string;
  decidedBy: string;
  reason: string;
}): Promise<void> {
  const db = createDb();
  const now = new Date();
  await db
    .update(changeReviews)
    .set({
      applyState: "partially_applied",
      decisionReason: input.reason.slice(0, 500),
      updatedAt: now,
    })
    .where(
      and(
        eq(changeReviews.id, input.reviewId),
        eq(changeReviews.applyState, "applying"),
        eq(changeReviews.decidedBy, input.decidedBy),
      ),
    );
}

async function markApplyFailed(input: {
  reviewId: string;
  decidedBy: string;
  reason: string;
}): Promise<void> {
  const db = createDb();
  const now = new Date();
  await db
    .update(changeReviews)
    .set({
      applyState: "apply_failed",
      decisionReason: input.reason.slice(0, 500),
      updatedAt: now,
    })
    .where(
      and(
        eq(changeReviews.id, input.reviewId),
        eq(changeReviews.applyState, "applying"),
        eq(changeReviews.decidedBy, input.decidedBy),
      ),
    );
}

export async function applyChangeReviewAsLeader(
  input: ApplyChangeReviewAsLeaderInput,
): Promise<ApplyChangeReviewAsLeaderResult> {
  const warnings: string[] = [];
  const reviewRepo = new ChangeReviewRepository();
  const workspaceRepo = new WorkspaceRepository();
  const events = new ExecutionEventRepository();
  const artifacts = new ArtifactRepository();

  // Step 1 — verdict gate.
  const review = await reviewRepo.getById(input.reviewId);
  if (!review) {
    return { ok: false, code: "not_found", message: `change_review ${input.reviewId} not found` };
  }
  if (review.diffHash !== input.expectedDiffHash) {
    return {
      ok: false,
      code: "race_lost",
      message: `diff hash mismatch (expected ${input.expectedDiffHash}, got ${review.diffHash})`,
    };
  }
  if (review.assignee !== "leader") {
    return {
      ok: false,
      code: "race_lost",
      message: `review ${review.id} is assigned to ${review.assignee}, not leader`,
    };
  }
  if (!review.reviewerVerdictArtifactId) {
    return {
      ok: false,
      code: "verdict_required",
      message: "no reviewer verdict artifact attached; spawn a reviewer first",
    };
  }
  const verdict = await getReviewerVerdictForReview(review.id);
  if (!verdict) {
    return {
      ok: false,
      code: "verdict_required",
      message: "reviewer verdict artifact is missing or malformed",
    };
  }
  if (verdict.verdict !== "APPROVE" || verdict.confidence !== "high") {
    return {
      ok: false,
      code: "verdict_insufficient",
      message: `reviewer verdict is ${verdict.verdict}/${verdict.confidence}; only high+APPROVE permits leader apply`,
    };
  }

  // Step 2 — atomic claim.
  const claimed = await claimApplyingSlot({
    reviewId: review.id,
    decidedBy: input.decidedBy,
    expectedDiffHash: input.expectedDiffHash,
  });
  if (!claimed) {
    return {
      ok: false,
      code: "race_lost",
      message: "could not claim the applying slot — operator override or another caller raced",
    };
  }

  const workspace = await workspaceRepo.getById(review.workspaceId);
  if (!workspace) {
    await revertApplyingSlot(review.id, input.decidedBy);
    return {
      ok: false,
      code: "workspace_missing",
      message: `workspace ${review.workspaceId} no longer exists`,
    };
  }
  const workspacePath = workspace.basePath;

  // Step 3 — apply lock with bounded retry.
  let lock: Awaited<ReturnType<typeof acquireApplyLock>> | null = null;
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      lock = await acquireApplyLock({
        workspaceId: workspace.id,
        workspacePath,
        reviewId: review.id,
      });
      break;
    } catch (err) {
      if (!(err instanceof ApplyLockBusyError)) {
        await revertApplyingSlot(review.id, input.decidedBy);
        throw err;
      }
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        await revertApplyingSlot(review.id, input.decidedBy);
        await events.create({
          id: `event_${randomUUID()}`,
          type: "safe_apply.change_review_apply_lock_busy",
          taskId: review.taskId,
          roleRuntimeId: review.roleRuntimeId,
          workspaceId: review.workspaceId,
          artifactId: review.reviewDraftArtifactId,
          severity: "warn",
          payloadJson: JSON.stringify({ reviewId: review.id, attempts: attempt + 1 }),
          occurredAt: new Date(),
        });
        return {
          ok: false,
          code: "lock_busy",
          message: `apply lock busy on workspace ${workspace.id} after ${attempt + 1} attempts (≈${LOCK_RETRY_DELAYS_MS.slice(0, attempt + 1).reduce((a, b) => a + b, 0) / 1000}s)`,
        };
      }
      await sleep(delay);
    }
  }
  if (!lock) {
    await revertApplyingSlot(review.id, input.decidedBy);
    return { ok: false, code: "lock_busy", message: "apply lock retry exhausted" };
  }

  // From here we MUST `lock.release()` before returning.
  try {
    // Step 4 — expectedWorkspaceHead drift check (optional).
    if (input.expectedWorkspaceHead) {
      const head = await runGit(workspacePath, ["rev-parse", "HEAD"]);
      if (!head.ok) {
        await revertApplyingSlot(review.id, input.decidedBy);
        return {
          ok: false,
          code: "head_drift",
          message: `git rev-parse HEAD failed: ${summarizeGitFailure(head)}`,
        };
      }
      const current = head.stdout.toString("utf8").trim();
      if (current !== input.expectedWorkspaceHead) {
        await revertApplyingSlot(review.id, input.decidedBy);
        return {
          ok: false,
          code: "head_drift",
          message: `workspace HEAD ${current} != expected ${input.expectedWorkspaceHead}`,
        };
      }
    }

    // Step 5 — base-revision check.
    if (review.baseRevision) {
      const head = await runGit(workspacePath, ["rev-parse", "HEAD"]);
      if (!head.ok) {
        await revertApplyingSlot(review.id, input.decidedBy);
        return {
          ok: false,
          code: "head_drift",
          message: summarizeGitFailure(head),
        };
      }
      const current = head.stdout.toString("utf8").trim();
      if (current !== review.baseRevision) {
        await revertApplyingSlot(review.id, input.decidedBy);
        return {
          ok: false,
          code: "base_revision_mismatch",
          message: `workspace HEAD ${current} != review.baseRevision ${review.baseRevision}`,
        };
      }
    }

    // Step 6 — workspace clean.
    const status = await runGit(workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (!status.ok) {
      await revertApplyingSlot(review.id, input.decidedBy);
      return {
        ok: false,
        code: "workspace_dirty",
        message: `git status failed: ${summarizeGitFailure(status)}`,
      };
    }
    // Filter out Magister's own internal bookkeeping (the apply-lock
    // file we just placed, plus any stray .magister/.local entries).
    const dirtyPaths = parsePorcelainStatusPaths(status.stdout.toString("utf8"))
      .filter((p) => p.length > 0 && !isInternalWorkspacePath(p));
    if (dirtyPaths.length > 0) {
      const patchFilePaths = parsePatchFilePaths(review.changedFilesJson);
      const conflicting = patchFilePaths.size > 0
        ? dirtyPaths.filter((p) => patchFilePaths.has(p))
        : dirtyPaths;
      if (conflicting.length > 0) {
        await revertApplyingSlot(review.id, input.decidedBy);
        return {
          ok: false,
          code: "workspace_dirty",
          message: `workspace has local changes that conflict with the patch: ${conflicting.slice(0, 5).join(", ")}`,
        };
      }
    }

    // Step 7 — git apply --check + load patch.
    const diffArtifact = await artifacts.getById(review.diffArtifactId);
    if (!diffArtifact) {
      await revertApplyingSlot(review.id, input.decidedBy);
      return {
        ok: false,
        code: "diff_unreadable",
        message: `diff artifact ${review.diffArtifactId} missing`,
      };
    }
    const patchBytes = await readFile(diffArtifact.storageRef).catch(() => null);
    if (!patchBytes) {
      await revertApplyingSlot(review.id, input.decidedBy);
      return {
        ok: false,
        code: "diff_unreadable",
        message: `failed to read diff artifact at ${diffArtifact.storageRef}`,
      };
    }
    // Write patch to a tmp file inside .magister/safe-apply/apply/
    const applyDir = join(workspacePath, ".magister", "safe-apply", "apply");
    await mkdir(applyDir, { recursive: true });
    const patchPath = join(applyDir, `leader-${review.id}.patch`);
    await writeFile(patchPath, patchBytes);

    const cleanupPatch = async () => {
      try {
        await unlink(patchPath);
      } catch {
        /* best-effort */
      }
    };

    try {
      const check = await runGit(workspacePath, [
        "apply",
        "--check",
        "--binary",
        "--whitespace=nowarn",
        patchPath,
      ]);
      if (!check.ok) {
        await markApplyFailed({
          reviewId: review.id,
          decidedBy: input.decidedBy,
          reason: `patch_check_failed: ${summarizeGitFailure(check)}`,
        });
        return {
          ok: false,
          code: "patch_check_failed",
          message: summarizeGitFailure(check),
        };
      }

      // Step 8 — real apply.
      const apply = await runGit(workspacePath, [
        "apply",
        "--binary",
        "--whitespace=nowarn",
        patchPath,
      ]);
      if (!apply.ok) {
        // Try reverse for cleanup.
        const reverse = await runGit(workspacePath, [
          "apply",
          "-R",
          "--binary",
          "--whitespace=nowarn",
          patchPath,
        ]);
        if (reverse.ok) {
          await markApplyFailed({
            reviewId: review.id,
            decidedBy: input.decidedBy,
            reason: `apply_failed: ${summarizeGitFailure(apply)}`,
          });
          return {
            ok: false,
            code: "apply_failed",
            message: summarizeGitFailure(apply),
          };
        }
        // Reverse also failed — dirty tree.
        await markPartiallyApplied({
          reviewId: review.id,
          decidedBy: input.decidedBy,
          reason: `apply_failed + reverse_failed: apply=${summarizeGitFailure(apply)}; reverse=${summarizeGitFailure(reverse)}`,
        });
        await events.create({
          id: `event_${randomUUID()}`,
          type: "safe_apply.change_review_apply_partial",
          taskId: review.taskId,
          roleRuntimeId: review.roleRuntimeId,
          workspaceId: review.workspaceId,
          artifactId: review.reviewDraftArtifactId,
          severity: "error",
          payloadJson: JSON.stringify({
            reviewId: review.id,
            applyError: summarizeGitFailure(apply),
            reverseError: summarizeGitFailure(reverse),
          }),
          occurredAt: new Date(),
        });
        return {
          ok: false,
          code: "partially_applied",
          message: "apply failed and reverse also failed; workspace is dirty — operator must intervene",
        };
      }

      // Step 9 — stage + commit.
      const changedFiles = parseChangedFilePaths(review.changedFilesJson);
      const stage = await runGit(workspacePath, ["add", "--all", "--", ...changedFiles]);
      if (!stage.ok) {
        const reverse = await runGit(workspacePath, [
          "apply",
          "-R",
          "--binary",
          "--whitespace=nowarn",
          patchPath,
        ]);
        if (reverse.ok) {
          await markApplyFailed({
            reviewId: review.id,
            decidedBy: input.decidedBy,
            reason: `stage_failed: ${summarizeGitFailure(stage)}`,
          });
          return { ok: false, code: "apply_failed", message: `git add failed: ${summarizeGitFailure(stage)}` };
        }
        await markPartiallyApplied({
          reviewId: review.id,
          decidedBy: input.decidedBy,
          reason: `stage_failed + reverse_failed`,
        });
        return {
          ok: false,
          code: "partially_applied",
          message: "git add failed and reverse failed",
        };
      }

      const commit = await runGit(workspacePath, [
        "-c", "user.email=magister-leader@local",
        "-c", "user.name=Magister Leader",
        "commit",
        "-m", `leader-applied change_review ${review.id}`,
        "-m", "",
        "-m", input.reasoning.slice(0, 500),
        "-m", "",
        "-m", `review-id: ${review.id}`,
        "-m", `decided-by: ${input.decidedBy}`,
        "-m", `reviewer-verdict: ${verdict.verdict}/${verdict.confidence}`,
        "-m", "",
        "-m", "🤖 Auto-applied by Magister Leader",
      ]);
      if (!commit.ok) {
        // Step 10 — commit failed, reverse.
        const reverse = await runGit(workspacePath, [
          "apply",
          "-R",
          "--binary",
          "--whitespace=nowarn",
          patchPath,
        ]);
        if (reverse.ok) {
          await markApplyFailed({
            reviewId: review.id,
            decidedBy: input.decidedBy,
            reason: `commit_failed: ${summarizeGitFailure(commit)}`,
          });
          return {
            ok: false,
            code: "commit_failed",
            message: summarizeGitFailure(commit),
          };
        }
        await markPartiallyApplied({
          reviewId: review.id,
          decidedBy: input.decidedBy,
          reason: `commit_failed + reverse_failed: commit=${summarizeGitFailure(commit)}; reverse=${summarizeGitFailure(reverse)}`,
        });
        await events.create({
          id: `event_${randomUUID()}`,
          type: "safe_apply.change_review_apply_partial",
          taskId: review.taskId,
          roleRuntimeId: review.roleRuntimeId,
          workspaceId: review.workspaceId,
          artifactId: review.reviewDraftArtifactId,
          severity: "error",
          payloadJson: JSON.stringify({
            reviewId: review.id,
            commitError: summarizeGitFailure(commit),
            reverseError: summarizeGitFailure(reverse),
          }),
          occurredAt: new Date(),
        });
        return {
          ok: false,
          code: "partially_applied",
          message: "commit failed and reverse failed; workspace is dirty",
        };
      }

      // Capture the new HEAD as the commit sha.
      const sha = await runGit(workspacePath, ["rev-parse", "HEAD"]);
      const commitSha = sha.ok ? sha.stdout.toString("utf8").trim() : "";

      // Step 11 — final atomic DB write.
      const db = createDb();
      const now = new Date();
      await db
        .update(changeReviews)
        .set({
          applyState: "applied",
          decisionState: "approved",
          decisionReason: input.reasoning.slice(0, 500),
          appliedAt: now,
          leaderApplyCommitSha: commitSha || null,
          updatedAt: now,
        })
        .where(
          and(
            eq(changeReviews.id, review.id),
            eq(changeReviews.applyState, "applying"),
            eq(changeReviews.decidedBy, input.decidedBy),
          ),
        );
      const after = await reviewRepo.getById(review.id);
      if (!after || after.applyState !== "applied" || after.leaderApplyCommitSha !== commitSha) {
        warnings.push("db_drift: commit landed in git but the final DB write didn't match our claim");
        await events.create({
          id: `event_${randomUUID()}`,
          type: "safe_apply.change_review_apply_db_drift",
          taskId: review.taskId,
          roleRuntimeId: review.roleRuntimeId,
          workspaceId: review.workspaceId,
          artifactId: review.reviewDraftArtifactId,
          severity: "error",
          payloadJson: JSON.stringify({
            reviewId: review.id,
            commitSha,
            actualState: after?.applyState ?? "missing",
          }),
          occurredAt: now,
        });
      }

      await events.create({
        id: `event_${randomUUID()}`,
        type: "safe_apply.change_review_applied",
        taskId: review.taskId,
        roleRuntimeId: review.roleRuntimeId,
        workspaceId: review.workspaceId,
        artifactId: review.reviewDraftArtifactId,
        severity: "info",
        payloadJson: JSON.stringify({
          reviewId: review.id,
          decidedBy: input.decidedBy,
          commitSha,
          verdict: `${verdict.verdict}/${verdict.confidence}`,
        }),
        occurredAt: now,
      });

      return { ok: true, commitSha, warnings };
    } finally {
      await cleanupPatch();
    }
  } finally {
    try {
      await lock.release();
    } catch {
      /* best-effort */
    }
  }
}

function parsePatchFilePaths(json: string): Set<string> {
  return new Set(parseChangedFilePaths(json));
}

function parseChangedFilePaths(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && typeof entry.path === "string") return entry.path;
        return null;
      })
      .filter((p): p is string => p !== null && p.length > 0);
  } catch {
    return [];
  }
}

/**
 * Startup reconciliation: revert any `apply_state='applying'` rows
 * older than the apply-lock TTL back to `not_applied`. A crash during
 * step 8-11 would otherwise leave the row stuck forever.
 *
 * Called from app.ts at boot. Idempotent — safe to run repeatedly.
 */
export async function reconcileOrphanApplyingReviews(now: Date = new Date()): Promise<{
  reverted: number;
  recoveredApplied: number;
}> {
  const db = createDb();
  const cutoff = new Date(now.getTime() - APPLY_ORPHAN_TTL_MS);
  const candidates = await db
    .select()
    .from(changeReviews)
    .where(
      and(
        eq(changeReviews.applyState, "applying"),
        lt(changeReviews.updatedAt, cutoff),
      ),
    );

  if (candidates.length === 0) return { reverted: 0, recoveredApplied: 0 };

  const events = new ExecutionEventRepository();
  const workspaceRepo = new WorkspaceRepository();
  let reverted = 0;
  let recoveredApplied = 0;
  for (const row of candidates) {
    const previousDecidedBy = row.decidedBy;
    const rowUpdatedAt = row.updatedAt;

    // 2026-05-24 (task #42, codex v3 audit D-1 CRITICAL) — Before
    // reverting to not_applied, check git log for a
    // `leader-applied change_review <id>` commit. If the marker
    // exists, the apply DID land on disk but the process crashed
    // between commit and the final DB UPDATE. In that case the
    // correct recovery is to mark the row APPLIED (with the SHA
    // we just found in git), NOT revert to not_applied.
    //
    // Without this check the previous code would silently revert,
    // creating drift: git has the commit, DB says not_applied,
    // operator confused, no audit. The marker grep is bounded by
    // recency (last 20 commits) so a long-running history doesn't
    // make this O(N).
    let recoveredCommitSha: string | null = null;
    try {
      const workspace = await workspaceRepo.getById(row.workspaceId);
      if (workspace) {
        // Codex audit BLOCKER (#42): use `git log --grep` so the
        // server filters by exact commit subject — no scan limit, no
        // fragile `---END---` body parsing. The expected subject is
        // `leader-applied change_review <id>` (review id is a UUID,
        // so a false positive on a random commit subject is near-zero).
        // We additionally cross-check the body for the
        // `review-id: <id>` footer to defeat the (already-tiny)
        // possibility that someone hand-crafted a fake subject. NUL
        // separators between records keep the parse simple even when
        // a body happens to contain text we use elsewhere as a
        // delimiter.
        const expectedSubject = `leader-applied change_review ${row.id}`;
        const reviewIdFooter = `review-id: ${row.id}`;
        const log = await runGit(workspace.basePath, [
          "log",
          `--grep=${expectedSubject}`,
          "--fixed-strings",
          "--format=%H%x00%s%x00%b%x1e",
          "--all",
        ]);
        if (log.ok) {
          const blob = log.stdout.toString("utf8");
          // Records separated by 0x1e (RS, record separator).
          // Fields within a record separated by 0x00 (NUL).
          for (const record of blob.split("\x1e")) {
            const trimmed = record.replace(/^\n+/, "");
            if (!trimmed) continue;
            const [sha = "", subject = "", body = ""] = trimmed.split("\x00");
            if (subject.trim() !== expectedSubject) continue;
            if (!body.includes(reviewIdFooter)) continue;
            recoveredCommitSha = sha.trim();
            break;
          }
        }
      }
    } catch (err) {
      // Marker-scan failure is non-fatal — fall through to the
      // revert path. We'd rather over-revert than wrongly mark
      // applied based on a partial read.
      console.warn(
        "[reconcileOrphan] git log marker scan failed for review",
        row.id,
        err,
      );
    }

    if (recoveredCommitSha) {
      // Apply path crashed after commit; the commit IS in git.
      // Mark applied + emit a distinguishable recovery event.
      const result = await db
        .update(changeReviews)
        .set({
          applyState: "applied",
          decisionState: "approved",
          appliedAt: now,
          leaderApplyCommitSha: recoveredCommitSha,
          updatedAt: now,
        })
        .where(
          and(
            eq(changeReviews.id, row.id),
            eq(changeReviews.applyState, "applying"),
            eq(changeReviews.updatedAt, rowUpdatedAt),
          ),
        );
      const changes = (result as unknown as { changes?: number }).changes ?? 0;
      if (changes === 1) {
        recoveredApplied += 1;
        await events.create({
          id: `event_${randomUUID()}`,
          type: "safe_apply.change_review_apply_recovered_from_git",
          taskId: row.taskId,
          roleRuntimeId: row.roleRuntimeId,
          workspaceId: row.workspaceId,
          artifactId: row.reviewDraftArtifactId,
          severity: "warn",
          payloadJson: JSON.stringify({
            reviewId: row.id,
            commitSha: recoveredCommitSha,
            previousDecidedBy,
            ageMs: row.updatedAt instanceof Date
              ? now.getTime() - row.updatedAt.getTime()
              : null,
            note: "process crashed after commit but before DB write; recovered via git log marker",
          }),
          occurredAt: now,
        });
      }
      continue;
    }

    // No marker found — true orphan, revert to not_applied so the
    // operator can retry.
    const result = await db
      .update(changeReviews)
      .set({
        applyState: "not_applied",
        decidedBy: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(changeReviews.id, row.id),
          eq(changeReviews.applyState, "applying"),
          eq(changeReviews.updatedAt, rowUpdatedAt),
        ),
      );
    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    if (changes === 1) {
      reverted += 1;
      const ageMs = row.updatedAt instanceof Date
        ? now.getTime() - row.updatedAt.getTime()
        : null;
      await events.create({
        id: `event_${randomUUID()}`,
        type: "safe_apply.change_review_apply_orphan_reverted",
        taskId: row.taskId,
        roleRuntimeId: row.roleRuntimeId,
        workspaceId: row.workspaceId,
        artifactId: row.reviewDraftArtifactId,
        severity: "warn",
        payloadJson: JSON.stringify({
          reviewId: row.id,
          previousDecidedBy,
          ageMs,
        }),
        occurredAt: now,
      });
    }
  }
  void sql; // imported for future explicit SQL needs
  return { reverted, recoveredApplied };
}
