import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";

import { registerAdapterRoutes } from "./routes/adapters";
import { registerApprovalRoutes } from "./routes/approvals";
import { registerChannelCallbackRoutes } from "./routes/channel-callbacks";
import { registerChannelEventRoutes } from "./routes/channel-events";
import { registerChangeReviewRoutes } from "./routes/change-reviews";
import { registerFeishuRoutes } from "./routes/feishu";
import { registerHealthRoutes } from "./routes/health";
import { registerRunRoutes } from "./routes/runs";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSystemRoutes } from "./routes/system";
import { registerTaskRoutes } from "./routes/tasks";
import { registerWebSocketRoutes } from "./routes/ws";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { registerSkillRoutes } from "./routes/skills";
import { registerAgentRoutes } from "./routes/agents";
import { registerMcpRoutes } from "./routes/mcp";
import { registerMemoryRoutes } from "./routes/memory";
import { registerCliBridgeRoutes } from "./routes/cli-bridge";
import { registerStatusRoutes } from "./routes/status";
import { registerWorkspaceRegistryRoutes } from "./routes/workspaces";
import { registerDiagnosticsRoutes } from "./routes/diagnostics";
import { registerUsageRoutes } from "./routes/usage";
import { registerTraceRoutes } from "./routes/traces";
import { registerApprovalRuleRoutes } from "./routes/approval-rules";
import { registerCliAgentRoutes } from "./routes/cli-agents";
import { registerOnboardingRoutes } from "./routes/onboarding";
import { registerScheduleRoutes } from "./routes/schedules";

// Fastify's default bodyLimit is 1 MB — far below what the attachment
// service permits (10 files × 10 MiB each, +33% base64 overhead +
// JSON envelope ≈ 145 MB worst case). Without this bump, a single
// modestly-sized image upload to POST /tasks crashes with
// FST_ERR_CTP_BODY_TOO_LARGE before the route handler ever runs.
// Keep this in sync with `MAX_IMAGE_SIZE_BYTES` × max file count
// in attachment-service.ts and with the proxy's `maxRequestBodySize`
// in apps/web/serve-prod.ts.
export const API_BODY_LIMIT_BYTES = 150 * 1024 * 1024; // 150 MiB

export function buildApp() {
  const app = Fastify({ bodyLimit: API_BODY_LIMIT_BYTES });

  app.register(fastifyWebsocket);
  app.register(registerWebSocketRoutes);
  app.register(registerHealthRoutes);
  app.register(registerFeishuRoutes);
  app.register(registerChannelEventRoutes);
  app.register(registerChannelCallbackRoutes);
  app.register(registerTaskRoutes);
  app.register(registerChangeReviewRoutes);
  app.register(registerRunRoutes);
  app.register(registerApprovalRoutes);
  app.register(registerAdapterRoutes);
  app.register(registerSystemRoutes);
  app.register(registerWorkspaceRoutes);
  app.register(registerSettingsRoutes);
  app.register(registerSkillRoutes);
  app.register(registerAgentRoutes);
  app.register(registerMcpRoutes);
  app.register(registerMemoryRoutes);
  app.register(registerCliBridgeRoutes);
  app.register(registerStatusRoutes);
  app.register(registerWorkspaceRegistryRoutes);
  app.register(registerDiagnosticsRoutes);
  app.register(registerUsageRoutes);
  app.register(registerTraceRoutes);
  app.register(registerApprovalRuleRoutes);
  app.register(registerCliAgentRoutes);
  app.register(registerOnboardingRoutes);
  app.register(registerScheduleRoutes);

  return app;
}
