import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { SlashCommandCard, type SlashResult } from "./SlashCommandCard";

afterEach(() => cleanup());

function makePicker(
  picks: Array<string | null>,
  overrides: Partial<Extract<SlashResult, { kind: "model_picker" }>["data"]> = {},
): SlashResult {
  return {
    kind: "model_picker",
    data: {
      taskId: "t1",
      phase: "list",
      current: { modelName: "alpha", providerLabel: "prov", apiDialect: "anthropic" },
      options: [
        { modelName: "alpha", providerLabel: "prov", apiDialect: "anthropic" },
        { modelName: "beta", providerLabel: "prov", apiDialect: "openai" },
      ],
      onPick: async (m) => { picks.push(m); },
      onConfirmSwitch: async () => {},
      onCancelSwitch: () => {},
      ...overrides,
    },
  };
}

describe("ModelPicker keyboard navigation", () => {
  test("highlight starts on the current model; ArrowDown + Enter picks the next", () => {
    const picks: Array<string | null> = [];
    const view = render(<SlashCommandCard result={makePicker(picks)} onDismiss={() => {}} />);
    const list = view.getByRole("listbox", { name: "Available models" });

    // current model "alpha" is the initial highlight (index 1; reset is 0).
    const optionAlpha = view.getByRole("option", { name: /alpha/ });
    expect(optionAlpha.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(picks).toEqual(["beta"]);
  });

  test("ArrowUp from the current model lands on the reset row; Enter resets", () => {
    const picks: Array<string | null> = [];
    const view = render(<SlashCommandCard result={makePicker(picks)} onDismiss={() => {}} />);
    const list = view.getByRole("listbox", { name: "Available models" });

    // alpha (index 1) → ArrowUp → reset (index 0).
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(picks).toEqual([null]);
  });

  test("Escape dismisses the picker", () => {
    let dismissed = false;
    const view = render(
      <SlashCommandCard result={makePicker([])} onDismiss={() => { dismissed = true; }} />,
    );
    const list = view.getByRole("listbox", { name: "Available models" });
    fireEvent.keyDown(list, { key: "Escape" });
    expect(dismissed).toBe(true);
  });

  test("interactive flows render flat (no inner card chrome) when variant=flat", () => {
    const view = render(
      <SlashCommandCard result={makePicker([])} onDismiss={() => {}} variant="flat" />,
    );
    const region = view.getByRole("region", { name: /model/i });
    // flat variant drops the bordered-card background.
    expect(region.style.background).toBe("transparent");
    expect(region.style.borderStyle).toBe("none");
  });
});
