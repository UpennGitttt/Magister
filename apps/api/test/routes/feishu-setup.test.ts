import { afterEach, beforeEach, expect, test } from "bun:test";

import { buildApp } from "../../src/app";

const ORIGINAL_ENV = {
  MAGISTER_DISABLE_CHANNELS: process.env.MAGISTER_DISABLE_CHANNELS,
  MAGISTER_FEISHU_CONNECTION_MODE: process.env.MAGISTER_FEISHU_CONNECTION_MODE,
  MAGISTER_FEISHU_APP_ID: process.env.MAGISTER_FEISHU_APP_ID,
  MAGISTER_FEISHU_APP_SECRET: process.env.MAGISTER_FEISHU_APP_SECRET,
  MAGISTER_FEISHU_VERIFICATION_TOKEN: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN,
  MAGISTER_FEISHU_ENCRYPT_KEY: process.env.MAGISTER_FEISHU_ENCRYPT_KEY,
};

function restoreEnvKey(key: keyof typeof ORIGINAL_ENV) {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.MAGISTER_FEISHU_CONNECTION_MODE = "websocket";
  process.env.MAGISTER_FEISHU_APP_ID = "cli-agent-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "cli-agent-app-secret";
  process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN = "cli-agent-verification-token";
  process.env.MAGISTER_FEISHU_ENCRYPT_KEY = "cli-agent-encrypt-key";
});

afterEach(() => {
  restoreEnvKey("MAGISTER_DISABLE_CHANNELS");
  restoreEnvKey("MAGISTER_FEISHU_CONNECTION_MODE");
  restoreEnvKey("MAGISTER_FEISHU_APP_ID");
  restoreEnvKey("MAGISTER_FEISHU_APP_SECRET");
  restoreEnvKey("MAGISTER_FEISHU_VERIFICATION_TOKEN");
  restoreEnvKey("MAGISTER_FEISHU_ENCRYPT_KEY");
});

test("GET /feishu/setup returns a redacted readiness snapshot", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/feishu/setup",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      provider: "feishu",
      mode: "websocket",
      ready: true,
      valid: true,
      missingFields: [],
      fields: {
        appId: {
          present: true,
          redactedValue: "cl...id",
        },
        appSecret: {
          present: true,
          redactedValue: "cl...et",
        },
        verificationToken: {
          present: true,
          redactedValue: "cl...en",
        },
        encryptKey: {
          present: true,
          redactedValue: "cl...ey",
        },
      },
    },
  });

  const body = response.json() as {
    data: {
      fields: {
        appId: { rawValue?: string; redactedValue: string };
        appSecret: { rawValue?: string; redactedValue: string };
        verificationToken: { rawValue?: string; redactedValue: string };
        encryptKey: { rawValue?: string; redactedValue: string };
      };
    };
  };

  expect(body.data.fields.appId.rawValue).toBeUndefined();
  expect(body.data.fields.appSecret.rawValue).toBeUndefined();
  expect(body.data.fields.verificationToken.rawValue).toBeUndefined();
  expect(body.data.fields.encryptKey.rawValue).toBeUndefined();
});

test("POST /feishu/setup/test-connection rejects missing Feishu credentials", async () => {
  delete process.env.MAGISTER_FEISHU_APP_ID;
  delete process.env.MAGISTER_FEISHU_APP_SECRET;
  delete process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN;
  delete process.env.MAGISTER_FEISHU_ENCRYPT_KEY;

  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/feishu/setup/test-connection",
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({
    ok: false,
    error: {
      code: "invalid_feishu_config",
      message: "Feishu setup is incomplete",
      details: {
        missingFields: [
          "MAGISTER_FEISHU_APP_ID",
          "MAGISTER_FEISHU_APP_SECRET",
        ],
      },
    },
  });
});

test("POST /feishu/setup/test-connection rejects when channels are disabled", async () => {
  process.env.MAGISTER_DISABLE_CHANNELS = "1";
  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/feishu/setup/test-connection",
  });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({
    ok: false,
    error: {
      code: "channels_disabled",
    },
  });
});
