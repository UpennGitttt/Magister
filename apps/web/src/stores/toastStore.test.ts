import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useToastStore } from "./toastStore";

beforeEach(() => {
  useToastStore.getState().clear();
});

afterEach(() => {
  useToastStore.getState().clear();
});

describe("toastStore", () => {
  test("push() adds a toast and returns its id", () => {
    const id = useToastStore
      .getState()
      .push({ kind: "success", title: "Saved" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.id).toBe(id);
    expect(toasts[0]!.kind).toBe("success");
    expect(toasts[0]!.title).toBe("Saved");
  });

  test("dismiss() removes the matching toast", () => {
    const a = useToastStore.getState().push({ kind: "info", title: "A" });
    const b = useToastStore.getState().push({ kind: "info", title: "B" });
    expect(useToastStore.getState().toasts).toHaveLength(2);

    useToastStore.getState().dismiss(a);
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(b);
  });

  test("dismiss() on an unknown id is a no-op", () => {
    useToastStore.getState().push({ kind: "info", title: "A" });
    useToastStore.getState().dismiss("nope");
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  test("push() returns unique ids across calls", () => {
    const ids = [
      useToastStore.getState().push({ kind: "info", title: "1" }),
      useToastStore.getState().push({ kind: "info", title: "2" }),
      useToastStore.getState().push({ kind: "info", title: "3" }),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  test("subscribers fire on add and on remove", () => {
    let calls = 0;
    const unsub = useToastStore.subscribe(() => {
      calls += 1;
    });

    const id = useToastStore.getState().push({ kind: "info", title: "x" });
    expect(calls).toBeGreaterThanOrEqual(1);

    const callsAfterPush = calls;
    useToastStore.getState().dismiss(id);
    expect(calls).toBeGreaterThan(callsAfterPush);

    unsub();
  });

  test("default duration is 5000ms; action toasts default to 6000ms", () => {
    const a = useToastStore
      .getState()
      .push({ kind: "info", title: "plain" });
    const b = useToastStore.getState().push({
      kind: "info",
      title: "with action",
      action: { label: "Undo", onClick: () => {} },
    });

    const toasts = useToastStore.getState().toasts;
    const plain = toasts.find((t) => t.id === a)!;
    const withAction = toasts.find((t) => t.id === b)!;
    expect(plain.durationMs).toBe(5000);
    expect(withAction.durationMs).toBe(6000);
  });

  test("explicit durationMs override wins over kind/action defaults", () => {
    const id = useToastStore
      .getState()
      .push({ kind: "info", title: "x", durationMs: 1234 });
    const toast = useToastStore
      .getState()
      .toasts.find((t) => t.id === id)!;
    expect(toast.durationMs).toBe(1234);
  });

  test("clear() empties the queue", () => {
    useToastStore.getState().push({ kind: "info", title: "1" });
    useToastStore.getState().push({ kind: "info", title: "2" });
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
