// Phase 1b-2 (§5.3) of the Leader-driven review autonomy
// RFC. Reviewer verdict is a typed artifact, not a markdown fenced
// JSON block.
//
// Rationale: a v1 design had reviewer emit ```json ... ``` in its
// final message and Leader parse it. Codex GPT-5.5 review caught
// that a compromised or merely sloppy teammate could embed forged
// JSON in their narrative and have Leader treat it as the verdict
// (prompt-injection-via-fenced-block). Typed artifacts close that:
//
//   1. Reviewer must call a dedicated tool (`submit_review_verdict`)
//      whose input is validated against a Zod schema before any
//      bytes hit the artifact store.
//   2. `reviewerRoleRuntimeId` in the artifact is checked against
//      the caller's role_runtime_id — a teammate other than the
//      spawned reviewer cannot submit a verdict for a review even
//      if it knows the review_id.
//   3. Leader reads the verdict via `read_change_review` (Phase 1b-2
//      Leader tool), which fetches the typed artifact rather than
//      parsing markdown — so even if the reviewer's narrative
//      response contains a fake VERDICT block, it never reaches
//      Leader's decision logic.
//
// Legacy compatibility: existing reviewer teammates still emit a
// "VERDICT:" line in markdown. `parseLegacyMarkdownVerdict` lifts
// that out as a `confidence: "low"` verdict so the system degrades
// gracefully during the rollout window. Confidence: low means
// Leader MUST escalate to user — autonomy gating remains safe.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { ArtifactRepository } from "../../repositories/artifact-repository";
import { ChangeReviewRepository } from "../../repositories/change-review-repository";
import { createDb, changeReviews } from "@magister/db";
import { and, eq, isNull, ne } from "@magister/db";

export const ReviewerVerdictSchema = z.object({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT"]),
  confidence: z.enum(["high", "medium", "low"]),
  reviewedReviewId: z.string().min(1),
  reviewerRoleRuntimeId: z.string().min(1),
  blockingFindings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        issue: z.string().max(2_000),
      }),
    )
    .max(50),
  nonBlockingFindings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        issue: z.string().max(2_000),
      }),
    )
    .max(100),
  evidence: z
    .array(
      z.object({
        kind: z.enum(["command", "test", "read"]),
        label: z.string().max(200),
        summary: z.string().max(2_000),
      }),
    )
    .max(50),
  narrative: z.string().max(4_000),
});

export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

const ARTIFACT_TYPE = "reviewer_verdict_v1";

export class ReviewerVerdictForgedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerVerdictForgedError";
  }
}

export class ReviewerVerdictAlreadySubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerVerdictAlreadySubmittedError";
  }
}

export class ReviewerVerdictTargetMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerVerdictTargetMissingError";
  }
}

export type PersistVerdictInput = {
  /** The role_runtime_id of the teammate calling this — server-injected, NOT from the tool's input args. */
  callerRoleRuntimeId: string;
  verdict: ReviewerVerdict;
};

/**
 * Persist a reviewer verdict as a typed artifact and link it to the
 * target change_review row. Throws if:
 *   - the verdict's `reviewerRoleRuntimeId` does not match the
 *     server-injected `callerRoleRuntimeId` (a non-reviewer trying
 *     to submit a verdict, or the reviewer impersonating another
 *     runtime).
 *   - the change_review id does not exist OR is not assigned to
 *     anyone the calling reviewer could plausibly have been spawned
 *     for. (We don't currently enforce a strict reviewer-spawn-for-
 *     this-review link — that would require runtime parent tracking
 *     beyond Phase 1 scope. We do check the review exists.)
 */
export async function persistReviewerVerdict(input: PersistVerdictInput): Promise<{
  artifactId: string;
}> {
  const { verdict, callerRoleRuntimeId } = input;

  // Forgery guard: the verdict claims `reviewerRoleRuntimeId`, but
  // the *actual* caller is who we trust. Reject mismatch.
  if (verdict.reviewerRoleRuntimeId !== callerRoleRuntimeId) {
    throw new ReviewerVerdictForgedError(
      `submit_review_verdict: caller ${callerRoleRuntimeId} cannot submit a verdict claiming reviewerRoleRuntimeId=${verdict.reviewerRoleRuntimeId}`,
    );
  }

  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.getById(verdict.reviewedReviewId);
  if (!review) {
    throw new ReviewerVerdictTargetMissingError(
      `submit_review_verdict: no change_review found with id=${verdict.reviewedReviewId}`,
    );
  }

  // Write the artifact. Storage layout matches the existing
  // safe-apply convention: `<workspace>/.magister/safe-apply/reviewer-verdicts/<id>.json`.
  const artifactId = `artifact_${randomUUID()}`;
  const dir = join(".magister", "safe-apply", "reviewer-verdicts");
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${artifactId}.json`);
  const bodyJson = JSON.stringify(verdict, null, 2);
  await writeFile(storagePath, bodyJson, "utf8");

  const artifactRepo = new ArtifactRepository();
  await artifactRepo.create({
    id: artifactId,
    taskId: review.taskId,
    roleRuntimeId: callerRoleRuntimeId,
    artifactType: ARTIFACT_TYPE,
    title: `Reviewer verdict for ${verdict.reviewedReviewId}`,
    storageKind: "file",
    storageRef: storagePath,
    summary: `${verdict.verdict} (${verdict.confidence}) — ${verdict.blockingFindings.length} blocking, ${verdict.nonBlockingFindings.length} non-blocking`,
    createdAt: new Date(),
  });

  // Codex GPT-5.5 v3 review (2026-05-24) caught that v1 of this
  // claim-the-slot block was NOT one-write: the WHERE only matched
  // by id, so a second submission silently overwrote the first. The
  // fix is an atomic conditional update gated on
  // `isNull(reviewerVerdictArtifactId)`. After the update we
  // re-read to verify our artifact id is the one in the slot. If a
  // concurrent caller beat us to it, our artifact file becomes an
  // orphan on disk (harmless — never linked) and we throw
  // ReviewerVerdictAlreadySubmittedError so the reviewer teammate
  // gets a clear signal that someone else owns the slot.
  const db = createDb();
  // Codex v3.1 4-审 BLOCKER 1 partial-fix: add apply_state fence to
  // this UPDATE too. A reviewer racing a Leader who is mid-apply
  // would in theory be filtered by the existing slot guard, but
  // defense-in-depth — if Leader has already committed to apply
  // based on an earlier verdict, no late verdict should attach to
  // the same row. `apply_state != 'applying'` covers this.
  await db
    .update(changeReviews)
    .set({ reviewerVerdictArtifactId: artifactId, updatedAt: new Date() })
    .where(
      and(
        eq(changeReviews.id, verdict.reviewedReviewId),
        isNull(changeReviews.reviewerVerdictArtifactId),
        ne(changeReviews.applyState, "applying"),
      ),
    );

  const reread = await reviewRepo.getById(verdict.reviewedReviewId);
  if (!reread || reread.reviewerVerdictArtifactId !== artifactId) {
    throw new ReviewerVerdictAlreadySubmittedError(
      `submit_review_verdict: ${verdict.reviewedReviewId} already has a verdict artifact (slot owner=${reread?.reviewerVerdictArtifactId ?? "missing"}); refusing to overwrite`,
    );
  }

  return { artifactId };
}

/**
 * Read the typed verdict (if any) attached to a review. Returns
 * `null` when no verdict has been submitted yet, or when a verdict
 * artifact exists but its body is malformed (legacy or corrupted —
 * caller falls back to markdown parsing).
 */
export async function getReviewerVerdictForReview(
  reviewId: string,
): Promise<ReviewerVerdict | null> {
  const reviewRepo = new ChangeReviewRepository();
  const review = await reviewRepo.getById(reviewId);
  if (!review || !review.reviewerVerdictArtifactId) return null;

  const artifactRepo = new ArtifactRepository();
  const artifact = await artifactRepo.getById(review.reviewerVerdictArtifactId);
  if (!artifact || artifact.artifactType !== ARTIFACT_TYPE) return null;

  try {
    const body = await readFile(artifact.storageRef, "utf8");
    const parsed = JSON.parse(body);
    const result = ReviewerVerdictSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Legacy fallback: extract a verdict from a reviewer teammate's
 * markdown response. Current reviewer prompt ends with a line like
 * `VERDICT: APPROVE` or `VERDICT: REJECT`. We treat any legacy
 * verdict as `confidence: "low"` — Leader's autonomy gate already
 * requires `high` to apply autonomously, so low-confidence verdicts
 * always escalate to the operator. This means rolling out the typed
 * artifact tool doesn't have to be atomic with deprecating the
 * markdown convention; both paths coexist safely.
 *
 * Returns `null` if no VERDICT line is found.
 */
export function parseLegacyMarkdownVerdict(
  markdown: string,
  context: { reviewedReviewId: string; reviewerRoleRuntimeId: string },
): ReviewerVerdict | null {
  const line = markdown
    .split("\n")
    .map((s) => s.trim())
    .reverse()
    .find((s) => /^VERDICT:\s*\w+/i.test(s));
  if (!line) return null;
  const match = line.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES|REJECT)/i);
  if (!match) return null;
  const verdict = match[1]!.toUpperCase() as "APPROVE" | "REQUEST_CHANGES" | "REJECT";
  return {
    verdict,
    confidence: "low",
    reviewedReviewId: context.reviewedReviewId,
    reviewerRoleRuntimeId: context.reviewerRoleRuntimeId,
    blockingFindings: [],
    nonBlockingFindings: [],
    evidence: [],
    narrative: "Legacy-format reviewer verdict (markdown VERDICT line). Treated as low-confidence so Leader will escalate to the operator.",
  };
}
