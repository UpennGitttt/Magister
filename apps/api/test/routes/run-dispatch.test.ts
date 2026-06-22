import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { ChannelSessionRepository } from "../../src/repositories/channel-session-repository";
import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { getExecutorCircuitState } from "../../src/services/executor-circuit-breaker-service";
import { recordExecutorCircuitFailure } from "../../src/services/executor-circuit-breaker-service";
import { readExecutorConfigFile } from "../../src/services/executor-config-service";
import { getExecutorSlotList } from "../../src/services/executor-slot-service";
import { getExecutorCapabilities } from "../../src/services/executor-capability-service";
import {
  classifyConfigurationBlockCode,
  classifyDispatchFailure,
} from "../../src/services/dispatch-run/failure-mapping";
import { resolveDispatchTargets } from "../../src/services/dispatch-run/route-selection";
import {
  resolveRuntimeContinuityDecision,
  resolveRuntimeContinuityPolicy,
} from "../../src/services/runtime-continuity-service";
import { writeSecretValue } from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-run-dispatch-db");
const originalFetch = globalThis.fetch;
const originalCircuitStorePath = process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH;
const originalCircuitFailureThreshold = process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD;
const originalCircuitOpenMs = process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS;

function createStubExecutorConfig() {
  return {
    executors: {
      codex: {
        configuredModel: "gpt-5.3-codex",
        commandPath: "__stub__",
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
  };
}

function parseEventPayload(event: { payloadJson?: string | null }) {
  try {
    return JSON.parse(event.payloadJson ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function initializeGitWorkspace(path: string) {
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Magister Test"], {
    cwd: path,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "magister-tests@example.com"], {
    cwd: path,
    stdio: "ignore",
  });
  writeFileSync(join(path, "README.md"), "# runtime workspace fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: path, stdio: "ignore" });
}

test("resolveDispatchTargets preserves route ordering as primary then fallback", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeFileSync(configPath, JSON.stringify(createStubExecutorConfig()));

  const config = await readExecutorConfigFile();
  const executorSlots = await getExecutorSlotList();
  const targets = resolveDispatchTargets({
    adapterId: "codex",
    roleId: "leader",
    strategy: "prefer_agent",
    fallbackAdapterId: "qoder",
    config,
    executorSlots,
  });

  expect(targets.length).toBeGreaterThanOrEqual(2);
  expect(targets[0]?.slot.adapterId).toBe("codex");
  expect(targets[0]?.routeSource).toBe("primary");
  expect(targets[1]?.slot.adapterId).toBe("qoder");
  expect(targets[1]?.routeSource).toBe("fallback");
});

test("classifyDispatchFailure marks transient and auth failures with different dispositions", () => {
  expect(classifyDispatchFailure("executor_timeout")).toEqual({
    failureClass: "transient",
    retryability: true,
    nextAction: "reroute",
  });
  expect(classifyDispatchFailure("executor_auth_failed")).toEqual({
    failureClass: "auth",
    retryability: false,
    nextAction: "manual_fix",
  });
});

test("classifyConfigurationBlockCode maps missing fields to stable block codes", () => {
  expect(classifyConfigurationBlockCode(["baseUrl"])).toBe("executor_provider_missing");
  expect(classifyConfigurationBlockCode(["model"])).toBe("executor_model_missing");
  expect(classifyConfigurationBlockCode(["configuredModel"])).toBe("executor_unconfigured");
});

test("runtime continuity derives policy from executor capabilities rather than adapter special-casing", () => {
  expect(getExecutorCapabilities("codex")).toMatchObject({
    nativeResume: true,
    runtimeWorkspace: true,
    runtimeContract: true,
  });
  expect(getExecutorCapabilities("qoder")).toMatchObject({
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  });
  expect(resolveRuntimeContinuityPolicy({ adapterId: "codex", priorSessionId: "session_resume_1" })).toBe(
    "resume_first",
  );
  expect(resolveRuntimeContinuityPolicy({ adapterId: "qoder", priorSessionId: "session_resume_1" })).toBe(
    "rehydrate_only",
  );
  expect(
    resolveRuntimeContinuityDecision({
      adapterId: "qoder",
      priorSessionId: "session_resume_1",
      priorWorkdir: "/tmp/qoder-workdir",
      resumePolicy: "resume_first",
    }),
  ).toMatchObject({
    policy: "resume_first",
    adapterId: "qoder",
    adapterSupportsResume: false,
    nativeResumeAttempted: false,
    fallbackToFresh: true,
    reason: "resume_not_supported_for_qoder",
  });
});

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `run-dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH = join(
    tempRoot,
    `circuits-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD = "2";
  process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS = "60000";
  // Spec §1.10 (2026-05-17) — sandbox default flipped to `optional`.
  // Run-dispatch tests assert pre-flip adapter snapshots and the
  // routing decision is sensitive to whether the sandbox metadata
  // changes the runtime contract. Pin mode=off so these tests keep
  // exercising the unsandboxed CLI executor path they were written
  // against; sandbox-aware behavior is covered by execution-sandbox-
  // service.test.ts.
  process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "off";
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
  process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH = originalCircuitStorePath;
  process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD = originalCircuitFailureThreshold;
  process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS = originalCircuitOpenMs;
  globalThis.fetch = originalFetch;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("POST /runs/:runId/dispatch routes to the API executor when the binding is api and provider and model are configured", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      ...createStubExecutorConfig(),
      roleRouting: {
        manager: "opencode",
        architect: "opencode",
        coder: "opencode",
        reviewer: "qoder",
        lander: "opencode",
      },
      providers: {
        minimax_api: {
          label: "MiniMax API",
          vendor: "minimax",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.minimax.chat/v1",
          auth: {
            kind: "api_key",
            secretRef: "MINIMAX_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        minimax_coding_plan: {
          label: "MiniMax Coding Plan",
          vendor: "minimax",
          modelName: "MiniMax Coding Plan",
          providerRefs: {
            api: "minimax_api",
          },
          defaultReasoning: {
            mode: "auto",
            effort: "medium",
          },
        },
      },
      bindings: {
        opencode: {
          executionMode: "api",
          modelRef: "minimax_coding_plan",
          providerRef: "minimax_api",
          timeoutMs: 120000,
        },
      },
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T11:10:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_api_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch the API-backed manager runtime",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_api_1",
    taskId: "task_dispatch_api_1",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  writeSecretValue("MINIMAX_API_KEY", "minimax-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "MiniMax API completed the run." }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_minimax_success",
      },
    })) as unknown as typeof fetch;

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_api_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_api_1",
      adapterId: "opencode",
      state: "COMPLETED",
      sessionId: expect.stringContaining("session_"),
      artifactId: expect.stringContaining("artifact_"),
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_api_1",
  });
  const taskResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_dispatch_api_1",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_api_1",
      state: "COMPLETED",
      executorId: "opencode",
      sessionId: expect.stringContaining("session_"),
      latestArtifactSummary: "MiniMax API completed the run.",
    },
  });

  expect(taskResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "task_dispatch_api_1",
      // Task completion is now driven by the leader loop via processTaskIntent,
      // not by dispatchRun. A single run dispatch leaves the task IN_PROGRESS.
      state: "IN_PROGRESS",
      latestArtifactSummary: "MiniMax API completed the run.",
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_api_1");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run.claimed", "run.started", "run.completed"]),
  );

  const completedPayload = parseEventPayload(
    events.find((event) => event.type === "run.completed") ?? {},
  );
  expect(completedPayload).toMatchObject({
    adapterId: "opencode",
    sessionId: expect.stringContaining("session_"),
    artifactId: expect.stringContaining("artifact_"),
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_api_1/context",
  });

  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        runtimeWorkspace: {
          runId: "runtime_dispatch_api_1",
          taskId: "task_dispatch_api_1",
          roleId: "leader",
          workspaceId: "workspace_main",
        },
      },
    },
  });
  const apiContextBody = contextResponse.json() as {
    data?: {
      metadata?: {
        runtimeWorkspace?: Record<string, unknown> | null;
      };
    };
  };
  expect(apiContextBody.data?.metadata?.runtimeWorkspace).toBeTruthy();
  expect(
    Object.prototype.hasOwnProperty.call(
      apiContextBody.data?.metadata?.runtimeWorkspace ?? {},
      "requestedStrategy",
    ),
  ).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(
      apiContextBody.data?.metadata?.runtimeWorkspace ?? {},
      "decisionReason",
    ),
  ).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(
      apiContextBody.data?.metadata?.runtimeWorkspace ?? {},
      "fallbackReason",
    ),
  ).toBe(true);
});

test("POST /runs/:runId/dispatch executes a stubbed adapter run and materializes session output", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(configPath, JSON.stringify(createStubExecutorConfig()));

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T11:20:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch the manager runtime",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_1",
    taskId: "task_dispatch_1",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    priorSessionId: "session_previous_dispatch_1",
    priorWorkdir: "/tmp/previous-workdir",
    resumePolicy: "resume_first",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
      ok: true,
      data: {
        runId: "runtime_dispatch_1",
        adapterId: "codex",
        state: "COMPLETED",
      sessionId: expect.stringContaining("session_"),
      artifactId: expect.stringContaining("artifact_"),
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_1",
  });
  const taskResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_dispatch_1",
  });
  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_1/context",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_1",
      state: "COMPLETED",
      executorId: "codex",
      sessionId: expect.stringContaining("session_"),
      latestArtifactSummary: "Stub executor completed the leader run",
    },
  });

  expect(taskResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "task_dispatch_1",
      // Task completion is now driven by the leader loop via processTaskIntent,
      // not by dispatchRun. A single run dispatch leaves the task IN_PROGRESS.
      state: "IN_PROGRESS",
      latestArtifactSummary: "Stub executor completed the leader run",
    },
  });

  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        sessionId: expect.stringContaining("session_"),
        priorSessionId: "session_previous_dispatch_1",
        priorWorkdir: "/tmp/previous-workdir",
        resumePolicy: "resume_first",
        attemptCount: 1,
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "resume_first",
          adapterId: "codex",
          priorSessionId: "session_previous_dispatch_1",
          priorWorkdir: "/tmp/previous-workdir",
          adapterSupportsResume: true,
          nativeResumeAttempted: true,
          fallbackToFresh: true,
          reason: "resume_requested",
        },
      },
      nextAction: {
        kind: "inspect",
      },
      run: {
        id: "runtime_dispatch_1",
        state: "COMPLETED",
      },
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_1");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run.claimed", "run.message", "run.started", "run.completed"]),
  );
  const resumeFallbackPayload = parseEventPayload(
    events.find((event) => event.type === "run.message") ?? {},
  );
  expect(resumeFallbackPayload).toMatchObject({
    reason: "resume_requested",
    policy: "resume_first",
    priorSessionId: "session_previous_dispatch_1",
    adapterSupportsResume: true,
    fallbackToFresh: true,
    continuity: {
      source: "control_plane",
      decisionSource: "runtime-continuity-service",
      policy: "resume_first",
      adapterId: "codex",
      priorSessionId: "session_previous_dispatch_1",
      priorWorkdir: "/tmp/previous-workdir",
      adapterSupportsResume: true,
      nativeResumeAttempted: true,
      fallbackToFresh: true,
      reason: "resume_requested",
    },
  });
});

test("POST /runs/:runId/dispatch executes the real opencode CLI adapter for coder runs", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  const fakeOpenCodePath = join(tempRoot, "fake-opencode");
  writeFileSync(
    fakeOpenCodePath,
    `#!/bin/sh
printf '%s\n' '{"type":"session.started","session_id":"session_opencode_cli_dispatch_1"}'
printf '%s\n' '{"type":"message.completed","message":{"role":"assistant","content":"OpenCode completed the coder run."}}'
`,
    "utf8",
  );
  chmodSync(fakeOpenCodePath, 0o755);

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "__stub__",
        },
        opencode: {
          configuredModel: "moonshot/kimi-k2",
          commandPath: fakeOpenCodePath,
          sandboxMode: "workspace-write",
          timeoutMs: 120000,
        },
      },
      roleRouting: {
        manager: "codex",
        architect: "opencode",
        coder: "opencode",
        reviewer: "codex",
        lander: "codex",
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-14T06:10:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_opencode_cli_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch the real OpenCode coder runtime",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_opencode_cli_1",
    taskId: "task_dispatch_opencode_cli_1",
    roleId: "coder",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_opencode_cli_1/dispatch",
    payload: {
      workspaceStrategyOverride: "workspace_root",
    },
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_opencode_cli_1",
      adapterId: "opencode",
      state: "COMPLETED",
      sessionId: "session_opencode_cli_dispatch_1",
      artifactId: expect.any(String),
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_opencode_cli_1",
  });
  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_opencode_cli_1/context",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_opencode_cli_1",
      state: "COMPLETED",
      executorId: "opencode",
      sessionId: "session_opencode_cli_dispatch_1",
      latestArtifactSummary: "OpenCode completed the coder run.",
    },
  });
  const contextBody = contextResponse.json() as {
    ok: boolean;
    data: {
      metadata: {
        sessionId?: string | null;
        runtimeWorkspace?: Record<string, unknown> | null;
      };
      runtimeContextArtifactId: string | null;
      runtimeContextSummary: {
        run?: {
          id?: string;
          roleId?: string;
        };
      } | null;
    };
  };
  expect(contextBody).toMatchObject({
    ok: true,
    data: {
      metadata: {
        sessionId: "session_opencode_cli_dispatch_1",
        runtimeWorkspace: {
          runId: "runtime_dispatch_opencode_cli_1",
          taskId: "task_dispatch_opencode_cli_1",
          roleId: "coder",
          workspaceId: "workspace_main",
          requestedStrategy: "workspace_root",
        },
        workspaceStrategyOverride: "workspace_root",
      },
      runtimeContextSummary: {
        run: {
          id: "runtime_dispatch_opencode_cli_1",
          roleId: "coder",
        },
      },
    },
  });
  expect(contextBody.data.runtimeContextArtifactId).toEqual(expect.any(String));
  expect(contextBody.data.metadata.runtimeWorkspace).toBeTruthy();
  expect(
    Object.prototype.hasOwnProperty.call(
      contextBody.data.metadata.runtimeWorkspace ?? {},
      "decisionReason",
    ),
  ).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(
      contextBody.data.metadata.runtimeWorkspace ?? {},
      "fallbackReason",
    ),
  ).toBe(true);

  const events = await executionEventRepository.listByTaskId("task_dispatch_opencode_cli_1");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "run.claimed",
      "runtime_workspace.allocated",
      "run.started",
      "run.completed",
    ]),
  );
  const allocatedPayload = parseEventPayload(
    events.find((event) => event.type === "runtime_workspace.allocated") ?? {},
  );
  expect(allocatedPayload).toMatchObject({
    adapterId: "opencode",
    workspaceStrategyOverride: "workspace_root",
    requestedStrategy: "workspace_root",
    resolvedStrategy: "workspace_root",
    decisionReason: "operator_override",
    fallbackReason: null,
  });
  const completedPayload = parseEventPayload(
    events.find((event) => event.type === "run.completed") ?? {},
  );
  expect(completedPayload).toMatchObject({
    adapterId: "opencode",
    sessionId: "session_opencode_cli_dispatch_1",
  });
});

test("POST /runs/:runId/dispatch clears a persisted workspace override when payload sets null", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  const fakeOpenCodePath = join(tempRoot, "fake-opencode-clear-override");
  writeFileSync(
    fakeOpenCodePath,
    `#!/bin/sh
printf '%s\n' '{"type":"session.started","session_id":"session_opencode_cli_dispatch_clear_1"}'
printf '%s\n' '{"type":"message.completed","message":{"role":"assistant","content":"OpenCode completed after clearing override."}}'
`,
    "utf8",
  );
  chmodSync(fakeOpenCodePath, 0o755);
  const cleanWorkspaceDir = join(tempRoot, "workspace-clear-override");
  mkdirSync(cleanWorkspaceDir, { recursive: true });
  initializeGitWorkspace(cleanWorkspaceDir);
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: cleanWorkspaceDir,
  });

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "__stub__",
        },
        opencode: {
          configuredModel: "moonshot/kimi-k2",
          commandPath: fakeOpenCodePath,
          sandboxMode: "workspace-write",
          timeoutMs: 120000,
        },
      },
      roleRouting: {
        manager: "codex",
        architect: "opencode",
        coder: "opencode",
        reviewer: "codex",
        lander: "codex",
      },
      providers: {},
      models: {},
      bindings: {},
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-14T06:11:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_opencode_cli_clear_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch after clearing runtime workspace override",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_opencode_cli_clear_1",
    taskId: "task_dispatch_opencode_cli_clear_1",
    roleId: "coder",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    workspaceStrategyOverride: "workspace_root",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_opencode_cli_clear_1/dispatch",
    payload: {
      workspaceStrategyOverride: null,
    },
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_opencode_cli_clear_1",
      adapterId: "opencode",
      state: "COMPLETED",
      sessionId: "session_opencode_cli_dispatch_clear_1",
    },
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_opencode_cli_clear_1/context",
  });
  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        workspaceStrategyOverride: null,
        runtimeWorkspace: {
          requestedStrategy: "git_worktree",
          strategy: "git_worktree",
          decisionReason: "coding_lane_default",
          fallbackReason: null,
        },
      },
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_opencode_cli_clear_1");
  const allocatedPayload = parseEventPayload(
    events.find((event) => event.type === "runtime_workspace.allocated") ?? {},
  );
  expect(allocatedPayload).toMatchObject({
    adapterId: "opencode",
    workspaceStrategyOverride: null,
    requestedStrategy: "git_worktree",
    resolvedStrategy: "git_worktree",
    decisionReason: "coding_lane_default",
    fallbackReason: null,
  });
});

test("POST /runs/:runId/dispatch fails with a control-plane error when the routed executor is unconfigured", async () => {
  delete process.env.MAGISTER_MODEL_CODEX;
  delete process.env.MAGISTER_MODEL_GENERAL_MODEL;

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const createdAt = new Date("2026-04-10T11:25:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_missing_model",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should stop on missing model config",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_missing_model",
    taskId: "task_dispatch_missing_model",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_missing_model/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(409);
  expect(dispatchResponse.json()).toMatchObject({
    ok: false,
    error: {
      code: "executor_unconfigured",
      message: expect.stringContaining("configuredModel"),
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_missing_model",
  });
  const taskResponse = await app.inject({
    method: "GET",
    url: "/tasks/task_dispatch_missing_model",
  });
  const workspaceResponse = await app.inject({
    method: "GET",
    url: "/workspace/summary",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_missing_model",
      state: "FAILED",
      executorId: "model",
      lastError: expect.stringContaining("Configure Model Fallback"),
    },
  });

  expect(taskResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "task_dispatch_missing_model",
      state: "BLOCKED",
      latestBlocker: expect.stringContaining("Configure Model Fallback"),
    },
  });

  expect(workspaceResponse.json()).toMatchObject({
    ok: true,
    data: {
      blockedTaskCount: 1,
      failedRunCount: 1,
      degradedAdapterCount: 1,
    },
  });
});

test("POST /runs/:runId/dispatch returns blockedBy details when the routed API provider is not ready", async () => {
  delete process.env.MOONSHOT_API_KEY;

  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {
        manager: "opencode",
      },
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
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        kimi_coding_plan: {
          label: "Kimi Coding Plan",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "kimi_main",
          },
        },
      },
      bindings: {
        opencode: {
          executionMode: "api",
          modelRef: "kimi_coding_plan",
          providerRef: "kimi_main",
          timeoutMs: 120000,
        },
      },
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const createdAt = new Date("2026-04-10T11:30:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_provider_missing",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should stop on missing provider readiness",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_provider_missing",
    taskId: "task_dispatch_provider_missing",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_provider_missing/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(409);
  expect(dispatchResponse.json()).toMatchObject({
    ok: false,
    error: {
      code: "executor_provider_missing",
      message: expect.stringContaining("auth.secretRef"),
    },
  });
});

test("POST /runs/:runId/dispatch treats rehydrate-only continuity as a fresh start with preserved context", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }
  writeFileSync(configPath, JSON.stringify(createStubExecutorConfig()));

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T11:24:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_rehydrate_only_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch the reviewer runtime with rehydration only",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_rehydrate_only_1",
    taskId: "task_dispatch_rehydrate_only_1",
    roleId: "reviewer",
    state: "CREATED",
    delegationMode: "delegate_with_context",
    priorSessionId: "session_previous_reviewer_dispatch_1",
    priorWorkdir: "/tmp/reviewer-workdir",
    resumePolicy: "rehydrate_only",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_rehydrate_only_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_rehydrate_only_1",
      adapterId: "qoder",
      state: "COMPLETED",
    },
  });

  const contextResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_rehydrate_only_1/context",
  });

  expect(contextResponse.json()).toMatchObject({
    ok: true,
    data: {
      metadata: {
        priorSessionId: "session_previous_reviewer_dispatch_1",
        priorWorkdir: "/tmp/reviewer-workdir",
        resumePolicy: "rehydrate_only",
        resumeAttemptedAt: null,
        continuityDecision: {
          source: "control_plane",
          decisionSource: "runtime-continuity-service",
          policy: "rehydrate_only",
          adapterId: "qoder",
          priorSessionId: "session_previous_reviewer_dispatch_1",
          priorWorkdir: "/tmp/reviewer-workdir",
          adapterSupportsResume: false,
          nativeResumeAttempted: false,
          fallbackToFresh: false,
          reason: "rehydrate_only",
        },
      },
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_rehydrate_only_1");
  const continuityPayload = parseEventPayload(
    events.find((event) => event.type === "run.message") ?? {},
  );
  expect(continuityPayload).toMatchObject({
    policy: "rehydrate_only",
    priorSessionId: "session_previous_reviewer_dispatch_1",
    adapterSupportsResume: false,
    nativeResumeAttempted: false,
    fallbackToFresh: false,
    reason: "rehydrate_only",
    continuity: {
      source: "control_plane",
      decisionSource: "runtime-continuity-service",
      policy: "rehydrate_only",
      adapterId: "qoder",
      priorSessionId: "session_previous_reviewer_dispatch_1",
      priorWorkdir: "/tmp/reviewer-workdir",
      adapterSupportsResume: false,
      nativeResumeAttempted: false,
      fallbackToFresh: false,
      reason: "rehydrate_only",
    },
  });
});

test("POST /runs/:runId/dispatch blocks immediately on executor auth failure without rerouting", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      ...createStubExecutorConfig(),
      roleRouting: {
        manager: "opencode",
        architect: "opencode",
        coder: "opencode",
        reviewer: "qoder",
        lander: "opencode",
      },
      providers: {
        minimax_api: {
          label: "MiniMax API",
          vendor: "minimax",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.minimax.chat/v1",
          auth: {
            kind: "api_key",
            secretRef: "MINIMAX_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        minimax_coding_plan: {
          label: "MiniMax Coding Plan",
          vendor: "minimax",
          modelName: "MiniMax Coding Plan",
          providerRefs: {
            api: "minimax_api",
          },
          defaultReasoning: {
            mode: "auto",
            effort: "medium",
          },
        },
      },
      bindings: {
        opencode: {
          executionMode: "api",
          modelRef: "minimax_coding_plan",
          providerRef: "minimax_api",
          timeoutMs: 120000,
        },
      },
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T11:15:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_auth_failed",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should stop on authentication failure",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_auth_failed",
    taskId: "task_dispatch_auth_failed",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  writeSecretValue("MINIMAX_API_KEY", "minimax-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_minimax_auth_failed",
      },
    })) as unknown as typeof fetch;

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_auth_failed/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(409);
  expect(dispatchResponse.json()).toMatchObject({
    ok: false,
    error: {
      code: "executor_auth_failed",
      message: expect.stringContaining("authentication failed"),
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_auth_failed");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run.claimed", "run.started", "run.blocked"]),
  );
  expect(events.map((event) => event.type)).not.toContain("run.progressed");

  const blockedPayload = parseEventPayload(events.find((event) => event.type === "run.blocked") ?? {});
  expect(blockedPayload).toMatchObject({
    reason: "executor_auth_failed",
    failureClass: "auth",
    retryability: false,
    nextAction: "manual_fix",
  });

  const circuitState = await getExecutorCircuitState("opencode");
  expect(circuitState).toMatchObject({
    state: "closed",
    consecutiveFailures: 0,
    lastFailureCode: null,
  });
});

test("POST /runs/:runId/dispatch rejects duplicate dispatches when the run is already active", async () => {
  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const createdAt = new Date("2026-04-10T11:40:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_running",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should not re-enter an active run",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_running",
    taskId: "task_dispatch_running",
    roleId: "leader",
    state: "RUNNING",
    delegationMode: "delegate_fresh",
    attemptCount: 1,
    activeExecutorId: "codex",
    currentSessionId: "session_inflight",
    startedAt: createdAt,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_running/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(409);
  expect(dispatchResponse.json()).toMatchObject({
    ok: false,
    error: {
      code: "executor_unavailable",
      message: expect.stringContaining("already running"),
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_running",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_running",
      state: "RUNNING",
      executorId: "codex",
      sessionId: "session_inflight",
    },
  });
});

test("POST /runs/:runId/dispatch falls back to the default model route when a stale Claude route is unconfigured", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "__stub__",
        },
        claude_code: {
          configuredModel: "",
          commandPath: "claude",
        },
        qoder: {
          configuredModel: "qoder-review",
          commandPath: "qoder",
        },
      },
      roleRouting: {
        manager: "claude_code",
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {
        codex_test_provider: {
          label: "Codex Test Provider",
          vendor: "openai",
          transport: "cli",
          apiDialect: "openai_chat_completions",
          auth: {
            kind: "chatgpt_session",
          },
          cli: {
            commandPath: "/opt/homebrew/bin/codex",
          },
        },
      },
      models: {
        codex_test_model: {
          label: "Codex Test Model",
          vendor: "openai",
          modelName: "gpt-5.3-codex",
          providerRefs: {
            api: "codex_test_provider",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "codex_test_model",
          providerRef: "codex_test_provider",
          timeoutMs: 5000,
        },
      },
    }),
  );

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const createdAt = new Date("2026-04-10T11:45:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_claude_fallback",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should prefer the supported default manager chain",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_claude_fallback",
    taskId: "task_dispatch_claude_fallback",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_claude_fallback/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_claude_fallback",
      adapterId: "model",
      state: "COMPLETED",
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_claude_fallback",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_claude_fallback",
      state: "COMPLETED",
      executorId: "model",
      latestArtifactSummary: "Fake API transport completed the run.",
    },
  });
});

test("POST /runs/:runId/dispatch falls back to the model slot when reviewer qoder is unavailable", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "__stub__",
        },
      },
      roleRouting: {
        manager: "codex",
        architect: "codex",
        coder: "codex",
        reviewer: {
          adapterId: "qoder",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
        },
        lander: "codex",
      },
      providers: {
        reviewer_model_provider: {
          label: "Reviewer Model Provider",
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
        reviewer_model: {
          label: "Reviewer Model",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "reviewer_model_provider",
          },
          defaultReasoning: {
            mode: "auto",
            effort: "medium",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "reviewer_model",
          providerRef: "reviewer_model_provider",
          timeoutMs: 180000,
        },
      },
    }),
  );

  writeSecretValue("MOONSHOT_API_KEY", "moonshot-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Reviewer model approved the plan." }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_reviewer_model_success",
      },
    })) as unknown as typeof fetch;

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const createdAt = new Date("2026-04-10T12:20:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_reviewer_model_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Review the generated plan",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_reviewer_model_1",
    taskId: "task_dispatch_reviewer_model_1",
    roleId: "reviewer",
    state: "CREATED",
    delegationMode: "delegate_with_context",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_reviewer_model_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_reviewer_model_1",
      adapterId: "model",
      state: "COMPLETED",
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_reviewer_model_1",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_reviewer_model_1",
      state: "COMPLETED",
      executorId: "model",
      latestArtifactSummary: "Reviewer model approved the plan.",
    },
  });
});

test("POST /runs/:runId/dispatch reroutes to fallback after a runtime failure on the primary adapter", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "/nonexistent/codex",
        },
      },
      roleRouting: {
        manager: {
          adapterId: "codex",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
        },
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {
        fallback_provider: {
          label: "Fallback Provider",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: {
            kind: "api_key",
            secretRef: "FALLBACK_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        fallback_model: {
          label: "Fallback Model",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "fallback_provider",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "fallback_model",
          providerRef: "fallback_provider",
          timeoutMs: 180000,
        },
      },
    }),
  );

  writeSecretValue("FALLBACK_API_KEY", "fallback-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Fallback lane completed after codex runtime failure." }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_fallback_reroute_success",
      },
    })) as unknown as typeof fetch;

  const app = buildApp();
  const conversationBindingRepository = new ConversationBindingRepository();
  const channelSessionRepository = new ChannelSessionRepository();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T12:45:00.000Z");

  await conversationBindingRepository.create({
    id: "feishu:tenant_alpha:oc_chat_dispatch_reroute_trace",
    channel: "feishu",
    accountId: "tenant_alpha",
    chatId: "oc_chat_dispatch_reroute_trace",
    workspaceId: "workspace_main",
    createdAt,
    updatedAt: createdAt,
    lastInboundAt: createdAt,
  });

  await channelSessionRepository.create({
    id: "feishu:tenant_alpha:oc_chat_dispatch_reroute_trace",
    bindingId: "feishu:tenant_alpha:oc_chat_dispatch_reroute_trace",
    channel: "feishu",
    workspaceId: "workspace_main",
    continuityMode: "reply_preferred",
    verboseLevel: "on",
    createdAt,
    updatedAt: createdAt,
  });

  await taskRepository.create({
    id: "task_dispatch_runtime_reroute_1",
    workspaceId: "workspace_main",
    source: "feishu",
    title: "Reroute manager lane when codex runtime is unavailable",
    state: "IN_PROGRESS",
    rootChannelBindingId: "feishu:tenant_alpha:oc_chat_dispatch_reroute_trace",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_runtime_reroute_1",
    taskId: "task_dispatch_runtime_reroute_1",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_runtime_reroute_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_runtime_reroute_1",
      adapterId: "model",
      state: "COMPLETED",
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_runtime_reroute_1",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_runtime_reroute_1",
      state: "COMPLETED",
      executorId: "model",
      latestArtifactSummary: "Fallback lane completed after codex runtime failure.",
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_runtime_reroute_1");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run.claimed", "run.started", "run.progressed", "run.completed"]),
  );

  const progressedPayload = parseEventPayload(
    events.find((event) => event.type === "run.progressed") ?? {},
  );
  expect(progressedPayload).toMatchObject({
    reason: "executor_unavailable",
    failureClass: "transient",
    retryability: true,
    nextAction: "reroute",
    source: "codex",
    routeSource: "primary",
  });

  const outboundPayloads = events
    .filter((event) => event.type === "channel.outbound.queued")
    .map((event) => parseEventPayload(event));
  expect(outboundPayloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "runtime_trace",
        eventType: "run.rerouted",
        summary: "执行器重路由：codex -> model（executor_unavailable）",
      }),
    ]),
  );
}, 15_000);

test("POST /runs/:runId/dispatch reroutes after a codex timeout and records a transient progress event", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  const timeoutScriptPath = join(tempRoot, `sleep-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(
    timeoutScriptPath,
    "#!/bin/sh\nsleep 1\necho \"Codex timeout probe\"\n",
  );
  chmodSync(timeoutScriptPath, 0o755);

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: timeoutScriptPath,
          timeoutMs: 100,
        },
      },
      roleRouting: {
        manager: {
          adapterId: "codex",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
        },
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {
        fallback_provider: {
          label: "Fallback Provider",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: {
            kind: "api_key",
            secretRef: "FALLBACK_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        fallback_model: {
          label: "Fallback Model",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "fallback_provider",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "fallback_model",
          providerRef: "fallback_provider",
          timeoutMs: 180000,
        },
      },
    }),
  );

  writeSecretValue("FALLBACK_API_KEY", "fallback-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Fallback lane completed after codex timeout." }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_fallback_timeout_success",
      },
    })) as unknown as typeof fetch;

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T12:50:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_timeout_reroute_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Reroute manager lane when codex times out",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_timeout_reroute_1",
    taskId: "task_dispatch_timeout_reroute_1",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_timeout_reroute_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_timeout_reroute_1",
      adapterId: "model",
      state: "COMPLETED",
    },
  });

  const runResponse = await app.inject({
    method: "GET",
    url: "/runs/runtime_dispatch_timeout_reroute_1",
  });

  expect(runResponse.json()).toMatchObject({
    ok: true,
    data: {
      id: "runtime_dispatch_timeout_reroute_1",
      state: "COMPLETED",
      executorId: "model",
      latestArtifactSummary: "Fallback lane completed after codex timeout.",
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_timeout_reroute_1");
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["run.claimed", "run.started", "run.progressed", "run.completed"]),
  );

  const progressedPayload = parseEventPayload(
    events.find((event) => event.type === "run.progressed") ?? {},
  );
  expect(progressedPayload).toMatchObject({
    reason: "executor_timeout",
    failureClass: "transient",
    retryability: true,
    nextAction: "reroute",
  });
}, 15_000);

test("POST /runs/:runId/dispatch skips an open primary circuit and routes directly to fallback", async () => {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) {
    throw new Error("Expected executor config path");
  }

  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {
        codex: {
          configuredModel: "gpt-5.3-codex",
          commandPath: "__stub__",
        },
      },
      roleRouting: {
        manager: {
          adapterId: "codex",
          strategy: "fallback_model",
          fallbackAdapterId: "model",
        },
        architect: "codex",
        coder: "codex",
        reviewer: "qoder",
        lander: "codex",
      },
      providers: {
        fallback_provider: {
          label: "Fallback Provider",
          vendor: "moonshot",
          transport: "api",
          apiDialect: "openai_chat_completions",
          baseUrl: "https://api.moonshot.cn/v1",
          auth: {
            kind: "api_key",
            secretRef: "FALLBACK_API_KEY",
            headerName: "Authorization",
            prefix: "Bearer ",
          },
        },
      },
      models: {
        fallback_model: {
          label: "Fallback Model",
          vendor: "moonshot",
          modelName: "kimi-k2.5-thinking-preview",
          providerRefs: {
            api: "fallback_provider",
          },
        },
      },
      bindings: {
        model: {
          executionMode: "api",
          modelRef: "fallback_model",
          providerRef: "fallback_provider",
          timeoutMs: 180000,
        },
      },
    }),
  );

  await recordExecutorCircuitFailure("codex", {
    code: "executor_unavailable",
  });
  await recordExecutorCircuitFailure("codex", {
    code: "executor_unavailable",
  });

  writeSecretValue("FALLBACK_API_KEY", "fallback-secret");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Fallback lane completed after circuit-open codex." }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_fallback_circuit_open_success",
      },
    })) as unknown as typeof fetch;

  const app = buildApp();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const createdAt = new Date("2026-04-10T13:00:00.000Z");

  await taskRepository.create({
    id: "task_dispatch_circuit_open_1",
    workspaceId: "workspace_main",
    source: "web",
    title: "Dispatch should skip codex when circuit is open",
    state: "IN_PROGRESS",
    createdAt,
    updatedAt: createdAt,
  });
  await roleRuntimeRepository.create({
    id: "runtime_dispatch_circuit_open_1",
    taskId: "task_dispatch_circuit_open_1",
    roleId: "leader",
    state: "CREATED",
    delegationMode: "delegate_fresh",
    attemptCount: 0,
    updatedAt: createdAt,
  });

  const dispatchResponse = await app.inject({
    method: "POST",
    url: "/runs/runtime_dispatch_circuit_open_1/dispatch",
  });

  expect(dispatchResponse.statusCode).toBe(200);
  expect(dispatchResponse.json()).toMatchObject({
    ok: true,
    data: {
      runId: "runtime_dispatch_circuit_open_1",
      adapterId: "model",
      state: "COMPLETED",
    },
  });

  const events = await executionEventRepository.listByTaskId("task_dispatch_circuit_open_1");
  const transitionPayloads = events
    .filter((event) => event.type === "task.orchestration.transition")
    .map((event) => {
      try {
        return JSON.parse(event.payloadJson ?? "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    });

  expect(transitionPayloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason: "reroute_circuit_open",
        fromAdapterId: "codex",
        toAdapterId: "model",
      }),
    ]),
  );
});
