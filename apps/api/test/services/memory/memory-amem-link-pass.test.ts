import { expect, test } from "bun:test";
import {
  isAmemEligible,
  pickNearestCandidates,
} from "../../../src/services/memory/memory-amem-link-pass";
import type { MemoryEntry } from "../../../src/services/memory/memory-types";

function makeEntry(
  path: string,
  description: string,
  type: MemoryEntry["type"] = "user",
): MemoryEntry {
  return {
    scope: "user-global",
    type,
    name: path.split("/").pop()!,
    path,
    frontmatter: {
      schemaVersion: 1,
      name: path.split("/").pop()!,
      description,
      type,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T00:00:00.000Z",
    },
    body: "body",
  };
}

test("pickNearestCandidates returns top-K by keyword overlap", () => {
  const entries = [
    makeEntry("user-global/user/foo", "leader loop architecture overview"),
    makeEntry("user-global/user/bar", "leader loop tools registration"),
    makeEntry("user-global/user/baz", "feishu outbound delivery"),
    makeEntry("user-global/user/qux", "compaction summary text"),
  ];
  const candidates = pickNearestCandidates(
    "user-global/user/new",
    "leader loop hooks and compaction",
    entries,
  );
  // foo and bar share "leader loop", qux shares "compaction"
  // baz shares nothing meaningful → excluded.
  const paths = candidates.map((c) => c.path);
  expect(paths).toContain("user-global/user/foo");
  expect(paths).toContain("user-global/user/bar");
  expect(paths).toContain("user-global/user/qux");
  expect(paths).not.toContain("user-global/user/baz");
  // Capped at K=3.
  expect(candidates.length).toBeLessThanOrEqual(3);
});

test("pickNearestCandidates excludes the new entry itself", () => {
  const self = makeEntry(
    "user-global/user/self",
    "leader loop architecture overview",
  );
  const candidates = pickNearestCandidates(
    "user-global/user/self",
    "leader loop architecture overview",
    [self],
  );
  expect(candidates).toEqual([]);
});

test("pickNearestCandidates skips cheatsheet + scratchpad entries", () => {
  const entries = [
    makeEntry(
      "user-global/cheatsheet",
      "leader loop tips and tricks",
      "cheatsheet",
    ),
    makeEntry(
      "project/scratchpad/task_x",
      "leader loop in-flight notes",
      "scratchpad",
    ),
    makeEntry("user-global/user/keep", "leader loop architecture"),
  ];
  const candidates = pickNearestCandidates(
    "user-global/user/new",
    "leader loop hooks",
    entries,
  );
  expect(candidates.map((c) => c.path)).toEqual(["user-global/user/keep"]);
});

test("pickNearestCandidates filters out entries with zero meaningful overlap", () => {
  const entries = [makeEntry("user-global/user/x", "completely unrelated topic")];
  const candidates = pickNearestCandidates(
    "user-global/user/new",
    "leader loop architecture",
    entries,
  );
  expect(candidates).toEqual([]);
});

test("pickNearestCandidates ignores stopwords + short tokens", () => {
  // "a", "the", "of" → stopwords. 2-char tokens excluded by len<3 filter.
  const entries = [
    makeEntry("user-global/user/x", "the a of"),
    makeEntry("user-global/user/y", "leader loop architecture"),
  ];
  const candidates = pickNearestCandidates(
    "user-global/user/new",
    "a leader the loop",
    entries,
  );
  expect(candidates.map((c) => c.path)).toEqual(["user-global/user/y"]);
});

test("isAmemEligible recognizes typed paths only", () => {
  expect(isAmemEligible("user-global/user/role")).toBe(true);
  expect(isAmemEligible("project/feedback/x")).toBe(true);
  expect(isAmemEligible("user-global/cheatsheet")).toBe(false);
  expect(isAmemEligible("project/scratchpad/task_42")).toBe(false);
  expect(isAmemEligible("nonsense")).toBe(false);
});
