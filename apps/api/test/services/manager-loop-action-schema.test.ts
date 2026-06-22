import { expect, test } from "bun:test";

import {
  isManagerLoopAction,
  parseManagerLoopAction,
} from "../../src/services/manager-loop-action-schema";

test("parseManagerLoopAction parses a valid respond action", () => {
  const action = parseManagerLoopAction({
    kind: "respond",
    reply: "I have finished the task.",
  });

  expect(action).toEqual({
    kind: "respond",
    reply: "I have finished the task.",
  });
  expect(isManagerLoopAction(action)).toBe(true);
});

test("parseManagerLoopAction parses a valid ask_user action", () => {
  const action = parseManagerLoopAction({
    kind: "ask_user",
    reply: "Can you confirm which environment I should target?",
  });

  expect(action).toEqual({
    kind: "ask_user",
    reply: "Can you confirm which environment I should target?",
  });
});

test("parseManagerLoopAction parses a valid call_tool action with registry validators", () => {
  const action = parseManagerLoopAction(
    {
      kind: "call_tool",
      toolName: "read_file",
      arguments: {
        path: "README.md",
      },
    },
    {
      isToolName: (toolName) => toolName === "read_file" || toolName === "list_dir",
    },
  );

  expect(action).toEqual({
    kind: "call_tool",
    toolName: "read_file",
    arguments: {
      path: "README.md",
    },
  });
});

test("parseManagerLoopAction rejects call_tool actions when toolName is not in registry", () => {
  expect(
    parseManagerLoopAction(
      {
        kind: "call_tool",
        toolName: "unknown_tool",
        arguments: {},
      },
      {
        isToolName: (toolName) => toolName === "read_file",
      },
    ),
  ).toBeNull();
});

test("parseManagerLoopAction parses a valid delegate_subagent action with registry validators", () => {
  const action = parseManagerLoopAction(
    {
      kind: "delegate_subagent",
      subagentType: "coder",
      goal: "Implement the endpoint and add tests.",
      skillId: "implement_code",
      dependsOn: ["architect", "reviewer", "architect", ""],
      whyThisInvocation: "Coding is required before review and landing.",
      completionSignal: "Patch exists and targeted tests pass.",
    },
    {
      isSubagentType: (subagentType) => subagentType === "architect" || subagentType === "coder",
    },
  );

  expect(action).toEqual({
    kind: "delegate_subagent",
    subagentType: "coder",
    goal: "Implement the endpoint and add tests.",
    skillId: "implement_code",
    dependsOn: ["architect", "reviewer"],
    whyThisInvocation: "Coding is required before review and landing.",
    completionSignal: "Patch exists and targeted tests pass.",
  });
});

test("parseManagerLoopAction rejects delegate_subagent actions when subagentType is not in registry", () => {
  expect(
    parseManagerLoopAction(
      {
        kind: "delegate_subagent",
        subagentType: "unknown",
        goal: "Unknown subagent should fail.",
      },
      {
        isSubagentType: (subagentType) => subagentType === "coder",
      },
    ),
  ).toBeNull();
});

test("parseManagerLoopAction parses a valid wait action", () => {
  const action = parseManagerLoopAction({
    kind: "wait",
    waitingFor: "ci_status",
    nextWakeupAt: "2026-04-20T09:00:00+08:00",
  });

  expect(action).toEqual({
    kind: "wait",
    waitingFor: "ci_status",
    nextWakeupAt: "2026-04-20T01:00:00.000Z",
  });
});

test("parseManagerLoopAction rejects legacy delegation fields", () => {
  expect(
    parseManagerLoopAction({
      kind: "delegate_subagent",
      subagentType: "coder",
      goal: "Do coding work.",
      delegateAgent: "coder",
      taskDescription: "legacy shape",
      details: "legacy shape",
      expectedOutput: "legacy shape",
    }),
  ).toBeNull();
});

test("parseManagerLoopAction rejects mixed terminal fields", () => {
  expect(
    parseManagerLoopAction({
      kind: "respond",
      reply: "This should not include wakeup metadata.",
      nextWakeupAt: "2026-04-20T09:00:00+08:00",
    }),
  ).toBeNull();

  expect(
    parseManagerLoopAction({
      kind: "wait",
      nextWakeupAt: "2026-04-20T09:00:00+08:00",
      reply: "This should not include reply text.",
    }),
  ).toBeNull();
});

test("parseManagerLoopAction rejects call_tool/delegate_subagent actions if validators are not provided", () => {
  expect(
    parseManagerLoopAction({
      kind: "call_tool",
      toolName: "read_file",
      arguments: {},
    }),
  ).toBeNull();

  expect(
    parseManagerLoopAction({
      kind: "delegate_subagent",
      subagentType: "coder",
      goal: "Implement the endpoint.",
    }),
  ).toBeNull();
});

test("parseManagerLoopAction rejects wait actions with invalid timestamps", () => {
  expect(
    parseManagerLoopAction({
      kind: "wait",
      nextWakeupAt: "tomorrow morning",
    }),
  ).toBeNull();

  expect(
    parseManagerLoopAction({
      kind: "wait",
      nextWakeupAt: "2026-04-20T09:00:00",
    }),
  ).toBeNull();
});
