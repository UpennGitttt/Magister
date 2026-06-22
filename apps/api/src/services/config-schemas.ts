import { z } from "zod";

// === Provider ===

export const ApiDialectSchema = z.enum([
  "openai_chat_completions",   // OpenAI, DeepSeek, Qwen, GLM, MiniMax (OpenAI compat)
  "openai_responses",
  "anthropic_messages",        // Claude, MiniMax (Anthropic compat)
  "gemini_generate_content",   // Gemini
  "cli_native",
]);

export const ProviderAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("api_key"), secretRef: z.string(), headerName: z.string().optional(), prefix: z.string().optional() }),
  z.object({ kind: z.literal("oauth_token"), secretRef: z.string() }),
  z.object({ kind: z.literal("chatgpt_session") }),
]);

export const ProviderHeaderRuleSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  secretRef: z.string().optional(),
  envRef: z.string().optional(),
});

export const ProviderConfigSchema = z.object({
  transport: z.enum(["api", "cli"]).default("api"),
  apiDialect: ApiDialectSchema,
  label: z.string().optional(),
  vendor: z.string(),
  baseUrl: z.string().url().optional(),
  auth: ProviderAuthSchema,
  headers: z.array(ProviderHeaderRuleSchema).optional(),
  requestOverrides: z.record(z.string(), z.unknown()).optional(),
});

// === Reasoning ===

export const ReasoningPolicySchema = z.object({
  mode: z.enum(["off", "auto", "on"]).default("off"),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  budgetTokens: z.number().int().positive().optional(),
  visibility: z.enum(["hidden", "summary", "full"]).optional(),
}).strict();

// === Model ===

export const ModelProfileSchema = z.object({
  modelName: z.string().min(1),
  fallbacks: z.array(z.string()).optional(),
  label: z.string().optional(),
  vendor: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  providerRefs: z.object({
    api: z.string().optional(),
    cli: z.string().optional(),
  }).optional(),
  defaultReasoning: ReasoningPolicySchema.optional(),
  // C3 — keep in sync with the hand-rolled ModelProfileRecord so the two
  // same-named `ModelProfile` types don't drift and these survive a parse.
  requestOverrides: z.record(z.string(), z.unknown()).optional(),
  capabilityHints: z.record(z.string(), z.unknown()).optional(),
  // Stable models.dev catalog identity, set when a model is added from the
  // catalog (spec §5.4). Used for refresh + resolution lookups.
  catalogProviderId: z.string().optional(),
  catalogModelId: z.string().optional(),
});

// === Binding ===

export const ExecutorBindingSchema = z.object({
  adapterId: z.string().optional(),
  executionMode: z.enum(["api", "cli"]).optional(),
  modelRef: z.string().optional(),
  providerRef: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxMode: z.string().optional(),
  commandPath: z.string().optional(),
});

// === Role Routing ===

export const RoleRoutingSchema = z.object({
  adapterId: z.string(),
  strategy: z.enum(["model_only", "agent_only", "fallback_model", "prefer_agent"]),
  fallbackAdapterId: z.string().optional(),
});

// === Full Config File ===

export const ExecutorConfigFileSchema = z.object({
  executors: z.record(z.string(), z.unknown()).optional(),
  roleRouting: z.record(z.string(), RoleRoutingSchema).optional(),
  roleMapping: z.record(z.string(), z.string().min(1)).optional(),
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
  models: z.record(z.string(), ModelProfileSchema).optional(),
  bindings: z.record(z.string(), ExecutorBindingSchema).optional(),
});

// === Type exports ===

export type ApiDialect = z.infer<typeof ApiDialectSchema>;
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;
export type ReasoningPolicy = z.infer<typeof ReasoningPolicySchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ExecutorBinding = z.infer<typeof ExecutorBindingSchema>;
export type RoleRouting = z.infer<typeof RoleRoutingSchema>;
export type ExecutorConfigFile = z.infer<typeof ExecutorConfigFileSchema>;

// === Vendor presets for quick setup (provider connection only, no model names) ===

export const VENDOR_PRESETS = {
  openai: {
    apiDialect: "openai_chat_completions" as const,
    vendor: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: { kind: "api_key" as const, secretRef: "OPENAI_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  anthropic: {
    apiDialect: "anthropic_messages" as const,
    vendor: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { kind: "api_key" as const, secretRef: "ANTHROPIC_API_KEY", headerName: "x-api-key" },
  },
  deepseek: {
    apiDialect: "openai_chat_completions" as const,
    vendor: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    auth: { kind: "api_key" as const, secretRef: "DEEPSEEK_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  // DeepSeek's anthropic-compat endpoint. This is the variant that
  // emits extended thinking via the `thinking.type: "adaptive"|"enabled"`
  // protocol on streaming responses. The default `deepseek` preset
  // above targets the OpenAI-compat /v1 endpoint which doesn't expose
  // reasoning tokens in stream form. New deployments wanting to see
  // thinking from DeepSeek should pick this preset, not the /v1 one.
  // See reasoning-patch.ts for how mode='auto' translates to
  // 'adaptive' on this dialect.
  "deepseek-anthropic": {
    apiDialect: "anthropic_messages" as const,
    vendor: "deepseek",
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { kind: "api_key" as const, secretRef: "DEEPSEEK_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  minimax: {
    apiDialect: "anthropic_messages" as const,
    vendor: "minimax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    auth: { kind: "api_key" as const, secretRef: "MINIMAX_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  qwen: {
    apiDialect: "openai_chat_completions" as const,
    vendor: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    auth: { kind: "api_key" as const, secretRef: "DASHSCOPE_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  glm: {
    apiDialect: "openai_chat_completions" as const,
    vendor: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    auth: { kind: "api_key" as const, secretRef: "GLM_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  gemini: {
    apiDialect: "gemini_generate_content" as const,
    vendor: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: { kind: "api_key" as const, secretRef: "GEMINI_API_KEY" },
  },
} as const;
