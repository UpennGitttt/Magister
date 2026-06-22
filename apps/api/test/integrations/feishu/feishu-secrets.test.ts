import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  buildFeishuSecretSnapshot,
  parseFeishuConfigFromEnv,
} from "../../../src/integrations/feishu/feishu-config";

test("feishu secrets snapshot never exposes raw values", () => {
  const config = {
    appId: "cli-agent-app-id",
    appSecret: "cli-agent-app-secret",
    verificationToken: "cli-agent-verification-token",
    encryptKey: "cli-agent-encrypt-key",
  };

  const snapshot = buildFeishuSecretSnapshot(config);

  expect(snapshot).toEqual({
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
  });
  expect(JSON.stringify(snapshot)).not.toContain("cli-agent-app-id");
  expect(JSON.stringify(snapshot)).not.toContain("cli-agent-app-secret");
  expect(JSON.stringify(snapshot)).not.toContain("cli-agent-verification-token");
  expect(JSON.stringify(snapshot)).not.toContain("cli-agent-encrypt-key");
});

test("parseFeishuConfigFromEnv reports missing fields without leaking values", () => {
  delete process.env.MAGISTER_FEISHU_APP_ID;
  delete process.env.MAGISTER_FEISHU_APP_SECRET;
  delete process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN;
  delete process.env.MAGISTER_FEISHU_ENCRYPT_KEY;

  const config = parseFeishuConfigFromEnv();

  expect(config).toEqual({
    connectionMode: "websocket",
    appId: undefined,
    appSecret: undefined,
    verificationToken: undefined,
    encryptKey: undefined,
    missingFields: ["MAGISTER_FEISHU_APP_ID", "MAGISTER_FEISHU_APP_SECRET"],
  });
});

test("parseFeishuConfigFromEnv reads creds from the secret store when env is unset (store→env fallback)", () => {
  delete process.env.MAGISTER_FEISHU_APP_ID;
  delete process.env.MAGISTER_FEISHU_APP_SECRET;
  delete process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN;
  delete process.env.MAGISTER_FEISHU_ENCRYPT_KEY;

  const dir = mkdtempSync(join(tmpdir(), "feishu-store-"));
  const storePath = join(dir, "secrets.json");
  writeFileSync(
    storePath,
    JSON.stringify({
      secrets: {
        MAGISTER_FEISHU_APP_ID: { value: "store-app-id", updatedAt: new Date(0).toISOString() },
        MAGISTER_FEISHU_APP_SECRET: { value: "store-app-secret", updatedAt: new Date(0).toISOString() },
      },
    }),
  );
  const prevStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  process.env.MAGISTER_SECRET_STORE_PATH = storePath;

  try {
    const config = parseFeishuConfigFromEnv();
    expect(config.appId).toBe("store-app-id");
    expect(config.appSecret).toBe("store-app-secret");
    expect(config.missingFields).toEqual([]);
  } finally {
    if (prevStorePath === undefined) {
      delete process.env.MAGISTER_SECRET_STORE_PATH;
    } else {
      process.env.MAGISTER_SECRET_STORE_PATH = prevStorePath;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env still wins as a fallback when the secret store has no feishu entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-store-empty-"));
  const storePath = join(dir, "secrets.json");
  writeFileSync(storePath, JSON.stringify({ secrets: {} }));
  const prevStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  process.env.MAGISTER_SECRET_STORE_PATH = storePath;
  process.env.MAGISTER_FEISHU_APP_ID = "env-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "env-app-secret";

  try {
    const config = parseFeishuConfigFromEnv();
    expect(config.appId).toBe("env-app-id");
    expect(config.appSecret).toBe("env-app-secret");
    expect(config.missingFields).toEqual([]);
  } finally {
    if (prevStorePath === undefined) {
      delete process.env.MAGISTER_SECRET_STORE_PATH;
    } else {
      process.env.MAGISTER_SECRET_STORE_PATH = prevStorePath;
    }
    delete process.env.MAGISTER_FEISHU_APP_ID;
    delete process.env.MAGISTER_FEISHU_APP_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});
