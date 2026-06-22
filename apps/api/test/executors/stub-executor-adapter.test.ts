import { expect, test } from "bun:test";

import type { ExecutorDispatchDependencies, ExecutorSlotSnapshot } from "../../src/executors/executor-adapter";
import { createStubExecutorAdapter } from "../../src/executors/stub-executor-adapter";

function createFakeDependencies(): {
  dependencies: ExecutorDispatchDependencies;
  runtimeUpdates: Array<{ id: string; input: Record<string, unknown> }>;
  taskUpdates: Array<{ id: string; input: Record<string, unknown> }>;
  artifactCreates: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
} {
  const runtimeUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const taskUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const artifactCreates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];

  return {
    dependencies: {
      roleRuntimeRepository: {
        async update(id, input) {
          runtimeUpdates.push({ id, input: input as Record<string, unknown> });
        },
      },
      taskRepository: {
        async update(id, input) {
          taskUpdates.push({ id, input: input as Record<string, unknown> });
        },
      },
      artifactRepository: {
        async create(input) {
          artifactCreates.push(input as Record<string, unknown>);
        },
        async getById(id) {
          return artifactCreates.find((artifact) => artifact.id === id) as never;
        },
      },
      observabilityAdapter: {
        async recordEvent(event) {
          events.push(event as Record<string, unknown>);
          return {
            event,
            taskSummary: null,
            runSummary: null,
          };
        },
      },
    },
    runtimeUpdates,
    taskUpdates,
    artifactCreates,
    events,
  };
}

test("stub executor adapter materializes a successful execution lifecycle", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "claude_code",
    displayName: "Claude Code",
    executorType: "coding_agent",
    roleTargets: ["leader"],
    configKey: "MAGISTER_MODEL_CLAUDE_CODE",
    executionMode: "cli",
    status: "configured",
    configuredModel: "claude-sonnet-4.5",
    configSource: "file",
    notes: "Primary manager slot for long-context orchestration and escalation handling.",
  };
  const dependencies = createFakeDependencies();

  const result = await createStubExecutorAdapter(slot).execute({
    runtime: {
      id: "runtime_1",
      taskId: "task_1",
      roleId: "leader",
      state: "CREATED",
      attemptCount: 0,
      delegationMode: "delegate_fresh",
    },
    task: {
      id: "task_1",
      workspaceId: "workspace_main",
      state: "INTAKE",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-10T11:20:00.000Z"),
    createId: () => "stub-123",
  });

  expect(result).toEqual({
    ok: true,
    runId: "runtime_1",
    adapterId: "claude_code",
    state: "COMPLETED",
    sessionId: "session_stub-123",
    artifactId: "artifact_stub-123",
  });
  expect(dependencies.runtimeUpdates).toHaveLength(2);
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.artifactCreates).toHaveLength(1);
  expect(dependencies.events).toHaveLength(2);
  expect(dependencies.events[0]).toMatchObject({
    type: "executor_session.started",
    executorSessionId: "session_stub-123",
  });
  expect(dependencies.events[1]).toMatchObject({
    type: "executor_session.completed",
    artifactId: "artifact_stub-123",
  });
  expect(dependencies.artifactCreates[0]).toMatchObject({
    id: "artifact_stub-123",
    artifactType: "plan",
    title: "Leader execution note",
    summary: "Stub executor completed the leader run",
  });
});

test("stub executor adapter marks the run blocked when the slot is unconfigured", async () => {
  const slot: ExecutorSlotSnapshot = {
    adapterId: "qoder",
    displayName: "Qoder",
    executorType: "coding_agent",
    roleTargets: ["reviewer"],
    configKey: "MAGISTER_MODEL_QODER",
    executionMode: "cli",
    status: "unconfigured",
    configSource: "default",
    notes: "Review-focused slot for PR critique and quality gate feedback.",
  };
  const dependencies = createFakeDependencies();

  const result = await createStubExecutorAdapter(slot).execute({
    runtime: {
      id: "runtime_2",
      taskId: "task_2",
      roleId: "reviewer",
      state: "CREATED",
      attemptCount: 3,
      delegationMode: "delegate_with_context",
    },
    task: {
      id: "task_2",
      workspaceId: "workspace_main",
      state: "IN_PROGRESS",
    },
    slot,
    dependencies: dependencies.dependencies,
    now: () => new Date("2026-04-10T11:30:00.000Z"),
    createId: () => "stub-456",
  });

  expect(result).toEqual({
    ok: false,
    runId: "runtime_2",
    adapterId: "qoder",
    state: "FAILED",
    code: "executor_unconfigured",
    message: "Configure a model for Qoder before dispatching the reviewer run",
  });
  expect(dependencies.runtimeUpdates).toHaveLength(1);
  expect(dependencies.runtimeUpdates[0]).toMatchObject({
    id: "runtime_2",
    input: expect.objectContaining({
      state: "FAILED",
      activeExecutorId: "qoder",
      currentSessionId: null,
      attemptCount: 4,
    }),
  });
  expect(dependencies.taskUpdates).toHaveLength(1);
  expect(dependencies.taskUpdates[0]).toMatchObject({
    id: "task_2",
    input: expect.objectContaining({
      state: "BLOCKED",
    }),
  });
  expect(dependencies.artifactCreates).toHaveLength(0);
  expect(dependencies.events).toHaveLength(1);
  expect(dependencies.events[0]).toMatchObject({
    type: "executor_session.failed",
    severity: "error",
  });
});
