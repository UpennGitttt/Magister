import { create } from "zustand";

export type ToastKind = "success" | "error" | "warning" | "info";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /**
   * Optional inline action. Action toasts get a longer 6s timer so the
   * user has time to read + react before they auto-dismiss.
   */
  action?: ToastAction;
  /**
   * Effective auto-dismiss delay in ms. Filled in by `push()` from
   * either the explicit `durationMs` prop or the kind-default
   * (5s base / 6s when an action is attached).
   */
  durationMs: number;
  createdAt: number;
};

export type ToastInput = {
  kind: ToastKind;
  title: string;
  body?: string;
  action?: ToastAction;
  /** Override the auto-dismiss timer (ms). 0 disables auto-dismiss. */
  durationMs?: number;
};

type ToastState = {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

function generateId(): string {
  try {
    // Modern browsers + Bun runtime both expose `crypto.randomUUID`.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the math.random fallback.
  }
  // Fallback id — not cryptographic, but unique-enough for the small
  // toast queue (max 3 visible) where we only need stable React keys.
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const id = generateId();
    const durationMs =
      input.durationMs !== undefined
        ? input.durationMs
        : input.action
        ? 6000
        : 5000;
    const toast: Toast = {
      id,
      kind: input.kind,
      title: input.title,
      durationMs,
      createdAt: Date.now(),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
    };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    return id;
  },
  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => set({ toasts: [] }),
}));

/**
 * Imperative hook for pushing toasts from any component.
 *
 *   const { push } = useToast();
 *   push({ kind: "success", title: "Saved", body: "Agent updated." });
 *
 * Stays stable across renders because Zustand selectors return the
 * raw store functions (no new identities per render).
 */
export function useToast() {
  const push = useToastStore((s) => s.push);
  const dismiss = useToastStore((s) => s.dismiss);
  return { push, dismiss };
}
