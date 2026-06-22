import "../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./DashboardPage";

const originalFetch = globalThis.fetch;

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type DashboardFetchStubOptions = {
  agents?: Array<{
    roleId: string;
    status: string | null;
    lastHeartbeatAt: number | null;
    modelName: string | null;
  }>;
  heartbeats?: Array<{
    roleId: string;
    label: string | null;
    lastSeenAt: number | null;
    secondsAgo: number | null;
    isLive: boolean;
  }>;
  feishuGateway?: Record<string, unknown>;
};

function installDashboardFetchStub(options: DashboardFetchStubOptions = {}) {
  const agents = options.agents ?? [
    {
      roleId: "leader",
      status: "idle",
      lastHeartbeatAt: null,
      modelName: "kimi-k2.6",
    },
    {
      roleId: "coder",
      status: "idle",
      lastHeartbeatAt: null,
      modelName: "gpt-5.5",
    },
  ];
  const heartbeats = options.heartbeats ?? [];

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
    if (url === "/api/settings/agents/statuses") {
      return apiResponse({
        items: agents,
      });
    }
    if (url === "/api/agents/heartbeats") {
      return apiResponse({ items: heartbeats });
    }
    if (url === "/api/approvals/pending") {
      return apiResponse({ items: [] });
    }
    if (url.startsWith("/api/tasks?")) {
      return apiResponse({ items: [] });
    }
    if (url === "/api/system/status") {
      return apiResponse({
        workers: {
          artifactRetention: { enabled: true },
          runtimeRecovery: { enabled: true },
          taskWorker: { enabled: true },
        },
        integrations: {
          feishuGateway: {
            disabled: false,
            configured: true,
            mode: "websocket",
            running: true,
            connectionState: "running",
            ...options.feishuGateway,
          },
        },
      });
    }
    return apiResponse({});
  }) as unknown as typeof fetch;
}

describe("DashboardPage information architecture", () => {
  beforeEach(() => {
    installDashboardFetchStub();
  });

  afterEach(() => {
    // 2026-05-19: previously this only restored fetch; the rendered
    // DOM from prior tests stacked in the document body. When the
    // "separates agent configuration" test queried `getByText("READY")`
    // it found 3 READY chips — one per accumulated render across the
    // 3 tests in this file. `cleanup()` unmounts and removes prior
    // renders. Was masked when running this file alone because the
    // bisected execution order happened to put this test first.
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("does not show a static agent orchestra on the control center", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main"]}>
        <Routes>
          <Route path="/w/:wid" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // Agents Available cell renders the big numeric value as "2".
      // The cell sub-line lists the role names (`Leader · Coder`) and
      // the Agent Pool card renders each agent's model name.
      const strip = view.getByLabelText("System status bar");
      const valueCells = strip.querySelectorAll(".dashboard-status-strip__value");
      const numericValues = Array.from(valueCells).map((el) => el.textContent?.trim());
      expect(numericValues.some((v) => v?.startsWith("2"))).toBe(true);
      expect(view.getByText("gpt-5.5")).toBeTruthy();
    });

    const systemStatusBar = view.getByLabelText("System status bar");
    expect(systemStatusBar.classList.contains("status-bar")).toBe(false);
    expect(systemStatusBar.classList.contains("dashboard-status-strip")).toBe(true);
    expect(view.queryByText("Agent Orchestra")).toBeNull();
    expect(view.queryByLabelText("Agent orchestra")).toBeNull();
    expect(view.getByText("Agent Pool")).toBeTruthy();
  });

  test("separates agent configuration and activity states", async () => {
    installDashboardFetchStub({
      agents: [
        {
          roleId: "coder",
          status: "idle",
          lastHeartbeatAt: null,
          modelName: "gpt-5.5",
        },
        {
          roleId: "deepresearcher",
          status: "idle",
          lastHeartbeatAt: null,
          modelName: null,
        },
      ],
    });

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main"]}>
        <Routes>
          <Route path="/w/:wid" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("READY")).toBeTruthy();
      expect(view.getByText("CONFIG")).toBeTruthy();
      expect(view.getByText("never run")).toBeTruthy();
      expect(view.getByText("Model unavailable")).toBeTruthy();
    });
    expect(view.queryByText("IDLE")).toBeNull();
    expect(view.getByText(/2 profiles · 0 seen · 1 config issue · polls 5s/)).toBeTruthy();
  });

  test("marks old heartbeat activity as stale instead of idle", async () => {
    const tenHoursAgo = Date.now() - 10 * 60 * 60 * 1000;
    installDashboardFetchStub({
      agents: [
        {
          roleId: "leader",
          status: "idle",
          lastHeartbeatAt: tenHoursAgo,
          modelName: "kimi-k2.6",
        },
      ],
    });

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main"]}>
        <Routes>
          <Route path="/w/:wid" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("STALE")).toBeTruthy();
      expect(view.getByText(/last active 10h ago/)).toBeTruthy();
      expect(view.getByText(/1 profiles · 1 seen · polls 5s/)).toBeTruthy();
    });
    expect(view.queryByText("IDLE")).toBeNull();
  });

  test("shows disabled Feishu as intentional channel shutdown", async () => {
    installDashboardFetchStub({
      feishuGateway: {
        disabled: true,
        configured: false,
        running: false,
        connectionState: "stopped",
      },
    });

    const view = render(
      <MemoryRouter initialEntries={["/w/workspace_main"]}>
        <Routes>
          <Route path="/w/:wid" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("Disabled")).toBeTruthy();
      expect(view.getByText("Disabled by MAGISTER_DISABLE_CHANNELS")).toBeTruthy();
      expect(view.getByText(/feishu disabled/)).toBeTruthy();
    });
    expect(view.queryByText("Not configured")).toBeNull();
  });
});
