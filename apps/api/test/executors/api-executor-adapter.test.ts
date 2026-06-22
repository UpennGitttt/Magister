import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutorDispatchDependencies,
  ExecutorSlotSnapshot,
} from "../../src/executors/executor-adapter";
import {
  createApiExecutorAdapter,
  createFakeApiTransport,
} from "../../src/executors/api-executor-adapter";

const tempDirs: string[] = [];
let previousSecretStorePath: string | undefined;

function createTempArtifactsRoot() {
  const directory = mkdtempSync(join(tmpdir(), "ultimate-api-adapter-"));
  tempDirs.push(directory);
  return directory;
}

beforeEach(() => {
  previousSecretStorePath = process.env.MAGISTER_SECRET_STORE_PATH;
  process.env.MAGISTER_SECRET_STORE_PATH = join(createTempArtifactsRoot(), "secrets.json");
});

afterEach(() => {
  if (previousSecretStorePath === undefined) {
    delete process.env.MAGISTER_SECRET_STORE_PATH;
  } else {
    process.env.MAGISTER_SECRET_STORE_PATH = previousSecretStorePath;
  }
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function createFakeDependencies(): {
  dependencies: ExecutorDispatchDependencies;
  runtimeUpdates: Array<{ id: string; input: Record<string, unknown> }>;
  taskUpdates: Array<{ id: string; input: Record<string, unknown> }>;
  artifactCreates: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
} {
  const runtimeUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const taskUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const artifactCreates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  return {
    dependencies: {
      roleRuntimeRepository: {
        async update(id, input) {
          runtimeUpdates.push({ id, input: input as Record<string, unknown> });
        },
      },
      taskRepository: {
        async update(id, input) {
          taskUpdates.push({ id, input: input as Record<string, unknown> });
        },
      },
      artifactRepository: {
        async create(input) {
          artifactCreates.push(input as Record<string, unknown>);
        },
        async getById(id) {
          return artifactCreates.find((artifact) => artifact.id === id) as never;
        },
      },
      observabilityAdapter: {
        async recordEvent(event) {
          events.push(event as Record<string, unknown>);
          return {
            event,
            taskSummary: null,
            runSummary: null,
          };
        },
      },
    },
    runtimeUpdates,
    taskUpdates,
    artifactCreates,
    events,
  };
}

function createApiSlot(
  overrides: {
    status?: "configured" | "unconfigured";
    configuredModel?: string | undefined;
    providerRef?: string | undefined;
    modelRef?: string | undefined;
    clearConfiguredModel?: boolean;
    clearProviderRef?: boolean;
    clearModelRef?: boolean;
  } = {},
) {
  return {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "api",
    status: "configured",
    configSource: "file",
    configuredModel: "miniMax-coding-plan",
    providerRef: "minimax_api",
    modelRef: "minimax_coding_plan",
    notes: "API-backed coding slot for heterogeneous execution.",
    ...(overrides.status ? { status: overrides.status } : {}),
    ...((overrides.clearConfiguredModel || overrides.configuredModel !== undefined)
      ? { configuredModel: overrides.configuredModel }
      : {}),
    ...((overrides.clearProviderRef || overrides.providerRef !== undefined)
      ? { providerRef: overrides.providerRef }
      : {}),
    ...((overrides.clearModelRef || overrides.modelRef !== undefined)
      ? { modelRef: overrides.modelRef }
      : {}),
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
}

test("api executor adapter marks an unconfigured API slot as executor_unconfigured", async () => {
  const slot = createApiSlot({
    status: "unconfigured",
    clearConfiguredModel: true,
    clearProviderRef: true,
    clearModelRef: true,
  });
  const dependencies = createFakeDependencies();
  const transport = createFakeApiTransport();

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {},
    models: {},
  }).execute({
    runtime: {
      id: "runtime_api_unconfigured",
      taskId: "task_api_unconfigured",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_unconfigured",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:00:00.000Z"),
    createId: () => "api-unconfigured",
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_api_unconfigured",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_unconfigured",
    message: "Configure an API provider and model for OpenCode before dispatching the coder run",
  });
  expect(transport.requests).toHaveLength(0);
  expect(dependencies.runtimeUpdates).toHaveLength(1);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.events).toHaveLength(1);
});

test("api executor adapter classifies a missing provider reference as executor_provider_missing", async () => {
  const slot = createApiSlot({
    clearProviderRef: true,
  });
  const dependencies = createFakeDependencies();
  const transport = createFakeApiTransport();

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      minimax_api: {
        providerRef: "minimax_api",
        label: "MiniMax API",
        transport: "fake",
      },
    },
    models: {
      minimax_coding_plan: {
        modelRef: "minimax_coding_plan",
        modelName: "MiniMax Coding Plan",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_provider_missing",
      taskId: "task_api_provider_missing",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_provider_missing",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:05:00.000Z"),
    createId: () => "api-provider-missing",
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_api_provider_missing",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_provider_missing",
    message: "Configure an API provider for OpenCode before dispatching the coder run",
  });
  expect(transport.requests).toHaveLength(0);
  expect(dependencies.events).toHaveLength(1);
});

test("api executor adapter classifies a missing model reference as executor_model_missing", async () => {
  const slot = createApiSlot({
    clearModelRef: true,
  });
  const dependencies = createFakeDependencies();
  const transport = createFakeApiTransport();

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      minimax_api: {
        providerRef: "minimax_api",
        label: "MiniMax API",
        transport: "fake",
      },
    },
    models: {},
  }).execute({
    runtime: {
      id: "runtime_api_model_missing",
      taskId: "task_api_model_missing",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_model_missing",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:10:00.000Z"),
    createId: () => "api-model-missing",
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_api_model_missing",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_model_missing",
    message: "Configure an API model for OpenCode before dispatching the coder run",
  });
  expect(transport.requests).toHaveLength(0);
  expect(dependencies.events).toHaveLength(1);
});

test("api executor adapter sends a request through a fake transport and materializes a completed run", async () => {
  const slot = createApiSlot();
  const dependencies = createFakeDependencies();
  const responseMessage = "Fake transport completed the coder run.";
  const transport = createFakeApiTransport({
    response: {
      ok: true,
      status: 200,
      requestId: "fake-request-1",
      body: {
        message: responseMessage,
      },
    },
  });
  const requestBuilderCalls: Array<Record<string, unknown>> = [];

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      minimax_api: {
        providerRef: "minimax_api",
        label: "MiniMax API",
        transport: "fake",
      },
    },
    models: {
      minimax_coding_plan: {
        modelRef: "minimax_coding_plan",
        modelName: "MiniMax Coding Plan",
      },
    },
    buildRequest(context, provider, model) {
      requestBuilderCalls.push({
        runId: context.runtime.id,
        providerRef: provider.providerRef,
        modelRef: model.modelRef,
        modelName: model.modelName,
      });

      return {
        providerRef: provider.providerRef,
        modelRef: model.modelRef,
        modelName: model.modelName,
        executionMode: "api",
        roleId: context.runtime.roleId,
        taskId: context.task.id,
        workspaceId: context.task.workspaceId,
        runId: context.runtime.id,
        prompt: `Role: ${context.runtime.roleId}`,
        metadata: {
          taskId: context.task.id,
          workspaceId: context.task.workspaceId,
        },
      };
    },
  }).execute({
    runtime: {
      id: "runtime_api_success",
      taskId: "task_api_success",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 2,
      delegationMode: "delegate_with_context",
    },
    task: {
      id: "task_api_success",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:15:00.000Z"),
    createId: (() => {
      const ids = [
        "api-session",
        "api-started",
        "api-artifact",
        "api-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_success",
    adapterId: "opencode",
    state: "COMPLETED",
    sessionId: "session_api-session",
    artifactId: "artifact_api-artifact",
  });
  expect(requestBuilderCalls).toEqual([
    expect.objectContaining({
      runId: "runtime_api_success",
      providerRef: "minimax_api",
      modelRef: "minimax_coding_plan",
      modelName: "MiniMax Coding Plan",
    }),
  ]);
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]).toMatchObject({
    provider: expect.objectContaining({
      providerRef: "minimax_api",
    }),
    model: expect.objectContaining({
      modelRef: "minimax_coding_plan",
    }),
    request: expect.objectContaining({
      prompt: "Role: coder",
    }),
  });
  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.artifactCreates).toHaveLength(1);
  expect(dependencies.events).toHaveLength(2);
  expect(dependencies.events[1]).toMatchObject({
    type: "executor_session.completed",
    executorSessionId: "session_api-session",
    artifactId: "artifact_api-artifact",
  });
  const completedPayload = JSON.parse(
    String((dependencies.events[1] as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(completedPayload.lastMessage).toBe(responseMessage);
});

test("api executor adapter materializes runtime context and rehydration contract for non-native-resume runs", async () => {
  const slot = createApiSlot();
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const transport = createFakeApiTransport({
    response: {
      ok: true,
      status: 200,
      requestId: "fake-continuity-1",
      body: {
        message: "API executor completed the rehydrated coder run.",
      },
    },
  });

  const result = await createApiExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    transport,
    providers: {
      minimax_api: {
        providerRef: "minimax_api",
        label: "MiniMax API",
        transport: "fake",
      },
    },
    models: {
      minimax_coding_plan: {
        modelRef: "minimax_coding_plan",
        modelName: "MiniMax Coding Plan",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_continuity",
      taskId: "task_api_continuity",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 1,
      delegationMode: "delegate_with_context",
      priorSessionId: "session_api_previous_1",
      priorWorkdir: "/tmp/api-previous-workdir",
      resumePolicy: "rehydrate_only",
    },
    task: {
      id: "task_api_continuity",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Continue the API coding lane",
      description: "Rehydrate the coding task and keep going from control-plane truth.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-12T10:30:00.000Z"),
    createId: (() => {
      const ids = [
        "api-continuity-session",
        "api-continuity-started",
        "api-continuity-artifact",
        "api-continuity-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-continuity-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_continuity",
    adapterId: "opencode",
    state: "COMPLETED",
    sessionId: "session_api-continuity-session",
    artifactId: "artifact_api-continuity-completed",
  });
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]?.request.prompt).toContain(
    "Before acting, read the run contract at `.magister/runtime-contracts/runtime_api_continuity/AGENTS.md`.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
  );
  expect(dependencies.artifactCreates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        artifactType: "runtime_context",
        title: "Runtime context document",
        storageKind: "file",
        summary: "Captured runtime context document for the coder run",
      }),
    ]),
  );
});

test("api executor adapter skips runtime-contract prompt hydration for fresh manager runs without continuity context", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const transport = createFakeApiTransport({
    response: {
      ok: true,
      status: 200,
      requestId: "fake-manager-fresh-1",
      body: {
        message: "Manager produced a direct answer.",
      },
    },
  });

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_fresh",
      taskId: "task_api_manager_fresh",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_manager_fresh",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Manager direct-answer turn",
      description: "Answer directly without continuity rehydration.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-16T09:00:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-fresh-session",
        "api-manager-fresh-started",
        "api-manager-fresh-artifact",
        "api-manager-fresh-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-fresh-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_fresh",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-fresh-session",
    artifactId: "artifact_api-manager-fresh-artifact",
  });
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]?.request.prompt).toContain("You are the leader agent for Magister.");
  expect(transport.requests[0]?.request.prompt).toContain("Current Wall Clock:");
  expect(transport.requests[0]?.request.prompt).toContain("2026-04-16 09:00:00");
  expect(transport.requests[0]?.request.prompt).toContain("Delegation Mode: assign");
  expect(transport.requests[0]?.request.prompt).toContain(
    "Assume the current workspace is the repository or codebase the user means unless they explicitly point elsewhere.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Do not ask the user for the repo path, project name, or frontend location when the current workspace already scopes the request.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Requests to inspect, review, explain, or summarize code in this workspace should be treated as in-repo work, not as missing-context questions.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "For local workspace facts such as current directory, visible files, repository layout, or file contents, prefer base tools over unsupported guesswork.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Before answering local workspace facts such as current directory, visible files, repository layout, or file contents, you must call the relevant base tool first.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "For weather and air-quality questions, never infer the user's city or location from timezone, locale, IP, workspace, or prior unrelated context.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "If a weather or air-quality question does not include a resolvable city or location, ask the user for it instead of guessing.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Use ask_user_question only when the missing information can only come from the user",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "do not claim you lack realtime access for those questions",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Do not emit markdown sections, XML tags, or tool-call wrappers.",
  );
  expect(transport.requests[0]?.request.prompt).toContain(
    "Return only a single valid JSON object with these top-level fields:",
  );
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Return sections exactly:\nObjective\nActions\nOutcome",
  );
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Before acting, read the run contract",
  );
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(transport.requests[0]?.request.metadata).toMatchObject({
    runtimeContractPath: null,
    runtimeContextArtifactId: null,
  });
  expect(dependencies.artifactCreates.some((artifact) => artifact.artifactType === "runtime_context")).toBe(
    false,
  );
});

test("api executor adapter does not tell manager runs to read runtime contracts even when continuity is present", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const transport = createFakeApiTransport({
    response: {
      ok: true,
      status: 200,
      requestId: "fake-manager-continuity-1",
      body: {
        message: "Manager produced a direct answer with continuity present.",
      },
    },
  });

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_continuity",
      taskId: "task_api_manager_continuity",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
      priorSessionId: "session_previous_manager_turn",
      resumePolicy: "rehydrate_only",
    },
    task: {
      id: "task_api_manager_continuity",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Explain the current project frontend",
      description: "Use the current workspace context without asking the user to load control-plane files.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-18T02:10:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-continuity-session",
        "api-manager-continuity-started",
        "api-manager-continuity-context",
        "api-manager-continuity-contract",
        "api-manager-continuity-artifact",
        "api-manager-continuity-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-continuity-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_continuity",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-continuity-session",
    artifactId: "artifact_api-manager-continuity-contract",
  });
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Before acting, read the run contract",
  );
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(transport.requests[0]?.request.prompt).not.toContain(
    "Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
  );
  expect(transport.requests[0]?.request.prompt).toContain("Current Wall Clock:");
  expect(transport.requests[0]?.request.prompt).toContain("2026-04-18 02:10:00");
});

test("api executor adapter retries one repair prompt when a manager returns an invalid structured decision", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const requests: Array<{ prompt: string }> = [];
  const transport = {
    async execute(input: { request: { prompt: string } }) {
      requests.push({ prompt: input.request.prompt });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          requestId: "fake-manager-invalid-1",
          body: {
            message: JSON.stringify({
              taskType: "mixed",
              executionMode: "bounded_execution",
              decision: "direct_answer",
              reply: "我需要先探索项目结构以了解前端架构。",
              confidence: 0.7,
              childWorkItems: [
                {
                  taskType: "coding",
                  taskDescription: "探索项目结构，识别前端技术栈、组件结构、路由配置等",
                  delegateAgent: "inspector",
                  expectedOutput: "前端架构概述",
                },
              ],
              waitingFor: null,
              nextWakeupAt: null,
              warnings: ["需要先探索代码库才能提供准确的前端说明"],
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        requestId: "fake-manager-repaired-1",
        body: {
          message: JSON.stringify({
            taskType: "coding",
            executionMode: "bounded_execution",
            decision: "spawn_work_items",
            reply: null,
            confidence: "high",
            childWorkItems: [
              {
                roleId: "architect",
                skillId: "inspect_repo",
                goal: "Inspect the repository frontend structure and summarize the architecture.",
                dependsOn: [],
              },
            ],
            waitingFor: null,
            nextWakeupAt: null,
            warnings: [],
          }),
        },
      };
    },
  };

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_repair",
      taskId: "task_api_manager_repair",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_manager_repair",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "解释一下当前项目的前端",
      description: "Explain the current project's frontend architecture using the workspace context.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-18T02:40:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-repair-session",
        "api-manager-repair-started",
        "api-manager-repair-artifact",
        "api-manager-repair-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-repair-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_repair",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-repair-session",
    artifactId: "artifact_api-manager-repair-artifact",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.prompt).toContain("The previous JSON output was invalid for the ManagerDecision contract.");
  expect(requests[1]?.prompt).toContain("Do not use legacy childWorkItem fields like delegateAgent");
  expect(requests[1]?.prompt).toContain("Child work items must use canonical fields only");
  expect(requests[1]?.prompt).toContain("architect: Explain architecture");
});

test("api executor adapter keeps grounded local-workspace replies even when a repair round is needed", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const requests: Array<{ prompt: string }> = [];
  const transport = {
    async execute(input: { request: { prompt: string } }) {
      requests.push({ prompt: input.request.prompt });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          requestId: "fake-manager-dir-invalid-1",
          body: {
            message: JSON.stringify({
              taskType: "conversation",
              executionMode: "immediate",
              decision: "direct_answer",
              reply: "当前工作目录是 workspace_main。",
              confidence: 1,
              childWorkItems: null,
              waitingFor: null,
              nextWakeupAt: null,
              warnings: null,
            }),
          },
        };
      }
      if (requests.length === 2) {
        return {
          ok: true,
          status: 200,
          requestId: "fake-manager-dir-invalid-2",
          body: {
            message: JSON.stringify({
              taskType: "conversation",
              executionMode: "immediate",
              decision: "direct_answer",
              reply: "当前工作目录（current working directory）是 /app。我可以通过 list_dir 查看这个目录下的内容。",
              confidence: "high",
              childWorkItems: [],
              waitingFor: [],
              nextWakeupAt: null,
              warnings: [],
            }),
          },
        };
      }
      throw new Error("Unexpected extra grounded-repair transport request");
    },
  };

  const result = await createApiExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_grounded_repair",
      taskId: "task_api_manager_grounded_repair",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_manager_grounded_repair",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "当前工作目录是啥",
      description: "Keep grounded local workspace facts even across repair retries.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-18T18:20:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-grounded-repair-session",
        "api-manager-grounded-repair-started",
        "api-manager-grounded-repair-artifact",
        "api-manager-grounded-repair-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-grounded-repair-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_grounded_repair",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-grounded-repair-session",
    artifactId: expect.stringContaining("artifact_api-manager-grounded-repair"),
  });
  if (!result.ok) {
    throw new Error("Expected grounded-repair result to complete successfully");
  }
  expect(requests).toHaveLength(2);
  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === result.artifactId,
  ) as { storageRef?: string } | undefined;
  expect(noteArtifact?.storageRef).toBeTruthy();
  expect(readFileSync(String(noteArtifact?.storageRef), "utf8")).toContain(process.cwd());
});

test("api executor adapter runs a manager loop for time questions instead of relying on model-only direct answers", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const requests: Array<{ prompt: string }> = [];
  const transport = {
    async execute(input: { request: { prompt: string } }) {
      requests.push({ prompt: input.request.prompt });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          requestId: "fake-manager-loop-time-1",
          body: {
            message: JSON.stringify({
              kind: "call_tool",
              toolName: "time_now",
              arguments: {},
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        requestId: "fake-manager-loop-time-2",
        body: {
          message: JSON.stringify({
            kind: "respond",
            reply: "现在是 2026-04-18 13:40:00。",
          }),
        },
      };
    },
  };

  const result = await createApiExecutorAdapter(slot, {
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_loop_time",
      taskId: "task_api_manager_loop_time",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_manager_loop_time",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "现在几点了",
      description: "Use the manager loop and local runtime context to answer the current time.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-18T05:40:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-loop-time-session",
        "api-manager-loop-time-started",
        "api-manager-loop-time-artifact",
        "api-manager-loop-time-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-loop-time-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_loop_time",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-loop-time-session",
    artifactId: expect.stringContaining("artifact_api-manager-loop-time"),
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.prompt).toContain("Current Wall Clock:");
  expect(requests[1]?.prompt).toContain("tool observations");
  expect(dependencies.events.some((event) => event.type === "executor_session.completed")).toBe(true);
  const toolEvents = dependencies.events.filter(
    (event) => event.type === "tool.call" || event.type === "tool.result",
  );
  expect(toolEvents.map((event) => event.type)).toEqual(["tool.call", "tool.result"]);
  const toolCallPayload = JSON.parse(String(toolEvents[0]?.payloadJson ?? "{}")) as Record<string, unknown>;
  const toolResultPayload = JSON.parse(String(toolEvents[1]?.payloadJson ?? "{}")) as Record<string, unknown>;
  expect(toolCallPayload.toolName).toBe("time_now");
  expect(toolResultPayload.toolName).toBe("time_now");
});

test("api executor adapter forces tool grounding for current-directory questions before completing", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const requests: Array<{ request: { prompt: string } }> = [];
  const transport = {
    requests,
    async execute(input: { request: { prompt: string } }) {
      requests.push({ request: { prompt: input.request.prompt } });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          requestId: "fake-manager-loop-dir-1",
          body: {
            message: JSON.stringify({
              taskType: "conversation",
              executionMode: "immediate",
              decision: "direct_answer",
              reply: "当前工作目录是 workspace_main。",
              confidence: 1,
              childWorkItems: null,
              waitingFor: null,
              nextWakeupAt: null,
              warnings: null,
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        requestId: "fake-manager-loop-dir-2",
        body: {
          message: JSON.stringify({
            taskType: "conversation",
            executionMode: "immediate",
            decision: "direct_answer",
            reply: "让我先查看当前工作目录。",
            confidence: "high",
            childWorkItems: [],
            waitingFor: null,
            nextWakeupAt: null,
            warnings: [],
            toolCalls: [
              {
                name: "bash",
                args: {
                  command: "pwd",
                },
              },
              {
                name: "list_dir",
                args: {
                  path: ".",
                },
              },
            ],
          }),
        },
      };
    },
  };

  const result = await createApiExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_manager_loop_dir",
      taskId: "task_api_manager_loop_dir",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_manager_loop_dir",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "当前工作目录是啥",
      description: "Ground local workspace facts before answering.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-18T18:12:00.000Z"),
    createId: (() => {
      const ids = [
        "api-manager-loop-dir-session",
        "api-manager-loop-dir-started",
        "api-manager-loop-dir-artifact",
        "api-manager-loop-dir-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-manager-loop-dir-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_manager_loop_dir",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-manager-loop-dir-session",
    artifactId: expect.stringContaining("artifact_api-manager-loop-dir"),
  });
  if (!result.ok) {
    throw new Error("Expected manager loop dir result to complete successfully");
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]?.request.prompt).toContain("tool observations");
  expect(requests[1]?.request.prompt).toContain("bash");
  const toolEvents = dependencies.events.filter(
    (event) => event.type === "tool.call" || event.type === "tool.result",
  );
  expect(toolEvents.map((event) => event.type)).toEqual(["tool.call", "tool.result"]);
  const toolCallPayload = JSON.parse(String(toolEvents[0]?.payloadJson ?? "{}")) as Record<string, unknown>;
  expect(toolCallPayload).toMatchObject({
    toolName: "bash",
    arguments: {
      command: "pwd",
    },
  });
  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === result.artifactId,
  ) as { storageRef?: string } | undefined;
  expect(noteArtifact?.storageRef).toBeTruthy();
  expect(readFileSync(String(noteArtifact?.storageRef), "utf8")).toContain(process.cwd());
});

test("api executor adapter materializes a structured reviewer artifact for model fallback reviews", async () => {
  const slot = {
    ...createApiSlot(),
    adapterId: "model",
    displayName: "Model Fallback",
    executorType: "model",
    roleTargets: ["leader", "architect", "reviewer"],
    configKey: "MAGISTER_MODEL_GENERAL_MODEL",
    configuredModel: "kimi-k2.5",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
  } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const transport = createFakeApiTransport({
    response: {
      ok: true,
      status: 200,
      requestId: "fake-review-1",
      body: {
        message: [
          "Review Summary",
          "The patch is close, but one regression remains.",
          "",
          "Blocking Issues",
          "- Missing retry guard around reviewer dispatch",
          "- No assertion for model fallback routing",
          "",
          "Suggested Fixes",
          "- Add a dispatch retry test",
          "- Add reviewer fallback integration coverage",
          "",
          "Verdict",
          "needs_changes",
        ].join("\n"),
      },
    },
  });

  const result = await createApiExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    transport,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        transport: "fake",
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_reviewer_success",
      taskId: "task_api_reviewer_success",
      roleId: "reviewer",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_reviewer_success",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Review fallback lane",
      description: "Review the current patch and return a structured verdict.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:16:00.000Z"),
    createId: (() => {
      const ids = [
        "api-review-session",
        "api-review-started",
        "api-review-artifact",
        "api-review-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-review-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_reviewer_success",
    adapterId: "model",
    state: "COMPLETED",
    sessionId: "session_api-review-session",
    artifactId: "artifact_api-review-artifact",
  });
  expect(dependencies.artifactCreates).toHaveLength(1);
  expect(dependencies.artifactCreates[0]).toMatchObject({
    artifactType: "review",
    title: "Reviewer execution note",
    storageKind: "file",
    summary: "Verdict: needs_changes",
  });
  expect(readFileSync(String(dependencies.artifactCreates[0]?.storageRef), "utf8")).toContain(
    "Blocking Issues",
  );
  expect(dependencies.events[1]).toMatchObject({
    type: "executor_session.completed",
    artifactId: "artifact_api-review-artifact",
  });
  expect(JSON.parse(String(dependencies.events[1]?.payloadJson))).toMatchObject({
    reviewVerdict: "needs_changes",
    blockingIssueCount: 2,
  });
  expect(transport.requests[0]?.request.prompt).toContain("Delegation Mode: assign");
});

test("api executor adapter uses real HTTP transport and classifies auth failures as executor_auth_failed", async () => {
  const slot = createApiSlot({
    clearProviderRef: true,
    clearModelRef: true,
    clearConfiguredModel: true,
  });
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_401",
      },
    });
  };

  const result = await createApiExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    fetchImpl,
    env: {
      MOONSHOT_API_KEY: "secret-value",
    } as NodeJS.ProcessEnv,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        vendor: "moonshot",
        transport: "http",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://api.moonshot.ai/v1",
        auth: {
          kind: "api_key",
          secretRef: "MOONSHOT_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
        providerRefs: {
          api: "kimi_main",
        },
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_auth_failed",
      taskId: "task_api_auth_failed",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_auth_failed",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: {
      ...slot,
      configuredModel: "kimi-k2.5",
      providerRef: "kimi_main",
      modelRef: "kimi_k2_5",
    } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string },
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:20:00.000Z"),
    createId: () => "api-auth-failed",
  });

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("https://api.moonshot.ai/v1/chat/completions");
  expect(result).toEqual({
    ok: false,
    runId: "runtime_api_auth_failed",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_auth_failed",
    message: "API authentication failed while dispatching the coder run",
  });
  expect(dependencies.artifactCreates).toHaveLength(2);
  expect(dependencies.artifactCreates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        artifactType: "execution_metadata",
        title: "API session metadata",
        storageKind: "file",
      }),
      expect.objectContaining({
        artifactType: "execution_note",
        title: "Coder execution note",
        storageKind: "file",
        summary: "API authentication failed while dispatching the coder run",
      }),
    ]),
  );

  const metadataArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "execution_metadata",
  );
  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "execution_note",
  );

  expect(metadataArtifact).toBeTruthy();
  expect(noteArtifact).toBeTruthy();
  expect(JSON.parse(readFileSync(String(metadataArtifact?.storageRef), "utf8"))).toMatchObject({
    adapterId: "opencode",
    providerRef: "kimi_main",
    modelRef: "kimi_k2_5",
    requestId: "req_401",
    responseStatus: 401,
    failureCode: "executor_auth_failed",
  });
  expect(readFileSync(String(noteArtifact?.storageRef), "utf8")).toContain(
    "API authentication failed while dispatching the coder run",
  );
});

test("api executor adapter uses real HTTP transport and classifies unavailability as executor_unavailable", async () => {
  const slot = createApiSlot({
    clearProviderRef: true,
    clearModelRef: true,
    clearConfiguredModel: true,
  });
  const dependencies = createFakeDependencies();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ error: { message: "unavailable" } }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_503",
      },
    });
  };

  const result = await createApiExecutorAdapter(slot, {
    fetchImpl,
    env: {
      MOONSHOT_API_KEY: "secret-value",
    } as NodeJS.ProcessEnv,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        vendor: "moonshot",
        transport: "http",
        apiDialect: "openai_chat_completions",
        baseUrl: "https://api.moonshot.ai/v1",
        auth: {
          kind: "api_key",
          secretRef: "MOONSHOT_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
        providerRefs: {
          api: "kimi_main",
        },
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_unavailable",
      taskId: "task_api_unavailable",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_unavailable",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: {
      ...slot,
      configuredModel: "kimi-k2.5",
      providerRef: "kimi_main",
      modelRef: "kimi_k2_5",
    } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string },
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:25:00.000Z"),
    createId: () => "api-unavailable",
  });

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("https://api.moonshot.ai/v1/chat/completions");
  expect(result).toEqual({
    ok: false,
    runId: "runtime_api_unavailable",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_unavailable",
    message: "API transport is unavailable while dispatching the coder run",
  });
});

test("api executor adapter returns provider readiness details when the HTTP provider is missing baseUrl or auth secret", async () => {
  const slot = createApiSlot({
    clearProviderRef: true,
    clearModelRef: true,
    clearConfiguredModel: true,
  });
  const dependencies = createFakeDependencies();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ message: "should not be called" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  const result = await createApiExecutorAdapter(slot, {
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    providers: {
      kimi_main: {
        providerRef: "kimi_main",
        label: "Kimi Main",
        vendor: "moonshot",
        transport: "http",
        apiDialect: "openai_chat_completions",
        auth: {
          kind: "api_key",
          secretRef: "MOONSHOT_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer ",
        },
      },
    },
    models: {
      kimi_k2_5: {
        modelRef: "kimi_k2_5",
        modelName: "kimi-k2.5",
        providerRefs: {
          api: "kimi_main",
        },
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_provider_readiness_missing",
      taskId: "task_api_provider_readiness_missing",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_provider_readiness_missing",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: {
      ...slot,
      configuredModel: "kimi-k2.5",
      providerRef: "kimi_main",
      modelRef: "kimi_k2_5",
    } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string },
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T09:25:00.000Z"),
    createId: () => "api-provider-readiness-missing",
  });

  expect(fetchCalls).toHaveLength(0);
  expect(result).toMatchObject({
    ok: false,
    runId: "runtime_api_provider_readiness_missing",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_provider_missing",
    message: expect.stringContaining("baseUrl"),
  });
  expect(dependencies.runtimeUpdates).toHaveLength(1);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.events).toHaveLength(1);
});

test("api executor adapter dispatches anthropic_messages HTTP requests and extracts assistant text", async () => {
  const slot = createApiSlot({
    clearProviderRef: true,
    clearModelRef: true,
    clearConfiguredModel: true,
  });
  const dependencies = createFakeDependencies();
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Objective\nActions\nOutcome",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "request-id": "anthropic_req_1",
        },
      },
    );
  };

  const result = await createApiExecutorAdapter(slot, {
    fetchImpl,
    env: {
      ANTHROPIC_API_KEY: "anthropic-secret",
    } as NodeJS.ProcessEnv,
    providers: {
      anthropic_main: {
        providerRef: "anthropic_main",
        label: "Anthropic Main",
        vendor: "anthropic",
        transport: "http",
        apiDialect: "anthropic_messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
        auth: {
          kind: "api_key",
          secretRef: "ANTHROPIC_API_KEY",
        },
      },
    },
    models: {
      claude_3_7_sonnet: {
        modelRef: "claude_3_7_sonnet",
        modelName: "claude-3-7-sonnet-20250219",
        providerRefs: {
          api: "anthropic_main",
        },
      },
    },
  }).execute({
    runtime: {
      id: "runtime_api_anthropic_success",
      taskId: "task_api_anthropic_success",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_anthropic_success",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: {
      ...slot,
      configuredModel: "claude-3-7-sonnet-20250219",
      providerRef: "anthropic_main",
      modelRef: "claude_3_7_sonnet",
    } as ExecutorSlotSnapshot & { providerRef?: string; modelRef?: string },
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-16T09:30:00.000Z"),
    createId: (() => {
      const ids = [
        "api-anthropic-session",
        "api-anthropic-started",
        "api-anthropic-artifact",
        "api-anthropic-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `api-anthropic-extra-${index}`;
    })(),
  });

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  expect(new Headers(fetchCalls[0]?.init.headers).get("x-api-key")).toBe("anthropic-secret");
  expect(new Headers(fetchCalls[0]?.init.headers).get("anthropic-version")).toBe("2023-06-01");
  expect(result).toEqual({
    ok: true,
    runId: "runtime_api_anthropic_success",
    adapterId: "opencode",
    state: "COMPLETED",
    sessionId: "session_api-anthropic-session",
    artifactId: "artifact_api-anthropic-artifact",
  });
  expect(dependencies.events).toHaveLength(2);
  expect(JSON.parse(String(dependencies.events[1]?.payloadJson))).toMatchObject({
    lastMessage: "Objective\nActions\nOutcome",
    requestId: "anthropic_req_1",
    responseStatus: 200,
  });
});
