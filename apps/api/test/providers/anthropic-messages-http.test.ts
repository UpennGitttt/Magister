import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  prepareAnthropicMessagesHttpRequest,
  type ExecutorBinding,
  type ModelProfile,
  type ProviderConfig,
} from "../../src/providers";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-anthropic-http-secret-store");

function prepareSecretStore() {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

const provider: ProviderConfig = {
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
  ],
};

const model: ModelProfile = {
  id: "claude_3_7_sonnet",
  modelName: "claude-3-7-sonnet-20250219",
  providerRefs: {
    api: "anthropic_main",
  },
};

const binding: ExecutorBinding = {
  adapterId: "manager_api",
  executionMode: "api",
  modelRef: "claude_3_7_sonnet",
  providerRef: "anthropic_main",
  timeoutMs: 90000,
};

test("prepareAnthropicMessagesHttpRequest resolves api_key auth from env and builds anthropic message body", () => {
  prepareSecretStore();
  try {
    const prepared = prepareAnthropicMessagesHttpRequest({
      provider,
      model,
      binding,
      prompt: "Plan the migration.",
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
        ANTHROPIC_EXTRA_HEADER: "extra-value",
      } as NodeJS.ProcessEnv,
    });

    expect(prepared.url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(prepared.init.headers).get("x-api-key")).toBe("anthropic-secret");
    expect(new Headers(prepared.init.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(new Headers(prepared.init.headers).get("x-secret")).toBe("extra-value");
    expect(prepared.init.method).toBe("POST");
    expect(JSON.parse(String(prepared.init.body))).toEqual({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Plan the migration.",
            },
          ],
        },
      ],
    });
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepareAnthropicMessagesHttpRequest resolves auth and header secrets from local store before env", () => {
  prepareSecretStore();
  try {
    writeSecretValue("ANTHROPIC_API_KEY", "local-anthropic-secret");
    writeSecretValue("ANTHROPIC_EXTRA_HEADER", "local-header-value");

    const prepared = prepareAnthropicMessagesHttpRequest({
      provider,
      model,
      binding,
      prompt: "Plan the migration.",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(prepared.url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(prepared.init.headers).get("x-api-key")).toBe("local-anthropic-secret");
    expect(new Headers(prepared.init.headers).get("x-secret")).toBe("local-header-value");
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepareAnthropicMessagesHttpRequest keeps a /v1 baseUrl from duplicating the path", () => {
  prepareSecretStore();
  try {
    const prepared = prepareAnthropicMessagesHttpRequest({
      provider: {
        ...provider,
        baseUrl: "https://api.minimaxi.com/anthropic/v1",
        headers: [],
      },
      model,
      binding,
      prompt: "Plan the migration.",
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
      } as NodeJS.ProcessEnv,
    });

    expect(prepared.url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepareAnthropicMessagesHttpRequest uses the official MiniMax anthropic baseUrl shape", () => {
  prepareSecretStore();
  try {
    const prepared = prepareAnthropicMessagesHttpRequest({
      provider: {
        ...provider,
        baseUrl: "https://api.minimaxi.com/anthropic",
        headers: [],
      },
      model,
      binding,
      prompt: "Plan the migration.",
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
      } as NodeJS.ProcessEnv,
    });

    expect(prepared.url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  } finally {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
