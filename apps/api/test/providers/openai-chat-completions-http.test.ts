import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  prepareOpenAIChatCompletionsHttpRequest,
  type ExecutorBinding,
  type ModelProfile,
  type ProviderConfig,
  type ProviderReasoningPolicy,
} from "../../src/providers";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-openai-http-secret-store");

function prepareSecretStore() {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

const provider: ProviderConfig = {
  id: "kimi_main",
  label: "Kimi Main",
  vendor: "moonshot",
  transport: "api",
  apiDialect: "openai_chat_completions",
  baseUrl: "https://api.moonshot.ai/v1",
  auth: {
    kind: "api_key",
    secretRef: "MOONSHOT_API_KEY",
    headerName: "Authorization",
    prefix: "Bearer ",
  },
  headers: [
    { name: "x-static", value: "1" },
    { name: "x-secret", secretRef: "MOONSHOT_EXTRA_HEADER" },
  ],
};

const model: ModelProfile = {
  id: "kimi_k2_5",
  modelName: "kimi-k2.5",
  providerRefs: {
    api: "kimi_main",
  },
};

const binding: ExecutorBinding = {
  adapterId: "planner_api",
  executionMode: "api",
  modelRef: "kimi_k2_5",
  providerRef: "kimi_main",
  timeoutMs: 120000,
};

test("prepareOpenAIChatCompletionsHttpRequest resolves api_key auth from env and patches the body", () => {
  prepareSecretStore();
  try {
    const reasoning: ProviderReasoningPolicy = {
      mode: "on",
      effort: "medium",
      visibility: "summary",
    };

    const prepared = prepareOpenAIChatCompletionsHttpRequest({
      provider,
      model,
      binding,
      prompt: "Plan the migration.",
      env: {
        MOONSHOT_API_KEY: "secret-value",
        MOONSHOT_EXTRA_HEADER: "extra-value",
      } as NodeJS.ProcessEnv,
      reasoningPolicy: reasoning,
    });

    expect(prepared.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(new Headers(prepared.init.headers).get("authorization")).toBe("Bearer secret-value");
    expect(new Headers(prepared.init.headers).get("x-secret")).toBe("extra-value");
    expect(prepared.init.method).toBe("POST");
    expect(JSON.parse(String(prepared.init.body))).toEqual({
      model: "kimi-k2.5",
      thinking: {
        type: "enabled",
      },
      messages: [
        {
          role: "system",
          content: "Plan the migration.",
        },
      ],
    });
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepareOpenAIChatCompletionsHttpRequest resolves auth and header secrets from the local store before env", () => {
  prepareSecretStore();
  try {
    writeSecretValue("MOONSHOT_API_KEY", "local-secret-value");
    writeSecretValue("MOONSHOT_EXTRA_HEADER", "local-header-value");

    const prepared = prepareOpenAIChatCompletionsHttpRequest({
      provider,
      model,
      binding,
      prompt: "Plan the migration.",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(prepared.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(new Headers(prepared.init.headers).get("authorization")).toBe("Bearer local-secret-value");
    expect(new Headers(prepared.init.headers).get("x-secret")).toBe("local-header-value");
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
