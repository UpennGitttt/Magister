import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getModSymbol } from "../lib/platform";
import { useUiStore } from "../stores/uiStore";
import { ChatArea } from "../components/chat/ChatArea";
import { ChatInput, resetWebSession } from "../components/chat/ChatInput";
import { ChangeReviewPanel } from "../components/chat/ChangeReviewPanel";
import { SessionSummaryBanner } from "../components/chat/SessionSummaryBanner";
import { TeammateTranscriptDrawer } from "../components/chat/TeammateTranscriptDrawer";
import { EmptyState } from "../components/ui/EmptyState";
import { ApprovalBell } from "../components/layout/ApprovalBell";
import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { useSelectedTaskId } from "../hooks/useSelectedTaskId";
import { setCurrentSelectedTaskId } from "../stores/currentRoute";
import { useTaskStore } from "../stores/taskStore";
import { getTask, getTaskUsage } from "../lib/api";
import type { TaskSummary, WorkspaceView } from "../lib/types";
import type { TaskUsageSummary } from "../lib/api";
import "../styles/chat.css";
import "../styles/task-detail.css";

const SESSION_LIST_DEFAULT_LIMIT = 5;
const SESSION_CONTEXT_USAGE_POLL_MS = 5_000;

export function ChatPage() {
  const tasks = useTaskStore((s) => s.tasks);
  const fetchTasks = useTaskStore((s) => s.fetchTasks);
  const navigate = useNavigate();
  // Path A — derive workspace scope from URL `:wid` first (deeplinks
  // trump localStorage), fall back to active picker selection. Used
  // both for filtering the visible sessions and for new-task wid.
  const { wid: urlWorkspaceId } = useParams<{ wid?: string }>();
  const { activeId: pickerWorkspaceId, workspaces } = useActiveWorkspace();
  const effectiveWorkspaceId = urlWorkspaceId ?? pickerWorkspaceId ?? null;
  // URL is the single source of truth for "which task is selected".
  // No mirror in Zustand — the previous design wrote `selectedTaskId` to
  // both URL and Zustand and the two could commit on different ticks,
  // creating a window where a route-sync effect would mistakenly clear
  // an in-flight optimistic send.
  const selectedTaskId = useSelectedTaskId();
  const [changeReviewActionCount, setChangeReviewActionCount] = useState(0);
  const [changeReviewBreakdown, setChangeReviewBreakdown] = useState<{
    toDecide: number;
    toApply: number;
  }>({ toDecide: 0, toApply: 0 });
  const handleChangeReviewActionCount = useCallback(
    (count: number, breakdown: { toDecide: number; toApply: number; total: number }) => {
      setChangeReviewActionCount(count);
      setChangeReviewBreakdown({ toDecide: breakdown.toDecide, toApply: breakdown.toApply });
    },
    [],
  );
  useEffect(() => {
    setChangeReviewActionCount(0);
    setChangeReviewBreakdown({ toDecide: 0, toApply: 0 });
  }, [selectedTaskId]);
  // Mobile drawer/sheet state. `null` = closed (desktop is always closed).
  // - "sessions" → left drawer with session list (hamburger)
  // - "context"  → bottom sheet with SessionContextPanel (ⓘ button)
  // Body scroll is locked while either is open at mobile breakpoint.
  const [mobileNav, setMobileNav] = useState<"sessions" | "context" | null>(null);
  // Track viewport breakpoint via matchMedia so a transition from mobile →
  // desktop (rotation, resize, dev tools) closes any open overlay and
  // releases the body-scroll lock. Without this, state leaks into the
  // desktop layout — body stays locked invisibly, drawer state persists
  // through rotation, etc.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 880px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 880px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    if (!isMobile && mobileNav !== null) setMobileNav(null);
  }, [isMobile, mobileNav]);

  // Consume the AppShell-set focus target. Set by ⌘K (session-search)
  // or ⌘⏎ (composer). On a fresh navigate from elsewhere, ChatPage
  // mounts AFTER the flag is set; on a same-page hotkey the flag flips
  // while we're already mounted. Both cases handled by reading at
  // mount + on every flag change. The DOM lookup runs in a microtask
  // so React has time to paint the input element before we focus it
  // (otherwise the ref would be stale on the first mount-and-focus).
  const pendingFocus = useUiStore((s) => s.pendingFocus);
  const consumeFocusTarget = useUiStore((s) => s.consumeFocusTarget);
  useEffect(() => {
    if (!pendingFocus) return;
    const targetId =
      pendingFocus === "session-search"
        ? "chat-session-search-input"
        : "chat-composer-textarea";
    // requestAnimationFrame, not setTimeout(0): pairs with the React
    // commit phase so the input is actually in the DOM before focus().
    const handle = requestAnimationFrame(() => {
      const el = document.getElementById(targetId) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) {
        el.focus();
        // Select existing text in search so the user can just start
        // typing and overwrite — same UX as Spotlight/⌘K elsewhere.
        if (pendingFocus === "session-search" && el instanceof HTMLInputElement) {
          el.select();
        }
      }
      consumeFocusTarget();
    });
    return () => cancelAnimationFrame(handle);
  }, [pendingFocus, consumeFocusTarget]);

  const closeMobileNav = () => setMobileNav(null);

  // Refs for focus management on drawer open/close.
  const sessionsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const sessionsPanelRef = useRef<HTMLElement | null>(null);
  const contextOpenerRef = useRef<HTMLButtonElement | null>(null);
  const contextPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (effectiveWorkspaceId !== null) {
      void fetchTasks({ workspaceId: effectiveWorkspaceId });
    }
  }, [fetchTasks, effectiveWorkspaceId]);

  // Kimi review M7 — when the URL workspace doesn't match the
  // selected task's actual workspace, the sessions sidebar would
  // hide the task while the chat still renders. Detect the
  // mismatch and redirect the URL to the right workspace so the
  // sidebar and chat agree.
  useEffect(() => {
    if (!selectedTaskId || !urlWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const task = await getTask(selectedTaskId);
        if (cancelled) return;
        if (task.workspaceId && task.workspaceId !== urlWorkspaceId) {
          navigate(`/w/${task.workspaceId}/sessions/${selectedTaskId}`, { replace: true });
        }
      } catch { /* task not found / unauth — fall through, ChatArea will surface */ }
    })();
    return () => { cancelled = true; };
  }, [selectedTaskId, urlWorkspaceId, navigate]);

  // Mirror the URL-derived task id into a module-level slot so non-React
  // code (the WebSocket event handler in `wsStore`) can read which task
  // the user is viewing without using hooks. This is the ONLY writer to
  // the mirror — everywhere else reads.
  useEffect(() => {
    setCurrentSelectedTaskId(selectedTaskId);
    return () => setCurrentSelectedTaskId(null);
  }, [selectedTaskId]);

  // While a mobile drawer/sheet is open: lock body scroll, listen for
  // Escape, and move focus into the active panel. On close, restore
  // focus to whichever opener triggered it.
  useEffect(() => {
    if (!isMobile || mobileNav === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const opener = mobileNav === "sessions"
      ? sessionsOpenerRef.current
      : contextOpenerRef.current;
    const panel = mobileNav === "sessions"
      ? sessionsPanelRef.current
      : contextPanelRef.current;
    // Move focus into the panel so screen readers + keyboard users land
    // inside the dialog. Falls back gracefully if the ref hasn't attached.
    panel?.focus({ preventScroll: true });

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setMobileNav(null);
        return;
      }
      // Tab trap: keep focus inside the active panel (a11y requirement
      // for role="dialog" with aria-modal). Without this, keyboard
      // users could tab out into the underlying chat content.
      if (ev.key === "Tab" && panel) {
        const focusables = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (ev.shiftKey) {
          if (active === first || !panel.contains(active)) {
            ev.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !panel.contains(active)) {
            ev.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      // Return focus to whichever button opened this panel.
      opener?.focus({ preventScroll: true });
    };
  }, [isMobile, mobileNav]);

  function handleNewChat() {
    resetWebSession();
    // Clear cross-task ephemera explicitly. The URL change alone doesn't
    // unwind these because the store no longer "knows" about task switch.
    useTaskStore.setState({ isWaitingForResponse: false, error: null });
    closeMobileNav();
    navigate("/sessions");
  }

  const selectedTask = selectedTaskId
    ? (tasks.find((task) => task.id === selectedTaskId) ?? null)
    : null;
  const showWorkbenchNarrative = Boolean(selectedTask?.blockedNarrative)
    && !(selectedTask?.blockedNarrative?.reason === "awaiting_approval"
      && selectedTask.blockedNarrative.source === "change_review");

  return (
    <div className="chat-page">
      {/* P3 mockup omits the standalone page header — the "Sessions"
          title moves into the sessions-panel header and the chat
          title fills the conversation-panel header. We keep this
          node mounted only on mobile (sr-only on desktop) so the
          mobile bar's a11y label still has a logical h1 above it. */}
      <header className="chat-page__page-header chat-page__page-header--hidden-desktop">
        <div>
          <h1>Sessions</h1>
          <p>Chat with agents and continue task work.</p>
        </div>
      </header>

      {/* Mobile-only top bar: hamburger (sessions drawer) + task title.
          Hidden on desktop via CSS. */}
      <header className="chat-page__mobile-bar" aria-label="Mobile chat controls">
        <button
          ref={sessionsOpenerRef}
          type="button"
          className="chat-page__mobile-bar-btn"
          aria-label="Open sessions list"
          aria-expanded={mobileNav === "sessions"}
          aria-controls="chat-sessions-panel"
          onClick={() => setMobileNav("sessions")}
        >
          ☰
        </button>
        <span className="chat-page__mobile-bar-title" title={selectedTask?.title ?? ""}>
          {selectedTask?.title ?? "New chat"}
        </span>
        {selectedTask ? (
          <span
            className={`chat-page__mobile-bar-state chat-page__state-badge--${stateTone(sessionDisplayState(selectedTask).bucket)}`}
            title={sessionDisplayState(selectedTask).title}
          >
            {sessionDisplayState(selectedTask).label}
          </span>
        ) : null}
        {selectedTask ? (
          <button
            ref={contextOpenerRef}
            type="button"
            className="chat-page__mobile-bar-btn chat-page__mobile-bar-btn--info"
            aria-label="Show session details"
            aria-expanded={mobileNav === "context"}
            aria-controls="chat-context-sheet"
            onClick={() => setMobileNav("context")}
          >
            ⓘ
          </button>
        ) : null}
      </header>

      <div className="chat-page__workspace">
        <aside
          ref={sessionsPanelRef}
          id="chat-sessions-panel"
          className="chat-page__sessions-panel"
          data-mobile-open={mobileNav === "sessions" ? "true" : "false"}
          aria-label="Sessions"
          role={isMobile ? "dialog" : undefined}
          aria-modal={isMobile && mobileNav === "sessions" ? true : undefined}
          tabIndex={isMobile && mobileNav === "sessions" ? -1 : undefined}
          inert={isMobile && mobileNav !== "sessions"}
        >
          <div className="chat-page__panel-head">
            <div className="chat-page__panel-head-title">
              {/* Workspace label lives in the title row as a pill,
                  alongside <h2>Sessions</h2>. */}
              <h2 style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                Sessions
                {(() => {
                  const wsLabel = workspaces.find((w) => w.id === effectiveWorkspaceId)?.label
                    ?? effectiveWorkspaceId
                    ?? "no workspace";
                  return (
                    <span
                      title={`Workspace id: ${effectiveWorkspaceId ?? "(none)"}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                        padding: "0.1rem 0.55rem",
                        borderRadius: "999px",
                        background: "rgba(143, 57, 40, 0.12)",
                        border: "1px solid rgba(143, 57, 40, 0.35)",
                        color: "var(--ink)",
                        fontSize: "0.7em",
                        fontWeight: 600,
                        letterSpacing: "0.01em",
                        textTransform: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span aria-hidden="true">📁</span>
                      {wsLabel}
                    </span>
                  );
                })()}
              </h2>
              <span className="chat-page__panel-head-meta">
                {tasks.length} total
                {(() => {
                  const live = tasks.filter((t) => {
                    const b = sessionDisplayState(t).bucket;
                    return b === "running" || b === "waiting" || b === "recovered";
                  }).length;
                  return live > 0 ? ` · ${live} live` : "";
                })()}
              </span>
            </div>
            <div className="chat-page__panel-head-actions">
              <ApprovalBell />
              <button type="button" className="chat-page__new-session-btn" onClick={handleNewChat}>
                + New
              </button>
              <button
                type="button"
                className="chat-page__mobile-close-btn"
                aria-label="Close sessions"
                onClick={closeMobileNav}
              >
                ×
              </button>
            </div>
          </div>

          <SessionList
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onDelete={async (taskId) => {
              // Confirm so a stray hover-click doesn't drop a 200-turn
              // session. Native confirm is fine — single-operator app;
              // a styled dialog would be over-engineering.
              if (!window.confirm("Delete this session? This cannot be undone.")) {
                return;
              }
              try {
                const { deleteTask } = await import("../lib/api");
                await deleteTask(taskId);
                // If we just deleted the currently-selected session,
                // navigate back to the empty sessions root so the
                // conversation area doesn't try to render a now-stale
                // task ID.
                if (taskId === selectedTaskId) {
                  const wid = urlWorkspaceId ?? effectiveWorkspaceId;
                  navigate(wid ? `/w/${wid}/sessions` : `/sessions`);
                }
                await fetchTasks();
              } catch (err) {
                console.error("Failed to delete task", err);
                useTaskStore.setState({
                  error: err instanceof Error ? err.message : "Delete failed",
                });
              }
            }}
            onSelect={(taskId) => {
              // Clear cross-task ephemera, but only the error banner —
              // `isWaitingForResponse` is a global flag that doubles as
              // the Stop-button trigger. Earlier this was reset to
              // false on every selection, including tapping the
              // currently-active session, which left the button as a
              // disabled Send and blocked the user from cancelling.
              // ChatInput now derives Stop visibility from the
              // server-truth task.state + WS activeAgents in addition
              // to this flag, so leaving it alone here is safe — when
              // the newly-selected task isn't actively running, the
              // other signals naturally evaluate false.
              useTaskStore.setState({ error: null });
              closeMobileNav();
              // Route to the task's own workspace path directly. Hitting
              // bare /sessions/<id> would trigger WorkspaceAwareTask-
              // Redirect to mount, fetch the registry, render a
              // "Loading…" placeholder for one route cycle, then
              // redirect here anyway. Lookup is O(N) on tasks but N is
              // the SessionList count — fine.
              // Codex review: if the task somehow lacks a
              // workspaceId, reuse the URL-current wid from the
              // params hook so we still skip the redirect; bare
              // /sessions/<id> stays a last-resort fallback only.
              const target = tasks.find((t) => t.id === taskId);
              const wid = target?.workspaceId ?? urlWorkspaceId;
              navigate(wid ? `/w/${wid}/sessions/${taskId}` : `/sessions/${taskId}`);
            }}
          />
          {/* Desktop renders SessionContextPanel inside the drawer
              (always visible alongside SessionList). On mobile it
              lives in the bottom-sheet below — rendering both would
              double-mount the polling effect and confuse a11y. */}
          {!isMobile && (
            <SessionContextPanel
              selectedTask={selectedTask}
              workspaces={workspaces}
              effectiveWorkspaceId={effectiveWorkspaceId}
            />
          )}
        </aside>

        <section className="chat-page__conversation-panel" aria-label="Conversation">
          {/* P4 — sticky session summary banner. Pulls latest
              compaction's summaryText for this task and surfaces it
              above the message stream so the user always knows what
              context the model is anchored on (vs scrolling 5+
              screens up to find the [Previous summary] inline). */}
          <SessionSummaryBanner taskId={selectedTaskId ?? null} />
          {showWorkbenchNarrative && selectedTask?.blockedNarrative ? (
            <WorkbenchNarrativeBanner
              narrative={selectedTask.blockedNarrative}
              changeReviewActionCount={changeReviewActionCount}
              changeReviewBreakdown={changeReviewBreakdown}
            />
          ) : null}
          <ChatArea />
          <ChangeReviewPanel
            key={selectedTaskId ?? "no-task"}
            taskId={selectedTaskId ?? null}
            taskState={selectedTask?.state ?? null}
            onActionableCountChange={handleChangeReviewActionCount}
          />
          {/* CancelBar removed — the Stop button in ChatInput already
              covers cancel; the inline chat-turn-timing strip already
              shows "Working (Xm Ys)" so the dedicated banner was
              duplicate noise. */}
          <SendErrorBar />
          <ChatInput />
        </section>

        {/* Mobile context bottom sheet — same SessionContextPanel that
           lived inside the drawer on earlier iterations, lifted out
           so the drawer is purely a navigator. ⓘ in the mobile bar
           opens it; tap-outside or Escape closes it. */}
        <aside
          ref={contextPanelRef}
          id="chat-context-sheet"
          className="chat-page__mobile-context-sheet"
          data-mobile-open={mobileNav === "context" ? "true" : "false"}
          aria-label="Session details"
          role={isMobile ? "dialog" : undefined}
          aria-modal={isMobile && mobileNav === "context" ? true : undefined}
          tabIndex={isMobile && mobileNav === "context" ? -1 : undefined}
          inert={!(isMobile && mobileNav === "context")}
        >
          <div className="chat-page__mobile-context-sheet-head">
            <span className="chat-page__mobile-context-sheet-title">Session details</span>
            <button
              type="button"
              className="chat-page__mobile-close-btn"
              aria-label="Close session details"
              onClick={closeMobileNav}
            >
              ×
            </button>
          </div>
          {/* Mobile-only: SessionContextPanel hosted inside the
              bottom sheet so users can pull up token/cost/workspace
              meta without losing the chat surface. Desktop renders
              its own copy inside the sessions drawer above. */}
          {isMobile && (
            <SessionContextPanel
              selectedTask={selectedTask}
              workspaces={workspaces}
              effectiveWorkspaceId={effectiveWorkspaceId}
            />
          )}
        </aside>

        {/* Mobile backdrop — only rendered at mobile breakpoint when a
           drawer is open. Tapping it closes the active overlay. The
           viewport guard avoids leaking the body-scroll lock + invisible
           backdrop button into desktop after a resize. */}
        {isMobile && mobileNav !== null && (
          // tabIndex=-1 keeps the backdrop out of the keyboard tab
          // order — the Tab trap inside the dialog handles focus
          // cycling. A focusable backdrop would let Tab escape the
          // dialog (a11y regression for screen-reader users).
          <button
            type="button"
            tabIndex={-1}
            className="chat-page__mobile-backdrop"
            aria-label="Close overlay"
            onClick={closeMobileNav}
          />
        )}
      </div>

      {/* sidechain teammate transcript drawer.
          Self-mounts when uiStore.transcriptDrawer is non-null. Lives at
          the page root so it overlays the session workspace. */}
      <TeammateTranscriptDrawer />
    </div>
  );
}

function SendErrorBar() {
  const error = useTaskStore((s) => s.error);
  if (!error) return null;
  return (
    <div className="chat-send-error" role="alert">
      <span aria-hidden="true">❌</span>
      <span className="chat-send-error__msg">Send failed: {error}</span>
      <span className="chat-send-error__hint">Press Enter to retry</span>
      <button
        type="button"
        className="chat-send-error__dismiss"
        aria-label="Dismiss error"
        onClick={() => useTaskStore.setState({ error: null })}
      >
        ×
      </button>
    </div>
  );
}

// CancelBar component removed — cancel is now exposed via the
// ChatInput Stop button + the inline chat-turn-timing strip.

function stateTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (state.includes("done") || state.includes("completed")) {
    return "success";
  }
  if (state.includes("failed") || state.includes("error") || state.includes("blocked")) {
    return "danger";
  }
  if (
    state.includes("running") ||
    state.includes("progress") ||
    state.includes("pending") ||
    state.includes("waiting") ||
    state.includes("recovered")
  ) {
    return "warning";
  }
  return "neutral";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export type SessionFilterBucket =
  | "all"
  | "running"
  | "waiting"
  | "recovered"
  | "blocked"
  | "done"
  | "failed";

// Canonical TASK_STATES come from `packages/core/src/domain/task.ts`. We
// can't import that package directly into the web bundle, so we mirror
// the bucket assignments here. Keep in sync: any new state added to
// TASK_STATES must be classified below or it'll silently fall through
// to bucket "all" and the chip filters won't see it.
const RUNNING_STATES = new Set([
  "INTAKE", "CLARIFYING", "PLANNING", "EXECUTING",
  "REVIEWING", "TESTING", "QUEUED", "IN_PROGRESS",
  "AWAITING_TEAMMATES",
]);
const WAITING_STATES = new Set(["WAITING", "PAUSED", "AWAITING_APPROVAL"]);
const DONE_STATES = new Set(["DONE", "PR_OPEN", "MERGE_WAITING"]);
const FAILED_STATES = new Set(["FAILED", "CANCELLED"]);
const BLOCKED_STATES = new Set(["BLOCKED"]);

/** Map a task.state string into one of the filter buckets. Set-based for
 * canonical TASK_STATES; falls back to substring heuristics for legacy
 * or non-canonical values (e.g. lowercase "done", "completed", etc.). */
export function stateBucket(state: string): SessionFilterBucket {
  const upper = state.trim().toUpperCase();
  if (DONE_STATES.has(upper)) return "done";
  if (BLOCKED_STATES.has(upper)) return "blocked";
  if (FAILED_STATES.has(upper)) return "failed";
  if (WAITING_STATES.has(upper)) return "waiting";
  if (RUNNING_STATES.has(upper)) return "running";
  // Fallback: legacy DB rows or shapes the canonical sets don't cover.
  const s = state.toLowerCase();
  if (s.includes("done") || s.includes("completed")) return "done";
  if (s.includes("blocked")) return "blocked";
  if (s.includes("waiting") || s.includes("awaiting") || s.includes("paused")) return "waiting";
  if (s.includes("failed") || s.includes("error") || s.includes("cancel")) return "failed";
  if (s.includes("running") || s.includes("progress") || s.includes("pending") || s.includes("queue")) return "running";
  return "all";
}

type SessionDisplayTask = Pick<
  TaskSummary,
  "state" | "recoveryNotice" | "waitReason" | "approvalState" | "blockedNarrative"
>;

type TaskBlockedNarrative = NonNullable<TaskSummary["blockedNarrative"]>;

function narrativeBucket(status: TaskBlockedNarrative["status"]): SessionFilterBucket {
  switch (status) {
    case "waiting":
      return "waiting";
    case "recovering":
      return "recovered";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
  }
}

function narrativeLabel(reason: TaskBlockedNarrative["reason"]): string {
  switch (reason) {
    case "awaiting_plan_approval":
      return "Plan approval";
    case "awaiting_approval":
      return "Approval";
    case "paused_by_user":
      return "Paused";
    case "cancel_requested":
      return "Cancelled";
    case "runtime_recovery_in_progress":
      return "Recovered";
    case "blocked_by_recovery":
      return "Recovery blocked";
    case "executor_unavailable":
      return "Executor";
    case "rate_limited":
      return "Rate limited";
    case "model_unavailable":
      return "Model unavailable";
    case "max_turns_reached":
      return "Max turns";
  }
}

function narrativeTitle(narrative: TaskBlockedNarrative): string {
  return narrative.nextAction
    ? `${narrative.message} ${narrative.nextAction}`
    : narrative.message;
}

export function sessionDisplayState(task: SessionDisplayTask): {
  bucket: SessionFilterBucket;
  label: string;
  title?: string;
} {
  if (task.blockedNarrative) {
    return {
      bucket: narrativeBucket(task.blockedNarrative.status),
      label: narrativeLabel(task.blockedNarrative.reason),
      title: narrativeTitle(task.blockedNarrative),
    };
  }
  if (task.recoveryNotice?.status === "blocked") {
    return {
      bucket: "blocked",
      label: "Blocked",
      title: `${task.recoveryNotice.reason} · user action needed`,
    };
  }
  if (task.recoveryNotice?.status === "recovered") {
    return {
      bucket: "recovered",
      label: "Recovered",
      title: task.recoveryNotice.reason,
    };
  }
  const approvalState = task.approvalState?.toLowerCase();
  if (
    task.waitReason ||
    approvalState === "pending" ||
    approvalState === "requested" ||
    stateBucket(task.state) === "waiting"
  ) {
    const title = task.waitReason ?? task.approvalState;
    return {
      bucket: "waiting",
      label: "Waiting",
      ...(title ? { title } : {}),
    };
  }
  const bucket = stateBucket(task.state);
  if (bucket === "blocked") return { bucket, label: "Blocked" };
  if (task.state.toUpperCase() === "AWAITING_TEAMMATES") {
    return { bucket, label: "Awaiting teammates" };
  }
  return { bucket, label: task.state };
}

function shouldPollSessionUsage(task: SessionDisplayTask): boolean {
  const bucket = sessionDisplayState(task).bucket;
  return bucket === "running" || bucket === "waiting" || bucket === "recovered";
}

export function workbenchNarrativeContent(
  narrative: TaskBlockedNarrative,
  _changeReviewActionCount = 0,
  _breakdown?: { toDecide: number; toApply: number },
): { label: string; message: string; nextAction?: string } {
  return {
    label: narrativeLabel(narrative.reason),
    message: narrative.message,
    ...(narrative.nextAction ? { nextAction: narrative.nextAction } : {}),
  };
}

function WorkbenchNarrativeBanner({
  narrative,
  changeReviewActionCount,
  changeReviewBreakdown,
}: {
  narrative: TaskBlockedNarrative;
  changeReviewActionCount: number;
  changeReviewBreakdown?: { toDecide: number; toApply: number };
}) {
  const content = workbenchNarrativeContent(
    narrative,
    changeReviewActionCount,
    changeReviewBreakdown,
  );
  return (
    <div
      className={`chat-workbench-narrative chat-workbench-narrative--${narrative.severity}`}
      role={narrative.severity === "error" ? "alert" : "status"}
    >
      <div className="chat-workbench-narrative__main">
        <span className="chat-workbench-narrative__label">{content.label}</span>
        <span className="chat-workbench-narrative__message">{content.message}</span>
      </div>
      {content.nextAction ? (
        <div className="chat-workbench-narrative__next">{content.nextAction}</div>
      ) : null}
    </div>
  );
}

function formatCompactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return `${value}`;
  if (abs < 100_000) return `${(value / 1000).toFixed(1)}K`;
  if (abs < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
}

// CLIENT_MODEL_RATES + estimateSessionCost removed — Magister doesn't
// track per-session cost (the mirrored rate table drifted from real
// pricing, unknown models silently showed $0.00).

function shortenPath(path: string): string {
  if (path.length <= 30) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path.slice(0, 27) + "...";
  return `.../${parts.slice(-2).join("/")}`;
}

function SessionContextPanel({
  selectedTask,
  workspaces,
  effectiveWorkspaceId,
}: {
  selectedTask: TaskSummary | null;
  workspaces: WorkspaceView[];
  effectiveWorkspaceId: string | null;
}) {
  const [usage, setUsage] = useState<TaskUsageSummary | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [tokenBreakdownOpen, setTokenBreakdownOpen] = useState(false);
  const selectedTaskId = selectedTask?.id ?? null;
  const shouldPollUsage = selectedTask ? shouldPollSessionUsage(selectedTask) : false;

  useEffect(() => {
    if (!selectedTaskId) {
      setUsage(null);
      setLoadingUsage(false);
      return;
    }
    let cancelled = false;
    const isVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const loadUsage = async (showLoading: boolean) => {
      if (showLoading) {
        setLoadingUsage(true);
        setUsage(null);
      }
      try {
        const next = await getTaskUsage(selectedTaskId);
        if (!cancelled) setUsage(next);
      } catch {
        if (!cancelled) setUsage(null);
      } finally {
        if (!cancelled && showLoading) setLoadingUsage(false);
      }
    };

    void loadUsage(true);
    if (!shouldPollUsage) {
      return () => { cancelled = true; };
    }

    const poll = () => {
      if (isVisible()) void loadUsage(false);
    };
    const onVisibilityChange = () => {
      if (isVisible()) void loadUsage(false);
    };
    const intervalId = window.setInterval(poll, SESSION_CONTEXT_USAGE_POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [selectedTaskId, shouldPollUsage]);

  const workspaceId = selectedTask?.workspaceId ?? effectiveWorkspaceId;
  const workspace = workspaceId
    ? workspaces.find((item) => item.id === workspaceId)
    : null;
  const workspaceLabel = workspace?.label ?? workspaceId ?? "No workspace";
  const workspacePath = workspace?.basePath ?? "";
  const hasUsage = usage !== null && usage.turnCount > 0;
  const totalTokens = usage
    ? usage.totalInputTokens + usage.totalOutputTokens
    : 0;
  const hasUsageSplit = usage
    ? usage.usageSplitKnown !== false && (
        usage.leaderInputTokens !== undefined
        || usage.leaderOutputTokens !== undefined
        || usage.teammateInputTokens !== undefined
        || usage.teammateOutputTokens !== undefined
      )
    : false;
  const leaderTokens = usage
    ? hasUsageSplit
      ? (usage.leaderInputTokens ?? 0) + (usage.leaderOutputTokens ?? 0)
      : totalTokens
    : 0;
  const teammateTokens = usage && hasUsageSplit
    ? (usage.teammateInputTokens ?? 0) + (usage.teammateOutputTokens ?? 0)
    : 0;
  // Use the leader's PEAK input (high-water mark of context size) rather
  // than the latest single call's input. The latest call is volatile —
  // tool-result-only follow-ups, post-model-switch resets, and auxiliary
  // sub-calls produce tiny inputs (e.g. 72 tokens) that misrepresent how
  // full the leader's context actually got. Peak is leader-scoped in the
  // repo (teammate sizes excluded) so it's a stable, honest utilization
  // signal. Fall back to latest only if peak is unavailable (legacy rows).
  const contextInput =
    usage?.leaderPeakInputTokens
    ?? usage?.peakInputTokens
    ?? usage?.leaderLatestInputTokens
    ?? usage?.latestInputTokens;
  const contextWindow = usage?.leaderContextWindow ?? usage?.contextWindow ?? null;
  const hasContext = typeof contextInput === "number" && contextInput > 0 && typeof contextWindow === "number" && contextWindow > 0;
  const contextPctRaw = hasContext
    ? Math.min(100, Math.max(0, (contextInput / contextWindow) * 100))
    : 0;
  // When the true % is < 1% (e.g. 829 / 1M = 0.08%) the fill renders
  // as 0 visible pixels and the bar looks "missing". Floor to 2% so
  // users see SOMETHING — still visually distinct from a meaningful
  // fill level. data-tone below still drives off the raw value so
  // coloring stays honest.
  const contextPct = hasContext && contextPctRaw > 0 && contextPctRaw < 2 ? 2 : contextPctRaw;
  const primaryModel = usage?.leaderLatestModel ?? usage?.latestModel ?? usage?.models[0] ?? null;

  return (
    <section className="chat-page__session-context" aria-label="Session Context">
      <div className="chat-page__session-context-head">
        <span className="chat-page__session-context-title">Session Context</span>
        {selectedTask ? (
          <span className={`chat-page__session-context-state chat-page__state-badge--${stateTone(sessionDisplayState(selectedTask).bucket)}`}>
            {sessionDisplayState(selectedTask).label}
          </span>
        ) : null}
      </div>

      {selectedTask ? (
        <div className="chat-page__session-context-task">
          <span className="chat-page__session-context-label">Task ID</span>
          <code className="chat-page__session-context-code" title={selectedTask.id}>
            {selectedTask.id}
          </code>
        </div>
      ) : null}

      <div className="chat-page__session-context-workspace">
        <span className="chat-page__session-context-label">Workspace</span>
        <span className="chat-page__session-context-value" title={workspaceLabel}>{workspaceLabel}</span>
        {workspacePath ? (
          <span className="chat-page__session-context-path" title={workspacePath}>
            {shortenPath(workspacePath)}
          </span>
        ) : null}
      </div>

      <div className="chat-page__session-context-grid">
        <div>
          <span
            className="chat-page__session-context-label"
            title="Cumulative tokens recorded for this task. Total includes the leader and spawned teammates; the split below separates them."
          >
            Tokens
          </span>
          <span className="chat-page__session-context-value">
            {loadingUsage
              ? "Loading..."
              : hasUsage
              ? <span
                  style={{ cursor: "pointer" }}
                  onClick={() => setTokenBreakdownOpen((v) => !v)}
                  title="Click to expand per-role breakdown"
                >
                  <span>{`${formatCompactTokens(totalTokens)} total`}</span>
                  <span style={{ marginLeft: 4 }}>{tokenBreakdownOpen ? "▴" : "▾"}</span>
                </span>
              : "No token usage yet"}
          </span>
          {hasUsage && hasUsageSplit && (leaderTokens > 0 || teammateTokens > 0) ? (
            <div className="chat-page__session-context-subvalue" style={{ whiteSpace: "normal" }}>
              {`Leader ${formatCompactTokens(leaderTokens)} · Team ${formatCompactTokens(teammateTokens)}`}
            </div>
          ) : null}
          {tokenBreakdownOpen && usage?.byRole && usage.byRole.length > 0 ? (
            <div style={{ marginTop: 2, lineHeight: 1.5 }}>
              {usage.byRole
                .sort((a, b) => b.totalTokens - a.totalTokens)
                .map((r) => (
                  <div key={`${r.roleId}:${r.model}`} className="chat-page__session-context-subvalue" style={{ display: "flex", flexWrap: "wrap", gap: "0 6px", overflow: "visible", whiteSpace: "normal", textOverflow: "unset" }}>
                    <span style={{ fontWeight: 600 }}>{r.roleId}</span>
                    <span>{formatCompactTokens(r.totalTokens)}</span>
                    <span style={{ opacity: 0.6 }}>({r.model})</span>
                  </div>
                ))}
            </div>
          ) : null}
        </div>
        <div>
          <span className="chat-page__session-context-label">Turns</span>
          <span className="chat-page__session-context-value">
            {hasUsage ? `${usage.turnCount} turn${usage.turnCount === 1 ? "" : "s"}` : "-"}
          </span>
        </div>
        {/* Cost removed — Magister is single-operator and does not track
            cost (was a client-side estimate against a hand-maintained
            rate table that drifted from actual pricing). Session
            identification is via Task ID block at the top of the panel. */}
      </div>

      <div className="chat-page__session-context-meter">
        <div className="chat-page__session-context-meter-row">
          <span
            className="chat-page__session-context-label"
            title="Leader's context utilization — peak prompt size this session vs the leader model's context window."
          >
            Leader context
          </span>
          <span className="chat-page__session-context-value">
            {hasContext ? `${formatCompactTokens(contextInput)} / ${formatCompactTokens(contextWindow)}` : "-"}
          </span>
        </div>
        <span
          className="chat-page__session-context-track"
          aria-hidden="true"
          // `data-tone` drives color thresholds reliably — previous
          // approach used CSS attribute-substring matching against
          // the style string ("--context-used: 6") which conflated 6%
          // and 60% (both matched the ochre selector). Computed in TS
          // once, free from string-pattern fragility.
          data-tone={contextPct >= 80 ? "danger" : contextPct >= 60 ? "warn" : "ok"}
          style={{ ["--context-used" as string]: `${contextPct}%` }}
        />
      </div>

      {primaryModel ? (
        <div className="chat-page__session-context-model" title={usage?.models.join(", ")}>
          {primaryModel}
        </div>
      ) : null}
    </section>
  );
}

// P3 Phase 3 — collapsed 7-bucket chip set into 5: all / active / stuck /
// done / failed. "active" rolls up running + waiting; "stuck" rolls up
// blocked + recovered. Per-session display labels stay granular — this
// only collapses the filter chip granularity. To revert, swap the
// SESSION_FILTER_CHIPS array back to:
//   ["all", "running", "waiting", "recovered", "blocked", "done", "failed"]
// and drop the matchesFilterChip helper below.
type SessionFilterChip = "all" | "active" | "stuck" | "done" | "failed";
const SESSION_FILTER_CHIPS: readonly SessionFilterChip[] = [
  "all",
  "active",
  "stuck",
  "done",
  "failed",
];
const SESSION_FILTER_CHIP_LABEL: Record<SessionFilterChip, string> = {
  all: "All",
  active: "Active",
  stuck: "Stuck",
  done: "Done",
  failed: "Failed",
};

function matchesFilterChip(chip: SessionFilterChip, bucket: SessionFilterBucket): boolean {
  if (chip === "all") return true;
  if (chip === "active") return bucket === "running" || bucket === "waiting";
  if (chip === "stuck") return bucket === "blocked" || bucket === "recovered";
  if (chip === "done") return bucket === "done";
  if (chip === "failed") return bucket === "failed";
  return true;
}

/** One-line at-a-glance preview for a session card, mirroring how
 *  BoardPage surfaces the latest work item. Picks the most actionable
 *  field: blocker > waitReason > nextWorkItemSummary > latestAnswer >
 *  latestArtifactSummary. Returns null when nothing useful exists so
 *  the card collapses cleanly instead of rendering an empty row. */
function sessionPreviewText(task: TaskSummary): string | null {
  const candidates = [
    task.latestBlocker,
    task.waitReason,
    task.nextWorkItemSummary,
    task.latestAnswer,
    task.latestArtifactSummary,
  ];
  for (const raw of candidates) {
    const text = raw?.trim();
    if (!text) continue;
    // Skip raw internal event-type names that leak via
    // latestArtifactSummary — patterns like `safe_apply.change_review_created`
    // or `leader.text_delta`: snake_case_dot_separated identifiers
    // with no spaces. Those read as engineering log lines in the UI,
    // not human session previews.
    if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(text)) continue;
    // Collapse whitespace + cap length so wrapping is predictable
    // inside the narrow drawer.
    const compact = text.replace(/\s+/g, " ");
    return compact.length > 140 ? compact.slice(0, 137) + "…" : compact;
  }
  return null;
}

function SessionList({
  tasks,
  selectedTaskId,
  onSelect,
  onDelete,
}: {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SessionFilterChip>("all");
  // Render the appropriate modifier glyph (⌘ on Mac, Ctrl elsewhere)
  // next to the search hint. Stable per session so a single useMemo
  // avoids recomputing the UA scan on every keystroke.
  const modSym = useMemo(() => getModSymbol(), []);

  const trimmedSearch = search.trim().toLowerCase();
  const isFiltering = trimmedSearch.length > 0 || filter !== "all";

  const filteredTasks = tasks.filter((task) => {
    if (!matchesFilterChip(filter, sessionDisplayState(task).bucket)) return false;
    if (trimmedSearch && !task.title.toLowerCase().includes(trimmedSearch)) return false;
    return true;
  });

  // When the user is actively filtering, show all matches — the "Show N
  // more" pagination only makes sense for the default unfiltered list
  // where we collapse a long history to keep the panel compact.
  const visibleTasks = isFiltering || expanded
    ? filteredTasks
    : filteredTasks.slice(0, SESSION_LIST_DEFAULT_LIMIT);
  const hasMore = !isFiltering && filteredTasks.length > SESSION_LIST_DEFAULT_LIMIT;

  return (
    <div className="chat-page__session-list">
      {tasks.length === 0 ? (
        <div className="chat-page__empty-list">No sessions yet.</div>
      ) : (
        <>
          <div className="chat-page__session-controls">
            <div className="chat-page__session-search-wrap">
              <span className="chat-page__session-search-icon" aria-hidden="true" />
              <input
                type="search"
                id="chat-session-search-input"
                data-focus-target="session-search"
                className="chat-page__session-search"
                placeholder="Search sessions"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search sessions"
                autoComplete="off"
                spellCheck={false}
              />
              {search ? (
                <button
                  type="button"
                  className="chat-page__session-search-clear"
                  aria-label="Clear session search"
                  onClick={() => setSearch("")}
                >
                  ×
                </button>
              ) : (
                <span className="chat-page__session-search-kbd" aria-hidden="true">{modSym} K</span>
              )}
            </div>
            {/* Group of toggle buttons rather than tablist — these don't
               implement arrow-key navigation between them, and pressing a
               chip doesn't reveal a tab panel; aria-pressed is the right
               semantic. */}
            <div className="chat-page__session-filter" role="group" aria-label="Filter sessions by state">
              {SESSION_FILTER_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  aria-pressed={filter === chip}
                  className={`chat-page__session-filter-chip${filter === chip ? " chat-page__session-filter-chip--active" : ""}`}
                  onClick={() => setFilter(chip)}
                >
                  {SESSION_FILTER_CHIP_LABEL[chip]}
                </button>
              ))}
            </div>
          </div>

          {filteredTasks.length === 0 ? (
            <div className="chat-page__empty-list">
              <EmptyState
                icon="◇"
                title="No sessions match"
                description={
                  isFiltering
                    ? "Try a different filter or search term."
                    : "Start a new session to get going."
                }
                compact
              />
            </div>
          ) : (
            visibleTasks.map((task) => {
              const isActive = task.id === selectedTaskId;
              const displayState = sessionDisplayState(task);
              const preview = sessionPreviewText(task);
              return (
                // The row is a positioned wrapper so the delete button can
                // overlap the row's top-right corner without breaking the
                // existing button-as-row semantics. Nested <button>s are
                // invalid HTML, so the delete control sits as a SIBLING of
                // the row button, positioned absolutely over its corner.
                <div
                  key={task.id}
                  className={`chat-page__session-item-wrap${isActive ? " chat-page__session-item-wrap--active" : ""}`}
                >
                  <button
                    type="button"
                    className={`chat-page__session-item${isActive ? " chat-page__session-item--active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelect(task.id)}
                  >
                    <div className="chat-page__session-title" title={task.title}>{task.title}</div>
                    {preview ? (
                      <div className="chat-page__session-preview" title={preview}>{preview}</div>
                    ) : null}
                    <div className="chat-page__session-footer">
                      <span className="chat-page__session-meta">Updated {timeAgo(task.updatedAt)}</span>
                      <span
                        className={`chat-page__state-badge chat-page__state-badge--${stateTone(displayState.bucket)}`}
                        title={displayState.title}
                      >
                        {displayState.label}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="chat-page__session-delete"
                    aria-label={`Delete session: ${task.title}`}
                    title="Delete session"
                    onClick={(e) => {
                      // Don't bubble into the row's onClick — that would
                      // navigate AND delete on the same gesture.
                      e.stopPropagation();
                      onDelete(task.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
          {hasMore && (
            <button
              type="button"
              className="chat-page__session-toggle"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? `Show less` : `Show ${filteredTasks.length - SESSION_LIST_DEFAULT_LIMIT} more sessions`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
