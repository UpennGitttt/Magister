import { describe, expect, test } from "bun:test";

import {
  matchExtraAccessRoot,
  parseExtraAccessRoots,
} from "../../src/lib/extra-access-roots";

describe("parseExtraAccessRoots", () => {
  test("unset env yields no roots (default = workspace-only)", () => {
    expect(parseExtraAccessRoots({})).toEqual([]);
    expect(parseExtraAccessRoots({ MAGISTER_EXTRA_ACCESS_ROOTS: "" })).toEqual([]);
  });

  test("single root defaults to read-only", () => {
    expect(parseExtraAccessRoots({ MAGISTER_EXTRA_ACCESS_ROOTS: "/opt/acme" })).toEqual([
      { root: "/opt/acme", writable: false },
    ]);
  });

  test(":rw suffix grants write, :ro is explicit read-only", () => {
    expect(
      parseExtraAccessRoots({ MAGISTER_EXTRA_ACCESS_ROOTS: "/a/rw:rw,/b/ro:ro,/c/def" }),
    ).toEqual([
      { root: "/a/rw", writable: true },
      { root: "/b/ro", writable: false },
      { root: "/c/def", writable: false },
    ]);
  });

  test("trims whitespace and normalizes trailing slash", () => {
    expect(
      parseExtraAccessRoots({ MAGISTER_EXTRA_ACCESS_ROOTS: " /opt/acme/ , /data/x/:rw " }),
    ).toEqual([
      { root: "/opt/acme", writable: false },
      { root: "/data/x", writable: true },
    ]);
  });

  test("skips non-absolute entries with a warning, keeps the rest", () => {
    const warnings: string[] = [];
    const roots = parseExtraAccessRoots(
      { MAGISTER_EXTRA_ACCESS_ROOTS: "relative/path,/opt/ok" },
      (m) => warnings.push(m),
    );
    expect(roots).toEqual([{ root: "/opt/ok", writable: false }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("relative/path");
  });

  test("duplicate root keeps the most permissive access", () => {
    expect(
      parseExtraAccessRoots({ MAGISTER_EXTRA_ACCESS_ROOTS: "/opt/x,/opt/x:rw" }),
    ).toEqual([{ root: "/opt/x", writable: true }]);
  });
});

describe("matchExtraAccessRoot", () => {
  const roots = [
    { root: "/opt/acme", writable: false },
    { root: "/data/x", writable: true },
  ];

  test("matches the root itself and descendants", () => {
    expect(matchExtraAccessRoot(roots, "/opt/acme")?.root).toBe("/opt/acme");
    expect(matchExtraAccessRoot(roots, "/opt/acme/webapp/main.go")?.root).toBe("/opt/acme");
    expect(matchExtraAccessRoot(roots, "/data/x/sub/file")?.writable).toBe(true);
  });

  test("does not match a sibling that merely shares a prefix string", () => {
    expect(matchExtraAccessRoot(roots, "/opt/acme-other/file")).toBeNull();
    expect(matchExtraAccessRoot(roots, "/data/xyz")).toBeNull();
  });

  test("returns null when nothing matches", () => {
    expect(matchExtraAccessRoot(roots, "/etc/passwd")).toBeNull();
    expect(matchExtraAccessRoot([], "/opt/acme")).toBeNull();
  });
});
