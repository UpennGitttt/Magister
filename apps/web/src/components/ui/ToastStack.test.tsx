import "../../test-setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { useToastStore, type ToastInput } from "../../stores/toastStore";
import { ToastStack } from "./ToastStack";

beforeEach(() => {
  useToastStore.getState().clear();
});

// Per-file RTL cleanup — see Pill.test.tsx for the rationale (bun:test
// does not propagate the global afterEach in test-setup to all files).
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useToastStore.getState().clear();
});

// `await act(async ...)` is required when pushing into a zustand store
// that drives the rendered tree. Sync `act(() => push(...))` works in
// isolation but flakes when other test files run first — async act
// flushes the subscriber queue deterministically before assertions.
async function pushAct(input: ToastInput) {
  await act(async () => {
    useToastStore.getState().push(input);
    await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("ToastStack", () => {
  test("renders nothing when there are no toasts", () => {
    const view = render(<ToastStack />);
    expect(view.container.querySelector(".magister-toast-stack")).toBeNull();
  });

  test("renders a toast pushed via the store", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "success", title: "Saved", durationMs: 0 });
    await waitFor(() => {
      expect(view.getByText("Saved")).toBeTruthy();
    });
    const stack = view.container.querySelector(".magister-toast-stack");
    expect(stack).toBeTruthy();
    expect(stack!.getAttribute("aria-live")).toBe("polite");
  });

  test("auto-dismisses after the configured duration", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "info", title: "Auto", durationMs: 30 });
    await waitFor(() => expect(view.getByText("Auto")).toBeTruthy());

    await tick(80);

    expect(view.queryByText("Auto")).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  test("durationMs: 0 disables auto-dismiss (sticky toast)", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "info", title: "Sticky", durationMs: 0 });
    await waitFor(() => expect(view.getByText("Sticky")).toBeTruthy());

    await tick(60);

    expect(view.getByText("Sticky")).toBeTruthy();
  });

  test("hovering pauses the dismiss timer; leaving resumes it", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "info", title: "Hovered", durationMs: 40 });

    const toast = await waitFor(() => {
      const el = view.container.querySelector(".magister-toast");
      if (!el) throw new Error("toast not yet rendered");
      return el;
    });

    // Hover almost immediately — the 40ms timer should now be paused.
    act(() => {
      fireEvent.mouseEnter(toast);
    });

    // Wait significantly longer than the original timer; toast must
    // still be there because hover paused it.
    await tick(120);
    expect(view.getByText("Hovered")).toBeTruthy();

    // Leaving resumes; remaining time is still ~40ms (we paused near 0).
    act(() => {
      fireEvent.mouseLeave(toast);
    });

    await tick(120);
    expect(view.queryByText("Hovered")).toBeNull();
  });

  test("error toasts mount with role=alert; non-error toasts use role=status", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "error", title: "Boom", durationMs: 0 });
    await pushAct({ kind: "info", title: "Note", durationMs: 0 });

    await waitFor(() => {
      expect(view.getByText("Boom")).toBeTruthy();
      expect(view.getByText("Note")).toBeTruthy();
    });

    const errorToast = view.getByText("Boom").closest(".magister-toast");
    const infoToast = view.getByText("Note").closest(".magister-toast");
    expect(errorToast!.getAttribute("role")).toBe("alert");
    expect(infoToast!.getAttribute("role")).toBe("status");
  });

  test("at most 3 toasts are visible even when more are queued", async () => {
    const view = render(<ToastStack />);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        useToastStore
          .getState()
          .push({ kind: "info", title: `T${i}`, durationMs: 0 });
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.container.querySelectorAll(".magister-toast").length).toBe(3);
    });

    // The visible slice is the last 3 (most recent).
    expect(view.queryByText("T0")).toBeNull();
    expect(view.queryByText("T1")).toBeNull();
    expect(view.getByText("T2")).toBeTruthy();
    expect(view.getByText("T3")).toBeTruthy();
    expect(view.getByText("T4")).toBeTruthy();

    // Underlying store still holds all 5 — only the render cap is 3.
    expect(useToastStore.getState().toasts.length).toBe(5);
  });

  test("dismiss button removes the toast from the queue", async () => {
    const view = render(<ToastStack />);
    await pushAct({ kind: "info", title: "Closable", durationMs: 0 });
    await waitFor(() => expect(view.getByText("Closable")).toBeTruthy());

    act(() => {
      fireEvent.click(view.getByLabelText("Dismiss notification"));
    });

    await waitFor(() => {
      expect(view.queryByText("Closable")).toBeNull();
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  test("action button fires the action handler and dismisses the toast", async () => {
    const view = render(<ToastStack />);
    let actionCalls = 0;
    await pushAct({
      kind: "success",
      title: "Done",
      durationMs: 0,
      action: { label: "Undo", onClick: () => (actionCalls += 1) },
    });
    await waitFor(() => expect(view.getByText("Done")).toBeTruthy());

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /Undo/i }));
    });

    expect(actionCalls).toBe(1);
    await waitFor(() => {
      expect(view.queryByText("Done")).toBeNull();
    });
  });
});
