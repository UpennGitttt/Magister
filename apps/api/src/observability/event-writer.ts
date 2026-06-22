import type { ExecutionEventInsert } from "@magister/db";

import { ExecutionEventRepository } from "../repositories/execution-event-repository";

export class EventWriter {
  constructor(
    private readonly executionEventRepository = new ExecutionEventRepository(),
  ) {}

  async write(event: ExecutionEventInsert) {
    await this.executionEventRepository.create(event);
    return event;
  }
}
