import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { createTask } from "../../lib/api";
import { useChatStore } from "../../stores/chatStore";
import { useTaskStore } from "../../stores/taskStore";
import { useToastStore } from "../../stores/toastStore";
import "./NewTaskButton.css";

/**
 * NewTaskButton — global `+ New Task` CTA + dialog.
 *
 * Opens a small dialog (title + workspace picker + Plan/Goal toggles
 * + Submit). POSTs to `/tasks` via the existing `createTask` helper
 * then navigates to the newly-created session.
 *
 * Mounted in topbar slots; the AppShell wires this in. ⌘N opens the
 * dialog from any page.
 *
 * Spec: `docs/specs/2026-05-16-ui-redesign-p3-spec.md` §6.1.
 */
export function NewTaskButton() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const { workspaces, activeId } = useActiveWorkspace();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();

  // Seed workspace from active picker when dialog opens.
  useEffect(() => {
    if (open && !workspaceId && activeId) setWorkspaceId(activeId);
  }, [open, activeId, workspaceId]);

  // ⌘N / Ctrl+N global shortcut. Honors text-input focus — if user
  // is typing somewhere we don't hijack the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        // Allow ⌘N to still open from any field-free context; if user
        // is mid-typing, let the browser handle (or no-op).
        return;
      }
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus management when dialog opens / closes.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => promptRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Esc to dismiss + focus trap (Tab/Shift+Tab cycle within dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Task description is required");
      return;
    }
    const wsId =
      workspaceId ||
      activeId ||
      import.meta.env.VITE_DEFAULT_WORKSPACE_ID ||
      "workspace_main";
    setSubmitting(true);
    setError(null);
    // Seed the exchange in chatStore + flip `isWaitingForResponse`
    // BEFORE the page navigates. Without this the ChatArea mounts
    // fresh on /w/<wid>/sessions/<taskId>, sees `messages.length === 0`
    // and `!hasModernExchanges`, and renders the "loading" branch
    // (fetching=true via Effect 2) for 1-2s until the first SSE event
    // lands. Mirroring the ChatInput
    // pre-network pattern parks an optimistic exchange under the
    // pending bucket, then `bindRequestId` migrates it into the new
    // task's conversation atomically before navigate fires.
    const setWaitingForResponse = useTaskStore.getState().setWaitingForResponse;
    setWaitingForResponse(true);
    const chatStoreLocalId = useChatStore.getState().beginExchange(null, trimmed);
    try {
      const result = await createTask({
        prompt: trimmed,
        source: "web",
        workspaceId: wsId,
        ...(planMode ? { planFirst: true } : {}),
        ...(goalMode ? { goal: { objective: trimmed } } : {}),
      });
      // Both ids now known — bind atomically (moves the exchange out
      // of `_pending:<localId>` and into conversations[<taskId>]).
      useChatStore.getState().bindRequestId(chatStoreLocalId, result.taskId, result.requestId);
      setOpen(false);
      setPrompt("");
      setPlanMode(false);
      setGoalMode(false);
      useToastStore.getState().push({
        kind: "info",
        title: "Task created",
        body: trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed,
      });
      navigate(`/w/${wsId}/sessions/${result.taskId}`);
    } catch (err) {
      // Roll back the optimistic seed so a failed create doesn't
      // leave a ghost prompt hanging in the `_pending:*` bucket.
      useChatStore.getState().rollbackOptimistic(chatStoreLocalId);
      setWaitingForResponse(false);
      const message =
        err instanceof Error ? err.message : "Failed to create task";
      setError(message);
      useToastStore.getState().push({
        kind: "error",
        title: "Failed to create task",
        body: message,
      });
    } finally {
      setSubmitting(false);
    }
  }, [prompt, workspaceId, activeId, planMode, goalMode, navigate]);

  return (
    <>
      <button
        type="button"
        className="magister-new-task-btn"
        onClick={() => setOpen(true)}
        title="New Task (⌘N)"
      >
        + New Task
      </button>

      {open ? (
        <div
          className="magister-new-task-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            className="magister-new-task-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header className="magister-new-task-dialog__head">
              <h2 id={titleId}>New Task</h2>
              <button
                type="button"
                className="magister-new-task-dialog__close"
                onClick={() => setOpen(false)}
                aria-label="Close dialog"
              >
                ×
              </button>
            </header>

            <div className="magister-new-task-dialog__body">
              <label className="magister-new-task-field">
                <span className="magister-new-task-field__label">
                  What should the agent do?
                </span>
                <textarea
                  ref={promptRef}
                  className="magister-new-task-field__input"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="Describe the task…"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
              </label>

              <label className="magister-new-task-field">
                <span className="magister-new-task-field__label">Workspace</span>
                <select
                  className="magister-new-task-field__input"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {workspaces.length === 0 ? (
                    <option value="">(no workspaces)</option>
                  ) : (
                    workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label || w.id}
                      </option>
                    ))
                  )}
                </select>
              </label>

              <div
                className="magister-new-task-toggles"
                role="group"
                aria-label="Mode toggles"
              >
                <button
                  type="button"
                  className="magister-new-task-toggle"
                  aria-pressed={planMode}
                  onClick={() => setPlanMode((v) => !v)}
                >
                  {planMode ? "✓ " : ""}Plan
                </button>
                <button
                  type="button"
                  className="magister-new-task-toggle"
                  aria-pressed={goalMode}
                  onClick={() => setGoalMode((v) => !v)}
                >
                  {goalMode ? "✓ " : ""}Goal
                </button>
              </div>

              {error ? (
                <p className="magister-new-task-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className="magister-new-task-dialog__foot">
              <button
                type="button"
                className="magister-new-task-cancel"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="magister-new-task-submit"
                onClick={() => void handleSubmit()}
                disabled={submitting || !prompt.trim()}
              >
                {submitting ? "Creating…" : "Submit"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
