import { expect, test } from "bun:test";

import { runManagerLoop } from "../../src/services/manager-loop-service";

test("runManagerLoop executes a base tool then returns a direct answer", async () => {
  const prompts: string[] = [];
  const toolEvents: Array<{ type: string; toolName: string }> = [];

  const result = await runManagerLoop({
    basePrompt: "Explain the current time.",
    workspaceDir: process.cwd(),
    now: () => new Date("2026-04-18T05:40:00.000Z"),
    onToolEvent: (event) => {
      toolEvents.push({
        type: event.type,
        toolName: event.toolName,
      });
    },
    dispatchModel: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            message: JSON.stringify({
              kind: "call_tool",
              toolName: "time_now",
              arguments: {},
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        body: {
          message: JSON.stringify({
            kind: "respond",
            reply: "现在是 2026-04-18 05:40:00。",
          }),
        },
      };
    },
  });

  const finalDecision = result?.finalMessage ? JSON.parse(result.finalMessage) : null;
  expect(finalDecision).toMatchObject({
    decision: "direct_answer",
    executionMode: "immediate",
    childWorkItems: [],
  });
  expect(finalDecision?.reply).toContain("现在是 2026-04-18 05:40:00。");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("tool observations:");
  expect(prompts[1]).toContain("time_now");
  expect(prompts[1]).toContain("Local time");
  expect(toolEvents).toEqual([
    { type: "tool.call", toolName: "time_now" },
    { type: "tool.result", toolName: "time_now" },
  ]);
});

test("runManagerLoop keeps workspace-directory answers on direct path after bash observations", async () => {
  const prompts: string[] = [];
  const toolEvents: Array<{
    type: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }> = [];

  const result = await runManagerLoop({
    basePrompt: "当前工作目录是啥",
    workspaceDir: process.cwd(),
    onToolEvent: (event) => {
      toolEvents.push({
        type: event.type,
        toolName: event.toolName,
        arguments: event.arguments,
      });
    },
    dispatchModel: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            message: JSON.stringify({
              kind: "call_tool",
              toolName: "bash",
              arguments: {
                command: "pwd",
              },
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        body: {
          message: JSON.stringify({
            kind: "respond",
            reply: `当前工作目录是 ${process.cwd()}。`,
          }),
        },
      };
    },
  });

  const finalDecision = result?.finalMessage ? JSON.parse(result.finalMessage) : null;
  expect(finalDecision).toMatchObject({
    decision: "direct_answer",
    executionMode: "immediate",
    childWorkItems: [],
  });
  expect(finalDecision?.reply).toContain(process.cwd());
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("tool observations:");
  expect(prompts[1]).toContain("bash");
  expect(prompts[1]).toContain("bash exit 0");
  expect(JSON.stringify(finalDecision)).not.toContain("spawn_work_items");
  expect(toolEvents).toEqual([
    {
      type: "tool.call",
      toolName: "bash",
      arguments: {
        command: "pwd",
      },
    },
    {
      type: "tool.result",
      toolName: "bash",
      arguments: {
        command: "pwd",
      },
    },
  ]);
});

test("runManagerLoop repairs terminal answers that skip required local workspace observations", async () => {
  const prompts: string[] = [];
  const result = await runManagerLoop({
    basePrompt: "当前工作目录是啥",
    workspaceDir: process.cwd(),
    validateTerminalResponse: ({ observations }) =>
      observations.length === 0
        ? "This asks for the current working directory. Call the relevant base tool before answering."
        : null,
    dispatchModel: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            message: JSON.stringify({
              kind: "respond",
              reply: "/app/workspace_main",
            }),
          },
        };
      }
      if (prompts.length === 2) {
        return {
          ok: true,
          status: 200,
          body: {
            message: JSON.stringify({
              kind: "call_tool",
              toolName: "bash",
              arguments: {
                command: "pwd",
              },
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        body: {
          message: JSON.stringify({
            kind: "respond",
            reply: `当前工作目录是 ${process.cwd()}。`,
          }),
        },
      };
    },
  });

  const finalDecision = result?.finalMessage ? JSON.parse(result.finalMessage) : null;
  expect(prompts).toHaveLength(3);
  expect(prompts[1]).toContain("Validation failure:");
  expect(prompts[1]).toContain("Call the relevant base tool before answering.");
  expect(prompts[2]).toContain("tool observations:");
  expect(prompts[2]).toContain("bash");
  expect(finalDecision?.reply).toContain(process.cwd());
});

test("runManagerLoop keeps file-visibility answers on direct path after list_dir observations", async () => {
  const prompts: string[] = [];
  const toolEvents: Array<{
    type: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }> = [];

  const result = await runManagerLoop({
    basePrompt: "你能看哪些文件",
    workspaceDir: process.cwd(),
    onToolEvent: (event) => {
      toolEvents.push({
        type: event.type,
        toolName: event.toolName,
        arguments: event.arguments,
      });
    },
    dispatchModel: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            message: JSON.stringify({
              kind: "call_tool",
              toolName: "list_dir",
              arguments: {
                path: ".",
              },
            }),
          },
        };
      }

      return {
        ok: true,
        status: 200,
        body: {
          message: JSON.stringify({
            kind: "respond",
            reply: "我能看到工作区里的文件和目录。",
          }),
        },
      };
    },
  });

  const finalDecision = result?.finalMessage ? JSON.parse(result.finalMessage) : null;
  expect(finalDecision).toMatchObject({
    decision: "direct_answer",
    executionMode: "immediate",
    childWorkItems: [],
  });
  expect(finalDecision?.reply).toContain("工作区");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("tool observations:");
  expect(prompts[1]).toContain("list_dir");
  expect(prompts[1]).toContain("Listed . (");
  expect(JSON.stringify(finalDecision)).not.toContain("spawn_work_items");
  expect(toolEvents).toEqual([
    {
      type: "tool.call",
      toolName: "list_dir",
      arguments: {
        path: ".",
      },
    },
    {
      type: "tool.result",
      toolName: "list_dir",
      arguments: {
        path: ".",
      },
    },
  ]);
});

test("runManagerLoop converts ask_user terminal actions into canonical manager decisions", async () => {
  const result = await runManagerLoop({
    basePrompt: "Need a missing deployment target.",
    workspaceDir: process.cwd(),
    dispatchModel: async () => ({
      ok: true,
      status: 200,
      body: {
        message: JSON.stringify({
          kind: "ask_user",
          reply: "你希望我针对哪个环境继续？",
        }),
      },
    }),
  });

  expect(result?.finalMessage).toContain('"decision":"ask_user"');
  expect(result?.finalMessage).toContain("你希望我针对哪个环境继续？");
});

test("runManagerLoop converts delegated subagents into canonical child work items with default skills", async () => {
  const result = await runManagerLoop({
    basePrompt: "Explain the current project's frontend architecture.",
    workspaceDir: process.cwd(),
    dispatchModel: async () => ({
      ok: true,
      status: 200,
      body: {
        message: JSON.stringify({
          kind: "delegate_subagent",
          subagentType: "architect",
          goal: "Explain the frontend architecture of the current repository.",
        }),
      },
    }),
  });

  expect(result?.finalMessage).toContain('"decision":"spawn_work_items"');
  expect(result?.finalMessage).toContain('"roleId":"architect"');
  expect(result?.finalMessage).toContain('"skillId":"inspect_repo"');
});

test("runManagerLoop returns null when the manager emits an invalid action", async () => {
  const result = await runManagerLoop({
    basePrompt: "This should fail.",
    workspaceDir: process.cwd(),
    dispatchModel: async () => ({
      ok: true,
      status: 200,
      body: {
        message: JSON.stringify({
          kind: "call_tool",
          toolName: "unknown_tool",
          arguments: {},
        }),
      },
    }),
  });

  expect(result).toBeNull();
});

test("runManagerLoop degrades to ask_user when the local step budget is exhausted", async () => {
  const result = await runManagerLoop({
    basePrompt: "Keep looping until the budget is exhausted.",
    workspaceDir: process.cwd(),
    maxSteps: 2,
    now: () => new Date("2026-04-18T05:40:00.000Z"),
    dispatchModel: async () => ({
      ok: true,
      status: 200,
      body: {
        message: JSON.stringify({
          kind: "call_tool",
          toolName: "time_now",
          arguments: {},
        }),
      },
    }),
  });

  expect(result?.finalMessage).toContain('"decision":"ask_user"');
  expect(result?.finalMessage).toContain("manager_loop_step_budget_exhausted");
});
