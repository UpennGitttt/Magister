import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  deleteProviderConfig,
  findProviderReferences,
  listProviderConfigs,
  listProviderPresetCatalog,
  getExecutorReadiness,
  ProviderInUseError,
  readExecutorConfigFile,
} from "../../src/services/executor-config-service";
import type { ExecutorSlotResource } from "../../src/services/executor-slot-service";

const tempRoot = join(process.cwd(), ".tmp-executor-config-service");
let prevDbPath: string | undefined;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  // Isolate the DB too — `findProviderReferences` queries
  // `agent_profiles`, so without this the delete tests would observe
  // whatever rows happen to live in the dev/CI DB.
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("readExecutorConfigFile preserves provider model and binding sections", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {
        reviewer: "qoder",
      },
      providers: {
        codex_chatgpt_cli: {
          label: "Codex CLI",
          vendor: "openai",
          transport: "cli",
          apiDialect: "cli_native",
          auth: {
            kind: "chatgpt_session",
          },
          cli: {
            commandPath: "/opt/homebrew/bin/codex",
            sandboxMode: "danger-full-access",
          },
        },
      },
      models: {
        codex_gpt_5_3: {
          label: "GPT-5.3 Codex",
          vendor: "openai",
          modelName: "gpt-5.3-codex",
          providerRefs: {
            cli: "codex_chatgpt_cli",
          },
        },
      },
      bindings: {
        codex: {
          executionMode: "cli",
          modelRef: "codex_gpt_5_3",
          providerRef: "codex_chatgpt_cli",
          timeoutMs: 7200000,
        },
      },
    }),
  );

  await expect(readExecutorConfigFile()).resolves.toMatchObject({
    roleRouting: {
      reviewer: {
        adapterId: "qoder",
        strategy: "fallback_model",
        fallbackAdapterId: "model",
      },
    },
    providers: {
      codex_chatgpt_cli: expect.objectContaining({
        transport: "cli",
        apiDialect: "cli_native",
      }),
    },
    models: {
      codex_gpt_5_3: expect.objectContaining({
        modelName: "gpt-5.3-codex",
      }),
    },
    bindings: {
      codex: expect.objectContaining({
        executionMode: "cli",
        modelRef: "codex_gpt_5_3",
      }),
    },
  });
});

test("readExecutorConfigFile hydrates missing reviewer fallback adapter for fallback routing", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {
        reviewer: {
          adapterId: "qoder",
          strategy: "fallback_model",
        },
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );

  await expect(readExecutorConfigFile()).resolves.toMatchObject({
    roleRouting: {
      reviewer: {
        adapterId: "qoder",
        strategy: "fallback_model",
        fallbackAdapterId: "model",
      },
    },
  });
});

test("listProviderPresetCatalog exposes provider-only presets", async () => {
  const presets = await listProviderPresetCatalog();
  expect(presets).toHaveLength(4);
  expect(presets).toEqual([
    expect.objectContaining({
      id: "kimi",
      label: "Kimi (Moonshot)",
      vendor: "moonshot",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://api.moonshot.cn/v1",
      auth: expect.objectContaining({ kind: "api_key", secretRef: "MOONSHOT_API_KEY" }),
    }),
    expect.objectContaining({
      id: "glm",
      label: "GLM (Zhipu)",
      vendor: "zhipu",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      auth: expect.objectContaining({ kind: "api_key", secretRef: "ZHIPU_API_KEY" }),
    }),
    expect.objectContaining({
      id: "dashscope",
      label: "DashScope / Qwen",
      vendor: "alibaba",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      auth: expect.objectContaining({ kind: "api_key", secretRef: "DASHSCOPE_API_KEY" }),
    }),
    expect.objectContaining({
      id: "minimax-anthropic",
      label: "MiniMax (Anthropic Compatible)",
      vendor: "minimax",
      transport: "api",
      apiDialect: "anthropic_messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
      auth: expect.objectContaining({ kind: "api_key", secretRef: "MINIMAX_API_KEY" }),
    }),
  ]);
});

test("readExecutorConfigFile normalizes legacy executor files into the expanded config shape", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      codex: {
        authMode: "chatgpt",
        configuredModel: "gpt-5.3-codex",
      },
    }),
  );

  await expect(readExecutorConfigFile()).resolves.toEqual({
    executors: {
      codex: {
        authMode: "chatgpt",
        configuredModel: "gpt-5.3-codex",
      },
    },
    roleRouting: {},
    roleMapping: {},
    providers: {},
    models: {},
    bindings: {},
  });
});

test("getExecutorReadiness resolves legacy configuredModel from executor environment", async () => {
  process.env.MAGISTER_MODEL_CLAUDE_CODE = "claude-sonnet-4.5";

  const config = await readExecutorConfigFile();
  expect(getExecutorReadiness(config, "claude_code")).toMatchObject({
    ready: true,
    missing: [],
  });
});

test("getExecutorSlotList resolves configured model details from bindings before legacy executors", async () => {
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
        codex_chatgpt_cli: {
          label: "Codex CLI",
          vendor: "openai",
          transport: "cli",
          apiDialect: "cli_native",
          auth: {
            kind: "chatgpt_session",
          },
          cli: {
            commandPath: "/opt/homebrew/bin/codex",
            sandboxMode: "danger-full-access",
          },
        },
      },
      models: {
        codex_gpt_5_3: {
          label: "GPT-5.3 Codex",
          vendor: "openai",
          modelName: "gpt-5.3-codex",
          providerRefs: {
            cli: "codex_chatgpt_cli",
          },
        },
      },
      bindings: {
        codex: {
          executionMode: "cli",
          modelRef: "codex_gpt_5_3",
          providerRef: "codex_chatgpt_cli",
          timeoutMs: 7200000,
        },
      },
    }),
  );

  const serviceModulePath = "../../src/services/executor-config-service" + ".ts";
  const { resolveExecutorConfiguration } = await import(serviceModulePath);
  const config = await readExecutorConfigFile();
  const resolved = resolveExecutorConfiguration(config, "codex");
  expect(resolved).toMatchObject({
    configSource: "file",
    modelRef: "codex_gpt_5_3",
    providerRef: "codex_chatgpt_cli",
    configuredModel: "gpt-5.3-codex",
  });

  const slotModulePath = "../../src/services/executor-slot-service" + ".ts";
  const { getExecutorSlotList } = await import(slotModulePath);
  const slots: ExecutorSlotResource[] = await getExecutorSlotList();
  const codexSlot = slots.find((slot) => slot.adapterId === "codex");
  expect(codexSlot).toBeDefined();
  expect(codexSlot?.adapterId).toBe("codex");
  expect(codexSlot?.status).toBe("configured");
  expect(codexSlot?.configSource).toBe("file");
  expect(codexSlot?.authMode).toBe("chatgpt");
  expect(codexSlot?.commandPath).toBe("/opt/homebrew/bin/codex");
  expect(codexSlot?.configuredModel).toBe("gpt-5.3-codex");
  expect(codexSlot?.modelRef).toBe("codex_gpt_5_3");
  expect(codexSlot?.providerRef).toBe("codex_chatgpt_cli");
  expect(codexSlot?.sandboxMode).toBe("danger-full-access");
  expect(codexSlot?.timeoutMs).toBe(7200000);
});

test("deleteProviderConfig refuses when binding still references it", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        prov_a: {
          label: "A",
          vendor: "openai",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://example.com/v1",
          auth: { kind: "api_key", secretRef: "X" },
        },
      },
      models: {
        m1: { modelName: "m1", providerRefs: { api: "prov_a" } },
      },
      bindings: {
        b1: { executionMode: "api", modelRef: "m1", providerRef: "prov_a" },
      },
    }),
  );

  const refs = await findProviderReferences("prov_a");
  expect(refs.length).toBe(2);
  expect(refs).toContainEqual({ kind: "model", modelId: "m1", field: "providerRefs.api" });
  expect(refs).toContainEqual({ kind: "binding", adapterId: "b1", field: "providerRef" });

  await expect(deleteProviderConfig("prov_a")).rejects.toBeInstanceOf(ProviderInUseError);

  const stillThere = (await listProviderConfigs()).find((p) => p.id === "prov_a");
  expect(stillThere).toBeDefined();
});

test("deleteProviderConfig removes orphan provider", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        prov_orphan: {
          label: "Orphan",
          vendor: "openai",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://example.com/v1",
          auth: { kind: "api_key", secretRef: "X" },
        },
      },
      models: {},
      bindings: {},
    }),
  );

  await deleteProviderConfig("prov_orphan");
  const list = await listProviderConfigs();
  expect(list.find((p) => p.id === "prov_orphan")).toBeUndefined();
});

test("findProviderReferences detects agent_profiles refs (providerId, fallbackProviderId, legacy provider)", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        target_prov: {
          label: "Target",
          vendor: "openai",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://example.com/v1",
          auth: { kind: "api_key", secretRef: "X" },
        },
      },
      models: {},
      bindings: {},
    }),
  );

  // Seed three agents, each pointing at target_prov via a different
  // column. The legacy `provider` column is the one we'd previously
  // missed — agent-resolution-service.ts:159 falls back to it when
  // providerId is null.
  const { createDb, agentProfiles } = await import("@magister/db");
  const db = createDb();
  const now = new Date();
  await db.insert(agentProfiles).values([
    { roleId: "agent_via_provider_id", displayName: "x", providerId: "target_prov", createdAt: now, updatedAt: now },
    { roleId: "agent_via_fallback", displayName: "y", fallbackProviderId: "target_prov", createdAt: now, updatedAt: now },
    { roleId: "agent_via_legacy", displayName: "z", provider: "target_prov", createdAt: now, updatedAt: now },
  ]);

  const refs = await findProviderReferences("target_prov");
  expect(refs.length).toBe(3);
  expect(refs).toContainEqual({ kind: "agent", roleId: "agent_via_provider_id", field: "providerId" });
  expect(refs).toContainEqual({ kind: "agent", roleId: "agent_via_fallback", field: "fallbackProviderId" });
  expect(refs).toContainEqual({ kind: "agent", roleId: "agent_via_legacy", field: "provider" });

  await expect(deleteProviderConfig("target_prov")).rejects.toBeInstanceOf(ProviderInUseError);
});

test("deleteProviderConfig cascade=true removes bindings, clears matching model refs, and nulls agent fields", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        target: {
          label: "Target",
          vendor: "openai",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://example.com/v1",
          auth: { kind: "api_key", secretRef: "X" },
        },
        keep: {
          label: "Keep",
          vendor: "openai",
          transport: "cli",
          apiDialect: "cli_native",
          auth: { kind: "none" },
          cli: { commandPath: "/usr/bin/foo" },
        },
      },
      models: {
        m_api_only: { modelName: "a", providerRefs: { api: "target" } },
        m_dual: { modelName: "b", providerRefs: { api: "target", cli: "keep" } },
        m_unrelated: { modelName: "c", providerRefs: { api: "keep" } },
      },
      bindings: {
        b_target: { executionMode: "api", modelRef: "m_api_only", providerRef: "target" },
        b_keep: { executionMode: "cli", modelRef: "m_dual", providerRef: "keep" },
      },
    }),
  );

  const { createDb, agentProfiles } = await import("@magister/db");
  const db = createDb();
  const now = new Date();
  await db.insert(agentProfiles).values([
    { roleId: "agent_pri", displayName: "p", providerId: "target", createdAt: now, updatedAt: now },
    { roleId: "agent_fb", displayName: "f", providerId: "keep", fallbackProviderId: "target", createdAt: now, updatedAt: now },
    { roleId: "agent_legacy", displayName: "l", provider: "target", createdAt: now, updatedAt: now },
    { roleId: "agent_unrelated", displayName: "u", providerId: "keep", createdAt: now, updatedAt: now },
  ]);

  const result = await deleteProviderConfig("target", { cascade: true });
  expect(result?.cascade).toBeDefined();
  const c = result!.cascade!;
  expect(c.bindingsRemoved).toEqual(["b_target"]);
  expect(c.modelsRemoved).toEqual(["m_api_only"]);
  expect(c.modelsCleared).toEqual(["m_dual"]);
  expect(c.agentsCleared.map((a) => a.roleId).sort()).toEqual(["agent_fb", "agent_legacy", "agent_pri"]);

  const after = await listProviderConfigs();
  expect(after.find((p) => p.id === "target")).toBeUndefined();
  expect(after.find((p) => p.id === "keep")).toBeDefined();

  // Re-read config to verify model/binding state
  const onDisk = JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8"));
  expect(onDisk.bindings.b_target).toBeUndefined();
  expect(onDisk.bindings.b_keep).toBeDefined();
  expect(onDisk.models.m_api_only).toBeUndefined();
  expect(onDisk.models.m_dual.providerRefs).toEqual({ cli: "keep" });
  expect(onDisk.models.m_unrelated.providerRefs).toEqual({ api: "keep" });

  // Agent state
  const profilesAfter = await db.select().from(agentProfiles);
  const byRole = new Map(profilesAfter.map((p) => [p.roleId, p]));
  expect(byRole.get("agent_pri")?.providerId).toBeNull();
  expect(byRole.get("agent_fb")?.fallbackProviderId).toBeNull();
  expect(byRole.get("agent_fb")?.providerId).toBe("keep"); // untouched
  expect(byRole.get("agent_legacy")?.provider).toBeNull();
  expect(byRole.get("agent_unrelated")?.providerId).toBe("keep"); // untouched
});

test("deleteProviderConfig is idempotent on missing provider", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  writeFileSync(
    configPath,
    JSON.stringify({ executors: {}, roleRouting: {}, providers: {}, models: {}, bindings: {} }),
  );
  await expect(deleteProviderConfig("not_there")).resolves.toBeUndefined();
});
