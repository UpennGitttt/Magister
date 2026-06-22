import type { TaskStreamSnapshot, TaskSummary } from "./types";

function shallowEqualObjects(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }

  return true;
}

function areEventsEqual(
  left: TaskStreamSnapshot["events"],
  right: TaskStreamSnapshot["events"],
): boolean {
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i++) {
    const leftEvent = left[i];
    const rightEvent = right[i];
    if (!leftEvent || !rightEvent) return false;
    if (
      !shallowEqualObjects(
        leftEvent as unknown as Record<string, unknown>,
        rightEvent as unknown as Record<string, unknown>,
      )
    ) {
      return false;
    }
  }

  return true;
}

export function mergeTaskSnapshot(
  current: TaskStreamSnapshot | null,
  incoming: TaskStreamSnapshot,
): TaskStreamSnapshot {
  if (!current || current.task.id !== incoming.task.id) {
    return incoming;
  }

  const mergedEvents = new Map<string, TaskStreamSnapshot["events"][number]>();
  for (const event of current.events) {
    mergedEvents.set(event.id, event);
  }
  for (const event of incoming.events) {
    mergedEvents.set(event.id, event);
  }

  const nextEvents = Array.from(mergedEvents.values()).sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );
  const task = shallowEqualObjects(
    current.task as unknown as Record<string, unknown>,
    incoming.task as unknown as Record<string, unknown>,
  )
    ? current.task
    : incoming.task;
  const events = areEventsEqual(current.events, nextEvents) ? current.events : nextEvents;

  if (task === current.task && events === current.events) {
    return current;
  }

  return {
    task,
    events,
  };
}

export function findLatestTaskForBinding(
  tasks: TaskSummary[],
  rootChannelBindingId: string,
): TaskSummary | null {
  return (
    [...tasks]
      .filter((task) => task.rootChannelBindingId === rootChannelBindingId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ??
    null
  );
}
