import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RuntimeConfig = {
  workspaceDir: string;
  baseWorkspaceDir?: string | null;
  initialPrompt: string;
  observeEvent?: (event: any) => void | Promise<void>;
};

let tempRoot = "";
let runtimeCalls: RuntimeConfig[] = [];
let workerCalls: RuntimeConfig[] = [];
let workerMode: "off" | "optional" | "required" = "off";
let runtimeBehavior: (config: RuntimeConfig) => Promise<{
  reason: string;
  turnCount: number;
  messages: any[];
}>;
let workerBehavior: (input: {
  config: RuntimeConfig;
  observeEvent?: (event: any) => void | Promise<void>;
  observeWorkerProcessState?: (state: any) => void | Promise<void>;
  observeWorkerSandboxState?: (state: any) => void | Promise<void>;
}) => Promise<{
  reason: string;
  turnCount: number;
  messages: any[];
}>;

mock.module(
  "../../src/services/manager-automation/autonomous-loop/manager-autonomous-runtime",
  () => ({
    buildLeaderRuntimeModelConfig: (apiConfig: any) => ({
      modelName: apiConfig.model.modelName,
    }),
    resolveLeaderRuntimeTools: async () => ({ tools: [], maxTurns: 60 }),
    runLeaderRuntime: (config: RuntimeConfig) => {
      if (!belongsToCurrentTempRoot(config)) {
        return ignoredForeignRuntimeResult(config);
      }
      return runtimeBehavior(config);
    },
  }),
);

mock.module("../../src/services/leader-runtime-worker-service", () => ({
  resolveLeaderWorkerMode: () => workerMode,
  runLeaderRuntimeInWorker: (input: {
    config: RuntimeConfig;
    observeEvent?: (event: any) => void | Promise<void>;
    observeWorkerProcessState?: (state: any) => void | Promise<void>;
    observeWorkerSandboxState?: (state: any) => void | Promise<void>;
  }) => {
    if (!belongsToCurrentTempRoot(input.config)) {
      return ignoredForeignRuntimeResult(input.config);
    }
    return workerBehavior(input);
  },
}));

beforeEach(() => {
  tempRoot = join(
    tmpdir(),
    `leader-safe-apply-isolation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(tempRoot, "test.sqlite");
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: tempRoot,
  });
  const configPath = join(tempRoot, "executors.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: { leader: { adapterId: "leader-model", strategy: "model_only" } },
      providers: {
        provider_openai: {
          label: "Provider OpenAI",
          vendor: "test",
          transport: "api",
          apiDialect: "openai_chat_completions",
          auth: { kind: "none" },
        },
      },
      models: {
        model_leader: {
          label: "Leader Model",
          vendor: "test",
          modelName: "leader-model",
          providerRefs: { api: "provider_openai" },
        },
      },
      bindings: {
        "leader-model": {
          executionMode: "api",
          modelRef: "model_leader",
          providerRef: "provider_openai",
        },
      },
    }),
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
  runtimeCalls = [];
  workerCalls = [];
  workerMode = "off";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "leader done" }],
        },
      ],
    };
  };
  workerBehavior = async ({ config, observeEvent, observeWorkerProcessState }) => {
    recordWorkerCall(config);
    await observeWorkerProcessState?.({ status: "active" });
    return await runtimeBehavior({
      ...config,
      ...(observeEvent ? { observeEvent } : {}),
    });
  };
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_LEADER_SAFE_APPLY_MODE;
  delete process.env.MAGISTER_LEADER_WORKER_MODE;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_NETWORK;
  rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

function initGitRepo(dir: string) {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
}

async function listHardeningStates(taskId: string): Promise<any[]> {
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const events = await new ExecutionEventRepository().listByTaskIdAndType(
    taskId,
    "leader.hardening_state",
  );
  return events.map((event) => JSON.parse(event.payloadJson ?? "{}"));
}

async function importProcessTaskIntentService(): Promise<typeof import("../../src/services/process-task-intent-service")> {
  return await import(
    `../../src/services/process-task-intent-service.ts?leaderSafeApplyIsolation=${Date.now()}-${Math.random()}`
  );
}

function belongsToCurrentTempRoot(config: RuntimeConfig): boolean {
  return [config.workspaceDir, config.baseWorkspaceDir]
    .filter((path): path is string => typeof path === "string")
    .some((path) => path === tempRoot || path.startsWith(`${tempRoot}/`));
}

function ignoredForeignRuntimeResult(config: RuntimeConfig): {
  reason: string;
  turnCount: number;
  messages: any[];
} {
  return {
    reason: "completed",
    turnCount: 1,
    messages: [
      { type: "user", content: config.initialPrompt },
      {
        type: "assistant",
        content: [{ type: "text", text: "ignored foreign runtime call" }],
      },
    ],
  };
}

function recordRuntimeCall(config: RuntimeConfig): void {
  if (belongsToCurrentTempRoot(config)) {
    runtimeCalls.push(config);
  }
}

function recordWorkerCall(config: RuntimeConfig): void {
  if (belongsToCurrentTempRoot(config)) {
    workerCalls.push(config);
  }
}

test("leader safe apply optional mode writes in a worktree and creates a review", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "optional";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    await config.observeEvent?.({
      type: "leader.tool_call",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: {
        toolUseId: "write-1",
        toolName: "write_file",
        toolSafety: {
          classification: "mutating",
          readOnly: false,
          planSafe: false,
        },
      },
    });
    await writeFile(join(config.workspaceDir, "README.md"), "leader changed\n", "utf8");
    await config.observeEvent?.({
      type: "leader.tool_result",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: { toolUseId: "write-1", toolName: "write_file", isError: false },
    });
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "leader changed README" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).toContain("Safe Apply review created");
  expect(runtimeCalls).toHaveLength(1);
  expect(runtimeCalls[0]!.workspaceDir).not.toBe(tempRoot);
  expect(runtimeCalls[0]!.baseWorkspaceDir).toBe(tempRoot);
  expect(runtimeCalls[0]!.workspaceDir).toContain(".worktrees");
  expect(existsSync(runtimeCalls[0]!.workspaceDir)).toBe(false);
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("base\n");

  const { ArtifactRepository } = await import("../../src/repositories/artifact-repository");
  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    result.taskId,
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(1);
  const payload = JSON.parse(safeApplyEvents[0]!.payloadJson ?? "{}");
  expect(payload.changedFiles).toBe(1);

  const reviewDraftArtifact = await new ArtifactRepository().getById(payload.reviewDraftArtifactId);
  const draft = JSON.parse(await readFile(reviewDraftArtifact!.storageRef, "utf8"));
  expect(draft.runtimeSecurity.runtimeSource).toBe("ucm");
  expect(draft.runtimeSecurity.runtimeWorkspaceStrategy).toBe("git_worktree");
  expect(draft.diffArtifact.changedFiles).toContainEqual(expect.objectContaining({
    path: "README.md",
    status: "modified",
  }));

  const reviews = await new ChangeReviewRepository().listByTaskId(result.taskId);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    reviewDraftArtifactId: payload.reviewDraftArtifactId,
    decisionState: "pending",
    applyState: "not_applied",
  });
});

test("leader safe apply off mode keeps existing main-workspace behavior", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "off";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    await writeFile(join(config.workspaceDir, "README.md"), "changed in main\n", "utf8");
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "main workspace changed" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README without isolation",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).toContain("main workspace changed");
  expect(result.finalAnswer).not.toContain("Safe Apply review created");
  expect(runtimeCalls).toHaveLength(1);
  expect(runtimeCalls[0]!.workspaceDir).toBe(tempRoot);
  expect(runtimeCalls[0]!.baseWorkspaceDir ?? null).toBeNull();
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("changed in main\n");

  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  expect(
    await new ExecutionEventRepository().listByTaskIdAndType(
      result.taskId,
      "safe_apply.review_draft_created",
    ),
  ).toHaveLength(0);
  expect(await new ChangeReviewRepository().listByTaskId(result.taskId)).toHaveLength(0);
});

test("leader worker optional mode runs through worker when safe apply worktree is active", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "optional";
  workerMode = "optional";
  workerBehavior = async ({ config, observeEvent }) => {
    recordWorkerCall(config);
    await observeEvent?.({
      type: "leader.tool_call",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: {
        toolUseId: "worker-write-1",
        toolName: "write_file",
        toolSafety: {
          classification: "mutating",
          readOnly: false,
          planSafe: false,
        },
      },
    });
    await writeFile(join(config.workspaceDir, "README.md"), "worker changed\n", "utf8");
    await observeEvent?.({
      type: "leader.tool_result",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: { toolUseId: "worker-write-1", toolName: "write_file", isError: false },
    });
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "worker leader changed README" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README through worker",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).toContain("worker leader changed README");
  expect(result.finalAnswer).toContain("Safe Apply review created");
  expect(runtimeCalls).toHaveLength(0);
  expect(workerCalls).toHaveLength(1);
  expect(workerCalls[0]!.workspaceDir).not.toBe(tempRoot);
  expect(workerCalls[0]!.baseWorkspaceDir).toBe(tempRoot);
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("base\n");

  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const reviews = await new ChangeReviewRepository().listByTaskId(result.taskId);
  expect(reviews).toHaveLength(1);
});

test("leader hardening state records parent-observed strict worker states and creates review", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "required";
  process.env.MAGISTER_LEADER_WORKER_MODE = "required";
  process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "required";
  process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";
  process.env.MAGISTER_EXECUTION_SANDBOX_NETWORK = "host";
  workerMode = "required";
  // This processTaskIntent test verifies strict-mode wiring, event emission,
  // and Safe Apply review creation. The real worker process and bubblewrap
  // filesystem boundary are covered in leader-runtime-worker-service.test.ts.
  workerBehavior = async ({
    config,
    observeEvent,
    observeWorkerProcessState,
    observeWorkerSandboxState,
  }) => {
    recordWorkerCall(config);
    await observeWorkerProcessState?.({ status: "active" });
    await observeWorkerSandboxState?.({
      status: "active",
      provider: "bubblewrap",
      network: "host",
    });
    await observeEvent?.({
      type: "leader.tool_call",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: {
        toolUseId: "strict-write-1",
        toolName: "write_file",
        toolSafety: {
          classification: "mutating",
          readOnly: false,
          planSafe: false,
        },
      },
    });
    await writeFile(join(config.workspaceDir, "README.md"), "strict worker changed\n", "utf8");
    await observeEvent?.({
      type: "leader.tool_result",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: { toolUseId: "strict-write-1", toolName: "write_file", isError: false },
    });
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "strict worker done" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README through strict worker",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(workerCalls).toHaveLength(1);
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("base\n");

  const hardeningStates = await listHardeningStates(result.taskId);
  expect(hardeningStates).toHaveLength(1);
  expect(hardeningStates[0]).toMatchObject({
    safeApplyMode: "required",
    workerMode: "required",
    executionSandboxMode: "required",
    runtimeWorkspace: {
      status: "isolated_worktree",
      baseWorkspaceDir: tempRoot,
    },
    workerProcess: {
      status: "active",
    },
    workerSandbox: {
      status: "active",
      provider: "bubblewrap",
      network: "host",
    },
  });
  expect(JSON.stringify(hardeningStates[0])).not.toContain("MAGISTER_DB_PATH");
  expect(JSON.stringify(hardeningStates[0])).not.toContain("MAGISTER_SECRET_STORE_PATH");
});

test("leader hardening state records failed worker status when worker service rejects before start", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "required";
  workerMode = "required";
  workerBehavior = async ({ config }) => {
    recordWorkerCall(config);
    throw new Error("pre-spawn failure");
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Try strict worker with launch failure",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("error");
  expect(workerCalls).toHaveLength(1);

  const hardeningStates = await listHardeningStates(result.taskId);
  expect(hardeningStates).toHaveLength(1);
  expect(hardeningStates[0]).toMatchObject({
    safeApplyMode: "required",
    workerMode: "required",
    runtimeWorkspace: {
      status: "isolated_worktree",
      baseWorkspaceDir: tempRoot,
    },
    workerProcess: {
      status: "failed",
      failureReason: "worker process did not start",
    },
  });
  expect(hardeningStates[0].workerProcess.status).not.toBe("active");
});

test("leader safe apply optional mode falls back to main workspace outside git", async () => {
  writeFileSync(join(tempRoot, "README.md"), "base\n", "utf8");
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "optional";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    await writeFile(join(config.workspaceDir, "README.md"), "fallback changed\n", "utf8");
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "fallback completed" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README with optional isolation outside git",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).toContain("fallback completed");
  expect(result.finalAnswer).not.toContain("Safe Apply review created");
  expect(runtimeCalls).toHaveLength(1);
  expect(runtimeCalls[0]!.workspaceDir).toBe(tempRoot);
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("fallback changed\n");

  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  expect(
    await new ExecutionEventRepository().listByTaskIdAndType(
      result.taskId,
      "safe_apply.review_draft_created",
    ),
  ).toHaveLength(0);
  expect(await new ChangeReviewRepository().listByTaskId(result.taskId)).toHaveLength(0);

  const hardeningStates = await listHardeningStates(result.taskId);
  expect(hardeningStates).toHaveLength(1);
  expect(hardeningStates[0]).toMatchObject({
    safeApplyMode: "optional",
    workerMode: "off",
    runtimeWorkspace: {
      status: "main_workspace",
      workspaceDir: tempRoot,
    },
    workerProcess: {
      status: "not_requested",
    },
  });
  expect(hardeningStates[0].runtimeWorkspace.failureReason).toContain(
    "Leader Safe Apply isolation required but not available",
  );
  expect(hardeningStates[0].workerSandbox.status).not.toBe("active");
});

test("leader worker required mode fails closed when safe apply worktree is not active", async () => {
  writeFileSync(join(tempRoot, "README.md"), "base\n", "utf8");
  workerMode = "required";

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Try worker without leader worktree",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("configuration_error");
  expect(result.finalAnswer).toContain("Leader worker isolation required");
  expect(runtimeCalls).toHaveLength(0);
  expect(workerCalls).toHaveLength(0);

  const hardeningStates = await listHardeningStates(result.taskId);
  expect(hardeningStates).toHaveLength(1);
  expect(hardeningStates[0]).toMatchObject({
    safeApplyMode: "off",
    workerMode: "required",
    runtimeWorkspace: {
      status: "main_workspace",
      workspaceDir: tempRoot,
    },
    workerProcess: {
      status: "failed",
    },
  });
  expect(hardeningStates[0].workerProcess.failureReason).toContain(
    "leader Safe Apply worktree isolation is not active",
  );
});

test("leader worker optional mode records fallback when safe apply worktree is not active", async () => {
  writeFileSync(join(tempRoot, "README.md"), "base\n", "utf8");
  workerMode = "optional";

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Run optional worker without leader worktree",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(runtimeCalls).toHaveLength(1);
  expect(workerCalls).toHaveLength(0);

  const hardeningStates = await listHardeningStates(result.taskId);
  expect(hardeningStates).toHaveLength(1);
  expect(hardeningStates[0]).toMatchObject({
    safeApplyMode: "off",
    workerMode: "optional",
    runtimeWorkspace: {
      status: "main_workspace",
      workspaceDir: tempRoot,
    },
    workerProcess: {
      status: "fallback",
      failureReason: "leader Safe Apply worktree isolation is not active",
    },
  });
  expect(hardeningStates[0].workerSandbox.status).not.toBe("active");
});

test("leader safe apply draft failure keeps successful leader answer", async () => {
  initGitRepo(tempRoot);
  writeFileSync(join(tempRoot, ".magister"), "not a directory", "utf8");
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "optional";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    await config.observeEvent?.({
      type: "leader.tool_call",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: {
        toolUseId: "write-fail-1",
        toolName: "write_file",
        toolSafety: {
          classification: "mutating",
          readOnly: false,
          planSafe: false,
        },
      },
    });
    await writeFile(join(config.workspaceDir, "README.md"), "draft failure changed\n", "utf8");
    await config.observeEvent?.({
      type: "leader.tool_result",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: { toolUseId: "write-fail-1", toolName: "write_file", isError: false },
    });
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "leader answer survived draft failure" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README while draft storage is broken",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).toContain("leader answer survived draft failure");
  expect(result.finalAnswer).not.toContain("ENOTDIR");
  expect(result.finalAnswer).not.toContain("Safe Apply review created");
  expect(runtimeCalls).toHaveLength(1);
  expect(runtimeCalls[0]!.workspaceDir).toContain(".worktrees");
  expect(existsSync(runtimeCalls[0]!.workspaceDir)).toBe(false);
  expect(await readFile(join(tempRoot, "README.md"), "utf8")).toBe("base\n");

  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  expect(
    await new ExecutionEventRepository().listByTaskIdAndType(
      result.taskId,
      "safe_apply.review_draft_created",
    ),
  ).toHaveLength(0);
  expect(await new ChangeReviewRepository().listByTaskId(result.taskId)).toHaveLength(0);
});

test("leader safe apply read-only empty diff creates no review", async () => {
  initGitRepo(tempRoot);
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "optional";
  runtimeBehavior = async (config) => {
    recordRuntimeCall(config);
    await config.observeEvent?.({
      type: "leader.tool_call",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: {
        toolUseId: "read-1",
        toolName: "read_file",
        toolSafety: {
          classification: "read_only",
          readOnly: true,
          planSafe: true,
        },
      },
    });
    await config.observeEvent?.({
      type: "leader.tool_result",
      timestamp: "2026-05-14T00:00:00.000Z",
      data: { toolUseId: "read-1", toolName: "read_file", isError: false },
    });
    return {
      reason: "completed",
      turnCount: 1,
      messages: [
        { type: "user", content: config.initialPrompt },
        {
          type: "assistant",
          content: [{ type: "text", text: "read only done" }],
        },
      ],
    };
  };

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Read README",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("completed");
  expect(result.finalAnswer).not.toContain("Safe Apply review created");

  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  expect(
    await new ExecutionEventRepository().listByTaskIdAndType(
      result.taskId,
      "safe_apply.review_draft_created",
    ),
  ).toHaveLength(0);
  expect(await new ChangeReviewRepository().listByTaskId(result.taskId)).toHaveLength(0);
});

test("leader safe apply required mode fails closed outside git", async () => {
  process.env.MAGISTER_LEADER_SAFE_APPLY_MODE = "required";

  const { processTaskIntent } = await importProcessTaskIntentService();
  const result = await processTaskIntent({
    prompt: "Change README",
    source: "feishu",
    workspaceId: "workspace_main",
  });

  expect(result.reason).toBe("configuration_error");
  expect(result.finalAnswer).toContain("Leader Safe Apply isolation required but not available");
  expect(runtimeCalls).toHaveLength(0);
});
