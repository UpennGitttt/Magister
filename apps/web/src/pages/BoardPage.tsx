import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AgentAvatar } from "../components/agents/AgentAvatar";
import { PageHeader } from "../components/layout/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusBadge } from "../components/ui/StatusBadge";
import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { dismissTaskAttention, undismissTaskAttention } from "../lib/api";
import { request } from "../lib/request";
import type { TaskSummary } from "../lib/types";
import "../styles/board.css";

type DismissToast = {
  /** Single task or "all visible" bulk dismissal. */
  taskIds: string[];
  /** Human label for the toast body. */
  label: string;
  /** Wall-clock ms when the toast was shown (for the 5s timer). */
  shownAt: number;
};

type BoardColumnKey = "queued" | "in_progress" | "attention" | "completed";

type BoardColumn = {
  key: BoardColumnKey;
  title: string;
};

const BOARD_COLUMNS: BoardColumn[] = [
  { key: "queued", title: "Queued" },
  { key: "in_progress", title: "In Progress" },
  // "Attention" (not "In Review") — the column holds failed/blocked
  // tasks needing human attention, not reviewer-stage work. Cancelled
  // → Completed (user's own Stop, no follow-up needed); failed/blocked
  // → Attention (real anomalies).
  { key: "attention", title: "Attention" },
  { key: "completed", title: "Completed" },
];

function sourceLabel(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === "feishu") return "Feishu";
  if (normalized === "cli") return "CLI";
  return "Web";
}

function sourceClassName(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === "feishu") return "task-source task-source--feishu";
  if (normalized === "cli") return "task-source task-source--cli";
  return "task-source task-source--web";
}

function formatRelativeTime(value: string | number | null | undefined): string {
  if (!value) return "--";

  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "--";

  const diffMs = Math.max(0, Date.now() - timestamp);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(month / 12)}y ago`;
}

function toShortTaskId(taskId: string): string {
  if (!taskId) return "--";
  return taskId.length <= 10 ? taskId : `${taskId.slice(0, 4)}...${taskId.slice(-4)}`;
}

function statusVariant(state: string): "success" | "warning" | "danger" | "primary" | "neutral" {
  const normalized = state.trim().toLowerCase();
  if (["failed", "error"].some((v) => normalized.includes(v))) return "danger";
  if (["done", "completed", "success"].some((v) => normalized.includes(v))) return "success";
  if (["running", "in_progress", "executing", "reviewing", "blocked", "awaiting_teammates"].some((v) => normalized.includes(v))) return "warning";
  if (["pending", "queued", "created"].some((v) => normalized.includes(v))) return "primary";
  return "neutral";
}

function mapTaskToColumn(task: TaskSummary): BoardColumnKey {
  // User-acknowledged Attention cards → Completed. UI-only — `state`
  // stays FAILED/BLOCKED so other consumers (sidebar, feishu, metrics)
  // still see the true terminal state.
  if (task.attentionDismissedAt) {
    return "completed";
  }
  const normalized = task.state.trim().toLowerCase();

  // Split terminal states by intent:
  //   cancelled → Completed (user pressed Stop; no anomaly to surface)
  //   failed / error / blocked → Attention (real problem needs eyes)
  if (normalized.includes("cancel")) {
    return "completed";
  }
  if (["failed", "error", "blocked"].some((v) => normalized.includes(v))) {
    return "attention";
  }
  if (["done", "completed", "success"].some((v) => normalized.includes(v))) {
    return "completed";
  }
  if (normalized.includes("review")) {
    return "attention";
  }
  if (["running", "in_progress", "executing", "working", "awaiting_teammates"].some((v) => normalized.includes(v))) {
    return "in_progress";
  }
  return "queued";
}

function inferAssignedAgent(task: TaskSummary): string {
  const capability = (task.nextCapability ?? "").toLowerCase();
  if (capability.includes("review")) return "Reviewer";
  if (capability.includes("land")) return "Lander";
  if (capability.includes("eval")) return "Evaluator";
  if (capability.includes("code") || capability.includes("implement")) return "Coder";

  const state = task.state.toLowerCase();
  if (state.includes("review")) return "Reviewer";
  // Default to Leader for every other state. Pre-leader-loop Magister
  // routed terminal tasks through a "Lander" role; in the new
  // architecture the Leader agent owns the full lifecycle and only
  // delegates explicitly via `spawn_teammate`. Showing LANDER on every
  // Feishu task in the In-Review / Completed columns was a stale
  // heuristic — the lander role was never actually invoked.
  return "Leader";
}

function lastEvent(task: TaskSummary): string {
  return (
    task.nextWorkItemSummary?.trim() ||
    task.latestArtifactSummary?.trim() ||
    task.latestAnswer?.trim() ||
    task.latestBlocker?.trim() ||
    task.waitReason?.trim() ||
    "No recent event"
  );
}

/** Per P3 §5.4, surface the source of the latest-event preview as an
 * uppercase mono label above the text: BLOCKER / WAIT REASON / FAILURE /
 * LATEST ARTIFACT / LATEST. State-driven (failed → FAILURE) overrides
 * the nextWorkItem chain so a failed card reads "FAILURE · …" instead of
 * a generic "LATEST". */
function eventLabel(task: TaskSummary): string | null {
  const state = task.state.toLowerCase();
  if (state.includes("failed") || state.includes("error")) return "Failure";
  if (task.latestBlocker?.trim()) return "Blocker";
  if (task.waitReason?.trim()) return "Wait reason";
  if (task.nextWorkItemSummary?.trim()) return "Latest";
  if (task.latestArtifactSummary?.trim()) return "Latest artifact";
  if (task.latestAnswer?.trim()) return "Latest";
  return null;
}

/** State tone → 3px left border color on the card. */
function cardStateTone(state: string): "run" | "review" | "fail" | "done" {
  const s = state.trim().toLowerCase();
  if (s.includes("failed") || s.includes("error")) return "fail";
  if (s.includes("review") || s.includes("blocked") || s.includes("waiting") || s.includes("approval")) return "review";
  if (s.includes("done") || s.includes("completed") || s.includes("success")) return "done";
  return "run";
}

const BOARD_COLLAPSED_STORAGE_KEY = "magister:boardCollapsed";
const LEGACY_BOARD_COLLAPSED_STORAGE_KEY = "ucm:boardCollapsed";

function readCollapsedFromStorage(): Record<BoardColumnKey, boolean> {
  if (typeof window === "undefined") return {} as Record<BoardColumnKey, boolean>;
  try {
    let raw = window.localStorage.getItem(BOARD_COLLAPSED_STORAGE_KEY);
    if (!raw) {
      raw = window.localStorage.getItem(LEGACY_BOARD_COLLAPSED_STORAGE_KEY);
      if (raw) {
        window.localStorage.setItem(BOARD_COLLAPSED_STORAGE_KEY, raw);
        window.localStorage.removeItem(LEGACY_BOARD_COLLAPSED_STORAGE_KEY);
      }
    }
    if (!raw) return {} as Record<BoardColumnKey, boolean>;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {} as Record<BoardColumnKey, boolean>;
  } catch {
    return {} as Record<BoardColumnKey, boolean>;
  }
}

export function BoardPage() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Undo toast for Attention dismissals. `dismissToast` is null when no
  // toast is showing; setting it kicks the 5s timer. Optimistic local
  // mutation lives in `tasks` (we flip attentionDismissedAt) so the UI
  // updates instantly; the network PUT runs in parallel. Undo calls
  // DELETE on the same endpoint and reverses the local flip.
  const [dismissToast, setDismissToast] = useState<DismissToast | null>(null);
  const dismissToastTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!dismissToast) return;
    dismissToastTimer.current = window.setTimeout(() => {
      setDismissToast(null);
      dismissToastTimer.current = null;
    }, 5_000);
    return () => {
      if (dismissToastTimer.current) {
        window.clearTimeout(dismissToastTimer.current);
        dismissToastTimer.current = null;
      }
    };
  }, [dismissToast]);

  const handleDismiss = useCallback((task: TaskSummary) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, attentionDismissedAt: Date.now() } : t)),
    );
    setDismissToast({
      taskIds: [task.id],
      label: `Dismissed: ${task.title || task.id}`,
      shownAt: Date.now(),
    });
    void dismissTaskAttention(task.id).catch(() => {
      // Revert optimistic update on failure.
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, attentionDismissedAt: null } : t)),
      );
      setDismissToast(null);
    });
  }, []);

  const handleUndoDismiss = useCallback(() => {
    if (!dismissToast) return;
    const ids = dismissToast.taskIds;
    setTasks((prev) =>
      prev.map((t) => (ids.includes(t.id) ? { ...t, attentionDismissedAt: null } : t)),
    );
    setDismissToast(null);
    void Promise.all(ids.map((id) => undismissTaskAttention(id).catch(() => null)));
  }, [dismissToast]);

  // Per-column collapse state, persisted to localStorage so users
  // don't have to re-collapse the same noisy column on every visit.
  // Empty record = all expanded; flipping a key true collapses that
  // column's card list (header stays visible with the count badge).
  const [collapsed, setCollapsed] = useState<Record<BoardColumnKey, boolean>>(readCollapsedFromStorage);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(BOARD_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));
      window.localStorage.removeItem(LEGACY_BOARD_COLLAPSED_STORAGE_KEY);
    } catch {
      /* quota / private mode — non-fatal, state simply doesn't persist */
    }
  }, [collapsed]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 880px)");
    const expandForMobile = () => {
      if (query.matches) {
        setCollapsed({} as Record<BoardColumnKey, boolean>);
      }
    };
    expandForMobile();
    query.addEventListener("change", expandForMobile);
    return () => query.removeEventListener("change", expandForMobile);
  }, []);
  const navigate = useNavigate();

  // Path A — board kanban must scope to active workspace; otherwise
  // it bleeds tasks from other workspaces into the same columns.
  const { wid: urlWorkspaceId } = useParams<{ wid?: string }>();
  const { activeId: pickerWorkspaceId } = useActiveWorkspace();
  const effectiveWorkspaceId = urlWorkspaceId ?? pickerWorkspaceId ?? null;

  const fetchTasks = useCallback(async () => {
    try {
      setError(null);
      const qs = effectiveWorkspaceId
        ? `?limit=100&workspaceId=${encodeURIComponent(effectiveWorkspaceId)}`
        : "?limit=100";
      const payload = await request<{ items?: TaskSummary[] } | TaskSummary[]>(`/tasks${qs}`);
      const items = Array.isArray(payload) ? payload : (payload.items ?? []);
      setTasks([...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkspaceId]);

  useEffect(() => {
    void fetchTasks();

    const timer = window.setInterval(() => {
      void fetchTasks();
    }, 30_000);

    return () => window.clearInterval(timer);
  }, [fetchTasks]);

  const byColumn = useMemo(() => {
    const grouped: Record<BoardColumnKey, TaskSummary[]> = {
      queued: [],
      in_progress: [],
      attention: [],
      completed: [],
    };

    for (const task of tasks) {
      grouped[mapTaskToColumn(task)].push(task);
    }

    return grouped;
  }, [tasks]);

  const summary = useMemo(() => {
    const total = tasks.length;
    const running = tasks.filter((task) => {
      const column = mapTaskToColumn(task);
      return column === "in_progress" || column === "attention";
    }).length;

    const completed = tasks.filter((task) => {
      const state = task.state.toLowerCase();
      return state.includes("done") || state.includes("completed") || state.includes("success");
    }).length;

    const failed = tasks.filter((task) => {
      const state = task.state.toLowerCase();
      return state.includes("failed") || state.includes("error");
    }).length;

    return { total, running, completed, failed };
  }, [tasks]);

  return (
    <div className="page board-page">
      <div className="board-layout">
        {/* Refresh button removed; Board auto-polls every 30s via the
            setInterval in this component. Tasks carry their own
            freshness from the auto-poll + WS events. */}
        <PageHeader
          title="Board"
          description={`Latest ${summary.total} tasks · ${summary.running} running · ${summary.completed} completed · ${summary.failed} failed`}
        />

        {error ? <p className="board-inline-error">{error}</p> : null}

        {tasks.length === 0 && !loading && !error ? (
          <EmptyState
            icon="▦"
            title="Board is empty"
            description="Tasks will appear here as they're created."
          />
        ) : null}

        {dismissToast ? (
          <div className="board-undo-toast" role="status" aria-live="polite">
            <span className="board-undo-toast__label">{dismissToast.label}</span>
            <button
              type="button"
              className="board-undo-toast__btn"
              onClick={handleUndoDismiss}
            >
              Undo
            </button>
          </div>
        ) : null}

        {tasks.length > 0 ? (
        <div className="board-columns" role="list" aria-label="Task board columns">
          {BOARD_COLUMNS.map((column) => {
            const columnTasks = byColumn[column.key];
            const isCollapsed = !!collapsed[column.key];
            const listId = `board-column-list-${column.key}`;
            return (
              <section
                key={column.key}
                className={`board-column${isCollapsed ? " board-column--collapsed" : ""}`}
                data-column={column.key}
                data-collapsed={isCollapsed ? "true" : "false"}
                role="listitem"
              >
                <button
                  type="button"
                  className="board-column-header"
                  aria-expanded={!isCollapsed}
                  aria-controls={listId}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [column.key]: !prev[column.key] }))
                  }
                >
                  <span className="board-column-header__chevron" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <h2>{column.title}</h2>
                  <span className="board-column-count">{columnTasks.length}</span>
                </button>

                <div
                  id={listId}
                  className="board-column-list"
                  hidden={isCollapsed}
                >
                  {columnTasks.length === 0 ? (
                    null
                  ) : (
                    columnTasks.map((task) => {
                      const assignedAgent = inferAssignedAgent(task);
                      const tone = cardStateTone(task.state);
                      const label = eventLabel(task);
                      const isAttention = column.key === "attention";
                      return (
                        <div key={task.id} className="task-card-shell">
                        {isAttention ? (
                          <button
                            type="button"
                            className="task-card-dismiss"
                            title="Dismiss from Attention"
                            aria-label={`Dismiss ${task.title || "task"} from Attention column`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDismiss(task);
                            }}
                          >
                            ✓
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`task-card task-card--${tone}`}
                          data-column={column.key}
                          data-task-id={task.id}
                          draggable
                          aria-label={`${task.title || "Untitled task"} · ${task.state} · ${assignedAgent}`}
                          onClick={() => {
                            // Navigate to the task's OWN workspace
                            // path, not the active-workspace path.
                            // Hitting `/sessions/<id>` would force
                            // WorkspaceAwareTaskRedirect to mount,
                            // fetch the registry, and flash a
                            // "Loading…" screen for one
                            // route cycle before redirecting here
                            // anyway. The task carries its own
                            // workspaceId; use it.
                            const workspaceId = task.workspaceId || effectiveWorkspaceId;
                            navigate(workspaceId ? `/w/${workspaceId}/sessions/${task.id}` : `/sessions/${task.id}`);
                          }}
                        >
                          <div className="task-card-title">{task.title || "Untitled task"}</div>

                          <div className="task-card-meta-row">
                            <span className="task-id">{toShortTaskId(task.id)}</span>
                            <span className={sourceClassName(task.source)}>{sourceLabel(task.source)}</span>
                          </div>

                          {label ? (
                            <div className="task-card-event">
                              <div className="task-card-event__lbl">{label}</div>
                              <div className="task-card-event__text">{lastEvent(task)}</div>
                            </div>
                          ) : null}

                          <div className="task-card-footer">
                            <span className="task-card-role">
                              <AgentAvatar name={assignedAgent} size={18} />
                              <span>{assignedAgent}</span>
                            </span>
                            <span className="task-card-footer-spacer" aria-hidden="true" />
                            <span className="task-time">{formatRelativeTime(task.updatedAt)}</span>
                          </div>

                          <span className="task-card-state-sr">
                            <StatusBadge label={task.state} variant={statusVariant(task.state)} dot />
                          </span>
                        </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
        ) : null}
      </div>
    </div>
  );
}
