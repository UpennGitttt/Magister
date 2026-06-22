import type { FastifyInstance } from "fastify";

import { getWorkspaceInsights } from "../services/workspace-insights-service";
import { getWorkspaceSummary } from "../services/workspace-summary-service";

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get("/workspace/summary", async () => {
    const summary = await getWorkspaceSummary();
    return {
      ok: true,
      data: summary,
    };
  });

  app.get("/workspace/insights", async () => {
    const insights = await getWorkspaceInsights();
    return {
      ok: true,
      data: insights,
    };
  });
}
