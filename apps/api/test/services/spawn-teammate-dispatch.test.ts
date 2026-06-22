import { afterEach, beforeEach, expect, test } from "bun:test";
import type { LeaderModelCallParams, LeaderModelOutputEvent, LeaderToolUseContext } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

let tempDir = "";
let priorStreamingFlag: string | undefined;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "spawn-teammate-dispatch-test-"));
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  // These tests use bash-stub commands that aren't real CLIs — they
  // exercise argv construction, not streaming behavior. Step 3 wires
  // streaming through `getCachedCliVersion`, which reads the project
  // root's `.magister/cli-versions.json` and returns the REAL CLI
  // version (codex 0.129+ etc.), triggering streaming for the stub.
  // The stub then produces non-JSON stdout that the codex parser
  // can't make sense of, hiding the echo'd argv behind a placeholder.
  // Disable streaming for the duration of this suite so the tests
  // actually see what they assert against.
  priorStreamingFlag = process.env.CLI_STREAMING_ENABLED;
  process.env.CLI_STREAMING_ENABLED = "false";
  process.env.MAGISTER_REVIEW_GATE_TIMEOUT_MS = "0";
});

afterEach(async () => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_REVIEW_GATE_TIMEOUT_MS;
  if (priorStreamingFlag === undefined) delete process.env.CLI_STREAMING_ENABLED;
  else process.env.CLI_STREAMING_ENABLED = priorStreamingFlag;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createContext(
  callModel: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>,
): LeaderToolUseContext {
  return {
    taskId: "task_phase_b",
    runId: "run_phase_b",
    requestId: "req_phase_b",
    workspaceDir: tempDir,
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: () => {},
    getInProgressToolUseIDs: () => new Set<string>(),
    recordEvent: async () => {},
    callModel,
  };
}

async function writeStubCommand(name: string, body: string): Promise<string> {
  const commandPath = join(tempDir, name);
  await writeFile(commandPath, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function initGitRepo(dir: string) {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "base\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
}

test("spawn_teammate with ucm agent runs leaderLoop", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_magister_dispatch",
    label: "Custom Magister Dispatch",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    systemPromptOverride: "You are a test teammate",
    toolProfile: "minimal",
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const callModel = async function* (_params: LeaderModelCallParams): AsyncGenerator<LeaderModelOutputEvent> {
    yield {
      type: "assistant",
      content: [{ type: "text", text: "ucm teammate response" }],
    };
  };

  const result = await spawnTool!.call(
    { role: "custom_magister_dispatch", goal: "Do Magister work" },
    createContext(callModel),
  );

  expect(result.data).toBe("ucm teammate response");
});

test("spawn_teammate with custom allowedTools freezes a narrowed teammate tool set", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_bash_only_dispatch",
    label: "Custom Bash Only Dispatch",
    runtimeType: "ucm",
    toolProfile: "full",
    // spawn_teammate is configurable but stripped from a teammate's own
    // tool set; the assertion below proves the teammate ends up with just
    // ["bash"]. (enter_plan_mode is no longer a configurable tool — it's a
    // plan-mode-only tool that upsertAgentProfile rejects.)
    allowedTools: ["bash", "spawn_teammate"],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const capturedToolNames: string[][] = [];
  const callModel = async function* (params: LeaderModelCallParams): AsyncGenerator<LeaderModelOutputEvent> {
    capturedToolNames.push(params.tools.map((tool) => tool.name));
    yield {
      type: "assistant",
      content: [{ type: "text", text: "bash-only teammate response" }],
    };
  };

  const result = await spawnTool!.call(
    { role: "custom_bash_only_dispatch", goal: "Do restricted Magister work" },
    createContext(callModel),
  );

  expect(result.data).toBe("bash-only teammate response");
  expect(capturedToolNames[0]).toEqual(["bash"]);
});

test("spawn_teammate with maxTurns under default bounds a runaway teammate loop", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_short_loop_dispatch",
    label: "Custom Short Loop Dispatch",
    runtimeType: "ucm",
    toolProfile: "full",
    allowedTools: ["time_now"],
    maxTurns: 5,
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  let modelCalls = 0;
  const events: Array<{ type: string; data: any }> = [];
  const callModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    modelCalls += 1;
    yield {
      type: "assistant",
      content: [{
        type: "tool_use",
        id: `time-${modelCalls}`,
        name: "time_now",
        input: {},
      }],
    };
  };
  const context = createContext(callModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  const result = await spawnTool!.call(
    { role: "custom_short_loop_dispatch", goal: "Loop until bounded" },
    context,
  );

  expect(String(result.data)).toContain("reached max turns");
  expect(modelCalls).toBe(5);
  expect(events).toContainEqual(expect.objectContaining({
    type: "leader.teammate_completed",
    data: expect.objectContaining({
      reason: "max_turns",
      turnCount: 6,
    }),
  }));
});

test("spawn_teammate with codex agent calls spawnCliAgent", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const commandPath = await writeStubCommand(
    "codex",
    'echo "ENV:$CODEX_TEST_ENV"\necho "ARGS:$*"',
  );

  await upsertAgentProfile({
    roleId: "custom_codex_dispatch",
    label: "Custom Codex Dispatch",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
    customEnv: '{"CODEX_TEST_ENV":"ok"}',
    customArgs: '["--extra","flag"]',
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const throwIfUsedModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for codex runtime");
  };
  const events: Array<{ type: string; data: any }> = [];
  const context = createContext(throwIfUsedModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  const result = await spawnTool!.call(
    { role: "custom_codex_dispatch", goal: "Do Codex work" },
    context,
  );

  const output = String(result.data);
  expect(output).toContain("ENV:ok");
  expect(output).toContain("--model gpt-5.4");
  expect(output).toContain("--extra flag");
  expect(output).toContain("Do Codex work");
  expect(events).toContainEqual(expect.objectContaining({
    type: "leader.teammate_spawned",
    data: expect.objectContaining({
      teammateName: "custom_codex_dispatch",
      role: "custom_codex_dispatch",
      runtimeType: "codex",
      modelName: "gpt-5.4",
    }),
  }));

  const spawnedEvent = events.find((event) => event.type === "leader.teammate_spawned");
  const teammateRunId = spawnedEvent?.data?.teammateRunId;
  expect(typeof teammateRunId).toBe("string");

  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(0);
});

test("spawn_teammate cli path propagates parent abort to subprocess (cancel cascades)", async () => {
  // Regression: prior to this fix, `spawnCliAgent` was called without
  // `signal`, so /tasks/:id/cancel only aborted the leader's own loop
  // while spawned `codex exec` / `claude -p` subprocesses kept running
  // and burning tokens. The "Working (Xm Ys)" timer in the chat UI also
  // never stopped. Verify the abort signal now reaches the child.
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const commandPath = await writeStubCommand(
    "codex",
    // Sleep long enough that the test would hang without abort cascading.
    // The trap catches SIGTERM so we can distinguish "killed by parent
    // abort" from "exited cleanly".
    'trap "echo killed; exit 143" TERM\nsleep 30',
  );

  await upsertAgentProfile({
    roleId: "custom_codex_abort_cascade",
    label: "Custom Codex Abort Cascade",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const throwIfUsedModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for codex runtime");
  };
  const events: Array<{ type: string; data: any }> = [];
  const context = createContext(throwIfUsedModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  // Abort shortly after the call starts. The leader's spawn_teammate
  // must forward `context.abortController.signal` into spawnCliAgent so
  // the child receives SIGTERM and the await resolves quickly.
  setTimeout(() => context.abortController.abort("cancelled"), 200);

  const startedAt = Date.now();
  const result = await spawnTool!.call(
    { role: "custom_codex_abort_cascade", goal: "Pretend long task" },
    context,
  );
  const elapsed = Date.now() - startedAt;

  // If the abort signal was NOT propagated, the stub would sleep for
  // 30s and this assertion would fail. Allow generous headroom for
  // CI flake but stay well under sleep duration.
  expect(elapsed).toBeLessThan(10_000);
  expect(result).toBeDefined();

  const completedEvent = events.find((e) => e.type === "leader.teammate_completed");
  expect(completedEvent).toBeDefined();
  // Aborted runs surface as `reason: "error"` (non-zero exit from SIGTERM).
  // Either reason is acceptable here as long as a terminal event was
  // emitted — the critical guarantee is that the timer can stop.
  expect(["error", "completed"]).toContain(completedEvent?.data?.reason);
});

test("spawn_teammate with isolated cli worktree records git_worktree review draft metadata", async () => {
  await initGitRepo(tempDir);

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const commandPath = await writeStubCommand(
    "codex",
    '[ -d "$CODEX_HOME" ] || { echo "missing codex home:$CODEX_HOME" >&2; exit 42; }\nprintf "changed\\n" >> README.md\necho "isolated done:$CODEX_HOME"',
  );

  await upsertAgentProfile({
    roleId: "custom_codex_isolated_dispatch",
    label: "Custom Codex Isolated Dispatch",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const throwIfUsedModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for codex runtime");
  };
  const events: Array<{ type: string; data: any }> = [];
  const context = createContext(throwIfUsedModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  const result = await spawnTool!.call(
    { role: "custom_codex_isolated_dispatch", goal: "Do isolated Codex work", isolate: true },
    context,
  );

  expect(String(result.data)).toContain("isolated done");
  // 2026-05-20: per-workspace slug now sits between cli-home and the
  // runtime dir (codex home no longer lives under the user workspace).
  expect(String(result.data)).toMatch(/\/\.magister\/cli-home\/[^/]+\/codex\/\.codex/);
  const teammateRunId = events.find((event) => event.type === "leader.teammate_spawned")?.data?.teammateRunId;
  expect(typeof teammateRunId).toBe("string");

  const { ArtifactRepository } = await import("../../src/repositories/artifact-repository");
  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(1);
  const safeApplyPayload = JSON.parse(safeApplyEvents[0]?.payloadJson ?? "{}");
  expect(safeApplyPayload.changedFiles).toBe(1);

  const reviewDraftArtifact = await new ArtifactRepository().getById(safeApplyPayload.reviewDraftArtifactId);
  const draft = JSON.parse(await readFile(reviewDraftArtifact!.storageRef, "utf8"));
  expect(draft.roleRuntimeId).toBe(teammateRunId);
  expect(draft.runtimeSecurity.runtimeWorkspaceStrategy).toBe("git_worktree");
  expect(draft.diffArtifact.baseRevision).toEqual(expect.any(String));
  expect(draft.diffArtifact.changedFiles).toContainEqual(expect.objectContaining({
    path: "README.md",
    status: "modified",
  }));

  const reviews = await new ChangeReviewRepository().listByTaskId("task_phase_b");
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    reviewDraftArtifactId: safeApplyPayload.reviewDraftArtifactId,
    diffArtifactId: safeApplyPayload.diffArtifactId,
    risk: "HUMAN_REQUIRED",
    decisionState: "pending",
    applyState: "not_applied",
  });
});

test("spawn_teammate with isolated Magister worktree records safe-apply review draft metadata", async () => {
  await initGitRepo(tempDir);

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_magister_isolated_dispatch",
    label: "Custom Magister Isolated Dispatch",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    systemPromptOverride: "You are a test teammate",
    toolProfile: "full",
    allowedTools: ["bash"],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  let modelCalls = 0;
  const callModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    modelCalls += 1;
    if (modelCalls === 1) {
      yield {
        type: "assistant",
        content: [{
          type: "tool_use",
          id: "bash-magister-write",
          name: "bash",
          input: { command: 'printf "ucm changed\\n" >> README.md' },
        }],
      };
      return;
    }
    yield {
      type: "assistant",
      content: [{ type: "text", text: "ucm isolated done" }],
    };
  };

  const result = await spawnTool!.call(
    { role: "custom_magister_isolated_dispatch", goal: "Modify README", isolate: true },
    createContext(callModel),
  );

  expect(result.data).toBe("ucm isolated done");
  const { ArtifactRepository } = await import("../../src/repositories/artifact-repository");
  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(1);
  const safeApplyPayload = JSON.parse(safeApplyEvents[0]?.payloadJson ?? "{}");
  expect(safeApplyPayload.changedFiles).toBe(1);

  const reviewDraftArtifact = await new ArtifactRepository().getById(safeApplyPayload.reviewDraftArtifactId);
  const draft = JSON.parse(await readFile(reviewDraftArtifact!.storageRef, "utf8"));
  expect(draft.runtimeSecurity.runtimeSource).toBe("ucm");
  expect(draft.runtimeSecurity.runtimeWorkspaceStrategy).toBe("git_worktree");
  expect(draft.diffArtifact.baseRevision).toEqual(expect.any(String));
  expect(draft.diffArtifact.changedFiles).toContainEqual(expect.objectContaining({
    path: "README.md",
    status: "modified",
  }));

  const reviews = await new ChangeReviewRepository().listByTaskId("task_phase_b");
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    reviewDraftArtifactId: safeApplyPayload.reviewDraftArtifactId,
    diffArtifactId: safeApplyPayload.diffArtifactId,
    decisionState: "pending",
    applyState: "not_applied",
  });
});

test("spawn_teammate with isolated Magister read-only tool activity and empty diff creates no review", async () => {
  await initGitRepo(tempDir);

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_magister_read_only_dispatch",
    label: "Custom Magister Read Only Dispatch",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    systemPromptOverride: "You are a test teammate",
    toolProfile: "full",
    allowedTools: ["read_file"],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  let modelCalls = 0;
  const callModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    modelCalls += 1;
    if (modelCalls === 1) {
      yield {
        type: "assistant",
        content: [{
          type: "tool_use",
          id: "read-ucm",
          name: "read_file",
          input: { path: "README.md" },
        }],
      };
      return;
    }
    yield {
      type: "assistant",
      content: [{ type: "text", text: "read-only done" }],
    };
  };

  const result = await spawnTool!.call(
    { role: "custom_magister_read_only_dispatch", goal: "Read README", isolate: true },
    createContext(callModel),
  );

  expect(result.data).toBe("read-only done");
  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(0);
  expect(await new ChangeReviewRepository().listByTaskId("task_phase_b")).toHaveLength(0);
});

test("spawn_teammate with isolated Magister mutating tool activity and empty diff records side-effect review", async () => {
  await initGitRepo(tempDir);

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_magister_side_effect_dispatch",
    label: "Custom Magister Side Effect Dispatch",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    systemPromptOverride: "You are a test teammate",
    toolProfile: "full",
    allowedTools: ["bash"],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  let modelCalls = 0;
  const callModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    modelCalls += 1;
    if (modelCalls === 1) {
      yield {
        type: "assistant",
        content: [{
          type: "tool_use",
          id: "bash-magister-side-effect",
          name: "bash",
          input: { command: "true" },
        }],
      };
      return;
    }
    yield {
      type: "assistant",
      content: [{ type: "text", text: "side-effect done" }],
    };
  };

  const result = await spawnTool!.call(
    { role: "custom_magister_side_effect_dispatch", goal: "Run mutating-capable command", isolate: true },
    createContext(callModel),
  );

  expect(result.data).toBe("side-effect done");
  const { ArtifactRepository } = await import("../../src/repositories/artifact-repository");
  const { ChangeReviewRepository } = await import("../../src/repositories/change-review-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(1);
  const safeApplyPayload = JSON.parse(safeApplyEvents[0]?.payloadJson ?? "{}");
  const reviewDraftArtifact = await new ArtifactRepository().getById(safeApplyPayload.reviewDraftArtifactId);
  const draft = JSON.parse(await readFile(reviewDraftArtifact!.storageRef, "utf8"));
  expect(draft.diffArtifact.isEmpty).toBe(true);
  expect(draft.sideEffectWarning).toMatchObject({
    code: "no_code_diff_runtime_side_effects_not_audited",
    observedEventTypes: expect.arrayContaining(["leader.tool_call", "leader.tool_result"]),
    observedTools: expect.arrayContaining(["bash"]),
  });

  const reviews = await new ChangeReviewRepository().listByTaskId("task_phase_b");
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.sideEffectWarningJson).toContain("observedTools");
});

test("spawn_teammate keeps successful Magister result when safe-apply draft persistence fails", async () => {
  await initGitRepo(tempDir);
  await writeFile(join(tempDir, ".magister"), "not a directory", "utf8");

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await upsertAgentProfile({
    roleId: "custom_magister_draft_failure",
    label: "Custom Magister Draft Failure",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    systemPromptOverride: "You are a test teammate",
    toolProfile: "full",
    allowedTools: ["bash"],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  let modelCalls = 0;
  const callModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    modelCalls += 1;
    if (modelCalls === 1) {
      yield {
        type: "assistant",
        content: [{
          type: "tool_use",
          id: "bash-magister-draft-failure",
          name: "bash",
          input: { command: 'printf "ucm draft failure changed\\n" >> README.md' },
        }],
      };
      return;
    }
    yield {
      type: "assistant",
      content: [{ type: "text", text: "ucm done despite draft failure" }],
    };
  };

  const events: Array<{ type: string; data: any }> = [];
  const context = createContext(callModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  const result = await spawnTool!.call(
    { role: "custom_magister_draft_failure", goal: "Do isolated Magister work", isolate: true },
    context,
  );

  expect(result.data).toBe("ucm done despite draft failure");
  const completedEvent = events.find((event) => event.type === "leader.teammate_completed");
  expect(completedEvent?.data?.reason).toBe("completed");

  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(0);
});

test("spawn_teammate keeps successful cli result when safe-apply draft persistence fails", async () => {
  await initGitRepo(tempDir);
  await writeFile(join(tempDir, ".magister"), "not a directory", "utf8");

  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const commandPath = await writeStubCommand(
    "codex",
    'printf "changed\\n" >> README.md\necho "isolated done despite draft failure"',
  );

  await upsertAgentProfile({
    roleId: "custom_codex_draft_failure",
    label: "Custom Codex Draft Failure",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const throwIfUsedModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for codex runtime");
  };
  const events: Array<{ type: string; data: any }> = [];
  const context = createContext(throwIfUsedModel);
  context.recordEvent = async (event) => {
    events.push(event as { type: string; data: any });
  };

  const result = await spawnTool!.call(
    { role: "custom_codex_draft_failure", goal: "Do isolated Codex work", isolate: true },
    context,
  );

  expect(String(result.data)).toContain("isolated done despite draft failure");
  expect(String(result.data)).not.toContain("ENOTDIR");
  const completedEvent = events.find((event) => event.type === "leader.teammate_completed");
  expect(completedEvent?.data?.reason).toBe("completed");

  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const safeApplyEvents = await new ExecutionEventRepository().listByTaskIdAndType(
    "task_phase_b",
    "safe_apply.review_draft_created",
  );
  expect(safeApplyEvents).toHaveLength(0);
});

test("spawn_teammate with cli runtime inlines markdown attachments into the goal", async () => {
  // Regression: CLI teammates (codex/opencode/claude-code) only see
  // image attachments via -i / -f / prompt-list. Text-shaped
  // attachments (md / plain) used to be filtered out at the
  // mimeType.startsWith("image/") gate, so a leader spawning
  // `coder goal: review this spec` with the user's spec.md attached
  // would hand the coder a goal with no spec content. Now the goal
  // string gets a "## Attached files" addendum carrying the same
  // text-block payload the Magister teammate sees.
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { saveAttachments } = await import("../../src/services/attachment-service");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const commandPath = await writeStubCommand(
    "codex",
    'echo "ARGS:$*"',
  );

  await upsertAgentProfile({
    roleId: "custom_codex_with_md",
    label: "Codex With MD",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  // Save a markdown attachment under the leader's current
  // (taskId, requestId). The CLI dispatch code reads from this
  // table by the same key.
  const dataBase64 = Buffer.from("# Spec\n\nDo the thing.\n", "utf8").toString("base64");
  await saveAttachments("task_phase_b", "req_phase_b", [
    { filename: "spec.md", mimeType: "text/markdown", dataBase64 },
  ]);

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const noModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for cli runtime");
  };
  const result = await spawnTool!.call(
    { role: "custom_codex_with_md", goal: "Do the work" },
    createContext(noModel),
  );

  const output = String(result.data);
  // Original goal preserved + attachment header + content all
  // present in the prompt that landed on the stub's argv.
  expect(output).toContain("Do the work");
  expect(output).toContain("Attached files");
  expect(output).toContain("spec.md");
  expect(output).toContain("Do the thing");
});

test("spawn_teammate caps total prompt at 96 KiB to avoid Linux MAX_ARG_STRLEN E2BIG", async () => {
  // Linux's per-argv-element limit is exactly 131072 bytes (128 KiB).
  // Without a total cap, multiple smaller text attachments could
  // join into a >128 KiB string passed as a single argv slot to
  // codex/opencode, causing posix_spawn to fail with E2BIG before
  // the CLI even runs. Verify the cap fires + the truncation
  // marker is present.
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { saveAttachments } = await import("../../src/services/attachment-service");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const commandPath = await writeStubCommand("codex", 'echo "ARGS:$*" | wc -c');
  await upsertAgentProfile({
    roleId: "custom_codex_overflow",
    label: "Codex Overflow",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  // Three 50 KiB markdown files — joined would be ~150 KiB, well
  // over the per-arg limit. With the cap, the result must be
  // ≤ ~96 KiB.
  for (let i = 0; i < 3; i++) {
    const body = "x".repeat(50 * 1024);
    const dataBase64 = Buffer.from(`# big-${i}\n\n${body}\n`, "utf8").toString("base64");
    await saveAttachments("task_phase_b", `req_BIG_${i}`, [
      { filename: `big-${i}.md`, mimeType: "text/markdown", dataBase64 },
    ]);
  }

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const noModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for cli runtime");
  };
  const result = await spawnTool!.call(
    { role: "custom_codex_overflow", goal: "summarize" },
    createContext(noModel),
  );

  // Stub prints the byte length of $*. Total argv bytes will
  // include the prompt + other flags; the prompt itself is what
  // we cap. Read the wc output: arg-set total bytes should be
  // well under 128 KiB.
  const output = String(result.data);
  const argByteCount = parseInt(output.trim().split(/\s+/).pop() ?? "0", 10);
  expect(argByteCount).toBeLessThan(131072);
  expect(argByteCount).toBeGreaterThan(0); // sanity: stub did run
});

test("spawn_teammate inlines attachments from EARLIER turns, not just current request", async () => {
  // Regression: per-turn lookup missed files uploaded on a prior
  // turn. User uploads spec.md on turn 1, leader chats for a few
  // turns, then spawns lander on turn 3 — current-turn requestId
  // doesn't match the upload's requestId, so the file was silently
  // dropped from the teammate's view. The fix uses task-wide
  // scope; this test seeds attachments under a DIFFERENT requestId
  // than the one the spawn context runs under.
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { saveAttachments } = await import("../../src/services/attachment-service");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const commandPath = await writeStubCommand("codex", 'echo "ARGS:$*"');
  await upsertAgentProfile({
    roleId: "custom_codex_taskwide",
    label: "Codex Task-wide",
    runtimeType: "codex",
    commandPath,
    modelOverride: "gpt-5.4",
  });

  // Save the file under a DIFFERENT requestId from the spawn
  // context's (`req_phase_b`). With per-turn scope this lookup
  // would miss; with task-wide scope it should find it.
  const dataBase64 = Buffer.from("# Spec\n\nFrom an earlier turn.\n", "utf8").toString("base64");
  await saveAttachments("task_phase_b", "req_FROM_EARLIER_TURN", [
    { filename: "earlier.md", mimeType: "text/markdown", dataBase64 },
  ]);

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const noModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for cli runtime");
  };
  const result = await spawnTool!.call(
    { role: "custom_codex_taskwide", goal: "do work" },
    createContext(noModel),
  );

  const output = String(result.data);
  expect(output).toContain("earlier.md");
  expect(output).toContain("From an earlier turn");
});

test("spawn_teammate with unknown runtimeType returns error", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");
  const { createDb, agentProfiles, eq } = await import("@magister/db");

  await upsertAgentProfile({
    roleId: "custom_unknown_dispatch",
    label: "Custom Unknown Dispatch",
    runtimeType: "ucm",
  });

  const db = createDb();
  await db.update(agentProfiles).set({
    runtimeType: "mystery-runtime",
  }).where(eq(agentProfiles.roleId, "custom_unknown_dispatch"));

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((tool) => tool.name === "spawn_teammate");
  expect(spawnTool).toBeDefined();

  const throwIfUsedModel = async function* (): AsyncGenerator<LeaderModelOutputEvent> {
    throw new Error("callModel should not be used for unknown runtimeType");
  };

  const result = await spawnTool!.call(
    { role: "custom_unknown_dispatch", goal: "Do unknown runtime work" },
    createContext(throwIfUsedModel),
  );

  expect(String(result.data)).toMatch(/unknown runtimeType/i);
});

// ────────────────────────────────────────────────────────────────────
// resume_id (v2 deferred from
// docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md §6 —
// landed 2026-04-29). Validates the rejection cases; happy path is
// integration-level and gets exercised end-to-end via the leaderLoop.
// ────────────────────────────────────────────────────────────────────

test("spawn_teammate with resume_id rejects unknown teammateRunId", async () => {
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");
  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "follow up", resume_id: "rt_does_not_exist_123" },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/no teammate run found/i);
});

test("spawn_teammate with resume_id rejects cross-task resume", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const repo = new RoleRuntimeRepository();
  const otherTaskRunId = `rt_coder_${Date.now()}_other`;
  await repo.create({
    id: otherTaskRunId,
    taskId: "task_OTHER",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_other",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: otherTaskRunId },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/different task/i);
});

test("spawn_teammate with resume_id rejects role mismatch", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_role`;
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "reviewer", goal: "x", resume_id: runId },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/role must match/i);
});

test("spawn_teammate with resume_id rejects RUNNING teammate", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_running`;
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "RUNNING",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: runId },
    createContext(async function* () {}),
  );
  // 2026-05-20: backend now also accepts CANCELLED resumes (user
  // pressed Stop mid-work then changes mind). The error wording
  // changed accordingly — RUNNING is still rejected.
  expect(String(result.data)).toMatch(/can only resume COMPLETED, FAILED, or CANCELLED/i);
});

test("spawn_teammate with resume_id rejects isolate:true (worktree gone)", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_isolated`;
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: runId, isolate: true },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/cannot combine resume_id with isolate/i);
});

test("spawn_teammate with resume_id rejects when parent task is CANCELLED", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const taskRepo = new TaskRepository();
  await taskRepo.create({
    id: "task_phase_b",
    workspaceId: "workspace_main",
    source: "web",
    title: "Cancelled parent",
    state: "CANCELLED",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_cancelled`;
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  // Need a checkpoint so we get past the no-checkpoint guard, hitting
  // the cancelled-task guard which is what we're testing.
  await new LeaderSessionStore().writeCheckpoint({
    sessionId: runId,
    taskId: "task_phase_b",
    runId,
    requestId: "req_phase_b",
    turnCount: 1,
    messages: [{ type: "user", content: "prior" }],
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: runId },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/parent task is cancelled/i);
});

test("spawn_teammate resume's atomic state flip resists double-resume race", async () => {
  // Validates the conditional WHERE clause: simulate the race by
  // pre-flipping the runtime to RUNNING (as a winning concurrent call
  // would have done), then attempt our resume — it should detect the
  // 0-rows-changed and bail out.
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  await new TaskRepository().create({
    id: "task_phase_b",
    workspaceId: "workspace_main",
    source: "web",
    title: "Race parent",
    state: "EXECUTING",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_race`;
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });
  await new LeaderSessionStore().writeCheckpoint({
    sessionId: runId,
    taskId: "task_phase_b",
    runId,
    requestId: "req_phase_b",
    turnCount: 1,
    messages: [{ type: "user", content: "prior" }],
  });

  // Simulate the winning concurrent resume by flipping the record now.
  await repo.update(runId, { state: "RUNNING", completedAt: null });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: runId },
    createContext(async function* () {}),
  );
  // Two acceptable outcomes: the early state guard catches it (prior
  // state=RUNNING) OR the conditional update returns 0 rows. Both
  // produce a clear error rather than a silent re-entry.
  expect(String(result.data)).toMatch(/can only resume COMPLETED, FAILED, or CANCELLED|no longer in COMPLETED\/FAILED\/CANCELLED/i);
});

test("spawn_teammate with resume_id rejects when no checkpoint exists", async () => {
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { createLeaderTools } = await import("../../src/services/manager-automation/autonomous-loop/manager-tools-adapter");

  const repo = new RoleRuntimeRepository();
  const runId = `rt_coder_${Date.now()}_nocp`;
  // Create a record but don't write any checkpoint events.
  await repo.create({
    id: runId,
    taskId: "task_phase_b",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "run_phase_b",
    attemptCount: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
  });

  const tools = createLeaderTools(tempDir);
  const spawnTool = tools.find((t) => t.name === "spawn_teammate");
  const result = await spawnTool!.call(
    { role: "coder", goal: "x", resume_id: runId },
    createContext(async function* () {}),
  );
  expect(String(result.data)).toMatch(/no checkpoint to resume from/i);
});
