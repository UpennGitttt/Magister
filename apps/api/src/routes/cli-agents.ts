import type { FastifyInstance } from "fastify";

import { getCliAgentStatus } from "../services/cli-agent-status-service";

/**
 * GET /cli-agents/status — onboarding probe for the three external CLI
 * coding agents (codex / claude-code / opencode). Reports install +
 * login state so the Settings → Setup wizard can guide first-run
 * configuration. See `cli-agent-status-service.ts`.
 */
export async function registerCliAgentRoutes(app: FastifyInstance) {
  app.get("/cli-agents/status", async () => {
    return {
      ok: true,
      data: {
        items: await getCliAgentStatus(),
      },
    };
  });
}
