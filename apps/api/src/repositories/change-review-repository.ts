import { and, desc, eq, ne } from "@magister/db";

import {
  changeReviews,
  createDb,
  getRawSqlite,
  type ChangeReviewInsert,
  type ChangeReviewSelect,
} from "@magister/db";

export type ChangeReviewRow = ChangeReviewSelect;

export class ChangeReviewNotFoundError extends Error {
  constructor(reviewId: string) {
    super(`Change review not found: ${reviewId}`);
    this.name = "ChangeReviewNotFoundError";
  }
}

export class ChangeReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeReviewConflictError";
  }
}

export function isChangeReviewUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  const text = `${typeof code === "string" ? code : ""} ${error.message}`;
  return (
    text.includes("SQLITE_CONSTRAINT") &&
    text.includes("change_reviews.review_draft_artifact_id")
  );
}

export type CreateChangeReviewFromDraftInput = Omit<
  ChangeReviewInsert,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
  actorType?: string;
  actorId?: string | null;
};

export type RecordChangeReviewDecisionInput = {
  reviewId: string;
  decisionState: "approved" | "rejected" | "revision_requested";
  reason: string | null;
  actorId: string | null;
  expectedDiffHash?: string | null;
  now?: Date;
};

export type RecordChangeReviewApplySuccessInput = {
  reviewId: string;
  expectedDiffHash: string;
  actorId: string | null;
  appliedPatchHash: string;
  now?: Date;
};

export type RecordChangeReviewApplyFailureInput = {
  reviewId: string;
  expectedDiffHash: string;
  actorId: string | null;
  failureCode: string;
  failureMessage: string;
  now?: Date;
};

export class ChangeReviewRepository {
  async createFromDraft(input: CreateChangeReviewFromDraftInput): Promise<ChangeReviewRow> {
    const db = createDb();
    const now = input.createdAt ?? new Date();
    const id = input.id ?? `change_review_${crypto.randomUUID()}`;

    try {
      // Native synchronous transaction (F4 — async drizzle tx is a no-op on
      // bun-sqlite and throws on better-sqlite3).
      const sqlite = getRawSqlite();
      return sqlite.transaction(() => {
        const existingRows = db
          .select()
          .from(changeReviews)
          .where(eq(changeReviews.reviewDraftArtifactId, input.reviewDraftArtifactId))
          .limit(1)
          .all();
        const existing = existingRows[0];
        if (existing) {
          return existing;
        }

        const row: ChangeReviewInsert = {
          id,
          taskId: input.taskId,
          roleRuntimeId: input.roleRuntimeId ?? null,
          workspaceId: input.workspaceId,
          sourceEventId: input.sourceEventId ?? null,
          reviewDraftArtifactId: input.reviewDraftArtifactId,
          diffArtifactId: input.diffArtifactId,
          gateArtifactId: input.gateArtifactId ?? null,
          runtimeSource: input.runtimeSource,
          permissionMode: input.permissionMode,
          executorCommand: input.executorCommand ?? null,
          sandboxMode: input.sandboxMode ?? null,
          argvFlagsJson: input.argvFlagsJson,
          permissionSignalsJson: input.permissionSignalsJson,
          envPermissionHintsJson: input.envPermissionHintsJson,
          runtimeWorkspaceStrategy: input.runtimeWorkspaceStrategy,
          mcpToolRiskJson: input.mcpToolRiskJson ?? null,
          sastAdvisoryJson: input.sastAdvisoryJson ?? null,
          executionSandboxJson: input.executionSandboxJson ?? null,
          sideEffectWarningJson: input.sideEffectWarningJson ?? null,
          baseRevision: input.baseRevision ?? null,
          diffHash: input.diffHash,
          diffAlgorithmJson: input.diffAlgorithmJson,
          changedFilesJson: input.changedFilesJson,
          addedLines: input.addedLines,
          removedLines: input.removedLines,
          isEmpty: input.isEmpty ?? false,
          risk: input.risk,
          riskReasonsJson: input.riskReasonsJson,
          verificationJson: input.verificationJson,
          reviewerVerdictsJson: input.reviewerVerdictsJson ?? "[]",
          decisionState: input.decisionState,
          decisionReason: input.decisionReason ?? null,
          decidedBy: input.decidedBy ?? null,
          decidedAt: input.decidedAt ?? null,
          applyState: input.applyState ?? "not_applied",
          appliedAt: input.appliedAt ?? null,
          assignee: input.assignee ?? "user",
          assigneeSetBy: input.assigneeSetBy ?? null,
          reviewerVerdictArtifactId: input.reviewerVerdictArtifactId ?? null,
          leaderApplyCommitSha: input.leaderApplyCommitSha ?? null,
          createdAt: now,
          updatedAt: input.updatedAt ?? now,
        };

        db.insert(changeReviews).values(row).run();

        const createdRows = db
          .select()
          .from(changeReviews)
          .where(eq(changeReviews.id, id))
          .limit(1)
          .all();
        const created = createdRows[0];
        if (!created) {
          throw new Error(`Change review ${id} not found after insert`);
        }
        return created;
      })();
    } catch (error) {
      if (isChangeReviewUniqueConstraintError(error)) {
        const existing = await this.getByDraftArtifactId(input.reviewDraftArtifactId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  async getById(id: string): Promise<ChangeReviewRow | null> {
    const db = createDb();
    const row = await db.query.changeReviews.findFirst({
      where: eq(changeReviews.id, id),
    });
    return row ?? null;
  }

  async getByDraftArtifactId(id: string): Promise<ChangeReviewRow | null> {
    const db = createDb();
    const row = await db.query.changeReviews.findFirst({
      where: eq(changeReviews.reviewDraftArtifactId, id),
    });
    return row ?? null;
  }

  async listByTaskId(taskId: string): Promise<ChangeReviewRow[]> {
    const db = createDb();
    return db.query.changeReviews.findMany({
      where: eq(changeReviews.taskId, taskId),
      orderBy: [desc(changeReviews.createdAt)],
    });
  }

  async listByRoleRuntimeId(roleRuntimeId: string): Promise<ChangeReviewSelect[]> {
    const db = createDb();
    return db
      .select()
      .from(changeReviews)
      .where(eq(changeReviews.roleRuntimeId, roleRuntimeId))
      .orderBy(changeReviews.createdAt);
  }

  async recordDecision(input: RecordChangeReviewDecisionInput): Promise<{
    review: ChangeReviewRow;
    idempotent: boolean;
  }> {
    const db = createDb();
    const now = input.now ?? new Date();

    const sqlite = getRawSqlite();
    return sqlite.transaction(() => {
      const reviewRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const review = reviewRows[0];
      if (!review) {
        throw new ChangeReviewNotFoundError(input.reviewId);
      }
      if (input.expectedDiffHash && input.expectedDiffHash !== review.diffHash) {
        throw new ChangeReviewConflictError("expectedDiffHash does not match current review diffHash");
      }
      if (review.decisionState !== "pending") {
        if (review.decisionState === input.decisionState) {
          return { review, idempotent: true };
        }
        throw new ChangeReviewConflictError(
          `review is already ${review.decisionState}; cannot change to ${input.decisionState}`,
        );
      }
      // Codex v3.1 4-审 BLOCKER 1 fix: operator-side decisions must
      // not race with a Leader apply that's already in flight. The
      // applying claim's UPDATE owns the slot until either step 11
      // or a revert. We treat operator-clicking-Reject during the
      // apply window as a conflict the operator must retry after
      // Leader settles.
      if (review.applyState === "applying") {
        throw new ChangeReviewConflictError(
          `review ${review.id} is currently being applied by leader (apply_state=applying). Wait for it to settle, then refresh.`,
        );
      }

      db
        .update(changeReviews)
        .set({
          decisionState: input.decisionState,
          decisionReason: input.reason,
          decidedBy: input.actorId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(changeReviews.id, input.reviewId),
            eq(changeReviews.decisionState, "pending"),
            // Defense-in-depth: even if the read above raced with a
            // claim that hadn't yet landed, the WHERE clause won't
            // match an applying row.
            ne(changeReviews.applyState, "applying"),
          ),
        )
        .run();

      const updatedRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`Change review ${input.reviewId} decision failed to materialize`);
      }
      if (updated.decisionState !== input.decisionState) {
        throw new ChangeReviewConflictError(
          `review decision changed concurrently to ${updated.decisionState}`,
        );
      }
      return { review: updated, idempotent: false };
    })();
  }

  async recordApplySuccess(input: RecordChangeReviewApplySuccessInput): Promise<{
    review: ChangeReviewRow;
  }> {
    const db = createDb();
    const now = input.now ?? new Date();

    const sqlite = getRawSqlite();
    return sqlite.transaction(() => {
      const reviewRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const review = reviewRows[0];
      if (!review) {
        throw new ChangeReviewNotFoundError(input.reviewId);
      }
      if (review.diffHash !== input.expectedDiffHash) {
        throw new ChangeReviewConflictError("expectedDiffHash does not match current review diffHash");
      }
      if (review.decisionState !== "approved") {
        throw new ChangeReviewConflictError(`review is ${review.decisionState}; approved review is required to apply`);
      }
      if (review.applyState !== "not_applied") {
        throw new ChangeReviewConflictError(`review apply state is ${review.applyState}; cannot apply`);
      }

      const updateResult = db
        .update(changeReviews)
        .set({
          applyState: "applied",
          appliedAt: now,
          updatedAt: now,
        })
        .where(and(eq(changeReviews.id, input.reviewId), eq(changeReviews.applyState, "not_applied")))
        .run();
      const updatedCount = getMutationCount(updateResult);
      if (updatedCount === 0) {
        throw new ChangeReviewConflictError("review apply state changed concurrently before success could be recorded");
      }

      const updatedRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`Change review ${input.reviewId} apply success failed to materialize`);
      }
      if (updated.applyState !== "applied") {
        throw new ChangeReviewConflictError(
          `review apply state changed concurrently to ${updated.applyState}`,
        );
      }
      return { review: updated };
    })();
  }

  async recordApplyFailure(input: RecordChangeReviewApplyFailureInput): Promise<{
    review: ChangeReviewRow;
  }> {
    const db = createDb();
    const now = input.now ?? new Date();

    const sqlite = getRawSqlite();
    return sqlite.transaction(() => {
      const reviewRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const review = reviewRows[0];
      if (!review) {
        throw new ChangeReviewNotFoundError(input.reviewId);
      }
      if (review.diffHash !== input.expectedDiffHash) {
        throw new ChangeReviewConflictError("expectedDiffHash does not match current review diffHash");
      }
      if (review.decisionState !== "approved") {
        throw new ChangeReviewConflictError(`review is ${review.decisionState}; approved review is required to record apply failure`);
      }
      if (review.applyState !== "not_applied") {
        throw new ChangeReviewConflictError(`review apply state is ${review.applyState}; cannot record apply failure`);
      }

      const updateResult = db
        .update(changeReviews)
        .set({
          applyState: "apply_failed",
          updatedAt: now,
        })
        .where(and(eq(changeReviews.id, input.reviewId), eq(changeReviews.applyState, "not_applied")))
        .run();
      const updatedCount = getMutationCount(updateResult);
      if (updatedCount === 0) {
        throw new ChangeReviewConflictError("review apply state changed concurrently before failure could be recorded");
      }

      const updatedRows = db
        .select()
        .from(changeReviews)
        .where(eq(changeReviews.id, input.reviewId))
        .limit(1)
        .all();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`Change review ${input.reviewId} apply failure failed to materialize`);
      }
      if (updated.applyState !== "apply_failed") {
        throw new ChangeReviewConflictError(
          `review apply state changed concurrently to ${updated.applyState}`,
        );
      }
      return { review: updated };
    })();
  }
}

function getMutationCount(result: unknown): number | null {
  const runResult = result as { changes?: number; rowsAffected?: number };
  return runResult.changes ?? runResult.rowsAffected ?? null;
}
