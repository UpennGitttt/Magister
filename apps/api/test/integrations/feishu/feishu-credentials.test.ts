import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { applyFeishuCredentials } from "../../../src/integrations/feishu/feishu-credentials";

let dir: string;
let prevStorePath: string | undefined;
let prevAppId: string | undefined;
let prevAppSecret: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feishu-cred-"));
  prevStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  process.env.MAGISTER_SECRET_STORE_PATH = join(dir, "secrets.json");
  prevAppId = process.env.MAGISTER_FEISHU_APP_ID;
  prevAppSecret = process.env.MAGISTER_FEISHU_APP_SECRET;
  delete process.env.MAGISTER_FEISHU_APP_ID;
  delete process.env.MAGISTER_FEISHU_APP_SECRET;
});

afterEach(() => {
  if (prevStorePath === undefined) delete process.env.MAGISTER_SECRET_STORE_PATH;
  else process.env.MAGISTER_SECRET_STORE_PATH = prevStorePath;
  if (prevAppId === undefined) delete process.env.MAGISTER_FEISHU_APP_ID;
  else process.env.MAGISTER_FEISHU_APP_ID = prevAppId;
  if (prevAppSecret === undefined) delete process.env.MAGISTER_FEISHU_APP_SECRET;
  else process.env.MAGISTER_FEISHU_APP_SECRET = prevAppSecret;
  rmSync(dir, { recursive: true, force: true });
});

test("applyFeishuCredentials persists creds to the store and reports ready", () => {
  const state = applyFeishuCredentials({ appId: "wizard-app-id", appSecret: "wizard-app-secret" });

  expect(state.ready).toBe(true);
  expect(state.missingFields).toEqual([]);

  const store = JSON.parse(readFileSync(process.env.MAGISTER_SECRET_STORE_PATH!, "utf8"));
  expect(store.secrets.MAGISTER_FEISHU_APP_ID.value).toBe("wizard-app-id");
  expect(store.secrets.MAGISTER_FEISHU_APP_SECRET.value).toBe("wizard-app-secret");

  // the returned state must never leak raw secret values
  expect(JSON.stringify(state)).not.toContain("wizard-app-secret");
});

test("applyFeishuCredentials ignores blank/absent fields (no clobber)", () => {
  applyFeishuCredentials({ appId: "only-id", appSecret: "   " });

  const store = JSON.parse(readFileSync(process.env.MAGISTER_SECRET_STORE_PATH!, "utf8"));
  expect(store.secrets.MAGISTER_FEISHU_APP_ID.value).toBe("only-id");
  expect(store.secrets.MAGISTER_FEISHU_APP_SECRET).toBeUndefined();
});
