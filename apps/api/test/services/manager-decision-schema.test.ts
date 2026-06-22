import { expect, test } from "bun:test";

import { isManagerDecision, parseManagerDecision } from "../../src/services/manager-decision-schema";

test("parseManagerDecision parses a valid manager decision", () => {
  const decision = parseManagerDecision({
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
  });

  expect(decision).toEqual({
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
  });
  expect(isManagerDecision(decision)).toBe(true);
});

test("parseManagerDecision rejects missing required fields", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      confidence: "high",
    }),
  ).toBeNull();
  expect(
    isManagerDecision({
      taskType: "coding",
      confidence: "high",
    }),
  ).toBe(false);
});

test("parseManagerDecision rejects invalid taskType and decision", () => {
  expect(
    parseManagerDecision({
      taskType: "invalid",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "medium",
    }),
  ).toBeNull();
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "invalid",
      confidence: "medium",
    }),
  ).toBeNull();
});

test("parseManagerDecision normalizes greeting-style task types and empty waitingFor arrays", () => {
  const decision = parseManagerDecision({
    taskType: "greeting",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: "high",
    reply: "你好，我是 Magister。",
    childWorkItems: [],
    waitingFor: [],
    nextWakeupAt: null,
    warnings: [],
  });

  expect(decision).toEqual({
    taskType: "conversation",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: "high",
    reply: "你好，我是 Magister。",
    skills: [],
    childWorkItems: [],
    waitingFor: null,
    nextWakeupAt: null,
    warnings: [],
  });
});

test("parseManagerDecision normalizes ask_user-style task types and empty waitingFor arrays", () => {
  const decision = parseManagerDecision({
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

  expect(decision).toEqual({
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
  });
});

test("parseManagerDecision normalizes numeric confidence scores", () => {
  expect(
    parseManagerDecision({
      taskType: "greeting",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: 0.99,
      reply: "你好，我在。",
      childWorkItems: [],
      waitingFor: [],
      nextWakeupAt: null,
      warnings: [],
    }),
  ).toEqual({
    taskType: "conversation",
    executionMode: "immediate",
    decision: "direct_answer",
    confidence: "high",
    reply: "你好，我在。",
    skills: [],
    childWorkItems: [],
    waitingFor: null,
    nextWakeupAt: null,
    warnings: [],
  });

  expect(
    parseManagerDecision({
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: 0.7,
      reply: "请再具体一点。",
    })?.confidence,
  ).toBe("medium");

  expect(
    parseManagerDecision({
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: 0.1,
      reply: "请再具体一点。",
    })?.confidence,
  ).toBe("low");
});

test("parseManagerDecision rejects invalid executionMode", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "invalid",
      decision: "spawn_work_items",
      confidence: "medium",
    }),
  ).toBeNull();
});

test("parseManagerDecision normalizes childWorkItems to a stable shape", () => {
  const decision = parseManagerDecision({
    taskType: "mixed",
    executionMode: "long_running",
    decision: "spawn_work_items",
    confidence: "medium",
    childWorkItems: [
      null,
      {
        roleId: "coder",
        skillId: "implement_code",
        goal: "Implement the endpoint.",
        whyThisWorkItem: "The code change is the next blocking step.",
        completionSignal: "The endpoint exists and typecheck passes.",
        handoffNotes: "Flag any review risk after implementation.",
        executionKind: "delegated_subagent",
      },
      {
        roleId: "reviewer",
        skillId: "review_changes",
        goal: "Review the patch.",
        dependsOn: ["coder", 42, null],
        whyThisWorkItem: "Review is required before landing.",
        executionKind: "delegated_subagent",
      },
    ],
  });

  expect(decision?.childWorkItems).toEqual([
    {
      subagentType: "coder",
      roleId: "coder",
      skillId: "implement_code",
      goal: "Implement the endpoint.",
      dependsOn: [],
      executionKind: "delegated_subagent",
      whyThisInvocation: "The code change is the next blocking step.",
      whyThisWorkItem: "The code change is the next blocking step.",
      completionSignal: "The endpoint exists and typecheck passes.",
      handoffNotes: "Flag any review risk after implementation.",
    },
    {
      subagentType: "reviewer",
      roleId: "reviewer",
      skillId: "review_changes",
      goal: "Review the patch.",
      dependsOn: ["coder"],
      executionKind: "delegated_subagent",
      whyThisInvocation: "Review is required before landing.",
      whyThisWorkItem: "Review is required before landing.",
    },
  ]);
});

test("parseManagerDecision supports the SubagentInvocation contract shape", () => {
  const decision = parseManagerDecision({
    taskType: "mixed",
    executionMode: "bounded_execution",
    decision: "spawn_work_items",
    confidence: "high",
    childWorkItems: [
      {
        subagentType: "coder",
        skillId: "implement_code",
        goal: "Implement the endpoint and wire tests.",
        whyThisInvocation: "Code changes are required before review can begin.",
        completionSignal: "Patch is applied and tests relevant to the change pass.",
        handoffNotes: "Call out migration or rollout risks in the summary.",
        executionBudget: {
          maxAttempts: 2,
          maxSteps: 12,
          maxRuntimeMinutes: 45,
        },
        workspaceStrategy: "git_worktree",
        routingHints: {
          primaryAdapterId: "codex",
          routingStrategy: "prefer_agent",
          fallbackAdapterId: "qoder",
          executorClass: "coding_agent",
        },
      },
    ],
  });

  expect(decision?.childWorkItems).toEqual([
    {
      subagentType: "coder",
      roleId: "coder",
      skillId: "implement_code",
      goal: "Implement the endpoint and wire tests.",
      dependsOn: [],
      executionKind: "delegated_subagent",
      whyThisInvocation: "Code changes are required before review can begin.",
      whyThisWorkItem: "Code changes are required before review can begin.",
      completionSignal: "Patch is applied and tests relevant to the change pass.",
      handoffNotes: "Call out migration or rollout risks in the summary.",
      executionBudget: {
        maxAttempts: 2,
        maxSteps: 12,
        maxRuntimeMinutes: 45,
      },
      workspaceStrategy: "git_worktree",
      routingHints: {
        primaryAdapterId: "codex",
        routingStrategy: "prefer_agent",
        fallbackAdapterId: "qoder",
        executorClass: "coding_agent",
      },
      primaryAdapterId: "codex",
      routingStrategy: "prefer_agent",
      fallbackAdapterId: "qoder",
      executorClass: "coding_agent",
    },
  ]);
});

test("parseManagerDecision rejects invalid executionBudget and workspaceStrategy in subagent contract items", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      childWorkItems: [
        {
          subagentType: "reviewer",
          skillId: "review_changes",
          goal: "Review the patch after coding completes.",
          executionBudget: {
            maxAttempts: 0,
          },
          workspaceStrategy: "invalid_workspace_strategy",
        },
      ],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects spawn_work_items decisions without child work items", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      childWorkItems: [],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects use_skill decisions without skills", () => {
  expect(
    parseManagerDecision({
      taskType: "conversation",
      executionMode: "bounded_execution",
      decision: "use_skill",
      confidence: "medium",
      skills: [],
    }),
  ).toBeNull();
});

test("parseManagerDecision requires reply for direct_answer decisions", () => {
  expect(
    parseManagerDecision({
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: null,
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects direct_answer decisions that also spawn child work items", () => {
  expect(
    parseManagerDecision({
      taskType: "conversation",
      executionMode: "immediate",
      decision: "direct_answer",
      confidence: "high",
      reply: "Here is the answer.",
      childWorkItems: [
        {
          roleId: "coder",
          skillId: "implement_code",
          goal: "Should not be dispatched.",
        },
      ],
    }),
  ).toBeNull();
});

test("parseManagerDecision requires reply for ask_user decisions", () => {
  expect(
    parseManagerDecision({
      taskType: "clarify",
      executionMode: "immediate",
      decision: "ask_user",
      confidence: "medium",
      reply: null,
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects use_skill decisions that also include child work items", () => {
  expect(
    parseManagerDecision({
      taskType: "conversation",
      executionMode: "bounded_execution",
      decision: "use_skill",
      confidence: "medium",
      skills: [
        {
          skillId: "inspect_repo",
          goal: "Inspect the current repository.",
        },
      ],
      childWorkItems: [
        {
          roleId: "architect",
          skillId: "inspect_repo",
          goal: "Inspect the repository.",
        },
      ],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects unknown manager skill ids", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "use_skill",
      confidence: "high",
      skills: [
        {
          skillId: "unknown_skill",
          goal: "Do something unclear",
        },
      ],
      childWorkItems: [],
      warnings: [],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects child work items whose role is incompatible with the skill", () => {
  expect(
    parseManagerDecision({
      taskType: "coding",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      skills: [
        {
          skillId: "prepare_delivery",
          goal: "Prepare the release handoff",
        },
      ],
      childWorkItems: [
        {
          roleId: "coder",
          skillId: "prepare_delivery",
          goal: "Prepare the release handoff",
          dependsOn: [],
        },
      ],
      warnings: [],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects sleep_until decisions without nextWakeupAt", () => {
  expect(
    parseManagerDecision({
      taskType: "wait",
      executionMode: "long_running",
      decision: "sleep_until",
      confidence: "medium",
      nextWakeupAt: null,
    }),
  ).toBeNull();
});

test("parseManagerDecision parses a valid sleep_until decision", () => {
  const decision = parseManagerDecision({
    taskType: "wait",
    executionMode: "long_running",
    decision: "sleep_until",
    confidence: "high",
    waitingFor: "ci_status",
    nextWakeupAt: "2026-04-12T10:00:00.000Z",
    warnings: ["Waiting for CI to finish before resuming orchestration."],
  });

  expect(decision).toEqual({
    taskType: "wait",
    executionMode: "long_running",
    decision: "sleep_until",
    confidence: "high",
    reply: null,
    skills: [],
    childWorkItems: [],
    waitingFor: "ci_status",
    nextWakeupAt: "2026-04-12T10:00:00.000Z",
    warnings: ["Waiting for CI to finish before resuming orchestration."],
  });
});

test("parseManagerDecision rejects sleep_until decisions that also include child work items or skills", () => {
  expect(
    parseManagerDecision({
      taskType: "wait",
      executionMode: "long_running",
      decision: "sleep_until",
      confidence: "high",
      waitingFor: "ci_status",
      nextWakeupAt: "2026-04-12T10:00:00.000Z",
      skills: [
        {
          skillId: "inspect_repo",
          goal: "Should not coexist with wait.",
        },
      ],
      childWorkItems: [
        {
          roleId: "architect",
          skillId: "inspect_repo",
          goal: "Should not be dispatched while waiting.",
        },
      ],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects sleep_until decisions with an invalid nextWakeupAt timestamp", () => {
  expect(
    parseManagerDecision({
      taskType: "wait",
      executionMode: "long_running",
      decision: "sleep_until",
      confidence: "medium",
      nextWakeupAt: "tomorrow morning",
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects sleep_until decisions without an explicit timezone offset", () => {
  expect(
    parseManagerDecision({
      taskType: "wait",
      executionMode: "long_running",
      decision: "sleep_until",
      confidence: "medium",
      nextWakeupAt: "2026-04-12T10:00:00",
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects duplicate childWorkItems role ids", () => {
  const decision = parseManagerDecision({
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
        goal: "Duplicate coder entry should be ignored.",
      },
      {
        roleId: "reviewer",
        skillId: "review_changes",
        goal: "Review the patch.",
      },
    ],
  });

  expect(decision).toBeNull();
});

test("parseManagerDecision rejects child work items that depend on missing child roles", () => {
  expect(
    parseManagerDecision({
      taskType: "mixed",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      childWorkItems: [
        {
          roleId: "coder",
          skillId: "implement_code",
          goal: "Implement the endpoint.",
          dependsOn: ["architect"],
        },
      ],
    }),
  ).toBeNull();
});

test("parseManagerDecision rejects cyclic child work item dependencies", () => {
  expect(
    parseManagerDecision({
      taskType: "mixed",
      executionMode: "bounded_execution",
      decision: "spawn_work_items",
      confidence: "high",
      childWorkItems: [
        {
          roleId: "coder",
          skillId: "implement_code",
          goal: "Implement the endpoint.",
          dependsOn: ["reviewer"],
        },
        {
          roleId: "reviewer",
          skillId: "review_changes",
          goal: "Review the patch.",
          dependsOn: ["coder"],
        },
      ],
    }),
  ).toBeNull();
});
