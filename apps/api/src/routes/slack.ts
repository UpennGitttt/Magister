import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { areMagisterChannelsDisabled } from "../integrations/feishu/feishu-config";
import { buildSlackClientIfConfigured } from "../integrations/slack/slack-client";
import {
  buildSlackSecretSnapshot,
  isSlackConfigReady,
  parseSlackConfig,
} from "../integrations/slack/slack-config";
import {
  getSlackSocketGatewayStatus,
  startSlackSocketGateway,
  stopSlackSocketGateway,
} from "../integrations/slack/slack-socket-gateway";
import { writeSecretValue } from "../services/local-secret-store-service";

function buildChannelsDisabledResponse() {
  return {
    ok: false,
    error: {
      code: "channels_disabled",
      message: "Channel integrations are disabled by MAGISTER_DISABLE_CHANNELS",
    },
  };
}

function buildSetupState() {
  const config = parseSlackConfig();
  return {
    ready: isSlackConfigReady(config),
    missingFields: config.missingFields,
    secrets: buildSlackSecretSnapshot(config),
  };
}

export async function registerSlackRoutes(app: FastifyInstance) {
  app.get("/slack/setup", async () => {
    return { ok: true, data: buildSetupState() };
  });

  const slackCredentialsSchema = z.object({
    botToken: z.string().trim().min(1).optional(),
    appToken: z.string().trim().min(1).optional(),
  });

  // Persist tokens, then best-effort reconnect the gateway so they take
  // effect without an API restart — mirrors POST /feishu/setup.
  app.post("/slack/setup", async (request) => {
    const body = slackCredentialsSchema.parse(request.body ?? {});
    if (body.botToken) writeSecretValue("MAGISTER_SLACK_BOT_TOKEN", body.botToken);
    if (body.appToken) writeSecretValue("MAGISTER_SLACK_APP_TOKEN", body.appToken);

    const state = buildSetupState();
    let gateway = getSlackSocketGatewayStatus();
    if (!areMagisterChannelsDisabled() && state.ready) {
      try {
        await stopSlackSocketGateway();
        gateway = await startSlackSocketGateway();
      } catch {
        gateway = getSlackSocketGatewayStatus();
      }
    }

    return { ok: true, data: { state, gateway } };
  });

  app.post("/slack/setup/test-connection", async (_, reply) => {
    if (areMagisterChannelsDisabled()) {
      reply.status(409);
      return buildChannelsDisabledResponse();
    }

    const config = parseSlackConfig();
    const state = buildSetupState();
    if (!state.ready) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "invalid_slack_config",
          message: "Slack setup is incomplete",
          details: { missingFields: state.missingFields },
        },
      };
    }

    const client = buildSlackClientIfConfigured(config.botToken);
    const identity = await client!.authTest();
    return { ok: true, data: { ...state, identity } };
  });

  app.get("/slack/gateway/status", async () => {
    return { ok: true, data: getSlackSocketGatewayStatus() };
  });

  app.post("/slack/gateway/start", async (_, reply) => {
    const status = await startSlackSocketGateway();
    if (status.connectionState === "error") {
      reply.status(503);
      return {
        ok: false,
        error: {
          code: "slack_gateway_start_failed",
          message: status.lastError ?? "Slack gateway failed to start",
        },
      };
    }
    return { ok: true, data: status };
  });

  app.post("/slack/gateway/stop", async () => {
    return { ok: true, data: await stopSlackSocketGateway() };
  });
}
