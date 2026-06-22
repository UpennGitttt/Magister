import { useEffect, useRef, useState } from "react";
import { useToastStore, type Toast, type ToastKind } from "../../stores/toastStore";
import "./ToastStack.css";

const ICON_BY_KIND: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  warning: "!",
  info: "i",
};

const MAX_VISIBLE = 3;

/**
 * ToastStack — bottom-right toast container. Mount once at the root
 * of the app (`AppShell.tsx`). Toasts are pushed imperatively via
 * `useToast().push(...)`. Auto-dismisses after each toast's
 * `durationMs` (paused while hovered).
 *
 * Spec: docs/specs/2026-05-16-ui-redesign-p3-spec.md §6.5.
 */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const visible = toasts.slice(-MAX_VISIBLE);

  if (visible.length === 0) return null;

  return (
    <div className="magister-toast-stack" role="status" aria-live="polite" aria-atomic="true">
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  // Remaining time once timer is paused — refreshed on each pause/resume.
  const remainingRef = useRef<number>(toast.durationMs);
  const lastResumeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (toast.durationMs <= 0) return; // 0 = sticky
    if (paused) return;

    lastResumeRef.current = Date.now();
    const handle = window.setTimeout(() => {
      dismiss(toast.id);
    }, remainingRef.current);

    return () => {
      window.clearTimeout(handle);
      const elapsed = Date.now() - lastResumeRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    };
  }, [paused, toast.durationMs, toast.id, dismiss]);

  const isError = toast.kind === "error";

  return (
    <div
      className={`magister-toast magister-toast--${toast.kind}`}
      role={isError ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="magister-toast__icon" aria-hidden="true">
        {ICON_BY_KIND[toast.kind]}
      </span>
      <div className="magister-toast__body">
        <p className="magister-toast__title">{toast.title}</p>
        {toast.body ? <p className="magister-toast__text">{toast.body}</p> : null}
        {toast.action ? (
          <button
            type="button"
            className="magister-toast__action"
            onClick={() => {
              toast.action?.onClick();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="magister-toast__close"
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}
