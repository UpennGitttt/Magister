import type {
  AnthropicMessagesRequestPatch,
  ExecutorBinding,
  ModelProfile,
  ProviderConfig,
  ProviderReasoningPolicy,
} from "./types";
import { normalizeProviderRequestMetadata } from "./openai-chat-completions";
import { buildReasoningPatch } from "./reasoning-patch";

function hasPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveAnthropicRequestPath(baseUrl?: string) {
  const normalized = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  return normalized.endsWith("/v1") ? "/messages" as const : "/v1/messages" as const;
}

export function buildAnthropicMessagesRequestPatch(params: {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  reasoningPolicy?: ProviderReasoningPolicy;
}): AnthropicMessagesRequestPatch {
  const normalized = normalizeProviderRequestMetadata(params);
  const requestMetadata = {
    ...normalized,
    requestPath: resolveAnthropicRequestPath(normalized.baseUrl),
  };
  const requestOverrides = requestMetadata.requestOverrides ?? {};

  return {
    requestMetadata,
    requestBodyPatch: {
      ...requestOverrides,
      model: requestMetadata.modelName,
      ...(hasPositiveNumber(requestOverrides.max_tokens) ? {} : { max_tokens: 2048 }),
      ...buildReasoningPatch(params.provider, params.model, params.reasoningPolicy),
    },
  };
}
