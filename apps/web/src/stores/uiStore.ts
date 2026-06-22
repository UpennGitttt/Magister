import { create } from "zustand";

const PLAN_MODE_STORAGE_KEY = "magister:planMode";
const LEGACY_PLAN_MODE_STORAGE_KEY = "ucm:planMode";
const GOAL_MODE_STORAGE_KEY = "magister:goalMode";
const LEGACY_GOAL_MODE_STORAGE_KEY = "ucm:goalMode";

function detectInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function readInitialPlanMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = window.localStorage.getItem(PLAN_MODE_STORAGE_KEY);
    if (value !== null) return value === "1";
    const legacyValue = window.localStorage.getItem(LEGACY_PLAN_MODE_STORAGE_KEY);
    if (legacyValue !== null) {
      window.localStorage.removeItem(LEGACY_PLAN_MODE_STORAGE_KEY);
      if (legacyValue === "1") window.localStorage.setItem(PLAN_MODE_STORAGE_KEY, "1");
      return legacyValue === "1";
    }
  } catch {
    return false;
  }
  return false;
}

function readInitialGoalMode(): boolean {
  // Intentionally NOT persisted to localStorage. Goal mode is a
  // "I want autonomous, long-running execution for this specific
  // request" intent; persisting it means a sticky toggle turns every
  // casual chat into a goal-mode task long after the user forgot it
  // was on. New sessions / reloads always start with goal off.
  return false;
}

type UiState = {
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  /**
   * Session-wide "Plan first" toggle (spec §3). Persisted to
   * localStorage so it survives reloads, route changes, and switching
   * between chat sessions — matching Claude Code's permission-mode
   * model where plan mode is a session attribute, not a per-message
   * flag. Every `createTask` reads this and sends it as `planFirst`
   * on the request body; the leader loop forces plan-mode entry when
   * it's true.
   */
  planMode: boolean;
  setPlanMode: (on: boolean) => void;
  togglePlanMode: () => void;
  /**
   * Goal mode (Ralph loop) — when on, the next createTask submits
   * `goal: { objective: prompt, maxWallSeconds? }` so the new task
   * runs autonomously: the worker auto-injects continuation
   * mailbox rows after each turn until the model calls
   * `mark_goal_complete`, the user pauses/cancels, or wall-time
   * elapses. Persisted to localStorage like planMode — when off
   * the toggle stays off across reloads. Per-task once submitted;
   * doesn't affect tasks already running.
   */
  goalMode: boolean;
  setGoalMode: (on: boolean) => void;
  toggleGoalMode: () => void;
  /**
   * sidechain teammate transcript drawer.
   * When set, ChatPage renders a side panel that fetches the full
   * teammate transcript via the `/tasks/:taskId/teammate/:parentToolUseId/
   * transcript` lazy-load endpoint. Triggered from `ToolPairRow` when
   * a teammate's `transcriptEventCount` exceeds TRANSCRIPT_INLINE_CAP
   * (or any time the user clicks "Open transcript →").
   */
  transcriptDrawer: { taskId: string; parentToolUseId: string; teammateName?: string } | null;
  openTranscriptDrawer: (params: { taskId: string; parentToolUseId: string; teammateName?: string }) => void;
  closeTranscriptDrawer: () => void;
  /**
   * Pending keyboard-shortcut focus target. AppShell's global ⌘K /
   * ⌘⏎ handler sets this + navigates to /sessions if needed; ChatPage
   * consumes on mount or whenever the field flips, focuses the matching
   * ref, then clears via `consumeFocusTarget`. Set to `null` when no
   * pending focus is queued. Two-step so it works regardless of
   * whether the user is already on the chat page or arriving fresh.
   */
  pendingFocus: "session-search" | "composer" | null;
  requestFocus: (target: "session-search" | "composer") => void;
  consumeFocusTarget: () => void;
};

export const useUiStore = create<UiState>((set, get) => ({
  theme: detectInitialTheme(),
  setTheme: (theme) => {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
    set({ theme });
  },
  planMode: readInitialPlanMode(),
  setPlanMode: (on) => {
    if (typeof window !== "undefined") {
      try {
        if (on) window.localStorage.setItem(PLAN_MODE_STORAGE_KEY, "1");
        else window.localStorage.removeItem(PLAN_MODE_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_PLAN_MODE_STORAGE_KEY);
      } catch {
        // localStorage may be disabled — silently fall back to in-memory.
      }
    }
    set({ planMode: on });
  },
  togglePlanMode: () => {
    get().setPlanMode(!get().planMode);
  },
  goalMode: readInitialGoalMode(),
  setGoalMode: (on) => {
    // No localStorage write — goal mode is intentionally per-session
    // (see readInitialGoalMode comment). The GOAL_MODE_STORAGE_KEY
    // constant is kept around for one release so a stale entry from
    // earlier versions gets actively cleared on the first toggle.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(GOAL_MODE_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_GOAL_MODE_STORAGE_KEY);
      } catch {
        // localStorage may be disabled — no-op.
      }
    }
    set({ goalMode: on });
  },
  toggleGoalMode: () => {
    get().setGoalMode(!get().goalMode);
  },
  transcriptDrawer: null,
  openTranscriptDrawer: (params) => set({ transcriptDrawer: params }),
  closeTranscriptDrawer: () => set({ transcriptDrawer: null }),
  pendingFocus: null,
  requestFocus: (target) => set({ pendingFocus: target }),
  consumeFocusTarget: () => set({ pendingFocus: null }),
}));
