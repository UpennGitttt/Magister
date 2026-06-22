import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { areMagisterChannelsDisabled, parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { applyFeishuCredentials } from "../integrations/feishu/feishu-credentials";
import { createFeishuClient } from "../integrations/feishu/feishu-client";
import { buildFeishuSetupState } from "../integrations/feishu/feishu-setup-state";
import {
  getFeishuWebSocketGatewayStatus,
  startFeishuWebSocketGateway,
  stopFeishuWebSocketGateway,
} from "../integrations/feishu/feishu-websocket-gateway";
import { deliverQueuedFeishuOutboundEvents } from "../services/feishu-outbound-delivery-service";

function buildInvalidConfigResponse(missingFields: string[]) {
  return {
    ok: false,
    error: {
      code: "invalid_feishu_config",
      message: "Feishu setup is incomplete",
      details: {
        missingFields,
      },
    },
  };
}

function buildChannelsDisabledResponse() {
  return {
    ok: false,
    error: {
      code: "channels_disabled",
      message: "Channel integrations are disabled by MAGISTER_DISABLE_CHANNELS",
    },
  };
}

export async function registerFeishuRoutes(app: FastifyInstance) {
  const feishuOutboundDeliverySchema = z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      eventIds: z.array(z.string().min(1)).max(50).optional(),
    })
    .optional();

  app.get("/feishu/setup", async () => {
    const config = parseFeishuConfigFromEnv();
    const state = buildFeishuSetupState(config);

    return {
      ok: true,
      data: state,
    };
  });

  const feishuCredentialsSchema = z.object({
    appId: z.string().trim().min(1).optional(),
    appSecret: z.string().trim().min(1).optional(),
    verificationToken: z.string().trim().min(1).optional(),
    encryptKey: z.string().trim().min(1).optional(),
  });

  // Persist creds supplied by the onboarding wizard, then best-effort reconnect
  // the gateway so they take effect without an API restart.
  app.post("/feishu/setup", async (request) => {
    const body = feishuCredentialsSchema.parse(request.body ?? {});
    const state = applyFeishuCredentials(body);

    let gateway = getFeishuWebSocketGatewayStatus();
    if (!areMagisterChannelsDisabled() && state.ready) {
      try {
        await stopFeishuWebSocketGateway();
        gateway = await startFeishuWebSocketGateway();
      } catch {
        gateway = getFeishuWebSocketGatewayStatus();
      }
    }

    return { ok: true, data: { state, gateway } };
  });

  app.post("/feishu/setup/test-connection", async (_, reply) => {
    if (areMagisterChannelsDisabled()) {
      reply.status(409);
      return buildChannelsDisabledResponse();
    }

    const config = parseFeishuConfigFromEnv();
    const state = buildFeishuSetupState(config);

    if (!state.ready) {
      reply.status(400);
      return buildInvalidConfigResponse(state.missingFields);
    }

    const client = createFeishuClient({
      appId: config.appId!,
      appSecret: config.appSecret!,
    });
    await client.getTenantAccessToken();

    return {
      ok: true,
      data: state,
    };
  });

  app.post("/feishu/outbound/deliver", async (request, reply) => {
    if (areMagisterChannelsDisabled()) {
      reply.status(409);
      return buildChannelsDisabledResponse();
    }

    const config = parseFeishuConfigFromEnv();
    const state = buildFeishuSetupState(config);

    if (!state.ready) {
      reply.status(400);
      return buildInvalidConfigResponse(state.missingFields);
    }

    const body = feishuOutboundDeliverySchema.parse(request.body ?? {});
    const result = await deliverQueuedFeishuOutboundEvents({
      ...(body?.limit ? { limit: body.limit } : {}),
      ...(body?.eventIds ? { eventIds: body.eventIds } : {}),
    });

    return {
      ok: true,
      data: result,
    };
  });

  app.get("/feishu/gateway/status", async () => {
    return {
      ok: true,
      data: getFeishuWebSocketGatewayStatus(),
    };
  });

  app.post("/feishu/gateway/start", async (_, reply) => {
    const status = await startFeishuWebSocketGateway();
    if (status.connectionState === "error") {
      reply.status(503);
      return {
        ok: false,
        error: {
          code: "feishu_gateway_start_failed",
          message: status.lastError ?? "Feishu gateway failed to start",
        },
      };
    }

    return {
      ok: true,
      data: status,
    };
  });

  app.post("/feishu/gateway/stop", async () => {
    return {
      ok: true,
      data: await stopFeishuWebSocketGateway(),
    };
  });
}
