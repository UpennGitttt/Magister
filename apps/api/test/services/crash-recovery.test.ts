import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import { LeaderSessionStore } from "../../src/services/leader-session-store";
import { recoverStaleTasks } from "../../src/services/crash-recovery-service";
import { buildResumeSystemPrompt } from "../../src/services/leader-session-resume-service";
import { classifyExecutionPolicy } from "../../src/services/leader-execution-policy-service";
import { LEADER_SYSTEM_PROMPT } from "../../src/services/manager-automation/teammate-system-prompts";

const tempRoot = join(process.cwd(), ".tmp-crash-recovery-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `crash-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("recoverStaleTasks marks EXECUTING tasks as FAILED when no checkpoint exists", async () => {
  const taskRepo = new TaskRepository();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_no_checkpoint_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Stale executing task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  const recovery = await recoverStaleTasks({ enqueueResume: () => {} });
  const task = await taskRepo.getById("task_crash_no_checkpoint_1");

  expect(task?.state).toBe("FAILED");
  expect(recovery).toEqual({ recovered: 0, failed: 1 });
});

test("recoverStaleTasks marks RUNNING runtimes as FAILED when no leader checkpoint", async () => {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_runtime_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Stale executing task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  // The latest runtime here is `coder` (no checkpoint) — the leader
  // requeue branch only fires when latestRuntime.roleId === "leader",
  // so this falls through to the FAILED branch.
  await runtimeRepo.create({
    id: "runtime_crash_running_1",
    taskId: "task_crash_runtime_1",
    roleId: "coder",
    state: "RUNNING",
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "runtime_crash_completed_1",
    taskId: "task_crash_runtime_1",
    roleId: "reviewer",
    state: "COMPLETED",
    updatedAt: now,
  });

  await recoverStaleTasks({ enqueueResume: () => {} });

  expect((await runtimeRepo.getById("runtime_crash_running_1"))?.state).toBe("FAILED");
  expect((await runtimeRepo.getById("runtime_crash_completed_1"))?.state).toBe("COMPLETED");
});

test("recoverStaleTasks REQUEUES tasks with a leader checkpoint instead of marking FAILED", async () => {
  // Regression coverage for the dev-restart-kills-tasks bug. Before
  // this fix, every `bun --watch` reload turned in-flight chats into
  // FAILED tasks because recoverStaleTasks always marked FAILED even
  // when a checkpoint existed (it logged "Recovered stale task" and
  // wrote FAILED in the next breath). Now it actually requeues.
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_checkpoint_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Stale executing task with checkpoint",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "runtime_crash_checkpoint_1",
    taskId: "task_crash_checkpoint_1",
    roleId: "leader",
    state: "RUNNING",
    updatedAt: now,
  });

  await sessionStore.writeCheckpoint({
    sessionId: "session_crash_checkpoint_1",
    taskId: "task_crash_checkpoint_1",
    runId: "runtime_crash_checkpoint_1",
    requestId: "req-fixture",
    turnCount: 2,
    messages: [
      { type: "user", content: "Fix bug" },
      { type: "assistant", content: [{ type: "text", text: "Working on it" }] },
    ],
  });

  const enqueued: Array<{ taskId: string; runId: string; messageCount: number }> = [];
  const recovery = await recoverStaleTasks({
    enqueueResume: (job) => {
      enqueued.push({
        taskId: job.taskId,
        runId: job.runId,
        messageCount: job.restoredMessages?.length ?? 0,
      });
    },
  });

  expect(recovery).toEqual({ recovered: 1, failed: 0 });
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]).toMatchObject({
    taskId: "task_crash_checkpoint_1",
    runId: "runtime_crash_checkpoint_1",
    messageCount: 2,
  });

  // Task state stays EXECUTING (loop will resume), runtime stays RUNNING.
  // The processTaskExecution entry will rewrite EXECUTING + bump
  // updatedAt; we just verify nothing transitioned to FAILED here.
  const task = await taskRepo.getById("task_crash_checkpoint_1");
  expect(task?.state).toBe("EXECUTING");
  const runtime = await runtimeRepo.getById("runtime_crash_checkpoint_1");
  expect(runtime?.state).toBe("RUNNING");
});

test("recoverStaleTasks falls back to FAILED when checkpoint exists but enqueue throws", async () => {
  // If the requeue path throws (e.g. taskWorker not available, DB
  // race), we still want a deterministic terminal state — mark FAILED
  // rather than leave EXECUTING dangling for the next dev restart to
  // wrestle with.
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_throw_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Requeue throw fixture",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await runtimeRepo.create({
    id: "runtime_crash_throw_1",
    taskId: "task_crash_throw_1",
    roleId: "leader",
    state: "RUNNING",
    updatedAt: now,
  });
  await sessionStore.writeCheckpoint({
    sessionId: "session_crash_throw_1",
    taskId: "task_crash_throw_1",
    runId: "runtime_crash_throw_1",
    requestId: "req-throw",
    turnCount: 1,
    messages: [{ type: "user", content: "go" }],
  });

  const recovery = await recoverStaleTasks({
    enqueueResume: () => {
      throw new Error("simulated worker unavailable");
    },
  });

  expect(recovery).toEqual({ recovered: 0, failed: 1 });
  expect((await taskRepo.getById("task_crash_throw_1"))?.state).toBe("FAILED");
});

test("recoverStaleTasks marks FAILED when checkpoint has empty message log", async () => {
  // An "empty checkpoint" (message log length 0) is a corrupted /
  // never-completed-first-turn case — there's nothing to resume from.
  // FAIL it rather than feed an empty message log into the loop.
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const sessionStore = new LeaderSessionStore();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_empty_ckpt_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Empty checkpoint fixture",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await runtimeRepo.create({
    id: "runtime_crash_empty_ckpt_1",
    taskId: "task_crash_empty_ckpt_1",
    roleId: "leader",
    state: "RUNNING",
    updatedAt: now,
  });
  await sessionStore.writeCheckpoint({
    sessionId: "session_crash_empty_ckpt_1",
    taskId: "task_crash_empty_ckpt_1",
    runId: "runtime_crash_empty_ckpt_1",
    requestId: "req-empty",
    turnCount: 0,
    messages: [],
  });

  const enqueued: unknown[] = [];
  const recovery = await recoverStaleTasks({
    enqueueResume: (job) => { enqueued.push(job); },
  });

  expect(recovery).toEqual({ recovered: 0, failed: 1 });
  expect(enqueued).toHaveLength(0);
  expect((await taskRepo.getById("task_crash_empty_ckpt_1"))?.state).toBe("FAILED");
});

test("recoverStaleTasks does nothing when no stale tasks exist", async () => {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const now = new Date("2026-04-23T10:00:00.000Z");

  await taskRepo.create({
    id: "task_crash_none_1",
    workspaceId: "workspace_main",
    source: "cli",
    title: "Completed task",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "runtime_crash_none_1",
    taskId: "task_crash_none_1",
    roleId: "coder",
    state: "RUNNING",
    updatedAt: now,
  });

  const recovery = await recoverStaleTasks();

  expect(recovery).toEqual({ recovered: 0, failed: 0 });
  expect((await taskRepo.getById("task_crash_none_1"))?.state).toBe("DONE");
  expect((await runtimeRepo.getById("runtime_crash_none_1"))?.state).toBe("RUNNING");
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for the resume system-prompt builder
// These test the pure `buildResumeSystemPrompt` helper exported from the resume
// service. Intercepting `runLeaderRuntime` in this test file is impractical
// because crash-recovery-service only calls `enqueueResume` (worker RPC) — it
// never directly invokes the resume service here. The pure helper gives us
// 100% coverage of the composition logic without I/O.
// ──────────────────────────────────────────────────────────────────────────────
describe("buildResumeSystemPrompt", () => {
  test("contains canonical LEADER_SYSTEM_PROMPT marker (not the old minimal prompt)", () => {
    const policy = classifyExecutionPolicy({ prompt: "", source: "feishu", availableRoles: [] });
    const resumePolicy = { ...policy, source: "resume_recovered" as const };
    const result = buildResumeSystemPrompt(LEADER_SYSTEM_PROMPT, resumePolicy, []);

    // Canonical marker from LEADER_SYSTEM_PROMPT
    expect(result).toContain("LEADER agent in Magister");
    // Must NOT contain the old minimal-prompt text that lost the persona
    expect(result).not.toContain("helpful AI assistant");
  });

  test("contains execution policy addendum", () => {
    const policy = classifyExecutionPolicy({ prompt: "Fix the bug", source: "feishu", availableRoles: [] });
    const resumePolicy = { ...policy, source: "resume_recovered" as const };
    const result = buildResumeSystemPrompt(LEADER_SYSTEM_PROMPT, resumePolicy, []);

    // The policy addendum header from buildExecutionPolicyPrompt
    expect(result).toContain("Execution policy for this turn");
  });

  test("policy source is overridden to resume_recovered", () => {
    const policy = classifyExecutionPolicy({ prompt: "implement something", source: "feishu", availableRoles: [] });
    const resumePolicy = { ...policy, source: "resume_recovered" as const };

    expect(resumePolicy.source).toBe("resume_recovered");
    // The base LEADER_SYSTEM_PROMPT is preserved in the composed result
    const result = buildResumeSystemPrompt(LEADER_SYSTEM_PROMPT, resumePolicy, []);
    expect(result).toContain("LEADER agent in Magister");
  });

  test("composed prompt separates base from policy with a blank line", () => {
    const policy = classifyExecutionPolicy({ prompt: "", source: "feishu", availableRoles: [] });
    const resumePolicy = { ...policy, source: "resume_recovered" as const };
    const result = buildResumeSystemPrompt("BASE_MARKER", resumePolicy, []);

    // buildSystemPromptWithPolicy joins with "\n\n"
    expect(result.startsWith("BASE_MARKER\n\n")).toBe(true);
  });
});
