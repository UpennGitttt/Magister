import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-route-db");

function writeStubRoutingConfig(configPath: string, overrides?: { managerConfiguredModel?: string | null }) {
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel:
            overrides && "managerConfiguredModel" in overrides
              ? overrides.managerConfiguredModel
              : "gpt-5.4-codex",
          commandPath: "__stub__",
        },
        opencode: {
          configuredModel:
            overrides && "managerConfiguredModel" in overrides
              ? overrides.managerConfiguredModel
              : "open-code-plan",
          commandPath: "opencode",
        },
        qoder: {
          configuredModel: "qoder-review",
          commandPath: "qoder",
        },
      },
      roleRouting: {
        manager: "codex",
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
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

test("POST /tasks auto-dispatches the manager runtime for a new task", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Create the first route-backed task",
      source: "cli",
      workspaceId: "workspace_main",
    },
  });

  expect(createResponse.statusCode).toBe(201);

  const created = createResponse.json() as {
    data: { taskId: string; runId: string; action: string; reason: string };
  };

  expect(created.data.taskId).toMatch(/^task_/);
  expect(created.data.runId).toMatch(/^rt_leader_/);
  expect(created.data.action).toBe("new_session");
  expect(typeof created.data.reason).toBe("string");

  const taskResponse = await app.inject({
    method: "GET",
    url: `/tasks/${created.data.taskId}`,
  });

  expect(taskResponse.statusCode).toBe(200);
  expect(taskResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: created.data.taskId,
      title: "Create the first route-backed task",
      source: "cli",
    },
  });
});

test("GET /tasks returns the current task summaries", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();

  await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "List me from the task index",
      source: "cli",
      workspaceId: "workspace_main",
    },
  });

  const listResponse = await app.inject({
    method: "GET",
    url: "/tasks",
  });

  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json()).toMatchObject({
    ok: true,
    data: {
      items: [
        {
          title: "List me from the task index",
          source: "cli",
          workspaceId: "workspace_main",
        },
      ],
    },
  });
});

test("POST /tasks returns queued status for non-feishu sources (async execution)", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath, {
    managerConfiguredModel: "",
  });

  const app = buildApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Create a task without a configured manager model",
      source: "cli",
      workspaceId: "workspace_main",
    },
  });

  expect(createResponse.statusCode).toBe(201);
  expect(createResponse.json()).toMatchObject({
    ok: true,
    data: {
      action: "new_session",
      reason: "queued",
      status: "queued",
    },
  });
});

test("POST /tasks can dispatch through the model-only route", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.4-codex",
          commandPath: "__stub__",
        },
      },
      roleRouting: {
        manager: {
          adapterId: "model",
          strategy: "model_only",
        },
        architect: "codex",
        coder: "codex",
        reviewer: "codex",
        lander: "codex",
      },
      providers: {
        kimi: {
          label: "Kimi",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: {
            kind: "api_key",
            secretRef: "MOONSHOT_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        "kimi-k2.5-thinking-preview": {
          label: "Kimi K2.5 Coding",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "kimi",
          },
          defaultReasoning: {
            mode: "auto",
            effort: "medium",
            visibility: "summary",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "kimi-k2.5-thinking-preview",
          providerRef: "kimi",
          timeoutMs: 180000,
        },
      },
    }),
  );

  writeSecretValue("MOONSHOT_API_KEY", "moonshot-secret");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        message:
          '{ "taskType": "conversation", "executionMode": "immediate", "decision": "direct_answer", "reply": "你好，我在。", "confidence": 0.99, "childWorkItems": [], "waitingFor": null, "nextWakeupAt": null, "warnings": [] }',
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_manager_model_only_success",
        },
      },
    )) as unknown as typeof fetch;

  try {
    const app = buildApp();

    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        prompt: "你好",
        source: "web",
        workspaceId: "workspace_main",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      ok: true,
      data: {
        action: "new_session",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /tasks accepts plannerHints and still creates a task via processTaskIntent", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Review, implement, and merge the login redirect fix",
      source: "web",
      workspaceId: "workspace_main",
      plannerHints: {
        taskType: "coding",
        coordinationAction: "handoff",
        stopCondition: "implementation_ready",
        childRuns: [
          {
            roleId: "coder",
            goal: "Patch the redirect regression and stop after implementation.",
          },
        ],
      },
    },
  });

  expect(createResponse.statusCode).toBe(201);
  const created = createResponse.json() as {
    data: { taskId: string; runId: string; action: string; reason: string };
  };

  expect(created.data.taskId).toMatch(/^task_/);
  expect(created.data.runId).toMatch(/^rt_leader_/);
  expect(created.data.action).toBe("new_session");
});

test("POST /tasks accepts taskManagerHints and still creates a task via processTaskIntent", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "Review, implement, and merge the billing fix",
      source: "web",
      workspaceId: "workspace_main",
      taskManagerHints: {
        taskType: "coding",
        coordinationAction: "handoff",
        stopCondition: "implementation_ready",
        childRuns: [
          {
            roleId: "coder",
            goal: "Patch the billing fix and stop after implementation.",
          },
        ],
      },
    },
  });

  expect(createResponse.statusCode).toBe(201);
  const created = createResponse.json() as {
    data: { taskId: string; runId: string; action: string; reason: string };
  };

  expect(created.data.taskId).toMatch(/^task_/);
  expect(created.data.action).toBe("new_session");
});

test("POST /tasks routes informational prompts through processTaskIntent", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeStubRoutingConfig(configPath);

  const app = buildApp();

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      prompt: "今天天气如何",
      source: "feishu",
      workspaceId: "workspace_main",
    },
  });

  expect(createResponse.statusCode).toBe(201);
  const created = createResponse.json() as {
    data: { taskId: string; runId: string; action: string; reason: string };
  };

  expect(created.data.taskId).toMatch(/^task_/);
  expect(created.data.action).toBe("new_session");

  const taskResponse = await app.inject({
    method: "GET",
    url: `/tasks/${created.data.taskId}`,
  });

  expect(taskResponse.statusCode).toBe(200);
  expect(taskResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: created.data.taskId,
      source: "feishu",
    },
  });
});

test("POST /tasks handles model auth failure gracefully via processTaskIntent", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.4-codex",
          commandPath: "__stub__",
        },
      },
      roleRouting: {
        manager: {
          adapterId: "model",
          strategy: "model_only",
        },
        architect: "codex",
        coder: "codex",
        reviewer: "codex",
        lander: "codex",
      },
      providers: {
        kimi: {
          label: "Kimi",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: {
            kind: "api_key",
            secretRef: "MOONSHOT_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        "kimi-k2.5-thinking-preview": {
          label: "Kimi K2.5 Coding",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "kimi",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "kimi-k2.5-thinking-preview",
          providerRef: "kimi",
          timeoutMs: 180000,
        },
      },
    }),
  );

  writeSecretValue("MOONSHOT_API_KEY", "broken-secret");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_manager_auth_failed_then_codex_fallback",
      },
    })) as unknown as typeof fetch;

  try {
    const app = buildApp();

    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        prompt: "你好",
        source: "web",
        workspaceId: "workspace_main",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      ok: true,
      data: {
        action: "new_session",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
