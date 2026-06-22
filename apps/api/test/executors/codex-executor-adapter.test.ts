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
import type { ExecutorDispatchDependencies, ExecutorSlotSnapshot } from "../../src/executors/executor-adapter";
import { createCodexExecutorAdapter } from "../../src/executors/codex-executor-adapter";
import { getExecutorCapabilities } from "../../src/services/executor-capability-service";
import { createFeishuTestHarness } from "../utils/feishu-test-harness";

const DEFAULT_LONG_RUNNING_TIMEOUT_MS = 7_200_000;
const TEST_WORKSPACE_DIR = join(tmpdir(), "ultimate-codex-workspace");
mkdirSync(TEST_WORKSPACE_DIR, { recursive: true });

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
  const directory = mkdtempSync(join(tmpdir(), "ultimate-codex-adapter-"));
  tempDirs.push(directory);
  return directory;
}

// Spec §1.10 (2026-05-17) — sandbox default flipped to `optional`.
// Adapter contract tests assert pre-flip snapshots; pin mode=off
// at the test seam so they keep exercising the unsandboxed CLI
// path they were written against. Individual tests that need
// `optional` (codex-executor-adapter.test.ts:426) override this.
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

test("codex executor capability registry declares native resume support", () => {
  expect(getExecutorCapabilities("codex")).toEqual({
    nativeResume: true,
    runtimeWorkspace: true,
    runtimeContract: true,
  });
  expect(getExecutorCapabilities("qoder")).toEqual({
    nativeResume: false,
    runtimeWorkspace: true,
    runtimeContract: true,
  });
});

test("codex executor adapter runs the local codex CLI contract and materializes stdout/stderr artifacts", async () => {
  const workspaceDir = TEST_WORKSPACE_DIR;
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "danger-full-access",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const invocations: Array<{
    command: string;
    args: string[];
    prompt: string;
    cwd: string;
    outputPath: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const codexLastMessage = "Objective\n- Finish the coder task\n\nOutcome\n- Delivered the first slice.";

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout:
          '{"type":"agent_message_delta","delta":"Planning..."}\n{"type":"agent_message","message":"Done"}\n',
        stderr: "warning: sandbox fallback not needed\n",
        lastMessage: codexLastMessage,
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_success",
      taskId: "task_codex_success",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 1,
      delegationMode: "delegate_with_context",
    },
    task: {
      id: "task_codex_success",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Build the first slice",
      description: "Create a concise implementation plan for the operator console and call out blockers.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:20:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-session",
        "codex-stdout",
        "codex-stderr",
        "codex-note",
        "codex-metadata",
        "codex-started",
        "codex-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_codex_success",
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: "session_codex-session",
    artifactId: "artifact_codex-note",
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]).toMatchObject({
    command: "/opt/homebrew/bin/codex",
    cwd: TEST_WORKSPACE_DIR,
    timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
    env: expect.objectContaining({
      CODEX_HOME: codexHome,
      HOME: codexHome,
      TMPDIR: join(artifactsRoot, "tmp"),
    }),
  });
  expect(invocations[0]?.args).toEqual(
    expect.arrayContaining([
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.3-codex",
      "--output-last-message",
      invocations[0]?.outputPath ?? "",
      "--json",
      "--color",
      "never",
    ]),
  );
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["--ephemeral"]));
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["--full-auto"]));
  expect(invocations[0]?.prompt).toContain("Role: coder");
  expect(invocations[0]?.prompt).toContain("Task Title:");
  expect(invocations[0]?.prompt).toContain("Delegation Mode: handoff");
  expect(invocations[0]?.prompt).toContain(
    "You are continuing a task-manager handoff.",
  );
  expect(invocations[0]?.prompt).toContain(
    "Task Description: Create a concise implementation plan for the operator console and call out blockers.",
  );
  expect(invocations[0]?.prompt).toContain(
    "- Do not treat bootstrap, environment checks, or session setup as task completion.",
  );
  expect(invocations[0]?.prompt).toContain(
    "Before acting, read the run contract at `.magister/runtime-contracts/runtime_codex_success/AGENTS.md`.",
  );
  expect(invocations[0]?.prompt).toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(invocations[0]?.prompt).toContain("Return sections exactly");

  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.taskUpdates[0]).toMatchObject({
    id: "task_codex_success",
    input: expect.objectContaining({
      state: "IN_PROGRESS",
    }),
  });
  expect(dependencies.artifactCreates).toHaveLength(8);
  expect(dependencies.artifactCreates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "artifact_codex-stdout",
        artifactType: "execution_log",
        title: "Codex stdout log",
        storageKind: "file",
        summary: "Captured Codex stdout for the coder run",
      }),
      expect.objectContaining({
        id: "artifact_codex-stderr",
        artifactType: "execution_log",
        title: "Codex stderr log",
        storageKind: "file",
        summary: "Captured Codex stderr for the coder run",
      }),
      expect.objectContaining({
        id: "artifact_codex-note",
        artifactType: "execution_note",
        title: "Coder execution note",
        storageKind: "file",
        summary: "Objective - Finish the coder task Outcome - Delivered the first slice.",
      }),
      expect.objectContaining({
        id: "artifact_codex-metadata",
        artifactType: "execution_metadata",
        title: "Codex session metadata",
        storageKind: "file",
        summary: "Captured Codex session metadata for the coder run",
      }),
      expect.objectContaining({
        artifactType: "runtime_context",
        title: "Runtime context document",
        storageKind: "file",
        summary: "Captured runtime context document for the coder run",
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
  // Event COUNT is intentionally not asserted: safe_apply.change_review_created
  // fires when the change-review row doesn't already exist (i.e. against a clean
  // change-review DB, as on CI), so the exact count is environment-dependent.
  // expectRecordedEventOrder below verifies the required events in order — the
  // same pattern the other adapter tests in this file use.
  expectRecordedEventOrder(dependencies.events, [
    "executor_session.started",
    "safe_apply.review_draft_created",
    "executor_session.completed",
  ]);
  const startedEvent = findRecordedEvent(dependencies.events, "executor_session.started");
  const reviewDraftEvent = findRecordedEvent(dependencies.events, "safe_apply.review_draft_created");
  const completedEvent = findRecordedEvent(dependencies.events, "executor_session.completed");
  expect(startedEvent).toMatchObject({
    type: "executor_session.started",
    executorSessionId: "session_codex-session",
  });
  expect(reviewDraftEvent).toMatchObject({
    type: "safe_apply.review_draft_created",
    taskId: "task_codex_success",
    roleRuntimeId: "runtime_codex_success",
    workspaceId: "workspace_main",
  });
  expect(completedEvent).toMatchObject({
    type: "executor_session.completed",
    executorSessionId: "session_codex-session",
    artifactId: "artifact_codex-note",
  });

  const startedPayload = JSON.parse(
    String((startedEvent as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  const completedPayload = JSON.parse(
    String((completedEvent as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(startedPayload.command).toContain("codex exec");
  expect(startedPayload.authMode).toBe("chatgpt");
  expect(startedPayload.configuredModel).toBe("gpt-5.3-codex");
  expect(startedPayload.artifactsRootDir).toBe(artifactsRoot);
  expect(startedPayload.runtimeSecurity).toMatchObject({
    runtimeSource: "codex",
    sandboxMode: "danger-full-access",
    permissionMode: "bypassed",
    runtimeWorkspaceStrategy: "workspace_root",
  });
  expect(completedPayload.stdoutPreview).toContain("agent_message_delta");
  expect(completedPayload.stderrPreview).toContain("warning:");
  expect(completedPayload.message).toContain("Delivered the first slice");
  expect(completedPayload.lastMessage).toBe(codexLastMessage);
  expect(Number(completedPayload.durationMs)).toBeGreaterThanOrEqual(0);

  const stdoutArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_codex-stdout",
  );
  const stderrArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_codex-stderr",
  );
  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_codex-note",
  );
  const metadataArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_codex-metadata",
  );
  const reviewDraftArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "change_review_draft",
  );

  expect(stdoutArtifact).toBeTruthy();
  expect(stderrArtifact).toBeTruthy();
  expect(noteArtifact).toBeTruthy();
  expect(metadataArtifact).toBeTruthy();
  expect(reviewDraftArtifact).toBeTruthy();
  expect(readFileSync(String(stdoutArtifact?.storageRef), "utf8")).toContain("agent_message");
  expect(readFileSync(String(stderrArtifact?.storageRef), "utf8")).toContain("sandbox fallback");
  expect(readFileSync(String(noteArtifact?.storageRef), "utf8")).toContain("Delivered the first slice");
  const runtimeContextArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.artifactType === "runtime_context",
  );
  expect(runtimeContextArtifact).toBeTruthy();
  expect(readFileSync(String(runtimeContextArtifact?.storageRef), "utf8")).toContain('"task"');
  expect(readFileSync(String(runtimeContextArtifact?.storageRef), "utf8")).toContain('"continuity"');
  expect(
    readFileSync(
      join(workspaceDir, ".magister", "runtime-contracts", "runtime_codex_success", "AGENTS.md"),
      "utf8",
    ),
  ).toContain("Magister Runtime Contract");
  expect(
    readFileSync(
      join(workspaceDir, ".magister", "runtime-contracts", "runtime_codex_success", "AGENTS.md"),
      "utf8",
    ),
  ).toContain("Runtime Context");
  const metadata = JSON.parse(readFileSync(String(metadataArtifact?.storageRef), "utf8"));
  expect(metadata).toMatchObject({
    adapterId: "codex",
    authMode: "chatgpt",
    configuredModel: "gpt-5.3-codex",
    sandboxMode: "danger-full-access",
    timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
    workspaceDir: TEST_WORKSPACE_DIR,
    roleId: "coder",
    runtimeSecurity: {
      runtimeSource: "codex",
      commandPath: "/opt/homebrew/bin/codex",
      sandboxMode: "danger-full-access",
      permissionMode: "bypassed",
      runtimeWorkspaceStrategy: "workspace_root",
    },
  });
  expect(metadata.runtimeSecurity.argvFlags).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(JSON.stringify(metadata.runtimeSecurity)).not.toContain("Task Description");
  const reviewDraft = JSON.parse(readFileSync(String(reviewDraftArtifact?.storageRef), "utf8"));
  expect(reviewDraft.runtimeSecurity.permissionMode).toBe("bypassed");
  expect(reviewDraft.gate.risk).toBe("HUMAN_REQUIRED");
});

// 2026-05-23: codex adapter no longer wraps in Magister's outer bwrap
// — codex runs its own inner sandbox via `--sandbox workspace-write`
// and the two-layer wrap fails with "Failed to mount tmpfs". The
// executionSandbox metadata recorded reflects mode="off" / disabled.
test("codex executor adapter does NOT wrap in outer bwrap even when optional sandbox is active", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["coder"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for coding work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
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
    const result = await createCodexExecutorAdapter(slot, {
      workspaceDir: TEST_WORKSPACE_DIR,
      artifactsRootDir: artifactsRoot,
      codexHomeDir: codexHome,
      runCommand: async (invocation) => {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stdout: '{"type":"agent_message","message":"Done"}\n',
          stderr: "",
          lastMessage: "Done",
        };
      },
    }).execute({
      runtime: {
        id: "runtime_codex_bwrap",
        taskId: "task_codex_bwrap",
        roleId: "coder",
        state: "CREATED",
        attemptCount: 0,
        delegationMode: "delegate_with_context",
      },
      task: {
        id: "task_codex_bwrap",
        workspaceId: "workspace_main",
        state: "IN_PROGRESS",
        title: "Wrap codex",
        description: "Verify the optional sandbox wrapper.",
      },
      slot,
      dependencies: dependencies.dependencies,
      now: () => new Date("2026-05-14T04:00:00.000Z"),
      createId: (() => {
        const ids = [
          "codex-bwrap-session",
          "codex-bwrap-stdout",
          "codex-bwrap-stderr",
          "codex-bwrap-note",
          "codex-bwrap-metadata",
          "codex-bwrap-runtime-context",
          "codex-bwrap-started",
          "codex-bwrap-completed",
        ];
        let index = 0;
        return () => ids[index++] ?? `codex-bwrap-extra-${index}`;
      })(),
    });

    expect(result.ok).toBe(true);
    expect(invocations).toHaveLength(1);
    // Crucial inverted assertion: command is the codex binary directly,
    // NOT bwrap. No outer wrap; the codex CLI runs its own sandbox.
    expect(invocations[0]?.command).toBe("/opt/homebrew/bin/codex");
    expect(invocations[0]?.args).not.toContain("--");

    const metadataArtifact = dependencies.artifactCreates.find(
      (artifact) => artifact.artifactType === "execution_metadata",
    );
    if (!metadataArtifact || typeof metadataArtifact.storageRef !== "string") {
      throw new Error("Expected metadata artifact storageRef");
    }
    const metadata = JSON.parse(readFileSync(metadataArtifact.storageRef, "utf8"));
    expect(metadata.runtimeSecurity).toMatchObject({
      runtimeSource: "codex",
      commandPath: "/opt/homebrew/bin/codex",
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

test("codex executor adapter records first-class tool events from explicit stdout JSONL lines", async () => {
  const workspaceDir = TEST_WORKSPACE_DIR;
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "danger-full-access",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => ({
      exitCode: 0,
      stdout: [
        '{"type":"session.started","session_id":"session_codex_tools_1"}',
        '{"type":"tool.started","tool":{"name":"search_code","arguments":{"query":"TODO"}}}',
        '{"type":"tool.completed","tool":{"name":"search_code","arguments":{"query":"TODO"}},"result":{"matches":3}}',
      ].join("\n"),
      stderr: "",
      lastMessage: "Objective\n- Search the codebase\n\nOutcome\n- Found the relevant matches.",
      durationMs: 1200,
    }),
  }).execute({
    runtime: {
      id: "runtime_codex_tools_1",
      taskId: "task_codex_tools_1",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_tools_1",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      source: "web",
      title: "Search the codebase with Codex",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-17T08:05:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-tools-stdout",
        "codex-tools-stderr",
        "codex-tools-note",
        "codex-tools-metadata",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-tools-extra-${index}`;
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
    toolName: "search_code",
    arguments: {
      query: "TODO",
    },
  });

  const toolResultPayload = JSON.parse(
    String((findRecordedEvent(dependencies.events, "tool.result") as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(toolResultPayload).toMatchObject({
    toolName: "search_code",
    result: {
      matches: 3,
    },
  });
});

test("codex executor adapter queues runtime_trace tool events for feishu tasks when verbose is enabled", async () => {
  const harness = createFeishuTestHarness({
    name: "codex-feishu-tool-runtime-trace",
  });
  const workspaceDir = TEST_WORKSPACE_DIR;
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "danger-full-access",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const taskRepository = new TaskRepository();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const artifactRepository = new ArtifactRepository();
  const executionEventRepository = new ExecutionEventRepository();
  const conversationBindingRepository = new ConversationBindingRepository();
  const channelSessionRepository = new ChannelSessionRepository();
  const now = new Date("2026-04-17T08:30:00.000Z");

  try {
    await conversationBindingRepository.create({
      id: "feishu:tenant_alpha:oc_chat_codex_tool_trace",
      channel: "feishu",
      accountId: "tenant_alpha",
      chatId: "oc_chat_codex_tool_trace",
      workspaceId: "workspace_main",
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
    });
    await channelSessionRepository.create({
      id: "feishu:tenant_alpha:oc_chat_codex_tool_trace",
      bindingId: "feishu:tenant_alpha:oc_chat_codex_tool_trace",
      channel: "feishu",
      workspaceId: "workspace_main",
      continuityMode: "reply_preferred",
      verboseLevel: "on",
      createdAt: now,
      updatedAt: now,
    });
    await taskRepository.create({
      id: "task_codex_feishu_tools_1",
      workspaceId: "workspace_main",
      source: "feishu",
      title: "Search the codebase with Codex",
      state: "IN_PROGRESS",
      rootChannelBindingId: "feishu:tenant_alpha:oc_chat_codex_tool_trace",
      createdAt: now,
      updatedAt: now,
    });
    await roleRuntimeRepository.create({
      id: "runtime_codex_feishu_tools_1",
      taskId: "task_codex_feishu_tools_1",
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

    const result = await createCodexExecutorAdapter(slot, {
      workspaceDir,
      artifactsRootDir: artifactsRoot,
      codexHomeDir: codexHome,
      runCommand: async () => ({
        exitCode: 0,
        stdout: [
          '{"type":"session.started","session_id":"session_codex_feishu_tools_1"}',
          '{"type":"tool.started","tool":{"name":"search_code","arguments":{"query":"TODO"}}}',
          '{"type":"tool.completed","tool":{"name":"search_code","arguments":{"query":"TODO"}},"result":{"matches":3}}',
        ].join("\n"),
        stderr: "",
        lastMessage: "Objective\n- Search the codebase\n\nOutcome\n- Found the relevant matches.",
        durationMs: 1200,
      }),
    }).execute({
      runtime: {
        id: "runtime_codex_feishu_tools_1",
        taskId: "task_codex_feishu_tools_1",
        roleId: "coder",
        state: "CREATED",
        attemptCount: 0,
        delegationMode: "delegate_fresh",
      },
      task: {
        id: "task_codex_feishu_tools_1",
        workspaceId: "workspace_main",
        state: "IN_PROGRESS",
        source: "feishu",
        rootChannelBindingId: "feishu:tenant_alpha:oc_chat_codex_tool_trace",
        title: "Search the codebase with Codex",
      },
      slot,
      dependencies,
      now: () => now,
      createId: (() => {
        const ids = [
          "codex-feishu-stdout",
          "codex-feishu-stderr",
          "codex-feishu-note",
          "codex-feishu-metadata",
        ];
        let index = 0;
        return () => ids[index++] ?? `codex-feishu-extra-${index}`;
      })(),
    });

    expect(result.ok).toBe(true);

    const events = await executionEventRepository.listByTaskId("task_codex_feishu_tools_1");
    const outboundQueuedPayloads = events
      .filter((event) => event.type === "channel.outbound.queued")
      .map((event) => JSON.parse(String(event.payloadJson ?? "{}")) as Record<string, unknown>);

    expect(outboundQueuedPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime_trace",
          eventType: "tool.call",
          summary: "Tool call: search_code",
        }),
        expect.objectContaining({
          kind: "runtime_trace",
          eventType: "tool.result",
          summary: "Tool result: search_code",
        }),
      ]),
    );
  } finally {
    harness.cleanup();
  }
});

test("codex executor adapter uses a dedicated manager prompt path while worker roles keep execution-oriented guidance", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const invocations: Array<{
    command: string;
    args: string[];
    prompt: string;
    cwd: string;
    outputPath: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout: '{"type":"thread.started","thread_id":"thread_manager_prompt_1"}\n{"type":"agent_message","message":"Decision made."}',
        stderr: "",
        lastMessage:
          '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"Manager decision ready.","confidence":"high","childWorkItems":[],"waitingFor":null,"nextWakeupAt":null,"warnings":[]}',
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_manager_prompt",
      taskId: "task_codex_manager_prompt",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_manager_prompt",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Decide the next move",
      description: "Make a structured orchestration decision for the task manager lane.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:22:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-manager-prompt-session",
        "codex-manager-prompt-stdout",
        "codex-manager-prompt-stderr",
        "codex-manager-prompt-note",
        "codex-manager-prompt-metadata",
        "codex-manager-prompt-started",
        "codex-manager-prompt-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-manager-prompt-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_codex_manager_prompt",
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: "thread_manager_prompt_1",
    artifactId: "artifact_codex-manager-prompt-note",
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.prompt).toContain("You are the leader agent for Magister.");
  expect(invocations[0]?.prompt).toContain(
    "- You are the primary semantic runtime for this task. Downstream coding or review work should be treated as delegated subagent execution.",
  );
  expect(invocations[0]?.prompt).toContain("Role: leader");
  expect(invocations[0]?.prompt).toContain(
    "- Answer the user directly when possible; do not delegate work that you can resolve without spawning child work items.",
  );
  expect(invocations[0]?.prompt).toContain(
    "- Treat child run results as internal orchestration signals, not as final user-visible answers.",
  );
  expect(invocations[0]?.prompt).not.toContain("prior lane");
  expect(invocations[0]?.prompt).toContain(
    '- Set "executionMode" to "immediate", "bounded_execution", or "long_running" based on whether the task should finish now, run in one bounded orchestration burst, or continue durably across waits and future wakeups.',
  );
  expect(invocations[0]?.prompt).toContain(
    '- Set "taskType" to one of: "conversation", "coding", "mixed", "clarify", "wait".',
  );
  expect(invocations[0]?.prompt).toContain(
    '- Set "decision" to one of: "direct_answer", "ask_user", "spawn_work_items", "sleep_until".',
  );
  expect(invocations[0]?.prompt).toContain(
    "- Do not use `use_skill`; answer directly, ask the user, delegate downstream work, or wait.",
  );
  expect(invocations[0]?.prompt).toContain(
    '- For "direct_answer" and "ask_user", set executionMode to "immediate", include a non-empty reply, and do not include childWorkItems, nextWakeupAt, or downstream execution.',
  );
  expect(invocations[0]?.prompt).toContain(
    '- For "spawn_work_items", set executionMode to "bounded_execution" or "long_running", include one or more childWorkItems, and ensure the output remains valid JSON.',
  );
  expect(invocations[0]?.prompt).toContain(
    '- For "sleep_until", set executionMode to "long_running", include nextWakeupAt and optional waitingFor, and do not include reply or childWorkItems.',
  );
  expect(invocations[0]?.prompt).toContain("Current Wall Clock:");
  expect(invocations[0]?.prompt ?? "").toMatch(
    /Current Wall Clock: 2026-04-11 10:22:00 UTC[+-]\d{2}:\d{2} \([^)]+\)/,
  );
  expect(invocations[0]?.prompt).toContain("Manager loop mode:");
  expect(invocations[0]?.prompt).toContain(
    'Return one next action JSON object only. Allowed kinds: "respond", "ask_user", "call_tool", "delegate_subagent", "wait".',
  );
  expect(invocations[0]?.prompt).toContain(
    '- For "call_tool", use only registered base tools and provide arguments.',
  );
  expect(invocations[0]?.prompt).toContain(
    '- For "delegate_subagent", use only registered subagent types and canonical fields.',
  );
  expect(invocations[0]?.prompt).toContain("tool observations:");
  expect(invocations[0]?.prompt).toContain(
    'Convert terminal "respond"/"ask_user"/"delegate_subagent"/"wait" actions into canonical ManagerDecision JSON output.',
  );
  expect(invocations[0]?.prompt).toContain("Terminal manager actions:");
  expect(invocations[0]?.prompt).toContain("ask_user_question");
  expect(invocations[0]?.prompt).toContain("Base tools:");
  expect(invocations[0]?.prompt).toContain(
    "For local workspace facts such as current directory, visible files, repository layout, or file contents, prefer base tools over unsupported guesswork.",
  );
  expect(invocations[0]?.prompt).toContain(
    "Before answering local workspace facts such as current directory, visible files, repository layout, or file contents, you must call the relevant base tool first.",
  );
  expect(invocations[0]?.prompt).toContain(
    "For weather and air-quality questions, never infer the user's city or location from timezone, locale, IP, workspace, or prior unrelated context.",
  );
  expect(invocations[0]?.prompt).toContain(
    "If a weather or air-quality question does not include a resolvable city or location, ask the user for it instead of guessing.",
  );
  expect(invocations[0]?.prompt).toContain(
    "- Do not treat bootstrap, environment checks, or session setup as task completion.",
  );
  expect(invocations[0]?.prompt).not.toContain(
    "- After satisfying workspace bootstrap requirements, continue with the actual task request.",
  );
  expect(invocations[0]?.prompt).toContain(
    "- If the JSON would violate the ManagerDecision contract, repair it before replying and still return one JSON object only.",
  );
  expect(invocations[0]?.prompt).toContain(
    "- Do not use legacy childWorkItem fields like delegateAgent, taskDescription, description, action, details, or expectedOutput.",
  );
  expect(invocations[0]?.prompt).not.toContain("Return sections exactly:\nObjective\nActions\nOutcome");
  expect(invocations[0]?.prompt).toContain(
    "Do not emit markdown sections, XML tags, or tool-call wrappers.",
  );
  expect(invocations[0]?.prompt).toContain(
    "Return only a single valid JSON object with these top-level fields:",
  );
  expect(invocations[0]?.prompt).toContain(
    "taskType, executionMode, decision, reply, confidence, childWorkItems, waitingFor, nextWakeupAt, warnings",
  );
  expect(invocations[0]?.prompt).not.toContain(
    "Return only a single valid JSON object that matches the ManagerDecision contract.",
  );
  expect(invocations[0]?.prompt).not.toContain("Before acting, read the run contract");
  expect(invocations[0]?.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(invocations[0]?.prompt).toContain("Delegation Mode: assign");
  expect(invocations[0]?.prompt).toContain(
    "You are handling a fresh assignment. Interpret the request, decide the next system action, and avoid unnecessary delegation.",
  );
  expect(invocations[0]?.prompt).not.toContain("Prefer deterministic edits and concise execution notes.");
  expect(
    dependencies.artifactCreates.some((artifact) => artifact.artifactType === "runtime_context"),
  ).toBe(false);

  const workerResult = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: createTempArtifactsRoot(),
    codexHomeDir: join(createTempArtifactsRoot(), "codex-home-worker"),
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout: '{"type":"thread.started","thread_id":"thread_worker_prompt_1"}\n{"type":"agent_message","message":"Worker completed."}',
        stderr: "",
        lastMessage: "Objective\n- Finish the worker task\n\nActions\n- Executed the requested changes.\n\nOutcome\n- Delivered.",
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_worker_prompt",
      taskId: "task_codex_worker_prompt",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_worker_prompt",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Implement the requested changes",
      description: "Carry out the execution-oriented worker task.",
    },
    slot,
    dependencies: createFakeDependencies().dependencies,
    now: () => new Date("2026-04-11T10:23:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-worker-prompt-session",
        "codex-worker-prompt-stdout",
        "codex-worker-prompt-stderr",
        "codex-worker-prompt-note",
        "codex-worker-prompt-metadata",
        "codex-worker-prompt-started",
        "codex-worker-prompt-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-worker-prompt-extra-${index}`;
    })(),
  });

  expect(workerResult).toMatchObject({
    ok: true,
    state: "COMPLETED",
    adapterId: "codex",
  });
  expect(invocations).toHaveLength(2);
  expect(invocations[1]?.prompt).toContain("Role: coder");
  expect(invocations[1]?.prompt).toContain("You are Codex running inside Magister.");
  expect(invocations[1]?.prompt).toContain(
    "You are a delegated execution subagent inside Magister.",
  );
  expect(invocations[1]?.prompt).toContain("Return sections exactly");
  expect(invocations[1]?.prompt).toContain("Prefer deterministic edits and concise execution notes.");
});

test("codex manager loop executes a base tool before returning a terminal manager decision", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home-manager-loop");
  const invocations: string[] = [];

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation.prompt);
      if (invocations.length === 1) {
        return {
          exitCode: 0,
          stdout:
            '{"type":"thread.started","thread_id":"thread_manager_loop_1"}\n{"type":"agent_message","message":"Calling time_now."}',
          stderr: "",
          lastMessage: '{"kind":"call_tool","toolName":"time_now","arguments":{}}',
        };
      }

      return {
        exitCode: 0,
        stdout:
          '{"type":"thread.started","thread_id":"thread_manager_loop_2"}\n{"type":"agent_message","message":"Responding after the observation."}',
        stderr: "",
        lastMessage:
          '{"kind":"respond","reply":"现在是 2026-04-11 10:22:00，已根据当前系统时间回答。"}',
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_manager_loop",
      taskId: "task_codex_manager_loop",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_manager_loop",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "现在几点了",
      description: "Answer the current time without spawning a coding lane.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:22:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-manager-loop-session",
        "codex-manager-loop-stdout",
        "codex-manager-loop-stderr",
        "codex-manager-loop-note",
        "codex-manager-loop-metadata",
        "codex-manager-loop-started",
        "codex-manager-loop-tool-call",
        "codex-manager-loop-tool-result",
        "codex-manager-loop-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-manager-loop-extra-${index}`;
    })(),
  });

  expect(result).toMatchObject({
    ok: true,
    state: "COMPLETED",
    adapterId: "codex",
  });
  expect(invocations).toHaveLength(2);
  expect(invocations[0]).toContain("Manager loop mode:");
  expect(invocations[1]).toContain("tool observations:");
  expect(invocations[1]).toContain("time_now | ok=true |");

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
    toolName: "time_now",
    arguments: {},
  });

  const toolResultPayload = JSON.parse(
    String((findRecordedEvent(dependencies.events, "tool.result") as { payloadJson: string }).payloadJson),
  ) as Record<string, unknown>;
  expect(toolResultPayload).toMatchObject({
    toolName: "time_now",
  });
});

test("codex manager conversational turns skip default runtime contract hydration", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const invocations: Array<{
    command: string;
    args: string[];
    prompt: string;
    cwd: string;
    outputPath: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout: '{"type":"thread.started","thread_id":"thread_manager_conversation_1"}\n{"type":"agent_message","message":"Decision made."}',
        stderr: "",
        lastMessage:
          '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"你好，我是 Magister。","confidence":0.99,"childWorkItems":[],"waitingFor":null,"nextWakeupAt":null,"warnings":[]}',
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_manager_conversation",
      taskId: "task_codex_manager_conversation",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_manager_conversation",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "你好",
      description: "你好",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:23:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-manager-conversation-session",
        "codex-manager-conversation-stdout",
        "codex-manager-conversation-stderr",
        "codex-manager-conversation-note",
        "codex-manager-conversation-metadata",
        "codex-manager-conversation-started",
        "codex-manager-conversation-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-manager-conversation-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_codex_manager_conversation",
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: "thread_manager_conversation_1",
    artifactId: "artifact_codex-manager-conversation-note",
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.prompt).toContain("You are the leader agent for Magister.");
  expect(invocations[0]?.prompt).not.toContain("Before acting, read the run contract");
  expect(invocations[0]?.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(dependencies.artifactCreates.some((artifact) => artifact.artifactType === "runtime_context")).toBe(false);
});

test("codex executor adapter resumes a prior session when resume_first policy is present", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const invocations: Array<{
    command: string;
    args: string[];
    prompt: string;
    cwd: string;
    outputPath: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      return {
        exitCode: 0,
        stdout: [
          '{"type":"thread.started","thread_id":"thread_resume_success_1"}',
          '{"type":"agent_message","message":"Resumed and completed."}',
        ].join("\n"),
        stderr: "",
        lastMessage:
          '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"Resumed and completed from the prior manager session.","confidence":"high","childWorkItems":[],"waitingFor":null,"nextWakeupAt":null,"warnings":[]}',
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_resume_success",
      taskId: "task_codex_resume_success",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 1,
      delegationMode: "delegate_with_context",
      priorSessionId: "session_prior_resume_1",
      priorWorkdir: TEST_WORKSPACE_DIR,
      resumePolicy: "resume_first",
    },
    task: {
      id: "task_codex_resume_success",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Continue previous manager lane",
      description: "Continue from previous lane session state.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-12T10:10:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-resume-success-session",
        "codex-resume-success-stdout",
        "codex-resume-success-stderr",
        "codex-resume-success-note",
        "codex-resume-success-metadata",
        "codex-resume-success-started",
        "codex-resume-success-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-resume-success-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_codex_resume_success",
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: "thread_resume_success_1",
    artifactId: "artifact_codex-resume-success-note",
  });
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.args).toEqual(expect.arrayContaining(["exec", "resume"]));
  expect(invocations[0]?.args).toContain("session_prior_resume_1");
  expect(invocations[0]?.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["--color", "never"]));
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["-C"]));
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["--ephemeral"]));
  expect(invocations[0]?.prompt).toContain("You are the leader agent for Magister.");
  expect(invocations[0]?.prompt).toContain("Delegation Mode: handoff");
  expect(invocations[0]?.prompt).not.toContain("Before acting, read the run contract");
  expect(invocations[0]?.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(invocations[0]?.prompt).not.toContain(
    "Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
  );

  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.runtimeUpdates[0]).toMatchObject({
    id: "runtime_codex_resume_success",
    input: expect.objectContaining({
      state: "RUNNING",
      currentSessionId: "session_prior_resume_1",
    }),
  });
  expect(dependencies.runtimeUpdates[1]).toMatchObject({
    id: "runtime_codex_resume_success",
    input: expect.objectContaining({
      state: "COMPLETED",
      currentSessionId: "thread_resume_success_1",
    }),
  });
});

test("codex executor adapter falls back to a fresh run when resume session is unavailable", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "workspace-write",
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const invocations: Array<{
    command: string;
    args: string[];
    prompt: string;
    cwd: string;
    outputPath: string;
    env?: NodeJS.ProcessEnv;
  }> = [];

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async (invocation) => {
      invocations.push(invocation);
      if (invocations.length === 1) {
        return {
          exitCode: 1,
          stdout: '{"type":"error","message":"Session not found: session_prior_resume_missing_1"}',
          stderr: "resume failed: session not found\n",
          lastMessage: "",
        };
      }

      return {
        exitCode: 0,
        stdout: '{"type":"agent_message","message":"Fresh fallback succeeded."}',
        stderr: "",
        lastMessage:
          '{"taskType":"conversation","executionMode":"immediate","decision":"direct_answer","reply":"Recovered after falling back to a fresh manager run.","confidence":"high","childWorkItems":[],"waitingFor":null,"nextWakeupAt":null,"warnings":[]}',
      };
    },
  }).execute({
    runtime: {
      id: "runtime_codex_resume_fallback",
      taskId: "task_codex_resume_fallback",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 2,
      delegationMode: "delegate_with_context",
      priorSessionId: "session_prior_resume_missing_1",
      priorWorkdir: TEST_WORKSPACE_DIR,
      resumePolicy: "resume_first",
    },
    task: {
      id: "task_codex_resume_fallback",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "Continue previous manager lane",
      description: "Continue from previous lane session state.",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-12T10:15:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-resume-fallback-session",
        "codex-resume-fallback-stdout",
        "codex-resume-fallback-stderr",
        "codex-resume-fallback-note",
        "codex-resume-fallback-metadata",
        "codex-resume-fallback-started",
        "codex-resume-fallback-completed",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-resume-fallback-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_codex_resume_fallback",
    adapterId: "codex",
    state: "COMPLETED",
    sessionId: "session_codex-resume-fallback-session",
    artifactId: "artifact_codex-resume-fallback-note",
  });
  expect(invocations).toHaveLength(2);
  expect(invocations[0]?.args).toEqual(expect.arrayContaining(["exec", "resume"]));
  expect(invocations[0]?.args).toContain("session_prior_resume_missing_1");
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["--color", "never"]));
  expect(invocations[0]?.args).not.toEqual(expect.arrayContaining(["-C"]));
  expect(invocations[1]?.args).toEqual(expect.arrayContaining(["exec"]));
  expect(invocations[1]?.args).not.toContain("resume");
  expect(invocations[1]?.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  expect(invocations[1]?.args).toEqual(expect.arrayContaining(["--color", "never"]));
  expect(invocations[1]?.args).toEqual(expect.arrayContaining(["-C", TEST_WORKSPACE_DIR]));
  expect(invocations[1]?.args).not.toEqual(expect.arrayContaining(["--ephemeral"]));
  expect(invocations[1]?.prompt).toContain("You are the leader agent for Magister.");
  expect(invocations[1]?.prompt).toContain("Delegation Mode: handoff");
  expect(invocations[1]?.prompt).not.toContain("Before acting, read the run contract");
  expect(invocations[1]?.prompt).not.toContain(
    "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
  );
  expect(invocations[1]?.prompt).not.toContain(
    "Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
  );

  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.runtimeUpdates[1]).toMatchObject({
    id: "runtime_codex_resume_fallback",
    input: expect.objectContaining({
      state: "COMPLETED",
      currentSessionId: "session_codex-resume-fallback-session",
      resumeFailureReason: expect.stringContaining("resume"),
    }),
  });
});

test("codex executor adapter fails the run when stdout includes a structured codex error item", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["leader", "architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    authMode: "chatgpt",
    commandPath: "/opt/homebrew/bin/codex",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "file",
    sandboxMode: "danger-full-access",
    timeoutMs: 180000,
    notes: "Primary execution slot for manager-led orchestration.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => ({
      exitCode: 0,
      stdout: [
        '{"type":"thread.started","thread_id":"thread_123"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"`[features].web_search_request` is deprecated because web search is enabled by default."}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Bootstrap done."}}',
      ].join("\n"),
      stderr:
        "2026-04-11T04:27:09.587395Z  WARN codex_state::runtime: failed to open state db at /opt/acme/.codex/state_5.sqlite\n",
      lastMessage:
        "Objective\nInitialize this workspace session.\n\nActions\n- Ran bootstrap.\n\nOutcome\nSession initialization is complete.",
    }),
  }).execute({
    runtime: {
      id: "runtime_codex_structured_error",
      taskId: "task_codex_structured_error",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_structured_error",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
      title: "你好",
      description: "请先理解用户目标，再给出执行计划。",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:25:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-structured-session",
        "codex-structured-stdout",
        "codex-structured-stderr",
        "codex-structured-note",
        "codex-structured-metadata",
        "codex-structured-started",
        "codex-structured-event",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-structured-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_codex_structured_error",
    adapterId: "codex",
    state: "FAILED",
    code: "executor_invocation_failed",
    message: "Codex reported an internal error while dispatching the leader run",
  });
  expect(dependencies.runtimeUpdates.at(-1)).toMatchObject({
    id: "runtime_codex_structured_error",
    input: expect.objectContaining({
      state: "FAILED",
    }),
  });
  expect(dependencies.taskUpdates.at(-1)).toMatchObject({
    id: "task_codex_structured_error",
    input: expect.objectContaining({
      state: "BLOCKED",
    }),
  });
  expect(dependencies.events.at(-1)).toMatchObject({
    type: "executor_session.failed",
    severity: "error",
  });

  const failedPayload = JSON.parse(
    String((dependencies.events.at(-1) as { payloadJson: string }).payloadJson),
  ) as Record<string, string>;
  expect(failedPayload.error).toContain("web_search_request");
  expect(failedPayload.lastMessagePreview).toContain("Session initialization is complete");
});

test("codex executor adapter blocks the run when the codex CLI exits non-zero", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "env",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => ({
      exitCode: 2,
      stdout: '{"type":"agent_message","message":"Trying"}\n',
      stderr: "authentication failed\n",
      lastMessage: "",
    }),
  }).execute({
    runtime: {
      id: "runtime_codex_failure",
      taskId: "task_codex_failure",
      roleId: "architect",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_failure",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:30:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-failure-session",
        "codex-failure-stdout",
        "codex-failure-stderr",
        "codex-failure-note",
        "codex-failure-metadata",
        "codex-failure-started",
        "codex-failure-event",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-failure-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_codex_failure",
    adapterId: "codex",
    state: "FAILED",
    code: "executor_auth_failed",
    message: "Codex authentication failed while dispatching the architect run",
  });
  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.runtimeUpdates[1]).toMatchObject({
    id: "runtime_codex_failure",
    input: expect.objectContaining({
      state: "FAILED",
      currentSessionId: "session_codex-failure-session",
    }),
  });
  expect(dependencies.taskUpdates).toHaveLength(2);
  expect(dependencies.taskUpdates[1]).toMatchObject({
    id: "task_codex_failure",
    input: expect.objectContaining({
      state: "BLOCKED",
    }),
  });
  expect(dependencies.artifactCreates).toHaveLength(8);
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
  // Event COUNT is intentionally not asserted: safe_apply.change_review_created
  // fires when the change-review row doesn't already exist (i.e. against a clean
  // change-review DB, as on CI), so the exact count is environment-dependent.
  // expectRecordedEventOrder below verifies the required events in order — the
  // same pattern the other adapter tests in this file use.
  expectRecordedEventOrder(dependencies.events, [
    "executor_session.started",
    "safe_apply.review_draft_created",
    "executor_session.failed",
  ]);
  const reviewDraftEvent = findRecordedEvent(dependencies.events, "safe_apply.review_draft_created");
  const failedEvent = findRecordedEvent(dependencies.events, "executor_session.failed");
  expect(reviewDraftEvent).toMatchObject({
    type: "safe_apply.review_draft_created",
  });
  expect(failedEvent).toMatchObject({
    type: "executor_session.failed",
    severity: "error",
  });

  const failedPayload = JSON.parse(
    String((failedEvent as { payloadJson: string }).payloadJson),
  ) as Record<string, string>;
  expect(failedPayload.command).toContain("codex exec");
  expect(failedPayload.stderrPreview).toContain("authentication failed");
  expect(failedPayload.errorCategory).toBe("auth_error");
  expect(failedPayload.failureCode).toBe("executor_auth_failed");
  expect(failedPayload.suggestion).toContain("credentials");
});

test("codex executor adapter classifies timeouts and emits timeout guidance", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "env",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => ({
      exitCode: 124,
      stdout: '{"type":"agent_message","message":"Working"}\n',
      stderr: "process exceeded execution window\n",
      lastMessage: "",
      timedOut: true,
      durationMs: 45_000,
      signal: "SIGTERM",
    }),
  }).execute({
    runtime: {
      id: "runtime_codex_timeout",
      taskId: "task_codex_timeout",
      roleId: "lander",
      state: "CREATED",
      attemptCount: 2,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_timeout",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:35:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-timeout-session",
        "codex-timeout-stdout",
        "codex-timeout-stderr",
        "codex-timeout-note",
        "codex-timeout-metadata",
        "codex-timeout-started",
        "codex-timeout-event",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-timeout-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_codex_timeout",
    adapterId: "codex",
    state: "FAILED",
    code: "executor_timeout",
    message: "Codex timed out while dispatching the lander run",
  });

  expectRecordedEventOrder(dependencies.events, ["executor_session.started", "executor_session.failed"]);
  const failedEvent = findRecordedEvent(dependencies.events, "executor_session.failed");
  const failedPayload = JSON.parse(
    String((failedEvent as { payloadJson: string }).payloadJson),
  ) as Record<string, string | number | boolean>;
  expect(failedPayload.errorCategory).toBe("timeout");
  expect(failedPayload.failureCode).toBe("executor_timeout");
  expect(failedPayload.timedOut).toBe(true);
  expect(failedPayload.signal).toBe("SIGTERM");
  expect(failedPayload.durationMs).toBe(45_000);
  expect(String(failedPayload.suggestion)).toContain("Reduce the task scope");
});

test("codex executor adapter condenses repetitive manifest warnings for failed run payloads", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "env",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");
  const noisyLog = [
    "Reading additional input from stdin...",
    "2026-04-12T13:28:08.464055Z WARN codex_core::plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/tmp/plugins/build-ios-apps/.codex-plugin/plugin.json",
    "2026-04-12T13:28:08.464771Z WARN codex_core::plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/tmp/plugins/life-science-research/.codex-plugin/plugin.json",
    "2026-04-12T13:28:08.887609Z WARN codex_core::plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/tmp/plugins/build-ios-apps/.codex-plugin/plugin.json",
    "2026-04-12T13:28:08.888506Z WARN codex_core::plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/tmp/plugins/life-science-research/.codex-plugin/plugin.json",
    "2026-04-12T13:28:07.853993Z WARN codex_core::shell_snapshot: Failed to delete shell snapshot at \"/tmp/shell_snapshot.tmp\": Os { code: 2, kind: NotFound, message: \"No such file or directory\" }",
    "Codex timed out after 180000ms",
  ].join("\n");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => ({
      exitCode: 124,
      stdout: "",
      stderr: noisyLog,
      lastMessage: noisyLog,
      timedOut: true,
      durationMs: 180_000,
      signal: "SIGTERM",
    }),
  }).execute({
    runtime: {
      id: "runtime_codex_noisy_failure",
      taskId: "task_codex_noisy_failure",
      roleId: "coder",
      state: "CREATED",
      attemptCount: 1,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_noisy_failure",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-12T13:31:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-noisy-session",
        "codex-noisy-stdout",
        "codex-noisy-stderr",
        "codex-noisy-note",
        "codex-noisy-metadata",
        "codex-noisy-started",
        "codex-noisy-event",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-noisy-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_codex_noisy_failure",
    adapterId: "codex",
    state: "FAILED",
    code: "executor_timeout",
    message: "Codex timed out while dispatching the coder run",
  });

  expectRecordedEventOrder(dependencies.events, ["executor_session.started", "executor_session.failed"]);
  const failedEventNoisy = findRecordedEvent(dependencies.events, "executor_session.failed");
  const failedPayload = JSON.parse(
    String((failedEventNoisy as { payloadJson: string }).payloadJson),
  ) as Record<string, string | number | boolean>;
  expect(String(failedPayload.lastMessage)).toContain("Codex timed out after 180000ms");
  expect(String(failedPayload.lastMessage)).toContain(
    "Suppressed 4 repetitive plugin manifest warnings",
  );
  expect(String(failedPayload.lastMessage)).not.toContain(".codex-plugin/plugin.json");
  expect(failedPayload.pluginManifestWarningCount).toBe(4);
  expect(failedPayload.shellSnapshotWarningCount).toBe(1);

  const noteArtifact = dependencies.artifactCreates.find(
    (artifact) => artifact.id === "artifact_codex-noisy-note",
  );
  expect(noteArtifact).toBeTruthy();
  expect(readFileSync(String(noteArtifact?.storageRef), "utf8")).toContain(
    "Suppressed 4 repetitive plugin manifest warnings",
  );
});

test("codex executor adapter classifies unavailable CLI invocations", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "codex",
    displayName: "Codex",
    executorType: "coding_agent",
    roleTargets: ["architect", "coder", "lander"],
    configKey: "MAGISTER_MODEL_CODEX",
    executionMode: "cli",
    status: "configured",
    configuredModel: "gpt-5.3-codex",
    configSource: "env",
    notes: "Primary execution slot for design, implementation, and landing work.",
  };
  const dependencies = createFakeDependencies();
  const artifactsRoot = createTempArtifactsRoot();
  const codexHome = join(artifactsRoot, "codex-home");

  const result = await createCodexExecutorAdapter(slot, {
    workspaceDir: TEST_WORKSPACE_DIR,
    artifactsRootDir: artifactsRoot,
    codexHomeDir: codexHome,
    runCommand: async () => {
      throw new Error("spawn codex ENOENT");
    },
  }).execute({
    runtime: {
      id: "runtime_codex_unavailable",
      taskId: "task_codex_unavailable",
      roleId: "architect",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_codex_unavailable",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-11T10:40:00.000Z"),
    createId: (() => {
      const ids = [
        "codex-unavailable-session",
        "codex-unavailable-stdout",
        "codex-unavailable-stderr",
        "codex-unavailable-note",
        "codex-unavailable-metadata",
        "codex-unavailable-started",
        "codex-unavailable-event",
      ];
      let index = 0;
      return () => ids[index++] ?? `codex-unavailable-extra-${index}`;
    })(),
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_codex_unavailable",
    adapterId: "codex",
    state: "FAILED",
    code: "executor_unavailable",
    message: "Codex CLI is unavailable while dispatching the architect run",
  });

  expectRecordedEventOrder(dependencies.events, ["executor_session.started", "executor_session.failed"]);
  const failedEventUnavailable = findRecordedEvent(dependencies.events, "executor_session.failed");
  const failedPayload = JSON.parse(
    String((failedEventUnavailable as { payloadJson: string }).payloadJson),
  ) as Record<string, string>;
  expect(failedPayload.errorCategory).toBe("runtime_unavailable");
  expect(failedPayload.failureCode).toBe("executor_unavailable");
  expect(failedPayload.error).toContain("ENOENT");
});
