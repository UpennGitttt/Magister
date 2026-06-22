import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { NewTaskButton } from "./NewTaskButton";

const originalFetch = globalThis.fetch;

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchCall = { url: string; init?: RequestInit };

function installFetchStub(record: FetchCall[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    record.push({ url, ...(init !== undefined ? { init } : {}) });

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
    if (url === "/api/tasks" && init?.method === "POST") {
      return apiResponse({
        taskId: "task_new_1",
        roleId: "leader",
      });
    }
    return apiResponse({});
  }) as unknown as typeof fetch;
}

function renderButton() {
  return render(
    <MemoryRouter initialEntries={["/w/workspace_main"]}>
      <NewTaskButton />
    </MemoryRouter>,
  );
}

describe("NewTaskButton", () => {
  let calls: FetchCall[] = [];

  beforeEach(() => {
    calls = [];
    installFetchStub(calls);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
  });

  test("renders the + New Task trigger", () => {
    const view = renderButton();
    expect(view.getByRole("button", { name: /New Task/i })).toBeTruthy();
  });

  test("clicking the trigger opens the dialog", async () => {
    const view = renderButton();
    fireEvent.click(view.getByRole("button", { name: /New Task/i }));
    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /New Task/i })).toBeTruthy();
    });
  });

  test("Escape closes the dialog", async () => {
    const view = renderButton();
    fireEvent.click(view.getByRole("button", { name: /New Task/i }));
    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeTruthy();
    });

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
  });

  test("clicking the backdrop closes the dialog", async () => {
    const view = renderButton();
    fireEvent.click(view.getByRole("button", { name: /New Task/i }));
    const backdrop = await waitFor(() => {
      const el = view.container.querySelector(".magister-new-task-backdrop");
      if (!el) throw new Error("backdrop missing");
      return el;
    });

    // Outside click: target === currentTarget triggers close. fireEvent
    // mouseDown defaults target === backdrop, currentTarget === backdrop.
    fireEvent.mouseDown(backdrop);

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
  });

  test("⌘N global shortcut opens the dialog from field-free context", async () => {
    const view = renderButton();
    expect(view.queryByRole("dialog")).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "n", metaKey: true });
    });

    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /New Task/i })).toBeTruthy();
    });
  });

  test("Ctrl+N also opens the dialog (non-mac shortcut)", async () => {
    const view = renderButton();
    act(() => {
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    });
    await waitFor(() => {
      expect(view.getByRole("dialog", { name: /New Task/i })).toBeTruthy();
    });
  });

  test("submit POSTs to /tasks with the entered prompt", async () => {
    const view = renderButton();
    fireEvent.click(view.getByRole("button", { name: /New Task/i }));
    const dialog = await waitFor(() =>
      view.getByRole("dialog", { name: /New Task/i }),
    );

    const textarea = dialog.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // userEvent.type fires the synthetic React onChange events the
    // controlled textarea requires (fireEvent.change skips a couple
    // of React internals on JSDOM textareas).
    const user = userEvent.setup();
    await user.type(textarea, "Refactor approvals UI");

    // Wait for the workspaces registry to hydrate so the select
    // populates and Submit transitions from disabled → enabled. The
    // registry is now module-cached (one fetch fans out across all
    // consumers) so a previous test in this file may have already
    // populated it — assert on the UI signal directly rather than a
    // per-test HTTP call.
    await waitFor(() => {
      const submit = view.getByRole("button", {
        name: /^Submit$/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    });

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /^Submit$/i }));
    });

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/tasks" && c.init?.method === "POST",
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.prompt).toBe("Refactor approvals UI");
      expect(body.source).toBe("web");
      expect(body.workspaceId).toBe("workspace_main");
    });
  });

  test("submit is disabled when prompt is empty", async () => {
    const view = renderButton();
    fireEvent.click(view.getByRole("button", { name: /New Task/i }));
    const submit = (await waitFor(() =>
      view.getByRole("button", { name: /^Submit$/i }),
    )) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
