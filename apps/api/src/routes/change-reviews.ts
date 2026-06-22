import { open } from "node:fs/promises";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ArtifactRepository } from "../repositories/artifact-repository";
import {
  ChangeReviewConflictError,
  ChangeReviewNotFoundError,
  ChangeReviewRepository,
} from "../repositories/change-review-repository";
import {
  materializePendingChangeReviewDrafts,
  recordChangeReviewDecision,
  toChangeReviewDetail,
  toChangeReviewSummary,
} from "../services/safe-apply/change-review-state-service";
import {
  ApplyGateApplyFailedError,
  ApplyGateConflictError,
  ApplyGatePatchError,
  applyChangeReview,
  computeChangeReviewApplicability,
} from "../services/safe-apply/apply-gate-service";

const taskParamsSchema = z.object({
  taskId: z.string().min(1),
});

const reviewParamsSchema = z.object({
  reviewId: z.string().min(1),
});

const diffPreviewQuerySchema = z.object({
  maxBytes: z.union([z.string(), z.number()]).optional(),
});

const decisionBodySchema = z.object({
  decision: z.enum(["approve", "reject", "request_revision"]),
  reason: z.string().min(1).optional(),
  expectedDiffHash: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
});

const applyBodySchema = z.object({
  expectedDiffHash: z.string().min(1),
});

const DEFAULT_DIFF_PREVIEW_BYTES = 128 * 1024;
const MAX_DIFF_PREVIEW_BYTES = 512 * 1024;

function normalizeDiffPreviewBytes(maxBytes: string | number | undefined) {
  const parsed =
    typeof maxBytes === "number"
      ? maxBytes
      : typeof maxBytes === "string" && maxBytes.trim().length > 0
      ? Number(maxBytes)
      : undefined;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return DEFAULT_DIFF_PREVIEW_BYTES;
  }
  return Math.min(MAX_DIFF_PREVIEW_BYTES, Math.max(1, Math.trunc(parsed)));
}

export async function registerChangeReviewRoutes(app: FastifyInstance) {
  app.get("/tasks/:taskId/change-reviews", async (request) => {
    const params = taskParamsSchema.parse(request.params);
    // Best-effort materialize with 10s cap so the response isn't blocked
    // by sequential I/O when many drafts are pending. If it times out,
    // return whatever already exists — next poll picks up the rest.
    await Promise.race([
      materializePendingChangeReviewDrafts({ taskId: params.taskId }),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    const reviews = await new ChangeReviewRepository().listByTaskId(params.taskId);
    return {
      ok: true,
      data: {
        reviews: reviews.map(toChangeReviewSummary),
      },
    };
  });

  app.get("/change-reviews/:reviewId/diff", async (request, reply) => {
    const params = reviewParamsSchema.parse(request.params);
    const query = diffPreviewQuerySchema.parse(request.query);
    const maxBytes = normalizeDiffPreviewBytes(query.maxBytes);
    const review = await new ChangeReviewRepository().getById(params.reviewId);
    if (!review) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Change review not found: ${params.reviewId}`,
        },
      };
    }

    const artifact = await new ArtifactRepository().getById(review.diffArtifactId);
    if (!artifact) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Runtime diff artifact not found: ${review.diffArtifactId}`,
        },
      };
    }
    if (artifact.artifactType !== "runtime_diff" || artifact.storageKind !== "file") {
      reply.status(422);
      return {
        ok: false,
        error: {
          code: "invalid_diff_artifact",
          message: `Change review diff artifact is not a file-backed runtime_diff artifact: ${review.diffArtifactId}`,
        },
      };
    }

    try {
      const handle = await open(artifact.storageRef, "r");
      try {
        const stat = await handle.stat();
        const readLimit = Math.min(stat.size, maxBytes + 1);
        const buffer = Buffer.alloc(readLimit);
        const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
        const actualBytes = Math.min(bytesRead, maxBytes);
        const truncated = stat.size > maxBytes || bytesRead > maxBytes;
        const patchBytes = buffer.subarray(0, actualBytes);
        return {
          ok: true,
          data: {
            reviewId: review.id,
            diffArtifactId: review.diffArtifactId,
            diffHash: review.diffHash,
            byteLength: stat.size,
            maxBytes,
            truncated,
            patch: patchBytes.toString("utf8"),
          },
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      reply.status(422);
      return {
        ok: false,
        error: {
          code: "unreadable_diff_artifact",
          message:
            error instanceof Error
              ? `Unable to read runtime diff artifact: ${error.message}`
              : "Unable to read runtime diff artifact.",
        },
      };
    }
  });

  app.get("/change-reviews/:reviewId", async (request, reply) => {
    const params = reviewParamsSchema.parse(request.params);
    const repository = new ChangeReviewRepository();
    const review = await repository.getById(params.reviewId);
    if (!review) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Change review not found: ${params.reviewId}`,
        },
      };
    }
    // Surface a precomputed applicability probe so the UI can disable
    // Apply and flag the patch as Stale when the workspace HEAD has
    // moved past `baseRevision`. Failure is treated as "unknown" rather
    // than blocking the detail load.
    let applicability: Awaited<ReturnType<typeof computeChangeReviewApplicability>> | null = null;
    try {
      applicability = await computeChangeReviewApplicability({ reviewId: params.reviewId });
    } catch (error) {
      request.log.warn(
        { reviewId: params.reviewId, err: error instanceof Error ? error.message : String(error) },
        "computeChangeReviewApplicability failed; returning detail without it",
      );
    }
    return {
      ok: true,
      data: {
        review: {
          ...toChangeReviewDetail(review),
          ...(applicability ? { applicability } : {}),
        },
      },
    };
  });

  app.post("/change-reviews/:reviewId/decision", async (request, reply) => {
    const params = reviewParamsSchema.parse(request.params);
    const body = decisionBodySchema.parse(request.body);

    try {
      const result = await recordChangeReviewDecision({
        reviewId: params.reviewId,
        decision: body.decision,
        reason: body.reason ?? null,
        expectedDiffHash: body.expectedDiffHash ?? null,
        actorId: body.actorId ?? null,
      });
      return {
        ok: true,
        data: {
          review: toChangeReviewSummary(result.review),
          idempotent: result.idempotent,
        },
      };
    } catch (error) {
      if (error instanceof ChangeReviewNotFoundError) {
        reply.status(404);
        return {
          ok: false,
          error: {
            code: "not_found",
            message: error.message,
          },
        };
      }
      if (error instanceof ChangeReviewConflictError) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "conflict",
            message: error.message,
          },
        };
      }
      throw error;
    }
  });

  // Supersede an approved review that can no longer be applied. The
  // route name stays `/discard` for compatibility with older clients,
  // but the row becomes a terminal `superseded` patch review instead
  // of a rejected review.
  app.post("/change-reviews/:reviewId/discard", async (request, reply) => {
    const params = reviewParamsSchema.parse(request.params);
    const body = (() => {
      try {
        const parsed = (request.body ?? {}) as Record<string, unknown>;
        const reason = typeof parsed.reason === "string" ? parsed.reason : null;
        const actorId = typeof parsed.actorId === "string" ? parsed.actorId : null;
        return { reason, actorId };
      } catch {
        return { reason: null, actorId: null };
      }
    })();

    const repository = new ChangeReviewRepository();
    const review = await repository.getById(params.reviewId);
    if (!review) {
      reply.status(404);
      return {
        ok: false,
        error: { code: "not_found", message: `Change review not found: ${params.reviewId}` },
      };
    }
    // Only blocked approved-not-applied rows qualify. A pending row
    // should go through /decision; an already-applied row has no
    // supersede semantics (the patch landed); a rejected/not_required
    // row is already terminal.
    if (review.decisionState !== "approved" || review.applyState !== "not_applied") {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "conflict",
          message: `discard requires decision_state=approved + apply_state=not_applied (got ${review.decisionState} + ${review.applyState})`,
        },
      };
    }
    // Verify non-applicability — refuse to discard a row that's still
    // applicable. The operator should use Apply for those.
    const applicability = await computeChangeReviewApplicability({ reviewId: params.reviewId });
    if (applicability.applicable !== false) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "still_applicable",
          message: "review is still applicable; use /apply instead of /discard",
        },
      };
    }

    const reason = body.reason && body.reason.trim().length > 0
      ? body.reason.trim()
      : `superseded as not applicable: ${applicability.reason ?? "apply preflight failed"}`;

    const now = new Date();
    const { createDb, changeReviews } = await import("@magister/db");
    const { and, eq } = await import("@magister/db");
    const result = await createDb()
      .update(changeReviews)
      .set({
        decisionState: "superseded",
        decisionReason: reason,
        decidedBy: body.actorId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(changeReviews.id, params.reviewId),
          eq(changeReviews.decisionState, "approved"),
          eq(changeReviews.applyState, "not_applied"),
        ),
      );
    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    if (changes !== 1) {
      reply.status(409);
      return {
        ok: false,
        error: { code: "conflict", message: "review state changed concurrently; refresh and retry" },
      };
    }
    const updated = await repository.getById(params.reviewId);
    if (!updated) {
      reply.status(500);
      return { ok: false, error: { code: "internal", message: "row disappeared after update" } };
    }

    // Audit trail in the existing event stream.
    const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
    await new ExecutionEventRepository().create({
      id: `event_${crypto.randomUUID()}`,
      type: "safe_apply.change_review_decision_recorded",
      taskId: updated.taskId,
      roleRuntimeId: updated.roleRuntimeId,
      workspaceId: updated.workspaceId,
      artifactId: updated.reviewDraftArtifactId,
      severity: "info",
      payloadJson: JSON.stringify({
        reviewId: updated.id,
        decisionState: "superseded",
        decidedBy: updated.decidedBy,
        reason: updated.decisionReason,
        kind: "supersede_not_applicable",
        previousDecisionState: "approved",
      }),
      occurredAt: now,
    });

    return {
      ok: true,
      data: { review: toChangeReviewSummary(updated), idempotent: false },
    };
  });

  app.post("/change-reviews/:reviewId/apply", async (request, reply) => {
    const params = reviewParamsSchema.parse(request.params);
    const body = applyBodySchema.parse(request.body);

    try {
      const result = await applyChangeReview({
        reviewId: params.reviewId,
        expectedDiffHash: body.expectedDiffHash,
        actorId: null,
      });
      return {
        ok: true,
        data: {
          review: toChangeReviewSummary(result.review),
          idempotent: result.idempotent,
          appliedPatchHash: result.appliedPatchHash,
        },
      };
    } catch (error) {
      if (error instanceof ChangeReviewNotFoundError) {
        reply.status(404);
        return {
          ok: false,
          error: {
            code: "not_found",
            message: error.message,
          },
        };
      }
      if (error instanceof ApplyGateConflictError || error instanceof ChangeReviewConflictError) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: error instanceof ApplyGateConflictError ? error.code : "conflict",
            message: error.message,
          },
        };
      }
      if (error instanceof ApplyGatePatchError) {
        reply.status(422);
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      if (error instanceof ApplyGateApplyFailedError) {
        reply.status(500);
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      throw error;
    }
  });
}
