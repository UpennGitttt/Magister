import { expect, test } from "bun:test";

import type { ExecutorDispatchDependencies, ExecutorSlotSnapshot } from "../../src/executors/executor-adapter";
import { createExecutorAdapter } from "../../src/executors/executor-registry";

function createDependencies(): ExecutorDispatchDependencies {
  return {
    roleRuntimeRepository: {
      async update() {},
    },
    taskRepository: {
      async update() {},
    },
    artifactRepository: {
      async create() {},
      async getById() {
        return undefined;
      },
    },
    observabilityAdapter: {
      async recordEvent(event) {
        return {
          event,
          taskSummary: null,
          runSummary: null,
        };
      },
    },
  };
}

test("createExecutorAdapter routes api slots to the API adapter and cli slots to the cli adapter", async () => {
  const apiSlot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "api",
    status: "unconfigured",
    configSource: "default",
    notes: "API-backed coding slot for heterogeneous execution.",
  } as ExecutorSlotSnapshot;

  const cliSlot = {
    adapterId: "qoder",
    displayName: "Qoder",
    executorType: "coding_agent",
    roleTargets: ["reviewer"],
    configKey: "MAGISTER_MODEL_QODER",
    executionMode: "cli",
    status: "unconfigured",
    configSource: "default",
    notes: "Review-focused slot for PR critique and quality gate feedback.",
  } as ExecutorSlotSnapshot;

  const apiResult = await createExecutorAdapter(apiSlot).execute({
    runtime: {
      id: "runtime_api_route",
      taskId: "task_api_route",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_api_route",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: apiSlot,
    dependencies: createDependencies(),
  });

  const cliResult = await createExecutorAdapter(cliSlot).execute({
    runtime: {
      id: "runtime_cli_route",
      taskId: "task_cli_route",
      roleId: "reviewer",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_cli_route",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot: cliSlot,
    dependencies: createDependencies(),
  });

  expect(apiResult).toMatchObject({
    ok: false,
    code: "executor_unconfigured",
    message: expect.stringContaining("API provider"),
  });
  expect(cliResult).toMatchObject({
    ok: false,
    code: "executor_unconfigured",
    message: expect.stringContaining("Configure a model for Qoder"),
  });
});

test("createExecutorAdapter routes cli slots with __stub__ command paths to the stub adapter", async () => {
  const stubbedCodexSlot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    status: "configured",
    configSource: "file",
    commandPath: "__stub__",
    configuredModel: "gpt-5.4-codex",
    notes: "Stubbed Codex slot for local/test orchestration.",
  } as ExecutorSlotSnapshot;

  const result = await createExecutorAdapter(stubbedCodexSlot).execute({
    runtime: {
      id: "runtime_stub_route",
      taskId: "task_stub_route",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_stub_route",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Stubbed Codex manager run",
    },
    slot: stubbedCodexSlot,
    dependencies: createDependencies(),
  });

  expect(result).toMatchObject({
    ok: true,
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: expect.stringContaining("session_"),
    artifactId: expect.stringContaining("artifact_"),
  });
});
