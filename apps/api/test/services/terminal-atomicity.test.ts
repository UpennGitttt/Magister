/**
 * DP1 atomicity test — primary async terminal transition.
 *
 * Verifies that the task-state update, runtime-state update, and
 * terminal-event insert in `processTaskExecution`'s success path are
 * committed as a single SQLite transaction: if the event insert fails,
 * the task must NOT be left in a terminal state (i.e. the whole
 * transaction rolls back).
 *
 * Test strategy:
 * - Install a SQLite BEFORE INSERT trigger on execution_events that
 *   raises an error for terminal (task:*) event types. This fires
 *   inside the DP1 transaction and causes it to ABORT, rolling back
 *   all three staged writes.
 * - After the transaction aborts, the outer catch block in
 *   processTaskExecution writes FAILED non-atomically (DP1 documented
 *   gap). That write IS expected to succeed (trigger only fires on
 *   terminal event inserts).
 * - To observe the rollback separately from the catch write, we also
 *   intercept TaskRepository.prototype.update so the catch-path write
 *   throws, leaving the DB in the post-rollback state (EXECUTING).
 * - Assert task.state = "EXECUTING" → proves the transaction rolled
 *   back the taskRepo.update(FAILED) that was staged inside it.
 *
 * Harness: temp SQLite DB (same pattern as crash-recovery.test.ts /
 * turn-timing-terminal-event.test.ts). No mock.module — narrow
 * prototype spy restored in afterEach.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-terminal-atomicity-test");

// Prototype spy handle for afterEach restore.
let originalTaskUpdate: ((id: string, input: any, tx?: any) => Promise<void>) | null = null;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `atomicity-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: tempRoot,
  });
  const configPath = join(tempRoot, "executors.json");
  // No providers/bindings → leader loop returns { reason: "configuration_error" }
  // which flows through the PRIMARY ASYNC terminal write cluster (try block,
  // not the catch block), exercising the DP1 transaction.
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: { leader: { adapterId: "leader_api", strategy: "model_only" } },
      providers: {},
      models: {},
      bindings: {},
    }),
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
  originalTaskUpdate = null;
});

afterEach(async () => {
  // Restore prototype spy if it was installed.
  if (originalTaskUpdate !== null) {
    const { TaskRepository } = await import("../../src/repositories/task-repository");
    TaskRepository.prototype.update = originalTaskUpdate as any;
    originalTaskUpdate = null;
  }
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("DP1: terminal-event insert failure rolls back task + runtime state (transaction atomicity)", async () => {
  /**
   * This test proves that the three writes in the DP1 atomic block are
   * truly committed or rolled back together:
   *
   * 1. A SQLite BEFORE INSERT trigger is added to execution_events that
   *    raises ABORT for terminal event types (task:*). This fires inside
   *    the native SQLite transaction (getRawSqlite().transaction(() => {...})())
   *    and causes the entire transaction to roll back — including the
   *    taskRepo.update and runtimeRepo.update that ran before it.
   *
   * 2. A TaskRepository.update prototype spy throws on the SECOND terminal
   *    write for this task (the catch-path's non-atomic update), so that
   *    processTaskExecution itself throws after the rollback.
   *
   * 3. After the full run:
   *    - task.state = "EXECUTING" (not "FAILED") proves the transaction
   *      rolled back the first taskRepo.update(FAILED) that was staged inside it.
   *    - If atomicity were broken (pre-DP1 sequential writes), task.state
   *      would be "FAILED" because the first non-transactional update
   *      committed before the event insert was attempted.
   */
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { processTaskExecution } = await import("../../src/services/process-task-intent-service");
  const { getRawSqlite } = await import("@magister/db");

  const taskId = "task_dp1_atomicity_1";
  const runId = "rt_dp1_atomicity_1";
  const requestId = "req_dp1_atomicity_1";
  const now = new Date();

  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();

  await taskRepo.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "DP1 atomicity test task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  // Step 1: Install a SQLite BEFORE INSERT trigger that rejects terminal
  // event inserts. This fires inside the native SQLite transaction and
  // causes it to abort, rolling back the staged task + runtime updates.
  const sqlite = getRawSqlite();
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS dp1_reject_terminal_events
    BEFORE INSERT ON execution_events
    WHEN NEW.type LIKE 'task:%'
    BEGIN
      SELECT RAISE(ABORT, 'DP1 test: terminal event insert rejected');
    END
  `);

  // Step 2: Install TaskRepository.update spy that throws on the FIRST
  // terminal-state write to this task that goes through the repo method.
  // Note: the DP1 transaction uses db.update(tasks)...run() DIRECTLY
  // (bypassing TaskRepository.prototype.update), so the first call that
  // reaches this spy is the catch-path's non-atomic taskRepo.update(FAILED).
  // By throwing on it, we prevent catch from committing FAILED, leaving
  // the DB in the post-rollback state (EXECUTING) so we can assert atomicity.
  originalTaskUpdate = TaskRepository.prototype.update;
  let taskTerminalUpdateCount = 0;
  TaskRepository.prototype.update = async function (id: string, input: any, tx?: any) {
    const isTerminalForThisTask =
      id === taskId &&
      (input?.state === "FAILED" || input?.state === "DONE" || input?.state === "CANCELLED");
    if (isTerminalForThisTask) {
      taskTerminalUpdateCount++;
      // The DP1 transaction writes directly via drizzle .run() without
      // going through this method. The FIRST call here is the catch-path's
      // non-atomic write. Block it to prevent overwriting the rolled-back state.
      throw new Error("DP1 spy: catch-path taskRepo.update blocked");
    }
    return (originalTaskUpdate as any).call(this, id, input, tx);
  };

  // Run — processTaskExecution will throw because:
  //   a. DP1 tx aborts (trigger fires on event insert) → error propagates
  //   b. Outer catch block catches it, tries non-atomic writes
  //   c. taskRepo.update spy throws on catch-path attempt → propagates out
  let threwError = false;
  try {
    await processTaskExecution({
      taskId,
      runId,
      requestId,
      requestStartedAtMs: Date.now(),
      workspaceId: "workspace_main",
      prompt: "atomicity test",
    });
  } catch {
    threwError = true;
  }

  // Restore spy before final reads.
  TaskRepository.prototype.update = originalTaskUpdate as any;
  originalTaskUpdate = null;

  // Drop the trigger so it doesn't affect other tests.
  sqlite.run("DROP TRIGGER IF EXISTS dp1_reject_terminal_events");

  // processTaskExecution must have thrown.
  expect(threwError).toBe(true);

  // CRITICAL: task.state must NOT be "FAILED".
  // This proves the DP1 transaction rolled back the taskRepo.update(FAILED)
  // that was staged inside it. If atomicity were broken (pre-DP1 sequential
  // writes), the first taskRepo.update would have committed immediately and
  // task.state would be "FAILED" here despite the catch-path spy blocking.
  const task = await taskRepo.getById(taskId);
  expect(task?.state).not.toBe("FAILED");
  expect(task?.state).toBe("EXECUTING");

  // taskTerminalUpdateCount == 1: the catch-path taskRepo.update(FAILED) was
  // called (spy intercepted it) and threw, preventing the write. The DP1
  // transaction did NOT go through taskRepo.update (uses db.update()...run()
  // directly), so the count reflects only the catch-path attempt.
  // 0 would mean catch never tried to write (wrong path), >1 means spy leaked.
  expect(taskTerminalUpdateCount).toBe(1);
});

test("DP1: control — terminal writes succeed without trigger (happy path works end-to-end)", async () => {
  // Control: verify the DP1 transaction path succeeds when no trigger/spy
  // is installed. Task should be FAILED and a terminal event should exist.
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const { processTaskExecution } = await import("../../src/services/process-task-intent-service");

  const taskId = "task_dp1_control_1";
  const runId = "rt_dp1_control_1";
  const requestId = "req_dp1_control_1";
  const now = new Date();

  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();

  await taskRepo.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "DP1 control task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  await processTaskExecution({
    taskId,
    runId,
    requestId,
    requestStartedAtMs: Date.now(),
    workspaceId: "workspace_main",
    prompt: "control test",
  });

  const task = await taskRepo.getById(taskId);
  const runtime = await runtimeRepo.getById(runId);
  const events = new ExecutionEventRepository();
  const allEvents = await events.listByTaskId(taskId);
  const terminalEvent = allEvents.find(
    (e) => (e.type === "task:failed" || e.type === "task:completed") && e.requestId === requestId,
  );

  expect(task?.state).toBe("FAILED");
  expect(runtime?.state).toBe("FAILED");
  expect(terminalEvent).toBeDefined();
  // The terminal event and task.state must be consistent (both terminal).
  expect(terminalEvent?.type).toBe("task:failed");
});
