import { expect, test } from "bun:test";

import {
  buildAnthropicMessagesRequestPatch,
  type ExecutorBinding,
  type ModelProfile,
  type ProviderConfig,
} from "../../src/providers";

const anthropicProvider: ProviderConfig = {
  id: "anthropic_main",
  label: "Anthropic Main",
  vendor: "anthropic",
  transport: "api",
  apiDialect: "anthropic_messages",
  baseUrl: "https://api.anthropic.com",
  auth: {
    kind: "api_key",
    secretRef: "ANTHROPIC_API_KEY",
  },
  headers: [
    { name: "x-static", value: "1" },
    { name: "x-secret", secretRef: "ANTHROPIC_EXTRA_HEADER" },
    { name: "x-skip", value: "ignored", whenDialect: ["openai_chat_completions"] },
  ],
  requestOverrides: {
    temperature: 0.1,
  },
};

const anthropicModel: ModelProfile = {
  id: "claude_3_7_sonnet",
  modelName: "claude-3-7-sonnet-20250219",
  providerRefs: {
    api: "anthropic_main",
  },
  requestOverrides: {
    temperature: 0.2,
  },
};

const anthropicBinding: ExecutorBinding = {
  adapterId: "reviewer_api",
  executionMode: "api",
  modelRef: "claude_3_7_sonnet",
  providerRef: "anthropic_main",
  timeoutMs: 90000,
};

test("buildAnthropicMessagesRequestPatch keeps anthropic metadata and defaults max_tokens", () => {
  const patch = buildAnthropicMessagesRequestPatch({
    provider: anthropicProvider,
    model: anthropicModel,
    binding: anthropicBinding,
  });

  expect(patch.requestMetadata).toEqual({
    adapterId: "reviewer_api",
    providerId: "anthropic_main",
    providerLabel: "Anthropic Main",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    requestPath: "/v1/messages",
    baseUrl: "https://api.anthropic.com",
    auth: {
      kind: "api_key",
      secretRef: "ANTHROPIC_API_KEY",
    },
    headers: [
      { name: "x-static", value: "1" },
      { name: "x-secret", secretRef: "ANTHROPIC_EXTRA_HEADER" },
    ],
    modelRef: "claude_3_7_sonnet",
    modelName: "claude-3-7-sonnet-20250219",
    providerRef: "anthropic_main",
    timeoutMs: 90000,
    requestOverrides: {
      temperature: 0.2,
    },
    capabilityHints: {},
  });

  expect(patch.requestBodyPatch).toEqual({
    temperature: 0.2,
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 2048,
  });
});

test("buildAnthropicMessagesRequestPatch avoids duplicating /v1 when baseUrl already includes it", () => {
  const patch = buildAnthropicMessagesRequestPatch({
    provider: {
      ...anthropicProvider,
      baseUrl: "https://api.minimaxi.com/anthropic/v1",
    },
    model: anthropicModel,
    binding: anthropicBinding,
  });

  expect(patch.requestMetadata.requestPath).toBe("/messages");
});

test("buildAnthropicMessagesRequestPatch keeps the standard /v1/messages path for anthropic-compatible base urls", () => {
  const patch = buildAnthropicMessagesRequestPatch({
    provider: {
      ...anthropicProvider,
      baseUrl: "https://api.minimaxi.com/anthropic",
    },
    model: anthropicModel,
    binding: anthropicBinding,
  });

  expect(patch.requestMetadata.requestPath).toBe("/v1/messages");
});

test("buildAnthropicMessagesRequestPatch omits thinking for Anthropic Claude when mode='auto'", () => {
  // 2026-05-24 — Anthropic Claude API rejects `thinking.type: "auto"`
  // ("unknown variant `auto`, expected one of ..."). For mode="auto"
  // the patch must OMIT the thinking field entirely so Claude uses
  // its default non-thinking behavior. mode="on" still emits
  // thinking.type="enabled".
  const patchAuto = buildAnthropicMessagesRequestPatch({
    provider: anthropicProvider,
    model: {
      ...anthropicModel,
      defaultReasoning: {
        mode: "auto",
        budgetTokens: 4096,
      },
    },
    binding: anthropicBinding,
  });

  expect(patchAuto.requestBodyPatch).toEqual({
    temperature: 0.2,
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 2048,
    // No `thinking` field — Anthropic Claude defaults to non-thinking
    // when the field is absent.
  });

  const patchOn = buildAnthropicMessagesRequestPatch({
    provider: anthropicProvider,
    model: {
      ...anthropicModel,
      defaultReasoning: {
        mode: "on",
        budgetTokens: 4096,
      },
    },
    binding: anthropicBinding,
  });

  expect(patchOn.requestBodyPatch).toEqual({
    temperature: 0.2,
    model: "claude-3-7-sonnet-20250219",
    max_tokens: 2048,
    thinking: {
      type: "enabled",
      budget_tokens: 4096,
    },
  });
});

test("buildReasoningPatch routes DeepSeek anthropic-compat mode='auto' to 'adaptive'", async () => {
  // 2026-05-24 — DeepSeek's anthropic-compat endpoint accepts
  // {adaptive, enabled, disabled}; "auto" is rejected. The patch
  // builder routes by provider family so DeepSeek gets "adaptive"
  // (its "let model decide" sentinel) while Anthropic Claude omits
  // the field.
  const { buildReasoningPatch } = await import("../../src/providers/reasoning-patch");
  const deepseekProvider = {
    id: "DeepSeek",
    label: "DeepSeek Official",
    vendor: "deepseek",
    apiDialect: "anthropic_messages" as const,
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { kind: "api_key" as const, secretRef: "DEEPSEEK_API_KEY" },
  };
  const deepseekModel = {
    id: "deepseek-v4-pro[1m]",
    label: "deepseek-v4-pro 1m",
    modelName: "deepseek-v4-pro[1m]",
    vendor: "deepseek",
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    providerRefs: { api: "DeepSeek" },
    defaultReasoning: { mode: "auto" as const, effort: "high" as const },
  };
  const patchAuto = buildReasoningPatch(deepseekProvider as never, deepseekModel as never);
  expect(patchAuto).toEqual({ thinking: { type: "adaptive" } });

  const patchOn = buildReasoningPatch(
    deepseekProvider as never,
    { ...deepseekModel, defaultReasoning: { mode: "on" as const, budgetTokens: 8192 } } as never,
  );
  expect(patchOn).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 } });
});
