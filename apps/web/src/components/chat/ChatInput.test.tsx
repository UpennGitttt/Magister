import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ChatInput, resetWebSession } from "./ChatInput";
import { useChatStore } from "../../stores/chatStore";
import { useTaskStore } from "../../stores/taskStore";
import { useUiStore } from "../../stores/uiStore";

const ORIGINAL_FETCH = globalThis.fetch;

type RecordedRequest = { url: string; method?: string | undefined; body?: string | undefined };
const requests: RecordedRequest[] = [];

function installFetchMock(taskId: string = "task_new") {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init?.body : undefined,
    });
    if (url.includes("/tasks") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ ok: true, data: { taskId, requestId: "req_1", status: "queued" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // GET /tasks (fetchTasks) — envelope shape with items array.
    return new Response(
      JSON.stringify({ ok: true, data: { items: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function installDelayedCreateTaskFetchMock(taskId: string = "task_new") {
  let resolvePost!: () => void;
  const postGate = new Promise<void>((resolve) => {
    resolvePost = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? init?.body : undefined,
    });
    if (url.includes("/tasks") && init?.method === "POST") {
      await postGate;
      return new Response(
        JSON.stringify({ ok: true, data: { taskId, requestId: "req_1", status: "queued" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, data: { items: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { resolvePost };
}

function renderInput() {
  return render(
    <MemoryRouter>
      <ChatInput />
    </MemoryRouter>,
  );
}

// Renders ChatInput under a route that supplies `:taskId`, so
// useSelectedTaskId() resolves to a real selected task (needed for the
// /compact path, which only arms against a selected task). When `state`
// is supplied, seeds taskStore with a task in that state so availability
// gates (/compact, /model terminal checks) resolve correctly.
function renderInputForTask(taskId: string, state?: string) {
  if (state !== undefined) {
    act(() => {
      useTaskStore.setState({
        tasks: [
          {
            id: taskId,
            title: "t",
            state,
            workspaceId: "workspace_main",
          } as never,
        ],
      });
    });
  }
  return render(
    <MemoryRouter initialEntries={[`/w/workspace_main/sessions/${taskId}`]}>
      <Routes>
        <Route path="/w/:wid/sessions/:taskId" element={<ChatInput />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  requests.length = 0;
  installFetchMock();
  // Reset store between tests — plan mode is now persisted in
  // localStorage, so without this a previous test's toggle leaks.
  try { window.localStorage.removeItem("magister:planMode"); } catch {}
  act(() => {
    useTaskStore.setState({ tasks: [], isWaitingForResponse: false, error: null });
    useChatStore.getState().resetForTests();
    useUiStore.setState({ planMode: false });
    resetWebSession();
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("ChatInput plan-first toggle", () => {
  test("toggle reflects pressed state on click", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const toggle = view.getByRole("button", { name: /Plan first/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await user.click(toggle);
    expect(view.getByRole("button", { name: /Plan first/i }).getAttribute("aria-pressed")).toBe("true");

    await user.click(toggle);
    expect(view.getByRole("button", { name: /Plan first/i }).getAttribute("aria-pressed")).toBe("false");
  });

  test("send WITHOUT plan-first sends prompt verbatim", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    await user.type(textarea, "fix the typo");
    await user.click(view.getByRole("button", { name: /Send message/i }));

    await waitFor(() => {
      const post = requests.find((r) => r.method === "POST" && r.url.includes("/tasks"));
      expect(post).toBeTruthy();
    });
    const post = requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))!;
    const body = JSON.parse(post.body!);
    expect(body.prompt).toBe("fix the typo");
  });

  test("send WITH plan-first sends prompt verbatim plus a planFirst:true flag, resets toggle after success", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    await user.click(view.getByRole("button", { name: /Plan first/i }));
    await user.type(textarea, "refactor the auth module");
    await user.click(view.getByRole("button", { name: /Send message/i }));

    await waitFor(() => {
      const post = requests.find((r) => r.method === "POST" && r.url.includes("/tasks"));
      expect(post).toBeTruthy();
    });
    const post = requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))!;
    const body = JSON.parse(post.body!);
    // User message is unchanged — the plan instruction goes via the
    // structured flag, not by polluting the user's prompt.
    expect(body.prompt).toBe("refactor the auth module");
    expect(body.planFirst).toBe(true);

    // Sticky-per-session per spec §3 — toggle stays on after send so
    // follow-up messages in the same task continue to flow through
    // plan mode until the user explicitly turns it off.
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /Plan first/i }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  test("Enter key sends a message", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    await user.type(textarea, "ship it");
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });

    await waitFor(() => {
      const post = requests.find((r) => r.method === "POST" && r.url.includes("/tasks"));
      expect(post).toBeTruthy();
    });
  });

  test("slash menu: ArrowDown/ArrowUp move the highlighted row, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // Open the menu with a filter that matches several built-ins.
    await user.type(textarea, "/");
    const options = await view.findAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    // First row highlighted by default.
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    await waitFor(() => {
      const opts = view.getAllByRole("option");
      expect(opts[0]!.getAttribute("aria-selected")).toBe("false");
      expect(opts[1]!.getAttribute("aria-selected")).toBe("true");
    });

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await waitFor(() => {
      expect(view.getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");
    });

    // ArrowUp from the top wraps to the last row.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await waitFor(() => {
      const opts = view.getAllByRole("option");
      expect(opts[opts.length - 1]!.getAttribute("aria-selected")).toBe("true");
    });
  });

  test("slash menu: Enter commits the highlighted built-in instead of raw-sending", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // "/clear" matches the clear built-in (top row). Enter should run it
    // — closing the menu and clearing the input — not POST a message.
    await user.type(textarea, "/clear");
    await view.findByRole("listbox");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(view.queryByRole("listbox")).toBeNull();
      expect((view.getByLabelText("Chat message") as HTMLTextAreaElement).value).toBe("");
    });
    // No task was created — Enter selected a command, it did not send.
    expect(requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))).toBeUndefined();
  });

  test("slash menu: native isComposing Enter does NOT commit the highlighted command (IME guard 2 — no compositionStart)", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // Open the slash menu — "/clear" highlights the clear built-in.
    await user.type(textarea, "/clear");
    await view.findByRole("listbox");

    // Deliberately do NOT fire compositionStart, so `composing.current` is
    // false. The only thing standing between this Enter and a command commit
    // is the native fallback `e.nativeEvent.isComposing || e.keyCode === 229`
    // (guard 2). Some IMEs fire keydown with isComposing=true before the
    // compositionstart event ever lands; this exercises that exact path.
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false, isComposing: true });

    // Menu stays open, the typed text is untouched, nothing dispatched/sent.
    expect(view.queryByRole("listbox")).not.toBeNull();
    expect((view.getByLabelText("Chat message") as HTMLTextAreaElement).value).toBe("/clear");
    expect(requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))).toBeUndefined();
  });

  test("slash menu: keyCode===229 Enter does NOT commit the highlighted command (IME guard 2 — keyCode fallback)", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // Open the slash menu — "/clear" highlights the clear built-in.
    await user.type(textarea, "/clear");
    await view.findByRole("listbox");

    // No compositionStart (composing.current = false) and isComposing left
    // false — the sole guard exercised here is the legacy `keyCode === 229`
    // signal browsers raise while an IME is mid-composition. This is the
    // load-bearing half of guard 2 in jsdom (the keyCode init reliably
    // reaches the handler).
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false, keyCode: 229 });

    // Menu stays open, the typed text is untouched, nothing dispatched/sent.
    expect(view.queryByRole("listbox")).not.toBeNull();
    expect((view.getByLabelText("Chat message") as HTMLTextAreaElement).value).toBe("/clear");
    expect(requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))).toBeUndefined();
  });

  test("slash menu: plain Enter (no composition) DOES commit the highlighted built-in", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // Open the slash menu — "/clear" highlights the clear built-in.
    await user.type(textarea, "/clear");
    await view.findByRole("listbox");

    // Sanity: no composition flags at all → Enter commits the row (closes the
    // menu + clears the input). Still no POST — /clear is a built-in, not a
    // raw send. This proves the IME guards above are gating real composition,
    // not silently swallowing every Enter.
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => {
      expect(view.queryByRole("listbox")).toBeNull();
      expect((view.getByLabelText("Chat message") as HTMLTextAreaElement).value).toBe("");
    });
    expect(requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))).toBeUndefined();
  });

  test("/compact: queued card arms a watcher that folds in real token stats", async () => {
    const taskId = "task_compact";
    act(() => {
      useTaskStore.setState({
        tasks: [{ id: taskId, state: "RUNNING" } as never],
        isWaitingForResponse: true,
        error: null,
      });
    });
    const user = userEvent.setup();
    const view = renderInputForTask(taskId);
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // /compact is only offered against an active task; the seeded
    // RUNNING task above satisfies that gate.
    await user.type(textarea, "/compact");
    await view.findByRole("listbox");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Immediate feedback: queued card explaining WHEN it runs.
    await view.findByText(/Compaction queued/i);
    await view.findByText(/Watching for the result/i);
    await waitFor(() => {
      expect(
        requests.find((r) => r.method === "POST" && r.url.includes(`/tasks/${taskId}/compact`)),
      ).toBeTruthy();
    });

    // Simulate the backend emitting the compaction result into the store
    // (as the SSE adapter would). The armed watcher should fold the
    // pre→post token stats into the card.
    act(() => {
      useChatStore.setState((s) => ({
        conversations: {
          ...s.conversations,
          [taskId]: {
            taskId,
            exchanges: [
              {
                response: {
                  parts: [
                    {
                      kind: "system",
                      id: "evt_compact_1",
                      variant: "compaction",
                      headline: "📦 Context compacted (45.2K → 12.1K tokens)",
                    },
                  ],
                },
              },
            ],
          } as never,
        },
      }));
    });

    await view.findByText(/45\.2K → 12\.1K tokens/);
  });

  test("slash menu: ranks prefix matches above description-only matches", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    // "/c": `clear` matches by name-prefix (best); `goal` only via its
    // "…or clear…" description. Prefix must sort first.
    await user.type(textarea, "/c");
    const options = await view.findAllByRole("option");
    expect(options[0]!.textContent).toContain("/clear");
  });

  test("slash menu: Tab autocompletes the highlighted command without sending", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    await user.type(textarea, "/cl");
    await view.findByRole("listbox");
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: false });

    await waitFor(() => {
      expect((view.getByLabelText("Chat message") as HTMLTextAreaElement).value).toBe("/clear ");
    });
    // Still a command in the box — nothing was sent.
    expect(requests.find((r) => r.method === "POST" && r.url.includes("/tasks"))).toBeUndefined();
  });

  test("shows an inline pending notice when send stays pending past the threshold", async () => {
    const delayed = installDelayedCreateTaskFetchMock();
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;

    await user.type(textarea, "slow request");
    await user.click(view.getByRole("button", { name: /Send message/i }));

    expect(view.queryByText("Still sending...")).toBeNull();
    expect(await view.findByText("Still sending...", {}, { timeout: 1800 })).toBeTruthy();

    await act(async () => {
      delayed.resolvePost();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => {
      expect(view.queryByText("Still sending...") === null).toBe(true);
    });
  });
});

async function openMenuWith(view: ReturnType<typeof render>, text: string) {
  const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.type(textarea, text);
  await waitFor(() => expect(view.getByLabelText("Slash commands")).toBeTruthy());
  return view.getByLabelText("Slash commands");
}

describe("ChatInput slash command availability gates", () => {
  test("/compact is offered for a non-terminal task with a selectedTaskId", async () => {
    const view = renderInputForTask("task_running", "WORKING");
    const menu = await openMenuWith(view, "/compact");
    await waitFor(() =>
      expect(within(menu).getByText("/compact")).toBeTruthy(),
    );
  });

  test("/compact is hidden when the selected task is terminal", async () => {
    const view = renderInputForTask("task_done", "DONE");
    const menu = await openMenuWith(view, "/compact");
    // The builtin should be filtered out by its availability gate; the
    // menu shows the no-match empty state instead.
    await waitFor(() =>
      expect(within(menu).queryByText("/compact")).toBeNull(),
    );
  });

  test("/model is offered even when an existing task is terminal", async () => {
    // /model is always available: switching the model on a finished task
    // takes effect on the next follow-up turn (resume applies
    // tasks.model_override), so the UI no longer hides it on terminal tasks.
    const view = renderInputForTask("task_done", "DONE");
    const menu = await openMenuWith(view, "/model");
    await waitFor(() =>
      expect(within(menu).getByText("/model")).toBeTruthy(),
    );
  });

  test("/model is offered on a non-terminal existing task", async () => {
    const view = renderInputForTask("task_running", "WORKING");
    const menu = await openMenuWith(view, "/model");
    await waitFor(() =>
      expect(within(menu).getByText("/model")).toBeTruthy(),
    );
  });
});

describe("ChatInput onSelectBuiltin canonicalization", () => {
  test("selecting model with a partial '/mod' typed dispatches /model (opens picker, no spurious model name)", async () => {
    // Fresh chat (no task). Type the partial, then click the model
    // builtin. The canonicalizer must rebuild "/model" from the selected
    // builtin — never pass the partial "/mod" through as a model name.
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;
    await user.type(textarea, "/mod");
    const menu = await view.findByLabelText("Slash commands");
    const modelBtn = within(menu).getByText("/model");
    await user.click(modelBtn);

    // Fresh-chat /model opens the picker card (kind model_picker) titled
    // "/model — pick a model"; it must NOT surface an "Unknown model"
    // error card.
    await waitFor(() =>
      expect(view.queryByText(/Unknown model/i)).toBeNull(),
    );
    await waitFor(() =>
      expect(view.getByText(/pick a model/i)).toBeTruthy(),
    );
  });

  test("selecting goal with trailing args preserves the args", async () => {
    const user = userEvent.setup();
    const view = renderInput();
    const textarea = view.getByLabelText("Chat message") as HTMLTextAreaElement;
    await user.type(textarea, "/goal fix the bug");
    const menu = await view.findByLabelText("Slash commands");
    const goalBtn = within(menu).getByText("/goal");
    await user.click(goalBtn);

    // /goal <objective> shows the activation card echoing the objective.
    await waitFor(() =>
      expect(view.getByText("fix the bug")).toBeTruthy(),
    );
  });
});
