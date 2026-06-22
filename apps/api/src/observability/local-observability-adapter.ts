import type { ExecutionEventInsert } from "@magister/db";

import { EventWriter } from "./event-writer";
import { RunSummaryStore } from "./run-summary-store";
import { TaskSummaryStore } from "./task-summary-store";

export class LocalObservabilityAdapter {
  constructor(
    private readonly eventWriter = new EventWriter(),
    private readonly taskSummaryStore = new TaskSummaryStore(),
    private readonly runSummaryStore = new RunSummaryStore(),
  ) {}

  async recordEvent(event: ExecutionEventInsert) {
    const writtenEvent = await this.eventWriter.write(event);
    const [taskSummary, runSummary] = await Promise.all([
      event.taskId ? this.taskSummaryStore.get(event.taskId) : Promise.resolve(null),
      event.roleRuntimeId ? this.runSummaryStore.get(event.roleRuntimeId) : Promise.resolve(null),
    ]);

    return {
      event: writtenEvent,
      taskSummary,
      runSummary,
    };
  }
}
