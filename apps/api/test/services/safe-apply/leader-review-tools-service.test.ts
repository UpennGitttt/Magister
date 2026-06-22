// 2026-05-24 — Tests for leader-review-tools-service (Phase 1b-2).
// Covers the three read/reject/escalate tools' core invariants:
//
//   - read_change_review refuses when assignee != "leader"
//   - reject + escalate are atomic against operator-side overrides
//     (race-lost path)
//   - escalate flips assignee to "user" and is idempotent if the
//     operator already owns it
//   - terminal-state guard prevents acting on already-decided rows
//
// We don't end-to-end exercise the diff body reading here — that
// path is just `readFile` and exercised by the broader integration
// tests in change-review-state-service.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ChangeReviewRepository } from "../../../src/repositories/change-review-repository";
import { WorkspaceRepository } from "../../../src/repositories/workspace-repository";
import {
  escalateChangeReviewToUser,
  readChangeReviewForLeader,
  rejectChangeReviewAsLeader,
  LeaderReviewToolFailure,
} from "../../../src/services/safe-apply/leader-review-tools-service";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "leader-review-tools-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});

afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function seedWorkspaceAndReview(opts: {
  assignee?: "leader" | "user";
  decisionState?: "pending" | "rejected" | "approved" | "not_required";
} = {}) {
  const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
  const workspaceRepo = new WorkspaceRepository();
  await workspaceRepo.create({
    id: workspaceId,
    label: "test ws",
    basePath: tempDir,
  });

  // Write a tiny diff artifact body so read_change_review's diff
  // loader has something to read (just metadata; readChangeReview
  // tolerates missing artifact path).
  const diffArtifactId = `artifact_${randomUUID().slice(0, 8)}`;
  const reviewDraftArtifactId = `artifact_${randomUUID().slice(0, 8)}`;

  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.createFromDraft({
    taskId: `task_${randomUUID().slice(0, 8)}`,
    roleRuntimeId: `rr_${randomUUID().slice(0, 8)}`,
    workspaceId,
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
    baseRevision: null,
    diffHash: "deadbeef",
    diffAlgorithmJson: "{}",
    changedFilesJson: JSON.stringify([{ path: "apps/web/src/Button.tsx" }]),
    addedLines: 5,
    removedLines: 2,
    isEmpty: false,
    risk: "HUMAN_REQUIRED",
    riskReasonsJson: "[]",
    verificationJson: "[]",
    reviewerVerdictsJson: "[]",
    decisionState: opts.decisionState ?? "pending",
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    applyState: "not_applied",
    appliedAt: null,
    assignee: opts.assignee ?? "leader",
    assigneeSetBy: opts.assignee === "user" ? null : "router",
    reviewerVerdictArtifactId: null,
    leaderApplyCommitSha: null,
  });
  return { review, workspaceId };
}

test("readChangeReviewForLeader refuses when assignee = 'user'", async () => {
  const { review } = await seedWorkspaceAndReview({ assignee: "user" });
  let thrown: unknown = null;
  try {
    await readChangeReviewForLeader({ reviewId: review.id });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LeaderReviewToolFailure);
  expect((thrown as LeaderReviewToolFailure).detail.code).toBe("not_leader_assigned");
});

test("readChangeReviewForLeader returns parsed metadata for leader-assigned review", async () => {
  const { review } = await seedWorkspaceAndReview();
  const result = await readChangeReviewForLeader({ reviewId: review.id });
  expect(result.review.id).toBe(review.id);
  expect(result.review.assignee).toBe("leader");
  // No artifact body file exists — diff field carries the
  // "unavailable" placeholder rather than throwing.
  expect(typeof result.diff).toBe("string");
  expect(result.reviewerVerdict).toBeNull();
});

test("rejectChangeReviewAsLeader flips state to 'rejected' with audit reasoning", async () => {
  const { review } = await seedWorkspaceAndReview();
  const result = await rejectChangeReviewAsLeader({
    reviewId: review.id,
    reason: "approach is wrong",
    reasoning: "the patch refactors auth code without tests; not safe",
    decidedBy: "leader:rr_test",
  });
  expect(result.review.decisionState).toBe("rejected");
  expect(result.review.decisionReason).toBe("approach is wrong");
  expect(result.review.decidedBy).toBe("leader:rr_test");

  // Reasoning is appended to reviewerVerdictsJson as a
  // leader_decision entry.
  const verdicts = JSON.parse(result.review.reviewerVerdictsJson ?? "[]") as Array<{
    kind?: string;
    reasoning?: string;
  }>;
  const leaderEntry = verdicts.find((v) => v.kind === "leader_decision");
  expect(leaderEntry?.reasoning).toContain("auth");
});

test("rejectChangeReviewAsLeader race-lost when operator flipped assignee mid-flight", async () => {
  const { review } = await seedWorkspaceAndReview();
  // Simulate an operator override happening before the tool call.
  const reviewRepo = new ChangeReviewRepository();
  const { createDb, changeReviews, eq } = await import("@magister/db");
  await createDb().update(changeReviews).set({ assignee: "user" }).where(eq(changeReviews.id, review.id));

  let thrown: unknown = null;
  try {
    await rejectChangeReviewAsLeader({
      reviewId: review.id,
      reason: "rejecting",
      reasoning: "...",
      decidedBy: "leader:rr_test",
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LeaderReviewToolFailure);
  expect((thrown as LeaderReviewToolFailure).detail.code).toBe("not_leader_assigned");
  // The review row was NOT mutated by the failed tool call.
  const reread = await reviewRepo.getById(review.id);
  expect(reread?.decisionState).toBe("pending");
  expect(reread?.assignee).toBe("user");
});

test("escalateChangeReviewToUser flips assignee", async () => {
  const { review } = await seedWorkspaceAndReview();
  const result = await escalateChangeReviewToUser({
    reviewId: review.id,
    reason: "this looks architectural — operator should weigh in",
    decidedBy: "leader:rr_test",
  });
  expect(result.review.assignee).toBe("user");
  expect(result.review.assigneeSetBy).toBe("leader");
  expect(result.review.decisionReason).toContain("architectural");
});

test("escalateChangeReviewToUser is idempotent when assignee is already 'user'", async () => {
  const { review } = await seedWorkspaceAndReview({ assignee: "user" });
  const result = await escalateChangeReviewToUser({
    reviewId: review.id,
    reason: "stale call",
    decidedBy: "leader:rr_test",
  });
  expect(result.review.assignee).toBe("user");
});

test("reject refuses on already-terminal review", async () => {
  const { review } = await seedWorkspaceAndReview({ decisionState: "rejected" });
  let thrown: unknown = null;
  try {
    await rejectChangeReviewAsLeader({
      reviewId: review.id,
      reason: "second reject",
      reasoning: "...",
      decidedBy: "leader:rr_test",
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LeaderReviewToolFailure);
  expect((thrown as LeaderReviewToolFailure).detail.code).toBe("terminal_state");
});

test("read / reject / escalate all return 'not_found' for bogus review id", async () => {
  for (const fn of [
    () => readChangeReviewForLeader({ reviewId: "bogus" }),
    () =>
      rejectChangeReviewAsLeader({
        reviewId: "bogus",
        reason: "x",
        reasoning: "x",
        decidedBy: "leader:r",
      }),
    () =>
      escalateChangeReviewToUser({
        reviewId: "bogus",
        reason: "x",
        decidedBy: "leader:r",
      }),
  ]) {
    let thrown: unknown = null;
    try {
      await fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LeaderReviewToolFailure);
    expect((thrown as LeaderReviewToolFailure).detail.code).toBe("not_found");
  }
});
