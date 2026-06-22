// Phase 1b-2 (§5.5) of the Leader-driven review autonomy
// RFC. Server-side implementations of the three Leader review tools
// that do NOT touch the working tree:
//
//   - read_change_review        (pure read)
//   - reject_change_review      (DB-only state change)
//   - escalate_change_review_to_user  (DB-only assignee flip)
//
// `apply_change_review` is intentionally NOT here — it is deferred
// to Phase 1b-3 / RFC v3 because it requires auto-commit + apply
// lock + atomicity between filesystem mutation and DB write that the
// v2 review found to be non-trivial. Until then Leader can decide
// what to do with a review but cannot actually land changes.
//
// Concurrency guard pattern: every state-changing tool uses an atomic
// DB conditional UPDATE with `WHERE id = ? AND assignee = 'leader'
// AND decision_state IN (...)`. If the conditional fails (operator
// override mid-flight, race with another leader call, terminal
// state), the call returns `code: "race_lost"` and is a no-op. This
// is the canonical signal that the operator beat us to it.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, inArray, ne } from "@magister/db";

import { changeReviews, createDb } from "@magister/db";
import { ArtifactRepository } from "../../repositories/artifact-repository";
import { ChangeReviewRepository, type ChangeReviewRow } from "../../repositories/change-review-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import {
  computeChangeReviewApplicability,
  type ChangeReviewApplicability,
} from "./apply-gate-service";
import { getReviewerVerdictForReview, type ReviewerVerdict } from "./reviewer-verdict-service";

const MAX_DIFF_BYTES = 200 * 1024;

export type ReadChangeReviewResult = {
  review: ChangeReviewRow;
  diff: string;
  diffTruncated: boolean;
  reviewerVerdict: ReviewerVerdict | null;
  applicability: ChangeReviewApplicability | null;
};

export type LeaderToolError = {
  code:
    | "not_found"
    | "race_lost"
    | "not_leader_assigned"
    | "terminal_state";
  message: string;
};

export class LeaderReviewToolFailure extends Error {
  constructor(public readonly detail: LeaderToolError) {
    super(`${detail.code}: ${detail.message}`);
    this.name = "LeaderReviewToolFailure";
  }
}

function assertLeaderAssigned(row: ChangeReviewRow) {
  if (row.assignee !== "leader") {
    throw new LeaderReviewToolFailure({
      code: "not_leader_assigned",
      message: `change_review ${row.id} is assigned to ${row.assignee}, not leader. Operator owns it; you cannot act on it.`,
    });
  }
}

export async function readChangeReviewForLeader(input: {
  reviewId: string;
}): Promise<ReadChangeReviewResult> {
  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.getById(input.reviewId);
  if (!review) {
    throw new LeaderReviewToolFailure({
      code: "not_found",
      message: `change_review not found: ${input.reviewId}`,
    });
  }
  assertLeaderAssigned(review);

  // Load + truncate the diff body. Mirrors the operator-facing
  // /change-reviews/:id/diff route's behaviour so Leader sees the
  // same content the operator would.
  let diff = "";
  let diffTruncated = false;
  try {
    const artifactRepo = new ArtifactRepository();
    const diffArtifact = await artifactRepo.getById(review.diffArtifactId);
    if (diffArtifact) {
      const bytes = await readFile(diffArtifact.storageRef);
      if (bytes.byteLength > MAX_DIFF_BYTES) {
        diff = bytes.subarray(0, MAX_DIFF_BYTES).toString("utf8")
          + `\n\n--- (truncated ${bytes.byteLength - MAX_DIFF_BYTES} bytes) ---\n`;
        diffTruncated = true;
      } else {
        diff = bytes.toString("utf8");
      }
    }
  } catch (error) {
    // Don't fail the whole read on diff-artifact issues — Leader
    // can still escalate or reject without the body.
    diff = `(diff body unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }

  const reviewerVerdict = await getReviewerVerdictForReview(input.reviewId);

  // Applicability probe: same as operator's UI sees. Failures bubble
  // up as a non-blocking null so Leader still gets the rest.
  let applicability: ChangeReviewApplicability | null = null;
  try {
    applicability = await computeChangeReviewApplicability({ reviewId: input.reviewId });
  } catch {
    applicability = null;
  }

  return { review, diff, diffTruncated, reviewerVerdict, applicability };
}

export async function rejectChangeReviewAsLeader(input: {
  reviewId: string;
  reason: string;
  reasoning: string;
  decidedBy: string;
}): Promise<{ review: ChangeReviewRow }> {
  const db = createDb();
  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.getById(input.reviewId);
  if (!review) {
    throw new LeaderReviewToolFailure({
      code: "not_found",
      message: `change_review not found: ${input.reviewId}`,
    });
  }
  assertLeaderAssigned(review);
  if (review.decisionState !== "pending") {
    throw new LeaderReviewToolFailure({
      code: "terminal_state",
      message: `change_review ${review.id} is in decision_state=${review.decisionState}; cannot reject (already decided).`,
    });
  }

  // Append a `leader_decision` entry to reviewer_verdicts_json so the
  // audit trail captures Leader's reasoning before the conditional
  // UPDATE — the read+update happens in two statements, so we
  // recompute the JSON freshly here.
  const decisionEntry = {
    kind: "leader_decision" as const,
    decidedBy: input.decidedBy,
    decision: "reject" as const,
    reason: input.reason,
    reasoning: input.reasoning,
    decidedAt: new Date().toISOString(),
  };
  let priorVerdicts: unknown[] = [];
  try {
    const parsed = JSON.parse(review.reviewerVerdictsJson ?? "[]");
    if (Array.isArray(parsed)) priorVerdicts = parsed;
  } catch {
    priorVerdicts = [];
  }
  const nextVerdictsJson = JSON.stringify([...priorVerdicts, decisionEntry]);

  // Atomic conditional UPDATE. The WHERE clause re-checks
  // assignee + decision_state so a mid-flight operator override is
  // honored. drizzle's `inArray` is overkill for a single value but
  // matches the pattern we'll use when 8.1b-3 adds more states.
  const now = new Date();
  const result = await db
    .update(changeReviews)
    .set({
      decisionState: "rejected",
      decisionReason: input.reason,
      decidedBy: input.decidedBy,
      decidedAt: now,
      reviewerVerdictsJson: nextVerdictsJson,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeReviews.id, input.reviewId),
        eq(changeReviews.assignee, "leader"),
        inArray(changeReviews.decisionState, ["pending"]),
        // Codex v3.1 4-审 BLOCKER 1 fix: reject/escalate must not
        // race with a Leader apply that's already in flight on the
        // same row. The applying claim's own UPDATE owns the slot;
        // any other mutate path must yield.
        ne(changeReviews.applyState, "applying"),
      ),
    );
  // SQLite drizzle returns { changes: n } on the result of update;
  // we don't get a return value in the same shape across all DBs.
  // Re-read to verify the row matches expectations.
  const after = await reviewRepo.getById(input.reviewId);
  if (!after || after.decisionState !== "rejected" || after.decidedBy !== input.decidedBy) {
    throw new LeaderReviewToolFailure({
      code: "race_lost",
      message: `change_review ${input.reviewId} could not be rejected as leader — operator may have re-assigned or decided concurrently. No-op.`,
    });
  }
  void result;

  // Emit an audit event so the operator sees what Leader did in the
  // existing safe_apply event stream.
  await new ExecutionEventRepository().create({
    id: `event_${randomUUID()}`,
    type: "safe_apply.change_review_decision_recorded",
    taskId: after.taskId,
    roleRuntimeId: after.roleRuntimeId,
    workspaceId: after.workspaceId,
    artifactId: after.reviewDraftArtifactId,
    severity: "warn",
    payloadJson: JSON.stringify({
      reviewId: after.id,
      decisionState: "rejected",
      decidedBy: after.decidedBy,
      reason: after.decisionReason,
      assignee: "leader",
    }),
    occurredAt: now,
  });

  return { review: after };
}

export async function escalateChangeReviewToUser(input: {
  reviewId: string;
  reason: string;
  decidedBy: string;
}): Promise<{ review: ChangeReviewRow }> {
  const db = createDb();
  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.getById(input.reviewId);
  if (!review) {
    throw new LeaderReviewToolFailure({
      code: "not_found",
      message: `change_review not found: ${input.reviewId}`,
    });
  }
  if (review.assignee === "user") {
    // Already with operator — Leader's call is a benign no-op.
    return { review };
  }
  assertLeaderAssigned(review);
  if (review.decisionState !== "pending") {
    throw new LeaderReviewToolFailure({
      code: "terminal_state",
      message: `change_review ${review.id} is in decision_state=${review.decisionState}; nothing to escalate.`,
    });
  }

  const now = new Date();
  await db
    .update(changeReviews)
    .set({
      assignee: "user",
      assigneeSetBy: "leader",
      decisionReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(changeReviews.id, input.reviewId),
        eq(changeReviews.assignee, "leader"),
        inArray(changeReviews.decisionState, ["pending"]),
        // Codex v3.1 4-审 BLOCKER 1 fix: reject/escalate must not
        // race with a Leader apply that's already in flight on the
        // same row. The applying claim's own UPDATE owns the slot;
        // any other mutate path must yield.
        ne(changeReviews.applyState, "applying"),
      ),
    );

  // Codex v3 review HIGH: verify the UPDATE actually changed the
  // row from leader→user via OUR transition, not someone else's
  // concurrent escalate. `assigneeSetBy === "leader"` is the
  // discriminator: if the row is now `user` but a different actor
  // ran the update, `assigneeSetBy` would not be the value we just
  // wrote OR another concurrent UPDATE happened after us. The
  // updatedAt check pins us to OUR write — anybody else's UPDATE
  // would overwrite this timestamp. Combined, these guard against
  // emitting an audit event for a transition we didn't author.
  const after = await reviewRepo.getById(input.reviewId);
  if (!after || after.assignee !== "user") {
    throw new LeaderReviewToolFailure({
      code: "race_lost",
      message: `change_review ${input.reviewId} could not be escalated — concurrent change blocked the update. No-op.`,
    });
  }
  if (
    after.assigneeSetBy !== "leader" ||
    !after.updatedAt ||
    after.updatedAt.getTime() !== now.getTime()
  ) {
    // The slot ended up with the right assignee but a different
    // writer (or the operator beat us to it by direct override).
    // Treat as race-lost rather than claim leader credit. The
    // audit event is intentionally NOT emitted.
    throw new LeaderReviewToolFailure({
      code: "race_lost",
      message: `change_review ${input.reviewId} is now assignee=user but the transition was not written by this leader call (assigneeSetBy=${after.assigneeSetBy}). No-op.`,
    });
  }

  await new ExecutionEventRepository().create({
    id: `event_${randomUUID()}`,
    type: "safe_apply.change_review_escalated_to_user",
    taskId: after.taskId,
    roleRuntimeId: after.roleRuntimeId,
    workspaceId: after.workspaceId,
    artifactId: after.reviewDraftArtifactId,
    severity: "warn",
    payloadJson: JSON.stringify({
      reviewId: after.id,
      reason: input.reason,
      escalatedBy: input.decidedBy,
    }),
    occurredAt: now,
  });

  return { review: after };
}
