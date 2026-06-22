import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-settings-secrets-route");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `settings-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  delete process.env.MOONSHOT_API_KEY;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET and PUT /settings/secrets use the local store without leaking raw values", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        kimi_main: {
          label: "Kimi Main",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.ai/v1",
          auth: {
            kind: "api_key",
            secretRef: "MOONSHOT_API_KEY",
          },
        },
      },
      models: {},
      bindings: {},
    }),
  );

  const app = buildApp();

  const emptyResponse = await app.inject({
    method: "GET",
    url: "/settings/secrets",
  });

  expect(emptyResponse.statusCode).toBe(200);
  expect(emptyResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          secretRef: "MOONSHOT_API_KEY",
          ready: false,
          source: "missing",
        }),
      ],
    },
  });

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/secrets/MOONSHOT_API_KEY",
    payload: {
      value: "local-moonshot-secret",
    },
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json()).toMatchObject({
    ok: true,
    data: {
      secretRef: "MOONSHOT_API_KEY",
      ready: true,
      source: "store",
      updatedAt: expect.any(String),
    },
  });
  expect(JSON.stringify(updateResponse.json())).not.toContain("local-moonshot-secret");

  const readyResponse = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });

  expect(readyResponse.statusCode).toBe(200);
  expect(readyResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          id: "kimi_main",
          readiness: {
            ready: true,
            missing: [],
          },
        }),
      ],
    },
  });

  expect(JSON.stringify(readyResponse.json())).not.toContain("local-moonshot-secret");
});
