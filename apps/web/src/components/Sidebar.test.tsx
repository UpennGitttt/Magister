import "../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";

const originalFetch = globalThis.fetch;

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Sidebar information architecture", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("collapses configuration navigation to one Settings entry", async () => {
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
      if (url.startsWith("/api/system/status")) {
        return apiResponse({
          workers: {},
          integrations: {},
        });
      }
      return apiResponse({});
    }) as unknown as typeof fetch;

    const view = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(view.getByText("Operational")).toBeTruthy();
    });

    const configSection = Array.from(view.container.querySelectorAll(".sidebar__section"))
      .find((section) => section.textContent?.includes("CONFIGURATION"));
    expect(configSection).toBeTruthy();
    // P3 redesign added a `.sidebar__item-glyph` span before the label;
    // query the label span specifically so the glyph doesn't leak into
    // the assertion.
    const labels = Array.from(configSection!.querySelectorAll(".sidebar__item-label"))
      .map((label) => label.textContent?.trim());
    expect(labels).toEqual(["Settings"]);
  });
});
