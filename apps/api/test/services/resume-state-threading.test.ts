/**
 * Tests for resume-state threading in leader-session-resume-service.
 *
 * Verifies that:
 *   1. startTurnCount + restoredDoomState are passed through to runLeaderRuntime
 *   2. Persisted executionPolicy is preferred over reclassification (gated reclassify)
 *   3. A terminal event is emitted after the resume outcome
 *
 * Isolation: mock.module is scoped to manager-autonomous-runtime (all exports
 * provided so downstream named-import validation passes). afterAll(() =>
 * mock.restore()) ensures the registration is torn down before the next test
 * file's module graph is evaluated — matching the proven pattern in
 * leader-safe-apply-isolation.test.ts.
 *
 * Non-runtime services (workspace, executor config, tavily, ws/hub, etc.) use
 * real implementations backed by MAGISTER_DB_PATH and MAGISTER_EXECUTOR_CONFIG_PATH
 * env vars set per-test in beforeEach. No partial-export mocks for those modules
 * means they cannot poison other test files.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Module mocks must be declared before any import that pulls in the
//    modules being mocked (bun:test evaluates mock.module hoisting-style).
//
//    Only manager-autonomous-runtime is mocked. All three function exports are
//    provided so that process-task-intent-service and teammate-system-prompts
//    (which statically import named exports from this module) don't throw
//    SyntaxError when evaluated by sibling test files in the same worker process.

type RuntimeConfig = {
  taskId: string;
  runId: string;
  requestId: string;
  workspaceDir: string;
  systemPrompt: string;
  initialPrompt: string;
  restoredMessages: unknown[];
  executionPolicy?: { mode: string; source: string; [k: string]: unknown };
  startTurnCount?: number;
  restoredDoomState?: unknown;
  abortController?: AbortController;
  [key: string]: unknown;
};

let runtimeCalls: RuntimeConfig[] = [];
let runtimeBehavior: (config: RuntimeConfig) => Promise<{
  reason: string;
  turnCount: number;
  messages: Array<{ type: string; content: unknown }>;
}>;

mock.module(
  "../../src/services/manager-automation/autonomous-loop/manager-autonomous-runtime",
  () => ({
    buildLeaderRuntimeModelConfig: (apiConfig: { model: { modelName: string } }) => ({
      modelName: apiConfig.model.modelName,
    }),
    resolveLeaderRuntimeTools: async () => ({ tools: [], maxTurns: 60 }),
    runLeaderRuntime: (config: RuntimeConfig) => {
      runtimeCalls.push(config);
      return runtimeBehavior(config);
    },
  }),
);

// ── After mocks, import the actual module under test ──────────────────────
import { resumeLeaderFromCheckpoint } from "../../src/services/leader-session-resume-service";
import { LeaderSessionStore } from "../../src/services/leader-session-store";
import { TaskRepository } from "../../src/repositories/task-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { classifyExecutionPolicy } from "../../src/services/leader-execution-policy-service";
import type { ExecutionPolicy } from "../../src/services/leader-execution-policy-service";

const tempRoot = join(process.cwd(), ".tmp-resume-threading-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  const dbPath = join(
    tempRoot,
    `resume-threading-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_DB_PATH = dbPath;
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: "/tmp/test-workspace",
  });

  // Write a structurally complete executors.json so that the real
  // readExecutorConfigFile + resolveApiConfigFromRoleRouting return a valid
  // ApiConfig (not null), avoiding the need to mock executor-config-service or
  // process-task-intent-service.
  const configPath = join(tempRoot, "executors.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {
        leader: { adapterId: "leader-test", strategy: "model_only" },
      },
      providers: {
        provider_test: {
          label: "Test Provider",
          vendor: "test",
          transport: "api",
          apiDialect: "openai_chat_completions",
          auth: { kind: "none" },
          baseUrl: "http://localhost:9999",
        },
      },
      models: {
        model_test: {
          label: "Test Model",
          vendor: "test",
          modelName: "test-model",
          providerRefs: { api: "provider_test" },
        },
      },
      bindings: {
        "leader-test": {
          executionMode: "api",
          modelRef: "model_test",
          providerRef: "provider_test",
        },
      },
    }),
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;

  runtimeCalls = [];
  runtimeBehavior = async () => ({
    reason: "completed",
    turnCount: 11,
    messages: [
      { type: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  });
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  // Tear down all mock.module registrations after the entire file completes.
  // In bun 1.x, mock.restore() in afterAll is the reliable path to undo
  // mock.module — confirmed by A/B: leader-safe-apply-isolation.test.ts uses
  // the same pattern and does not leak into sibling test files.
  mock.restore();
});

/**
 * Build a structurally valid ExecutionPolicy by calling the real classifier,
 * then stamping the desired source/mode. This avoids seeding malformed policy
 * objects that crash buildSystemPromptWithPolicy (which checks policy.constraints).
 */
function makePolicy(
  mode: ExecutionPolicy["mode"],
  source: ExecutionPolicy["source"],
): ExecutionPolicy {
  // Use a prompt that naturally produces "delegated_coding" or fall through;
  // we override mode+source after so the exact prompt doesn't matter.
  const base = classifyExecutionPolicy({
    prompt: "implement the feature for the coder",
    source: "feishu",
    availableRoles: ["coder"],
  });
  return { ...base, mode, source };
}

async function seedCheckpointFixture(opts: {
  taskId: string;
  runId: string;
  sessionId: string;
  turnCount: number;
  executionPolicy?: ExecutionPolicy;
  doomState?: object;
}) {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-05-31T00:00:00.000Z");

  await taskRepo.create({
    id: opts.taskId,
    workspaceId: "workspace_main",
    source: "cli",
    title: "Resume threading fixture",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: opts.runId,
    taskId: opts.taskId,
    roleId: "leader",
    state: "RUNNING",
    updatedAt: now,
  });

  await sessionStore.writeCheckpoint({
    sessionId: opts.sessionId,
    taskId: opts.taskId,
    runId: opts.runId,
    requestId: "req-fixture",
    turnCount: opts.turnCount,
    messages: [
      { type: "user", content: "implement the feature" },
      { type: "assistant", content: [{ type: "text", text: "working" }] },
    ],
    ...(opts.executionPolicy !== undefined ? { executionPolicy: opts.executionPolicy } : {}),
    ...(opts.doomState !== undefined ? { doomState: opts.doomState as never } : {}),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("resume state threading", () => {
  test("Part 1: threads startTurnCount + restoredDoomState into runLeaderRuntime", async () => {
    const taskId = "task_resume_threading_1";
    const runId = "runtime_resume_threading_1";

    const doomState = { recentHashes: ["aaa", "bbb"], blockCount: 0 };

    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_threading_1",
      turnCount: 9,
      executionPolicy: makePolicy("delegated_coding", "runtime_escalation"),
      doomState,
    });

    const result = await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    expect(result.ok).toBe(true);
    expect(runtimeCalls).toHaveLength(1);
    const call = runtimeCalls[0]!;

    // Part 1: startTurnCount must be the checkpoint's turnCount (9), not
    // undefined or 0 — the core bug this change fixes.
    expect(call.startTurnCount).toBe(9);

    // Part 1: restoredDoomState must be threaded through so the detector
    // doesn't lose its fingerprint window across crash/restart.
    expect(call.restoredDoomState).toEqual(doomState);
  });

  test("Part 2: prefers persisted executionPolicy (mode + source unchanged — NOT reclassified)", async () => {
    const taskId = "task_resume_policy_persisted_1";
    const runId = "runtime_resume_policy_persisted_1";

    // Simulate an escalated policy that was stored during a prior run.
    const persistedPolicy = makePolicy("delegated_coding", "runtime_escalation");

    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_policy_persisted_1",
      turnCount: 9,
      executionPolicy: persistedPolicy,
    });

    await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    expect(runtimeCalls).toHaveLength(1);
    const call = runtimeCalls[0]!;

    // Persisted policy must survive unchanged — NOT reclassified to "resume_recovered".
    expect(call.executionPolicy?.mode).toBe("delegated_coding");
    expect(call.executionPolicy?.source).toBe("runtime_escalation");
  });

  test("Part 2: reclassifies with source 'resume_recovered' when checkpoint has no policy (legacy fallback)", async () => {
    const taskId = "task_resume_policy_legacy_1";
    const runId = "runtime_resume_policy_legacy_1";

    // No executionPolicy in checkpoint → should reclassify.
    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_policy_legacy_1",
      turnCount: 3,
      // executionPolicy intentionally absent
    });

    await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    expect(runtimeCalls).toHaveLength(1);
    const call = runtimeCalls[0]!;

    // Must have reclassified with source "resume_recovered"
    expect(call.executionPolicy?.source).toBe("resume_recovered");
  });

  test("Part 3: emits terminal task:completed event after successful resume", async () => {
    const taskId = "task_resume_terminal_1";
    const runId = "runtime_resume_terminal_1";

    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_terminal_1",
      turnCount: 2,
    });

    runtimeBehavior = async () => ({
      reason: "completed",
      turnCount: 4,
      messages: [
        { type: "assistant", content: [{ type: "text", text: "finished" }] },
      ],
    });

    await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    // The terminal event must have been persisted to execution_events.
    const eventRepo = new ExecutionEventRepository();
    const events = await eventRepo.listByTaskIdAndTypes(taskId, [
      "task:completed",
      "task:failed",
    ]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const terminalEvent = events[0]!;
    expect(terminalEvent.type).toBe("task:completed");
    const payload = JSON.parse(terminalEvent.payloadJson ?? "{}");
    expect(payload.state).toBe("DONE");
  });

  test("Part 3: emits terminal task:failed event when resume loop throws", async () => {
    const taskId = "task_resume_terminal_fail_1";
    const runId = "runtime_resume_terminal_fail_1";

    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_terminal_fail_1",
      turnCount: 1,
    });

    runtimeBehavior = async () => {
      throw new Error("simulated loop failure");
    };

    const result = await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");

    const eventRepo = new ExecutionEventRepository();
    const events = await eventRepo.listByTaskIdAndTypes(taskId, [
      "task:completed",
      "task:failed",
    ]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const terminalEvent = events[0]!;
    expect(terminalEvent.type).toBe("task:failed");

    // P1-fix-d: the TASK ROW must also be marked FAILED (not left
    // EXECUTING). Before the fix the catch only failed the runtime, so the
    // task stayed EXECUTING forever and the reaper kept re-reaping it.
    const failedTask = await new TaskRepository().getById(taskId);
    expect(failedTask?.state).toBe("FAILED");
    expect(failedTask?.completedAt).toBeTruthy();
  });

  test("#43: CANCELLED task row → runtime CANCELLED + task:cancelled terminal event (not FAILED/failed)", async () => {
    // Simulate a cancel-during-resume: the resume loop returns an aborted reason
    // (NOT a throw), but the /stop route already stamped the task CANCELLED.
    const taskId = "task_resume_cancelled_43";
    const runId = "runtime_resume_cancelled_43";

    await seedCheckpointFixture({
      taskId,
      runId,
      sessionId: "session_resume_cancelled_43",
      turnCount: 3,
    });

    // Simulate the /stop route stamping CANCELLED while the loop is running:
    // runtimeBehavior mutates the task row mid-flight (just before returning
    // the aborted reason), which is what the real cancel route does.
    const taskRepo = new TaskRepository();
    runtimeBehavior = async () => {
      // The /stop route fires during execution — stamp CANCELLED now.
      await taskRepo.update(taskId, { state: "CANCELLED", updatedAt: new Date() });
      // Loop returns aborted reason (cancel surfaces as reason, not throw).
      return {
        reason: "aborted_cancelled",
        turnCount: 3,
        messages: [],
      };
    };

    await resumeLeaderFromCheckpoint({
      taskId,
      runId,
      workspaceId: "workspace_main",
    });

    // Runtime record must be CANCELLED (not FAILED).
    const runtimeRepo = new RoleRuntimeRepository();
    const runtime = await runtimeRepo.getById(runId);
    expect(runtime?.state).toBe("CANCELLED");

    // Terminal event must be task:cancelled (not task:failed).
    const eventRepo = new ExecutionEventRepository();
    const events = await eventRepo.listByTaskIdAndTypes(taskId, [
      "task:completed",
      "task:failed",
      "task:cancelled",
    ]);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const terminal = events[0]!;
    expect(terminal.type).toBe("task:cancelled");
    const payload = JSON.parse(terminal.payloadJson ?? "{}");
    expect(payload.state).toBe("CANCELLED");
  });
});
