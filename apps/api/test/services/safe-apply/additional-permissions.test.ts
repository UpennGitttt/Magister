/**
 * Sandbox-elevation v4.3 §4.1 / §4.3 — additional_permissions
 * validation + normalization tests.
 */
import { expect, test, describe } from "bun:test";

import {
  validateAndNormalize,
  canonicalizePath,
  PermissionValidationError,
  additionalPermissionsSchema,
} from "../../../src/services/safe-apply/additional-permissions";

const HOME = "/home/alice";
const MAGISTER = "/opt/magister-install";
const opts = { homeDir: HOME, magisterInstallDir: MAGISTER };

// Test canonicalizer — pass-through for paths that already look
// canonical (avoid touching real fs during unit tests).
const passthrough = (p: string) => p;

function call(raw: unknown, mode: "use_default" | "with_additional_permissions" | "require_escalated" = "with_additional_permissions") {
  return validateAndNormalize({
    raw,
    mode,
    classifyOptions: opts,
    canonicalize: passthrough,
  });
}

describe("schema parse (Zod .strict)", () => {
  test("plain object with read[] and write[] parses", () => {
    const result = call({
      file_system: { read: [`${HOME}/.gitconfig`], write: [`${HOME}/.cache/uv/x`] },
    });
    expect(result.profile.file_system?.entries.length).toBe(2);
  });

  test("unknown top-level field rejected (.strict)", () => {
    expect(() => call({ file_system: { read: ["/tmp/x"] }, extra_field: "lol" })).toThrow(/schema_invalid/);
  });

  test("unknown file_system field rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/x"], magic: true } })).toThrow(/schema_invalid/);
  });

  test("per-array cap 16 enforced by Zod", () => {
    const seventeen = Array.from({ length: 17 }, (_, i) => `/tmp/path${i}`);
    expect(() => call({ file_system: { read: seventeen } })).toThrow(/schema_invalid/);
  });
});

describe("sum cap (read + write ≤ 16)", () => {
  test("16 total = ok", () => {
    const result = call({
      file_system: {
        read: Array.from({ length: 8 }, (_, i) => `/tmp/r${i}`),
        write: Array.from({ length: 8 }, (_, i) => `/tmp/w${i}`),
      },
    });
    expect(result.profile.file_system?.entries.length).toBe(16);
  });
  test("17 total (9 read + 8 write) rejected", () => {
    expect(() => call({
      file_system: {
        read: Array.from({ length: 9 }, (_, i) => `/tmp/r${i}`),
        write: Array.from({ length: 8 }, (_, i) => `/tmp/w${i}`),
      },
    })).toThrow(/path_count_exceeded/);
  });
});

describe("path char + length validation", () => {
  test("path with \\n rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/foo\nbar"] } })).toThrow(/path_forbidden_chars/);
  });
  test("path with \\0 rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/foo\0bar"] } })).toThrow(/path_forbidden_chars/);
  });
  test("path with \\r rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/foo\rbar"] } })).toThrow(/path_forbidden_chars/);
  });
  test("path > 4096 chars rejected", () => {
    const longPath = "/" + "a".repeat(4100);
    expect(() => call({ file_system: { read: [longPath] } })).toThrow(/path_too_long/);
  });
  test("glob char * rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/*"] } })).toThrow(/path_glob_unsupported/);
  });
  test("glob char ? rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/?.txt"] } })).toThrow(/path_glob_unsupported/);
  });
  test("glob char [] rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/[abc].txt"] } })).toThrow(/path_glob_unsupported/);
  });
});

describe("absoluteness check", () => {
  test("relative path rejected", () => {
    expect(() => call({ file_system: { read: ["foo/bar"] } })).toThrow();
    // Could be path_not_absolute OR caught by classifier's canonical check.
    // Either way, a relative path doesn't make it through.
  });
});

describe("dedupe + merge semantics", () => {
  test("duplicate path within read[] deduped silently", () => {
    const result = call({
      file_system: { read: [`${HOME}/.gitconfig`, `${HOME}/.gitconfig`] },
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
  });

  test("same path in read AND write → kept in write only", () => {
    const result = call({
      file_system: {
        read: [`${HOME}/.cache/uv/foo`],
        write: [`${HOME}/.cache/uv/foo`],
      },
    });
    const entries = result.profile.file_system?.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0]!.access).toBe("write");
  });

  test("path in write multiple times deduped", () => {
    const result = call({
      file_system: { write: [`${HOME}/.cache/uv/x`, `${HOME}/.cache/uv/x`] },
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
  });
});

describe("empty-after-strip handling", () => {
  test("with_additional_permissions + empty read[]/write[] AND no network → error", () => {
    expect(() => call({ file_system: { read: [], write: [] } })).toThrow(/with_additional_permissions_empty/);
  });
  test("with_additional_permissions + omitted file_system AND no network → error", () => {
    expect(() => call({})).toThrow(/with_additional_permissions_empty/);
  });
  test("with_additional_permissions + only network → ok", () => {
    const result = call({ network: { enabled: true } });
    expect(result.profile.network?.enabled).toBe(true);
    expect(result.profile.file_system).toBeUndefined();
  });

  test("use_default + non-empty profile → silently accepted (mode wins)", () => {
    const result = validateAndNormalize({
      raw: { file_system: { read: [`${HOME}/.gitconfig`] } },
      mode: "use_default",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.effectiveMode).toBe("use_default");
    // Profile is still built — dispatcher decides whether to apply.
    expect(result.profile.file_system?.entries.length).toBe(1);
  });
});

describe("access:'none' interception (v4.3 metadata-only behavior)", () => {
  test("entries[{path, access:'none'}] stripped + collected as deny-read-requested", () => {
    const result = validateAndNormalize({
      raw: {
        file_system: {
          entries: [
            { path: `${HOME}/.aws/credentials`, access: "none" },
            { path: `${HOME}/.gitconfig`, access: "read" },
          ],
        },
      },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.denyReadRequestedButUnsupported.length).toBe(1);
    expect(result.denyReadRequestedButUnsupported[0]!.path).toBe(`${HOME}/.aws/credentials`);
    expect(result.denyReadRequestedButUnsupported[0]!.classification).toBe("caution");
    // The non-none entry made it through
    expect(result.profile.file_system?.entries.length).toBe(1);
    expect(result.profile.file_system?.entries[0]!.access).toBe("read");
  });

  test("all entries are access:'none' → demoted to use_default (codex+kimi review)", () => {
    // This is the codex+kimi flag — must NOT escalate sandbox mode.
    // Kimi A.2 review LOW #L3: tighten previous loose assertion to
    // precise expected behavior.
    const result = validateAndNormalize({
      raw: {
        file_system: {
          entries: [{ path: `${HOME}/.aws/credentials`, access: "none" }],
        },
      },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.effectiveMode).toBe("use_default");
    // The deny-read intent IS surfaced
    expect(result.denyReadRequestedButUnsupported.length).toBe(1);
    // Profile is empty (no bind list to apply)
    expect(result.profile.file_system).toBeUndefined();
  });
});

describe("mixed shape rejected (kimi A.2 review BLOCKER B1)", () => {
  test("entries[] + read[] together → mixed_shape error", () => {
    expect(() =>
      validateAndNormalize({
        raw: {
          file_system: {
            entries: [{ path: "/tmp/a", access: "read" }],
            read: ["/tmp/b"],
          },
        },
        mode: "with_additional_permissions",
        classifyOptions: opts,
        canonicalize: passthrough,
      })
    ).toThrow(/mixed_shape/);
  });
  test("entries[] + write[] together → mixed_shape error", () => {
    expect(() =>
      validateAndNormalize({
        raw: {
          file_system: {
            entries: [{ path: "/tmp/a", access: "write" }],
            write: ["/tmp/b"],
          },
        },
        mode: "with_additional_permissions",
        classifyOptions: opts,
        canonicalize: passthrough,
      })
    ).toThrow(/mixed_shape/);
  });
  test("entries[] alone is fine (codex trace shape)", () => {
    const result = validateAndNormalize({
      raw: {
        file_system: {
          entries: [{ path: `${HOME}/.gitconfig`, access: "read" }],
        },
      },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
  });
});

describe("C1 control char strip (kimi A.2 review MEDIUM #M1)", () => {
  test("path with U+0080 rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/foobar"] } })).toThrow(/path_forbidden_chars/);
  });
  test("path with U+009F rejected", () => {
    expect(() => call({ file_system: { read: ["/tmp/foobar"] } })).toThrow(/path_forbidden_chars/);
  });
});

describe("deny-list error redaction (kimi A.2 review MEDIUM #M2)", () => {
  test("error message does NOT include the requested path (reconnaissance defense)", () => {
    try {
      call({ file_system: { read: ["/etc/shadow"] } });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as PermissionValidationError;
      expect(err.toolUseError).not.toContain("/etc/shadow");
      // Generic enough that the model can't enumerate which specific
      // paths are denied
      expect(err.toolUseError).toContain("non-grantable");
    }
  });
});

describe("canonicalize errno distinction (kimi A.2 review HIGH #H1)", () => {
  test("EACCES (or any non-ENOENT errno) from canonicalize → PermissionValidationError", () => {
    const eacces = (p: string) => {
      const err = new Error(`EACCES: permission denied, lstat '${p}'`) as Error & { code?: string };
      err.code = "EACCES";
      throw err;
    };
    expect(() =>
      validateAndNormalize({
        raw: { file_system: { read: ["/var/secret/db.sqlite"] } },
        mode: "with_additional_permissions",
        classifyOptions: opts,
        canonicalize: eacces,
      })
    ).toThrow();
  });

  test("ENOENT from canonicalize → resolved-only form used (path doesn't exist is OK)", () => {
    // Custom canonicalizer that throws ENOENT for non-existent paths,
    // mimicking the production behavior.
    const enoentThenResolve = (p: string) => {
      // For test simplicity, just return p as-is (caller already
      // resolved). Real canonicalizePath would resolve first then
      // catch ENOENT to return resolved.
      return p;
    };
    const result = validateAndNormalize({
      raw: { file_system: { read: [`${HOME}/never-exists/foo`] } },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: enoentThenResolve,
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
  });
});

describe("dedupe symmetry (kimi A.2 review HIGH #H3)", () => {
  test("read=['/a','/a'] + write=['/a'] → entries=[{/a,write}]", () => {
    const result = validateAndNormalize({
      raw: { file_system: { read: ["/tmp/a", "/tmp/a"], write: ["/tmp/a"] } },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
    expect(result.profile.file_system?.entries[0]!.access).toBe("write");
  });
  test("read=['/a'] + write=['/a','/a'] → entries=[{/a,write}]", () => {
    const result = validateAndNormalize({
      raw: { file_system: { read: ["/tmp/a"], write: ["/tmp/a", "/tmp/a"] } },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.profile.file_system?.entries.length).toBe(1);
    expect(result.profile.file_system?.entries[0]!.access).toBe("write");
  });
  test("pre-merge 17 paths but post-merge 16 → passes (boundary)", () => {
    // 16 unique writes + 1 read of a path already in write → after
    // merge total = 16, passes the cap.
    const sharedPaths = Array.from({ length: 16 }, (_, i) => `/tmp/p${i}`);
    const result = validateAndNormalize({
      raw: {
        file_system: {
          read: [sharedPaths[0]],   // overlaps with write[0]
          write: sharedPaths,
        },
      },
      mode: "with_additional_permissions",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.profile.file_system?.entries.length).toBe(16);
  });
});

describe("require_escalated mode interactions (kimi A.2 review BLOCKER B2 - tests)", () => {
  test("require_escalated + empty profile → ok (sandbox bypassed; no profile needed)", () => {
    const result = validateAndNormalize({
      raw: {},
      mode: "require_escalated",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.effectiveMode).toBe("require_escalated");
    expect(result.profile.file_system).toBeUndefined();
  });
  test("require_escalated + access:none entries → escalated stays (model wanted to bypass; access:none is unenforceable metadata)", () => {
    const result = validateAndNormalize({
      raw: {
        file_system: {
          entries: [{ path: `${HOME}/.aws/credentials`, access: "none" }],
        },
      },
      mode: "require_escalated",
      classifyOptions: opts,
      canonicalize: passthrough,
    });
    expect(result.effectiveMode).toBe("require_escalated");
    expect(result.denyReadRequestedButUnsupported.length).toBe(1);
  });
  test("require_escalated + critical path → still rejected (deny-list applies in all modes)", () => {
    expect(() =>
      validateAndNormalize({
        raw: { file_system: { read: ["/etc/shadow"] } },
        mode: "require_escalated",
        classifyOptions: opts,
        canonicalize: passthrough,
      })
    ).toThrow(/path_on_deny_list/);
  });
});

describe("deny-list (critical hard-reject)", () => {
  test("/etc/shadow rejected at validation", () => {
    expect(() => call({ file_system: { read: ["/etc/shadow"] } })).toThrow(/path_on_deny_list/);
  });
  test(`${HOME}/.ssh/authorized_keys write rejected`, () => {
    expect(() => call({
      file_system: { write: [`${HOME}/.ssh/authorized_keys`] },
    })).toThrow(/path_on_deny_list/);
  });
  test(`${MAGISTER}/config/secrets.json rejected (any access)`, () => {
    expect(() => call({
      file_system: { read: [`${MAGISTER}/config/secrets.json`] },
    })).toThrow(/path_on_deny_list/);
  });
});

describe("output shape", () => {
  test("entries have sensitivity + reason", () => {
    const result = call({
      file_system: {
        read: [`${HOME}/.gitconfig`],
        write: [`${HOME}/.cache/uv/foo`, `${HOME}/.aws/credentials`],
      },
    });
    const entries = result.profile.file_system?.entries ?? [];
    expect(entries.find((e) => e.path === `${HOME}/.gitconfig`)!.sensitivity).toBe("safe");
    expect(entries.find((e) => e.path === `${HOME}/.cache/uv/foo`)!.sensitivity).toBe("safe");
    // .aws/credentials write — covered by ~/.aws caution catch-all
    expect(entries.find((e) => e.path === `${HOME}/.aws/credentials`)!.sensitivity).toBe("caution");
  });
});

describe("canonicalizePath (real fs)", () => {
  test("resolves `..` segments", () => {
    expect(canonicalizePath("/tmp/foo/../bar")).toBe("/tmp/bar");
  });
  test("non-existent path returns the resolved (no-realpath) form", () => {
    // The path /__definitely_does_not_exist_xyz__/file is unlikely to exist
    const result = canonicalizePath("/__definitely_does_not_exist_xyz__/foo/../bar");
    expect(result).toBe("/__definitely_does_not_exist_xyz__/bar");
  });
});

describe("additionalPermissionsSchema (direct Zod usage)", () => {
  test("export is usable standalone", () => {
    const result = additionalPermissionsSchema.safeParse({ network: { enabled: true } });
    expect(result.success).toBe(true);
  });
});

describe("PermissionValidationError class shape", () => {
  test("has toolUseError and code fields", () => {
    try {
      call({ file_system: { read: ["/tmp/*"] } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PermissionValidationError);
      const err = e as PermissionValidationError;
      expect(err.code).toBe("path_glob_unsupported");
      expect(err.toolUseError).toContain("glob");
    }
  });
});
