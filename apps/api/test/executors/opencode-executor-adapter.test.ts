import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalObservabilityAdapter } from "../../src/observability/local-observability-adapter";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";
import { ChannelSessionRepository } from "../../src/repositories/channel-session-repository";
import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import type {
  ExecutorDispatchDependencies,
  ExecutorSlotSnapshot,
} from "../../src/executors/executor-adapter";
import { createOpenCodeExecutorAdapter } from "../../src/executors/opencode-executor-adapter";
import { getExecutorCapabilities } from "../../src/services/executor-capability-service";
import { createFeishuTestHarness } from "../utils/feishu-test-harness";

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

function findRecordedEvent(events: Array<Record<string, unknown>>, type: string) {
  const event = events.find((candidate) => candidate.type === type);
  expect(event).toBeDefined();
  return event as Record<string, unknown>;
}

function expectRecordedEventOrder(events: Array<Record<string, unknown>>, expectedTypes: string[]) {
  let previousIndex = -1;
  for (const type of expectedTypes) {
    const index = events.findIndex((event) => event.type === type);
    expect(index).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

const tempDirs: string[] = [];

function createTempArtifactsRoot() {
  const directory = mkdtempSync(join(tmpdir(), "ultimate-opencode-adapter-"));
  tempDirs.push(directory);
  return directory;
}

// Spec §1.10 (2026-05-17) — sandbox default flipped to `optional`.
// Adapter contract tests assert pre-flip snapshots; pin mode=off at
// the test seam so they keep exercising the unsandboxed CLI path
// they were written against. Individual tests that need `optional`
// override this (see :323).
beforeEach(() => {
  process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "off";
});

afterEach(() => {
  delete process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_NETWORK;
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("opencode executor capability registry declares runtime workspace support without native resume", () => {
  expect(getExecutorCapabilities("opencode")).toEqual({
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  });
});

test("opencode executor adapter runs the local opencode CLI contract and materializes runtime artifacts", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    commandPath: "/opt/homebrew/bin/opencode",
    status: "configured",
    configuredModel: "moonshot/kimi-k2",
    configSource: "file",
    sandboxMode: "workspace-write",
    timeoutMs: 120000,
    notes: "Secondary coding slot for heterogeneous execution.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const invocations: Array<{
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  const result = await createOpenCodeExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout: [
          '{"type":"session.started","session_id":"session_opencode_success_1"}',
          '{"type":"message.completed","message":{"role":"assistant","content":"OpenCode completed the coder run."}}',
        ].join("\n"),
        stderr: "",
        durationMs: 2500,
      };
    },
  }).execute({
    runtime: {
      id: "runtime_opencode_success_1",
      taskId: "task_opencode_success_1",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_with_context",
      priorSessionId: "session_prior_opencode_success_1",
      priorWorkdir: "/tmp/opencode-prior-workdir",
      resumePolicy: "rehydrate_only",
    },
    task: {
      id: "task_opencode_success_1",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Implement the coding slice",
      description: "Ship the next coding slice with explicit rehydration instructions.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-14T06:20:00.000Z"),
    createId: (() => {
      const ids = [
        "opencode-stdout",
        "opencode-stderr",
        "opencode-note",
        "opencode-metadata",
        "opencode-started",
        "opencode-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `opencode-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_opencode_success_1",
    adapterId: "opencode",
    state: "COMPLETED",
    sessionId: "session_opencode_success_1",
    artifactId: "artifact_opencode-note",
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]).toMatchObject({
    command: "/opt/homebrew/bin/opencode",
    env: expect.objectContaining({
      TMPDIR: join(artifactsRoot, "tmp"),
    }),
  });
  expect(invocations[0]?.args).toEqual(
    expect.arrayContaining([
      "run",
      "--format",
      "json",
      "--dir",
      expect.any(String),
      "--model",
      "moonshot/kimi-k2",
    ]),
  );
  expect(invocations[0]?.args.at(-1)).toContain(
    "You are a delegated execution subagent inside Magister.",
  );
  expect(invocations[0]?.args.join(" ")).not.toContain("--session");
  expect(invocations[0]?.args.join(" ")).not.toContain("--continue");
  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.artifactCreates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "artifact_opencode-note",
        artifactType: "execution_note",
        title: "Coder execution note",
        summary: "OpenCode completed the coder run.",
      }),
      expect.objectContaining({
        artifactType: "runtime_context",
        title: "Runtime context document",
      }),
      expect.objectContaining({
        artifactType: "execution_log",
        title: "OpenCode stdout log",
      }),
      expect.objectContaining({
        artifactType: "execution_log",
        title: "OpenCode stderr log",
      }),
      expect.objectContaining({
        artifactType: "execution_metadata",
        title: "OpenCode session metadata",
      }),
      expect.objectContaining({
        artifactType: "runtime_diff",
        title: "Runtime diff",
      }),
      expect.objectContaining({
        artifactType: "static_gate_result",
        title: "Static gate result",
      }),
      expect.objectContaining({
        artifactType: "change_review_draft",
        title: "Change review draft",
      }),
    ]),
  );

  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_opencode-note",
  );
  if (!noteArtifact || typeof noteArtifact.storageRef !== "string") {
    throw new Error("Expected note artifact storageRef");
  }
  expect(readFileSync(noteArtifact.storageRef, "utf8")).toContain(
    "OpenCode completed the coder run.",
  );

  const runtimeContextArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "runtime_context",
  );
  if (!runtimeContextArtifact || typeof runtimeContextArtifact.storageRef !== "string") {
    throw new Error("Expected runtime context artifact storageRef");
  }
  expect(readFileSync(runtimeContextArtifact.storageRef, "utf8")).toContain(
    "\"priorSessionId\": \"session_prior_opencode_success_1\"",
  );

  const metadataArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "execution_metadata",
  );
  if (!metadataArtifact || typeof metadataArtifact.storageRef !== "string") {
    throw new Error("Expected metadata artifact storageRef");
  }
  const metadata = JSON.parse(readFileSync(metadataArtifact.storageRef, "utf8"));
  expect(metadata.runtimeSecurity).toMatchObject({
    runtimeSource: "opencode",
    commandPath: "/opt/homebrew/bin/opencode",
    sandboxMode: "workspace-write",
    permissionMode: "headless",
    runtimeWorkspaceStrategy: "git_worktree",
  });
  expect(metadata.runtimeSecurity.argvFlags).toContain("run");
  expect(JSON.stringify(metadata.runtimeSecurity)).not.toContain(
    "Ship the next coding slice",
  );

  const reviewDraftArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "change_review_draft",
  );
  if (!reviewDraftArtifact || typeof reviewDraftArtifact.storageRef !== "string") {
    throw new Error("Expected review draft artifact storageRef");
  }
  const reviewDraft = JSON.parse(readFileSync(reviewDraftArtifact.storageRef, "utf8"));
  expect(reviewDraft.runtimeSecurity.permissionMode).toBe("headless");
  expect(reviewDraft.gate.risk).toBe("HUMAN_REQUIRED");
  expect(dependencies.events.map((event) => event.type)).toContain(
    "safe_apply.review_draft_created",
  );
});

// 2026-05-23: opencode adapter no longer wraps in Magister's outer bwrap
// (opencode runs its own sandbox; nested bwrap fails to mount tmpfs).
test("opencode executor adapter does NOT wrap in outer bwrap even when optional sandbox is active", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    commandPath: "/opt/homebrew/bin/opencode",
    status: "configured",
    configuredModel: "moonshot/kimi-k2",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Secondary coding slot for heterogeneous execution.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const workspaceDir = join(artifactsRoot, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const bwrapPath = join(artifactsRoot, "bwrap");
  writeFileSync(bwrapPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(bwrapPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${artifactsRoot}:${originalPath ?? ""}`;
  process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "optional";
  process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

  const invocations: Array<{
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  }> = [];

  try {
    const result = await createOpenCodeExecutorAdapter(slot, {
      workspaceDir,
      artifactsRootDir: artifactsRoot,
      runCommand: async (invocation) => {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stdout: [
            '{"type":"session.started","session_id":"session_opencode_bwrap"}',
            '{"type":"message.completed","message":{"role":"assistant","content":"Done"}}',
          ].join("\n"),
          stderr: "",
          durationMs: 120,
        };
      },
    }).execute({
      runtime: {
        id: "runtime_opencode_bwrap",
        taskId: "task_opencode_bwrap",
        roleId: "coder",
        state: "CREATED",
        attemptCount: 0,
        delegationMode: "delegate_with_context",
      },
      task: {
        id: "task_opencode_bwrap",
        workspaceId: "workspace_main",
        state: "IN_PROGRESS",
        title: "Wrap opencode",
        description: "Verify the optional sandbox wrapper.",
      },
      slot,
      dependencies: dependencies.dependencies,
      now: () => new Date("2026-05-14T04:05:00.000Z"),
      createId: (() => {
        const ids = [
          "opencode-bwrap-stdout",
          "opencode-bwrap-stderr",
          "opencode-bwrap-note",
          "opencode-bwrap-metadata",
          "opencode-bwrap-runtime-context",
          "opencode-bwrap-started",
          "opencode-bwrap-completed",
        ];
        let index = 0;
        return () => ids[index++] ?? `opencode-bwrap-extra-${index}`;
      })(),
    });

    expect(result.ok).toBe(true);
    expect(invocations).toHaveLength(1);
    // Crucial inverted assertion: command is opencode directly, NOT bwrap.
    expect(invocations[0]?.command).toBe("/opt/homebrew/bin/opencode");
    expect(invocations[0]?.args).not.toContain("--");

    const metadataArtifact = dependencies.artifactCreates.find(
      (artifact) => artifact.artifactType === "execution_metadata",
    );
    if (!metadataArtifact || typeof metadataArtifact.storageRef !== "string") {
      throw new Error("Expected metadata artifact storageRef");
    }
    const metadata = JSON.parse(readFileSync(metadataArtifact.storageRef, "utf8"));
    expect(metadata.runtimeSecurity).toMatchObject({
      runtimeSource: "opencode",
      commandPath: "/opt/homebrew/bin/opencode",
      executionSandbox: {
        mode: "off",
        status: "disabled",
        reason: "mode_off",
      },
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("opencode executor adapter records first-class tool events from explicit stdout JSONL lines", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    commandPath: "/opt/homebrew/bin/opencode",
    status: "configured",
    configuredModel: "moonshot/kimi-k2",
    configSource: "file",
    sandboxMode: "workspace-write",
    timeoutMs: 120000,
    notes: "Secondary coding slot for heterogeneous execution.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();

  const result = await createOpenCodeExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    runCommand: async () => ({
      exitCode: 0,
      stdout: [
        '{"type":"session.started","session_id":"session_opencode_tools_1"}',
        '{"type":"tool.started","tool":{"name":"read_file","arguments":{"path":"src/index.ts"}}}',
        '{"type":"tool.completed","tool":{"name":"read_file","arguments":{"path":"src/index.ts"}},"result":{"lines":132}}',
        '{"type":"message.completed","message":{"role":"assistant","content":"OpenCode completed the coder run."}}',
      ].join("\n"),
      stderr: "",
      durationMs: 2500,
    }),
  }).execute({
    runtime: {
      id: "runtime_opencode_tools_1",
      taskId: "task_opencode_tools_1",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_opencode_tools_1",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      source: "web",
      title: "Inspect a file with OpenCode",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-17T08:00:00.000Z"),
    createId: (() => {
      const ids = [
        "opencode-tools-stdout",
        "opencode-tools-stderr",
        "opencode-tools-note",
        "opencode-tools-metadata",
        "opencode-tools-started",
        "opencode-tools-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `opencode-tools-extra-${index}`;
    })(),
  });

  expect(result.ok).toBe(true);
  expectRecordedEventOrder(dependencies.events, [
    "executor_session.started",
    "tool.call",
    "tool.result",
    "safe_apply.review_draft_created",
    "executor_session.completed",
  ]);

  const toolCallPayload = JSON.parse(
    String((findRecordedEvent(dependencies.events, "tool.call") as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(toolCallPayload).toMatchObject({
    toolName: "read_file",
    arguments: {
      path: "src/index.ts",
    },
  });

  const toolResultPayload = JSON.parse(
    String((findRecordedEvent(dependencies.events, "tool.result") as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(toolResultPayload).toMatchObject({
    toolName: "read_file",
    result: {
      lines: 132,
    },
  });
});

test("opencode executor adapter queues runtime_trace tool events for feishu tasks when verbose is enabled", async () => {
  const harness = createFeishuTestHarness({
    name: "opencode-feishu-tool-runtime-trace",
  });
  const slot: ExecutorSlotSnapshot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    commandPath: "/opt/homebrew/bin/opencode",
    status: "configured",
    configuredModel: "moonshot/kimi-k2",
    configSource: "file",
    sandboxMode: "workspace-write",
    timeoutMs: 120000,
    notes: "Secondary coding slot for heterogeneous execution.",
  };
  const artifactsRoot = createTempArtifactsRoot();
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const channelSessionRepository = new ChannelSessionRepository();
  const now = new Date("2026-04-17T08:20:00.000Z");

  try {
    await conversationBindingRepository.create({
      id: "feishu:tenant_alpha:oc_chat_opencode_tool_trace",
      channel: "feishu",
      accountId: "tenant_alpha",
      chatId: "oc_chat_opencode_tool_trace",
      workspaceId: "workspace_main",
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
    });
    await channelSessionRepository.create({
      id: "feishu:tenant_alpha:oc_chat_opencode_tool_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_opencode_tool_trace",
      channel: "feishu",
      workspaceId: "workspace_main",
      continuityMode: "reply_preferred",
      verboseLevel: "on",
      createdAt: now,
      updatedAt: now,
    });
    await taskRepository.create({
      id: "task_opencode_feishu_tools_1",
      workspaceId: "workspace_main",
      source: "feishu",
      title: "Inspect a file with OpenCode",
      state: "IN_PROGRESS",
      rootChannelBindingId: "feishu:tenant_alpha:oc_chat_opencode_tool_trace",
      createdAt: now,
      updatedAt: now,
    });
    await roleRuntimeRepository.create({
      id: "runtime_opencode_feishu_tools_1",
      taskId: "task_opencode_feishu_tools_1",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
      updatedAt: now,
    });

    const dependencies: ExecutorDispatchDependencies = {
      roleRuntimeRepository,
      taskRepository,
      artifactRepository,
      observabilityAdapter: new LocalObservabilityAdapter(),
    };

    const result = await createOpenCodeExecutorAdapter(slot, {
      artifactsRootDir: artifactsRoot,
      runCommand: async () => ({
        exitCode: 0,
        stdout: [
          '{"type":"session.started","session_id":"session_opencode_feishu_tools_1"}',
          '{"type":"tool.started","tool":{"name":"read_file","arguments":{"path":"src/index.ts"}}}',
          '{"type":"tool.completed","tool":{"name":"read_file","arguments":{"path":"src/index.ts"}},"result":{"lines":132}}',
          '{"type":"message.completed","message":{"role":"assistant","content":"OpenCode completed the coder run."}}',
        ].join("\n"),
        stderr: "",
        durationMs: 2500,
      }),
    }).execute({
      runtime: {
        id: "runtime_opencode_feishu_tools_1",
        taskId: "task_opencode_feishu_tools_1",
        roleId: "coder",
        state: "CREATED",
        attemptCount: 0,
        delegationMode: "delegate_fresh",
      },
      task: {
        id: "task_opencode_feishu_tools_1",
        workspaceId: "workspace_main",
        state: "IN_PROGRESS",
        source: "feishu",
        rootChannelBindingId: "feishu:tenant_alpha:oc_chat_opencode_tool_trace",
        title: "Inspect a file with OpenCode",
      },
      slot,
      dependencies,
      now: () => now,
      createId: (() => {
        const ids = [
          "opencode-feishu-stdout",
          "opencode-feishu-stderr",
          "opencode-feishu-note",
          "opencode-feishu-metadata",
          "opencode-feishu-started",
          "opencode-feishu-completed",
        ];
        let index = 0;
        return () => ids[index++] ?? `opencode-feishu-extra-${index}`;
      })(),
    });

    expect(result.ok).toBe(true);

    const events = await executionEventRepository.listByTaskId("task_opencode_feishu_tools_1");
    const outboundQueuedPayloads = events
      .filter((event) => event.type === "channel.outbound.queued")
      .map((event) => JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>);

    expect(outboundQueuedPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_trace",
          eventType: "tool.call",
          summary: "Tool call: read_file",
        }),
        expect.objectContaining({
          kind: "runtime_trace",
          eventType: "tool.result",
          summary: "Tool result: read_file",
        }),
      ]),
    );
  } finally {
    harness.cleanup();
  }
});

test("opencode executor adapter classifies unavailable CLI invocations", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "opencode",
    displayName: "OpenCode",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder"],
    configKey: "MAGISTER_MODEL_OPENCODE",
    executionMode: "cli",
    commandPath: "/opt/homebrew/bin/opencode",
    status: "configured",
    configuredModel: "moonshot/kimi-k2",
    configSource: "file",
    sandboxMode: "workspace-write",
    timeoutMs: 120000,
    notes: "Secondary coding slot for heterogeneous execution.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  let createIdCounter = 0;

  const result = await createOpenCodeExecutorAdapter(slot, {
    artifactsRootDir: artifactsRoot,
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "spawn opencode ENOENT",
      durationMs: 10,
      invocationError: "spawn opencode ENOENT",
    }),
  }).execute({
    runtime: {
      id: "runtime_opencode_unavailable_1",
      taskId: "task_opencode_unavailable_1",
      roleId: "architect",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_opencode_unavailable_1",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Design the next slice",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-14T06:25:00.000Z"),
    createId: () => `opencode-unavailable-${++createIdCounter}`,
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_opencode_unavailable_1",
    adapterId: "opencode",
    state: "FAILED",
    code: "executor_unavailable",
    message: "OpenCode CLI is unavailable while dispatching the architect run",
  });
});
