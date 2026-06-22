import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("EmptyState", () => {
  test("renders title and base class", () => {
    const view = render(<EmptyState title="Nothing yet" />);
    expect(view.getByText("Nothing yet")).toBeTruthy();
    const root = view.container.querySelector(".magister-empty-state");
    expect(root).toBeTruthy();
  });

  test("renders icon when provided", () => {
    const view = render(<EmptyState title="x" icon="◇" />);
    const icon = view.container.querySelector(".magister-empty-state__icon");
    expect(icon).toBeTruthy();
    expect(icon!.textContent).toBe("◇");
  });

  test("omits icon node when no icon prop", () => {
    const view = render(<EmptyState title="x" />);
    expect(view.container.querySelector(".magister-empty-state__icon")).toBeNull();
  });

  test("renders description when provided", () => {
    const view = render(
      <EmptyState title="x" description="Try creating a task" />,
    );
    expect(view.getByText("Try creating a task")).toBeTruthy();
  });

  test("renders CTA button and fires onClick", () => {
    let clicked = 0;
    const view = render(
      <EmptyState
        title="x"
        cta={{ label: "Create one", onClick: () => (clicked += 1) }}
      />,
    );
    const btn = view.getByRole("button", { name: /Create one/i });
    fireEvent.click(btn);
    expect(clicked).toBe(1);
  });

  test("renders CTA as anchor when href is provided", () => {
    const view = render(
      <EmptyState
        title="x"
        cta={{ label: "Open docs", href: "/docs/x" }}
      />,
    );
    const anchor = view.container.querySelector(
      "a.magister-empty-state__cta",
    ) as HTMLAnchorElement | null;
    expect(anchor).toBeTruthy();
    expect(anchor!.getAttribute("href")).toBe("/docs/x");
    expect(anchor!.textContent).toContain("Open docs");
  });

  test("compact variant adds the compact modifier class", () => {
    const view = render(<EmptyState title="x" compact />);
    const root = view.container.querySelector(".magister-empty-state");
    expect(root!.classList.contains("magister-empty-state--compact")).toBe(true);
  });

  test("non-compact does not add the compact modifier class", () => {
    const view = render(<EmptyState title="x" />);
    const root = view.container.querySelector(".magister-empty-state");
    expect(root!.classList.contains("magister-empty-state--compact")).toBe(false);
  });
});
