import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-secret-reveal-test");

function writeProviderConfig(configPath: string) {
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        p1: {
          label: "Test Provider",
          transport: "api",
          apiDialect: "anthropic_messages",
          baseUrl: "https://api.example.com",
          auth: {
            kind: "api_key",
            secretRef: "test-provider-key",
          },
        },
      },
      models: {},
      bindings: {},
    }),
  );
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `db-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );

  // Disable API auth for inject() calls
  delete process.env.MAGISTER_API_TOKEN;
  delete process.env.UCM_API_TOKEN;
  delete process.env.ULTIMATE_CODEX_MANAGER_API_TOKEN;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  delete process.env.MAGISTER_ALLOW_SECRET_REVEAL;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("reveal disabled: value is blanked but configured stays true", async () => {
  process.env.MAGISTER_ALLOW_SECRET_REVEAL = "off";

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeProviderConfig(configPath);

  // Write the actual secret
  writeSecretValue("test-provider-key", "sk-test-key-123456");

  const app = buildApp();

  const res = await app.inject({ method: "GET", url: "/settings/providers/p1/secret" });
  expect(res.statusCode).toBe(200);

  const body = res.json();
  expect(body.ok).toBe(true);
  expect(body.data.value).toBe("");
  expect(body.data.configured).toBe(true);
});

test("reveal enabled (default): value is returned", async () => {
  // no env set → default on
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeProviderConfig(configPath);

  // Write the actual secret
  writeSecretValue("test-provider-key", "sk-test-key-123456");

  const app = buildApp();

  const res = await app.inject({ method: "GET", url: "/settings/providers/p1/secret" });
  expect(res.statusCode).toBe(200);

  const body = res.json();
  expect(body.ok).toBe(true);
  expect(body.data.value.length).toBeGreaterThan(0);
  expect(body.data.value).toBe("sk-test-key-123456");
  expect(body.data.configured).toBe(true);
});
