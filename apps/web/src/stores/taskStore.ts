import { create } from "zustand";
import type { TaskSummary } from "../lib/types";
import { getTasks } from "../lib/api";
import { getCurrentSelectedTaskId } from "./currentRoute";

/**
 * Task store — does NOT own "what task is selected". Selection lives in the
 * URL (read via `useSelectedTaskId()`). Non-React code reads the URL via
 * `getCurrentSelectedTaskId()`.
 *
 * What this store DOES own:
 *  - `tasks` — the list of all tasks (fetched from API)
 *  - `loading` / `error` — list-fetch state
 *  - `isWaitingForResponse` — per-send lifecycle (set true in handleSend,
 *    cleared on terminal events / cancel / send failure / explicit nav)
 *  - `chatRefreshCounter` — bump to force ChatArea to refetch the message
 *    list of the currently-selected task
 */
type TaskState = {
  tasks: TaskSummary[];
  loading: boolean;
  error: string | null;
  isWaitingForResponse: boolean;
  chatRefreshCounter: number;
  fetchTasks: (opts?: { workspaceId?: string | null }) => Promise<void>;
  setWaitingForResponse: (waiting: boolean) => void;
  refreshChat: () => void;
  /**
   * Called when a task reaches terminal state. If the terminated task is
   * the one the user is currently viewing (URL match), unlock the input
   * and bump the refresh counter so messages reconcile from the API.
   */
  completeSend: (taskId: string) => void;
};

// Workspace-switch race guard. fetchTasks fires whenever the active
// workspace changes; the in-flight call from the previous workspace can
// still be travelling when we start the new one. Without a guard, the
// late response from the OLD workspace overwrites the freshly-set list
// from the NEW workspace. The fix tags each call with a monotonic id
// and drops responses that arrive after a newer call started.
let fetchTasksGeneration = 0;

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  loading: false,
  error: null,
  isWaitingForResponse: false,
  chatRefreshCounter: 0,
  fetchTasks: async (opts) => {
    const myGen = ++fetchTasksGeneration;
    set({ error: null });
    try {
      // Path A — when called with a workspaceId, server filters
      // server-side. Without it, list is global (used by stats /
      // legacy callers).
      const tasks = await getTasks(opts);
      if (myGen !== fetchTasksGeneration) {
        // A newer fetchTasks started after we did. Discard our
        // (now stale) response so it doesn't clobber whatever the
        // newer call set / will set.
        return;
      }
      set({ tasks });
    } catch (err) {
      if (myGen !== fetchTasksGeneration) return;
      set({ error: err instanceof Error ? err.message : "Failed to fetch tasks" });
    }
  },
  setWaitingForResponse: (waiting) => set({ isWaitingForResponse: waiting }),
  refreshChat: () =>
    set((state) => ({ chatRefreshCounter: state.chatRefreshCounter + 1 })),
  completeSend: (taskId: string) => {
    if (getCurrentSelectedTaskId() === taskId) {
      set((state) => ({
        isWaitingForResponse: false,
        error: null,
        chatRefreshCounter: state.chatRefreshCounter + 1,
      }));
    }
  },
}));
