import "../test-setup";
import { expect, test } from "bun:test";

import {
  findLatestTaskForBinding,
  mergeTaskSnapshot,
} from "./task-streaming";
import type { TaskStreamSnapshot, TaskSummary } from "./types";

function createTaskSummary(overrides?: Partial<TaskSummary>): TaskSummary {
  return {
    id: "task_1",
    title: "Investigate live updates",
    state: "RUNNING",
    source: "web",
    workspaceId: "workspace_main",
    updatedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  };
}

function createSnapshot(
  taskOverrides?: Partial<TaskSummary>,
  events?: TaskStreamSnapshot["events"],
): TaskStreamSnapshot {
  return {
    task: createTaskSummary(taskOverrides),
    events:
      events ??
      [
        {
          id: "evt_1",
          type: "leader.tool_call",
          occurredAt: "2026-04-21T12:00:01.000Z",
          payloadJson: "{\"toolName\":\"web_search\"}",
        },
      ],
  };
}

test("mergeTaskSnapshot preserves existing events and appends new ones by id", () => {
  const current = createSnapshot(undefined, [
    {
      id: "evt_1",
      type: "leader.tool_call",
      occurredAt: "2026-04-21T12:00:01.000Z",
      payloadJson: "{\"toolName\":\"web_search\"}",
    },
  ]);

  const incoming = createSnapshot(
    {
      state: "DONE",
      updatedAt: "2026-04-21T12:00:03.000Z",
    },
    [
      {
        id: "evt_1",
        type: "leader.tool_call",
        occurredAt: "2026-04-21T12:00:01.000Z",
        payloadJson: "{\"toolName\":\"web_search\"}",
      },
      {
        id: "evt_2",
        type: "leader.tool_result",
        occurredAt: "2026-04-21T12:00:02.000Z",
        payloadJson: "{\"toolName\":\"web_search\",\"status\":\"succeeded\"}",
      },
    ],
  );

  expect(mergeTaskSnapshot(current, incoming)).toEqual({
    task: incoming.task,
    events: [
      current.events[0]!,
      incoming.events[1]!,
    ],
  });
});

test("mergeTaskSnapshot returns the current reference when the incoming snapshot is unchanged", () => {
  const current = createSnapshot();
  const incoming = createSnapshot();

  expect(mergeTaskSnapshot(current, incoming)).toBe(current);
});

test("findLatestTaskForBinding returns the newest task for the current web session", () => {
  const tasks = [
    createTaskSummary({
      id: "task_old",
      rootChannelBindingId: "web:chat:other",
      updatedAt: "2026-04-21T12:00:01.000Z",
    }),
    createTaskSummary({
      id: "task_match_old",
      rootChannelBindingId: "web:chat:session",
      updatedAt: "2026-04-21T12:00:02.000Z",
    }),
    createTaskSummary({
      id: "task_match_new",
      rootChannelBindingId: "web:chat:session",
      updatedAt: "2026-04-21T12:00:03.000Z",
    }),
  ];

  expect(findLatestTaskForBinding(tasks, "web:chat:session")?.id).toBe("task_match_new");
});
