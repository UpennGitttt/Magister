import { describe, expect, test } from "bun:test";

import { createLeaderTools } from "../../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter";
import type {
  LeaderLoopEvent,
  LeaderTool,
  LeaderToolUseContext,
} from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

function makeContext(overrides: Partial<LeaderToolUseContext> = {}): {
  context: LeaderToolUseContext;
  events: LeaderLoopEvent[];
} {
  const events: LeaderLoopEvent[] = [];
  const context: LeaderToolUseContext = {
    taskId: "task_test",
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: "/tmp",
    abortController: new AbortController(),
    messages: [],
    tools: [],
    getInProgressToolUseIDs: () => new Set(),
    setInProgressToolUseIDs: () => {},
    recordEvent: async (event: LeaderLoopEvent) => {
      events.push(event);
    },
    ...overrides,
  };
  return { context, events };
}

function findTool(name: string): LeaderTool {
  const tools = createLeaderTools("/tmp");
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe("enter_plan_mode tool", () => {
  test("emits leader.plan_mode_entered event and returns success", async () => {
    const tool = findTool("enter_plan_mode");
    const { context, events } = makeContext({ turnIndex: 7 });
    const result = await tool.call({}, context);

    expect((result.data as { success: boolean }).success).toBe(true);
    expect((result.data as { state: string }).state).toBe("PLANNING");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("leader.plan_mode_entered");
    expect(events[0]?.data).toMatchObject({
      taskId: "task_test",
      requestId: "req_test",
      runId: "run_test",
      // Spec §9 — attribute the entry to the turn that called us.
      turnIndex: 7,
    });
  });

  test("plan_mode_entered defaults turnIndex to 1 when context omits it", async () => {
    const tool = findTool("enter_plan_mode");
    const { context, events } = makeContext();
    await tool.call({}, context);
    expect((events[0]?.data as { turnIndex: number }).turnIndex).toBe(1);
  });

  test("declares isPlanSafe = true (so plan-mode-entered isn't gated by itself)", () => {
    const tool = findTool("enter_plan_mode");
    expect(tool.isPlanSafe?.({})).toBe(true);
  });
});

describe("exit_plan_mode tool", () => {
  test("emits leader.plan_proposed with full plan markdown and returns halt instruction", async () => {
    const tool = findTool("exit_plan_mode");
    // Spec §7.2 IDLE guard: exit_plan_mode requires inPlanMode === true.
    const { context, events } = makeContext({ inPlanMode: true });
    const planMarkdown = "## Plan\n\n1. Refactor X\n2. Test Y\n3. Ship";
    const result = await tool.call({ plan: planMarkdown }, context);

    expect((result.data as { success: boolean }).success).toBe(true);
    expect((result.data as { state: string }).state).toBe("AWAITING_APPROVAL");
    // The halt-instruction string is what the model sees as tool_result;
    // it MUST tell the model to stop.
    expect((result.data as { instruction: string }).instruction).toContain("STOP");
    expect((result.data as { instruction: string }).instruction).toContain("approval");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("leader.plan_proposed");
    // Full plan markdown — not truncated like inputSummary.
    expect(events[0]?.data.plan).toBe(planMarkdown);
    expect(events[0]?.data).toMatchObject({
      taskId: "task_test",
      requestId: "req_test",
      runId: "run_test",
    });
  });

  test("rejects empty plan via input schema", () => {
    const tool = findTool("exit_plan_mode");
    const parsed = tool.inputSchema.safeParse({ plan: "" });
    expect(parsed.success).toBe(false);
  });

  test("rejects oversized plan via input schema (>20000 chars)", () => {
    const tool = findTool("exit_plan_mode");
    const parsed = tool.inputSchema.safeParse({ plan: "x".repeat(20001) });
    expect(parsed.success).toBe(false);
  });

  test("declares isPlanSafe = true (so the halt itself isn't gated)", () => {
    const tool = findTool("exit_plan_mode");
    expect(tool.isPlanSafe?.({ plan: "..." })).toBe(true);
  });

  test("throws when called outside plan mode (spec §7.2 IDLE guard)", async () => {
    const tool = findTool("exit_plan_mode");
    const { context, events } = makeContext({ inPlanMode: false });
    // tool-execution.ts catches the throw and emits a tool_result with
    // isError:true. The unit-level contract here is just: it throws,
    // and no event is emitted.
    await expect(tool.call({ plan: "## Plan\n- step 1" }, context)).rejects.toThrow(/plan mode/);
    expect(events).toHaveLength(0);
  });
});

describe("enter_plan_mode tool — already-in-plan no-op (spec §7.1)", () => {
  test("does NOT emit a duplicate event when called while already in plan mode", async () => {
    const tool = findTool("enter_plan_mode");
    const { context, events } = makeContext({ inPlanMode: true });
    const result = await tool.call({}, context);
    expect((result.data as { success: boolean }).success).toBe(true);
    expect((result.data as { alreadyInPlanMode?: boolean }).alreadyInPlanMode).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe("plan tools registry / teammate exclusion", () => {
  test("both tools appear in the unfiltered leader registry", () => {
    const tools = createLeaderTools("/tmp");
    const names = tools.map((t) => t.name);
    expect(names).toContain("enter_plan_mode");
    expect(names).toContain("exit_plan_mode");
  });

  test("named tool profiles exclude plan tools", async () => {
    const { filterToolsByProfile } = await import(
      "../../../../src/services/manager-automation/tool-profiles"
    );
    const tools = createLeaderTools("/tmp");
    for (const profileId of ["full", "coding", "research", "minimal"] as const) {
      const filtered = filterToolsByProfile(tools, profileId);
      const names = filtered.map((t) => t.name);
      expect(names).not.toContain("enter_plan_mode");
      expect(names).not.toContain("exit_plan_mode");
    }
  });
});
