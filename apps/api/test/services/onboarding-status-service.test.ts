import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import type { ProviderAuthConfig } from "../../src/providers/types";
import { summarizeProviderReadiness } from "../../src/services/onboarding-status-service";

let dir: string;
let prevStorePath: string | undefined;
let prevAnthropicKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "onboarding-"));
  prevStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  process.env.MAGISTER_SECRET_STORE_PATH = join(dir, "secrets.json");
  prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (prevStorePath === undefined) delete process.env.MAGISTER_SECRET_STORE_PATH;
  else process.env.MAGISTER_SECRET_STORE_PATH = prevStorePath;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  rmSync(dir, { recursive: true, force: true });
});

const apiKeyProvider = (secretRef: string) => ({
  auth: { kind: "api_key", secretRef } as ProviderAuthConfig,
});

test("no providers → not configured", () => {
  expect(summarizeProviderReadiness({})).toEqual({ total: 0, readyCount: 0, configured: false });
});

test("api_key provider with a stored secret → configured", () => {
  writeFileSync(
    process.env.MAGISTER_SECRET_STORE_PATH!,
    JSON.stringify({ secrets: { ANTHROPIC_API_KEY: { value: "sk-test", updatedAt: new Date(0).toISOString() } } }),
  );
  expect(summarizeProviderReadiness({ anthropic: apiKeyProvider("ANTHROPIC_API_KEY") })).toEqual({
    total: 1,
    readyCount: 1,
    configured: true,
  });
});

test("api_key provider with a missing secret → not configured", () => {
  writeFileSync(process.env.MAGISTER_SECRET_STORE_PATH!, JSON.stringify({ secrets: {} }));
  expect(summarizeProviderReadiness({ anthropic: apiKeyProvider("ANTHROPIC_API_KEY") })).toEqual({
    total: 1,
    readyCount: 0,
    configured: false,
  });
});

test("a no-key (kind none) provider counts as usable", () => {
  expect(
    summarizeProviderReadiness({ local: { auth: { kind: "none" } as ProviderAuthConfig } }),
  ).toEqual({ total: 1, readyCount: 1, configured: true });
});
