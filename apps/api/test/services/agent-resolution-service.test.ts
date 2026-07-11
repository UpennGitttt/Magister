import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentProfiles, createDb } from "@magister/db";

import {
  resolveAgentConfig,
  resolveAgentForRole,
} from "../../src/services/agent-resolution-service";

const tempRoot = join(process.cwd(), ".tmp-agent-resolution-service");

type SeedAgentInput = {
  roleId: string;
  runtimeType?: "ucm" | "codex" | "opencode" | "claude-code";
  modelName?: string | null;
  providerId?: string | null;
  commandPath?: string | null;
  customEnv?: string | null;
  customArgs?: string | null;
  reasoningMode?: string | null;
  reasoningEffort?: string | null;
  fallbackModelName?: string | null;
  fallbackProviderId?: string | null;
};

function writeExecutorConfig(input: {
  providers?: Record<string, unknown>;
  models?: Record<string, unknown>;
  roleMapping?: Record<string, string>;
}) {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected MAGISTER_EXECUTOR_CONFIG_PATH");
  }

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        executors: {},
        roleRouting: {},
        providers: input.providers ?? {},
        models: input.models ?? {},
        bindings: {},
        roleMapping: input.roleMapping ?? {},
      },
      null,
      2,
    ),
  );
}

async function seedAgentProfile(input: SeedAgentInput) {
  const db = createDb();
  const now = new Date();
  await db.insert(agentProfiles).values({
    roleId: input.roleId,
    label: input.roleId,
    displayName: input.roleId,
    runtimeType: input.runtimeType ?? "ucm",
    modelName: input.modelName ?? null,
    providerId: input.providerId ?? null,
    commandPath: input.commandPath ?? null,
    customEnv: input.customEnv ?? null,
    customArgs: input.customArgs ?? null,
    reasoningMode: input.reasoningMode ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    fallbackModelName: input.fallbackModelName ?? null,
    fallbackProviderId: input.fallbackProviderId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `agent-resolution-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("resolveAgentConfig returns Magister runtime with model and provider", async () => {
  writeExecutorConfig({
    providers: {
      "volcengine-ark": {
        label: "Volcengine ARK",
        vendor: "volcengine",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {
          kind: "api_key",
          secretRef: "VOLCENGINE_ARK_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
  });
  await seedAgentProfile({
    roleId: "kimi-manager",
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    providerId: "volcengine-ark",
  });

  const resolved = await resolveAgentConfig("kimi-manager");
  expect(resolved).not.toBeNull();
  expect(resolved).toMatchObject({
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    provider: {
      id: "volcengine-ark",
      label: "Volcengine ARK",
      apiDialect: "openai_chat_completions",
    },
  });
});

test("resolveAgentConfig returns CLI runtime with commandPath and no provider", async () => {
  writeExecutorConfig({ providers: {} });
  await seedAgentProfile({
    roleId: "codex-heavy",
    runtimeType: "codex",
    modelName: "gpt-5.4",
    commandPath: "/usr/bin/codex",
  });

  const resolved = await resolveAgentConfig("codex-heavy");
  expect(resolved).not.toBeNull();
  expect(resolved).toMatchObject({
    runtimeType: "codex",
    modelName: "gpt-5.4",
    commandPath: "/usr/bin/codex",
  });
  expect(resolved?.provider).toBeUndefined();
});

test("resolveAgentConfig coerces leader runtime to Magister", async () => {
  writeExecutorConfig({
    providers: {
      "volcengine-ark": {
        label: "Volcengine ARK",
        vendor: "volcengine",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {
          kind: "api_key",
          secretRef: "VOLCENGINE_ARK_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
  });
  await seedAgentProfile({
    roleId: "leader",
    runtimeType: "codex",
    modelName: "kimi-k2.6-ark",
    providerId: "volcengine-ark",
    commandPath: "/usr/bin/codex",
  });

  const resolved = await resolveAgentConfig("leader");
  expect(resolved).not.toBeNull();
  expect(resolved?.runtimeType).toBe("ucm");
  expect(resolved?.provider?.id).toBe("volcengine-ark");
  expect(resolved?.commandPath).toBeUndefined();
});

test("resolveAgentConfig keeps claude-code runtime for leader", async () => {
  writeExecutorConfig({ providers: {} });
  await seedAgentProfile({
    roleId: "leader",
    runtimeType: "claude-code",
    modelName: "claude-sonnet-5",
    commandPath: "/usr/local/bin/claude",
  });

  const resolved = await resolveAgentConfig("leader");
  expect(resolved).not.toBeNull();
  expect(resolved?.runtimeType).toBe("claude-code");
  expect(resolved?.modelName).toBe("claude-sonnet-5");
  expect(resolved?.commandPath).toBe("/usr/local/bin/claude");
  expect(resolved?.provider).toBeUndefined();
});

test("resolveAgentConfig returns null for missing agent", async () => {
  writeExecutorConfig({ providers: {} });
  await expect(resolveAgentConfig("missing-agent")).resolves.toBeNull();
});

test("resolveAgentForRole resolves roleMapping to agent id", async () => {
  writeExecutorConfig({
    roleMapping: {
      manager: "kimi-manager",
    },
    providers: {
      "volcengine-ark": {
        label: "Volcengine ARK",
        vendor: "volcengine",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {
          kind: "api_key",
          secretRef: "VOLCENGINE_ARK_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
  });
  await seedAgentProfile({
    roleId: "kimi-manager",
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    providerId: "volcengine-ark",
  });

  const resolved = await resolveAgentForRole("leader");
  expect(resolved).not.toBeNull();
  expect(resolved?.agent.roleId).toBe("kimi-manager");
});

test("resolveAgentForRole returns null when role is unmapped", async () => {
  writeExecutorConfig({
    roleMapping: {
      manager: "kimi-manager",
    },
    providers: {},
  });

  await expect(resolveAgentForRole("not-mapped")).resolves.toBeNull();
});

test("resolveAgentConfig returns null and warns when provider record is missing", async () => {
  writeExecutorConfig({ providers: {} });
  await seedAgentProfile({
    roleId: "kimi-broken",
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    providerId: "missing-provider",
  });

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const resolved = await resolveAgentConfig("kimi-broken");
    expect(resolved).toBeNull();
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings.length).toBeGreaterThan(0);
});

test("resolveAgentConfig returns reasoning for Magister profile", async () => {
  writeExecutorConfig({
    providers: {
      "volcengine-ark": {
        label: "Volcengine ARK",
        vendor: "volcengine",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {
          kind: "api_key",
          secretRef: "VOLCENGINE_ARK_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
  });
  await seedAgentProfile({
    roleId: "kimi-reasoning",
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    providerId: "volcengine-ark",
    reasoningMode: "on",
    reasoningEffort: "high",
  });

  const resolved = await resolveAgentConfig("kimi-reasoning");
  expect(resolved).not.toBeNull();
  expect(resolved?.reasoning).toEqual({
    mode: "on",
    effort: "high",
  });
});

test("resolveAgentConfig parses customEnv and customArgs for CLI profile", async () => {
  writeExecutorConfig({ providers: {} });
  await seedAgentProfile({
    roleId: "codex-env",
    runtimeType: "codex",
    modelName: "gpt-5.4",
    commandPath: "/usr/bin/codex",
    customEnv: "{\"KEY\":\"val\"}",
    customArgs: "[\"--flag\"]",
  });

  const resolved = await resolveAgentConfig("codex-env");
  expect(resolved).not.toBeNull();
  expect(resolved).toMatchObject({
    runtimeType: "codex",
    customEnv: { KEY: "val" },
    customArgs: ["--flag"],
  });
});

test("resolveAgentConfig falls back to model.providerRefs.api when agent.providerId is null", async () => {
  // The user-visible regression: leader agent had model_name set but
  // provider_id null (e.g. seeded that way, or nulled by a cascade
  // delete). Resolution returned null and the leader hung. Model
  // already knew its provider via providerRefs — resolution now
  // pulls it forward instead of failing.
  writeExecutorConfig({
    providers: {
      "volcengine-ark": {
        label: "Volcengine ARK",
        vendor: "volcengine",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://example.com/v1",
        auth: { kind: "api_key", secretRef: "K" },
      },
    },
    models: {
      "kimi-k2.6-ark": {
        modelName: "kimi-k2.6-ark",
        providerRefs: { api: "volcengine-ark" },
      },
    },
  });
  await seedAgentProfile({
    roleId: "leader",
    runtimeType: "ucm",
    modelName: "kimi-k2.6-ark",
    providerId: null, // ← the smoking gun
  });

  const resolved = await resolveAgentConfig("leader");
  expect(resolved).not.toBeNull();
  expect(resolved?.provider?.id).toBe("volcengine-ark");
});

test("resolveAgentConfig falls back to model.providerRefs.cli when no api ref present", async () => {
  writeExecutorConfig({
    providers: {
      "codex-cli-prov": {
        label: "Codex CLI",
        vendor: "openai",
        transport: "cli",
        apiDialect: "cli_native",
        auth: { kind: "chatgpt_session" },
        cli: { commandPath: "/usr/bin/codex" },
      },
    },
    models: {
      "codex-gpt-5.4": {
        modelName: "gpt-5.4",
        providerRefs: { cli: "codex-cli-prov" },
      },
    },
  });
  await seedAgentProfile({
    roleId: "no-provider-cli",
    runtimeType: "ucm",
    modelName: "codex-gpt-5.4",
    providerId: null,
  });

  const resolved = await resolveAgentConfig("no-provider-cli");
  expect(resolved).not.toBeNull();
  expect(resolved?.provider?.id).toBe("codex-cli-prov");
});

test("resolveAgentConfig resolves the fallback's OWN capabilityHints/maxOutputTokens from config.models (PR2 wiring)", async () => {
  writeExecutorConfig({
    providers: {
      "prov-main": {
        label: "Main",
        vendor: "anthropic",
        transport: "api",
        apiDialect: "anthropic_messages",
        baseUrl: "https://main.example.com",
        auth: { kind: "none" },
      },
    },
    models: {
      // Primary: vision-capable, large output.
      "claude-main": {
        modelName: "claude-main",
        providerRefs: { api: "prov-main" },
        capabilityHints: { vision: true },
        maxOutputTokens: 16000,
      },
      // Fallback: a text-only shim with a smaller output limit.
      "qwen-textonly-fallback": {
        modelName: "qwen-textonly-fallback",
        providerRefs: { api: "prov-main" },
        capabilityHints: { vision: false },
        maxOutputTokens: 4096,
      },
    },
  });
  await seedAgentProfile({
    roleId: "pr2-agent",
    runtimeType: "ucm",
    modelName: "claude-main",
    providerId: "prov-main",
    fallbackModelName: "qwen-textonly-fallback",
  });

  const resolved = await resolveAgentConfig("pr2-agent");
  expect(resolved).not.toBeNull();
  // The fallback must carry its OWN capability, not the primary's vision:true.
  expect(resolved?.fallback?.modelName).toBe("qwen-textonly-fallback");
  expect((resolved?.fallback?.capabilityHints as { vision?: boolean })?.vision).toBe(false);
  expect(resolved?.fallback?.maxOutputTokens).toBe(4096);
});
