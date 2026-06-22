import { expect, test } from "bun:test";

import {
  buildOpenAIChatCompletionsRequestPatch,
  normalizeProviderRequestMetadata,
  type ExecutorBinding,
  type ModelProfile,
  type ProviderConfig,
  type ReasoningPolicy,
} from "../../src/providers";

const kimiProvider: ProviderConfig = {
  id: "kimi_main",
  label: "Kimi Main",
  vendor: "moonshot",
  transport: "api",
  apiDialect: "openai_chat_completions",
  baseUrl: "https://api.moonshot.ai/v1",
  auth: {
    kind: "api_key",
    secretRef: "MOONSHOT_API_KEY",
  },
  headers: [
    { name: "x-static", value: "1" },
    { name: "x-secret", secretRef: "MOONSHOT_EXTRA_HEADER" },
    { name: "x-skip", value: "ignored", whenModelPattern: ["other-*"] },
  ],
};

const kimiModel: ModelProfile = {
  id: "kimi_k2_5",
  modelName: "kimi-k2.5",
  providerRefs: {
    api: "kimi_main",
  },
};

const kimiBinding: ExecutorBinding = {
  adapterId: "planner_api",
  executionMode: "api",
  modelRef: "kimi_k2_5",
  providerRef: "kimi_main",
  timeoutMs: 120000,
};

test("normalizeProviderRequestMetadata keeps openai chat completions provider details and filters headers", () => {
  const metadata = normalizeProviderRequestMetadata({
    provider: kimiProvider,
    model: kimiModel,
    binding: kimiBinding,
  });

  expect(metadata).toEqual({
    adapterId: "planner_api",
    providerId: "kimi_main",
    providerLabel: "Kimi Main",
    vendor: "moonshot",
    transport: "api",
    apiDialect: "openai_chat_completions",
    requestPath: "/chat/completions",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: {
      kind: "api_key",
      secretRef: "MOONSHOT_API_KEY",
    },
    headers: [
      { name: "x-static", value: "1" },
      { name: "x-secret", secretRef: "MOONSHOT_EXTRA_HEADER" },
    ],
    modelRef: "kimi_k2_5",
    modelName: "kimi-k2.5",
    providerRef: "kimi_main",
    timeoutMs: 120000,
    requestOverrides: {},
    capabilityHints: {},
  });
});

test("buildOpenAIChatCompletionsRequestPatch maps kimi thinking off to disabled thinking", () => {
  const reasoning: ReasoningPolicy = {
    mode: "off",
    effort: "low",
    visibility: "summary",
  };

  const patch = buildOpenAIChatCompletionsRequestPatch({
    provider: kimiProvider,
    model: kimiModel,
    binding: kimiBinding,
    reasoningPolicy: reasoning,
  });

  expect(patch.requestMetadata.modelName).toBe("kimi-k2.5");
  expect(patch.requestBodyPatch).toEqual({
    model: "kimi-k2.5",
    thinking: {
      type: "disabled",
    },
  });
});

test("buildOpenAIChatCompletionsRequestPatch maps glm thinking visibility into clear_thinking", () => {
  const provider: ProviderConfig = {
    id: "glm_coding_plan",
    label: "GLM Coding Plan",
    vendor: "bigmodel",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    auth: {
      kind: "api_key",
      secretRef: "BIGMODEL_API_KEY",
    },
  };

  const model: ModelProfile = {
    id: "glm_4_7",
    modelName: "glm-4.7",
    providerRefs: {
      api: "glm_coding_plan",
    },
  };

  const binding: ExecutorBinding = {
    adapterId: "architect_api",
    executionMode: "api",
    modelRef: "glm_4_7",
    providerRef: "glm_coding_plan",
  };

  const hiddenPatch = buildOpenAIChatCompletionsRequestPatch({
    provider,
    model,
    binding,
    reasoningPolicy: {
      mode: "on",
      visibility: "hidden",
    },
  });

  const fullPatch = buildOpenAIChatCompletionsRequestPatch({
    provider,
    model,
    binding,
    reasoningPolicy: {
      mode: "on",
      visibility: "full",
    },
  });

  expect(hiddenPatch.requestBodyPatch).toEqual({
    model: "glm-4.7",
    thinking: {
      type: "enabled",
      clear_thinking: true,
    },
  });
  expect(fullPatch.requestBodyPatch).toEqual({
    model: "glm-4.7",
    thinking: {
      type: "enabled",
      clear_thinking: false,
    },
  });
});

test("buildOpenAIChatCompletionsRequestPatch maps dashscope thinking budget into openai chat extras", () => {
  const provider: ProviderConfig = {
    id: "dashscope_main",
    label: "DashScope",
    vendor: "dashscope",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    auth: {
      kind: "api_key",
      secretRef: "DASHSCOPE_API_KEY",
    },
  };

  const model: ModelProfile = {
    id: "qwen3_5_plus",
    modelName: "qwen3.5-plus",
    providerRefs: {
      api: "dashscope_main",
    },
  };

  const binding: ExecutorBinding = {
    adapterId: "coder_api",
    executionMode: "api",
    modelRef: "qwen3_5_plus",
    providerRef: "dashscope_main",
  };

  const patch = buildOpenAIChatCompletionsRequestPatch({
    provider,
    model,
    binding,
    reasoningPolicy: {
      mode: "auto",
      effort: "medium",
      budgetTokens: 1024,
    },
  });

  expect(patch.requestBodyPatch).toEqual({
    model: "qwen3.5-plus",
    enable_thinking: true,
    thinking_budget: 1024,
  });
});

test("buildOpenAIChatCompletionsRequestPatch maps generic openai reasoning effort when enabled", () => {
  const provider: ProviderConfig = {
    id: "openai_main",
    label: "OpenAI Main",
    vendor: "openai",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    auth: {
      kind: "api_key",
      secretRef: "OPENAI_API_KEY",
    },
  };

  const model: ModelProfile = {
    id: "o3",
    modelName: "o3",
    providerRefs: {
      api: "openai_main",
    },
    defaultReasoning: {
      mode: "on",
      effort: "xhigh",
    },
  };

  const binding: ExecutorBinding = {
    adapterId: "manager_api",
    executionMode: "api",
    modelRef: "o3",
    providerRef: "openai_main",
  };

  const patch = buildOpenAIChatCompletionsRequestPatch({
    provider,
    model,
    binding,
  });

  expect(patch.requestBodyPatch).toEqual({
    model: "o3",
    reasoning_effort: "high",
  });
});
