import { expect, type Page } from "@playwright/test";

const FIXED_TIME_ISO = "2026-04-22T10:00:00.000Z";

const MOCK_TASKS = [
  {
    id: "task-1",
    title: "Sample Task",
    state: "CREATED",
    source: "web",
    workspaceId: "workspace_main",
    updatedAt: FIXED_TIME_ISO,
    rootChannelBindingId: null,
  },
];

const MOCK_WORKSPACES = [
  {
    id: "workspace_main",
    label: "Main Workspace",
    basePath: "/opt/acme/magister",
    isDefault: true,
    createdAt: FIXED_TIME_ISO,
    updatedAt: FIXED_TIME_ISO,
  },
];

const MOCK_PROVIDERS = [
  {
    id: "provider-openai",
    label: "OpenAI",
    vendor: "openai",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    auth: {
      kind: "api_key",
      secretRef: "OPENAI_API_KEY",
    },
    readiness: {
      ready: true,
      missing: [],
    },
  },
];

const MOCK_MODELS = [
  {
    id: "gpt-5-4",
    label: "GPT-5.4",
    vendor: "openai",
    modelName: "gpt-5.4",
    providerRefs: {
      api: "provider-openai",
      cli: null,
    },
    readiness: {
      ready: true,
      missing: [],
    },
  },
];

const MOCK_BINDINGS = [
  {
    adapterId: "coder",
    executionMode: "api",
    modelRef: "gpt-5-4",
    providerRef: "provider-openai",
    timeoutMs: 60_000,
    commandPath: null,
    sandboxMode: "workspace-write",
    readiness: {
      ready: true,
      missing: [],
    },
  },
];

const MOCK_AGENTS = [
  {
    roleId: "leader",
    label: "Leader",
    description: "Orchestrates tasks",
    modelOverride: null,
    maxTurns: 60,
    isBuiltin: 1,
  },
  {
    roleId: "coder",
    label: "Coder",
    description: "Implements code changes",
    modelOverride: null,
    maxTurns: 60,
    isBuiltin: 1,
  },
  {
    roleId: "reviewer",
    label: "Reviewer",
    description: "Reviews code quality",
    modelOverride: null,
    maxTurns: 60,
    isBuiltin: 1,
  },
  {
    roleId: "architect",
    label: "Architect",
    description: "Designs system changes",
    modelOverride: null,
    maxTurns: 60,
    isBuiltin: 1,
  },
  {
    roleId: "lander",
    label: "Lander",
    description: "Prepares merge-ready changes",
    modelOverride: null,
    maxTurns: 60,
    isBuiltin: 1,
  },
];

function envelope(data: unknown) {
  return { ok: true, data };
}

function mockPayloadFor(pathname: string, method: string) {
  if (method === "GET" && pathname === "/tasks") {
    return { items: MOCK_TASKS };
  }

  if (method === "GET" && /^\/tasks\/[^/]+\/usage$/.test(pathname)) {
    const taskId = decodeURIComponent(pathname.split("/")[2] ?? "");
    return {
      taskId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      leaderInputTokens: 0,
      leaderOutputTokens: 0,
      teammateInputTokens: 0,
      teammateOutputTokens: 0,
      turnCount: 0,
      models: [],
      latestModel: null,
      latestProvider: null,
      leaderLatestModel: null,
      leaderLatestProvider: null,
      latestInputTokens: 0,
      peakInputTokens: 0,
      leaderLatestInputTokens: 0,
      leaderPeakInputTokens: 0,
      contextWindow: null,
      leaderContextWindow: null,
    };
  }

  if (method === "GET" && /^\/tasks\/[^/]+$/.test(pathname)) {
    const taskId = decodeURIComponent(pathname.slice("/tasks/".length));
    return MOCK_TASKS.find((task) => task.id === taskId) ?? MOCK_TASKS[0];
  }

  if (method === "GET" && pathname === "/workspaces") {
    return { items: MOCK_WORKSPACES };
  }

  if (method === "GET" && pathname === "/workspace/summary") {
    return {
      activeTaskCount: 1,
      blockedTaskCount: 0,
      failedRunCount: 0,
      pendingApprovalCount: 0,
      degradedAdapterCount: 0,
      taskQueue: MOCK_TASKS,
      attentionItems: [],
      recentImportantEvents: [],
    };
  }

  if (method === "GET" && pathname === "/workspace/insights") {
    return {
      recentFailures: [],
      recentPullRequests: [],
      recentMemoryCandidates: [],
      executorSlots: [],
    };
  }

  if (method === "GET" && pathname === "/system/status") {
    return {
      workers: {
        artifactRetention: {
          enabled: true,
          inFlight: false,
          intervalMs: 60_000,
          graceMs: 60_000,
          lastTickAt: FIXED_TIME_ISO,
          lastWindowStart: FIXED_TIME_ISO,
          lastScannedTaskCount: 0,
          lastEligibleTaskCount: 0,
          lastCleanedTaskIds: [],
          lastDeletedArtifactIds: [],
          lastFailedTaskIds: [],
          lastFailureAt: null,
          lastFailureTaskId: null,
          lastFailureMessage: null,
        },
        runtimeRecovery: {
          enabled: true,
          inFlight: false,
          intervalMs: 60_000,
          staleRunningThresholdMs: 120_000,
          stuckTaskThresholdMs: 120_000,
          maxAttempts: 3,
          lastTickAt: FIXED_TIME_ISO,
          lastScannedRunningCount: 0,
          lastScannedTaskCount: 0,
          lastRecoveredRunIds: [],
          lastResumedTaskIds: [],
          lastBlockedRunIds: [],
        },
      },
      integrations: {
        feishuGateway: {
          mode: "disabled",
          configured: false,
          running: false,
          connectionState: "idle",
          messageEvents: 0,
          cardActionEvents: 0,
        },
      },
    };
  }

  if (method === "GET" && pathname === "/settings/providers") {
    return MOCK_PROVIDERS;
  }

  if (method === "GET" && pathname === "/settings/vendor-presets") {
    return {};
  }

  if (method === "GET" && pathname === "/settings/models") {
    return MOCK_MODELS;
  }

  if (method === "GET" && pathname === "/settings/bindings") {
    return MOCK_BINDINGS;
  }

  if (method === "GET" && pathname === "/settings/agents") {
    return MOCK_AGENTS;
  }

  if (method === "GET" && /^\/agents\/[^/]+\/skills$/.test(pathname)) {
    return { items: [] };
  }

  if (method === "GET" && /^\/tasks\/[^/]+\/messages$/.test(pathname)) {
    return {
      messages: [],
      total: 0,
      offset: 0,
      limit: 500,
    };
  }

  return {};
}

export async function mockAppEnvironment(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly CONNECTING = MockWebSocket.CONNECTING;
      readonly OPEN = MockWebSocket.OPEN;
      readonly CLOSING = MockWebSocket.CLOSING;
      readonly CLOSED = MockWebSocket.CLOSED;
      readonly url: string;
      readonly protocol = "";
      readonly extensions = "";
      bufferedAmount = 0;
      binaryType: BinaryType = "blob";
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      sentMessages: unknown[] = [];

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        (window as unknown as { __mockWebSockets: MockWebSocket[] }).__mockWebSockets ??= [];
        (window as unknown as { __mockWebSockets: MockWebSocket[] }).__mockWebSockets.push(this);
        (window as unknown as { __lastMockWebSocket: MockWebSocket }).__lastMockWebSocket = this;

        setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        }, 0);
      }

      send(data: unknown) {
        this.sentMessages.push(data);
      }

      close(code = 1000, reason = "") {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSING;
        this.readyState = MockWebSocket.CLOSED;
        const event = new CloseEvent("close", { code, reason, wasClean: true });
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }

    (window as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/^\/api/, "");
    const data = mockPayloadFor(pathname, request.method());

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(envelope(data)),
    });
  });
}

export function createConsoleErrorTracker(page: Page) {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });

  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  return {
    checkpoint() {
      return errors.length;
    },
    expectNoNewErrors(since: number, label: string) {
      const freshErrors = errors.slice(since);
      expect(
        freshErrors,
        `${label} emitted console errors:\n${freshErrors.join("\n")}`,
      ).toEqual([]);
    },
  };
}
