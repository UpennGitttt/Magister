import "../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ErrorBanner } from "./ErrorBanner";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("ErrorBanner", () => {
  test("renders title with role=alert", () => {
    const view = render(<ErrorBanner title="Something broke" />);
    expect(view.getByText("Something broke")).toBeTruthy();
    expect(view.getByRole("alert")).toBeTruthy();
  });

  test("renders message body when provided", () => {
    const view = render(
      <ErrorBanner title="Failed" message="Could not load tasks" />,
    );
    expect(view.getByText("Could not load tasks")).toBeTruthy();
  });

  test("renders code prefix when both code and message are provided", () => {
    const view = render(
      <ErrorBanner title="Failed" message="Could not load" code="ERR_FETCH" />,
    );
    const codeEl = view.container.querySelector(".magister-error-banner__code");
    expect(codeEl).toBeTruthy();
    expect(codeEl!.textContent).toBe("ERR_FETCH");
    expect(view.getByText(/Could not load/)).toBeTruthy();
  });

  test("does not render code prefix without a message", () => {
    const view = render(<ErrorBanner title="X" code="ERR_X" />);
    expect(view.container.querySelector(".magister-error-banner__code")).toBeNull();
  });

  test("renders Retry button when onRetry is supplied and fires the handler", () => {
    let calls = 0;
    const view = render(
      <ErrorBanner title="X" onRetry={() => (calls += 1)} />,
    );
    const btn = view.getByRole("button", { name: /Retry/i });
    fireEvent.click(btn);
    expect(calls).toBe(1);
  });

  test("does not render Retry button when onRetry is undefined", () => {
    const view = render(<ErrorBanner title="X" />);
    expect(view.queryByRole("button", { name: /Retry/i })).toBeNull();
  });
});
