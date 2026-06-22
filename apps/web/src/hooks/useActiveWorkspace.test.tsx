import "../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  __resetWorkspaceHookForTests,
  useActiveWorkspace,
} from "./useActiveWorkspace";

const originalFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/workspaces")) {
      return new Response(JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              id: "dev_magister",
              label: "Magister Dev",
              basePath: "/opt/acme/magister-dev",
              isDefault: true,
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
            {
              id: "omni",
              label: "Omni",
              basePath: "/opt/acme/workspace/demo-service",
              isDefault: false,
              createdAt: "2026-05-01T00:00:00.000Z",
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function PickerLike() {
  const { activeId, setActive } = useActiveWorkspace();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="picker-active">{activeId ?? "null"}</span>
      <button
        type="button"
        data-testid="picker-select-omni"
        onClick={() => {
          setActive("omni");
          navigate("/w/omni/sessions");
        }}
      >
        omni
      </button>
      <button
        type="button"
        data-testid="picker-set-cache-only"
        onClick={() => setActive("omni")}
      >
        cache-only
      </button>
    </div>
  );
}

function SidebarLike() {
  const { activeId } = useActiveWorkspace();
  return <span data-testid="sidebar-active">{activeId ?? "null"}</span>;
}

describe("useActiveWorkspace cross-consumer sync (regression for stale-mount bug)", () => {
  beforeEach(() => {
    try { localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY); } catch { /* */ }
    __resetWorkspaceHookForTests();
    installFetchStub();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    try { localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY); } catch { /* */ }
    __resetWorkspaceHookForTests();
  });

  test("URL navigation in one consumer updates activeId in another consumer mounted earlier", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/dev_magister/sessions"]}>
        <Routes>
          <Route
            path="/w/:wid/*"
            element={
              <>
                <SidebarLike />
                <PickerLike />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByTestId("sidebar-active").textContent).toBe("dev_magister");
      expect(view.getByTestId("picker-active").textContent).toBe("dev_magister");
    });

    act(() => {
      fireEvent.click(view.getByTestId("picker-select-omni"));
    });

    // Sidebar must reflect the new workspace WITHOUT requiring a
    // second user interaction. This was the original bug — each hook
    // instance held its own useState, so the Picker's mutation never
    // propagated to the Sidebar's stale snapshot.
    await waitFor(() => {
      expect(view.getByTestId("sidebar-active").textContent).toBe("omni");
      expect(view.getByTestId("picker-active").textContent).toBe("omni");
    });
  });

  test("a URL pointing at a deleted workspace falls back to the default once the registry loads", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/w/kb_deleted/sessions"]}>
        <Routes>
          <Route path="/w/:wid/*" element={<PickerLike />} />
        </Routes>
      </MemoryRouter>,
    );

    // Registry has no `kb_deleted` (it was deleted out from under this tab);
    // once it loads we must resolve to the default instead of pinning the
    // app to the ghost id (which rendered "Loading…" forever).
    await waitFor(() => {
      expect(view.getByTestId("picker-active").textContent).toBe("dev_magister");
    });
  });

  test("cache-only setActive (no URL change) syncs across consumers via the same-tab event", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <SidebarLike />
                <PickerLike />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByTestId("sidebar-active").textContent).toBe("dev_magister");
    });

    act(() => {
      fireEvent.click(view.getByTestId("picker-set-cache-only"));
    });

    await waitFor(() => {
      expect(view.getByTestId("sidebar-active").textContent).toBe("omni");
      expect(view.getByTestId("picker-active").textContent).toBe("omni");
    });
  });
});
