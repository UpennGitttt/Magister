import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ChangeReviewPanel } from "./ChangeReviewPanel";

const ORIGINAL_FETCH = globalThis.fetch;

type RecordedRequest = {
  url: string;
  method: string | undefined;
  body: string | undefined;
};

const requests: RecordedRequest[] = [];
let reviewsResponse: unknown[] = [];
let detailResponse: unknown | null = null;
let decisionStatus = 200;
let decisionErrorCode = "conflict";
let decisionErrorMessage = "expectedDiffHash does not match current review diffHash";
let decisionPayload: unknown = null;
let applyStatus = 200;
let applyErrorCode = "base_revision_mismatch";
let applyErrorMessage = "Main workspace HEAD does not match reviewed base revision.";
let applyPayload: unknown = null;
let discardStatus = 200;
let discardPayload: unknown = null;
let reviewsStatus = 200;
let reviewsErrorCode = "request_timeout";
let reviewsErrorMessage = "请求超时 (60000ms)：/tasks/task_1/change-reviews — 服务无响应或网络异常,请重试。";

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

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (url === "/api/tasks/task_1/change-reviews") {
      if (reviewsStatus >= 400) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: reviewsErrorCode, message: reviewsErrorMessage },
        }), {
          status: reviewsStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { reviews: reviewsResponse } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1") {
      return new Response(JSON.stringify({ ok: true, data: { review: detailResponse ?? reviewDetail() } }), {
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
          byteLength: 52,
          maxBytes: 131072,
          truncated: false,
          patch: "diff --git a/src/a.ts b/src/a.ts\n+secret patch bytes\n",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1/decision") {
      if (decisionStatus >= 400) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: decisionErrorCode, message: decisionErrorMessage },
        }), {
          status: decisionStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: decisionPayload ?? {
          review: reviewSummary({ decisionState: "approved" }),
          idempotent: false,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1/apply") {
      if (applyStatus >= 400) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: applyErrorCode, message: applyErrorMessage },
        }), {
          status: applyStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: applyPayload ?? {
          review: reviewSummary({ decisionState: "approved", applyState: "applied" }),
          idempotent: false,
          appliedPatchHash: "hash_1",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/change-reviews/review_1/discard") {
      if (discardStatus >= 400) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: "conflict", message: "review state changed concurrently" },
        }), {
          status: discardStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: discardPayload ?? {
          review: reviewSummary({ decisionState: "superseded", applyState: "not_applied" }),
          idempotent: false,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests.length = 0;
  reviewsResponse = [];
  detailResponse = null;
  decisionStatus = 200;
  decisionErrorCode = "conflict";
  decisionErrorMessage = "expectedDiffHash does not match current review diffHash";
  decisionPayload = null;
  applyStatus = 200;
  applyErrorCode = "base_revision_mismatch";
  applyErrorMessage = "Main workspace HEAD does not match reviewed base revision.";
  applyPayload = null;
  discardStatus = 200;
  discardPayload = null;
  reviewsStatus = 200;
  reviewsErrorCode = "request_timeout";
  reviewsErrorMessage = "请求超时 (60000ms)：/tasks/task_1/change-reviews — 服务无响应或网络异常,请重试。";
  installFetchMock();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("ChangeReviewPanel", () => {
  test("renders nothing when the selected task has no change reviews", async () => {
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(requests.some((request) => request.url === "/api/tasks/task_1/change-reviews")).toBe(true);
    });

    expect(view.queryByLabelText("Patch Reviews")).toBeNull();
  });

  test("pending-bar surface shows only actionable review entrypoint and opens detail", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="EXECUTING" />);

    await waitFor(() => {
      expect(view.getByLabelText("Patch Reviews")).toBeTruthy();
    });

    expect(view.getByText("1 patch review needs action")).toBeTruthy();
    expect(view.getByText("1 to review")).toBeTruthy();
    expect(view.queryByText("src/a.ts")).toBeNull();
    expect(view.queryByText(/secret patch bytes/)).toBeNull();

    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));

    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /Patch Review Detail/i })).toBeTruthy();
      expect(view.getByLabelText("Diff preview")).toBeTruthy();
      expect(view.getByText(/secret patch bytes/)).toBeTruthy();
    });
  });

  test("embedded entrypoint opens in-chat detail instead of spawning a second review window", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(
      <ChangeReviewPanel
        taskId="task_1"
        taskState="EXECUTING"
      />,
    );

    const button = await view.findByRole("button", { name: /Review patch/i });
    expect(view.queryByRole("link", { name: /Open change review window/i })).toBeNull();

    fireEvent.click(button);

    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /Patch Review Detail/i })).toBeTruthy();
      expect(view.getByLabelText("Diff preview")).toBeTruthy();
    });
    expect(requests.map((request) => request.url)).toContain("/api/change-reviews/review_1/diff");
  });

  test("actionable review bar collapses into a compact pill instead of staying pinned open", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved", applyState: "not_applied" })];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByLabelText("Patch Reviews")).toBeTruthy();
    });
    expect(view.getByText("1 patch review needs action")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /Collapse patch review bar/i }));

    await waitFor(() => {
      expect(view.queryByText("1 patch review needs action")).toBeNull();
      expect(view.getByRole("button", { name: /Show patch review bar/i })).toBeTruthy();
      expect(view.getByText("Patch Review · 1 to apply")).toBeTruthy();
    });
  });

  test("list errors can be dismissed from the embedded review bar", async () => {
    reviewsStatus = 504;
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="EXECUTING" />);

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("请求超时");
    });

    fireEvent.click(view.getByRole("button", { name: /Dismiss patch review alert/i }));

    await waitFor(() => {
      expect(view.queryByLabelText("Patch Reviews")).toBeNull();
    });
  });

  test("pending-bar surface hides terminal review history when no action is required", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved", applyState: "applied" })];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(requests.some((request) => request.url === "/api/tasks/task_1/change-reviews")).toBe(true);
    });

    expect(view.queryByLabelText("Patch Reviews")).toBeNull();
  });

  test("shows pending review without loading patch bytes until detail opens", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="EXECUTING" />);

    await waitFor(() => {
      expect(view.getByLabelText("Patch Reviews")).toBeTruthy();
    });

    expect(view.queryByText(/secret patch bytes/)).toBeNull();
    expect(view.queryByRole("button", { name: /Apply patch to workspace/i })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));

    // "Audit events" section was removed in commit 5552cd4
    // (delete HMAC audit chain — overkill for single-operator localhost).
    // Test no longer asserts its presence.
    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /Patch Review Detail/i })).toBeTruthy();
      expect(view.getByLabelText("Runtime metadata")).toBeTruthy();
      expect(view.getByLabelText("Diff preview")).toBeTruthy();
      expect(view.getByText(/secret patch bytes/)).toBeTruthy();
      expect(view.queryByRole("button", { name: /Apply patch to workspace/i })).toBeNull();
    });
    expect(requests.map((request) => request.url)).toContain("/api/change-reviews/review_1/diff");
  });

  test("renders SAST advisory findings in review detail", async () => {
    reviewsResponse = [reviewSummary({
      reasonCodes: ["sast_advisory_finding"],
    })];
    detailResponse = reviewDetail({
      riskReasons: [
        {
          code: "sast_advisory_finding",
          message: "SAST advisory reported findings.",
        },
      ],
      sastAdvisory: {
        status: "findings",
        scanner: "semgrep",
        reason: null,
        command: ["semgrep", "--json", "src/a.ts"],
        durationMs: 14,
        startedAt: "2026-05-14T00:00:00.000Z",
        finishedAt: "2026-05-14T00:00:00.014Z",
        findings: [
          {
            scanner: "semgrep",
            ruleId: "rule.eval",
            severity: "warning",
            path: "src/a.ts",
            line: 1,
            message: "eval call",
            metadata: {},
          },
        ],
      },
    });
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    fireEvent.click(await view.findByRole("button", { name: /Review patch/i }));

    await waitFor(() => {
      expect(view.getByLabelText("SAST advisory")).toBeTruthy();
      expect(view.getByText("semgrep")).toBeTruthy();
      expect(view.getByText("rule.eval")).toBeTruthy();
      expect(view.getByText(/src\/a\.ts:1/)).toBeTruthy();
      expect(view.getByText("eval call")).toBeTruthy();
    });
  });

  test("moves focus into detail and Escape closes back to the opener", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    const opener = await view.findByRole("button", { name: /Review patch/i });
    fireEvent.click(opener);

    await waitFor(() => {
      expect(document.activeElement).toBe(view.getByRole("dialog", { name: /Patch Review Detail/i }));
    });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(view.queryByRole("dialog", { name: /Patch Review Detail/i })).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  });

  test("approves pending review with expectedDiffHash and refreshes list", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="EXECUTING" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Approve & Apply/i })).toBeTruthy();
    });

    reviewsResponse = [reviewSummary({ decisionState: "approved" })];
    detailResponse = reviewDetail({ decisionState: "approved" });
    fireEvent.click(view.getByRole("button", { name: /Approve & Apply/i }));

    await waitFor(() => {
      const post = requests.find((request) => request.url === "/api/change-reviews/review_1/decision");
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body ?? "{}")).toEqual({
        decision: "approve",
        expectedDiffHash: "hash_1",
      });
      expect(view.getAllByText("Approved for apply").length).toBeGreaterThan(0);
      expect(requests.filter((request) => request.url === "/api/change-reviews/review_1")).toHaveLength(2);
    });
  });

  test("requires notes for reject and request revision decisions", async () => {
    reviewsResponse = [reviewSummary()];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Reject/i })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /Reject/i }));
    expect(view.getByRole("alert").textContent).toContain("note");
    expect(requests.some((request) => request.url === "/api/change-reviews/review_1/decision")).toBe(false);
  });

  test("shows conflict errors without mutating the final state", async () => {
    reviewsResponse = [reviewSummary()];
    decisionStatus = 409;
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Approve & Apply/i })).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Approve & Apply/i }));
    });

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("expectedDiffHash");
      expect(view.getAllByText("Review required").length).toBeGreaterThan(0);
      expect(requests.filter((request) => request.url === "/api/change-reviews/review_1")).toHaveLength(2);
    });
  });

  test("applies an approved review with expectedDiffHash and refreshes detail", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved" })];
    detailResponse = reviewDetail({ decisionState: "approved" });
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Apply patch to workspace/i })).toBeTruthy();
    });

    reviewsResponse = [reviewSummary({ decisionState: "approved", applyState: "applied" })];
    detailResponse = reviewDetail({ decisionState: "approved", applyState: "applied" });
    fireEvent.click(view.getByRole("button", { name: /Apply patch to workspace/i }));

    await waitFor(() => {
      const post = requests.find((request) => request.url === "/api/change-reviews/review_1/apply");
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body ?? "{}")).toEqual({
        expectedDiffHash: "hash_1",
      });
      expect(view.getAllByText("Applied").length).toBeGreaterThan(0);
      expect(requests.filter((request) => request.url === "/api/change-reviews/review_1")).toHaveLength(2);
    });
  });

  test("shows apply conflicts without applying local state", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved" })];
    detailResponse = reviewDetail({ decisionState: "approved" });
    applyStatus = 409;
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Apply patch to workspace/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Apply patch to workspace/i }));

    await waitFor(() => {
      expect(view.getByRole("alert").textContent).toContain("Main workspace HEAD");
      expect(view.getAllByText("Not applied").length).toBeGreaterThan(0);
      expect(requests.filter((request) => request.url === "/api/change-reviews/review_1")).toHaveLength(2);
    });
  });

  test("disables apply when detail reports a dirty conflicting workspace", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved" })];
    detailResponse = reviewDetail({
      decisionState: "approved",
      applicability: {
        applicable: false,
        code: "workspace_dirty",
        reason: "Workspace has local changes that conflict with the patch: src/a.ts",
      },
    });
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(view.getByRole("button", { name: /Review patch/i })).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Review patch/i }));

    await waitFor(() => {
      const status = view.getByRole("status");
      expect(status.textContent).toContain("Cannot apply patch.");
      expect(status.textContent).toContain("src/a.ts");
      expect((view.getByRole("button", { name: /Apply patch to workspace/i }) as HTMLButtonElement).disabled).toBe(true);
      expect(view.getByRole("button", { name: /Supersede patch/i })).toBeTruthy();
    });
  });

  test("supersedes a blocked approved patch and removes it from actionable queue", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "approved" })];
    detailResponse = reviewDetail({
      decisionState: "approved",
      applicability: {
        applicable: false,
        code: "workspace_dirty",
        reason: "Workspace has local changes that conflict with the patch: src/a.ts",
      },
    });
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    fireEvent.click(await view.findByRole("button", { name: /Review patch/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /Supersede patch/i })).toBeTruthy();
    });

    reviewsResponse = [reviewSummary({ decisionState: "superseded", applyState: "not_applied" })];
    detailResponse = reviewDetail({ decisionState: "superseded", applyState: "not_applied" });
    fireEvent.click(view.getByRole("button", { name: /Supersede patch/i }));

    await waitFor(() => {
      const post = requests.find((request) => request.url === "/api/change-reviews/review_1/discard");
      expect(post).toBeTruthy();
      expect(view.queryByLabelText("Patch Reviews")).toBeNull();
    });
  });

  test("non-pending reviews are read-only", async () => {
    reviewsResponse = [reviewSummary({ decisionState: "rejected", applyState: "not_applied" })];
    const view = render(<ChangeReviewPanel taskId="task_1" taskState="DONE" />);

    await waitFor(() => {
      expect(requests.some((request) => request.url === "/api/tasks/task_1/change-reviews")).toBe(true);
    });
    expect(view.queryByRole("button", { name: /Review patch/i })).toBeNull();
    expect(view.queryByLabelText("Patch Reviews")).toBeNull();
  });
});
