import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SlashMenu, type SlashBuiltin, type SlashMenuItem } from "./SlashMenu";

const ORIGINAL_FETCH = globalThis.fetch;

// SlashMenu loads MCP prompts via getMcpPrompts() → fetch("/mcp/prompts").
// Return an empty list so the tests exercise the builtins path
// deterministically (no async prompt rows shifting the active index).
function installEmptyPromptsFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/mcp/prompts")) {
      return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const BUILTINS: SlashBuiltin[] = [
  { name: "status", description: "Show status" },
  { name: "clear", description: "Clear display" },
  { name: "model", description: "Switch model" },
];

beforeEach(() => {
  installEmptyPromptsFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

// SlashMenu is now a CONTROLLED, presentational component: keyboard
// navigation (Arrow/Enter/Tab/IME) is owned by ChatInput (see
// ChatInput.test.tsx). These tests pin SlashMenu's own contract:
//   - `activeIndex` prop drives which row is aria-selected,
//   - `onItemsChange` reports the ordered/filtered/ranked item list up,
//   - `onHoverIndex` fires on pointer hover,
//   - click invokes onSelectBuiltin / onSelect,
//   - matches are ranked (prefix > substring > subsequence; name > desc).
describe("SlashMenu controlled rendering", () => {
  test("activeIndex prop drives the highlighted row", async () => {
    const view = render(
      <SlashMenu
        filter=""
        builtins={BUILTINS}
        onSelect={() => {}}
        onSelectBuiltin={() => {}}
        onClose={() => {}}
        activeIndex={1}
        onItemsChange={() => {}}
        onHoverIndex={() => {}}
      />,
    );
    await waitFor(() => expect(view.getByRole("listbox")).toBeTruthy());

    const options = view.getAllByRole("option");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
  });

  test("reports the ordered item list up via onItemsChange", async () => {
    let reported: SlashMenuItem[] = [];
    render(
      <SlashMenu
        filter=""
        builtins={BUILTINS}
        onSelect={() => {}}
        onSelectBuiltin={() => {}}
        onClose={() => {}}
        activeIndex={0}
        onItemsChange={(items) => { reported = items; }}
        onHoverIndex={() => {}}
      />,
    );
    await waitFor(() => expect(reported.length).toBe(3));
    expect(reported.every((it) => it.type === "builtin")).toBe(true);
    expect(reported.map((it) => (it.type === "builtin" ? it.builtin.name : ""))).toEqual([
      "status",
      "clear",
      "model",
    ]);
  });

  test("click invokes onSelectBuiltin with the clicked builtin", async () => {
    const picked: string[] = [];
    const view = render(
      <SlashMenu
        filter=""
        builtins={BUILTINS}
        onSelect={() => {}}
        onSelectBuiltin={(b) => { picked.push(b.name); }}
        onClose={() => {}}
        activeIndex={0}
        onItemsChange={() => {}}
        onHoverIndex={() => {}}
      />,
    );
    await waitFor(() => expect(view.getByRole("listbox")).toBeTruthy());

    fireEvent.click(view.getByText("/model"));
    expect(picked).toEqual(["model"]);
  });

  test("mouse hover reports the row index via onHoverIndex", async () => {
    const hovered: number[] = [];
    const view = render(
      <SlashMenu
        filter=""
        builtins={BUILTINS}
        onSelect={() => {}}
        onSelectBuiltin={() => {}}
        onClose={() => {}}
        activeIndex={0}
        onItemsChange={() => {}}
        onHoverIndex={(i) => { hovered.push(i); }}
      />,
    );
    await waitFor(() => expect(view.getByRole("listbox")).toBeTruthy());

    fireEvent.mouseEnter(view.getByText("/clear"));
    expect(hovered).toEqual([1]);
  });

  test("ranks prefix matches above description-only matches", async () => {
    let reported: SlashMenuItem[] = [];
    render(
      <SlashMenu
        filter="cl"
        builtins={[
          { name: "status", description: "Show status" },
          { name: "clear", description: "Clear display" },
          // `goal` only matches "cl" via its description.
          { name: "goal", description: "Set or clear an autonomous goal" },
        ]}
        onSelect={() => {}}
        onSelectBuiltin={() => {}}
        onClose={() => {}}
        activeIndex={0}
        onItemsChange={(items) => { reported = items; }}
        onHoverIndex={() => {}}
      />,
    );
    // `clear` (name-prefix) must rank ahead of `goal` (description-only).
    await waitFor(() => expect(reported.length).toBeGreaterThan(0));
    expect(reported[0]!.type === "builtin" && reported[0]!.builtin.name).toBe("clear");
  });

  test("subsequence match still finds a builtin (e.g. 'stts' → status)", async () => {
    let reported: SlashMenuItem[] = [];
    render(
      <SlashMenu
        filter="stts"
        builtins={BUILTINS}
        onSelect={() => {}}
        onSelectBuiltin={() => {}}
        onClose={() => {}}
        activeIndex={0}
        onItemsChange={(items) => { reported = items; }}
        onHoverIndex={() => {}}
      />,
    );
    await waitFor(() => expect(reported.length).toBe(1));
    expect(reported[0]!.type === "builtin" && reported[0]!.builtin.name).toBe("status");
  });
});
