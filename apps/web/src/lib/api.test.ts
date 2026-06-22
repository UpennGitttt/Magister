import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  applyChangeReview,
  decideChangeReview,
  discardChangeReview,
  getChangeReview,
  getChangeReviewDiff,
  getTaskChangeReviews,
  getTools,
  updateAgentProfile,
} from "./api";
import { request } from "./request";

describe("api request handling", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("surfaces a diagnostic error when the API returns an empty body", async () => {
    globalThis.fetch = mock(async () =>
      new Response("", {
        status: 502,
        headers: {
          "content-type": "application/json",
        },
      }),
    ) as unknown as typeof fetch;

    await expect(request("/workspace/summary")).rejects.toThrow(
      "Request failed: /workspace/summary (HTTP 502)",
    );
  });

  test("surfaces a diagnostic error including body snippet when JSON is malformed", async () => {
    globalThis.fetch = mock(async () =>
      new Response("{not valid json", {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(request("/workspace/summary")).rejects.toThrow(
      "Request failed: /workspace/summary (HTTP 400) — {not valid json",
    );
  });

  test("non-envelope error responses (Fastify FST_ERR_*) surface a useful message", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          statusCode: 400,
          code: "FST_ERR_CTP_EMPTY_JSON_BODY",
          error: "Bad Request",
          message: "Body cannot be empty when content-type is set to 'application/json'",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    // Fastify's response is JSON but isn't envelope-shaped (no top-level
    // `ok` field), so the helper falls back to the diagnostic message
    // built from status + body snippet.
    await expect(request("/workspace/summary")).rejects.toThrow(
      /HTTP 400.*FST_ERR_CTP_EMPTY_JSON_BODY/,
    );
  });

  test("surfaces a stable error when the API request cannot reach the server", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(request("/workspace/summary")).rejects.toThrow("Unable to connect to API service. Please check that the server is running.");
  });

  test("getTools reads the settings tools registry", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe("/api/settings/tools");
      return new Response(JSON.stringify({
        ok: true,
        data: {
          items: [{ name: "bash", description: "Run shell commands" }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(getTools()).resolves.toEqual([
      { name: "bash", description: "Run shell commands" },
    ]);
  });

  test("updateAgentProfile sends per-agent tool restrictions", async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        allowedTools: ["bash"],
        disallowedTools: ["web_search"],
      });
      return new Response(JSON.stringify({
        ok: true,
        data: {
          roleId: "custom_tools",
          label: "Custom Tools",
          allowedTools: ["bash"],
          disallowedTools: ["web_search"],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await updateAgentProfile("custom_tools", {
      allowedTools: ["bash"],
      disallowedTools: ["web_search"],
    });
    expect(result.allowedTools).toEqual(["bash"]);
    expect(result.disallowedTools).toEqual(["web_search"]);
  });

  test("getAgentModels sends an explicit blank provider override", async () => {
    const { getAgentModels } = await import("./api");
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe("/api/settings/agents/reviewer/models?runtimeType=ucm&providerId=");
      return new Response(JSON.stringify({
        ok: true,
        data: {
          models: [],
          supported: true,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(getAgentModels("reviewer", { runtimeType: "ucm", providerId: "" })).resolves.toEqual({
      models: [],
      supported: true,
    });
  });

  test("change review helpers unwrap list, detail, diff, and decision responses", async () => {
    const requests: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (String(url) === "/api/tasks/task_1/change-reviews") {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            reviews: [
              {
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
                changedFiles: [],
                addedLines: 1,
                removedLines: 0,
                reasonCodes: ["runtime_headless"],
                sideEffectWarningCode: null,
                createdAt: "2026-05-14T00:00:00.000Z",
                updatedAt: "2026-05-14T00:00:00.000Z",
              },
            ],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "/api/change-reviews/review_1") {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            review: {
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
              changedFiles: [],
              addedLines: 1,
              removedLines: 0,
              reasonCodes: ["runtime_headless"],
              sideEffectWarningCode: null,
              createdAt: "2026-05-14T00:00:00.000Z",
              updatedAt: "2026-05-14T00:00:00.000Z",
              artifactIds: {
                reviewDraftArtifactId: "artifact_draft",
                diffArtifactId: "artifact_diff",
                gateArtifactId: "artifact_gate",
              },
              runtimeSecurity: {
                runtimeSource: "codex",
                commandPath: "codex",
                argvFlags: ["exec"],
                sandboxMode: "workspace-write",
                permissionMode: "headless",
                permissionSignals: [],
                envPermissionHints: [],
                runtimeWorkspaceStrategy: "git_worktree",
              },
              diffAlgorithm: {},
              riskReasons: [{ code: "runtime_headless", message: "Headless runtime output requires review." }],
              verification: [],
              reviewerVerdicts: [],
              sideEffectWarning: null,
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "/api/change-reviews/review_1/diff") {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            reviewId: "review_1",
            diffArtifactId: "artifact_diff",
            diffHash: "hash_1",
            byteLength: 11,
            maxBytes: 131072,
            truncated: false,
            patch: "diff patch\n",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "/api/change-reviews/review_1/decision") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          decision: "approve",
          expectedDiffHash: "hash_1",
        });
        return new Response(JSON.stringify({
          ok: true,
          data: {
            review: {
              id: "review_1",
              taskId: "task_1",
              roleRuntimeId: "rt_1",
              runtimeSource: "codex",
              permissionMode: "headless",
              runtimeWorkspaceStrategy: "git_worktree",
              risk: "HUMAN_REQUIRED",
              decisionState: "approved",
              applyState: "not_applied",
              diffHash: "hash_1",
              baseRevision: "base_1",
              changedFiles: [],
              addedLines: 1,
              removedLines: 0,
              reasonCodes: ["runtime_headless"],
              sideEffectWarningCode: null,
              createdAt: "2026-05-14T00:00:00.000Z",
              updatedAt: "2026-05-14T00:01:00.000Z",
            },
            idempotent: false,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "/api/change-reviews/review_1/apply") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedDiffHash: "hash_1",
        });
        return new Response(JSON.stringify({
          ok: true,
          data: {
            review: {
              id: "review_1",
              taskId: "task_1",
              roleRuntimeId: "rt_1",
              runtimeSource: "codex",
              permissionMode: "headless",
              runtimeWorkspaceStrategy: "git_worktree",
              risk: "HUMAN_REQUIRED",
              decisionState: "approved",
              applyState: "applied",
              diffHash: "hash_1",
              baseRevision: "base_1",
              changedFiles: [],
              addedLines: 1,
              removedLines: 0,
              reasonCodes: ["runtime_headless"],
              sideEffectWarningCode: null,
              createdAt: "2026-05-14T00:00:00.000Z",
              updatedAt: "2026-05-14T00:02:00.000Z",
            },
            idempotent: false,
            appliedPatchHash: "hash_1",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url) === "/api/change-reviews/review_1/discard") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({});
        return new Response(JSON.stringify({
          ok: true,
          data: {
            review: {
              id: "review_1",
              taskId: "task_1",
              roleRuntimeId: "rt_1",
              runtimeSource: "codex",
              permissionMode: "headless",
              runtimeWorkspaceStrategy: "git_worktree",
              risk: "HUMAN_REQUIRED",
              decisionState: "superseded",
              applyState: "not_applied",
              diffHash: "hash_1",
              baseRevision: "base_1",
              changedFiles: [],
              addedLines: 1,
              removedLines: 0,
              reasonCodes: ["runtime_headless"],
              sideEffectWarningCode: null,
              createdAt: "2026-05-14T00:00:00.000Z",
              updatedAt: "2026-05-14T00:03:00.000Z",
            },
            idempotent: false,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "missing" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(getTaskChangeReviews("task_1")).resolves.toHaveLength(1);
    await expect(getChangeReview("review_1")).resolves.toMatchObject({ id: "review_1", diffHash: "hash_1" });
    await expect(getChangeReviewDiff("review_1")).resolves.toMatchObject({ patch: "diff patch\n" });
    await expect(decideChangeReview("review_1", {
      decision: "approve",
      expectedDiffHash: "hash_1",
    })).resolves.toMatchObject({
      review: { decisionState: "approved" },
    });
    await expect(applyChangeReview("review_1", {
      expectedDiffHash: "hash_1",
    })).resolves.toMatchObject({
      review: { applyState: "applied" },
      appliedPatchHash: "hash_1",
    });
    await expect(discardChangeReview("review_1")).resolves.toMatchObject({
      review: { decisionState: "superseded" },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "/api/tasks/task_1/change-reviews",
      "/api/change-reviews/review_1",
      "/api/change-reviews/review_1/diff",
      "/api/change-reviews/review_1/decision",
      "/api/change-reviews/review_1/apply",
      "/api/change-reviews/review_1/discard",
    ]);
  });
});
