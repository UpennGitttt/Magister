import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import { TaskRepository } from "../../src/repositories/task-repository";

export type LargeSessionFixtureEvent = {
  id: string;
  type: string;
  taskId: string;
  roleRuntimeId: string;
  requestId: string;
  occurredAt: Date;
  payloadJson: string;
};

export function makeLargeSessionEvents(input: {
  taskId: string;
  runId: string;
  eventCount: number;
  requestCount?: number;
  startedAt?: Date;
}): LargeSessionFixtureEvent[] {
  const requestCount = Math.max(1, Math.min(input.requestCount ?? input.eventCount, input.eventCount));
  const startedAtMs = (input.startedAt ?? new Date("2026-05-12T00:00:00.000Z")).getTime();

  return Array.from({ length: input.eventCount }, (_, index) => {
    const requestOrdinal = Math.min(
      requestCount - 1,
      Math.floor(index / Math.ceil(input.eventCount / requestCount)),
    );
    const requestId = `req_large_${String(requestOrdinal + 1).padStart(5, "0")}`;
    const type = index % 7 === 6 ? "leader.turn_complete" : "leader.stream_delta";
    return {
      id: `evt_large_${String(index + 1).padStart(6, "0")}`,
      type,
      taskId: input.taskId,
      roleRuntimeId: input.runId,
      requestId,
      occurredAt: new Date(startedAtMs + index),
      payloadJson: JSON.stringify(
        type === "leader.stream_delta"
          ? { type: "text_delta", text: `chunk-${index}` }
          : { eventIndex: index },
      ),
    };
  });
}

export async function seedLargeSessionFixture(input: {
  taskId: string;
  runId: string;
  eventCount: number;
  requestCount?: number;
  state?: string;
}) {
  const now = new Date("2026-05-12T00:00:00.000Z");
  await new TaskRepository().create({
    id: input.taskId,
    title: `Large session ${input.eventCount} events`,
    state: input.state ?? "DONE",
    source: "web",
    workspaceId: "workspace_main",
    createdAt: now,
    updatedAt: now,
  });
  await new RoleRuntimeRepository().create({
    id: input.runId,
    taskId: input.taskId,
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });

  const events = makeLargeSessionEvents(input);
  const repo = new ExecutionEventRepository();
  for (const event of events) {
    await repo.create(event);
  }
  return events;
}
