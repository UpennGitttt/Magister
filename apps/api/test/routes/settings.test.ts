import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-settings-route");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `settings-route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
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
  rmSync(tempRoot, { recursive: true, force: true });
});

test("executor settings routes list and persist configured models", async () => {
  const app = buildApp();

  const initialResponse = await app.inject({
    method: "GET",
    url: "/settings/executors",
  });

  expect(initialResponse.statusCode).toBe(200);
  expect(initialResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          status: "unconfigured",
        }),
      ]),
    },
  });

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/executors/codex",
    payload: {
      authMode: "chatgpt",
      commandPath: "/opt/homebrew/bin/codex",
      configuredModel: "gpt-5.3-codex",
      sandboxMode: "danger-full-access",
      timeoutMs: 180000,
    },
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json()).toMatchObject({
    ok: true,
    data: {
      adapterId: "codex",
      authMode: "chatgpt",
      commandPath: "/opt/homebrew/bin/codex",
      configuredModel: "gpt-5.3-codex",
      sandboxMode: "danger-full-access",
      status: "configured",
      timeoutMs: 180000,
    },
  });

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
    executors: {
      codex: {
        authMode: "chatgpt",
        commandPath: "/opt/homebrew/bin/codex",
        configuredModel: "gpt-5.3-codex",
        sandboxMode: "danger-full-access",
        timeoutMs: 180000,
      },
    },
    roleRouting: {},
    roleMapping: {},
    providers: {},
    models: {},
    bindings: {},
  });
});

test("executor settings routes preserve legacy CLI readiness for configured executors without bindings", async () => {
  const app = buildApp();

  await app.inject({
    method: "PUT",
    url: "/settings/executors/codex",
    payload: {
      authMode: "chatgpt",
      commandPath: "/opt/homebrew/bin/codex",
      configuredModel: "gpt-5.3-codex",
      sandboxMode: "danger-full-access",
      timeoutMs: 180000,
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/settings/executors",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          readiness: {
            ready: true,
            missing: [],
          },
        }),
      ]),
    },
  });
});

test("agent settings route persists per-agent tool restrictions", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "PUT",
    url: "/settings/agents/custom_restricted",
    payload: {
      label: "Custom Restricted",
      allowedTools: ["bash", "read_file"],
      disallowedTools: ["web_search"],
      maxTurns: 5,
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      roleId: "custom_restricted",
      allowedTools: ["bash", "read_file"],
      disallowedTools: ["web_search"],
      maxTurns: 5,
    },
  });
});

test("partial PUT without tool-restriction fields preserves existing values", async () => {
  // Regression: prior route did `body.allowedTools ?? null`, which
  // coerced an OMITTED key into an explicit null and silently
  // cleared the user's restrictions on any unrelated profile save.
  const app = buildApp();

  const setup = await app.inject({
    method: "PUT",
    url: "/settings/agents/custom_partial_put",
    payload: {
      label: "Initial",
      allowedTools: ["bash", "read_file"],
      disallowedTools: ["web_search"],
    },
  });
  expect(setup.statusCode).toBe(200);

  // Second PUT omits allow/deny entirely — should NOT clear them.
  const update = await app.inject({
    method: "PUT",
    url: "/settings/agents/custom_partial_put",
    payload: { label: "Renamed" },
  });
  expect(update.statusCode).toBe(200);
  expect(update.json().data).toMatchObject({
    label: "Renamed",
    allowedTools: ["bash", "read_file"],
    disallowedTools: ["web_search"],
  });

  // Explicit null (vs omitted) DOES clear, matching service contract.
  const clear = await app.inject({
    method: "PUT",
    url: "/settings/agents/custom_partial_put",
    payload: { allowedTools: null, disallowedTools: null },
  });
  expect(clear.statusCode).toBe(200);
  expect(clear.json().data.allowedTools).toBeNull();
  expect(clear.json().data.disallowedTools).toBeNull();
});

test("GET /settings/tools exposes canonical tools without plan-mode tools", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/settings/tools",
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  const names = body.data.items.map((item: { name: string }) => item.name);
  expect(names).toContain("bash");
  expect(names).toContain("spawn_teammate");
  expect(names).not.toContain("enter_plan_mode");
  expect(names).not.toContain("exit_plan_mode");
  expect(body.data.items).toContainEqual(expect.objectContaining({
    name: "bash",
    description: expect.any(String),
  }));
});

test("agent tool restrictions accept every tool exposed by settings tools", async () => {
  const app = buildApp();

  const toolsResponse = await app.inject({
    method: "GET",
    url: "/settings/tools",
  });
  expect(toolsResponse.statusCode).toBe(200);

  const names = toolsResponse.json().data.items.map((item: { name: string }) => item.name);
  expect(names.length).toBeGreaterThan(0);

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/agents/custom_every_tool",
    payload: {
      label: "Custom Every Tool",
      allowedTools: names,
    },
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json().data.allowedTools).toEqual(names);
});

test("role routing routes expose defaults and persist overrides", async () => {
  const app = buildApp();

  const initialResponse = await app.inject({
    method: "GET",
    url: "/settings/role-routing",
  });

  expect(initialResponse.statusCode).toBe(200);
  expect(initialResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          roleId: "leader",
          adapterId: "model",
          strategy: "model_only",
          source: "default",
        }),
        expect.objectContaining({
          roleId: "reviewer",
          adapterId: "qoder",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
          source: "default",
        }),
      ]),
    },
  });

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/role-routing/reviewer",
    payload: {
      adapterId: "codex",
    },
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json()).toMatchObject({
    ok: true,
    data: {
      roleId: "reviewer",
      adapterId: "codex",
      strategy: "fallback_model",
      fallbackAdapterId: "model",
      source: "file",
    },
  });

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
    executors: {},
    roleRouting: {
      reviewer: {
        adapterId: "codex",
        strategy: "fallback_model",
        fallbackAdapterId: "model",
      },
    },
    roleMapping: {},
    providers: {},
    models: {},
    bindings: {},
  });
});

test("role routing routes hydrate missing reviewer fallback adapter in stored config", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  rmSync(configPath, { force: true });
  await Bun.write(
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

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/settings/role-routing",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          roleId: "reviewer",
          adapterId: "qoder",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
          source: "file",
        }),
      ]),
    },
  });
});

test("executor settings updates preserve provider model and binding sections already present in file", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  rmSync(configPath, { force: true });
  await Bun.write(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        kimi_main: {
          presetId: "kimi",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          auth: {
            kind: "api_key",
            secretRef: "MOONSHOT_API_KEY",
          },
        },
      },
      models: {
        kimi_k2_5: {
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "kimi_main",
          },
        },
      },
      bindings: {
        planner_api: {
          executionMode: "api",
          modelRef: "kimi_k2_5",
          providerRef: "kimi_main",
          timeoutMs: 120000,
        },
      },
    }),
  );

  const app = buildApp();
  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/executors/codex",
    payload: {
      configuredModel: "gpt-5.3-codex",
    },
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
    executors: {
      codex: {
        configuredModel: "gpt-5.3-codex",
      },
    },
    roleRouting: {},
    roleMapping: {},
    providers: {
      kimi_main: {
        presetId: "kimi",
        vendor: "moonshot",
        transport: "api",
        apiDialect: "openai_chat_completions",
        auth: {
          kind: "api_key",
          secretRef: "MOONSHOT_API_KEY",
        },
      },
    },
    models: {
      kimi_k2_5: {
        modelName: "kimi-k2.5-thinking-preview",
        providerRefs: {
          api: "kimi_main",
        },
      },
    },
    bindings: {
      planner_api: {
        executionMode: "api",
        modelRef: "kimi_k2_5",
        providerRef: "kimi_main",
        timeoutMs: 120000,
      },
    },
  });
});

test("provider model and binding routes read and persist minimal v1 sections", async () => {
  const app = buildApp();

  const emptyProvidersResponse = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(emptyProvidersResponse.statusCode).toBe(200);
  expect(emptyProvidersResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [],
    },
  });

  const providerUpdateResponse = await app.inject({
    method: "PUT",
    url: "/settings/providers/kimi_main",
    payload: {
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
  });

  expect(providerUpdateResponse.statusCode).toBe(200);
  expect(providerUpdateResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "kimi_main",
      label: "Kimi Main",
      vendor: "moonshot",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://api.moonshot.ai/v1",
      auth: {
        kind: "api_key",
        secretRef: "[redacted]",
      },
    },
  });

  const providersResponse = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(providersResponse.statusCode).toBe(200);
  expect(providersResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          id: "kimi_main",
          vendor: "moonshot",
          transport: "api",
        }),
      ],
    },
  });

  const modelUpdateResponse = await app.inject({
    method: "PUT",
    url: "/settings/models/kimi_k2_5",
    payload: {
      label: "Kimi K2.5",
      vendor: "moonshot",
      modelName: "kimi-k2.5-thinking-preview",
      providerRefs: {
        api: "kimi_main",
      },
      defaultReasoning: {
        mode: "auto",
        effort: "medium",
      },
    },
  });

  expect(modelUpdateResponse.statusCode).toBe(200);
  expect(modelUpdateResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "kimi_k2_5",
      label: "Kimi K2.5",
      vendor: "moonshot",
      modelName: "kimi-k2.5-thinking-preview",
      providerRefs: {
        api: "kimi_main",
      },
      defaultReasoning: {
        mode: "auto",
        effort: "medium",
      },
    },
  });

  const bindingUpdateResponse = await app.inject({
    method: "PUT",
    url: "/settings/bindings/codex",
    payload: {
      executionMode: "api",
      modelRef: "kimi_k2_5",
      providerRef: "kimi_main",
      timeoutMs: 120000,
    },
  });

  expect(bindingUpdateResponse.statusCode).toBe(200);
  expect(bindingUpdateResponse.json()).toMatchObject({
    ok: true,
    data: {
      adapterId: "codex",
      executionMode: "api",
      modelRef: "kimi_k2_5",
      providerRef: "kimi_main",
      timeoutMs: 120000,
    },
  });

  const bindingsResponse = await app.inject({
    method: "GET",
    url: "/settings/bindings",
  });
  expect(bindingsResponse.statusCode).toBe(200);
  expect(bindingsResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          adapterId: "codex",
          executionMode: "api",
          modelRef: "kimi_k2_5",
        }),
      ],
    },
  });

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
    executors: {},
    roleRouting: {},
    roleMapping: {},
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
    models: {
      kimi_k2_5: {
        label: "Kimi K2.5",
        vendor: "moonshot",
        modelName: "kimi-k2.5-thinking-preview",
        providerRefs: {
          api: "kimi_main",
        },
        defaultReasoning: {
          mode: "auto",
          effort: "medium",
        },
      },
    },
    bindings: {
      codex: {
        executionMode: "api",
        modelRef: "kimi_k2_5",
        providerRef: "kimi_main",
        timeoutMs: 120000,
      },
    },
  });
});

test("executor settings list exposes binding-derived execution mode and refs", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  rmSync(configPath, { force: true });
  await Bun.write(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        kimi_main: {
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          auth: {
            kind: "api_key",
            secretRef: "MOONSHOT_API_KEY",
          },
        },
      },
      models: {
        kimi_k2_5: {
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "kimi_main",
          },
        },
      },
      bindings: {
        codex: {
          executionMode: "api",
          modelRef: "kimi_k2_5",
          providerRef: "kimi_main",
          timeoutMs: 120000,
        },
      },
    }),
  );

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/settings/executors",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          executionMode: "api",
          providerRef: "kimi_main",
          modelRef: "kimi_k2_5",
          configuredModel: "kimi-k2.5-thinking-preview",
        }),
      ]),
    },
  });
});

test("provider preset catalog exposes v1 presets for api dialect providers", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/settings/provider-presets",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "kimi",
          label: "Kimi (Moonshot)",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: expect.objectContaining({ kind: "api_key" }),
        }),
        expect.objectContaining({
          id: "glm",
          label: "GLM (Zhipu)",
          vendor: "zhipu",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          auth: expect.objectContaining({ kind: "api_key" }),
        }),
        expect.objectContaining({
          id: "dashscope",
          label: "DashScope / Qwen",
          vendor: "alibaba",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          auth: expect.objectContaining({ kind: "api_key" }),
        }),
        expect.objectContaining({
          id: "minimax-anthropic",
          label: "MiniMax (Anthropic Compatible)",
          vendor: "minimax",
          transport: "api",
          apiDialect: "anthropic_messages",
          baseUrl: "https://api.minimaxi.com/anthropic",
          auth: expect.objectContaining({ kind: "api_key" }),
        }),
      ]),
    },
  });

  // Provider-only presets — no model/binding/all scopes
  const items = response.json().data.items;
  expect(items).toHaveLength(4);
});

test("provider settings persist preset metadata without breaking existing schema", async () => {
  const app = buildApp();

  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/providers/kimi_main",
    payload: {
      presetId: "kimi",
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
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "kimi_main",
      presetId: "kimi",
      label: "Kimi Main",
      vendor: "moonshot",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://api.moonshot.ai/v1",
      auth: {
        kind: "api_key",
        secretRef: "[redacted]",
      },
    },
  });

  const providersResponse = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });

  expect(providersResponse.statusCode).toBe(200);
  expect(providersResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        expect.objectContaining({
          id: "kimi_main",
          presetId: "kimi",
          vendor: "moonshot",
          transport: "api",
        }),
      ],
    },
  });

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
    providers: {
      kimi_main: {
        presetId: "kimi",
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
  });
});

test("provider model and binding updates preserve legacy executor and role routing sections already present in file", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  rmSync(configPath, { force: true });
  await Bun.write(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          authMode: "chatgpt",
          configuredModel: "gpt-5.3-codex",
        },
      },
      roleRouting: {
        reviewer: "codex",
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );

  const app = buildApp();

  await app.inject({
    method: "PUT",
    url: "/settings/providers/dashscope_main",
    payload: {
      vendor: "dashscope",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      auth: {
        kind: "api_key",
        secretRef: "DASHSCOPE_API_KEY",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/models/qwen_max",
    payload: {
      modelName: "qwen-max",
      providerRefs: {
        api: "dashscope_main",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/bindings/claude_code",
    payload: {
      executionMode: "cli",
      modelRef: "qwen_max",
      providerRef: "dashscope_main",
      commandPath: "/opt/homebrew/bin/claude",
      sandboxMode: "workspace-write",
      timeoutMs: 180000,
    },
  });

  expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
    executors: {
      codex: {
        authMode: "chatgpt",
        configuredModel: "gpt-5.3-codex",
      },
    },
    roleRouting: {
      reviewer: {
        adapterId: "codex",
        strategy: "fallback_model",
        fallbackAdapterId: "model",
      },
    },
    roleMapping: {},
    providers: {
      dashscope_main: {
        vendor: "dashscope",
        transport: "api",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        auth: {
          kind: "api_key",
          secretRef: "DASHSCOPE_API_KEY",
        },
      },
    },
    models: {
      qwen_max: {
        modelName: "qwen-max",
        providerRefs: {
          api: "dashscope_main",
        },
      },
    },
    bindings: {
      claude_code: {
        executionMode: "cli",
        modelRef: "qwen_max",
        providerRef: "dashscope_main",
        commandPath: "/opt/homebrew/bin/claude",
        sandboxMode: "workspace-write",
        timeoutMs: 180000,
      },
    },
  });
});

test("settings read routes expose readiness without leaking secret values", async () => {
  const app = buildApp();

  writeSecretValue("OPENAI_API_KEY", "openai-secret");

  await app.inject({
    method: "PUT",
    url: "/settings/providers/kimi_main",
    payload: {
      label: "Kimi Main",
      vendor: "moonshot",
      transport: "api",
      apiDialect: "openai_chat_completions",
      auth: {
        kind: "api_key",
        secretRef: "MOONSHOT_API_KEY",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/providers/claude_local",
    payload: {
      label: "Claude Local",
      vendor: "anthropic",
      transport: "cli",
      apiDialect: "cli_native",
      cli: {
        commandPath: "/opt/homebrew/bin/claude",
        sandboxMode: "workspace-write",
      },
      auth: {
        kind: "chatgpt_session",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/models/kimi_k2_5",
    payload: {
      modelName: "kimi-k2.5-thinking-preview",
      providerRefs: {
        api: "kimi_main",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/models/claude_sonnet",
    payload: {
      modelName: "claude-sonnet-4.5",
      providerRefs: {
        cli: "claude_local",
      },
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/bindings/codex",
    payload: {
      executionMode: "api",
      modelRef: "kimi_k2_5",
      providerRef: "kimi_main",
    },
  });

  await app.inject({
    method: "PUT",
    url: "/settings/bindings/claude_code",
    payload: {
      executionMode: "cli",
      modelRef: "claude_sonnet",
      providerRef: "claude_local",
    },
  });

  const providersResponse = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(providersResponse.statusCode).toBe(200);
  const providersPayload = providersResponse.json() as {
    ok: boolean;
    data: { items: Array<{ id: string; readiness: { ready: boolean; missing: string[] } }> };
  };
  expect(providersPayload.ok).toBe(true);
  expect(providersPayload.data.items.find((item) => item.id === "kimi_main")).toMatchObject({
    id: "kimi_main",
    readiness: {
      ready: false,
      missing: expect.arrayContaining(["baseUrl", "auth.secretRef"]),
    },
  });
  expect(providersPayload.data.items.find((item) => item.id === "claude_local")).toMatchObject({
    id: "claude_local",
    readiness: {
      ready: true,
      missing: [],
    },
  });

  const bindingsResponse = await app.inject({
    method: "GET",
    url: "/settings/bindings",
  });
  expect(bindingsResponse.statusCode).toBe(200);
  expect(bindingsResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          readiness: {
            ready: false,
            missing: expect.arrayContaining(["baseUrl", "auth.secretRef"]),
          },
        }),
        expect.objectContaining({
          adapterId: "claude_code",
          readiness: {
            ready: true,
            missing: [],
          },
        }),
      ]),
    },
  });

  const executorsResponse = await app.inject({
    method: "GET",
    url: "/settings/executors",
  });
  expect(executorsResponse.statusCode).toBe(200);
  expect(executorsResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: expect.arrayContaining([
        expect.objectContaining({
          adapterId: "codex",
          readiness: {
            ready: false,
            missing: expect.arrayContaining(["baseUrl", "auth.secretRef"]),
          },
        }),
        expect.objectContaining({
          adapterId: "claude_code",
          readiness: {
            ready: true,
            missing: [],
          },
        }),
      ]),
    },
  });

  const serialized = JSON.stringify({
    providers: providersResponse.json(),
    bindings: bindingsResponse.json(),
    executors: executorsResponse.json(),
  });
  expect(serialized).not.toContain("MOONSHOT_API_KEY");
});

test("provider updates preserve existing preset metadata when presetId is omitted", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  rmSync(configPath, { force: true });
  await Bun.write(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {
        kimi_main: {
          presetId: "kimi",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
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
  const updateResponse = await app.inject({
    method: "PUT",
    url: "/settings/providers/kimi_main",
    payload: {
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
  });

  expect(updateResponse.statusCode).toBe(200);
  expect(updateResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "kimi_main",
      presetId: "kimi",
      label: "Kimi Main",
    },
  });
});

test("PUT /settings/providers/:id un-redacts secretRef on round-trip from UI", async () => {
  const app = buildApp();

  // Create a provider with a real secretRef.
  await app.inject({
    method: "PUT",
    url: "/settings/providers/round_trip",
    payload: {
      label: "Round Trip",
      vendor: "openai",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://example.com/v1",
      auth: { kind: "api_key", secretRef: "REAL_SECRET_REF" },
    },
  });

  // GET returns redacted "[redacted]" — verify.
  const getResp = await app.inject({ method: "GET", url: "/settings/providers" });
  const fetched = getResp.json().data.items.find((p: { id: string }) => p.id === "round_trip");
  expect(fetched.auth.secretRef).toBe("[redacted]");

  // Simulate Edit-then-Save: UI re-PUTs the redacted shape unchanged
  // (e.g. user edited the label, didn't touch the auth fields).
  const replayResp = await app.inject({
    method: "PUT",
    url: "/settings/providers/round_trip",
    payload: {
      label: "Round Trip — relabeled",
      vendor: "openai",
      transport: "api",
      apiDialect: "openai_chat_completions",
      baseUrl: "https://example.com/v1",
      // The smoking gun: `[redacted]` arriving from the UI.
      auth: { kind: "api_key", secretRef: "[redacted]" },
    },
  });
  expect(replayResp.statusCode).toBe(200);

  // Read the underlying file and assert the real ref survived.
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH!;
  const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
  expect(onDisk.providers.round_trip.auth.secretRef).toBe("REAL_SECRET_REF");
  // And the label change went through.
  expect(onDisk.providers.round_trip.label).toBe("Round Trip — relabeled");
});

test("PUT /settings/models/:id preserves defaultReasoning subfields the UI doesn't expose", async () => {
  const app = buildApp();

  // Seed a model with a fully-populated defaultReasoning (mode +
  // effort + budgetTokens + visibility). The current ModelList form
  // exposes the first three but not visibility — we want the
  // round-trip to keep visibility intact.
  await app.inject({
    method: "PUT",
    url: "/settings/models/preserve_test",
    payload: {
      label: "Preserve Test",
      modelName: "preserve-test-model",
      vendor: "test",
      defaultReasoning: {
        mode: "auto",
        effort: "medium",
        budgetTokens: 1024,
        visibility: "summary",
      },
    },
  });

  // Now simulate the UI saving — it sends the three exposed fields
  // and omits `visibility` entirely.
  const replay = await app.inject({
    method: "PUT",
    url: "/settings/models/preserve_test",
    payload: {
      label: "Preserve Test — relabel",
      modelName: "preserve-test-model",
      vendor: "test",
      defaultReasoning: {
        mode: "auto",
        effort: "high",
        budgetTokens: null,
      },
    },
  });
  expect(replay.statusCode).toBe(200);

  const onDisk = JSON.parse(readFileSync(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!, "utf8"));
  const reasoning = onDisk.models.preserve_test.defaultReasoning;
  expect(reasoning.mode).toBe("auto");
  expect(reasoning.effort).toBe("high"); // updated
  expect(reasoning.budgetTokens).toBeUndefined(); // explicitly cleared via null
  expect(reasoning.visibility).toBe("summary"); // PRESERVED — this is the bug fix
  expect(onDisk.models.preserve_test.label).toBe("Preserve Test — relabel");
});
