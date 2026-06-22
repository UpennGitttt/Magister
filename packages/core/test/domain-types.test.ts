import { expect, test } from "bun:test";

import {
  APPROVAL_STATES,
  EXECUTION_EVENT_TYPES,
  ROLE_RUNTIME_STATES,
  TASK_STATES,
} from "../src";

test("core domain exports the phase 1 state and event enums", () => {
  expect(TASK_STATES).toContain("INTAKE");
  expect(TASK_STATES).toContain("FAILED");

  expect(ROLE_RUNTIME_STATES).toContain("CREATED");
  expect(ROLE_RUNTIME_STATES).toContain("COMPLETED");

  expect(APPROVAL_STATES).toContain("pending");
  expect(APPROVAL_STATES).toContain("rejected");

  expect(EXECUTION_EVENT_TYPES).toContain("task.created");
  expect(EXECUTION_EVENT_TYPES).toContain("approval.resolved");
});
