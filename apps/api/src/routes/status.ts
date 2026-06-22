import type { FastifyInstance } from "fastify";

import { buildStatusReport } from "../services/status-service";

/**
 * `GET /status` — read-only aggregator for the Settings → Status
 * panel and the chat `/status` slash command. Returns the snapshot
 * defined by `StatusReport` in `status-service.ts`. Single panel
 * showing "what is this system loaded with right now?" — workspace,
 * agents, MCP, skills, active task. Token usage / rate limits live
 * on the dashboard and are deliberately NOT echoed here.
 */
export async function registerStatusRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { workspaceId?: string; taskId?: string } }>(
    "/status",
    async (request) => {
      // `workspaceId` lets the panel re-render for a different workspace
      // without re-routing the whole page. Falls back to the registry's
      // default when missing. Path A.
      const workspaceId =
        typeof request.query.workspaceId === "string" && request.query.workspaceId.length > 0
          ? request.query.workspaceId
          : null;
      // `taskId` (optional) makes the panel session-aware. The chat
      // `/status` slash command passes the active task; sidebar
      // Settings → Status leaves it unset so the panel stays at
      // workspace-level.
      const taskId =
        typeof request.query.taskId === "string" && request.query.taskId.length > 0
          ? request.query.taskId
          : null;
      const report = await buildStatusReport({ workspaceId, taskId });
      return { ok: true, data: report };
    },
  );
}
