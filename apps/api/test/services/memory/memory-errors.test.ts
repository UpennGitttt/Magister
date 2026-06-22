import { expect, test } from "bun:test";
import {
  MemoryCapacityError,
  MemoryError,
  MemoryIOError,
  MemoryNotFoundError,
  MemoryValidationError,
  mapMemoryErrorToHttpStatus,
} from "../../../src/services/memory/memory-errors";

test("MemoryValidationError is a MemoryError subclass with tag=validation", () => {
  const err = new MemoryValidationError("bad path");
  expect(err).toBeInstanceOf(MemoryError);
  expect(err.tag).toBe("validation");
  expect(err.message).toBe("bad path");
});

test("MemoryNotFoundError carries path", () => {
  const err = new MemoryNotFoundError("user-global/user/role");
  expect(err.path).toBe("user-global/user/role");
  expect(err.tag).toBe("not_found");
});

test("MemoryCapacityError tag=capacity", () => {
  expect(new MemoryCapacityError("too big").tag).toBe("capacity");
});

test("MemoryIOError carries cause", () => {
  const cause = new Error("ENOSPC");
  const err = new MemoryIOError("disk full", cause);
  expect(err.cause).toBe(cause);
  expect(err.tag).toBe("io");
});

test("mapMemoryErrorToHttpStatus maps each class", () => {
  expect(mapMemoryErrorToHttpStatus(new MemoryValidationError("x"))).toBe(400);
  expect(mapMemoryErrorToHttpStatus(new MemoryCapacityError("x"))).toBe(413);
  expect(mapMemoryErrorToHttpStatus(new MemoryNotFoundError("x"))).toBe(404);
  expect(mapMemoryErrorToHttpStatus(new MemoryIOError("x"))).toBe(500);
  expect(mapMemoryErrorToHttpStatus(new Error("unknown"))).toBe(500);
});
