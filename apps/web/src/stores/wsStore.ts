import { create } from "zustand";

type WSEvent = {
  type: string;
  taskId: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: string;
  agent?: { role: string; id: string };
};

type ActiveAgent = {
  taskId: string;
  agentId: string;
  role: string;
  currentAction: string; // e.g., "thinking", "web_search", "reading files"
  lastUpdate: string;
};

type WSState = {
  connected: boolean;
  lastSeq: number;
  activeAgents: ActiveAgent[];
  recentEvents: WSEvent[]; // last 50 events for activity feed
  setConnected: (v: boolean) => void;
  pushEvent: (event: WSEvent) => void;
};

const MAX_RECENT_EVENTS = 50;

function deriveAction(event: WSEvent): string | null {
  switch (event.type) {
    case "leader.turn_start": return "thinking...";
    case "leader.tool_call": return String(event.data.toolName ?? "tool");
    case "leader.tool_result": return null; // tool done, don't update
    case "leader.turn_complete": return null; // turn done
    case "leader.teammate_spawned": return `spawning ${event.data.teammateName}`;
    default: return null;
  }
}

export const useWSStore = create<WSState>((set) => ({
  connected: false,
  lastSeq: 0,
  activeAgents: [],
  recentEvents: [],
  setConnected: (connected) =>
    set(
      // Terminal WS events are what normally clear activeAgents. If the socket
      // drops before the terminal event is delivered, the agent entry persists
      // and the Stop button stays visible on a DONE session. Clear on
      // disconnect — reconnect/visibilitychange reconciles real state via
      // fetchTasks() anyway.
      connected ? { connected } : { connected, activeAgents: [] }
    ),
  pushEvent: (event) =>
    set((state) => {
      const recentEvents = [event, ...state.recentEvents].slice(0, MAX_RECENT_EVENTS);

      // Update active agents
      let activeAgents = [...state.activeAgents];
      const action = deriveAction(event);

      if (action) {
        const agentId = event.agent?.id ?? "leader";
        const agentKey = `${event.taskId}:${agentId}`;
        const existing = activeAgents.findIndex((a) => `${a.taskId}:${a.agentId}` === agentKey);
        const agent: ActiveAgent = {
          taskId: event.taskId,
          agentId,
          role: event.agent?.role ?? "leader",
          currentAction: action,
          lastUpdate: event.timestamp,
        };
        if (existing >= 0) {
          activeAgents[existing] = agent;
        } else {
          activeAgents.push(agent);
        }
      }

      // When a task starts executing, refresh task list so ChatArea sees EXECUTING state
      // and opens the EventSource for real-time streaming
      if (event.type === "leader.turn_start") {
        Promise.resolve().then(async () => {
          try {
            const { useTaskStore } = await import("./taskStore");
            await useTaskStore.getState().fetchTasks();
          } catch {}
        });
      }

      // Remove agents for terminal tasks and trigger final completion refresh.
      // `task:cancelled` must be included — without it, isWaitingForResponse
      // stays true on cancel and the Stop button keeps showing (was the
      // task:cancelled-event-emission fix's missing piece).
      if (
        event.type === "leader.session_complete" ||
        event.type === "task:completed" ||
        event.type === "task:failed" ||
        event.type === "task:cancelled"
      ) {
        activeAgents = activeAgents.filter((a) => a.taskId !== event.taskId);

        // Signal task completion — clears thinking dots, refreshes chat, updates sidebar.
        // `completeSend` itself checks the URL-mirror to decide whether to
        // touch waiting/refresh state for THIS task; we always refresh the
        // tasks list since other surfaces (Board, Dashboard) care.
        Promise.resolve().then(async () => {
          try {
            const { useTaskStore } = await import("./taskStore");
            const store = useTaskStore.getState();
            store.completeSend(event.taskId);
            await store.fetchTasks();
          } catch {
            // Best-effort refresh — swallow failures
          }
        });
      }

      return { recentEvents, activeAgents, lastSeq: event.seq ?? state.lastSeq };
    }),
}));
