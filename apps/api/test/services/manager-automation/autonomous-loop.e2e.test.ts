import { expect, test, describe, mock } from "bun:test";
import { leaderLoop } from "../../../src/services/manager-automation/autonomous-loop/autonomous-loop-service";
import {
  createTeammateContext,
  runWithTeammateContext,
} from "../../../src/services/manager-automation/autonomous-loop/teammate-context";
import type {
  LeaderTool,
  LeaderToolUseContext,
  LeaderMessage,
  LeaderAssistantMessage,
  LeaderLoopParams,
  LeaderLoopEvent,
  LeaderToolResultMessage,
  LeaderModelCallParams,
} from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";
import type { DoomLoopSnapshot } from "../../../src/services/manager-automation/autonomous-loop/doom-loop-detector";
import { z } from "zod";

function createMockTool(
  name: string,
  options: {
    isConcurrencySafe?: boolean;
    isReadOnly?: boolean;
    isPlanSafe?: boolean;
    inputSchema?: z.ZodType<any>;
    callImpl?: (input: any, context: LeaderToolUseContext) => Promise<any>;
  } = {}
): LeaderTool {
  const schema = options.inputSchema ?? z.record(z.string(), z.any());
  return {
    name,
    inputSchema: schema,
    call: options.callImpl ?? (async () => ({ data: "ok" })),
    isConcurrencySafe: () => options.isConcurrencySafe ?? true,
    isReadOnly: () => options.isReadOnly ?? true,
    isPlanSafe: () => options.isPlanSafe ?? false,
  };
}

function createMockCallModel(
  turnResponses: LeaderAssistantMessage[][]
): LeaderLoopParams["callModel"] {
  let turnIndex = 0;

  return async function* (params: LeaderModelCallParams) {
    const responses = turnResponses[turnIndex] ?? [
      { type: "assistant" as const, content: [{ type: "text" as const, text: "Default response" }] },
    ];
    turnIndex++;

    for (const msg of responses) {
      yield msg;
    }
  };
}

function createTestParams(
  overrides: Partial<LeaderLoopParams> & {
    turnResponses?: LeaderAssistantMessage[][];
  } = {}
): LeaderLoopParams {
  const abortController = new AbortController();
  const events: LeaderLoopEvent[] = [];

  const callModel = overrides.callModel ?? createMockCallModel(
    overrides.turnResponses ?? [
      [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Default response" }] }],
    ]
  );

  const defaultMessages: LeaderMessage[] = [
    { type: "user", content: "Test request" },
  ];

  return {
    messages: overrides.messages ?? defaultMessages,
    systemPrompt: overrides.systemPrompt ?? "Test system prompt",
    workspaceDir: overrides.workspaceDir ?? "/tmp/test",
    taskId: overrides.taskId ?? "test-task",
    runId: overrides.runId ?? "test-run",
    requestId: overrides.requestId ?? "test-req",
    ...(overrides.roleId ? { roleId: overrides.roleId } : {}),
    tools: overrides.tools ?? [createMockTool("testTool")],
    maxTurns: overrides.maxTurns ?? 10,
    abortController: overrides.abortController ?? abortController,
    recordEvent: overrides.recordEvent ?? mock(async (event: LeaderLoopEvent) => {
      events.push(event);
    }),
    callModel,
    ...(overrides.requestApproval ? { requestApproval: overrides.requestApproval } : {}),
    ...(overrides.modelOverride ? { modelOverride: overrides.modelOverride } : {}),
    ...(overrides.planFirst === true ? { planFirst: true } : {}),
    ...(overrides.initialPlanRequestId ? { initialPlanRequestId: overrides.initialPlanRequestId } : {}),
    ...(overrides.reloadTools ? { reloadTools: overrides.reloadTools } : {}),
    ...(overrides.onCheckpoint ? { onCheckpoint: overrides.onCheckpoint } : {}),
    ...(overrides.executionPolicy !== undefined ? { executionPolicy: overrides.executionPolicy } : {}),
    ...(overrides.startTurnCount !== undefined ? { startTurnCount: overrides.startTurnCount } : {}),
    ...(overrides.restoredDoomState !== undefined ? { restoredDoomState: overrides.restoredDoomState } : {}),
  };
}

function isToolResult(message: LeaderMessage): message is LeaderToolResultMessage {
  return message.type === "tool_result";
}

async function runLeaderLoop(params: LeaderLoopParams): Promise<{ messages: LeaderMessage[]; result: LeaderLoopParams["callModel"] extends any ? any : never }> {
  const messages: LeaderMessage[] = [];
  const gen = leaderLoop(params);
  let result: any;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    messages.push(value);
  }
  return { messages, result };
}

describe("leaderLoop E2E", () => {
  test("completes multi-turn loop with tool execution", async () => {
    const toolCallLog: string[] = [];
    const tool = createMockTool("testTool", {
      callImpl: async (input) => {
        toolCallLog.push(`testTool called with ${JSON.stringify(input)}`);
        return { data: `Tool result for ${input.action}` };
      },
    });

    const params = createTestParams({
      tools: [tool],
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "tool_use" as const, id: "call-1", name: "testTool", input: { action: "step1" } },
            ],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Final response after tool execution" },
            ],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(result.turnCount).toBe(2);
    expect(toolCallLog).toHaveLength(1);
    expect(toolCallLog[0]).toContain("step1");

    const toolResults = messages.filter(isToolResult);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolUseId).toBe("call-1");
    expect(toolResults[0]?.content).toContain("Tool result");
  });

  test("continues loop after tool execution with follow-up", async () => {
    const toolCallLog: string[] = [];
    const tool = createMockTool("analyzeTool", {
      callImpl: async (input) => {
        toolCallLog.push(`analyze: ${input.target}`);
        return { data: { result: `Analysis of ${input.target}`, score: 85 } };
      },
    });

    const params = createTestParams({
      tools: [tool],
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "tool_use" as const, id: "call-1", name: "analyzeTool", input: { target: "file1" } },
              { type: "tool_use" as const, id: "call-2", name: "analyzeTool", input: { target: "file2" } },
            ],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Analysis complete. Here is the summary..." },
            ],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(result.turnCount).toBe(2);
    expect(toolCallLog).toHaveLength(2);
    expect(toolCallLog).toContain("analyze: file1");
    expect(toolCallLog).toContain("analyze: file2");

    const toolResults = messages.filter(isToolResult);
    expect(toolResults).toHaveLength(2);
  });

  test("leader delegation guard emits warning but does not block after limit", async () => {
    const toolCallLog: string[] = [];
    const bashTool = createMockTool("bash", {
      callImpl: async () => {
        toolCallLog.push("bash");
        return { data: "ok" };
      },
    });
    const writeFileTool = createMockTool("write_file", {
      callImpl: async () => {
        toolCallLog.push("write_file");
        return { data: "wrote" };
      },
    });
    const editFileTool = createMockTool("edit_file", {
      callImpl: async () => {
        toolCallLog.push("edit_file");
        return { data: "edited" };
      },
    });
    const spawnTool = createMockTool("spawn_teammate");
    const events: LeaderLoopEvent[] = [];

    const params = createTestParams({
      tools: [bashTool, writeFileTool, editFileTool, spawnTool],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-1", name: "bash", input: { command: "ls" } }],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-2", name: "write_file", input: { path: "a", content: "x" } }],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-3", name: "edit_file", input: { path: "a", patch: "y" } }],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-4", name: "bash", input: { command: "pwd" } }],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-5", name: "bash", input: { command: "bun test" } }],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [{ type: "text" as const, text: "All done." }],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["bash", "write_file", "edit_file", "bash", "bash"]);
    const toolResults = messages.filter(isToolResult);
    const withNote = toolResults.filter((m) => typeof m.content === "string" && m.content.includes("magister-delegating"));
    expect(withNote.length).toBeGreaterThanOrEqual(1);
  });

  test("leader delegation guard does not count failed implementation tools (2026-05-24)", async () => {
    // Pre-fix the demo-service "start uvicorn" task burned its quota on
    // FOUR rejections of the same bash command (path denied / timeout
    // / etc.) and got force-delegated for no useful work. Counter now
    // only increments on successful direct-work tool results.
    //
    // Scenario: bash returns isError four times (using DIFFERENT
    // commands so the doom-loop detector doesn't pre-empt), then a
    // 5th successful bash — should run because failed ones don't
    // tick the counter.
    const bashCallLog: string[] = [];
    const bashTool = createMockTool("bash", {
      callImpl: async (input: { command?: string }) => {
        bashCallLog.push(input?.command ?? "");
        const isFailing = (input?.command ?? "").startsWith("fail-");
        if (isFailing) {
          // tool-execution wraps THROWN errors as
          // `tool_result { isError: true, ... }`; returning
          // `{ isError: true }` as data does NOT mark the result
          // as an error from the leader-loop's perspective.
          throw new Error("command rejected");
        }
        return { data: "ok" };
      },
    });
    const spawnTool = createMockTool("spawn_teammate");
    const events: LeaderLoopEvent[] = [];

    const params = createTestParams({
      tools: [bashTool, spawnTool],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "f1", name: "bash", input: { command: "fail-alpha" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "f2", name: "bash", input: { command: "fail-bravo" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "f3", name: "bash", input: { command: "fail-charlie" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "f4", name: "bash", input: { command: "fail-delta" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "ok1", name: "bash", input: { command: "echo ok" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    await runLeaderLoop(params);

    // Core assertion of the fix: failed bash calls did NOT trip the
    // delegation guard. Pre-fix the 4th call (or any retry past the
    // limit) would have emitted leader.delegation_guard_warning
    // before reaching the next dispatch — the demo-service task hit
    // exactly that. Post-fix the counter only ticks on successful
    // results, so four failures → zero quota consumed.
    //
    // (Whether the 5th successful bash gets to run depends on other
    // guards layered on top — doom-loop fingerprinting can stop
    // bash-only loops independently — which is fine. The point is
    // the delegation-guard branch specifically didn't fire.)
    const warningEvents = events.filter((event) => event.type === "leader.delegation_guard_warning");
    expect(warningEvents.length).toBe(0);
    expect(bashCallLog.length).toBeGreaterThanOrEqual(4);
  });

  test("leader delegation guard is disabled in plan mode", async () => {
    const toolCallLog: string[] = [];
    const readFileTool = createMockTool("read_file", {
      isPlanSafe: true,
      callImpl: async () => {
        toolCallLog.push("read_file");
        return { data: "file content" };
      },
    });
    const grepTool = createMockTool("grep", {
      isPlanSafe: true,
      callImpl: async () => {
        toolCallLog.push("grep");
        return { data: "matches" };
      },
    });
    const bashTool = createMockTool("bash", {
      isPlanSafe: true,
      callImpl: async () => {
        toolCallLog.push("bash");
        return { data: "plan-safe output" };
      },
    });
    const events: LeaderLoopEvent[] = [];

    const params = createTestParams({
      planFirst: true,
      tools: [readFileTool, grepTool, bashTool, createMockTool("spawn_teammate")],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "plan-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "plan-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "plan-3", name: "bash", input: { command: "pwd" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Planned investigation done." }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "bash"]);
    expect(events.some((event) => event.type === "leader.delegation_guard_warning")).toBe(false);
  });

  test("leader delegation guard honors explicit no-subagent user intent", async () => {
    const toolCallLog: string[] = [];
    const readFileTool = createMockTool("read_file", {
      callImpl: async () => {
        toolCallLog.push("read_file");
        return { data: "file content" };
      },
    });
    const grepTool = createMockTool("grep", {
      callImpl: async () => {
        toolCallLog.push("grep");
        return { data: "matches" };
      },
    });
    const bashTool = createMockTool("bash", {
      callImpl: async () => {
        toolCallLog.push("bash");
        return { data: "direct output" };
      },
    });
    const events: LeaderLoopEvent[] = [];

    const params = createTestParams({
      messages: [{ type: "user", content: "Do not use subagents; handle it yourself." }],
      tools: [readFileTool, grepTool, bashTool, createMockTool("spawn_teammate")],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "direct-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "direct-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "direct-3", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Handled directly." }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "bash"]);
    expect(events.some((event) => event.type === "leader.delegation_guard_warning")).toBe(false);
  });

  test("leader delegation guard does not run for non-leader roles", async () => {
    const toolCallLog: string[] = [];
    const params = createTestParams({
      roleId: "coder",
      tools: [
        createMockTool("read_file", { callImpl: async () => { toolCallLog.push("read_file"); return { data: "file" }; } }),
        createMockTool("grep", { callImpl: async () => { toolCallLog.push("grep"); return { data: "matches" }; } }),
        createMockTool("bash", { callImpl: async () => { toolCallLog.push("bash"); return { data: "output" }; } }),
        createMockTool("spawn_teammate"),
      ],
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "coder-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "coder-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "coder-3", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "bash"]);
  });

  test("leader delegation guard does not run inside an in-process teammate", async () => {
    const toolCallLog: string[] = [];
    const abortController = new AbortController();
    const params = createTestParams({
      abortController,
      tools: [
        createMockTool("read_file", { callImpl: async () => { toolCallLog.push("read_file"); return { data: "file" }; } }),
        createMockTool("grep", { callImpl: async () => { toolCallLog.push("grep"); return { data: "matches" }; } }),
        createMockTool("bash", { callImpl: async () => { toolCallLog.push("bash"); return { data: "output" }; } }),
        createMockTool("spawn_teammate"),
      ],
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "tm-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "tm-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "tm-3", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    const { result } = await runWithTeammateContext(
      createTeammateContext({
        agentId: "coder",
        agentName: "Coder",
        teamName: "Engineering",
        planModeRequired: false,
        parentSessionId: "parent-run",
        abortController,
        taskId: params.taskId,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
      }),
      () => runLeaderLoop(params),
    );

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "bash"]);
  });

  test("leader delegation guard does not run when spawn_teammate is unavailable", async () => {
    const toolCallLog: string[] = [];
    const params = createTestParams({
      tools: [
        createMockTool("read_file", { callImpl: async () => { toolCallLog.push("read_file"); return { data: "file" }; } }),
        createMockTool("grep", { callImpl: async () => { toolCallLog.push("grep"); return { data: "matches" }; } }),
        createMockTool("bash", { callImpl: async () => { toolCallLog.push("bash"); return { data: "output" }; } }),
      ],
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "nos-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "nos-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "nos-3", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "bash"]);
  });

  test("leader delegation guard resets direct work count after successful spawn_teammate", async () => {
    const toolCallLog: string[] = [];
    const params = createTestParams({
      tools: [
        createMockTool("read_file", { callImpl: async () => { toolCallLog.push("read_file"); return { data: "file" }; } }),
        createMockTool("grep", { callImpl: async () => { toolCallLog.push("grep"); return { data: "matches" }; } }),
        createMockTool("spawn_teammate", { callImpl: async () => { toolCallLog.push("spawn_teammate"); return { data: "spawned" }; } }),
        createMockTool("bash", { callImpl: async () => { toolCallLog.push("bash"); return { data: "output" }; } }),
      ],
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "reset-1", name: "read_file", input: { path: "a.ts" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "reset-2", name: "grep", input: { query: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "reset-3", name: "spawn_teammate", input: { role: "coder", goal: "fix it" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "reset-4", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["read_file", "grep", "spawn_teammate", "bash"]);
  });

  test("leader delegation guard does not reset direct work count after failed spawn_teammate", async () => {
    const toolCallLog: string[] = [];
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      tools: [
        createMockTool("bash", { callImpl: async () => { toolCallLog.push("bash"); return { data: "ok" }; } }),
        createMockTool("write_file", { callImpl: async () => { toolCallLog.push("write_file"); return { data: "wrote" }; } }),
        createMockTool("edit_file", { callImpl: async () => { toolCallLog.push("edit_file"); return { data: "edited" }; } }),
        createMockTool("spawn_teammate", { callImpl: async () => { toolCallLog.push("spawn_teammate"); throw new Error("spawn failed"); } }),
      ],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-1", name: "bash", input: { command: "ls" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-2", name: "write_file", input: { path: "a", content: "x" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-3", name: "spawn_teammate", input: { role: "coder", goal: "fix it" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-4", name: "edit_file", input: { path: "a", patch: "y" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-5", name: "bash", input: { command: "pwd" } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "fr-6", name: "bash", input: { command: "bun test" } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(toolCallLog).toEqual(["bash", "write_file", "spawn_teammate", "edit_file", "bash", "bash"]);
    const toolResults = messages.filter(isToolResult);
    const withNote = toolResults.filter((m) => typeof m.content === "string" && m.content.includes("magister-delegating"));
    expect(withNote.length).toBeGreaterThanOrEqual(1);
  });

  test("terminates at maxTurns limit", async () => {
    const toolCallLog: string[] = [];
    const tool = createMockTool("loopTool", {
      callImpl: async (input) => {
        toolCallLog.push(`loopTool turn ${input.turn}`);
        return { data: `Result for turn ${input.turn}` };
      },
    });

    const maxTurns = 3;
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      tools: [tool],
      maxTurns,
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "loopTool", input: { turn: 1 } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "t2", name: "loopTool", input: { turn: 2 } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "t3", name: "loopTool", input: { turn: 3 } }] }],
        [{ type: "assistant" as const, content: [{ type: "tool_use" as const, id: "t4", name: "loopTool", input: { turn: 4 } }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Should not reach" }] }],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("max_turns");
    expect(result.turnCount).toBe(maxTurns + 1);

    const maxTurnsEvent = events.find((e) => e.type === "leader.max_turns");
    expect(maxTurnsEvent).toBeDefined();
    expect(maxTurnsEvent?.data.maxTurns).toBe(maxTurns);
  });

  test("P1-fix-c: thinking-only continuations are bounded by maxTurns and are checkpointed", async () => {
    // A model that emits thinking-only responses every turn used to bypass
    // the maxTurns check (the thinking-only `continue` skipped it) and never
    // checkpointed the injected continuation. Now it must terminate at
    // maxTurns and checkpoint each continuation.
    const maxTurns = 2;
    const events: LeaderLoopEvent[] = [];
    const checkpointTurns: number[] = [];
    const params = createTestParams({
      maxTurns,
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      onCheckpoint: async (data: { turnCount: number }) => {
        checkpointTurns.push(data.turnCount);
      },
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "thinking" as const, thinking: "reasoning 1" }] }],
        [{ type: "assistant" as const, content: [{ type: "thinking" as const, thinking: "reasoning 2" }] }],
        [{ type: "assistant" as const, content: [{ type: "thinking" as const, thinking: "reasoning 3" }] }],
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "Should not reach" }] }],
      ],
    });

    const { result } = await runLeaderLoop(params);

    // Bounded — does NOT loop until responses are exhausted or overshoot.
    expect(result.reason).toBe("max_turns");
    expect(result.turnCount).toBe(maxTurns + 1);
    // The continuation path fired AND checkpointed the injected state.
    expect(events.some((e) => e.type === "leader.thinking_only_continuation")).toBe(true);
    expect(checkpointTurns.length).toBeGreaterThanOrEqual(1);
  });

  test("handles abort during streaming", async () => {
    const abortController = new AbortController();
    const tool = createMockTool("slowTool", {
      callImpl: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { data: "completed" };
      },
    });

    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      tools: [tool],
      abortController,
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      callModel: async function* () {
        yield {
          type: "assistant" as const,
          content: [{ type: "tool_use" as const, id: "call-1", name: "slowTool", input: {} }],
        };
      },
    });

    setTimeout(() => abortController.abort("user_cancelled"), 5);

    const { messages, result } = await runLeaderLoop(params);

    expect(["aborted_streaming", "aborted_tools"]).toContain(result.reason);
    expect(abortController.signal.aborted).toBe(true);
  });

  test("handles abort during tool execution", async () => {
    const abortController = new AbortController();
    const toolCallLog: string[] = [];

    const tool = createMockTool("abortTestTool", {
      callImpl: async (input) => {
        toolCallLog.push(`started: ${input.phase}`);
        if (input.phase === "trigger_abort") {
          setTimeout(() => abortController.abort("abort_requested"), 5);
          await new Promise((r) => setTimeout(r, 100));
        }
        return { data: `Phase ${input.phase} complete` };
      },
    });

    const params = createTestParams({
      tools: [tool],
      abortController,
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "tool_use" as const, id: "call-1", name: "abortTestTool", input: { phase: "trigger_abort" } },
            ],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Should not reach" },
            ],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(["aborted_streaming", "aborted_tools"]).toContain(result.reason);
    expect(abortController.signal.aborted).toBe(true);
  });

  test("handles model error and terminates", async () => {
    const events: LeaderLoopEvent[] = [];
    let hasYielded = false;
    const params = createTestParams({
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
      callModel: async function* () {
        if (!hasYielded) {
          hasYielded = true;
          yield {
            type: "assistant" as const,
            content: [{ type: "tool_use" as const, id: "call-1", name: "testTool", input: {} }],
          };
          throw new Error("Model API rate limit exceeded");
        }
      },
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("model_error");
    expect(result.error?.message).toContain("rate limit");

    const errorEvent = events.find((e) => e.type === "leader.model_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.error).toContain("rate limit");

    const orphanResults = messages.filter(isToolResult);
    expect(orphanResults.length).toBeGreaterThanOrEqual(0);
  });

  test("executes tools concurrently for concurrency-safe tools", async () => {
    const executionTimes: { name: string; start: number; end: number }[] = [];
    const toolA = createMockTool("concurrentA", {
      isConcurrencySafe: true,
      callImpl: async (input) => {
        const start = Date.now();
        executionTimes.push({ name: "A", start, end: 0 });
        await new Promise((r) => setTimeout(r, 50));
        const aEntry = executionTimes.find((e) => e.name === "A" && e.end === 0);
        if (aEntry) aEntry.end = Date.now();
        return { data: `A:${input.value}` };
      },
    });
    const toolB = createMockTool("concurrentB", {
      isConcurrencySafe: true,
      callImpl: async (input) => {
        const start = Date.now();
        executionTimes.push({ name: "B", start, end: 0 });
        await new Promise((r) => setTimeout(r, 30));
        const bEntry = executionTimes.find((e) => e.name === "B" && e.end === 0);
        if (bEntry) bEntry.end = Date.now();
        return { data: `B:${input.value}` };
      },
    });

    const params = createTestParams({
      tools: [toolA, toolB],
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "tool_use" as const, id: "call-1", name: "concurrentA", input: { value: 1 } },
              { type: "tool_use" as const, id: "call-2", name: "concurrentB", input: { value: 2 } },
            ],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Both tools executed" },
            ],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(executionTimes).toHaveLength(2);

    const aTime = executionTimes.find((e) => e.name === "A");
    const bTime = executionTimes.find((e) => e.name === "B");

    if (aTime && bTime && aTime.end > 0 && bTime.end > 0) {
      const overlap =
        (aTime.start <= bTime.end && aTime.end >= bTime.start) ||
        (bTime.start <= aTime.end && bTime.end >= aTime.start);
      expect(overlap).toBe(true);
    }

    const toolResults = messages.filter(isToolResult);
    expect(toolResults).toHaveLength(2);
  });

  test("empty response without tool use terminates loop", async () => {
    const params = createTestParams({
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Just a text response, no tools" },
            ],
          },
        ],
      ],
    });

    const { messages, result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(result.turnCount).toBe(1);
    // Final assistant message is now yielded so callers can read it
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("assistant");
  });

  // Regression: closes the bug where Plan toggle ON didn't actually
  // gate writes — the prior wiring depended on the model obeying a
  // system-prompt instruction to call `enter_plan_mode`, which small
  // models routinely skipped (kimi-k2.6 went straight to git_commit).
  // The forced-entry fix transitions plan state at loop init.
  test("planFirst=true forces plan_mode_entered emit at loop init", async () => {
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      planFirst: true,
      recordEvent: async (event) => {
        events.push(event);
      },
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Acknowledged plan mode." },
            ],
          },
        ],
      ],
    });

    await runLeaderLoop(params);

    const planEntered = events.find((e) => e.type === "leader.plan_mode_entered");
    expect(planEntered).toBeTruthy();
    expect(planEntered?.data).toMatchObject({
      taskId: "test-task",
      requestId: "test-req",
      runId: "test-run",
      forced: true,
    });
  });

  // Regression: forced-entry from planFirst-toggle skips the
  // `enter_plan_mode` tool_use, so a resume's
  // `derivePlanStateFromMessages` would see exit_plan_mode without
  // the prior PLANNING state and stay at IDLE — preflight then
  // misses the cancel/approve sentinel and the literal token leaks
  // to the model. `initialPlanRequestId` from the event log is the
  // authoritative override that pins state to AWAITING_APPROVAL.
  test("initialPlanRequestId pins state to AWAITING_APPROVAL even when message log derivation says IDLE", async () => {
    const events: LeaderLoopEvent[] = [];
    let modelCalls = 0;
    const callModel: LeaderLoopParams["callModel"] = async function* () {
      modelCalls += 1;
      yield {
        type: "assistant" as const,
        content: [{ type: "tool_use", id: "should_not_run", name: "bash", input: { command: "echo nope" } }],
      };
    };
    const params = createTestParams({
      // No enter_plan_mode tool_use in the log (forced-entry skipped it).
      // exit_plan_mode is here but state would stay IDLE without the
      // override because the IDLE→AWAITING_APPROVAL gate requires
      // PLANNING first.
      messages: [
        { type: "user", content: "do thing" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "tu_x", name: "exit_plan_mode", input: { plan: "step 1" } },
          ],
        },
        { type: "tool_result", toolUseId: "tu_x", content: "submitted" },
        { type: "user", content: "__PLAN_CANCELLED__" },
      ],
      initialPlanRequestId: "req_original_plan",
      recordEvent: async (event) => { events.push(event); },
      callModel,
    });

    await runLeaderLoop(params);

    expect(modelCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "leader.plan_mode_exited",
      data: expect.objectContaining({ reason: "cancelled" }),
    }));
  });

  test("planFirst is no-op when state was already PLANNING (idempotent)", async () => {
    // Simulate a resumed session by feeding messages that derive to
    // PLANNING (assistant tool_use of enter_plan_mode in the history).
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      planFirst: true,
      messages: [
        { type: "user", content: "previous turn" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "tu_1", name: "enter_plan_mode", input: {} },
          ],
        },
        { type: "tool_result", toolUseId: "tu_1", content: "ok" },
        { type: "user", content: "new follow-up" },
      ],
      recordEvent: async (event) => {
        events.push(event);
      },
      turnResponses: [
        [{ type: "assistant" as const, content: [{ type: "text" as const, text: "ack" }] }],
      ],
    });

    await runLeaderLoop(params);

    // Only synthetic init event should NOT fire — derived state was
    // already PLANNING. Nothing should re-emit plan_mode_entered.
    const initEntries = events.filter(
      (e) => e.type === "leader.plan_mode_entered" && (e.data as { forced?: boolean }).forced === true,
    );
    expect(initEntries).toHaveLength(0);
  });

  // Regression: when the user clicks Cancel on a PlanCard, the
  // preflight detects __PLAN_CANCELLED__ and emits plan_mode_exited.
  // Earlier draft also called the model with a "user cancelled,
  // stop" addendum — but qwen3.6 / kimi-k2.6 routinely ignored that
  // and proceeded to do the cancelled work anyway. Now the loop
  // short-circuits BEFORE callModel — model never gets a chance to
  // generate tool_use after a cancel.
  test("cancel sentinel hard-stops the loop before model is called", async () => {
    const events: LeaderLoopEvent[] = [];
    let modelCalls = 0;
    const callModel: LeaderLoopParams["callModel"] = async function* () {
      modelCalls += 1;
      yield {
        type: "assistant" as const,
        content: [{ type: "tool_use", id: "tu_x", name: "bash", input: { command: "rm -rf /" } }],
      };
    };
    const params = createTestParams({
      messages: [
        // Simulate a plan flow already in AWAITING_APPROVAL: prior
        // assistant called exit_plan_mode, user replied with the
        // cancel sentinel.
        { type: "user", content: "do thing" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "tu_e", name: "enter_plan_mode", input: {} },
          ],
        },
        { type: "tool_result", toolUseId: "tu_e", content: "ok" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "tu_x", name: "exit_plan_mode", input: { plan: "step 1" } },
          ],
        },
        { type: "tool_result", toolUseId: "tu_x", content: "submitted" },
        { type: "user", content: "__PLAN_CANCELLED__" },
      ],
      recordEvent: async (event) => {
        events.push(event);
      },
      callModel,
    });

    const { result, messages } = await runLeaderLoop(params);

    // Loop terminated cleanly.
    expect(result.reason).toBe("completed");
    // Model was never called — preflight short-circuited.
    expect(modelCalls).toBe(0);
    // plan_mode_exited fired with reason=cancelled.
    expect(events).toContainEqual(expect.objectContaining({
      type: "leader.plan_mode_exited",
      data: expect.objectContaining({ reason: "cancelled" }),
    }));
    // session_complete fired with the dedicated reason.
    expect(events).toContainEqual(expect.objectContaining({
      type: "leader.session_complete",
      data: expect.objectContaining({ reason: "plan_cancelled" }),
    }));
    // Final yielded message is the deterministic acknowledgment.
    const ack = messages.find((m) => m.type === "assistant");
    expect(ack).toBeTruthy();
    if (ack && ack.type === "assistant") {
      const textPart = ack.content.find((c): c is { type: "text"; text: string } => c.type === "text");
      expect(textPart?.text).toContain("cancelled");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Spec §4 — per-turn tool list hot-reload + content-hash short-circuit
// ─────────────────────────────────────────────────────────────────────

describe("leaderLoop tool list hot-reload (spec §4)", () => {
  test("no reloadTools callback → no tools_reloaded event ever fires", async () => {
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      tools: [createMockTool("alpha")],
      turnResponses: [
        [{ type: "assistant", content: [{ type: "text", text: "hello" }] }],
      ],
      recordEvent: async (event) => {
        events.push(event);
      },
      // reloadTools intentionally omitted
    });

    await runLeaderLoop(params);

    expect(events.some((e) => e.type === "leader.tools_reloaded")).toBe(false);
  });

  test("reloadTools returns identical hash → no tools_reloaded event (cache stays warm)", async () => {
    const tools = [createMockTool("alpha"), createMockTool("beta")];
    const events: LeaderLoopEvent[] = [];
    let reloadCallCount = 0;
    const params = createTestParams({
      tools,
      turnResponses: [
        [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      ],
      recordEvent: async (event) => {
        events.push(event);
      },
      reloadTools: async () => {
        reloadCallCount++;
        // Return a *new array* with the same tools — exercises the
        // content-hash short-circuit, which should treat this as
        // "no change" and skip emitting tools_reloaded.
        return [...tools];
      },
    });

    await runLeaderLoop(params);

    expect(reloadCallCount).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "leader.tools_reloaded")).toBe(false);
  });

  test("reloadTools returns changed list → tools_reloaded event with added/removed diff", async () => {
    const initial = [createMockTool("alpha"), createMockTool("beta")];
    const expanded = [createMockTool("alpha"), createMockTool("beta"), createMockTool("gamma")];
    const events: LeaderLoopEvent[] = [];
    let reloadCallCount = 0;
    // Capture each call's tools[] for downstream assertion (codex
    // review #5): proves the reloaded list is what the model
    // actually sees, not just an event that was emitted.
    const callModelToolsLog: readonly LeaderTool[][] = [];
    const recordingCallModel: LeaderLoopParams["callModel"] = async function* (
      params: LeaderModelCallParams,
    ) {
      (callModelToolsLog as LeaderTool[][]).push([...(params.tools ?? [])]);
      const responses = (callModelToolsLog.length === 1)
        ? [
            {
              type: "assistant" as const,
              content: [{ type: "tool_use" as const, id: "t1", name: "alpha", input: {} }],
            },
          ]
        : [{ type: "assistant" as const, content: [{ type: "text" as const, text: "done" }] }];
      for (const msg of responses) yield msg;
    };
    const params = createTestParams({
      tools: initial,
      callModel: recordingCallModel,
      recordEvent: async (event) => {
        events.push(event);
      },
      reloadTools: async () => {
        reloadCallCount++;
        // First reload returns the initial list (no diff vs initial),
        // second reload returns the expanded list (gamma added).
        return reloadCallCount === 1 ? initial : expanded;
      },
    });

    await runLeaderLoop(params);

    const reloadEvents = events.filter((e) => e.type === "leader.tools_reloaded");
    expect(reloadEvents).toHaveLength(1);
    expect(reloadEvents[0]!.data.added).toEqual(["gamma"]);
    expect(reloadEvents[0]!.data.removed).toEqual([]);
    expect(reloadEvents[0]!.data.cacheWillInvalidate).toBe(true);

    // Turn 1 callModel saw initial 2-tool list; turn 2 must see the
    // expanded 3-tool list (gamma added) — the model actually
    // receives the reloaded shape, not just an event about it.
    expect(callModelToolsLog).toHaveLength(2);
    expect(callModelToolsLog[0]!.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
    expect(callModelToolsLog[1]!.map((t) => t.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("MAGISTER_TOOLS_HOT_RELOAD=off → reloadTools is never called even when supplied", async () => {
    const prev = process.env.MAGISTER_TOOLS_HOT_RELOAD;
    process.env.MAGISTER_TOOLS_HOT_RELOAD = "off";
    try {
      let reloadCallCount = 0;
      const params = createTestParams({
        tools: [createMockTool("alpha")],
        turnResponses: [
          [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
        ],
        reloadTools: async () => {
          reloadCallCount++;
          return [createMockTool("beta")];
        },
      });

      await runLeaderLoop(params);

      expect(reloadCallCount).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MAGISTER_TOOLS_HOT_RELOAD;
      else process.env.MAGISTER_TOOLS_HOT_RELOAD = prev;
    }
  });

  test("reloadTools throws → loop continues + emits leader.tools_reload_failed event", async () => {
    const tools = [createMockTool("alpha")];
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      tools,
      turnResponses: [
        [{ type: "assistant", content: [{ type: "text", text: "done" }] }],
      ],
      recordEvent: async (event) => {
        events.push(event);
      },
      reloadTools: async () => {
        throw new Error("simulated MCP pool lookup failure");
      },
    });

    const { messages } = await runLeaderLoop(params);

    // Loop completed despite reload throwing. No tools_reloaded event,
    // but a tools_reload_failed event was emitted for observability
    // (codex review #4).
    expect(events.some((e) => e.type === "leader.tools_reloaded")).toBe(false);
    const failedEvents = events.filter((e) => e.type === "leader.tools_reload_failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.data.reason).toContain("simulated MCP pool lookup failure");
    expect(typeof failedEvents[0]!.data.previousHash).toBe("string");
    expect(messages.length).toBeGreaterThan(0);
  });

  test("thinking-only response triggers continuation instead of exiting", async () => {
    const events: LeaderLoopEvent[] = [];

    const params = createTestParams({
      turnResponses: [
        [
          {
            type: "assistant" as const,
            content: [
              { type: "thinking" as const, thinking: "Let me analyze this problem step by step..." },
            ],
          },
        ],
        [
          {
            type: "assistant" as const,
            content: [
              { type: "text" as const, text: "Here is my analysis." },
            ],
          },
        ],
      ],
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    expect(result.turnCount).toBe(2);
    expect(events.some((e) => e.type === "leader.thinking_only_continuation")).toBe(true);
    expect(events.some((e) => e.type === "leader.empty_response_detected")).toBe(false);
  });
});

describe("leaderLoop checkpoint completeness (P1)", () => {
  test("startTurnCount initialises turnCount from restored value instead of 1", async () => {
    const events: LeaderLoopEvent[] = [];
    const params = createTestParams({
      startTurnCount: 5,
      recordEvent: mock(async (event: LeaderLoopEvent) => {
        events.push(event);
      }),
    });

    const { result } = await runLeaderLoop(params);

    // Loop runs one turn starting from 5; result is turn 5 or beyond.
    expect(result.reason).toBe("completed");
    expect(result.turnCount).toBeGreaterThanOrEqual(5);
  });

  test("onCheckpoint payload includes executionPolicy and doomState", async () => {
    const checkpoints: Parameters<NonNullable<LeaderLoopParams["onCheckpoint"]>>[0][] = [];

    const policy = {
      mode: "direct_answer" as const,
      source: "intake_rules" as const,
      reason: "test policy",
      constraints: {
        allowReadTools: true,
        allowSpawnTools: false,
        allowCodeWriteTools: false as const,
        allowOpsBash: false,
        allowGitCommit: false,
        mustDelegate: false,
      },
      counters: {
        discoveryToolCalls: 0,
        writeToolCalls: 0,
        writtenPaths: [],
        codeMutatingBashCalls: 0,
        testFailures: 0,
        teammateSpawned: false,
      },
    };

    const params = createTestParams({
      executionPolicy: policy,
      onCheckpoint: async (data) => {
        checkpoints.push(data);
      },
    });

    await runLeaderLoop(params);

    expect(checkpoints.length).toBeGreaterThan(0);
    const cp = checkpoints[0]!;
    // executionPolicy must be carried through
    expect(cp.executionPolicy).toBeDefined();
    expect(cp.executionPolicy?.mode).toBe("direct_answer");
    // doomState must always be present (snapshot of the detector window)
    expect(cp.doomState).toBeDefined();
    expect(Array.isArray((cp.doomState as DoomLoopSnapshot).window)).toBe(true);
  });

  test("startTurnCount + restoredDoomState: turnCount starts at restored value, doom state is seeded", async () => {
    const checkpoints: Parameters<NonNullable<LeaderLoopParams["onCheckpoint"]>>[0][] = [];

    const restoredDoomState: DoomLoopSnapshot = {
      window: ["fingerprint-a", "fingerprint-b", "fingerprint-c"],
    };

    const params = createTestParams({
      startTurnCount: 7,
      restoredDoomState,
      onCheckpoint: async (data) => {
        checkpoints.push(data);
      },
    });

    const { result } = await runLeaderLoop(params);

    expect(result.reason).toBe("completed");
    // turnCount must reflect the restored start
    expect(result.turnCount).toBeGreaterThanOrEqual(7);
    // checkpoint must include a doomState snapshot
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]!.doomState).toBeDefined();
  });
});
