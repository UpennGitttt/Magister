import { expect, test } from "bun:test";
import { MemoryValidationError } from "../../../src/services/memory/memory-errors";
import {
  buildMemoryPath,
  parseMemoryPath,
} from "../../../src/services/memory/memory-path";

test("parseMemoryPath accepts valid typed-entry path", () => {
  const p = parseMemoryPath("user-global/feedback/testing-mocks");
  expect(p.scope).toBe("user-global");
  expect(p.type).toBe("feedback");
  expect(p.name).toBe("testing-mocks");
});

test("parseMemoryPath accepts path with .md suffix", () => {
  const p = parseMemoryPath("project/user/role.md");
  expect(p.scope).toBe("project");
  expect(p.type).toBe("user");
  expect(p.name).toBe("role");
});

test("parseMemoryPath rejects bad scope (typed error)", () => {
  expect(() => parseMemoryPath("global/user/x")).toThrow(MemoryValidationError);
});

test("parseMemoryPath rejects bad type", () => {
  expect(() => parseMemoryPath("user-global/wat/x")).toThrow(MemoryValidationError);
});

test("parseMemoryPath rejects path traversal", () => {
  expect(() => parseMemoryPath("user-global/../etc/passwd")).toThrow(
    MemoryValidationError
  );
  expect(() => parseMemoryPath("user-global/feedback/..")).toThrow(
    MemoryValidationError
  );
});

test("parseMemoryPath rejects non-kebab name", () => {
  expect(() => parseMemoryPath("user-global/user/Has Spaces")).toThrow(
    MemoryValidationError
  );
  expect(() => parseMemoryPath("user-global/user/UPPER")).toThrow(
    MemoryValidationError
  );
});

test("buildMemoryPath round-trips typed path", () => {
  const path = buildMemoryPath({
    kind: "typed",
    scope: "project",
    type: "reference",
    name: "leader-loop",
  });
  expect(path).toBe("project/reference/leader-loop");
});

test("parseMemoryPath accepts cheatsheet pinned shape", () => {
  const p = parseMemoryPath("user-global/cheatsheet.md");
  expect(p.kind).toBe("cheatsheet");
  expect(p.scope).toBe("user-global");
  expect(p.type).toBe("cheatsheet");
});

test("parseMemoryPath rejects depth-2 paths that aren't cheatsheet", () => {
  expect(() => parseMemoryPath("user-global/scratchpad")).toThrow(
    MemoryValidationError,
  );
  expect(() => parseMemoryPath("project/random")).toThrow(MemoryValidationError);
});

test("parseMemoryPath accepts project-scope scratchpad with taskId", () => {
  const p = parseMemoryPath("project/scratchpad/task_abc-123");
  expect(p.kind).toBe("scratchpad");
  if (p.kind === "scratchpad") {
    expect(p.taskId).toBe("task_abc-123");
  }
});

test("parseMemoryPath rejects user-global scratchpad", () => {
  expect(() => parseMemoryPath("user-global/scratchpad/foo")).toThrow(
    MemoryValidationError,
  );
});

test("parseMemoryPath rejects empty taskId on scratchpad", () => {
  expect(() => parseMemoryPath("project/scratchpad/")).toThrow(
    MemoryValidationError,
  );
});

test("buildMemoryPath round-trips cheatsheet", () => {
  const path = buildMemoryPath({
    kind: "cheatsheet",
    scope: "user-global",
    type: "cheatsheet",
    name: "cheatsheet",
  });
  expect(path).toBe("user-global/cheatsheet");
});

test("buildMemoryPath round-trips scratchpad", () => {
  const path = buildMemoryPath({
    kind: "scratchpad",
    scope: "project",
    type: "scratchpad",
    name: "task42",
    taskId: "task42",
  });
  expect(path).toBe("project/scratchpad/task42");
});
