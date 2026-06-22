import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

import { registerOnboardingRoutes } from "../../src/routes/onboarding";

let app: FastifyInstance;
let dir: string;
let prevConfigPath: string | undefined;
let prevStorePath: string | undefined;
let prevDbPath: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "onboarding-route-"));

  const configPath = join(dir, "executors.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      roleMapping: {},
      providers: {
        anthropic: {
          label: "Anthropic",
          vendor: "anthropic",
          transport: "api",
          apiDialect: "anthropic_messages",
          baseUrl: "https://api.anthropic.com",
          auth: { kind: "api_key", secretRef: "ANTHROPIC_API_KEY" },
        },
      },
      models: {},
      bindings: {},
    }),
  );

  const storePath = join(dir, "secrets.json");
  writeFileSync(
    storePath,
    JSON.stringify({
      secrets: { ANTHROPIC_API_KEY: { value: "sk-test", updatedAt: new Date(0).toISOString() } },
    }),
  );

  prevConfigPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  prevStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
  process.env.MAGISTER_SECRET_STORE_PATH = storePath;
  process.env.MAGISTER_DB_PATH = join(dir, "control-plane.sqlite");

  app = Fastify();
  await app.register(registerOnboardingRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (prevConfigPath === undefined) delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  else process.env.MAGISTER_EXECUTOR_CONFIG_PATH = prevConfigPath;
  if (prevStorePath === undefined) delete process.env.MAGISTER_SECRET_STORE_PATH;
  else process.env.MAGISTER_SECRET_STORE_PATH = prevStorePath;
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  rmSync(dir, { recursive: true, force: true });
});

test("GET /onboarding/status aggregates providers, CLI agents, and feishu", async () => {
  const res = await app.inject({ method: "GET", url: "/onboarding/status" });

  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.ok).toBe(true);

  expect(body.data.providers).toEqual({ total: 1, readyCount: 1, configured: true });
  expect(body.data.complete).toBe(true);

  expect(Array.isArray(body.data.cliAgents.items)).toBe(true);
  expect(typeof body.data.cliAgents.anyReady).toBe("boolean");

  expect(body.data.feishu.state.provider).toBe("feishu");
  expect(typeof body.data.feishu.channelsDisabled).toBe("boolean");
  expect(body.data.feishu.gateway).toBeDefined();
});

test("GET /onboarding/provider-presets lists choices without leaking secret refs", async () => {
  const res = await app.inject({ method: "GET", url: "/onboarding/provider-presets" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.ok).toBe(true);
  const ids = body.data.items.map((p: { id: string }) => p.id);
  expect(ids).toContain("anthropic");
  expect(ids).toContain("openai");
  // presets are public choices — must not expose secretRef
  expect(JSON.stringify(body.data.items)).not.toContain("secretRef");
});

test("POST /onboarding/provider configures the leader from a key", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/onboarding/provider",
    payload: { presetId: "anthropic", apiKey: "sk-ant-route-test", modelName: "claude-sonnet-4-6" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.ok).toBe(true);
  expect(body.data).toEqual({ providerId: "anthropic", modelName: "claude-sonnet-4-6" });

  // and the aggregated status now reports providers configured
  const status = (await app.inject({ method: "GET", url: "/onboarding/status" })).json();
  expect(status.data.providers.configured).toBe(true);
  expect(status.data.complete).toBe(true);
});

test("POST /onboarding/provider returns 400 on an unknown preset", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/onboarding/provider",
    payload: { presetId: "does-not-exist", apiKey: "x" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().ok).toBe(false);
});
