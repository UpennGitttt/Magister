import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  hasBinaryExtension,
  isBinaryContent,
  isInternalPath,
  resolveInsideWorkspace,
  safeReadFile,
  safeWriteFile,
} from "../../../src/services/manager-tools/workspace-path";

async function canonicalPath(filePath: string): Promise<string> {
  let current = filePath;
  let suffix = "";
  while (true) {
    try {
      const resolved = await realpath(current);
      return suffix ? path.join(resolved, suffix) : resolved;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return path.resolve(filePath);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(filePath);
      }
      const baseName = path.basename(current);
      suffix = suffix ? path.join(baseName, suffix) : baseName;
      current = parent;
    }
  }
}

// Hardening from GLM-5.1's review of 7bfdc40: a path that LEXICALLY
// resolves inside the workspace can still escape via a symlink in the
// chain. resolveInsideWorkspace runs realpath on the deepest existing
// ancestor so the symlink target is what we check against.

describe("resolveInsideWorkspace", () => {
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "ws-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "outside-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test("accepts a normal relative path inside the workspace", async () => {
    await writeFile(path.join(workspaceDir, "hello.txt"), "hi");
    const r = await resolveInsideWorkspace(workspaceDir, "hello.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(await canonicalPath(path.join(workspaceDir, "hello.txt")));
  });

  test("accepts a non-existent leaf inside an existing directory (new file)", async () => {
    const r = await resolveInsideWorkspace(workspaceDir, "newfile.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(await canonicalPath(path.join(workspaceDir, "newfile.txt")));
  });

  test("accepts a deeply nested non-existent path (multiple missing ancestors)", async () => {
    const r = await resolveInsideWorkspace(workspaceDir, "a/b/c/d/file.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(await canonicalPath(path.join(workspaceDir, "a/b/c/d/file.txt")));
  });

  test("rejects a path that escapes via .. traversal", async () => {
    const r = await resolveInsideWorkspace(workspaceDir, "../escape.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path escapes workspace directory");
  });

  test("rejects an absolute path outside the workspace", async () => {
    const r = await resolveInsideWorkspace(workspaceDir, "/etc/passwd");
    expect(r.ok).toBe(false);
  });

  test("rejects a SYMLINK INSIDE the workspace pointing to a directory outside", async () => {
    // The vulnerability the old lexical check missed: /workspace/escape -> /outside.
    // path.resolve(workspaceDir, "escape/file.txt") returns /workspace/escape/file.txt,
    // which startsWith(/workspace/) — the old check passes.
    // realpath of the existing ancestor (the symlink) returns /outside, so the new
    // check correctly rejects.
    await symlink(outsideDir, path.join(workspaceDir, "escape"));
    const r = await resolveInsideWorkspace(workspaceDir, "escape/file.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path escapes workspace directory");
  });

  test("rejects writing through a symlink whose target is OUTSIDE", async () => {
    // Same as above but the symlink itself IS the leaf (no suffix).
    await symlink(path.join(outsideDir, "captured.txt"), path.join(workspaceDir, "trap"));
    const r = await resolveInsideWorkspace(workspaceDir, "trap");
    expect(r.ok).toBe(false);
  });

  test("accepts a symlink pointing to a sibling INSIDE the workspace", async () => {
    // Symlinks aren't categorically rejected — only those whose realpath
    // escapes. An internal symlink should keep working.
    const innerDir = path.join(workspaceDir, "real");
    await mkdir(innerDir);
    await writeFile(path.join(innerDir, "x.txt"), "hi");
    await symlink(innerDir, path.join(workspaceDir, "alias"));
    const r = await resolveInsideWorkspace(workspaceDir, "alias/x.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(await canonicalPath(path.join(workspaceDir, "real/x.txt")));
  });

  test("works when the workspace itself is a symlink", async () => {
    // Realistic deployment shape: workspace is a symlink in the leader's
    // current dir into a real path elsewhere. The check should still pass
    // for ordinary inside-paths (relies on realpath-ing the workspace
    // first so all comparisons happen against the same canonicalization).
    const realWs = await mkdtemp(path.join(tmpdir(), "real-ws-"));
    const linkWs = path.join(tmpdir(), `link-ws-${Date.now()}`);
    try {
      await symlink(realWs, linkWs);
      await writeFile(path.join(realWs, "hi.txt"), "x");
      const r = await resolveInsideWorkspace(linkWs, "hi.txt");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolved).toBe(await canonicalPath(path.join(realWs, "hi.txt")));
    } finally {
      await rm(linkWs, { force: true });
      await rm(realWs, { recursive: true, force: true });
    }
  });

  test("accepts the workspace dir itself", async () => {
    const r = await resolveInsideWorkspace(workspaceDir, ".");
    expect(r.ok).toBe(true);
  });

  test("accepts an absolute path that lands inside the workspace", async () => {
    const target = path.join(workspaceDir, "subdir", "f.txt");
    const r = await resolveInsideWorkspace(workspaceDir, target);
    expect(r.ok).toBe(true);
  });

  // Coverage gaps flagged by kimi review.

  test("rejects a chain of dangling symlinks ending OUTSIDE", async () => {
    // a -> b (dangling) -> /outside/captured. Each iteration must
    // advance until we resolve the final target, then check it.
    await symlink(path.join(outsideDir, "captured.txt"), path.join(workspaceDir, "b"));
    await symlink(path.join(workspaceDir, "b"), path.join(workspaceDir, "a"));
    const r = await resolveInsideWorkspace(workspaceDir, "a");
    expect(r.ok).toBe(false);
  });

  test("rejects a symlink loop (a → b → a) within the iteration cap", async () => {
    // Two symlinks pointing at each other: the helper must terminate
    // and not hang. Cap is 64 iterations; this loop would otherwise
    // run forever.
    await symlink(path.join(workspaceDir, "b"), path.join(workspaceDir, "a"));
    await symlink(path.join(workspaceDir, "a"), path.join(workspaceDir, "b"));
    const r = await resolveInsideWorkspace(workspaceDir, "a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Either the loop cap fires, OR the OS bails out with ELOOP via
      // realpath — both are acceptable outcomes (fail closed).
      expect(/too many symlink levels|path resolution failed/.test(r.error)).toBe(true);
    }
  });

  test("rejects a mid-chain dangling symlink whose target is OUTSIDE", async () => {
    // /workspace/dir/a/file.txt where `dir` is a dangling symlink to
    // /outside/dir. The deepest existing ancestor is `dir`; we lstat
    // it, see it's a symlink, follow to /outside/dir, then attempt
    // realpath of /outside/dir/a/file.txt which doesn't exist either.
    await symlink(path.join(outsideDir, "dir"), path.join(workspaceDir, "dir"));
    const r = await resolveInsideWorkspace(workspaceDir, "dir/a/file.txt");
    expect(r.ok).toBe(false);
  });

  // Layer-1 denylist (workspace-internal Magister directories).
  test("rejects .local/ and nested paths under it", async () => {
    await mkdir(path.join(workspaceDir, ".local"));
    await writeFile(path.join(workspaceDir, ".local", "control-plane.sqlite"), "x");
    const r1 = await resolveInsideWorkspace(workspaceDir, ".local");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("off-limits");
    const r2 = await resolveInsideWorkspace(workspaceDir, ".local/control-plane.sqlite");
    expect(r2.ok).toBe(false);
  });

  test("rejects .magister/ and config/secrets.json", async () => {
    const r1 = await resolveInsideWorkspace(workspaceDir, ".magister/api.lock");
    expect(r1.ok).toBe(false);
    const r2 = await resolveInsideWorkspace(workspaceDir, "config/secrets.json");
    expect(r2.ok).toBe(false);
  });

  test("rejects .env, .env.local, .env.production", async () => {
    for (const name of [".env", ".env.local", ".env.production"]) {
      const r = await resolveInsideWorkspace(workspaceDir, name);
      expect(r.ok).toBe(false);
    }
  });

  test("ALLOWS .env template files (.example/.template/.sample/.dist)", async () => {
    // Kimi review M3 — these are tracked template files committed to
    // the repo for users to copy. Blocking them is a false positive
    // that breaks the "show me what env vars I should set" flow.
    for (const name of [".env.example", ".env.template", ".env.sample", ".env.dist"]) {
      await writeFile(path.join(workspaceDir, name), "TEMPLATE=value\n");
      const r = await resolveInsideWorkspace(workspaceDir, name);
      expect(r.ok).toBe(true);
    }
  });

  test("accepts ordinary nested files even when sibling denylist entries exist", async () => {
    await mkdir(path.join(workspaceDir, "src"));
    await writeFile(path.join(workspaceDir, "src", "foo.ts"), "x");
    const r = await resolveInsideWorkspace(workspaceDir, "src/foo.ts");
    expect(r.ok).toBe(true);
  });

  test("rejects a path under a symlink whose target is INSIDE outsideDir, even with .. tricks", async () => {
    // Symlink target tries to use .. to land back inside the workspace
    // by accident: /workspace/sneaky -> /outside/../workspace/secret.
    // path.resolve collapses this to /workspace/secret, which is
    // legitimately inside the workspace. So this case should ACCEPT.
    await mkdir(path.join(workspaceDir, "secret"));
    await writeFile(path.join(workspaceDir, "secret", "ok.txt"), "");
    await symlink(
      path.join(outsideDir, "..", path.basename(workspaceDir), "secret"),
      path.join(workspaceDir, "sneaky"),
    );
    const r = await resolveInsideWorkspace(workspaceDir, "sneaky/ok.txt");
    // Note: this is the expected behavior — `..` collapsing means the
    // symlink genuinely points inside. The boundary check honors that.
    expect(r.ok).toBe(true);
  });
});

// O_NOFOLLOW leaf-symlink TOCTOU defense — second-line guard for the
// case where the leaf gets atomic-replaced with a symlink between
// resolveInsideWorkspace's check and the actual fs.open.
describe("safeWriteFile / safeReadFile (O_NOFOLLOW)", () => {
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "ws-safe-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "outside-safe-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  test("safeWriteFile writes a normal file successfully", async () => {
    const target = path.join(workspaceDir, "hello.txt");
    await safeWriteFile(target, "hi");
    expect(await readFile(target, "utf-8")).toBe("hi");
  });

  test("safeWriteFile truncates an existing file (write replaces, not appends)", async () => {
    const target = path.join(workspaceDir, "doc.txt");
    await writeFile(target, "old long content here");
    await safeWriteFile(target, "new");
    expect(await readFile(target, "utf-8")).toBe("new");
  });

  test("safeWriteFile rejects a leaf symlink to OUTSIDE (the TOCTOU attack)", async () => {
    // Simulate the race: the resolve step already passed (we have a
    // canonical path), but right before our open the leaf gets swapped
    // for a symlink pointing outside. The real attack is concurrent;
    // this test pre-creates the symlink, which is the same observable
    // behavior at fs.open time.
    const targetPath = path.join(outsideDir, "captured.txt");
    const linkPath = path.join(workspaceDir, "trap.txt");
    await symlink(targetPath, linkPath);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeWriteFile(linkPath, "I should not land outside the workspace");
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe("ELOOP");
    // And the attack target must NOT have been created.
    let externalExists = true;
    try {
      await readFile(targetPath, "utf-8");
    } catch {
      externalExists = false;
    }
    expect(externalExists).toBe(false);
  });

  test("safeWriteFile rejects a leaf symlink even when the target is INSIDE the workspace", async () => {
    // O_NOFOLLOW is unconditional — it doesn't matter where the
    // symlink points; it always refuses to follow. This is by design:
    // the resolve step already returned the canonical path; if the
    // leaf is a symlink at write time, it was swapped after our check.
    await writeFile(path.join(workspaceDir, "real.txt"), "real");
    const linkPath = path.join(workspaceDir, "link.txt");
    await symlink(path.join(workspaceDir, "real.txt"), linkPath);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeWriteFile(linkPath, "via-link");
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe("ELOOP");
  });

  test("safeReadFile reads a normal file successfully", async () => {
    const target = path.join(workspaceDir, "x.txt");
    await writeFile(target, "abc");
    expect(await safeReadFile(target)).toBe("abc");
  });

  test("safeReadFile rejects a leaf symlink to OUTSIDE", async () => {
    // Information disclosure attack: read /etc/passwd via a symlink.
    await writeFile(path.join(outsideDir, "secret"), "secret-data");
    const linkPath = path.join(workspaceDir, "leak.txt");
    await symlink(path.join(outsideDir, "secret"), linkPath);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeReadFile(linkPath);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe("ELOOP");
  });

  test("safeWriteFile creates a new file (most common case — leaf doesn't exist yet)", async () => {
    // O_CREAT lets us create new files; O_NOFOLLOW only kicks in if
    // the leaf already exists AND is a symlink. This test proves the
    // common create-new-file path still works.
    const target = path.join(workspaceDir, "subdir", "new.txt");
    await mkdir(path.dirname(target));
    await safeWriteFile(target, "fresh");
    expect(await readFile(target, "utf-8")).toBe("fresh");
  });

  test("symlink can be replaced with a regular file then written normally", async () => {
    // Realistic recovery path: the leader sees the ELOOP error, calls
    // bash to unlink the symlink, then write_file succeeds.
    const linkPath = path.join(workspaceDir, "swap.txt");
    await symlink(path.join(outsideDir, "x"), linkPath);
    await unlink(linkPath); // simulate the recovery
    await safeWriteFile(linkPath, "now-a-real-file");
    expect(await readFile(linkPath, "utf-8")).toBe("now-a-real-file");
  });

  test("safeReadFile rejects a leaf symlink even when target is INSIDE", async () => {
    // Symmetric to the safeWriteFile case — O_NOFOLLOW is unconditional;
    // if the leaf is a symlink at open time it was swapped after our
    // resolve check (or the caller is treating a symlink as a regular
    // file, which is also wrong). Either way refuse.
    await writeFile(path.join(workspaceDir, "real.txt"), "real");
    const linkPath = path.join(workspaceDir, "alias.txt");
    await symlink(path.join(workspaceDir, "real.txt"), linkPath);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeReadFile(linkPath);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    expect(caught?.code).toBe("ELOOP");
  });

  test("safeReadFile rejects a FIFO at the leaf (no DoS)", async () => {
    // FIFO at the leaf: O_NOFOLLOW alone wouldn't reject; the open
    // would block (writer side has no reader). With O_NONBLOCK + the
    // post-open fstat regular-file check, we reject cleanly.
    const { execSync } = await import("node:child_process");
    const fifoPath = path.join(workspaceDir, "fifo");
    execSync(`mkfifo ${fifoPath}`);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeReadFile(fifoPath);
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    // ENXIO: opening a FIFO O_RDONLY | O_NONBLOCK with no writer
    // returns immediately, then fstat may have not even gotten there.
    // ENOTREG: fstat caught it. Either is acceptable — both are
    // fail-closed without blocking.
    if (!caught) throw new Error("expected safeReadFile/safeWriteFile to throw on a FIFO leaf");
    expect(["ENOTREG", "ENXIO"]).toContain(caught.code ?? "<no-code>");
  });

  test("safeWriteFile rejects a FIFO at the leaf (no DoS)", async () => {
    const { execSync } = await import("node:child_process");
    const fifoPath = path.join(workspaceDir, "fifo");
    execSync(`mkfifo ${fifoPath}`);
    let caught: NodeJS.ErrnoException | null = null;
    try {
      await safeWriteFile(fifoPath, "should never write");
    } catch (err) {
      caught = err as NodeJS.ErrnoException;
    }
    if (!caught) throw new Error("expected safeReadFile/safeWriteFile to throw on a FIFO leaf");
    expect(["ENOTREG", "ENXIO"]).toContain(caught.code ?? "<no-code>");
  });
});

describe("isInternalPath / hasBinaryExtension / isBinaryContent", () => {
  test("isInternalPath true for the four built-in patterns", () => {
    expect(isInternalPath(".local")).toBe(true);
    expect(isInternalPath(".local/control-plane.sqlite")).toBe(true);
    expect(isInternalPath(".magister/uploads/x.png")).toBe(true);
    expect(isInternalPath("config/secrets.json")).toBe(true);
    expect(isInternalPath(".env")).toBe(true);
    expect(isInternalPath(".env.local")).toBe(true);
    expect(isInternalPath(".env.production")).toBe(true);
  });

  test("isInternalPath false for safe paths", () => {
    expect(isInternalPath("")).toBe(false);
    expect(isInternalPath(".")).toBe(false);
    expect(isInternalPath("src/server.ts")).toBe(false);
    expect(isInternalPath("docs/architecture.md")).toBe(false);
    // Tricky: a directory whose name STARTS with `.local` but isn't it.
    expect(isInternalPath(".localhost.txt")).toBe(false);
    // `config/` itself is fine — only the secrets file is denied.
    expect(isInternalPath("config/executors.json")).toBe(false);
    // .env template files — tracked, no secrets, must be allowed.
    expect(isInternalPath(".env.example")).toBe(false);
    expect(isInternalPath(".env.template")).toBe(false);
    expect(isInternalPath(".env.sample")).toBe(false);
    expect(isInternalPath(".env.dist")).toBe(false);
  });

  test("hasBinaryExtension recognizes the original-incident extensions", () => {
    expect(hasBinaryExtension("foo.sqlite")).toBe(true);
    expect(hasBinaryExtension("FOO.SQLITE3")).toBe(true);
    expect(hasBinaryExtension("blob.db")).toBe(true);
    expect(hasBinaryExtension("logo.png")).toBe(true);
    expect(hasBinaryExtension("manual.pdf")).toBe(true);
    expect(hasBinaryExtension("doc.docx")).toBe(true);
  });

  test("hasBinaryExtension false for source / text", () => {
    expect(hasBinaryExtension("foo.ts")).toBe(false);
    expect(hasBinaryExtension("README.md")).toBe(false);
    expect(hasBinaryExtension("data.json")).toBe(false);
    expect(hasBinaryExtension("noext")).toBe(false);
  });

  test("isBinaryContent — NUL byte triggers instant binary", () => {
    const buf = Buffer.from([0x68, 0x69, 0x00, 0x21]); // "hi\0!"
    expect(isBinaryContent(buf)).toBe(true);
  });

  test("isBinaryContent — >10% non-printable triggers binary", () => {
    // 100 bytes: 89 printable + 11 control chars (other than tab/LF/CR)
    const bytes = Buffer.alloc(100, 0x41); // 'A'
    for (let i = 0; i < 11; i++) bytes[i] = 0x07; // BEL — non-printable
    expect(isBinaryContent(bytes)).toBe(true);
  });

  test("isBinaryContent — plain UTF-8 text is not binary", () => {
    expect(isBinaryContent(Buffer.from("Hello, world!\nThis is plain text.\n"))).toBe(false);
    // Unicode (CJK) is multi-byte but all bytes ≥ 0x80 — not control chars
    expect(isBinaryContent(Buffer.from("你好，世界\n", "utf-8"))).toBe(false);
  });

  test("isBinaryContent — empty buffer is not binary", () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });
});

describe("resolveInsideWorkspace — MAGISTER_EXTRA_ACCESS_ROOTS allowlist", () => {
  let workspaceDir: string;
  let externalRoot: string;
  let externalFile: string;
  const prevEnv = process.env.MAGISTER_EXTRA_ACCESS_ROOTS;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "ws-"));
    externalRoot = await mkdtemp(path.join(tmpdir(), "ext-root-"));
    externalFile = path.join(externalRoot, "code.ts");
    await writeFile(externalFile, "export const x = 1;");
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.MAGISTER_EXTRA_ACCESS_ROOTS;
    else process.env.MAGISTER_EXTRA_ACCESS_ROOTS = prevEnv;
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  });

  test("without the env, an external path still escapes the workspace", async () => {
    delete process.env.MAGISTER_EXTRA_ACCESS_ROOTS;
    const r = await resolveInsideWorkspace(workspaceDir, externalFile, { intent: "read" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path escapes workspace directory");
  });

  test("read intent resolves into a read-only external root", async () => {
    process.env.MAGISTER_EXTRA_ACCESS_ROOTS = externalRoot;
    const r = await resolveInsideWorkspace(workspaceDir, externalFile, { intent: "read" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(await canonicalPath(externalFile));
  });

  test("write intent (default) is refused for a read-only external root", async () => {
    process.env.MAGISTER_EXTRA_ACCESS_ROOTS = externalRoot;
    const r = await resolveInsideWorkspace(workspaceDir, path.join(externalRoot, "new.ts"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path escapes workspace directory");
  });

  test("a :rw external root permits writes", async () => {
    process.env.MAGISTER_EXTRA_ACCESS_ROOTS = `${externalRoot}:rw`;
    const r = await resolveInsideWorkspace(workspaceDir, path.join(externalRoot, "new.ts"));
    expect(r.ok).toBe(true);
  });

  test("a path outside every allowed root still escapes", async () => {
    process.env.MAGISTER_EXTRA_ACCESS_ROOTS = externalRoot;
    const other = await mkdtemp(path.join(tmpdir(), "other-"));
    try {
      const r = await resolveInsideWorkspace(workspaceDir, path.join(other, "f"), { intent: "read" });
      expect(r.ok).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
