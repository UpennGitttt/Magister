// 2026-05-24 — Phase 1b-3 red-team + happy-path tests for
// applyChangeReviewAsLeader. Each test exercises one explicit
// failure mode or the success path. The scope is the DB / verdict-
// gate side of the state machine; the actual git operations are
// exercised indirectly via a temporary git workspace with a real
// patch.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { ChangeReviewRepository } from "../../../src/repositories/change-review-repository";
import { WorkspaceRepository } from "../../../src/repositories/workspace-repository";
import { ArtifactRepository } from "../../../src/repositories/artifact-repository";
import {
  applyChangeReviewAsLeader,
  reconcileOrphanApplyingReviews,
} from "../../../src/services/safe-apply/leader-apply-service";
import { persistReviewerVerdict } from "../../../src/services/safe-apply/reviewer-verdict-service";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "leader-apply-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});
afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function setupGitWorkspace(): Promise<{ workspacePath: string; head: string }> {
  const workspacePath = join(tempDir, "ws");
  await mkdir(workspacePath, { recursive: true });
  git(workspacePath, "init", "--initial-branch=main");
  git(workspacePath, "config", "user.email", "test@local");
  git(workspacePath, "config", "user.name", "Test");
  await writeFile(join(workspacePath, "a.txt"), "hello\n");
  git(workspacePath, "add", ".");
  git(workspacePath, "commit", "-m", "initial");
  const head = git(workspacePath, "rev-parse", "HEAD");
  return { workspacePath, head };
}

async function setupReview(opts: {
  workspaceId: string;
  workspacePath: string;
  baseRevision: string;
  patchPath: string;
  diffHash: string;
  changedFiles: Array<{ path: string }>;
  assignee?: "leader" | "user";
  applyState?: "not_applied" | "applying" | "applied" | "apply_failed" | "partially_applied";
}) {
  const reviewDraftArtifactId = `art_draft_${randomUUID().slice(0, 8)}`;
  const diffArtifactId = `art_diff_${randomUUID().slice(0, 8)}`;
  await new ArtifactRepository().create({
    id: diffArtifactId,
    taskId: `task_${randomUUID().slice(0, 8)}`,
    roleRuntimeId: `rr_review`,
    artifactType: "runtime_diff",
    title: "test patch",
    storageKind: "file",
    storageRef: opts.patchPath,
    summary: null,
    createdAt: new Date(),
  });
  const review = await new ChangeReviewRepository().createFromDraft({
    taskId: `task_${randomUUID().slice(0, 8)}`,
    roleRuntimeId: "rr_review",
    workspaceId: opts.workspaceId,
    sourceEventId: null,
    reviewDraftArtifactId,
    diffArtifactId,
    gateArtifactId: null,
    runtimeSource: "codex",
    permissionMode: "approval",
    executorCommand: "codex",
    sandboxMode: "workspace-write",
    argvFlagsJson: "[]",
    permissionSignalsJson: "[]",
    envPermissionHintsJson: "[]",
    runtimeWorkspaceStrategy: "isolated_worktree",
    mcpToolRiskJson: null,
    sastAdvisoryJson: null,
    executionSandboxJson: null,
    sideEffectWarningJson: null,
    baseRevision: opts.baseRevision,
    diffHash: opts.diffHash,
    diffAlgorithmJson: "{}",
    changedFilesJson: JSON.stringify(opts.changedFiles),
    addedLines: 1,
    removedLines: 0,
    isEmpty: false,
    risk: "HUMAN_REQUIRED",
    riskReasonsJson: "[]",
    verificationJson: "[]",
    reviewerVerdictsJson: "[]",
    decisionState: "pending",
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    applyState: opts.applyState ?? "not_applied",
    appliedAt: null,
    assignee: opts.assignee ?? "leader",
    assigneeSetBy: opts.assignee === "user" ? null : "router",
    reviewerVerdictArtifactId: null,
    leaderApplyCommitSha: null,
  });
  return review;
}

async function seedVerdict(opts: {
  reviewId: string;
  reviewerRoleRuntimeId: string;
  verdict?: "APPROVE" | "REJECT" | "REQUEST_CHANGES";
  confidence?: "high" | "medium" | "low";
}) {
  await persistReviewerVerdict({
    callerRoleRuntimeId: opts.reviewerRoleRuntimeId,
    verdict: {
      verdict: opts.verdict ?? "APPROVE",
      confidence: opts.confidence ?? "high",
      reviewedReviewId: opts.reviewId,
      reviewerRoleRuntimeId: opts.reviewerRoleRuntimeId,
      blockingFindings: [],
      nonBlockingFindings: [],
      evidence: [],
      narrative: "ok",
    },
  });
}

async function makeApprovedSetup() {
  const ws = await setupGitWorkspace();
  const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
  await new WorkspaceRepository().create({
    id: workspaceId,
    label: "ws",
    basePath: ws.workspacePath,
  });
  // Build a simple patch that creates a new file.
  const patchPath = join(tempDir, `patch-${randomUUID().slice(0, 8)}.diff`);
  await writeFile(
    patchPath,
    `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello world
`,
  );
  const review = await setupReview({
    workspaceId,
    workspacePath: ws.workspacePath,
    baseRevision: ws.head,
    patchPath,
    diffHash: "abc123",
    changedFiles: [{ path: "new.txt" }],
  });
  await seedVerdict({ reviewId: review.id, reviewerRoleRuntimeId: "rr_reviewer_a" });
  return { ...ws, workspaceId, review, patchPath };
}

test("happy path: applies the patch, commits with stable message, row becomes applied", async () => {
  const setup = await makeApprovedSetup();
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "looks safe, tests pass",
    expectedDiffHash: "abc123",
    decidedBy: "leader:rr_test",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("ok branch expected");

  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("applied");
  expect(after?.decisionState).toBe("approved");
  expect(after?.leaderApplyCommitSha).toBe(result.commitSha);

  // The commit landed in git history with the canonical message.
  const log = spawnSync("git", ["log", "--format=%s", "-1"], {
    cwd: setup.workspacePath,
    encoding: "utf8",
  }).stdout.trim();
  expect(log).toBe(`leader-applied change_review ${setup.review.id}`);
});

test("verdict_required: refuses when no reviewer verdict exists", async () => {
  const ws = await setupGitWorkspace();
  const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
  await new WorkspaceRepository().create({ id: workspaceId, label: "ws", basePath: ws.workspacePath });
  const patchPath = join(tempDir, "p.diff");
  await writeFile(patchPath, "diff --git a/b.txt b/b.txt\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+x\n");
  const review = await setupReview({
    workspaceId,
    workspacePath: ws.workspacePath,
    baseRevision: ws.head,
    patchPath,
    diffHash: "h",
    changedFiles: [{ path: "b.txt" }],
  });
  const result = await applyChangeReviewAsLeader({
    reviewId: review.id,
    reasoning: "...",
    expectedDiffHash: "h",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("verdict_required");
});

test.each([
  { verdict: "REJECT" as const, confidence: "high" as const },
  { verdict: "APPROVE" as const, confidence: "medium" as const },
  { verdict: "APPROVE" as const, confidence: "low" as const },
])("verdict_insufficient: refuses on $verdict/$confidence", async (opts) => {
  const ws = await setupGitWorkspace();
  const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
  await new WorkspaceRepository().create({ id: workspaceId, label: "ws", basePath: ws.workspacePath });
  const patchPath = join(tempDir, `p-${randomUUID().slice(0, 8)}.diff`);
  await writeFile(
    patchPath,
    "diff --git a/x.txt b/x.txt\nnew file mode 100644\nindex 0000000..1\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n",
  );
  const review = await setupReview({
    workspaceId,
    workspacePath: ws.workspacePath,
    baseRevision: ws.head,
    patchPath,
    diffHash: `h-${randomUUID().slice(0, 6)}`,
    changedFiles: [{ path: "x.txt" }],
  });
  await seedVerdict({
    reviewId: review.id,
    reviewerRoleRuntimeId: "rr_r",
    verdict: opts.verdict,
    confidence: opts.confidence,
  });
  const result = await applyChangeReviewAsLeader({
    reviewId: review.id,
    reasoning: "...",
    expectedDiffHash: review.diffHash,
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("verdict_insufficient");
});

test("race_lost: assignee is user", async () => {
  const setup = await makeApprovedSetup();
  await setupReviewSetAssigneeUser(setup.review.id);
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "abc123",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("race_lost");
});

test("race_lost: diff_hash mismatch", async () => {
  const setup = await makeApprovedSetup();
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "WRONG_HASH",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("race_lost");
});

test("base_revision_mismatch: workspace HEAD moved", async () => {
  const setup = await makeApprovedSetup();
  // Add another commit to the workspace so HEAD != review.baseRevision.
  await writeFile(join(setup.workspacePath, "drift.txt"), "drift\n");
  git(setup.workspacePath, "add", ".");
  git(setup.workspacePath, "commit", "-m", "drift");

  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "abc123",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("base_revision_mismatch");
  // Row state reverted to not_applied so the operator/leader can retry.
  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("not_applied");
});

test("workspace_dirty: unrelated untracked file does NOT block apply", async () => {
  const setup = await makeApprovedSetup();
  await writeFile(join(setup.workspacePath, "untracked.txt"), "leftover\n");
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "abc123",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(true);
});

test("workspace_dirty: conflicting dirty file blocks apply", async () => {
  const setup = await makeApprovedSetup();
  await writeFile(join(setup.workspacePath, "new.txt"), "conflicting content\n");
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "abc123",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("workspace_dirty");
});

test("patch_check_failed: corrupted patch never reaches apply", async () => {
  const setup = await makeApprovedSetup();
  await writeFile(setup.patchPath, "not a valid patch at all");
  const result = await applyChangeReviewAsLeader({
    reviewId: setup.review.id,
    reasoning: "...",
    expectedDiffHash: "abc123",
    decidedBy: "leader:r",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.code).toBe("patch_check_failed");
  // apply_state lands in apply_failed (terminal).
  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("apply_failed");
});

test("concurrent leader apply: only one wins, the other gets race_lost", async () => {
  const setup = await makeApprovedSetup();
  const [a, b] = await Promise.all([
    applyChangeReviewAsLeader({
      reviewId: setup.review.id,
      reasoning: "A",
      expectedDiffHash: "abc123",
      decidedBy: "leader:rA",
    }),
    applyChangeReviewAsLeader({
      reviewId: setup.review.id,
      reasoning: "B",
      expectedDiffHash: "abc123",
      decidedBy: "leader:rB",
    }),
  ]);
  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  expect(winners.length).toBe(1);
  expect(losers.length).toBe(1);
  if (!losers[0]!.ok) {
    expect(losers[0]!.code === "race_lost" || losers[0]!.code === "lock_busy").toBe(true);
  }
});

test("reconcileOrphanApplyingReviews reverts stuck rows older than the TTL", async () => {
  const setup = await makeApprovedSetup();
  // Manually flip the row to 'applying' with an old updatedAt.
  const { createDb, changeReviews, eq } = await import("@magister/db");
  const oldUpdatedAt = new Date(Date.now() - 11 * 60 * 1000); // > 10min ago
  await createDb()
    .update(changeReviews)
    .set({
      applyState: "applying",
      decidedBy: "leader:crashed",
      updatedAt: oldUpdatedAt,
    })
    .where(eq(changeReviews.id, setup.review.id));

  const res = await reconcileOrphanApplyingReviews();
  expect(res.reverted).toBe(1);
  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("not_applied");
  expect(after?.decidedBy).toBeNull();
});

test("reconcileOrphanApplyingReviews does NOT revert recently-updated rows", async () => {
  const setup = await makeApprovedSetup();
  const { createDb, changeReviews, eq } = await import("@magister/db");
  await createDb()
    .update(changeReviews)
    .set({
      applyState: "applying",
      decidedBy: "leader:fresh",
      updatedAt: new Date(), // fresh
    })
    .where(eq(changeReviews.id, setup.review.id));

  const res = await reconcileOrphanApplyingReviews();
  expect(res.reverted).toBe(0);
  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("applying");
});

// 2026-05-24 (task #42) — Crash-during-commit recovery. Simulate a
// process that committed `leader-applied change_review <id>` in git
// but crashed before the final DB write. The reconciler should find
// the marker via `git log` and recover the row to `applied` with the
// SHA, NOT silently revert to `not_applied`.
test("reconcileOrphanApplyingReviews recovers via git marker after crash-after-commit", async () => {
  const setup = await makeApprovedSetup();
  const { createDb, changeReviews, eq } = await import("@magister/db");

  // Stamp the workspace with a "leader-applied" commit that matches
  // this review id — simulates the apply path's commit landing.
  await writeFile(join(setup.workspacePath, "new.txt"), "hello world\n");
  git(setup.workspacePath, "add", ".");
  git(
    setup.workspacePath,
    "-c", "user.email=magister-leader@local",
    "-c", "user.name=Magister Leader",
    "commit",
    "-m", `leader-applied change_review ${setup.review.id}`,
    "-m", "",
    "-m", `review-id: ${setup.review.id}`,
    "-m", "decided-by: leader:rr_test",
  );
  const recoveredSha = git(setup.workspacePath, "rev-parse", "HEAD");

  // Force the row into orphan applying state with an old updatedAt
  // so the reconciler picks it up.
  const oldUpdatedAt = new Date(Date.now() - 11 * 60 * 1000);
  await createDb()
    .update(changeReviews)
    .set({
      applyState: "applying",
      decidedBy: "leader:crashed",
      updatedAt: oldUpdatedAt,
    })
    .where(eq(changeReviews.id, setup.review.id));

  const res = await reconcileOrphanApplyingReviews();
  expect(res.reverted).toBe(0);
  expect(res.recoveredApplied).toBe(1);

  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("applied");
  expect(after?.decisionState).toBe("approved");
  expect(after?.leaderApplyCommitSha).toBe(recoveredSha);
  expect(after?.appliedAt).toBeTruthy();
});

test("reconcileOrphanApplyingReviews reverts (does NOT recover) when no git marker exists", async () => {
  const setup = await makeApprovedSetup();
  const { createDb, changeReviews, eq } = await import("@magister/db");

  const oldUpdatedAt = new Date(Date.now() - 11 * 60 * 1000);
  await createDb()
    .update(changeReviews)
    .set({
      applyState: "applying",
      decidedBy: "leader:crashed",
      updatedAt: oldUpdatedAt,
    })
    .where(eq(changeReviews.id, setup.review.id));

  // No "leader-applied" commit added — reconciler should revert.
  const res = await reconcileOrphanApplyingReviews();
  expect(res.reverted).toBe(1);
  expect(res.recoveredApplied).toBe(0);

  const after = await new ChangeReviewRepository().getById(setup.review.id);
  expect(after?.applyState).toBe("not_applied");
});

async function setupReviewSetAssigneeUser(reviewId: string) {
  const { createDb, changeReviews, eq } = await import("@magister/db");
  await createDb().update(changeReviews).set({ assignee: "user" }).where(eq(changeReviews.id, reviewId));
}
