import type { ProviderApiDialect, ProviderAuthConfig } from "../providers/types";
import { resolveAgentForRole } from "./agent-resolution-service";
import { upsertAgentProfile } from "./agent-profile-service";
import { updateModelConfig, updateProviderConfig } from "./executor-config-service";
import { writeSecretValue } from "./local-secret-store-service";

export type OnboardingProviderPreset = {
  id: string;
  label: string;
  vendor: string;
  apiDialect: ProviderApiDialect;
  /** Empty for `custom` — the user must supply a base URL. */
  baseUrl: string;
  secretRef: string;
  authHeaderName: string;
  authPrefix?: string;
  /** Suggested model, shown as a placeholder / default in the wizard. */
  defaultModel: string;
  /** When true the wizard must collect a base URL (OpenAI-compatible custom endpoint). */
  requiresBaseUrl?: boolean;
};

/**
 * The provider presets the onboarding wizard offers. Each one carries every
 * field needed to wire a runnable leader from just an API key (+ model name).
 * The OpenAI-compatible entries mirror `PROVIDER_PRESET_CATALOG` in
 * executor-config-service so the two stay recognizable.
 */
export const ONBOARDING_PROVIDER_PRESETS: OnboardingProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    vendor: "anthropic",
    apiDialect: "anthropic_messages",
    baseUrl: "https://api.anthropic.com/v1",
    secretRef: "ANTHROPIC_API_KEY",
    authHeaderName: "x-api-key",
    defaultModel: "claude-sonnet-4-6",
  },
  {
    id: "openai",
    label: "OpenAI",
    vendor: "openai",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    secretRef: "OPENAI_API_KEY",
    authHeaderName: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "gpt-5.3",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    vendor: "moonshot",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
    secretRef: "MOONSHOT_API_KEY",
    authHeaderName: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "kimi-k2-0905-preview",
  },
  {
    id: "glm",
    label: "GLM (Zhipu)",
    vendor: "zhipu",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    secretRef: "ZHIPU_API_KEY",
    authHeaderName: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "glm-4.6",
  },
  {
    id: "dashscope",
    label: "DashScope / Qwen",
    vendor: "alibaba",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    secretRef: "DASHSCOPE_API_KEY",
    authHeaderName: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "qwen-max",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    vendor: "custom",
    apiDialect: "openai_chat_completions",
    baseUrl: "",
    secretRef: "CUSTOM_API_KEY",
    authHeaderName: "Authorization",
    authPrefix: "Bearer ",
    defaultModel: "",
    requiresBaseUrl: true,
  },
];

export function getOnboardingProviderPreset(presetId: string): OnboardingProviderPreset | undefined {
  return ONBOARDING_PROVIDER_PRESETS.find((preset) => preset.id === presetId);
}

export type ConfigureLeaderProviderInput = {
  presetId: string;
  apiKey: string;
  /** Optional — falls back to the preset's default model. */
  modelName?: string | undefined;
  /** Optional override; required for the `custom` preset. */
  baseUrl?: string | undefined;
};

export type ConfigureLeaderProviderResult = {
  providerId: string;
  modelName: string;
};

/**
 * One-shot "configure the leader from an API key". Magister resolves the leader
 * as Role → Agent (`agent_profiles`) → Provider (executors.json), so a runnable
 * setup needs four coordinated writes — done here in dependency order:
 *   1. secret  → 2. provider record → 3. model record → 4. leader agent profile.
 * Finally we verify the leader actually resolves, so the wizard never reports
 * success on a config that still can't think.
 */
export async function configureLeaderProvider(
  input: ConfigureLeaderProviderInput,
): Promise<ConfigureLeaderProviderResult> {
  const preset = getOnboardingProviderPreset(input.presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset "${input.presetId}"`);
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error("apiKey is required");
  }

  const modelName = input.modelName?.trim() || preset.defaultModel;
  if (!modelName) {
    throw new Error("modelName is required");
  }

  const baseUrl = input.baseUrl?.trim() || preset.baseUrl;
  if (!baseUrl) {
    throw new Error("baseUrl is required for this provider");
  }

  const providerId = preset.id;
  const auth: ProviderAuthConfig = {
    kind: "api_key",
    secretRef: preset.secretRef,
    ...(preset.authHeaderName ? { headerName: preset.authHeaderName } : {}),
    ...(preset.authPrefix ? { prefix: preset.authPrefix } : {}),
  };

  // 1. secret
  writeSecretValue(preset.secretRef, apiKey);

  // 2. provider record
  await updateProviderConfig(providerId, {
    label: preset.label,
    vendor: preset.vendor,
    transport: "api",
    apiDialect: preset.apiDialect,
    baseUrl,
    auth,
  });

  // 3. model record (gives the Models tab an entry + context-window defaults)
  await updateModelConfig(modelName, {
    label: modelName,
    vendor: preset.vendor,
    modelName,
    providerRefs: { api: providerId },
  });

  // 4. point the leader agent at the new model + provider (partial patch —
  // preserves the seeded system prompt and other leader fields)
  await upsertAgentProfile({ roleId: "leader", modelName, providerId });

  // verify the whole chain actually resolves before reporting success
  const resolved = await resolveAgentForRole("leader");
  if (!resolved?.provider) {
    throw new Error(
      "Leader did not resolve after configuration — double-check the model name for this provider",
    );
  }

  return { providerId, modelName };
}
