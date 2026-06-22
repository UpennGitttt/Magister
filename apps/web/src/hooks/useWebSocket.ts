import { useEffect, useRef, useCallback } from "react";

type WSEvent = {
  type: string;
  taskId: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: string;
  agent?: { role: string; id: string };
};

type UseWebSocketOptions = {
  onEvent: (event: WSEvent) => void;
  taskId?: string;
  enabled?: boolean;
  onConnectionChange?: (connected: boolean) => void;
};

export function useWebSocket({
  onEvent,
  taskId,
  enabled = true,
  onConnectionChange,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const disposed = useRef(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!enabled || disposed.current) return;

    // Determine WS URL — use same host as page, but ws: protocol
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = taskId
      ? `${protocol}//${window.location.host}/api/ws?taskId=${taskId}`
      : `${protocol}//${window.location.host}/api/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Clear reconnect timer on successful connect
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = undefined;
        }
        onConnectionChange?.(true);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as WSEvent;
          if (parsed.type && parsed.type !== "connected") {
            onEventRef.current(parsed);
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        onConnectionChange?.(false);
        // Reconnect after 3 seconds unless disposed
        if (enabled && !disposed.current) {
          reconnectTimer.current = window.setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        onConnectionChange?.(false);
        ws.close();
      };
    } catch {}
  }, [enabled, onConnectionChange, taskId]);

  useEffect(() => {
    disposed.current = false;
    connect();
    return () => {
      disposed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      onConnectionChange?.(false);
    };
  }, [connect, onConnectionChange]);

  // Method to subscribe to a specific task
  const subscribe = useCallback((newTaskId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", taskId: newTaskId }));
    }
  }, []);

  return { subscribe };
}
