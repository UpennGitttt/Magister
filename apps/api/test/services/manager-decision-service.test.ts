import { expect, test } from "bun:test";

import { extractManagerDecisionOutput } from "../../src/services/manager-decision-service";

test("extractManagerDecisionOutput parses a valid JSON decision", () => {
  const rawOutput = JSON.stringify({
    taskType: "coding",
    executionMode: "bounded_execution",
    decision: "spawn_work_items",
    confidence: "high",
    reply: "Proceeding with the implementation plan.",
    skills: [
      {
        skillId: "implement_code",
        goal: "Implement the endpoint.",
      },
    ],
    childWorkItems: [
      {
        roleId: "architect",
        skillId: "inspect_repo",
        goal: "Inspect the repository and identify constraints.",
        dependsOn: [],
      },
      {
        roleId: "coder",
        skillId: "implement_code",
        goal: "Implement the endpoint.",
        dependsOn: ["architect"],
      },
    ],
    waitingFor: null,
    nextWakeupAt: null,
    warnings: [],
  });

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: {
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      reply: "Proceeding with the implementation plan.",
      skills: [
        {
          skillId: "implement_code",
          goal: "Implement the endpoint.",
        },
      ],
      childWorkItems: [
        {
          subagentType: "architect",
          roleId: "architect",
          skillId: "inspect_repo",
          goal: "Inspect the repository and identify constraints.",
          dependsOn: [],
          executionKind: "delegated_subagent",
        },
        {
          subagentType: "coder",
          roleId: "coder",
          skillId: "implement_code",
          goal: "Implement the endpoint.",
          dependsOn: ["architect"],
          executionKind: "delegated_subagent",
        },
      ],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    },
    rawOutput,
    fallbackReason: null,
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("extractManagerDecisionOutput preserves raw output when JSON is invalid", () => {
  const rawOutput = "{\"taskType\":\"coding\",\"decision\":\"spawn_work_items\"";

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: null,
    rawOutput,
    fallbackReason: "invalid_json",
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("parseManagerDecision rejects duplicate child work item role ids", () => {
  expect(
    extractManagerDecisionOutput(
      JSON.stringify({
        taskType: "mixed",
        executionMode: "bounded_execution",
        decision: "spawn_work_items",
        confidence: "high",
        childWorkItems: [
          {
            roleId: "coder",
            skillId: "implement_code",
            goal: "Implement the endpoint.",
          },
          {
            roleId: "coder",
            skillId: "run_tests",
            goal: "Duplicate coder entry should be rejected.",
          },
        ],
      }),
    ),
  ).toEqual({
    parsedDecision: null,
    rawOutput: JSON.stringify({
      taskType: "mixed",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      childWorkItems: [
        {
          roleId: "coder",
          skillId: "implement_code",
          goal: "Implement the endpoint.",
        },
        {
          roleId: "coder",
          skillId: "run_tests",
          goal: "Duplicate coder entry should be rejected.",
        },
      ],
    }),
    fallbackReason: "invalid_decision",
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("extractManagerDecisionOutput tolerates greeting-style direct answers from the manager", () => {
  const rawOutput = JSON.stringify({
    taskType: "greeting",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: "high",
    reply: "你好，我是 Magister。请告诉我你希望我处理的具体事项。",
    childWorkItems: [],
    waitingFor: [],
    nextWakeupAt: null,
    warnings: [],
  });

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: {
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: "你好，我是 Magister。请告诉我你希望我处理的具体事项。",
      skills: [],
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    },
    rawOutput,
    fallbackReason: null,
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("extractManagerDecisionOutput tolerates ask_user task types from the manager", () => {
  const rawOutput = JSON.stringify({
    taskType: "ask_user",
    executionMode: "immediate",
    decision: "ask_user",
    confidence: "high",
    reply: "请告诉我你希望我处理的具体事项。",
    childWorkItems: [],
    waitingFor: [],
    nextWakeupAt: null,
    warnings: [],
  });

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: {
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: "high",
      reply: "请告诉我你希望我处理的具体事项。",
      skills: [],
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    },
    rawOutput,
    fallbackReason: null,
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("extractManagerDecisionOutput tolerates numeric confidence scores from the manager", () => {
  const rawOutput = JSON.stringify({
    taskType: "greeting",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: 0.99,
    reply: "你好，我在。请告诉我你希望我处理的具体事项。",
    childWorkItems: [],
    waitingFor: [],
    nextWakeupAt: null,
    warnings: [],
  });

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: {
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: "你好，我在。请告诉我你希望我处理的具体事项。",
      skills: [],
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    },
    rawOutput,
    fallbackReason: null,
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});

test("extractManagerDecisionOutput tolerates numeric confidence scores encoded as strings", () => {
  const rawOutput = JSON.stringify({
    taskType: "conversation",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: "1.0",
    reply: "现在是 2026 年 4 月 18 日 13:33:44。",
    childWorkItems: [],
    waitingFor: [],
    nextWakeupAt: null,
    warnings: [],
  });

  expect(extractManagerDecisionOutput(rawOutput)).toEqual({
    parsedDecision: {
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: "现在是 2026 年 4 月 18 日 13:33:44。",
      skills: [],
      childWorkItems: [],
      waitingFor: null,
      nextWakeupAt: null,
      warnings: [],
    },
    rawOutput,
    fallbackReason: null,
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  });
});
