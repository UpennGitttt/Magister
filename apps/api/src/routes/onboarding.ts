import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  configureLeaderProvider,
  ONBOARDING_PROVIDER_PRESETS,
} from "../services/onboarding-provider-service";
import { getOnboardingStatus } from "../services/onboarding-status-service";

/**
 * Onboarding endpoints backing the Settings → Setup wizard:
 *   GET  /onboarding/status           — snapshot of providers / CLI / feishu
 *   GET  /onboarding/provider-presets — the provider choices the wizard offers
 *   POST /onboarding/provider         — one-shot "configure the leader" from a key
 */
export async function registerOnboardingRoutes(app: FastifyInstance) {
  app.get("/onboarding/status", async () => {
    return {
      ok: true,
      data: await getOnboardingStatus(),
    };
  });

  app.get("/onboarding/provider-presets", async () => {
    return {
      ok: true,
      data: {
        items: ONBOARDING_PROVIDER_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          vendor: preset.vendor,
          apiDialect: preset.apiDialect,
          baseUrl: preset.baseUrl,
          defaultModel: preset.defaultModel,
          requiresBaseUrl: preset.requiresBaseUrl ?? false,
        })),
      },
    };
  });

  const configureSchema = z.object({
    presetId: z.string().trim().min(1),
    apiKey: z.string().min(1),
    modelName: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().optional(),
  });

  app.post("/onboarding/provider", async (request, reply) => {
    const body = configureSchema.parse(request.body ?? {});
    try {
      const result = await configureLeaderProvider(body);
      return { ok: true, data: result };
    } catch (err) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "configure_failed",
          message: err instanceof Error ? err.message : "Failed to configure provider",
        },
      };
    }
  });
}
