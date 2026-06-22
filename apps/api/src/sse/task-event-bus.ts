/**
 * Lightweight pub/sub for per-task SSE events.
 * The leader event projector publishes here; SSE stream handlers subscribe.
 */

export type TaskSSEEvent = {
  type: string;
  requestId: string;
  data: Record<string, unknown>;
  timestamp: string;
  seq?: number;
  agent?: Record<string, unknown>;
};

type Listener = (event: TaskSSEEvent) => void;

class TaskEventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(taskId: string, listener: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);

    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  publish(taskId: string, event: TaskSSEEvent): void {
    const set = this.listeners.get(taskId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  getSubscriberCount(taskId: string): number {
    return this.listeners.get(taskId)?.size ?? 0;
  }
}

export const taskEventBus = new TaskEventBus();
