import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Pill } from "./Pill";

// Belt-and-braces: bun:test does not propagate the global afterEach
// registered in test-setup to test files loaded later in the run, so
// each multi-test file installs its own RTL cleanup hook. Without it,
// renders pile up across tests in the same file when run alongside
// other suites and getBy/queryBy queries match unrelated leftover DOM.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Pill", () => {
  test("renders neutral tone by default with base class", () => {
    const view = render(<Pill>WEB</Pill>);
    const el = view.getByText("WEB");
    expect(el.classList.contains("magister-pill")).toBe(true);
    expect(el.classList.contains("magister-pill--neutral")).toBe(true);
  });

  test("renders all 5 tones with the matching modifier class", () => {
    const tones = ["sage", "ochre", "red", "blue", "neutral"] as const;
    for (const tone of tones) {
      const view = render(<Pill tone={tone}>tone-{tone}</Pill>);
      const el = view.getByText(`tone-${tone}`);
      expect(el.classList.contains("magister-pill")).toBe(true);
      expect(el.classList.contains(`magister-pill--${tone}`)).toBe(true);
      view.unmount();
    }
  });

  test("renders children content", () => {
    const view = render(<Pill tone="sage">CLI</Pill>);
    expect(view.getByText("CLI")).toBeTruthy();
  });

  test("renders complex children (ReactNode) inside the pill", () => {
    const view = render(
      <Pill tone="blue">
        <span data-testid="inner">123</span>
      </Pill>,
    );
    expect(view.getByTestId("inner").textContent).toBe("123");
  });
});
