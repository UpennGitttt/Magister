import { test, expect } from "bun:test";

import { applyModelOverrideToApiConfig } from "../../../src/services/process-task-intent-service";
import type { ProviderConfig, ModelProfile, ExecutorBinding } from "../../../src/providers/types";

// Optimizer "override silently fell back" surface signal regression
// test. The actual optimizeObjective function depends on heavy
// service wiring (DB, leader checkpoint, callStreamingApi), but the
// signal-detection logic is purely a string compare on the resolved
// apiConfig.modelName — verify that piece in isolation.

const baseApiConfig = {
  provider: {
    id: "provider_a",
    transport: "api",
    apiDialect: "anthropic_messages",
    vendor: "anthropic",
    auth: { kind: "api_key", secretRef: "X" },
  } as ProviderConfig,
  model: { id: "model_id_a", modelName: "agent-default-model", providerRefs: { api: "provider_a" } } as ModelProfile,
  binding: { adapterId: "leader_binding", executionMode: "api", modelRef: "model_id_a", providerRef: "provider_a" } as ExecutorBinding,
};

test("applyModelOverrideToApiConfig: stale override (not in config) returns unchanged apiConfig", () => {
  const config = {
    executors: {},
    roleRouting: {},
    providers: {},
    models: {},
    bindings: {},
  };
  const after = applyModelOverrideToApiConfig(baseApiConfig, "deleted-model", config);
  // Optimizer detects this case via after.model.modelName !== task.modelOverride.
  expect(after.model.modelName).toBe("agent-default-model");
  expect(after.model.modelName).not.toBe("deleted-model");
});

test("applyModelOverrideToApiConfig: valid override updates modelName + provider", () => {
  const config = {
    executors: {},
    roleRouting: {},
    providers: {
      provider_b: {
        transport: "api" as const,
        apiDialect: "openai_chat_completions" as const,
        vendor: "openai",
        auth: { kind: "api_key" as const, secretRef: "Y" },
      },
    },
    models: {
      "new-model": {
        modelName: "new-model",
        providerRefs: { api: "provider_b" },
      },
    },
    bindings: {},
  };
  const after = applyModelOverrideToApiConfig(baseApiConfig, "new-model", config);
  expect(after.model.modelName).toBe("new-model");
  expect(after.provider.id).toBe("provider_b");
  expect(after.provider.apiDialect).toBe("openai_chat_completions");
});

test("applyModelOverrideToApiConfig: override without providerRefs.api returns unchanged", () => {
  const config = {
    executors: {},
    roleRouting: {},
    providers: { provider_b: { transport: "api" as const, apiDialect: "openai_chat_completions" as const, vendor: "openai", auth: { kind: "none" as const } } },
    models: { "cli-only-model": { modelName: "cli-only-model", providerRefs: { cli: "provider_b" } } },
    bindings: {},
  };
  const after = applyModelOverrideToApiConfig(baseApiConfig, "cli-only-model", config);
  expect(after.model.modelName).toBe("agent-default-model");
});

test("applyModelOverrideToApiConfig: empty/null override is a no-op", () => {
  const after = applyModelOverrideToApiConfig(baseApiConfig, null, { executors: {}, roleRouting: {}, providers: {}, models: {}, bindings: {} });
  expect(after).toBe(baseApiConfig);
  const after2 = applyModelOverrideToApiConfig(baseApiConfig, "", { executors: {}, roleRouting: {}, providers: {}, models: {}, bindings: {} });
  expect(after2).toBe(baseApiConfig);
});

test("applyModelOverrideToApiConfig: preserves requestOverrides + defaultReasoning from model record", () => {
  const config = {
    executors: {},
    roleRouting: {},
    providers: { provider_b: { transport: "api" as const, apiDialect: "openai_chat_completions" as const, vendor: "openai", auth: { kind: "none" as const } } },
    models: {
      "rich-model": {
        modelName: "rich-model",
        providerRefs: { api: "provider_b" },
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        requestOverrides: { temperature: 0.2, top_p: 0.9 },
        capabilityHints: { vision: true },
        defaultReasoning: { mode: "on" as const, effort: "high" as const },
        fallbacks: ["fallback-model"],
      },
    },
    bindings: {},
  };
  const after = applyModelOverrideToApiConfig(baseApiConfig, "rich-model", config);
  expect(after.model.modelName).toBe("rich-model");
  expect(after.model.contextWindow).toBe(1_000_000);
  expect(after.model.maxOutputTokens).toBe(32_768);
  expect(after.model.requestOverrides).toEqual({ temperature: 0.2, top_p: 0.9 });
  expect((after.model as ModelProfile & { capabilityHints?: { vision?: boolean } }).capabilityHints).toEqual({ vision: true });
  expect(after.model.defaultReasoning?.mode).toBe("on");
  expect(after.model.fallbacks).toEqual(["fallback-model"]);
});
