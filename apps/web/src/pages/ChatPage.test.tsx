import "../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ChatPage, sessionDisplayState, stateBucket, workbenchNarrativeContent } from "./ChatPage";
import { useChatStore } from "../stores/chatStore";
import { useTaskStore } from "../stores/taskStore";

const originalFetch = globalThis.fetch;
const originalFetchTasks = useTaskStore.getState().fetchTasks;
const originalWindowSetInterval = window.setInterval;
const originalWindowClearInterval = window.clearInterval;

let taskSessionUsageCalls = 0;
let taskSessionUsageResponses: unknown[] = [];
let chatPageChangeReviews: unknown[] = [];

function usageResponse(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task_session",
    totalInputTokens: 2500,
    totalOutputTokens: 500,
    leaderInputTokens: 1900,
    leaderOutputTokens: 300,
    teammateInputTokens: 600,
    teammateOutputTokens: 200,
    turnCount: 2,
    models: ["gpt-5.5"],
    latestModel: "gpt-5.5",
    latestProvider: "openai",
    leaderLatestModel: "gpt-5.5",
    leaderLatestProvider: "openai",
    latestInputTokens: 2000,
    peakInputTokens: 2500,
    leaderLatestInputTokens: 2000,
    leaderPeakInputTokens: 2500,
    usageSplitKnown: true,
    contextWindow: 200000,
    leaderContextWindow: 200000,
    ...overrides,
  };
}

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installChatPageFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/workspaces")) {
      return apiResponse({
        items: [
          {
            id: "workspace_main",
            label: "Main",
            basePath: "/repo",
            isDefault: true,
            createdAt: "2026-05-13T00:00:00.000Z",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
      });
    }
    if (url.startsWith("/api/tasks/task_session/messages")) {
      return apiResponse({ messages: [], total: 0, offset: 0, limit: 120 });
    }
    if (url === "/api/tasks/task_session/usage") {
      taskSessionUsageCalls += 1;
      return apiResponse(
        taskSessionUsageResponses[
          Math.min(taskSessionUsageCalls - 1, taskSessionUsageResponses.length - 1)
        ] ?? usageResponse(),
      );
    }
    if (url === "/api/tasks/task_session/change-reviews") {
      return apiResponse({ reviews: chatPageChangeReviews });
    }
    if (url === "/api/tasks/task_session") {
      return apiResponse({
        id: "task_session",
        title: "Session without trace",
        state: "DONE",
        source: "web",
        workspaceId: "workspace_main",
        updatedAt: "2026-05-13T00:00:00.000Z",
      });
    }
    if (url.startsWith("/api/tasks?")) {
      return apiResponse({
        items: [
          {
            id: "task_session",
            title: "Session without trace",
            state: "DONE",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
      });
    }
    return apiResponse({});
  }) as unknown as typeof fetch;
}

function chatPageReviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "review_1",
    taskId: "task_session",
    roleRuntimeId: "rt_1",
    runtimeSource: "codex",
    permissionMode: "headless",
    runtimeWorkspaceStrategy: "git_worktree",
    risk: "HUMAN_REQUIRED",
    decisionState: "approved",
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

function installMatchMedia(matches = false) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("stateBucket", () => {
  // Canonical TASK_STATES from packages/core/src/domain/task.ts.
  // Keep this matrix in sync if states are added or removed.
  test("DONE / PR_OPEN / MERGE_WAITING bucket as 'done'", () => {
    expect(stateBucket("DONE")).toBe("done");
    expect(stateBucket("PR_OPEN")).toBe("done");
    expect(stateBucket("MERGE_WAITING")).toBe("done");
  });

  test("FAILED buckets as 'failed'", () => {
    expect(stateBucket("FAILED")).toBe("failed");
  });

  test("active lifecycle states bucket as 'running'", () => {
    for (const s of ["INTAKE", "CLARIFYING", "PLANNING", "EXECUTING", "REVIEWING", "TESTING", "QUEUED", "IN_PROGRESS"]) {
      expect(stateBucket(s)).toBe("running");
    }
  });

  test("waiting lifecycle states bucket as 'waiting'", () => {
    for (const s of ["WAITING", "PAUSED", "AWAITING_APPROVAL"]) {
      expect(stateBucket(s)).toBe("waiting");
    }
  });

  // Substring fallback for legacy / non-canonical states that may show
  // up in older DB rows or external systems.
  test("legacy lowercase fallback", () => {
    expect(stateBucket("done")).toBe("done");
    expect(stateBucket("completed")).toBe("done");
    expect(stateBucket("failed")).toBe("failed");
    expect(stateBucket("error")).toBe("failed");
    expect(stateBucket("blocked")).toBe("blocked");
    expect(stateBucket("cancelled")).toBe("failed");
    expect(stateBucket("running")).toBe("running");
    expect(stateBucket("in_progress")).toBe("running");
    expect(stateBucket("queued")).toBe("running");
    expect(stateBucket("pending")).toBe("running");
  });

  test("unknown state falls through to 'all'", () => {
    expect(stateBucket("MYSTERY")).toBe("all");
    expect(stateBucket("")).toBe("all");
  });

  test("trims whitespace before matching", () => {
    expect(stateBucket("  DONE  ")).toBe("done");
  });
});

describe("sessionDisplayState", () => {
  const baseTask = {
    id: "task_display_state",
    title: "Display state",
    state: "EXECUTING",
    updatedAt: "2026-05-12T08:00:00.000Z",
    workspaceId: "workspace_main",
  };

  test("distinguishes running, waiting, recovered, and blocked session states", () => {
    expect(sessionDisplayState(baseTask)).toMatchObject({
      bucket: "running",
      label: "EXECUTING",
    });

    expect(sessionDisplayState({
      ...baseTask,
      state: "WAITING",
      waitReason: "approval",
    })).toMatchObject({
      bucket: "waiting",
      label: "Waiting",
    });

    expect(sessionDisplayState({
      ...baseTask,
      recoveryNotice: {
        status: "recovered",
        occurredAt: "2026-05-12T08:01:00.000Z",
        reason: "runtime_recovery_stale_running",
        previousState: "RUNNING",
        nextState: "IN_PROGRESS",
        requiresUserAction: false,
        runId: "rt_recovered",
      },
    })).toMatchObject({
      bucket: "recovered",
      label: "Recovered",
    });

    expect(sessionDisplayState({
      ...baseTask,
      state: "BLOCKED",
      recoveryNotice: {
        status: "blocked",
        occurredAt: "2026-05-12T08:02:00.000Z",
        reason: "runtime_recovery_exhausted",
        previousState: "RUNNING",
        nextState: "BLOCKED",
        requiresUserAction: true,
        runId: "rt_blocked",
      },
    })).toMatchObject({
      bucket: "blocked",
      label: "Blocked",
    });
  });

  test("uses the shared blocked narrative for session-list labels and titles", () => {
    expect(sessionDisplayState({
      ...baseTask,
      blockedNarrative: {
        reason: "awaiting_plan_approval",
        status: "waiting",
        severity: "warn",
        message: "Waiting for plan approval.",
        nextAction: "Approve, revise, or cancel the proposed plan.",
        occurredAt: "2026-05-12T08:04:00.000Z",
        source: "leader.plan_proposed",
      },
    } as any)).toMatchObject({
      bucket: "waiting",
      label: "Plan approval",
      title: "Waiting for plan approval. Approve, revise, or cancel the proposed plan.",
    });
  });
});

describe("workbenchNarrativeContent", () => {
  const awaitingApproval = {
    status: "waiting",
    reason: "awaiting_approval",
    severity: "warn",
    message: "Waiting for a human approval.",
    nextAction: "Review the pending approval request.",
    occurredAt: "2026-05-12T08:05:00.000Z",
    source: "change_review",
  } as const;

  test("keeps awaiting approval copy generic when change reviews need action", () => {
    expect(workbenchNarrativeContent(awaitingApproval, 2)).toEqual({
      label: "Approval",
      message: "Waiting for a human approval.",
      nextAction: "Review the pending approval request.",
    });
  });

  test("keeps the original approval copy when no change review actions exist", () => {
    expect(workbenchNarrativeContent(awaitingApproval, 0)).toEqual({
      label: "Approval",
      message: "Waiting for a human approval.",
      nextAction: "Review the pending approval request.",
    });
  });
});

describe("ChatPage information architecture", () => {
  beforeEach(() => {
    installMatchMedia(false);
    installChatPageFetchStub();
    taskSessionUsageCalls = 0;
    taskSessionUsageResponses = [];
    chatPageChangeReviews = [];
    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_session",
            title: "Session without trace",
            state: "DONE",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
        loading: false,
        error: null,
        isWaitingForResponse: false,
        chatRefreshCounter: 0,
        fetchTasks: async () => {},
      });
      useChatStore.getState().resetForTests();
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    window.setInterval = originalWindowSetInterval;
    window.clearInterval = originalWindowClearInterval;
    act(() => {
      useTaskStore.setState({
        tasks: [],
        loading: false,
        error: null,
        isWaitingForResponse: false,
        chatRefreshCounter: 0,
        fetchTasks: originalFetchTasks,
      });
      useChatStore.getState().resetForTests();
    });
  });

  test("keeps execution trace out of the session page", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_session"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getAllByText("Session without trace").length).toBeGreaterThan(0);
    });

    expect(Boolean(view.queryByLabelText("Trace panel"))).toBe(false);
    expect(Boolean(view.queryByLabelText("Open trace panel"))).toBe(false);
    expect(view.queryByText("Events")).toBeNull();
  });

  test("shows selected session workspace and token context in the session panel footer", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_session"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("Session Context")).toBeTruthy();
    });

    expect(view.getByText("Task ID")).toBeTruthy();
    expect(view.getByText("task_session")).toBeTruthy();
    // "Main" appears twice — once in the sessions-panel workspace pill
    // (added 2026-05-22), once in this Session Context row. Disambig
    // by scope to the latter.
    expect(view.getAllByText("Main").length).toBeGreaterThanOrEqual(1);
    expect(view.getByText("/repo")).toBeTruthy();
    expect(view.getByText("3.0K total")).toBeTruthy();
    expect(view.getByText("Leader 2.2K · Team 800")).toBeTruthy();
    // Context bar shows leader PEAK input (2500), not the volatile latest (2000).
    expect(view.getByText("2.5K / 200K")).toBeTruthy();
    expect(view.getByText("2 turns")).toBeTruthy();
    expect(view.getByText("gpt-5.5")).toBeTruthy();
    // 2026-05-19: Cost row removed from Session Context per user
    // feedback ("我们不计算 cost") — Magister doesn't price tokens.
    // Verify the row is GONE so a future revert is caught.
    expect(view.queryByText("Cost")).toBeNull();
    // The negative assertions for /input/ and /output/ — still valid
    // (we don't show separate input/output breakdown in this panel).
    expect(view.queryByText(/input/i)).toBeNull();
    expect(view.queryByText(/output/i)).toBeNull();
  });

  test("hides leader/team breakdown when legacy usage split is unknown", async () => {
    taskSessionUsageResponses = [
      usageResponse({
        totalInputTokens: 2500,
        totalOutputTokens: 500,
        leaderInputTokens: 2500,
        leaderOutputTokens: 500,
        teammateInputTokens: 0,
        teammateOutputTokens: 0,
        usageSplitKnown: false,
      }),
    ];

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_session"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("3.0K total")).toBeTruthy();
    });

    expect(Boolean(view.queryByText(/Leader .* Team/))).toBe(false);
  });

  test("polls selected non-terminal session usage every 5 seconds while visible", async () => {
    taskSessionUsageResponses = [
      usageResponse(),
      usageResponse({
        totalInputTokens: 3500,
        totalOutputTokens: 500,
        latestInputTokens: 3000,
        leaderLatestInputTokens: 3000,
        // Peak grows with context (peak >= latest always); the bar reads peak.
        peakInputTokens: 3000,
        leaderPeakInputTokens: 3000,
      }),
    ];
    const intervals: Array<{ handler: TimerHandler; delay: number | undefined }> = [];
    window.setInterval = ((handler: TimerHandler, delay?: number) => {
      intervals.push({ handler, delay });
      return intervals.length;
    }) as typeof window.setInterval;
    window.clearInterval = (() => {}) as typeof window.clearInterval;

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_session",
            title: "Session without trace",
            state: "EXECUTING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
      });
    });

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_session"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(taskSessionUsageCalls).toBe(1);
    });
    const usagePollIdx = intervals.findIndex((i) => i.delay === 5000);
    expect(usagePollIdx).toBeGreaterThanOrEqual(0);

    await act(async () => {
      const handler = intervals[usagePollIdx]?.handler;
      if (typeof handler === "function") handler();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(taskSessionUsageCalls).toBe(2);
      expect(view.getByText("4.0K total")).toBeTruthy();
      expect(view.getByText("3.0K / 200K")).toBeTruthy();
    });
  });

  test("does not render a duplicate top review narrative when the review bar has actionable work", async () => {
    chatPageChangeReviews = [chatPageReviewSummary()];
    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_session",
            title: "Session with review",
            state: "EXECUTING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-05-13T00:00:00.000Z",
            blockedNarrative: {
              status: "waiting",
              reason: "awaiting_approval",
              severity: "warn",
              message: "Waiting for a human approval.",
              nextAction: "Review the pending approval request.",
              occurredAt: "2026-05-13T00:00:00.000Z",
              source: "change_review",
            },
          },
        ],
      });
    });

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main/sessions/task_session"]}>
        <Routes>
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByLabelText("Patch Reviews")).toBeTruthy();
      expect(view.getByText("1 patch review needs action")).toBeTruthy();
    });

    expect(view.container.querySelector(".chat-workbench-narrative")).toBeNull();
    expect(view.queryByText("Use the review bar above the composer.")).toBeNull();
  });
});
