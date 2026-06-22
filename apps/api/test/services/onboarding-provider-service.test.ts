import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { resolveAgentForRole } from "../../src/services/agent-resolution-service";
import { readExecutorConfigFile } from "../../src/services/executor-config-service";
import { getSecretStatus } from "../../src/services/local-secret-store-service";
import {
  configureLeaderProvider,
  ONBOARDING_PROVIDER_PRESETS,
} from "../../src/services/onboarding-provider-service";

const tempRoot = join(process.cwd(), ".tmp-onboarding-provider");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  process.env.MAGISTER_DB_PATH = join(tempRoot, `db-${tag}.sqlite`);
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(tempRoot, `executors-${tag}.json`);
  process.env.MAGISTER_SECRET_STORE_PATH = join(tempRoot, `secrets-${tag}.json`);
  writeFileSync(
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH,
    JSON.stringify({ executors: {}, roleRouting: {}, roleMapping: {}, providers: {}, models: {}, bindings: {} }),
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("ONBOARDING_PROVIDER_PRESETS includes anthropic and openai", () => {
  const ids = ONBOARDING_PROVIDER_PRESETS.map((p) => p.id);
  expect(ids).toContain("anthropic");
  expect(ids).toContain("openai");
});

test("configureLeaderProvider wires secret + provider + model + leader agent so the leader resolves", async () => {
  const result = await configureLeaderProvider({
    presetId: "anthropic",
    apiKey: "sk-ant-test",
    modelName: "claude-sonnet-4-6",
  });
  expect(result.providerId).toBe("anthropic");
  expect(result.modelName).toBe("claude-sonnet-4-6");

  // secret persisted to the store
  expect(getSecretStatus("ANTHROPIC_API_KEY").ready).toBe(true);

  // provider + model written to executors.json
  const config = await readExecutorConfigFile();
  expect(config.providers.anthropic).toBeDefined();
  expect(config.providers.anthropic?.apiDialect).toBe("anthropic_messages");
  expect(config.models["claude-sonnet-4-6"]).toBeDefined();

  // the leader role now resolves to a runnable config
  const resolved = await resolveAgentForRole("leader");
  expect(resolved).not.toBeNull();
  expect(resolved!.provider).toBeTruthy();
  expect(resolved!.modelName).toBe("claude-sonnet-4-6");
});

test("configureLeaderProvider rejects an unknown preset or a blank key", async () => {
  await expect(
    configureLeaderProvider({ presetId: "nope", apiKey: "x", modelName: "m" }),
  ).rejects.toThrow();
  await expect(
    configureLeaderProvider({ presetId: "anthropic", apiKey: "   ", modelName: "m" }),
  ).rejects.toThrow();
});
