import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Skeleton } from "./Skeleton";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Skeleton", () => {
  test("renders 3 lines by default", () => {
    const view = render(<Skeleton />);
    const lines = view.container.querySelectorAll(".magister-skeleton__line");
    expect(lines.length).toBe(3);
  });

  test("renders the requested number of lines", () => {
    const view = render(<Skeleton lines={5} />);
    const lines = view.container.querySelectorAll(".magister-skeleton__line");
    expect(lines.length).toBe(5);
  });

  test("clamps lines to at least 1 when an invalid value is passed", () => {
    const view = render(<Skeleton lines={0} />);
    const lines = view.container.querySelectorAll(".magister-skeleton__line");
    expect(lines.length).toBe(1);
  });

  test("applies custom width to the container via style attribute", () => {
    const view = render(<Skeleton width="240px" />);
    const root = view.container.querySelector(
      ".magister-skeleton",
    ) as HTMLElement | null;
    expect(root).toBeTruthy();
    expect(root!.style.width).toBe("240px");
  });

  test("container marks itself aria-hidden so screen readers skip the placeholder", () => {
    const view = render(<Skeleton />);
    const root = view.container.querySelector(".magister-skeleton");
    expect(root!.getAttribute("aria-hidden")).toBe("true");
  });

  test("applies the optional className alongside the base class", () => {
    const view = render(<Skeleton className="extra-x" />);
    const root = view.container.querySelector(".magister-skeleton");
    expect(root!.classList.contains("magister-skeleton")).toBe(true);
    expect(root!.classList.contains("extra-x")).toBe(true);
  });
});
