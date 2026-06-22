import "../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChangeReviewPage } from "./ChangeReviewPage";

const ORIGINAL_FETCH = globalThis.fetch;

function reviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "review_1",
    taskId: "task_1",
    roleRuntimeId: "rt_1",
    runtimeSource: "codex",
    permissionMode: "headless",
    runtimeWorkspaceStrategy: "git_worktree",
    risk: "HUMAN_REQUIRED",
    decisionState: "pending",
    applyState: "not_applied",
    diffHash: "hash_1",
    baseRevision: "base_1",
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        isBinary: false,
        isExecutable: false,
      },
    ],
    addedLines: 2,
    removedLines: 1,
    reasonCodes: ["runtime_headless"],
    sideEffectWarningCode: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

function reviewDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...reviewSummary(),
    artifactIds: {
      reviewDraftArtifactId: "artifact_draft",
      diffArtifactId: "artifact_diff",
      gateArtifactId: "artifact_gate",
    },
    runtimeSecurity: {
      runtimeSource: "codex",
      commandPath: "codex",
      argvFlags: ["exec", "--sandbox", "workspace-write"],
      sandboxMode: "workspace-write",
      permissionMode: "headless",
      permissionSignals: ["headless-runtime"],
      envPermissionHints: [],
      runtimeWorkspaceStrategy: "git_worktree",
    },
    diffAlgorithm: {},
    riskReasons: [
      {
        code: "runtime_headless",
        message: "Headless runtime output requires review.",
      },
    ],
    verification: [],
    reviewerVerdicts: [],
    sideEffectWarning: null,
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/tasks/task_1/change-reviews") {
      return new Response(JSON.stringify({ ok: true, data: { reviews: [reviewSummary()] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1") {
      return new Response(JSON.stringify({ ok: true, data: { review: reviewDetail() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1/diff") {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          reviewId: "review_1",
          diffArtifactId: "artifact_diff",
          diffHash: "hash_1",
          byteLength: 56,
          maxBytes: 131072,
          truncated: false,
          patch: "diff --git a/src/a.ts b/src/a.ts\n+standalone patch bytes\n",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: url } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("ChangeReviewPage", () => {
  test("renders a standalone review workspace for a session task", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_1/change-reviews"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId/change-reviews" element={<ChangeReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await view.findByRole("heading", { name: "Patch Reviews" })).toBeTruthy();
    expect(view.getByRole("link", { name: /Back to session/i }).getAttribute("href")).toBe(
      "/w/workspace_main/sessions/task_1",
    );

    await waitFor(() => {
      expect(view.getByLabelText("Patch Review Workspace")).toBeTruthy();
      expect(view.getByLabelText("Diff preview")).toBeTruthy();
      expect(view.getByText(/standalone patch bytes/)).toBeTruthy();
    });

    expect(view.queryByRole("dialog", { name: /Patch Review Detail/i })).toBeNull();
  });
});
