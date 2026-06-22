import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { isModShortcut, isTouchOnlyDevice } from "./lib/platform";
import "./styles/tokens.css";
import { Sidebar } from "./components/Sidebar";
import { ToastStack } from "./components/ui/ToastStack";
import { DashboardPage } from "./pages/DashboardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { ChangeReviewPage } from "./pages/ChangeReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { BoardPage } from "./pages/BoardPage";
import { ChatPage } from "./pages/ChatPage";
import { useUiStore } from "./stores/uiStore";
import { useWebSocket } from "./hooks/useWebSocket";
import { useWSStore } from "./stores/wsStore";
import { useTaskStore } from "./stores/taskStore";
import { ACTIVE_WORKSPACE_STORAGE_KEY, useActiveWorkspace } from "./hooks/useActiveWorkspace";
import { useMobileDrawer } from "./hooks/useMobileDrawer";

export function AppShell() {
  return (
    <BrowserRouter>
      <AppShellFrame />
    </BrowserRouter>
  );
}

// Path A — preserve workspace scope when the global hotkey navigates
// into /sessions. If we're already on /w/:wid/sessions or its child
// route, do nothing; if we're elsewhere, infer the workspace id from
// the URL or localStorage so we don't accidentally drop the user into
// the workspace-less fallback list.
function navigateToSessionsIfNeeded(navigate: (path: string) => void) {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  if (/^\/w\/[^/]+\/sessions(\/|$)/.test(path) || path === "/sessions") return;
  const fromUrl = path.match(/^\/w\/([^/]+)/);
  let wid: string | null = fromUrl ? (fromUrl[1] ?? null) : null;
  if (!wid) {
    try {
      wid = typeof localStorage !== "undefined"
        ? localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)
        : null;
    } catch {
      wid = null;
    }
  }
  navigate(wid ? `/w/${wid}/sessions` : "/sessions");
}

function AppShellFrame() {
  const setTheme = useUiStore((s) => s.setTheme);
  const pushEvent = useWSStore((s) => s.pushEvent);
  const setConnected = useWSStore((s) => s.setConnected);
  const mobileDrawer = useMobileDrawer();
  const pageTitle = useCurrentPageTitle();

  useWebSocket({
    onEvent: pushEvent,
    enabled: true,
    onConnectionChange: setConnected,
  });

  useEffect(() => {
    setTheme("light");
  }, [setTheme]);

  // Refresh the task list whenever the tab becomes visible. Defense in
  // depth against missed WS terminal events (Tailscale Funnel hiccups,
  // browser tab suspension): if a task transitioned states while the
  // user was elsewhere, the sidebar/header would otherwise stay on the
  // last-known state until a manual refresh. Cheap (one GET /tasks),
  // only fires on focus regain, never reloads the page.
  // Global keyboard shortcuts: ⌘K/Ctrl+K focuses the session search;
  // ⌘⏎/Ctrl+Enter focuses the composer. Both navigate to /sessions if
  // not already there. Touch-only devices skip the listener entirely —
  // the hint chips are hidden on those viewports so the shortcut would
  // be invisible/unreachable anyway.
  const navigate = useNavigate();
  useEffect(() => {
    if (isTouchOnlyDevice()) return undefined;

    function onKeyDown(event: KeyboardEvent) {
      // Hot path: bail early on non-mod combos so we don't run the
      // shortcut check on every keystroke.
      if (!event.metaKey && !event.ctrlKey) return;

      // ⌘K / Ctrl+K — focus session search.
      if (isModShortcut(event, "k")) {
        event.preventDefault();
        useUiStore.getState().requestFocus("session-search");
        navigateToSessionsIfNeeded(navigate);
        return;
      }

      // ⌘⏎ / Ctrl+Enter — dispatch new task = focus the composer. We
      // explicitly DO NOT hijack this when the user is already typing
      // in a textarea/input (the chat composer's own onKeyDown handles
      // send on ⌘⏎). Without this guard, hitting ⌘⏎ inside the
      // composer would both submit AND trigger a re-focus, which is a
      // useless flicker; in a non-composer input (a settings text
      // field) it would steal focus mid-edit.
      if (isModShortcut(event, "Enter")) {
        const tag = (event.target as HTMLElement | null)?.tagName ?? "";
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        event.preventDefault();
        useUiStore.getState().requestFocus("composer");
        navigateToSessionsIfNeeded(navigate);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Scope the visibility-refetch to the active workspace —
        // otherwise we refetch the global list and overwrite the
        // workspace-filtered view that ChatPage just loaded.
        // Kimi review C3 — URL `:wid` wins over localStorage so a
        // tab pointed at `/w/myapp/...` doesn't get its sessions
        // list overwritten by another tab's localStorage selection.
        const fromUrl = window.location.pathname.match(/^\/w\/([^/]+)/);
        let workspaceId: string | null = fromUrl ? (fromUrl[1] ?? null) : null;
        if (!workspaceId) {
          try { workspaceId = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY); } catch { /* ignore */ }
        }
        void useTaskStore.getState().fetchTasks(workspaceId ? { workspaceId } : undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar mobileOpen={mobileDrawer.isOpen} onClose={mobileDrawer.close} />
      {mobileDrawer.isOpen && (
        <div
          className="app-sidebar-backdrop"
          aria-hidden="true"
          onClick={mobileDrawer.close}
        />
      )}
      <main className="app-main" data-mobile-drawer-inert>
        <header className="app-mobile-bar" aria-label="Mobile navigation">
          <button
            type="button"
            className="app-mobile-bar__menu"
            aria-label="Open navigation"
            aria-expanded={mobileDrawer.isOpen}
            onClick={mobileDrawer.open}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="app-mobile-bar__title">{pageTitle}</span>
        </header>
        {/* StatusBar removed — the in-memory wsStore.activeAgents list
            got stuck on missed terminal events (WS disconnect, browser
            tab suspension), producing a permanent floating banner.
            Cancel is still exposed via ChatInput's Stop, the Board
            task cards, and the TaskDetail page. */}
        <Routes>
          {/* Path A — workspace-scoped routes live under /w/:wid/.
                Tenant-switch model (Linear/Notion/Vercel): the URL
                segment is the source of truth for "which workspace
                am I viewing?". The picker re-routes here on switch;
                deeplinks read the segment to set the active id.
                Pages downstream still consult the
                `useActiveWorkspace` hook for label / basePath. */}
          <Route path="/w/:wid" element={<DashboardPage />} />
          <Route path="/w/:wid/board" element={<BoardPage />} />
          <Route path="/w/:wid/sessions" element={<ChatPage />} />
          <Route path="/w/:wid/sessions/:taskId/change-reviews" element={<ChangeReviewPage />} />
          <Route path="/w/:wid/sessions/:taskId" element={<ChatPage />} />
          <Route path="/w/:wid/tasks/:taskId" element={<TaskDetailPage />} />

          {/* Legacy flat routes — redirect to /w/:active/... so old
                bookmarks keep working. We can't compute :active until
                the workspace registry loads, so the redirect renders
                a small shim that waits for the hook then navigates. */}
          <Route path="/" element={<WorkspaceAwareRedirect to="" />} />
          <Route path="/board" element={<WorkspaceAwareRedirect to="/board" />} />
          <Route path="/sessions" element={<WorkspaceAwareRedirect to="/sessions" />} />
          <Route path="/sessions/:taskId/change-reviews" element={<WorkspaceAwareTaskRedirect prefix="sessions" suffix="/change-reviews" />} />
          <Route path="/sessions/:taskId" element={<WorkspaceAwareTaskRedirect prefix="sessions" />} />
          <Route path="/tasks/:taskId" element={<WorkspaceAwareTaskRedirect prefix="tasks" />} />

          {/* Settings + globals — workspace-agnostic. They reflect
                the active workspace via the picker but their own
                URLs don't carry it (matches Vercel's "/settings" vs.
                "/<team>/<project>/..." split). */}
          <Route path="/agents" element={<Navigate to="/settings?tab=agents" replace />} />
          <Route path="/skills" element={<Navigate to="/settings?tab=skills" replace />} />
          <Route path="/workspaces" element={<Navigate to="/settings?tab=workspaces" replace />} />
          <Route path="/settings" element={<SettingsPage />} />

          <Route path="/chat" element={<Navigate to="/sessions" replace />} />
          <Route path="/chat/:taskId" element={<ChatAliasRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        <ToastStack />
      </main>
    </div>
  );
}

function useCurrentPageTitle() {
  const { pathname } = useLocation();
  if (pathname.includes("/change-reviews")) return "Patch Reviews";
  if (pathname.includes("/board")) return "Board";
  if (pathname.includes("/sessions") || pathname.includes("/chat")) return "Sessions";
  if (pathname.includes("/tasks/")) return "Task Detail";
  if (pathname.includes("/agents") || pathname.includes("/skills")) return "Settings";
  if (pathname.includes("/workspaces")) return "Workspaces";
  if (pathname.includes("/settings")) return "Settings";
  return "Control Center";
}

function ChatAliasRedirect() {
  const { taskId } = useParams<{ taskId: string }>();
  return <Navigate to={taskId ? `/sessions/${taskId}` : "/sessions"} replace />;
}

/** Redirect a flat URL (e.g. `/board`) to the workspace-prefixed
 *  variant (`/w/<active>/board`) once the registry has loaded.
 *  Renders a tiny placeholder during the brief "loading active
 *  workspace" window. */
function WorkspaceAwareRedirect({ to }: { to: string }) {
  const { activeId, loading } = useActiveWorkspace();
  if (loading || !activeId) return <div className="page" style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>;
  return <Navigate to={`/w/${activeId}${to}`} replace />;
}

/** Redirect deep-linked task URLs without a workspace prefix to the
 *  prefixed equivalent. Looks up the task's ACTUAL workspaceId so a
 *  feishu link for a task in workspace `kb` routes to `/w/kb/...`
 *  even when the picker's active workspace is `workspace_main`. Falls
 *  back to active workspace if the task lookup fails (e.g. stale
 *  bookmark for a deleted task). */
function WorkspaceAwareTaskRedirect({ prefix, suffix = "" }: { prefix: "sessions" | "tasks"; suffix?: string }) {
  const { taskId } = useParams<{ taskId: string }>();
  const { activeId, loading } = useActiveWorkspace();
  const [taskWorkspace, setTaskWorkspace] = useState<string | null>(null);
  const [taskLookupDone, setTaskLookupDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!taskId) return;
    // Reset state on taskId change — otherwise an in-place navigation
    // between deep links could briefly redirect to the PREVIOUS task's
    // workspace before the new fetch lands.
    setTaskWorkspace(null);
    setTaskLookupDone(false);
    void (async () => {
      try {
        const { getTask } = await import("./lib/api");
        const task = await getTask(taskId);
        const wid = (task as { workspaceId?: string } | null | undefined)?.workspaceId;
        if (!cancelled && typeof wid === "string" && wid.length > 0) {
          setTaskWorkspace(wid);
        }
      } catch {
        /* fall back to activeId on lookup failure */
      } finally {
        if (!cancelled) setTaskLookupDone(true);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (!taskId) return <NotFound />;
  if (loading || !taskLookupDone) {
    return <div className="page" style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>;
  }
  const targetWid = taskWorkspace ?? activeId;
  if (!targetWid) {
    // Both task lookup AND active workspace are unresolvable — e.g.
    // brand-new browser session opening a deep link before the
    // workspace picker has hydrated and the task fetch 404'd. Offer
    // an escape hatch instead of an infinite "Loading…" spinner.
    return (
      <div className="page" style={{ padding: 24 }}>
        <p style={{ color: "var(--muted)", marginBottom: 12 }}>
          Workspace unavailable for this task.
        </p>
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}
        >
          Go to home
        </button>
      </div>
    );
  }
  return <Navigate to={`/w/${targetWid}/${prefix}/${taskId}${suffix}`} replace />;
}

function NotFound() {
  return (
    <div className="page">
      <h1>404</h1>
      <p style={{ color: "var(--muted)" }}>Page not found</p>
    </div>
  );
}
