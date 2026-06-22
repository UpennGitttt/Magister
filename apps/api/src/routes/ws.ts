import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";

import { wsHub } from "../ws/hub";

export async function registerWebSocketRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url ?? "/ws", `http://${req.headers.host}`);
    const taskId = url.searchParams.get("taskId");
    const taskIds = taskId ? [taskId] : [];

    wsHub.addClient(socket, taskIds);

    // Send welcome message
    socket.send(JSON.stringify({ type: "connected", clientCount: wsHub.getClientCount() }));

    // Handle subscribe/unsubscribe messages from client
    socket.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string; taskId?: string };
        if (msg.type === "subscribe" && msg.taskId) {
          const client = [...(wsHub as unknown as { clients: Set<{ ws: unknown; taskIds: Set<string> }> }).clients].find(
            (c) => c.ws === socket,
          );
          if (client) client.taskIds.add(msg.taskId);
        }
      } catch {
        // ignore malformed messages
      }
    });
  });

  app.get("/ws/status", async () => ({
    ok: true,
    data: { clients: wsHub.getClientCount(), seq: wsHub.getSeq() },
  }));
}
