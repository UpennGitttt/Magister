import type { ArtifactInsert, ExecutionEventInsert } from "@magister/db";

import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorDispatchResult,
  ExecutorSlotSnapshot,
} from "./executor-adapter";

function getArtifactDescriptor(roleId: string) {
  switch (roleId) {
    case "leader":
      return {
        artifactType: "plan",
        title: "Leader execution note",
      };
    case "reviewer":
      return {
        artifactType: "review",
        title: "Reviewer execution note",
      };
    default:
      return {
        artifactType: "execution_note",
        title: `${roleId[0]?.toUpperCase() ?? ""}${roleId.slice(1)} execution note`,
      };
  }
}

function buildMessage(roleId: string, verb: "started" | "completed") {
  return `Stub executor ${verb} the ${roleId} run`;
}

function buildFailureMessage(slot: ExecutorSlotSnapshot, roleId: string) {
  return `Configure a model for ${slot.displayName} before dispatching the ${roleId} run`;
}

function createEvent(
  context: ExecutorDispatchContext,
  event: ExecutionEventInsert,
): ExecutionEventInsert {
  return {
    ...event,
    id: event.id ?? `event_${context.createId?.() ?? crypto.randomUUID()}`,
  };
}

export function createStubExecutorAdapter(slot: ExecutorSlotSnapshot): ExecutorAdapter {
  return {
    slot,
    async execute(context: ExecutorDispatchContext): Promise<ExecutorDispatchResult> {
      const createId = context.createId ?? (() => crypto.randomUUID());
      const now = context.now ?? (() => new Date());
      const configuredModel = context.slot.configuredModel?.trim();

      if (!configuredModel) {
        const failedAt = now();
        const message = buildFailureMessage(context.slot, context.runtime.roleId);

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createEvent(context, {
            id: `event_${createId()}`,
            type: "executor_session.failed",
            taskId: context.task.id,
            roleRuntimeId: context.runtime.id,
            workspaceId: context.task.workspaceId,
            severity: "error",
            occurredAt: failedAt,
            payloadJson: JSON.stringify({
              message,
              error: message,
              reason: "executor_unconfigured",
              source: context.slot.adapterId,
              configKey: context.slot.configKey,
            }),
          }),
        );

        return {
          ok: false,
          runId: context.runtime.id,
          adapterId: context.slot.adapterId,
          state: "FAILED",
          code: "executor_unconfigured",
          message,
        };
      }

      const sessionId = `session_${createId()}`;
      const artifactId = `artifact_${createId()}`;
      const startedAt = now();

      await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
        state: "RUNNING",
        activeExecutorId: context.slot.adapterId,
        currentSessionId: sessionId,
        delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
        attemptCount: context.runtime.attemptCount + 1,
        startedAt: context.runtime.startedAt ?? startedAt,
        updatedAt: startedAt,
        completedAt: null,
      });

      await context.dependencies.taskRepository.update(context.task.id, {
        state: "IN_PROGRESS",
        updatedAt: startedAt,
      });

      await context.dependencies.observabilityAdapter.recordEvent(
        createEvent(context, {
          id: `event_${createId()}`,
          type: "executor_session.started",
          taskId: context.task.id,
          roleRuntimeId: context.runtime.id,
          executorSessionId: sessionId,
          workspaceId: context.task.workspaceId,
          severity: "info",
          occurredAt: startedAt,
          payloadJson: JSON.stringify({
            message: buildMessage(context.runtime.roleId, "started"),
            source: context.slot.adapterId,
            configuredModel,
          }),
        }),
      );

      const completionMessage = buildMessage(context.runtime.roleId, "completed");
      const artifactDescriptor = getArtifactDescriptor(context.runtime.roleId);
      const completedAt = now();

      await context.dependencies.artifactRepository.create({
        id: artifactId,
        taskId: context.task.id,
        roleRuntimeId: context.runtime.id,
        artifactType: artifactDescriptor.artifactType,
        title: artifactDescriptor.title,
        storageKind: "inline",
        storageRef: `executor://${sessionId}/artifacts/${artifactId}`,
        summary: completionMessage,
        createdAt: completedAt,
      } satisfies ArtifactInsert);

      await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
        state: "COMPLETED",
        updatedAt: completedAt,
        completedAt,
      });

      await context.dependencies.observabilityAdapter.recordEvent(
        createEvent(context, {
          id: `event_${createId()}`,
          type: "executor_session.completed",
          taskId: context.task.id,
          roleRuntimeId: context.runtime.id,
          executorSessionId: sessionId,
          artifactId,
          workspaceId: context.task.workspaceId,
          severity: "info",
          occurredAt: completedAt,
          payloadJson: JSON.stringify({
            message: completionMessage,
            source: context.slot.adapterId,
            configuredModel,
          }),
        }),
      );

      return {
        ok: true,
        runId: context.runtime.id,
        adapterId: context.slot.adapterId,
        state: "COMPLETED",
        sessionId,
        artifactId,
      };
    },
  };
}
