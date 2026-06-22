import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildTaskTree } from "../../src/services/build-task-tree-service";
import { TaskRepository } from "../../src/repositories/task-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { ArtifactRepository } from "../../src/repositories/artifact-repository";

const tempRoot = join(process.cwd(), ".tmp-tree-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(tempRoot, `tree-${Date.now()}.sqlite`);
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("buildTaskTree returns null for nonexistent task", async () => {
  const result = await buildTaskTree("nonexistent");
  expect(result).toBeNull();
});

test("buildTaskTree builds tree from checkpoint messages", async () => {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const eventRepo = new ExecutionEventRepository();
  const now = new Date();

  await taskRepo.create({
    id: "t-1",
    workspaceId: "ws",
    source: "web",
    title: "Test task",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
    completedAt: new Date(now.getTime() + 5000),
  });

  await runtimeRepo.create({
    id: "rt-leader",
    taskId: "t-1",
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    updatedAt: now,
  });

  // Write a checkpoint with conversation messages
  await eventRepo.create({
    id: "evt-cp",
    type: "leader.session_checkpoint",
    taskId: "t-1",
    roleRuntimeId: "rt-leader",
    occurredAt: new Date(now.getTime() + 4000),
    payloadJson: JSON.stringify({
      messages: [
        { type: "user", content: "What's the weather?" },
        { type: "assistant", content: [{ type: "tool_use", id: "t1", name: "web_search", input: { query: "weather" } }] },
        { type: "tool_result", toolUseId: "t1", content: "Sunny 25°C" },
        { type: "assistant", content: [{ type: "text", text: "It's sunny and 25°C" }] },
      ],
    }),
  });

  const result = await buildTaskTree("t-1");
  expect(result).not.toBeNull();
  expect(result!.root.type).toBe("task");
  expect(result!.root.children.length).toBe(1); // 1 user message group
  expect(result!.root.children[0]!.type).toBe("user_message");
  expect(result!.root.children[0]!.label).toBe("What's the weather?");
  // User message group should have: tool_call + leader_response
  const userGroup = result!.root.children[0]!;
  expect(userGroup.children.length).toBe(2);
  expect(userGroup.children[0]!.type).toBe("tool_call");
  expect(userGroup.children[0]!.label).toBe("web_search");
  expect(userGroup.children[0]!.state).toBe("completed");
  expect(userGroup.children[1]!.type).toBe("leader_response");
  expect(result!.stats.toolCalls).toBe(1);
  expect(result!.stats.userMessages).toBe(1);
});

test("buildTaskTree includes teammate runtimes", async () => {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const eventRepo = new ExecutionEventRepository();
  const now = new Date();

  await taskRepo.create({
    id: "t-2",
    workspaceId: "ws",
    source: "web",
    title: "Complex task",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "rt-leader-2",
    taskId: "t-2",
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "rt-coder",
    taskId: "t-2",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "rt-leader-2",
    attemptCount: 0,
    startedAt: now,
    completedAt: new Date(now.getTime() + 10000),
    updatedAt: now,
  });

  await eventRepo.create({
    id: "evt-cp-2",
    type: "leader.session_checkpoint",
    taskId: "t-2",
    roleRuntimeId: "rt-leader-2",
    occurredAt: now,
    payloadJson: JSON.stringify({
      messages: [
        { type: "user", content: "Fix the bug" },
        { type: "assistant", content: [{ type: "text", text: "I'll delegate to a coder agent." }] },
      ],
    }),
  });

  const result = await buildTaskTree("t-2");
  expect(result).not.toBeNull();
  const userGroup = result!.root.children[0]!;
  // Should have: leader_response + teammate
  const teammateNode = userGroup.children.find((n) => n.type === "teammate");
  expect(teammateNode).toBeDefined();
  expect(teammateNode!.label).toBe("coder");
  expect(result!.stats.teammates).toBe(1);
});

test("buildTaskTree attaches artifacts and recent events to runtime-backed nodes", async () => {
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const eventRepo = new ExecutionEventRepository();
  const artifactRepo = new ArtifactRepository();
  const now = new Date();

  await taskRepo.create({
    id: "t-3",
    workspaceId: "ws",
    source: "web",
    title: "Task with artifacts",
    state: "DONE",
    createdAt: now,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "rt-leader-3",
    taskId: "t-3",
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    updatedAt: now,
  });

  await runtimeRepo.create({
    id: "rt-coder-3",
    taskId: "t-3",
    roleId: "coder",
    state: "COMPLETED",
    parentRunId: "rt-leader-3",
    attemptCount: 0,
    startedAt: now,
    completedAt: new Date(now.getTime() + 10_000),
    updatedAt: now,
  });

  // Leader artifact + teammate artifact — both should bucket to the
  // right runtime.
  await artifactRepo.create({
    id: "art-leader-1",
    taskId: "t-3",
    roleRuntimeId: "rt-leader-3",
    artifactType: "file",
    title: "plan.md",
    storageKind: "fs",
    storageRef: "/tmp/plan.md",
    summary: "Initial plan",
    createdAt: new Date(now.getTime() + 1000),
  });
  await artifactRepo.create({
    id: "art-coder-1",
    taskId: "t-3",
    roleRuntimeId: "rt-coder-3",
    artifactType: "file",
    title: "patch.diff",
    storageKind: "fs",
    storageRef: "/tmp/patch.diff",
    summary: "Bug fix",
    createdAt: new Date(now.getTime() + 5000),
  });

  // Structured events that should surface
  await eventRepo.create({
    id: "evt-decision-1",
    type: "leader.decision_trace",
    taskId: "t-3",
    roleRuntimeId: "rt-leader-3",
    occurredAt: new Date(now.getTime() + 2000),
    payloadJson: JSON.stringify({ turnIndex: 1, toolNames: ["bash"], toolCount: 1 }),
  });
  await eventRepo.create({
    id: "evt-error-1",
    type: "leader.model_error",
    taskId: "t-3",
    roleRuntimeId: "rt-leader-3",
    occurredAt: new Date(now.getTime() + 3000),
    payloadJson: JSON.stringify({ message: "rate limited" }),
  });
  // Noisy event that must NOT appear
  await eventRepo.create({
    id: "evt-noise-1",
    type: "leader.stream_delta",
    taskId: "t-3",
    roleRuntimeId: "rt-leader-3",
    occurredAt: new Date(now.getTime() + 3500),
    payloadJson: JSON.stringify({ type: "text_delta", text: "hi" }),
  });

  // Minimal checkpoint so the tree has a user_message group for the
  // teammate to attach under
  await eventRepo.create({
    id: "evt-cp-3",
    type: "leader.session_checkpoint",
    taskId: "t-3",
    roleRuntimeId: "rt-leader-3",
    occurredAt: now,
    payloadJson: JSON.stringify({
      messages: [{ type: "user", content: "Patch the bug" }],
    }),
  });

  const result = await buildTaskTree("t-3");
  expect(result).not.toBeNull();

  // Root (task) node — backed by leader runtime
  expect(result!.root.artifacts).toBeDefined();
  expect(result!.root.artifacts!.length).toBe(1);
  expect(result!.root.artifacts![0]!.path).toBe("/tmp/plan.md");
  expect(result!.root.artifacts![0]!.summary).toBe("Initial plan");

  expect(result!.root.recentEvents).toBeDefined();
  // model_error + decision_trace; stream_delta excluded
  expect(result!.root.recentEvents!.length).toBe(2);
  const eventTypes = result!.root.recentEvents!.map((e) => e.eventType);
  expect(eventTypes).toContain("leader.model_error");
  expect(eventTypes).toContain("leader.decision_trace");
  expect(eventTypes).not.toContain("leader.stream_delta");

  // Teammate node — own artifact + no events
  const userGroup = result!.root.children[0]!;
  const teammate = userGroup.children.find((n) => n.type === "teammate");
  expect(teammate).toBeDefined();
  expect(teammate!.artifacts).toBeDefined();
  expect(teammate!.artifacts!.length).toBe(1);
  expect(teammate!.artifacts![0]!.path).toBe("/tmp/patch.diff");
  expect(teammate!.recentEvents).toBeDefined();
  expect(teammate!.recentEvents!.length).toBe(0);
});
