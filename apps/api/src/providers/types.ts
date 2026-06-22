export type ProviderApiDialect = "openai_chat_completions" | "anthropic_messages" | "gemini_generate_content";

export type ProviderTransport = "api" | "cli";

export type ProviderAuthConfig =
  | { kind: "chatgpt_session" }
  | { kind: "api_key"; secretRef: string; headerName?: string; prefix?: string }
  | { kind: "oauth_token"; secretRef: string; headerName?: string; prefix?: string }
  | { kind: "none" };

export type ProviderHeaderRule = {
  name: string;
  value?: string;
  secretRef?: string;
  envRef?: string;
  whenDialect?: ProviderApiDialect[];
  whenModelPattern?: string[];
};

export type ProviderReasoningPolicy = {
  mode: "off" | "auto" | "on";
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  budgetTokens?: number;
  visibility?: "hidden" | "summary" | "full";
};

export type ProviderConfig = {
  id: string;
  label?: string;
  vendor: string;
  transport: ProviderTransport;
  apiDialect: ProviderApiDialect;
  baseUrl?: string;
  auth: ProviderAuthConfig;
  headers?: ProviderHeaderRule[];
  cli?: {
    commandPath?: string;
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  };
  requestOverrides?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  quirks?: {
    preserveReasoningContent?: boolean;
    supportsThinkingBudget?: boolean;
    supportsThinkingClear?: boolean;
  };
};

export type ModelProfile = {
  id: string;
  label?: string;
  vendor?: string;
  modelName: string;
  fallbacks?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  providerRefs?: {
    cli?: string;
    api?: string;
  };
  defaultReasoning?: ProviderReasoningPolicy;
  requestOverrides?: Record<string, unknown>;
  capabilityHints?: Record<string, unknown>;
};

export type ExecutorBinding = {
  adapterId: string;
  executionMode: "cli" | "api";
  modelRef: string;
  providerRef?: string;
  timeoutMs?: number;
  commandPath?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
};

export type NormalizedProviderRequestMetadata = {
  adapterId: string;
  providerId: string;
  providerLabel?: string;
  providerRef: string;
  vendor: string;
  transport: ProviderTransport;
  apiDialect: ProviderApiDialect;
  baseUrl?: string;
  requestPath: "/chat/completions" | "/v1/messages" | "/messages";
  auth: ProviderAuthConfig;
  headers: ProviderHeaderRule[];
  modelRef: string;
  modelName: string;
  timeoutMs?: number;
  commandPath?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  requestOverrides: Record<string, unknown>;
  capabilityHints: Record<string, unknown>;
  reasoningPolicy?: ProviderReasoningPolicy;
};

export type OpenAIChatCompletionsRequestPatch = {
  requestMetadata: NormalizedProviderRequestMetadata;
  requestBodyPatch: Record<string, unknown>;
};

export type AnthropicMessagesRequestPatch = {
  requestMetadata: NormalizedProviderRequestMetadata;
  requestBodyPatch: Record<string, unknown>;
};
