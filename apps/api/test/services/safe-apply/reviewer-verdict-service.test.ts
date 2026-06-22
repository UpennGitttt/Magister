// 2026-05-24 — Tests for the reviewer-verdict typed-artifact service.
// Covers:
//   - Zod schema accepts the canonical shape
//   - Zod rejects out-of-range / missing-required-field input
//   - Persist refuses when caller != claimed reviewerRoleRuntimeId
//   - Persist refuses when target review id doesn't exist
//   - Legacy markdown VERDICT line parses to confidence:low

import { describe, expect, test } from "bun:test";

import {
  ReviewerVerdictSchema,
  parseLegacyMarkdownVerdict,
  persistReviewerVerdict,
  ReviewerVerdictForgedError,
  ReviewerVerdictTargetMissingError,
  ReviewerVerdictAlreadySubmittedError,
} from "../../../src/services/safe-apply/reviewer-verdict-service";

describe("ReviewerVerdictSchema", () => {
  const valid = {
    verdict: "APPROVE" as const,
    confidence: "high" as const,
    reviewedReviewId: "change_review_aaa",
    reviewerRoleRuntimeId: "rr_reviewer_1",
    blockingFindings: [],
    nonBlockingFindings: [{ file: "src/x.ts", line: 12, issue: "consider extracting" }],
    evidence: [{ kind: "test" as const, label: "bun test apps/api", summary: "78 pass, 0 fail" }],
    narrative: "Looks good.",
  };

  test("accepts canonical shape", () => {
    expect(ReviewerVerdictSchema.parse(valid)).toEqual(valid);
  });

  test("rejects unknown verdict enum", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({ ...valid, verdict: "MAYBE" }),
    ).toThrow();
  });

  test("rejects unknown confidence enum", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({ ...valid, confidence: "very_high" }),
    ).toThrow();
  });

  test("rejects line:0", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({
        ...valid,
        blockingFindings: [{ file: "x.ts", line: 0, issue: "..." }],
      }),
    ).toThrow();
  });

  test("rejects oversized narrative", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({ ...valid, narrative: "x".repeat(5_000) }),
    ).toThrow();
  });
});

describe("parseLegacyMarkdownVerdict", () => {
  const ctx = {
    reviewedReviewId: "change_review_legacy",
    reviewerRoleRuntimeId: "rr_legacy",
  };

  test("extracts APPROVE", () => {
    const parsed = parseLegacyMarkdownVerdict(
      "Some narrative.\n\nVERDICT: APPROVE\n",
      ctx,
    );
    expect(parsed?.verdict).toBe("APPROVE");
    expect(parsed?.confidence).toBe("low");
    expect(parsed?.reviewedReviewId).toBe(ctx.reviewedReviewId);
  });

  test("extracts REJECT case-insensitively", () => {
    const parsed = parseLegacyMarkdownVerdict(
      "...\n\nverdict: reject",
      ctx,
    );
    expect(parsed?.verdict).toBe("REJECT");
  });

  test("returns null when no VERDICT line", () => {
    expect(
      parseLegacyMarkdownVerdict("Plain text without a verdict line.", ctx),
    ).toBeNull();
  });

  test("returns null when VERDICT value is unrecognised", () => {
    expect(
      parseLegacyMarkdownVerdict("VERDICT: maybe", ctx),
    ).toBeNull();
  });

  test("uses the LAST VERDICT line when multiple are present", () => {
    // A teammate that flip-flopped — last line wins (terminal state).
    const parsed = parseLegacyMarkdownVerdict(
      "VERDICT: APPROVE\n... reconsidered ...\nVERDICT: REJECT",
      ctx,
    );
    expect(parsed?.verdict).toBe("REJECT");
  });
});

// AlreadySubmittedError test — needs a real workspace + review row,
// which requires DB bootstrapping similar to leader-review-tools tests.
import { afterEach as innerAfterEach, beforeEach as innerBeforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

describe("persistReviewerVerdict one-write slot (codex v3 BLOCKER fix)", () => {
  let tempDir = "";
  let prevDb: string | undefined;

  innerBeforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reviewer-verdict-slot-test-"));
    prevDb = process.env.MAGISTER_DB_PATH;
    process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
  });
  innerAfterEach(async () => {
    if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
    else process.env.MAGISTER_DB_PATH = prevDb;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("second submission against the same review throws AlreadySubmittedError; slot is preserved", async () => {
    const { WorkspaceRepository } = await import(
      "../../../src/repositories/workspace-repository"
    );
    const { ChangeReviewRepository } = await import(
      "../../../src/repositories/change-review-repository"
    );

    const workspaceId = `ws_${randomUUID().slice(0, 8)}`;
    await new WorkspaceRepository().create({
      id: workspaceId,
      label: "ws",
      basePath: tempDir,
    });

    const review = await new ChangeReviewRepository().createFromDraft({
      taskId: `task_${randomUUID().slice(0, 8)}`,
      roleRuntimeId: `rr_test`,
      workspaceId,
      sourceEventId: null,
      reviewDraftArtifactId: `art_draft_${randomUUID().slice(0, 8)}`,
      diffArtifactId: `art_diff_${randomUUID().slice(0, 8)}`,
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
      diffHash: "h",
      diffAlgorithmJson: "{}",
      changedFilesJson: "[]",
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
      applyState: "not_applied",
      appliedAt: null,
      assignee: "leader",
      assigneeSetBy: "router",
      reviewerVerdictArtifactId: null,
      leaderApplyCommitSha: null,
    });

    const firstResult = await persistReviewerVerdict({
      callerRoleRuntimeId: "rr_reviewer_a",
      verdict: {
        verdict: "APPROVE",
        confidence: "high",
        reviewedReviewId: review.id,
        reviewerRoleRuntimeId: "rr_reviewer_a",
        blockingFindings: [],
        nonBlockingFindings: [],
        evidence: [],
        narrative: "first",
      },
    });
    expect(firstResult.artifactId).toBeDefined();

    // Same caller, second submit — should be rejected.
    let thrown: unknown = null;
    try {
      await persistReviewerVerdict({
        callerRoleRuntimeId: "rr_reviewer_a",
        verdict: {
          verdict: "REJECT",
          confidence: "high",
          reviewedReviewId: review.id,
          reviewerRoleRuntimeId: "rr_reviewer_a",
          blockingFindings: [],
          nonBlockingFindings: [],
          evidence: [],
          narrative: "second — should not land",
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewerVerdictAlreadySubmittedError);

    // The original artifact id is still in the slot.
    const reread = await new ChangeReviewRepository().getById(review.id);
    expect(reread?.reviewerVerdictArtifactId).toBe(firstResult.artifactId);
  });
});

describe("persistReviewerVerdict forgery guard", () => {
  test("rejects when caller's role_runtime_id doesn't match claimed reviewerRoleRuntimeId", async () => {
    let thrown: unknown = null;
    try {
      await persistReviewerVerdict({
        callerRoleRuntimeId: "rr_actual_coder",
        verdict: {
          verdict: "APPROVE",
          confidence: "high",
          reviewedReviewId: "change_review_x",
          reviewerRoleRuntimeId: "rr_pretend_reviewer", // mismatch!
          blockingFindings: [],
          nonBlockingFindings: [],
          evidence: [],
          narrative: "",
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewerVerdictForgedError);
  });

  test("rejects when claimed reviewedReviewId doesn't exist in the DB", async () => {
    // Caller and reviewerRoleRuntimeId match, but the review id is
    // bogus. We expect ReviewerVerdictTargetMissingError. (The DB
    // lookup goes through ChangeReviewRepository — in this test
    // environment we just trust the bogus id has no real row.)
    let thrown: unknown = null;
    try {
      await persistReviewerVerdict({
        callerRoleRuntimeId: "rr_aligned",
        verdict: {
          verdict: "REJECT",
          confidence: "medium",
          reviewedReviewId: "change_review_does_not_exist_xyz_123",
          reviewerRoleRuntimeId: "rr_aligned",
          blockingFindings: [],
          nonBlockingFindings: [],
          evidence: [],
          narrative: "",
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewerVerdictTargetMissingError);
  });
});
