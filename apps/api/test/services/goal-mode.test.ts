/**
 * Goal-mode (Ralph loop) regression tests. Per kimi review #11
 * — the highest-value missing test was: a goal turn that ends
 * WITHOUT mark_goal_complete should auto-write a continuation
 * mailbox row + re-enqueue, and the task state must stay in
 * non-terminal so the next worker tick continues the loop.
 *
 * We can't easily exercise the full leader runtime in a unit
 * test, so we drive `processTaskExecution` with a stubbed
 * `executeLeaderLoop` import via `process.env.MAGISTER_TEST_*`
 * — actually we don't have a test seam for that. Instead, this
 * test exercises the smaller surface that's safe to call
 * directly: the worker hook only runs after a leader turn
 * completes, and the rest of the chain is straightforward.
 *
 * Test strategy: call the goal endpoints directly and assert
 * DB state. Higher-level wiring (the actual continuation
 * mailbox write) is exercised by an end-to-end smoke against
 * the running stack, captured in the commit message.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "goal-mode-test-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("mark_goal_complete tool flips task.goalStatus to complete", async () => {
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  // Seed a goal-active task.
  const db = createDb();
  const taskId = "task_goal_complete_test";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Test goal",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "Do the thing.",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 2,
    goalTokensUsed: 0,
    goalLastVerifierVerdict: "READY",
    goalLastVerifierAt: Date.now(),
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  expect(tool).toBeDefined();

  // Call the tool with a fake context.
  const context = {
    taskId,
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: tempDir,
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: () => {},
    getInProgressToolUseIDs: () => new Set<string>(),
    recordEvent: async () => {},
    callModel: async function* () {} as any,
  };
  const result = await tool!.call(
    { summary: "Done; verified by running tests.", evidence: ["abc1234"] },
    context as any,
  );

  expect(String(result.data)).toContain("Goal marked complete");
  // Verify DB state.
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("complete");
});

test("mark_goal_complete({ trivial: true }) skips the evaluator gate", async () => {
  // For trivial / conversational goals (greeting, single Q&A) the
  // leader self-classifies as trivial and we skip the verifier
  // gate — there's nothing for an evaluator to verify. The DB row
  // has NO verifier verdict ever recorded; the standard path would
  // refuse. Trivial path must succeed.
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_goal_trivial_test";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Trivial goal",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "你好",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    // Crucially: no verifier verdict. Standard path would refuse.
    goalLastVerifierVerdict: null,
    goalLastVerifierAt: null,
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  const context = {
    taskId,
    runId: "run_trivial",
    requestId: "req_trivial",
    workspaceDir: tempDir,
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: () => {},
    getInProgressToolUseIDs: () => new Set<string>(),
    recordEvent: async () => {},
    callModel: async function* () {} as any,
  };

  const result = await tool!.call(
    { summary: "Replied to user greeting.", trivial: true },
    context as any,
  );

  expect(String(result.data)).toContain("trivial path");
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("complete");
});

// ── GOAL-1: evaluator BLOCKED verdict enforcement ─────────────────────────

function makeContext(taskId: string, workspaceDir: string) {
  return {
    taskId,
    runId: `run_${taskId}`,
    requestId: `req_${taskId}`,
    workspaceDir,
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: () => {},
    getInProgressToolUseIDs: () => new Set<string>(),
    recordEvent: async () => {},
    callModel: async function* () {} as any,
  };
}

test("GOAL-1: BLOCKED verdict + mark_goal_complete without force → refused", async () => {
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_goal_blocked_refused";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Test BLOCKED gate",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "Ship feature X.",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 1,
    goalTokensUsed: 0,
    goalLastVerifierVerdict: "BLOCKED",
    goalLastVerifierBlocker: "Tests are still failing.",
    goalLastVerifierAt: Date.now(),
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  expect(tool).toBeDefined();

  const result = await tool!.call(
    { summary: "Done, I think." },
    makeContext(taskId, tempDir) as any,
  );

  // Must be refused.
  expect(String(result.data)).toContain("Refused");
  expect(String(result.data)).toContain("BLOCKED");
  expect(String(result.data)).toContain("Tests are still failing.");
  // Task must still be active.
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("active");
});

test("GOAL-1: BLOCKED verdict + trivial:true (iteration 0) → still refused (no trivial bypass)", async () => {
  // Regression: `trivial: true` must NOT bypass the BLOCKED gate. Use
  // iteration 0 so the trivial-only-at-iteration-0 guard does NOT fire —
  // the ONLY thing that can refuse here is the BLOCKED gate. Before the fix
  // the gate was skipped for trivial, so an iteration-0 trivial call would
  // wrongly complete a BLOCKED goal.
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_goal_blocked_trivial_bypass";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Test BLOCKED gate vs trivial bypass",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "Ship feature X.",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 0,
    goalTokensUsed: 0,
    goalLastVerifierVerdict: "BLOCKED",
    goalLastVerifierBlocker: "Tests are still failing.",
    goalLastVerifierAt: Date.now(),
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  const result = await tool!.call(
    { summary: "Trivial, nothing to do.", trivial: true },
    makeContext(taskId, tempDir) as any,
  );

  expect(String(result.data)).toContain("Refused");
  expect(String(result.data)).toContain("BLOCKED");
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("active");
});

test("GOAL-1: BLOCKED verdict + force:true → allowed", async () => {
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_goal_blocked_forced";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Test BLOCKED gate with force",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "Ship feature X.",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 1,
    goalTokensUsed: 0,
    goalLastVerifierVerdict: "BLOCKED",
    goalLastVerifierBlocker: "Tests are still failing.",
    goalLastVerifierAt: Date.now(),
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  expect(tool).toBeDefined();

  const result = await tool!.call(
    { summary: "Fixed the failing tests before evaluator re-ran. Forcing.", force: true },
    makeContext(taskId, tempDir) as any,
  );

  // Must succeed.
  expect(String(result.data)).toContain("Goal marked complete");
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("complete");
});

test("GOAL-1: no BLOCKED verdict → allowed as before", async () => {
  const { createDb, tasks, eq } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_goal_no_blocked";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Test no BLOCKED verdict",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    goalObjective: "Ship feature X.",
    goalStatus: "active",
    goalStartedAt: now.getTime(),
    goalIterations: 1,
    goalTokensUsed: 0,
    goalLastVerifierVerdict: "READY",
    goalLastVerifierBlocker: null,
    goalLastVerifierAt: Date.now(),
  });

  const tools = createLeaderTools(tempDir, undefined, undefined);
  const tool = tools.find((t) => t.name === "mark_goal_complete");
  expect(tool).toBeDefined();

  const result = await tool!.call(
    { summary: "All criteria met; evaluator returned READY." },
    makeContext(taskId, tempDir) as any,
  );

  // Must succeed (READY verdict, no BLOCKED gate).
  expect(String(result.data)).toContain("Goal marked complete");
  const after = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  expect(after?.goalStatus).toBe("complete");
});

test("teammate roles do NOT receive mark_goal_complete tool", async () => {
  // Kimi review #5: a coder/reviewer/architect spawned as a
  // teammate inherits the parent's taskId via context, so without
  // the leader-only gate they could prematurely complete the
  // parent's goal. Confirm it's filtered out.
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const leaderTools = createLeaderTools(tempDir, undefined, undefined);
  expect(leaderTools.find((t) => t.name === "mark_goal_complete")).toBeDefined();

  const coderTools = createLeaderTools(tempDir, undefined, undefined, { callerRoleId: "coder" });
  expect(coderTools.find((t) => t.name === "mark_goal_complete")).toBeUndefined();

  const reviewerTools = createLeaderTools(tempDir, undefined, undefined, { callerRoleId: "reviewer" });
  expect(reviewerTools.find((t) => t.name === "mark_goal_complete")).toBeUndefined();
});

test("mark_goal_complete is a no-op on a task without goal_objective", async () => {
  const { createDb, tasks } = await import("@magister/db");
  const { createLeaderTools } = await import(
    "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
  );

  const db = createDb();
  const taskId = "task_no_goal";
  const now = new Date();
  await db.insert(tasks).values({
    id: taskId,
    workspaceId: "ws_test",
    source: "web",
    title: "Plain task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
    // no goal fields
  });

  const tool = createLeaderTools(tempDir, undefined, undefined).find(
    (t) => t.name === "mark_goal_complete",
  );
  const context = {
    taskId,
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: tempDir,
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: () => {},
    getInProgressToolUseIDs: () => new Set<string>(),
    recordEvent: async () => {},
    callModel: async function* () {} as any,
  };
  const result = await tool!.call(
    { summary: "Should be a no-op since no goal." },
    context as any,
  );
  expect(String(result.data)).toMatch(/no-op/i);
});
