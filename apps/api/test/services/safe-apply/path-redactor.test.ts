/**
 * Sandbox-elevation v4.3 spec acceptance #22 — path-redactor tests.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  __setHomeForTests,
  redactHomePath,
  redactPathEntries,
} from "../../../src/services/safe-apply/path-redactor";

afterEach(() => {
  __setHomeForTests(null);  // reset to default
});

describe("redactHomePath", () => {
  test("non-HOME paths pass through unchanged", () => {
    __setHomeForTests("/home/alice");
    expect(redactHomePath("/etc/shadow")).toBe("/etc/shadow");
    expect(redactHomePath("/tmp/foo")).toBe("/tmp/foo");
    expect(redactHomePath("/opt/install/config.json")).toBe("/opt/install/config.json");
  });

  test("HOME exact match → ~", () => {
    __setHomeForTests("/home/alice");
    expect(redactHomePath("/home/alice")).toBe("~");
  });

  test("HOME prefix paths → ~/...", () => {
    __setHomeForTests("/home/alice");
    expect(redactHomePath("/home/alice/.cache/uv")).toBe("~/.cache/uv");
    expect(redactHomePath("/home/alice/.ssh/id_rsa")).toBe("~/.ssh/id_rsa");
    expect(redactHomePath("/home/alice/Documents/notes.md")).toBe("~/Documents/notes.md");
  });

  test("HOME prefix MUST be directory boundary (no partial username match)", () => {
    __setHomeForTests("/home/alice");
    // alicebob has a longer name; her path should NOT be redacted as alice's
    expect(redactHomePath("/home/alicebob/x")).toBe("/home/alicebob/x");
  });

  test("root user HOME=/root", () => {
    __setHomeForTests("/root");
    expect(redactHomePath("/root/.cache/uv")).toBe("~/.cache/uv");
    expect(redactHomePath("/root")).toBe("~");
    expect(redactHomePath("/rootfs/foo")).toBe("/rootfs/foo");  // no prefix match
  });

  test("HOME=/ is degenerate; paths pass through", () => {
    __setHomeForTests("/");
    expect(redactHomePath("/home/alice/x")).toBe("/home/alice/x");
  });

  test("empty / null / non-string → empty string", () => {
    __setHomeForTests("/home/alice");
    expect(redactHomePath("")).toBe("");
    expect(redactHomePath(null)).toBe("");
    expect(redactHomePath(undefined)).toBe("");
    expect(redactHomePath(42)).toBe("");
  });

  test("idempotent — redact(redact(x)) === redact(x)", () => {
    __setHomeForTests("/home/alice");
    const inputs = ["/etc/shadow", "/home/alice/x", "/home/alice", "/tmp/foo"];
    for (const input of inputs) {
      const once = redactHomePath(input);
      const twice = redactHomePath(once);
      expect(twice).toBe(once);
    }
  });
});

describe("redactPathEntries", () => {
  test("redacts path field; preserves other fields", () => {
    __setHomeForTests("/home/alice");
    const entries = [
      { path: "/home/alice/.cache/uv", access: "write" as const },
      { path: "/etc/gitconfig", access: "read" as const },
    ];
    const result = redactPathEntries(entries);
    expect(result).toEqual([
      { path: "~/.cache/uv", access: "write" },
      { path: "/etc/gitconfig", access: "read" },
    ]);
  });

  test("empty array → empty array", () => {
    __setHomeForTests("/home/alice");
    expect(redactPathEntries([])).toEqual([]);
  });

  test("entries with extra fields keep them", () => {
    __setHomeForTests("/home/alice");
    const entries = [{ path: "/home/alice/x", access: "read" as const, expiredAtMs: 12345 }];
    const result = redactPathEntries(entries);
    expect(result[0]).toEqual({ path: "~/x", access: "read", expiredAtMs: 12345 });
  });
});
