import type { FastifyInstance } from "fastify";

import { areMagisterChannelsDisabled, parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { normalizeFeishuInboundEvent } from "../integrations/feishu/feishu-event-normalizer";
import {
  serializeSignedPayload,
  verifyFeishuSignature,
} from "../integrations/feishu/feishu-signature";
import { processChannelEvent } from "../services/process-channel-event-service";

export async function registerChannelEventRoutes(app: FastifyInstance) {
  app.post("/channel-events", async (request, reply) => {
    if (areMagisterChannelsDisabled()) {
      reply.status(503);
      return {
        ok: false,
        error: {
          code: "channels_disabled",
          message: "Channel integrations are disabled by MAGISTER_DISABLE_CHANNELS",
        },
      };
    }

    const config = parseFeishuConfigFromEnv();
    const verification = verifyFeishuSignature({
      headers: request.headers,
      rawBody: serializeSignedPayload(request.body),
      config,
    });

    if (!verification.ok) {
      reply.status(401);
      return {
        ok: false,
        error: {
          code: "invalid_channel_signature",
          message: "Feishu request signature is missing or invalid",
        },
      };
    }

    try {
      const normalizedEvent = normalizeFeishuInboundEvent(request.body);
      const result = await processChannelEvent(normalizedEvent);

      reply.status(202);
      return {
        ok: true,
        data: result,
      };
    } catch (error) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "invalid_channel_event",
          message: error instanceof Error ? error.message : "Failed to normalize channel event",
        },
      };
    }
  });
}
