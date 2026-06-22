import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { runToolUse } from "../../../../src/services/manager-automation/autonomous-loop/tool-execution";
import type {
  LeaderTool,
  LeaderToolUseContext,
} from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

function makeContext(overrides: Partial<LeaderToolUseContext> = {}): LeaderToolUseContext {
  return {
    taskId: "task_test",
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: "/tmp",
    abortController: new AbortController(),
    messages: [],
    tools: [],
    getInProgressToolUseIDs: () => new Set(),
    setInProgressToolUseIDs: () => {},
    recordEvent: async () => {},
    ...overrides,
  };
}

function makeTool(opts: {
  name: string;
  isPlanSafe?: () => boolean;
  call?: () => Promise<{ data: string }>;
}): LeaderTool {
  return {
    name: opts.name,
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    ...(opts.isPlanSafe ? { isPlanSafe: opts.isPlanSafe } : {}),
    call: opts.call ?? (async () => ({ data: "ok" })),
  };
}

async function collectFirstMessage(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  tools: LeaderTool[],
  context: LeaderToolUseContext,
) {
  const updates: any[] = [];
  for await (const u of runToolUse(toolUse, tools, context)) {
    updates.push(u);
    if (u.message) break; // first message is enough for these tests
  }
  return updates;
}

describe("plan-mode gate at runToolUse dispatch site", () => {
  test("inPlanMode=false: tool runs normally regardless of isPlanSafe", async () => {
    const tool = makeTool({ name: "write_file", isPlanSafe: () => false });
    const updates = await collectFirstMessage(
      { id: "tu_1", name: "write_file", input: {} },
      [tool],
      makeContext({ inPlanMode: false }),
    );
    // Tool ran (no plan-mode error); the only message is the success result.
    expect(updates[0].message).toMatchObject({
      type: "tool_result",
      toolUseId: "tu_1",
    });
    expect(updates[0].message.isError).not.toBe(true);
  });

  test("inPlanMode=true + isPlanSafe=false: tool is gated with deterministic error", async () => {
    let called = false;
    const tool = makeTool({
      name: "write_file",
      isPlanSafe: () => false,
      call: async () => {
        called = true;
        return { data: "should not run" };
      },
    });
    const updates = await collectFirstMessage(
      { id: "tu_2", name: "write_file", input: {} },
      [tool],
      makeContext({ inPlanMode: true }),
    );
    expect(called).toBe(false);
    expect(updates[0].message).toMatchObject({
      type: "tool_result",
      toolUseId: "tu_2",
      isError: true,
    });
    expect(updates[0].message.content).toContain("write_file");
    expect(updates[0].message.content).toContain("plan mode");
  });

  test("inPlanMode=true + isPlanSafe=true: tool runs normally", async () => {
    const tool = makeTool({ name: "read_file", isPlanSafe: () => true });
    const updates = await collectFirstMessage(
      { id: "tu_3", name: "read_file", input: {} },
      [tool],
      makeContext({ inPlanMode: true }),
    );
    expect(updates[0].message).toMatchObject({
      type: "tool_result",
      toolUseId: "tu_3",
    });
    expect(updates[0].message.isError).not.toBe(true);
  });

  test("inPlanMode=true + isPlanSafe undefined: default-deny", async () => {
    let called = false;
    const tool = makeTool({
      name: "future_tool",
      // intentionally no isPlanSafe declared
      call: async () => {
        called = true;
        return { data: "should not run" };
      },
    });
    const updates = await collectFirstMessage(
      { id: "tu_4", name: "future_tool", input: {} },
      [tool],
      makeContext({ inPlanMode: true }),
    );
    expect(called).toBe(false);
    expect(updates[0].message).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect(updates[0].message.content).toContain("plan mode");
  });

  test("isPlanSafe receives parsed args (dynamic classifiers)", async () => {
    let receivedArgs: unknown = null;
    const tool: LeaderTool = {
      name: "bash",
      inputSchema: z.object({ command: z.string() }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: (args: { command: string }) => {
        receivedArgs = args;
        return args.command.startsWith("ls ");
      },
      call: async () => ({ data: "ok" }),
    };
    await collectFirstMessage(
      { id: "tu_5", name: "bash", input: { command: "ls /tmp" } },
      [tool],
      makeContext({ inPlanMode: true }),
    );
    expect(receivedArgs).toEqual({ command: "ls /tmp" });
  });
});
