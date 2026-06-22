import "../../test-setup";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

// Mock useWebSocket to capture the onEvent handler without opening
// a real WS connection. The shape of `lastOnEvent` lets each test
// trigger a synthetic `approval.*` event and observe the re-fetch.
type WSEvent = {
  type: string;
  taskId: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: string;
};
let lastOnEvent: ((event: WSEvent) => void) | null = null;
mock.module("../../hooks/useWebSocket", () => ({
  useWebSocket: (opts: { onEvent: (event: WSEvent) => void }) => {
    lastOnEvent = opts.onEvent;
    return { subscribe: () => {} };
  },
}));

// Importing after the mock is registered ensures the component
// resolution picks up the stubbed module.
import { ApprovalBell } from "./ApprovalBell";

const originalFetch = globalThis.fetch;

type ApprovalRow = {
  id: string;
  taskId: string;
  toolName: string;
  summary?: string;
  status: "pending";
  createdAt: number;
  // Spec §1 V1.1 — escalation metadata that triggers the "+ save rule" button
  toolArgs?: {
    command?: string;
    escalation?: {
      sandbox_permissions?: string;
      justification?: string;
      proposed_prefix_rule?: string[];
      proposed_scope?: string;
      project_path?: string;
    };
  };
};

type FetchCall = { url: string; method: string; body?: string | null };

type FetchPlan = {
  pending: ApprovalRow[];
  // map of `${id}::${kind}` → ordered list of statuses to return; once
  // exhausted, returns 200.
  resolveStatuses: Map<string, number[]>;
  fallbackResolveStatus: number;
};

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFoundResponse() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "not_found", message: "not_found" },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

function installFetchStub(plan: FetchPlan, record: FetchCall[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    record.push({ url, method, body: (init?.body as string | null) ?? null });

    if (url === "/api/approvals/pending") {
      return apiResponse({ items: plan.pending });
    }
    // Approve / reject (db path)
    const approveMatch = url.match(
      /^\/api\/approvals\/([^/]+)\/(approve|reject)$/,
    );
    if (approveMatch) {
      const key = `${approveMatch[1]}::${approveMatch[2]}`;
      const queue = plan.resolveStatuses.get(key);
      const status = queue?.shift() ?? 200;
      if (status === 404) return notFoundResponse();
      return apiResponse({ ok: true }, status);
    }
    // Fallback /resolve (in-memory command-gate path)
    if (/^\/api\/approvals\/[^/]+\/resolve$/.test(url)) {
      if (plan.fallbackResolveStatus === 404) return notFoundResponse();
      return apiResponse({ ok: true }, plan.fallbackResolveStatus);
    }

    return apiResponse({});
  }) as unknown as typeof fetch;
}

function makeApproval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr_1",
    taskId: "task-mp7qdz5q-er143r",
    toolName: "bash",
    summary: "rm -rf node_modules",
    status: "pending",
    createdAt: 0,
    ...overrides,
  };
}

describe("ApprovalBell", () => {
  let calls: FetchCall[] = [];
  let plan: FetchPlan;

  beforeEach(() => {
    calls = [];
    plan = {
      pending: [],
      resolveStatuses: new Map(),
      fallbackResolveStatus: 200,
    };
    installFetchStub(plan, calls);
    lastOnEvent = null;
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
  });

  test("renders quiet command-approval button when there are no approvals", async () => {
    plan.pending = [];
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      expect(
        calls.some((c) => c.url === "/api/approvals/pending"),
      ).toBe(true);
    });

    const btn = view.getByRole("button", { name: /No command approvals pending/i });
    expect(btn).toBeTruthy();
    expect(view.container.querySelector(".magister-approval-bell__badge")).toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("No command approvals pending");

    fireEvent.click(btn);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.queryByText(/No pending approvals/i)).toBeNull();
  });

  test("badge renders the count and aria-label reflects it", async () => {
    plan.pending = [
      makeApproval({ id: "a1" }),
      makeApproval({ id: "a2" }),
    ];
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      const badge = view.container.querySelector(
        ".magister-approval-bell__badge",
      );
      expect(badge).toBeTruthy();
      expect(badge!.textContent).toBe("2");
    });
    const btn = view.getByRole("button", { name: /Command approvals/i });
    expect(btn.getAttribute("aria-label")).toBe("Command approvals (2 pending)");
  });

  test("clicking the bell opens a dropdown listing each pending approval", async () => {
    plan.pending = [
      makeApproval({ id: "a1", toolName: "bash", summary: "delete dir" }),
      makeApproval({ id: "a2", toolName: "write_file", summary: "edit config" }),
    ];
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      const badge = view.container.querySelector(".magister-approval-bell__badge");
      expect(badge).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));

    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /Command approvals/i })).toBeTruthy();
    });

    expect(view.getByText("delete dir")).toBeTruthy();
    expect(view.getByText("edit config")).toBeTruthy();
  });

  test("approve hits /approve and optimistically removes the row", async () => {
    plan.pending = [makeApproval({ id: "a1" })];
    plan.resolveStatuses.set("a1::approve", [200]);
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      expect(view.container.querySelector(".magister-approval-bell__badge")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() => {
      expect(view.getByRole("button", { name: /^Approve once$/i })).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /^Approve once$/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/approvals/a1/approve" && c.method === "POST",
      );
      expect(post).toBeTruthy();
    });
    // Optimistic removal — list is now empty.
    await waitFor(() => {
      expect(view.queryByRole("button", { name: /^Approve once$/i })).toBeNull();
    });
  });

  test("approve falls back to /resolve when /approve returns 404", async () => {
    plan.pending = [makeApproval({ id: "a1" })];
    plan.resolveStatuses.set("a1::approve", [404]);
    plan.fallbackResolveStatus = 200;
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      expect(view.container.querySelector(".magister-approval-bell__badge")).toBeTruthy();
    });
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /^Approve once$/i })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole("button", { name: /^Approve once$/i }));

    await waitFor(() => {
      const approve = calls.find(
        (c) => c.url === "/api/approvals/a1/approve" && c.method === "POST",
      );
      const resolve = calls.find(
        (c) => c.url === "/api/approvals/a1/resolve" && c.method === "POST",
      );
      expect(approve).toBeTruthy();
      expect(resolve).toBeTruthy();
      const body = JSON.parse(resolve!.body ?? "{}");
      expect(body.decision).toBe("approved");
    });
  });

  test("reject falls back to /resolve when /reject returns 404", async () => {
    plan.pending = [makeApproval({ id: "a1" })];
    plan.resolveStatuses.set("a1::reject", [404]);
    plan.fallbackResolveStatus = 200;
    const view = render(<ApprovalBell />);

    await waitFor(() =>
      expect(
        view.container.querySelector(".magister-approval-bell__badge"),
      ).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Reject/i })).toBeTruthy(),
    );

    fireEvent.click(view.getByRole("button", { name: /Reject/i }));

    await waitFor(() => {
      const reject = calls.find(
        (c) => c.url === "/api/approvals/a1/reject" && c.method === "POST",
      );
      const resolve = calls.find(
        (c) => c.url === "/api/approvals/a1/resolve" && c.method === "POST",
      );
      expect(reject).toBeTruthy();
      expect(resolve).toBeTruthy();
      const body = JSON.parse(resolve!.body ?? "{}");
      expect(body.decision).toBe("rejected");
    });
  });

  test("WS approval.* event triggers a re-fetch of the pending list", async () => {
    plan.pending = [];
    const view = render(<ApprovalBell />);

    await waitFor(() => {
      expect(
        calls.filter((c) => c.url === "/api/approvals/pending").length,
      ).toBeGreaterThanOrEqual(1);
    });

    const beforeCount = calls.filter(
      (c) => c.url === "/api/approvals/pending",
    ).length;

    // Simulate WS approval event; ApprovalBell should refetch.
    plan.pending = [makeApproval({ id: "a1" })];
    expect(lastOnEvent).toBeTruthy();
    act(() => {
      lastOnEvent!({
        type: "approval.created",
        taskId: "task_x",
        data: {},
        seq: 1,
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      const after = calls.filter(
        (c) => c.url === "/api/approvals/pending",
      ).length;
      expect(after).toBeGreaterThan(beforeCount);
    });
    await waitFor(() => {
      expect(
        view.container.querySelector(".magister-approval-bell__badge"),
      ).toBeTruthy();
    });
  });

  test("Escape closes the dropdown", async () => {
    plan.pending = [makeApproval({ id: "a1" })];
    const view = render(<ApprovalBell />);

    await waitFor(() =>
      expect(
        view.container.querySelector(".magister-approval-bell__badge"),
      ).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.queryByRole("dialog")).toBeTruthy(),
    );

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
  });

  test("load() failure pushes one error toast (suppresses further toasts within cooldown)", async () => {
    // Stub fetch so /approvals/pending throws — simulates backend
    // outage. The first failed poll should push exactly one toast; a
    // second failed poll within the cooldown should NOT push another.
    const { useToastStore } = await import("../../stores/toastStore");
    useToastStore.setState({ toasts: [] });

    let pollCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/approvals/pending") {
        pollCount++;
        throw new Error("network down");
      }
      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(<ApprovalBell />);

    // Wait for the first poll to attempt + fail + push the toast.
    await waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(useToastStore.getState().toasts.length).toBe(1);
    });
    const firstToast = useToastStore.getState().toasts[0]!;
    expect(firstToast.kind).toBe("error");
    expect(firstToast.title).toBe("Failed to refresh approvals");
    // `request()` wraps network errors with a generic Chinese message;
    // we just assert a non-empty body landed (specific text is the
    // request helper's concern, not the bell's).
    expect((firstToast.body ?? "").length).toBeGreaterThan(0);

    // Trigger a second failure via WS event. The component should NOT
    // push a second toast (cooldown active).
    expect(lastOnEvent).toBeTruthy();
    act(() => {
      lastOnEvent!({
        type: "approval.created",
        taskId: "task_x",
        data: {},
        seq: 1,
        timestamp: new Date().toISOString(),
      });
    });
    await waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });
    // Still only 1 toast — cooldown silenced the second.
    expect(useToastStore.getState().toasts.length).toBe(1);

    view.unmount();
  });

  // Spec §1 V1.1 — escalation approval with proposed_prefix_rule
  // surfaces a 3rd "Approve + save rule" button. Click → POST
  // /approvals/:id/resolve { decision: "approved", save_rule: true }.
  test("escalation approval shows + save rule button; click posts save_rule:true to /resolve", async () => {
    plan.pending = [
      makeApproval({
        id: "esc_1",
        summary: "npm install",
        toolArgs: {
          command: "npm install",
          escalation: {
            sandbox_permissions: "require_escalated",
            justification: "install dependencies before running tests",
            proposed_prefix_rule: ["npm", "install"],
            proposed_scope: "project",
            project_path: "/repo",
          },
        },
      }),
    ];
    const view = render(<ApprovalBell />);

    await waitFor(() =>
      expect(view.container.querySelector(".magister-approval-bell__badge")).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /Approve \+ save rule/i })).toBeTruthy(),
    );

    // Prefix preview rendered in the escalation block.
    const prefixCode = view.container.querySelector(".magister-approval-bell__escalation-prefix");
    expect(prefixCode?.textContent).toBe("npm install");
    const scopeSpan = view.container.querySelector(".magister-approval-bell__escalation-scope");
    expect(scopeSpan?.textContent).toBe("(project)");

    // Click the new split button.
    fireEvent.click(view.getByRole("button", { name: /Approve \+ save rule/i }));

    await waitFor(() => {
      const resolve = calls.find(
        (c) => c.url === "/api/approvals/esc_1/resolve" && c.method === "POST",
      );
      expect(resolve).toBeTruthy();
      const body = JSON.parse(resolve!.body ?? "{}");
      expect(body).toEqual({ decision: "approved", save_rule: true });
    });
    // Verify the DB-approval endpoint was NOT hit (we route the save_rule
    // variant exclusively through /resolve since save_rule is a command-
    // approval-service feature).
    const dbApprove = calls.find(
      (c) => c.url === "/api/approvals/esc_1/approve" && c.method === "POST",
    );
    expect(dbApprove).toBeFalsy();
  });

  test("non-escalation approval does NOT render the + save rule button", async () => {
    plan.pending = [makeApproval({ id: "plain_1" })];
    const view = render(<ApprovalBell />);

    await waitFor(() =>
      expect(view.container.querySelector(".magister-approval-bell__badge")).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: /^Approve once$/i })).toBeTruthy(),
    );

    expect(view.queryByRole("button", { name: /Approve \+ save rule/i })).toBeNull();
  });

  test("outside mousedown closes the dropdown", async () => {
    plan.pending = [makeApproval({ id: "a1" })];
    const view = render(<ApprovalBell />);

    await waitFor(() =>
      expect(
        view.container.querySelector(".magister-approval-bell__badge"),
      ).toBeTruthy(),
    );
    fireEvent.click(view.getByRole("button", { name: /Command approvals/i }));
    await waitFor(() =>
      expect(view.queryByRole("dialog")).toBeTruthy(),
    );

    // Outside click. Listener is attached to `document`, so a mousedown
    // dispatched at document with a non-popover target counts as outside.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    act(() => {
      fireEvent.mouseDown(outside);
    });

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
  });
});
