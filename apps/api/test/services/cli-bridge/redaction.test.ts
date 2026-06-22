import { expect, test } from "bun:test";

import { redactMcpConfig } from "../../../src/services/cli-bridge/redaction";

test("redactMcpConfig: redacts Authorization header value", () => {
  const out = redactMcpConfig({
    type: "remote",
    url: "https://example/mcp",
    headers: {
      Authorization: "Bearer sk-dba97bdbe4ec4e82864bd2a1a6cccdf6",
      "Other-Header": "harmless-value",
    },
    enabled: true,
  });
  expect((out.headers as Record<string, string>).Authorization).toBe("[REDACTED]");
  // Lowercase variant case-insensitive
  expect(out.url).toBe("https://example/mcp");
  expect(out.enabled).toBe(true);
});

test("redactMcpConfig: redacts X-API-Key header (case-insensitive)", () => {
  const out = redactMcpConfig({
    headers: { "x-api-key": "supersecret-value-12345678" },
  });
  expect((out.headers as Record<string, string>)["x-api-key"]).toBe("[REDACTED]");
});

test("redactMcpConfig: redacts top-level string matching secret regex", () => {
  const out = redactMcpConfig({
    name: "github",
    bearer_token_env_var: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  expect(out.name).toBe("github");
  expect(out.bearer_token_env_var).toBe("[REDACTED]");
});

test("redactMcpConfig: redacts all env values", () => {
  const out = redactMcpConfig({
    env: {
      GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      DEBUG: "1",
    },
  });
  expect((out.env as Record<string, string>).GITHUB_TOKEN).toBe("[REDACTED]");
  expect((out.env as Record<string, string>).DEBUG).toBe("[REDACTED]");
});

test("redactMcpConfig: leaves benign config alone", () => {
  const input = {
    type: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
    enabled: true,
  };
  expect(redactMcpConfig(input)).toEqual(input);
});

test("redactMcpConfig: handles nested object", () => {
  const out = redactMcpConfig({
    transport: {
      type: "http",
      url: "https://x",
      bearer_token_env_var: "Bearer sk-livesecret-3afdfae3afdfae3afdfae",
    },
  });
  expect((out.transport as Record<string, unknown>).bearer_token_env_var).toBe("[REDACTED]");
  expect((out.transport as Record<string, unknown>).url).toBe("https://x");
});

test("redactMcpConfig: doesn't mutate the input", () => {
  const input = {
    headers: { Authorization: "Bearer sk-realsecretvaluethatlongenough" },
  };
  const original = JSON.parse(JSON.stringify(input));
  redactMcpConfig(input);
  expect(input).toEqual(original);
});

test("redactMcpConfig: short non-secret strings not flagged", () => {
  // Don't false-positive on short strings that happen to start with sk-
  const out = redactMcpConfig({ note: "sk-yes" });
  expect(out.note).toBe("sk-yes");
});
