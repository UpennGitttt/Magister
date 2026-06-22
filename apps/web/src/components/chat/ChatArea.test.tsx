import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ChatArea, sliceToRecentTurns } from "./ChatArea";
import { useChatStore } from "../../stores/chatStore";
import { useTaskStore } from "../../stores/taskStore";

// Track scrollIntoView calls so auto-scroll regressions are observable.
// Tests reset the count in beforeEach.
let scrollIntoViewCalls = 0;
Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => { scrollIntoViewCalls += 1; },
});

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

class ControllableEventSource {
  static instances: ControllableEventSource[] = [];

  readonly url: string;
  closeCount = 0;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    ControllableEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() { this.closeCount += 1; }

  emit(type: string, data: unknown = {}) {
    const event = { data: JSON.stringify(data), lastEventId: "" } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

// ChatArea reads the selected task id from the URL via `useSelectedTaskId`
// (which calls `useParams`). Tests must mount it inside a Router whose route
// shape matches `/sessions/:taskId`, otherwise the param is undefined.
function renderChatArea(taskId: string | null) {
  const path = taskId ? `/sessions/${taskId}` : "/sessions";
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions" element={<ChatArea />} />
        <Route path="/sessions/:taskId" element={<ChatArea />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatArea", () => {
  beforeEach(() => {
    scrollIntoViewCalls = 0;
    act(() => {
      useTaskStore.setState({
        tasks: [],
        loading: false,
        error: null,
        isWaitingForResponse: false,
        chatRefreshCounter: 0,
      });
      useChatStore.getState().resetForTests();
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    ControllableEventSource.instances = [];
  });

  test("renders messages fetched from the paginated API", async () => {
    const requestedUrls: string[] = [];
    const apiResponse = {
      ok: true,
      data: {
        messages: [
          { type: "user", content: "Hello" },
          { type: "assistant", content: [{ type: "text", text: "World" }] },
        ],
        total: 2,
        offset: 0,
        limit: 200,
      },
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(apiResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_123",
            title: "Investigate flicker",
            state: "RUNNING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        ],
      });
    });

    const view = renderChatArea("task_123");

    await waitFor(() => {
      expect(view.queryByText("Start a new conversation")).toBeNull();
      expect(view.getByText("Investigate flicker")).toBeTruthy();
      expect(view.getByText("Hello")).toBeTruthy();
      expect(view.getByText("World")).toBeTruthy();
    });
    expect(requestedUrls.some((url) => url.includes("/tasks/task_123/messages?tail=true&limit=120"))).toBe(true);
    expect(ControllableEventSource.instances.at(-1)?.url).toBe("/api/tasks/task_123/stream?light=true");
  });

  test("does not treat an EventSource error as terminal while the task is still active", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: { messages: [], total: 0, offset: 0, limit: 500 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_error",
            title: "Active stream",
            state: "RUNNING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        ],
        isWaitingForResponse: true,
      });
    });

    renderChatArea("task_error");

    await waitFor(() => {
      expect(ControllableEventSource.instances.length).toBeGreaterThan(0);
    });
    const stream = ControllableEventSource.instances.at(-1)!;

    act(() => {
      stream.onerror?.();
    });

    expect(useTaskStore.getState().isWaitingForResponse).toBe(true);
  });

  // Removed in PR 3.3: this test exercised the legacy `streamingTextBuffer`
  // module singleton + setMessages(prev) reconciliation in ChatArea, which
  // are gone after the chatStore cutover. The equivalent behavior — text
  // delta dedup against stale snapshots — is unit-tested at the projector
  // level (`projector.test.ts > regression: 8 fixed bugs > [b83f191]
  // reconnect snapshot replay produces identical state` plus the
  // dedup-by-(requestId, seq) tests in `chatStore.test.ts`).

  // Regression — fix(chat) commit 0c9842c:
  // After PR 3.3 the first message of a new conversation rendered as
  // "Loading messages..." (or empty) until either /messages returned or
  // SSE delivered the first event, because `isModern` was gated on
  // `hasModernEvents` (lastAppliedSeq > 0) and the Loading guard short-
  // circuited render based on `messages.length === 0`. This test pins
  // the contract: when chatStore has an exchange (even a pure-optimistic
  // one with no events applied yet), ChatArea must render the user
  // bubble immediately and never show Loading.
  test("fresh send: optimistic exchange in chatStore renders without Loading flash", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, data: { messages: [], total: 0, offset: 0, limit: 500 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    // Mirror what ChatInput does on Enter: park optimistic in `_pending:*`,
    // then atomically migrate to the real taskId after createTask returns.
    act(() => {
      const localId = useChatStore.getState().beginExchange(null, "fresh prompt");
      useChatStore.getState().bindRequestId(localId, "task_fresh", "req_fresh");
      useTaskStore.setState({ isWaitingForResponse: true });
    });

    const view = renderChatArea("task_fresh");

    // The user bubble must be visible at first paint — never gated behind
    // the /messages round-trip.
    await waitFor(() => {
      expect(view.getByText("fresh prompt")).toBeTruthy();
    });
    expect(view.queryByText("Loading messages...")).toBeNull();
  });

  // Regression — Codex blocker 1 (kept-fix in PR 3.3 d262b4f):
  // ChatArea's SSE useEffect must NOT close the EventSource on
  // `task:completed` / `task:failed` / `leader.session_complete`.
  // Doing so used to kill the stream for the next turn, since the
  // [selectedTaskId] effect doesn't remount on a same-task follow-up.
  test("SSE stream stays open across task:completed (same-task follow-up)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, data: { messages: [], total: 0, offset: 0, limit: 500 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_followup",
            title: "Long-lived stream",
            state: "RUNNING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-04-25T12:00:00.000Z",
          },
        ],
      });
    });

    renderChatArea("task_followup");

    await waitFor(() => {
      expect(ControllableEventSource.instances.length).toBeGreaterThan(0);
    });
    const stream = ControllableEventSource.instances.at(-1)!;
    const closeCountBefore = stream.closeCount;

    act(() => {
      stream.emit("task:completed", { taskId: "task_followup" });
      stream.emit("leader.session_complete", { taskId: "task_followup" });
      stream.emit("task:failed", { taskId: "task_followup" });
    });

    expect(stream.closeCount).toBe(closeCountBefore);
  });

  // Regression — Codex blocker 2 (kept-fix in PR 3.3 d262b4f):
  // Auto-scroll's `totalCount` must include modern path signals
  // (exchange count + parts across exchanges), not only the legacy
  // `messages.length`. Otherwise a streaming task's content grows
  // off-screen with no bottom pinning.
  test("auto-scroll fires when chatStore exchange/parts growth signals new modern content", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, data: { messages: [], total: 0, offset: 0, limit: 500 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_scroll",
            title: "Scroll watch",
            state: "RUNNING",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-04-25T12:00:00.000Z",
          },
        ],
        isWaitingForResponse: true,
      });
    });

    // Seed an optimistic exchange so applyWireEvent has a registered
    // requestId to apply against (otherwise the projector's stale-filter
    // drops unknown-requestId events on the floor).
    act(() => {
      const localId = useChatStore.getState().beginExchange("task_scroll", "scroll prompt");
      useChatStore.getState().bindRequestId(localId, "task_scroll", "req_scroll");
    });

    renderChatArea("task_scroll");
    await waitFor(() => {
      expect(ControllableEventSource.instances.length).toBeGreaterThan(0);
    });

    const callsBefore = scrollIntoViewCalls;
    // Now apply a real modern event: this adds a TextPart to the
    // response, ticking the modernPartsCount counter in the auto-scroll
    // signal.
    act(() => {
      useChatStore.getState().applyWireEvent("task_scroll", {
        type: "leader.stream_delta",
        requestId: "req_scroll",
        seq: 1,
        data: { type: "text_delta", text: "streaming…" },
      });
    });

    await waitFor(() => {
      expect(scrollIntoViewCalls).toBeGreaterThan(callsBefore);
    });
  });

  test("large modern sessions render only the recent exchange window at first paint", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, data: { messages: [], total: 0, offset: 0, limit: 500 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    globalThis.EventSource = ControllableEventSource as unknown as typeof EventSource;

    const exchanges = Array.from({ length: 1000 }, (_, index) => {
      const n = index + 1;
      return {
        id: `req_${n}`,
        status: "complete",
        user: { content: `prompt ${n}` },
        response: { parts: [] },
        lastAppliedSeq: n,
      };
    });

    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: "task_large",
            title: "Large transcript",
            state: "DONE",
            source: "web",
            workspaceId: "workspace_main",
            updatedAt: "2026-05-12T12:00:00.000Z",
          },
        ],
      });
      useChatStore.setState({
        conversations: {
          task_large: { taskId: "task_large", exchanges: exchanges as any },
        },
      });
    });

    const view = renderChatArea("task_large");

    await waitFor(() => {
      expect(view.getByText("Show earlier (985 hidden)")).toBeTruthy();
    });
    expect(view.queryByText("prompt 985")).toBeNull();
    expect(view.getByText("prompt 986")).toBeTruthy();
    expect(view.getByText("prompt 1000")).toBeTruthy();
  });
});

describe("sliceToRecentTurns", () => {
  type Role = "user" | "assistant" | "tool-call" | "tool-result" | "meta";
  type M = { id: string; role: Role; content: string };
  const mk = (role: Role, n: number): M => ({ id: `${role}-${n}`, role, content: `${role} ${n}` });

  test("returns all messages when user-turn count ≤ limit", () => {
    const msgs = [mk("user", 1), mk("assistant", 1), mk("user", 2), mk("assistant", 2)];
    const r = sliceToRecentTurns(msgs as any, 5);
    expect(r.hidden).toBe(0);
    expect(r.visible).toBe(msgs);
  });

  test("trims to the last N user turns and reports hidden count", () => {
    const msgs: M[] = [];
    for (let i = 1; i <= 10; i++) {
      msgs.push(mk("user", i));
      msgs.push(mk("assistant", i));
    }
    // Keep last 3 user turns → user 8/9/10 → 6 messages visible, 14 hidden
    const r = sliceToRecentTurns(msgs as any, 3);
    expect(r.hidden).toBe(14);
    expect(r.visible.length).toBe(6);
    expect(r.visible[0]).toEqual(mk("user", 8));
    expect(r.visible.at(-1)).toEqual(mk("assistant", 10));
  });

  test("keeps tool-call/result rows attached to their user turn", () => {
    const msgs = [
      mk("user", 1),
      { id: "tc-1", role: "tool-call", content: "t1" },
      { id: "tr-1", role: "tool-result", content: "r1" },
      mk("assistant", 1),
      mk("user", 2),
      mk("assistant", 2),
    ];
    const r = sliceToRecentTurns(msgs as any, 1);
    // Only last user turn kept → user 2 + assistant 2
    expect(r.hidden).toBe(4);
    expect(r.visible.map((m) => m.id)).toEqual(["user-2", "assistant-2"]);
  });
});
