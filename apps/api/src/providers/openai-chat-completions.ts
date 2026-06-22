import type {
  ExecutorBinding,
  ModelProfile,
  NormalizedProviderRequestMetadata,
  OpenAIChatCompletionsRequestPatch,
  ProviderApiDialect,
  ProviderConfig,
  ProviderHeaderRule,
  ProviderReasoningPolicy,
} from "./types";
import { buildReasoningPatch, resolveReasoningPolicy } from "./reasoning-patch";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function matchesModelPattern(modelName: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }

  if (!normalizedPattern.includes("*")) {
    return modelName === normalizedPattern;
  }

  const escaped = normalizedPattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(modelName);
}

function normalizeHeaderRules(
  headers: ProviderHeaderRule[] | undefined,
  apiDialect: ProviderApiDialect,
  modelName: string,
): ProviderHeaderRule[] {
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers
    .map((header) => {
      const name = normalizeString(header?.name);
      if (!name) {
        return null;
      }

      const dialectMatches =
        !Array.isArray(header.whenDialect) ||
        header.whenDialect.length === 0 ||
        header.whenDialect.includes(apiDialect);
      if (!dialectMatches) {
        return null;
      }

      const patternMatches =
        !Array.isArray(header.whenModelPattern) ||
        header.whenModelPattern.length === 0 ||
        header.whenModelPattern.some((pattern) => matchesModelPattern(modelName, pattern));
      if (!patternMatches) {
        return null;
      }

      const normalized: ProviderHeaderRule = { name };
      const value = normalizeString(header.value);
      const secretRef = normalizeString(header.secretRef);
      const envRef = normalizeString(header.envRef);
      if (value) {
        normalized.value = value;
      }
      if (secretRef) {
        normalized.secretRef = secretRef;
      }
      if (envRef) {
        normalized.envRef = envRef;
      }
      return normalized;
    })
    .filter((header): header is ProviderHeaderRule => Boolean(header));
}

function mergeRecordValues(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(isPlainObject(left) ? left : {}),
    ...(isPlainObject(right) ? right : {}),
  };
}

export function normalizeProviderRequestMetadata(params: {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  reasoningPolicy?: ProviderReasoningPolicy;
}): NormalizedProviderRequestMetadata {
  const requestReasoningPolicy = resolveReasoningPolicy(params.model, params.reasoningPolicy);
  const providerLabel = normalizeString(params.provider.label);
  const baseUrl = normalizeString(params.provider.baseUrl);
  const commandPath = normalizeString(params.binding.commandPath);
  const providerRef =
    normalizeString(params.binding.providerRef) ||
    normalizeString(params.model.providerRefs?.api) ||
    params.provider.id;
  const modelName = params.model.modelName.trim();
  const requestOverrides = mergeRecordValues(params.provider.requestOverrides, params.model.requestOverrides);

  return {
    adapterId: params.binding.adapterId,
    providerId: params.provider.id,
    ...(providerLabel ? { providerLabel } : {}),
    providerRef,
    vendor: normalizeString(params.provider.vendor) || params.provider.vendor,
    transport: params.provider.transport,
    apiDialect: params.provider.apiDialect,
    ...(baseUrl ? { baseUrl } : {}),
    requestPath: "/chat/completions",
    auth: params.provider.auth,
    headers: normalizeHeaderRules(params.provider.headers, params.provider.apiDialect, modelName),
    modelRef: params.binding.modelRef,
    modelName,
    ...(typeof params.binding.timeoutMs === "number" && Number.isFinite(params.binding.timeoutMs)
      ? { timeoutMs: Math.round(params.binding.timeoutMs) }
      : {}),
    ...(commandPath ? { commandPath } : {}),
    ...(params.binding.sandboxMode ? { sandboxMode: params.binding.sandboxMode } : {}),
    requestOverrides,
    capabilityHints: params.model.capabilityHints ?? {},
    ...(requestReasoningPolicy ? { reasoningPolicy: requestReasoningPolicy } : {}),
  };
}

export function buildOpenAIChatCompletionsRequestPatch(params: {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  reasoningPolicy?: ProviderReasoningPolicy;
}): OpenAIChatCompletionsRequestPatch {
  const requestMetadata = normalizeProviderRequestMetadata(params);

  return {
    requestMetadata,
    requestBodyPatch: {
      ...(requestMetadata.requestOverrides ?? {}),
      model: requestMetadata.modelName,
      ...buildReasoningPatch(params.provider, params.model, params.reasoningPolicy),
    },
  };
}
