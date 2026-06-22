import { expect, test, describe, mock } from "bun:test";
import { createLeaderTools } from "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter";
import type { LeaderToolUseContext } from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";

// Spec: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md
//
// update_plan is the leader's session-level todo list. The runtime
// enforces two hard invariants on every call:
//   1. At most ONE item with status === "in_progress" at any time.
//   2. Any in_progress item MUST have a non-empty activeForm.
// Both reject by throwing — tool-execution converts that into a
// `tool_result` with `isError: true`, so the model sees a hard refusal
// and re-issues a corrected call.

function ctx(overrides: Partial<LeaderToolUseContext> = {}): LeaderToolUseContext {
  return {
    taskId: "task-1",
    runId: "run-1",
    requestId: "req-1",
    workspaceDir: "/tmp",
    abortController: new AbortController(),
    messages: [],
    tools: [],
    setInProgressToolUseIDs: mock(() => {}),
    getInProgressToolUseIDs: () => new Set(),
    recordEvent: mock(async () => {}),
    requestApproval: mock(async () => ({ decision: "approve" as const })),
    ...overrides,
  };
}

function getUpdatePlanTool() {
  const tools = createLeaderTools("/tmp");
  const tool = tools.find((t) => t.name === "update_plan");
  if (!tool) throw new Error("update_plan tool not registered");
  return tool;
}

describe("update_plan tool", () => {
  test("registered with correct safety classifications", () => {
    const tool = getUpdatePlanTool();
    // Single shared resource — concurrent updates would discard each
    // other's snapshots.
    expect(tool.isConcurrencySafe({})).toBe(false);
    // Plan tracking is the orchestration surface, must work in plan mode.
    expect(tool.isPlanSafe?.({})).toBe(true);
  });

  test("accepts a valid plan with one in_progress item", async () => {
    const tool = getUpdatePlanTool();
    const result = await tool.call(
      {
        todos: [
          { content: "Read the spec", activeForm: "Reading the spec", status: "completed" },
          { content: "Write the code", activeForm: "Writing the code", status: "in_progress" },
          { content: "Run tests", activeForm: "Running tests", status: "pending" },
        ],
      },
      ctx(),
    );
    expect(typeof result.data).toBe("string");
    expect(result.data).toContain("3 item");
    expect(result.data).toContain("1 in_progress");
    expect(result.data).toContain("1 completed");
  });

  test("accepts an all-completed plan (post-finish state)", async () => {
    const tool = getUpdatePlanTool();
    const result = await tool.call(
      {
        todos: [
          { content: "A", activeForm: "Doing A", status: "completed" },
          { content: "B", activeForm: "Doing B", status: "completed" },
        ],
      },
      ctx(),
    );
    expect(result.data).toContain("2 item");
    expect(result.data).toContain("0 in_progress");
  });

  test("rejects two in_progress items (the ONE-in-progress invariant)", async () => {
    const tool = getUpdatePlanTool();
    await expect(
      tool.call(
        {
          todos: [
            { content: "A", activeForm: "Doing A", status: "in_progress" },
            { content: "B", activeForm: "Doing B", status: "in_progress" },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/2 items are in_progress/);
  });

  test("rejects in_progress item with empty activeForm", async () => {
    const tool = getUpdatePlanTool();
    await expect(
      tool.call(
        {
          todos: [{ content: "Run tests", activeForm: "", status: "in_progress" }],
        },
        ctx(),
      ),
    ).rejects.toThrow(/missing activeForm/);
  });

  test("rejects in_progress item whose activeForm is whitespace-only", async () => {
    const tool = getUpdatePlanTool();
    await expect(
      tool.call(
        {
          todos: [{ content: "Run tests", activeForm: "   ", status: "in_progress" }],
        },
        ctx(),
      ),
    ).rejects.toThrow(/missing activeForm/);
  });

  test("accepts cancelled status (opencode parity — explicit retire vs silent drop)", async () => {
    const tool = getUpdatePlanTool();
    const result = await tool.call(
      {
        todos: [
          { content: "Old plan A", activeForm: "Doing A", status: "cancelled" },
          { content: "New plan B", activeForm: "Doing B", status: "in_progress" },
        ],
      },
      ctx(),
    );
    expect(result.data).toContain("1 cancelled");
  });

  test("accepts optional priority field", async () => {
    const tool = getUpdatePlanTool();
    const result = await tool.call(
      {
        todos: [
          { content: "Critical fix", activeForm: "Fixing critical bug", status: "in_progress", priority: "high" },
          { content: "Cleanup", activeForm: "Cleaning up", status: "pending", priority: "low" },
        ],
      },
      ctx(),
    );
    expect(result.data).toContain("2 item");
  });

  test("schema rejects an unknown status", () => {
    const tool = getUpdatePlanTool();
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "x", activeForm: "doing x", status: "blocked" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("schema requires content to be non-empty", () => {
    const tool = getUpdatePlanTool();
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "", activeForm: "doing it", status: "pending" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("schema requires activeForm to be non-empty (length validation, separate from in_progress invariant)", () => {
    const tool = getUpdatePlanTool();
    // Schema-level: activeForm is min(1) for ALL items, not just in_progress.
    // Even pending/completed items get an activeForm so the UI can surface
    // it consistently (e.g. when re-rendering the same item across status
    // transitions without losing the gerund label).
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "Done thing", activeForm: "", status: "completed" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("spawn_teammate concurrency classification", () => {
  test("isConcurrencySafe(true) when isolate is true", () => {
    const tools = createLeaderTools("/tmp");
    const spawn = tools.find((t) => t.name === "spawn_teammate");
    if (!spawn) throw new Error("spawn_teammate not registered");
    expect(spawn.isConcurrencySafe({ role: "coder", goal: "x", isolate: true })).toBe(true);
  });

  test("isConcurrencySafe(false) when isolate is false (workspace race)", () => {
    const tools = createLeaderTools("/tmp");
    const spawn = tools.find((t) => t.name === "spawn_teammate");
    if (!spawn) throw new Error("spawn_teammate not registered");
    expect(spawn.isConcurrencySafe({ role: "coder", goal: "x", isolate: false })).toBe(false);
  });

  test("isConcurrencySafe(false) when isolate is omitted (default false)", () => {
    const tools = createLeaderTools("/tmp");
    const spawn = tools.find((t) => t.name === "spawn_teammate");
    if (!spawn) throw new Error("spawn_teammate not registered");
    expect(spawn.isConcurrencySafe({ role: "coder", goal: "x" })).toBe(false);
  });
});
