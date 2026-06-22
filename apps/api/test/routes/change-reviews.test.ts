import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifacts, createDb, eq } from "@magister/db";

import { buildApp } from "../../src/app";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ChangeReviewRepository } from "../../src/repositories/change-review-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { WorkspaceRepository } from "../../src/repositories/workspace-repository";
import { createChangeReviewDraft } from "../../src/services/safe-apply/change-review-draft-service";
import type {
  RuntimeDiffArtifact,
  RuntimeSecurityMetadata,
  StaticGateResult,
} from "../../src/services/safe-apply/safe-apply-types";

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  const dbDir = tempDir("change-reviews-route-db-");
  process.env.MAGISTER_DB_PATH = join(dbDir, "control.sqlite");
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function seedReviewDraft(taskId: string, gate?: StaticGateResult, patchText?: string) {
  const artifactsDir = tempDir("change-reviews-route-artifacts-");
  const patchPath = join(artifactsDir, `${taskId}.diff`);
  writeFileSync(
    patchPath,
    patchText ?? "diff --git a/src/a.ts b/src/a.ts\n+secret patch bytes\n",
    "utf8",
  );

  const runtimeSecurity: RuntimeSecurityMetadata = {
    runtimeSource: "codex",
    commandPath: "codex",
    argvFlags: ["exec", "--sandbox", "workspace-write"],
    sandboxMode: "workspace-write",
    permissionMode: "headless",
    permissionSignals: ["headless-runtime"],
    envPermissionHints: [],
    runtimeWorkspaceStrategy: "git_worktree",
    executionSandbox: null,
  };
  const diffArtifact: RuntimeDiffArtifact = {
    artifactId: `artifact_diff_${taskId}`,
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef: patchPath,
    diffHash: `hash_${taskId}`,
    diffAlgorithm: {
      command: ["git", "diff", "--no-color", "--binary", "--full-index", "--find-renames=50%"],
      gitVersion: "git version 2.43.0",
      hash: "sha256",
    },
    baseRevision: "base_rev_1",
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
        isExecutable: false,
      },
    ],
    addedLines: 1,
    removedLines: 0,
    isEmpty: false,
  };

  const result = await createChangeReviewDraft({
    taskId,
    roleRuntimeId: `runtime_${taskId}`,
    workspaceId: "workspace_main",
    runtimeSecurity,
    diffArtifact,
    gate:
      gate ?? {
        risk: "HUMAN_REQUIRED",
        reasons: [
          {
            code: "runtime_headless",
            message: "Headless runtime output requires review.",
          },
        ],
      },
    sideEffectWarning: null,
    verification: [],
    artifactsDir,
    now: () => new Date("2026-05-13T00:00:00.000Z"),
    artifactRepository: new ArtifactRepository(),
    executionEventRepository: new ExecutionEventRepository(),
  });

  return { ...result, taskId, patchPath };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createApplyRepoWithPatch() {
  const repoDir = tempDir("change-reviews-route-apply-repo-");
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "a.ts"), "export const value = 1;\n", "utf8");
  git(repoDir, ["add", "src/a.ts"]);
  git(repoDir, ["commit", "-m", "base"]);
  const baseRevision = git(repoDir, ["rev-parse", "HEAD"]);
  writeFileSync(join(repoDir, "src", "a.ts"), "export const value = 2;\n", "utf8");
  const patch = execFileSync(
    "git",
    ["diff", "--no-color", "--binary", "--full-index", "--find-renames=50%", baseRevision],
    { cwd: repoDir },
  );
  git(repoDir, ["checkout", "--", "."]);
  return { repoDir, baseRevision, patch };
}

async function seedApprovedApplyReview(taskId: string) {
  const repo = createApplyRepoWithPatch();
  await new WorkspaceRepository().update("workspace_main", { basePath: repo.repoDir });
  const artifactsDir = tempDir("change-reviews-route-apply-artifacts-");
  const patchPath = join(artifactsDir, `${taskId}.patch`);
  writeFileSync(patchPath, repo.patch);
  const diffHash = createHash("sha256").update(repo.patch).digest("hex");
  const runtimeSecurity: RuntimeSecurityMetadata = {
    runtimeSource: "codex",
    commandPath: "codex",
    argvFlags: ["exec", "--sandbox", "workspace-write"],
    sandboxMode: "workspace-write",
    permissionMode: "headless",
    permissionSignals: ["headless-runtime"],
    envPermissionHints: [],
    runtimeWorkspaceStrategy: "git_worktree",
    executionSandbox: null,
  };
  const diffArtifact: RuntimeDiffArtifact = {
    artifactId: `artifact_diff_${taskId}`,
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef: patchPath,
    diffHash,
    diffAlgorithm: {
      command: ["git", "diff", "--no-color", "--binary", "--full-index", "--find-renames=50%"],
      gitVersion: "git version 2.43.0",
      hash: "sha256",
    },
    baseRevision: repo.baseRevision,
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        isBinary: false,
        isExecutable: false,
      },
    ],
    addedLines: 1,
    removedLines: 1,
    isEmpty: false,
  };
  await createChangeReviewDraft({
    taskId,
    roleRuntimeId: `runtime_${taskId}`,
    workspaceId: "workspace_main",
    runtimeSecurity,
    diffArtifact,
    gate: {
      risk: "HUMAN_REQUIRED",
      reasons: [{ code: "runtime_headless", message: "Headless runtime output requires review." }],
    },
    sideEffectWarning: null,
    verification: [],
    artifactsDir,
    now: () => new Date("2026-05-13T00:00:00.000Z"),
    artifactRepository: new ArtifactRepository(),
    executionEventRepository: new ExecutionEventRepository(),
  });
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(taskId);
  expect(review).toBeDefined();
  const approve = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${review!.id}/decision`,
    payload: {
      decision: "approve",
      expectedDiffHash: diffHash,
      actorId: "user_1",
    },
  });
  expect(approve.statusCode).toBe(200);
  return { ...repo, review: (await new ChangeReviewRepository().getById(review!.id))!, diffHash };
}

test("GET /tasks/:taskId/change-reviews backfills draft events and returns summaries", async () => {
  const seeded = await seedReviewDraft("task_route_list");
  const response = await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: true;
    data: {
      reviews: Array<{
        id: string;
        taskId: string;
        risk: string;
        decisionState: string;
        reasonCodes: string[];
        changedFiles: Array<{ path: string }>;
      }>;
    };
  };

  expect(body.ok).toBe(true);
  expect(body.data.reviews).toHaveLength(1);
  expect(body.data.reviews[0]).toMatchObject({
    taskId: seeded.taskId,
    risk: "HUMAN_REQUIRED",
    decisionState: "pending",
    reasonCodes: ["runtime_headless"],
    changedFiles: [{ path: "src/a.ts" }],
  });
  expect(JSON.stringify(body)).not.toContain("secret patch bytes");
});

test("GET /change-reviews/:reviewId includes audit metadata without patch bytes", async () => {
  const seeded = await seedReviewDraft("task_route_detail");
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(seeded.taskId);
  expect(review).toBeDefined();

  const response = await buildApp().inject({
    method: "GET",
    url: `/change-reviews/${review!.id}`,
  });

  expect(response.statusCode).toBe(200);
  const bodyText = response.body;
  const body = response.json() as {
    ok: true;
    data: { review: { id: string; artifactIds: { diffArtifactId: string } } };
  };

  expect(body.ok).toBe(true);
  expect(body.data.review.id).toBe(review!.id);
  expect(body.data.review.artifactIds.diffArtifactId).toBe(seeded.artifactIds.diffArtifactId);
  expect(bodyText).not.toContain("secret patch bytes");
  expect(readFileSync(seeded.patchPath, "utf8")).toContain("secret patch bytes");
});

test("GET /change-reviews/:reviewId flags conflicting dirty workspace as not applicable", async () => {
  const seeded = await seedApprovedApplyReview("task_route_detail_dirty_conflict");
  writeFileSync(join(seeded.repoDir, "src", "a.ts"), "export const value = 99;\n", "utf8");

  const response = await buildApp().inject({
    method: "GET",
    url: `/change-reviews/${seeded.review.id}`,
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    data: {
      review: {
        applicability?: { applicable: boolean; code?: string; reason?: string };
      };
    };
  };
  expect(body.data.review.applicability).toMatchObject({
    applicable: false,
    code: "workspace_dirty",
  });
  expect(body.data.review.applicability?.reason).toContain("src/a.ts");
});

test("POST /change-reviews/:reviewId/discard marks blocked approved patch as superseded", async () => {
  const seeded = await seedApprovedApplyReview("task_route_supersede_dirty_conflict");
  writeFileSync(join(seeded.repoDir, "src", "a.ts"), "export const value = 99;\n", "utf8");

  const response = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${seeded.review.id}/discard`,
    payload: {
      actorId: "user_1",
    },
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: true;
    data: { review: { decisionState: string; applyState: string } };
  };
  expect(body.data.review).toMatchObject({
    decisionState: "superseded",
    applyState: "not_applied",
  });

  const row = await new ChangeReviewRepository().getById(seeded.review.id);
  expect(row?.decisionState).toBe("superseded");
  expect(row?.decisionReason).toContain("not applicable");
});

test("POST /change-reviews/:reviewId/decision records approval and rejects conflicts", async () => {
  const seeded = await seedReviewDraft("task_route_decision");
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(seeded.taskId);
  expect(review).toBeDefined();

  const approve = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${review!.id}/decision`,
    payload: {
      decision: "approve",
      reason: "reviewed",
      expectedDiffHash: `hash_${seeded.taskId}`,
      actorId: "user_1",
    },
  });

  expect(approve.statusCode).toBe(200);
  const approveBody = approve.json() as {
    ok: true;
    data: { review: { decisionState: string } };
  };
  expect(approveBody.data.review.decisionState).toBe("approved");

  const conflict = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${review!.id}/decision`,
    payload: { decision: "reject", reason: "changed my mind", actorId: "user_1" },
  });

  expect(conflict.statusCode).toBe(409);
});

test("POST /change-reviews/:reviewId/decision rejects stale diff hashes", async () => {
  const seeded = await seedReviewDraft("task_route_stale");
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(seeded.taskId);
  expect(review).toBeDefined();

  const stale = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${review!.id}/decision`,
    payload: {
      decision: "approve",
      expectedDiffHash: "different_hash",
      actorId: "user_1",
    },
  });

  expect(stale.statusCode).toBe(409);
});

test("GET /change-reviews/:reviewId/diff returns capped patch preview", async () => {
  const seeded = await seedReviewDraft(
    "task_route_diff",
    undefined,
    "diff --git a/src/a.ts b/src/a.ts\n+secret patch bytes that should be capped\n",
  );
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(seeded.taskId);
  expect(review).toBeDefined();

  const response = await buildApp().inject({
    method: "GET",
    url: `/change-reviews/${review!.id}/diff?maxBytes=23`,
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: true;
    data: {
      reviewId: string;
      diffArtifactId: string;
      diffHash: string;
      byteLength: number;
      maxBytes: number;
      truncated: boolean;
      patch: string;
    };
  };
  expect(body.data).toMatchObject({
    reviewId: review!.id,
    diffArtifactId: seeded.artifactIds.diffArtifactId,
    diffHash: `hash_${seeded.taskId}`,
    maxBytes: 23,
    truncated: true,
  });
  expect(body.data.patch).toBe("diff --git a/src/a.ts b");
  expect(body.data.patch).not.toContain("secret patch bytes");
  expect(body.data.byteLength).toBeGreaterThan(24);

  const clamped = await buildApp().inject({
    method: "GET",
    url: `/change-reviews/${review!.id}/diff?maxBytes=0`,
  });
  expect(clamped.statusCode).toBe(200);
  expect(clamped.json().data).toMatchObject({
    maxBytes: 1,
    truncated: true,
    patch: "d",
  });
});

test("GET /change-reviews/:reviewId/diff rejects missing or non-runtime diff artifacts", async () => {
  const missing = await buildApp().inject({
    method: "GET",
    url: "/change-reviews/change_review_missing/diff",
  });
  expect(missing.statusCode).toBe(404);

  const seeded = await seedReviewDraft("task_route_diff_bad_artifact");
  await buildApp().inject({
    method: "GET",
    url: `/tasks/${seeded.taskId}/change-reviews`,
  });
  const [review] = await new ChangeReviewRepository().listByTaskId(seeded.taskId);
  expect(review).toBeDefined();

  await createDb()
    .update(artifacts)
    .set({ artifactType: "change_review_draft" })
    .where(eq(artifacts.id, seeded.artifactIds.diffArtifactId));

  const badArtifact = await buildApp().inject({
    method: "GET",
    url: `/change-reviews/${review!.id}/diff`,
  });

  expect(badArtifact.statusCode).toBe(422);
});

test("POST /change-reviews/:reviewId/apply applies an approved review", async () => {
  const seeded = await seedApprovedApplyReview("task_route_apply_success");

  const response = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${seeded.review.id}/apply`,
    payload: {
      expectedDiffHash: seeded.diffHash,
    },
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    ok: true;
    data: { review: { applyState: string }; appliedPatchHash: string };
  };
  expect(body.data.review.applyState).toBe("applied");
  expect(body.data.appliedPatchHash).toBe(seeded.diffHash);
  expect(readFileSync(join(seeded.repoDir, "src", "a.ts"), "utf8")).toContain("value = 2");
});

test("POST /change-reviews/:reviewId/apply ignores unrelated local changes", async () => {
  const seeded = await seedApprovedApplyReview("task_route_apply_unrelated_dirty");
  writeFileSync(join(seeded.repoDir, "notes.txt"), "local scratch\n", "utf8");

  const response = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${seeded.review.id}/apply`,
    payload: {
      expectedDiffHash: seeded.diffHash,
    },
  });

  expect(response.statusCode).toBe(200);
  expect(readFileSync(join(seeded.repoDir, "src", "a.ts"), "utf8")).toContain("value = 2");
  expect(readFileSync(join(seeded.repoDir, "notes.txt"), "utf8")).toBe("local scratch\n");
});

test("POST /change-reviews/:reviewId/apply maps stale hash and base mismatch", async () => {
  const stale = await seedApprovedApplyReview("task_route_apply_stale");
  const staleResponse = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${stale.review.id}/apply`,
    payload: { expectedDiffHash: "wrong" },
  });
  expect(staleResponse.statusCode).toBe(409);
  expect(staleResponse.json().error.code).toBe("stale_diff_hash");

  const baseMismatch = await seedApprovedApplyReview("task_route_apply_base_mismatch");
  git(baseMismatch.repoDir, ["commit", "--allow-empty", "-m", "move head"]);
  const mismatchResponse = await buildApp().inject({
    method: "POST",
    url: `/change-reviews/${baseMismatch.review.id}/apply`,
    payload: { expectedDiffHash: baseMismatch.diffHash },
  });
  expect(mismatchResponse.statusCode).toBe(409);
  expect(mismatchResponse.json().error.code).toBe("base_revision_mismatch");
});
