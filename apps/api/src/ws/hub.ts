import type { WebSocket } from "ws";

export type TaskWsEvent = {
  type: string;
  requestId: string;
  data: Record<string, unknown>;
  timestamp: string;
  seq?: number;
  agent?: Record<string, unknown>;
};

type WSClient = {
  ws: WebSocket;
  taskIds: Set<string>; // subscribed task IDs ("*" = all)
};

export class WebSocketHub {
  private clients = new Set<WSClient>();
  private seqCounter = 0;

  addClient(ws: WebSocket, taskIds: string[]) {
    const client: WSClient = { ws, taskIds: new Set(taskIds.length ? taskIds : ["*"]) };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
    return client;
  }

  broadcast(taskId: string, event: TaskWsEvent) {
    this.seqCounter++;
    const payload = JSON.stringify({ ...event, taskId, seq: this.seqCounter });

    for (const client of this.clients) {
      if (client.ws.readyState !== 1) continue; // OPEN = 1
      if (client.taskIds.has("*") || client.taskIds.has(taskId)) {
        try {
          client.ws.send(payload);
        } catch {
          // ignore send errors on broken sockets
        }
      }
    }
  }

  getSeq() {
    return this.seqCounter;
  }

  getClientCount() {
    return this.clients.size;
  }
}

// Singleton
export const wsHub = new WebSocketHub();
