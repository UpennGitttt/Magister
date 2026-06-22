import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { areMagisterChannelsDisabled } from "../integrations/feishu/feishu-config";
import { resolveFeishuApprovalCallback } from "../services/feishu-approval-callback-service";

const feishuApprovalCallbackSchema = z.object({
  approvalId: z.string().min(1),
  bindingId: z.string().min(1),
  resolution: z.enum(["approved", "rejected"]),
  expiresAt: z.string().min(1),
  signedToken: z.string().min(1),
  actorId: z.string().min(1).optional(),
  comment: z.string().min(1).optional(),
});

const FEISHU_CALLBACK_STATUS: Record<string, number> = {
  invalid_feishu_config: 503,
  invalid_feishu_callback_signature: 400,
  expired_feishu_callback: 400,
  approval_not_found: 404,
  task_not_found: 404,
  conversation_binding_not_found: 404,
  approval_binding_mismatch: 409,
};

export async function registerChannelCallbackRoutes(app: FastifyInstance) {
  app.post("/channel-callbacks/feishu", async (request, reply) => {
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

    const body = feishuApprovalCallbackSchema.parse(request.body);
    const result = await resolveFeishuApprovalCallback({
      approvalId: body.approvalId,
      bindingId: body.bindingId,
      resolution: body.resolution,
      expiresAt: body.expiresAt,
      signedToken: body.signedToken,
      ...(body.actorId ? { actorId: body.actorId } : {}),
      ...(body.comment ? { comment: body.comment } : {}),
    });

    if (!result.ok) {
      reply.status(FEISHU_CALLBACK_STATUS[result.code] ?? 400);
      return {
        ok: false,
        error: {
          code: result.code,
          message: result.message,
        },
      };
    }

    return {
      ok: true,
      data: result,
    };
  });
}
