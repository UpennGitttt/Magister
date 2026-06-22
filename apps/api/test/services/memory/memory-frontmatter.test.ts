import { expect, test } from "bun:test";
import { MemoryValidationError } from "../../../src/services/memory/memory-errors";
import {
  formatMemoryFile,
  parseMemoryFile,
} from "../../../src/services/memory/memory-frontmatter";

const VALID_SAMPLE = `---
schemaVersion: 1
name: testing-mocks
description: Integration tests must hit real DB, not mocks
type: feedback
createdAt: 2026-05-13T10:00:00.000Z
lastAccessedAt: 2026-05-13T10:00:00.000Z
related:
  - feishu-dedup
---
Prior incident: mocked tests passed but the prod migration failed.
`;

test("parseMemoryFile extracts frontmatter and body", () => {
  const parsed = parseMemoryFile(VALID_SAMPLE);
  expect(parsed.frontmatter.name).toBe("testing-mocks");
  expect(parsed.frontmatter.type).toBe("feedback");
  expect(parsed.frontmatter.schemaVersion).toBe(1);
  expect(parsed.frontmatter.related).toEqual(["feishu-dedup"]);
  expect(parsed.body.trim()).toBe(
    "Prior incident: mocked tests passed but the prod migration failed."
  );
});

test("parseMemoryFile tolerates missing schemaVersion (defaults to 1)", () => {
  const noVersion = VALID_SAMPLE.replace("schemaVersion: 1\n", "");
  const parsed = parseMemoryFile(noVersion);
  expect(parsed.frontmatter.schemaVersion).toBe(1);
});

test("parseMemoryFile throws MemoryValidationError on missing frontmatter", () => {
  expect(() => parseMemoryFile("just a body, no fm")).toThrow(
    MemoryValidationError
  );
});

test("parseMemoryFile throws MemoryValidationError on missing required field", () => {
  const bad = `---\nname: only-name\n---\nbody`;
  expect(() => parseMemoryFile(bad)).toThrow(MemoryValidationError);
});

test("parseMemoryFile ignores unknown frontmatter fields (forward compat)", () => {
  const withUnknown = VALID_SAMPLE.replace(
    "schemaVersion: 1",
    "schemaVersion: 1\nfutureField: hello"
  );
  const parsed = parseMemoryFile(withUnknown);
  expect(parsed.frontmatter.name).toBe("testing-mocks");
});

test("formatMemoryFile round-trips", () => {
  const parsed = parseMemoryFile(VALID_SAMPLE);
  const reformatted = formatMemoryFile(parsed.frontmatter, parsed.body);
  const reparsed = parseMemoryFile(reformatted);
  expect(reparsed.frontmatter.name).toBe(parsed.frontmatter.name);
  expect(reparsed.frontmatter.related).toEqual(parsed.frontmatter.related);
  expect(reparsed.body.trim()).toBe(parsed.body.trim());
});

test("formatMemoryFile omits optional fields when undefined", () => {
  const out = formatMemoryFile(
    {
      schemaVersion: 1,
      name: "x",
      description: "y",
      type: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T00:00:00.000Z",
    },
    "body"
  );
  expect(out).not.toContain("supersedes:");
  expect(out).not.toContain("related:");
});

test("formatMemoryFile always emits schemaVersion", () => {
  const out = formatMemoryFile(
    {
      schemaVersion: 1,
      name: "x",
      description: "y",
      type: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T00:00:00.000Z",
    },
    "body"
  );
  expect(out).toContain("schemaVersion: 1");
});

test("parseMemoryFile throws MemoryValidationError on invalid type", () => {
  const bad = `---
schemaVersion: 1
name: x
description: y
type: invalid
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
---
body`;
  expect(() => parseMemoryFile(bad)).toThrow(MemoryValidationError);
});

test("parseMemoryFile accepts cheatsheet type", () => {
  const cs = `---
schemaVersion: 1
name: cheatsheet
description: My cheatsheet
type: cheatsheet
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
---
body`;
  expect(parseMemoryFile(cs).frontmatter.type).toBe("cheatsheet");
});

test("parseMemoryFile accepts scratchpad with taskId", () => {
  const sp = `---
schemaVersion: 1
name: task_42
description: In-flight scratch
type: scratchpad
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
taskId: task_42
---
notes`;
  const parsed = parseMemoryFile(sp);
  expect(parsed.frontmatter.type).toBe("scratchpad");
  expect(parsed.frontmatter.taskId).toBe("task_42");
});

test("parseMemoryFile rejects scratchpad without taskId", () => {
  const bad = `---
schemaVersion: 1
name: task_42
description: missing taskId
type: scratchpad
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
---
body`;
  expect(() => parseMemoryFile(bad)).toThrow(MemoryValidationError);
});

test("parseMemoryFile accepts inline array syntax for related", () => {
  // YAML flow style: related: [a, b, c]
  const txt = `---
schemaVersion: 1
name: x
description: y
type: user
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
related: [user-global/user/a, user-global/user/b]
---
body`;
  const parsed = parseMemoryFile(txt);
  expect(parsed.frontmatter.related).toEqual([
    "user-global/user/a",
    "user-global/user/b",
  ]);
});

test("parseMemoryFile rejects scalar related (would silently iterate chars)", () => {
  const txt = `---
schemaVersion: 1
name: x
description: y
type: user
createdAt: 2026-01-01T00:00:00.000Z
lastAccessedAt: 2026-01-01T00:00:00.000Z
related: not-an-array
---
body`;
  expect(() => parseMemoryFile(txt)).toThrow(MemoryValidationError);
});

test("formatMemoryFile emits taskId when present", () => {
  const out = formatMemoryFile(
    {
      schemaVersion: 1,
      name: "task_42",
      description: "sp",
      type: "scratchpad",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T00:00:00.000Z",
      taskId: "task_42",
    },
    "body",
  );
  expect(out).toContain("taskId: task_42");
});
