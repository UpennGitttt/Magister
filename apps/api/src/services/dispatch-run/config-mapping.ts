import type { ApiModelConfig, ApiProviderConfig } from "../../executors/api-executor-adapter";
import { readExecutorConfigFile, type ModelProfileRecord } from "../executor-config-service";

type ExecutorConfig = Awaited<ReturnType<typeof readExecutorConfigFile>>;

export function mapProviders(
  providers: ExecutorConfig["providers"],
): Record<string, ApiProviderConfig> {
  return Object.fromEntries(
    Object.entries(providers).map(([providerRef, provider]) => {
      const mapped: ApiProviderConfig = {
        providerRef,
        vendor: provider.vendor,
        transport: provider.transport === "api" ? "http" : "fake",
        ...(provider.apiDialect === "openai_chat_completions" ||
        provider.apiDialect === "anthropic_messages"
          ? { apiDialect: provider.apiDialect }
          : {}),
      };

      if (provider.label) {
        mapped.label = provider.label;
      }

      if (provider.baseUrl) {
        mapped.baseUrl = provider.baseUrl;
      }

      if (provider.auth) {
        mapped.auth = provider.auth;
      }

      if (provider.headers && provider.headers.length > 0) {
        mapped.headers = provider.headers;
      }

      if (provider.quirks) {
        mapped.quirks = provider.quirks as ApiProviderConfig["quirks"];
      }

      return [providerRef, mapped] as const;
    }),
  );
}

function mapModelThinking(defaultReasoning: ModelProfileRecord["defaultReasoning"]): ApiModelConfig["thinking"] {
  if (!defaultReasoning) {
    return undefined;
  }

  return {
    mode: defaultReasoning.mode,
    ...(defaultReasoning.effort ? { effort: defaultReasoning.effort } : {}),
    ...(defaultReasoning.budgetTokens ? { budgetTokens: defaultReasoning.budgetTokens } : {}),
  };
}

export function mapModels(models: Record<string, ModelProfileRecord>): Record<string, ApiModelConfig> {
  return Object.fromEntries(
    Object.entries(models).map(([modelRef, model]) => {
      const mapped: ApiModelConfig = {
        modelRef,
        modelName: model.modelName,
      };

      if (model.providerRefs) {
        mapped.providerRefs = model.providerRefs;
      }

      if (model.requestOverrides) {
        mapped.requestOverrides = model.requestOverrides;
      }

      const thinking = mapModelThinking(model.defaultReasoning);
      if (thinking) {
        mapped.thinking = thinking;
      }

      if (model.capabilityHints) {
        mapped.capabilityHints = model.capabilityHints;
      }

      // §5.9 — propagate limits to the dispatch transport.
      if (typeof model.contextWindow === "number") {
        mapped.contextWindow = model.contextWindow;
      }
      if (typeof model.maxOutputTokens === "number") {
        mapped.maxOutputTokens = model.maxOutputTokens;
      }

      return [modelRef, mapped] as const;
    }),
  );
}
