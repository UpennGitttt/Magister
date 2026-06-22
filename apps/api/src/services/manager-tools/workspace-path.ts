import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

import { matchExtraAccessRoot, parseExtraAccessRoots } from "../../lib/extra-access-roots";

/**
 * Magister-internal paths that no agent tool should ever read, list, edit,
 * or write. These sit *inside* the workspace (which by default is the
 * Magister repo root) so the existing prefix-containment check in
 * `resolveInsideWorkspace` happily lets them through. Past incident
 * (2026-05-03): a naive grep walked into `.local/control-plane.sqlite`
 * (143 MB SQLite DB), returned a mix of binary bytes + recursive Magister
 * event payload text (the model literally read its own prior tool
 * output back), and poisoned the next turn so badly the model
 * returned an empty response and the loop exited silently.
 *
 * Patterns are matched against the path relative to the workspace
 * root (POSIX-style separator), so they only fire when the workspace
 * IS the Magister repo. A teammate working in a fresh worktree won't have
 * a `.local` of its own and won't trigger these.
 */
const INTERNAL_PATH_PATTERNS: readonly RegExp[] = [
  /^\.local(\/|$)/,
  /^\.magister(\/|$)/,
  /^config\/secrets\.json$/,
  // Match `.env`, `.env.local`, `.env.production`, etc. — but
  // explicitly exclude tracked template files (`.env.example`,
  // `.env.template`, `.env.sample`, `.env.dist`). Those are
  // committed to the repo for users to copy and contain no
  // secrets, so blocking them is a false positive that breaks
  // the legitimate "show me what env vars I should set" workflow.
  // 
  /^\.env(\.(?!(example|template|sample|dist)$)[^/]+)?$/,
];

/**
 * Optional, user-extensible denylist via env. Comma-separated regex
 * sources. Invalid patterns are logged and skipped, so a bad env var
 * never bricks the tool layer.
 */
function loadEnvDenylist(): readonly RegExp[] {
  const raw = process.env.MAGISTER_TOOL_DENYLIST;
  if (!raw) return [];
  const out: RegExp[] = [];
  for (const part of raw.split(",")) {
    const src = part.trim();
    if (!src) continue;
    try {
      out.push(new RegExp(src));
    } catch (err) {
      console.warn(
        `[workspace-path] ignoring invalid MAGISTER_TOOL_DENYLIST entry: ${src} (${(err as Error).message})`,
      );
    }
  }
  return out;
}
const ENV_DENYLIST: readonly RegExp[] = loadEnvDenylist();

/**
 * Check a workspace-relative path (POSIX-style) against the built-in
 * + env-supplied denylists. Used by `resolveInsideWorkspace` to fail
 * any path-taking tool call that targets Magister internals.
 */
export function isInternalPath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  if (normalized === "" || normalized === ".") return false;
  for (const pat of INTERNAL_PATH_PATTERNS) {
    if (pat.test(normalized)) return true;
  }
  for (const pat of ENV_DENYLIST) {
    if (pat.test(normalized)) return true;
  }
  return false;
}

/**
 * Binary file extensions to skip for text-based operations. Critically
 * includes `.sqlite`, `.sqlite3`, `.db`, `.mdb` (the original
 * 2026-05-03 incident's vector).
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif",
  // Videos
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg",
  // Audio
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".aiff", ".opus",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".z", ".tgz", ".iso",
  // Executables / binaries
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib", ".app",
  ".msi", ".deb", ".rpm",
  // Documents (read_file extracts pdf/docx/xlsx — checked at the call site)
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  // Fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // Bytecode / VM artifacts
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear", ".node", ".wasm", ".rlib",
  // Database files
  ".sqlite", ".sqlite3", ".db", ".mdb", ".idx",
  // Design / 3D
  ".psd", ".ai", ".eps", ".sketch", ".fig", ".xd", ".blend", ".3ds", ".max",
  // Flash
  ".swf", ".fla",
  // Lock / profiling data
  ".lockb", ".dat", ".data",
]);

export function hasBinaryExtension(filePath: string): boolean {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(idx).toLowerCase());
}

/**
 * Heuristic binary detector — checks the first 8 KiB. NUL byte → instant
 * binary; otherwise count non-printable, non-whitespace bytes; > 10 % →
 * binary. Catches files with text-y extensions whose payload is binary
 * (e.g. compressed `.log` files).
 */
const BINARY_CHECK_SIZE = 8192;
export function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE);
  if (checkSize === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    if (
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13 // carriage return
    ) {
      nonPrintable++;
    }
  }
  return nonPrintable / checkSize > 0.1;
}

/**
 * Resolve a user-supplied path against the workspace, **following
 * symlinks along the way**, and reject paths that — after symlink
 * resolution — escape the workspace directory.
 *
 * Why not the older `path.resolve` + `startsWith` check: that's purely
 * lexical and misses a symlink inside the workspace pointing out.
 * E.g. `/workspace/escape` → `/etc`; the lexical check sees
 * `/workspace/escape/...` and passes, but `fs.writeFile` follows the
 * link and writes outside.
 *
 * Why not just `fs.realpath(filePath)`: realpath fails when the leaf
 * doesn't exist yet (creating a new file). We walk up to the deepest
 * existing ancestor, realpath that (which resolves any symlinks in the
 * ancestor chain), then re-join the missing tail.
 *
 * Returns a discriminated result so callers don't have to wrap a
 * try/catch around what is mostly a validation step.
 *
 * Known limitation — TOCTOU on intermediate path components: between
 * this check returning a canonical path and the caller's subsequent
 * write, an attacker who can mutate the filesystem can swap a
 * **directory** in the resolved chain for a symlink pointing outside.
 * The kernel re-resolves at write time and follows the new symlink.
 *
 * The LEAF case (the final path component being a symlink at write
 * time) IS now closed — see `safeReadFile` / `safeWriteFile` below,
 * which use `O_NOFOLLOW` + a regular-file `fstat` to refuse following
 * the leaf and to reject FIFOs / device files. Closing the
 * intermediate-component case would need `openat2(RESOLVE_BENEATH)`
 * (Linux 5.6+) via a native binding, which we haven't taken on yet.
 *
 * **Hardlinks are NOT defended against.** If an attacker can hardlink
 * a sensitive file (e.g. `/etc/passwd`) into the workspace, writes
 * mutate the original target. No portable Node fix; the file-system
 * boundary check inherently treats hardlinks as ordinary files.
 *
 * Acceptable for our threat model (the leader is the only intentional
 * mutator inside the workspace), but worth knowing if the trust model
 * tightens.
 */
export async function resolveInsideWorkspace(
  workspaceDir: string,
  requestedPath: string,
  options?: {
    /**
     * Operation the caller intends to perform. Governs the
     * `MAGISTER_EXTRA_ACCESS_ROOTS` allowlist only — paths inside the
     * workspace are always allowed regardless. `"read"` may resolve into
     * read-only external roots; `"write"` (the default, so write_file /
     * edit_file keep their strict workspace-only behaviour) only resolves
     * into roots the operator marked `:rw`.
     */
    intent?: "read" | "write";
  },
): Promise<
  | { ok: true; resolved: string }
  | { ok: false; error: string }
> {
  const intent = options?.intent ?? "write";
  const realWorkspace = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
  const lexical = path.resolve(workspaceDir, requestedPath);

  let current = lexical;
  let suffix = "";
  // Anti-loop guard for pathological symlink chains.
  const MAX_ITERATIONS = 64;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    try {
      const realCurrent = await fs.realpath(current);
      const candidate = suffix ? path.join(realCurrent, suffix) : realCurrent;
      if (candidate === realWorkspace || candidate.startsWith(realWorkspace + path.sep)) {
        // Layer 1 denylist — path resolves cleanly inside the workspace
        // but targets Magister internals (.local, .magister, secrets, .env).
        // Reject *after* the inside-check so external paths still get
        // the more accurate "escapes workspace" error.
        const relFromWorkspace = candidate === realWorkspace
          ? ""
          : path.relative(realWorkspace, candidate);
        if (isInternalPath(relFromWorkspace)) {
          return {
            ok: false,
            error: `path is off-limits to agent tools (Magister-internal directory: ${relFromWorkspace.split(path.sep).join("/")})`,
          };
        }
        return { ok: true, resolved: candidate };
      }
      // Extra-access allowlist (MAGISTER_EXTRA_ACCESS_ROOTS): the path
      // resolved cleanly outside the workspace, but the operator may have
      // approved specific external roots. `candidate` is realpath-resolved
      // above, so a symlink can't smuggle a path past the allowlist. A
      // read-only root permits `intent: "read"` only; a `:rw` root also
      // permits writes (the default intent).
      const extraRoot = matchExtraAccessRoot(parseExtraAccessRoots(), candidate);
      if (extraRoot && (intent === "read" || extraRoot.writable)) {
        return { ok: true, resolved: candidate };
      }
      // Relaxed path policy: allow access outside workspace but still
      // block Magister internals relative to the workspace.
      if (process.env.MAGISTER_RELAXED_PATH_POLICY === "1") {
        return { ok: true, resolved: candidate };
      }
      return { ok: false, error: "path escapes workspace directory" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // Permission errors, EACCES, etc. — fail closed; never silently
        // proceed to a write.
        return {
          ok: false,
          error: `path resolution failed: ${(err as Error)?.message ?? String(err)}`,
        };
      }
      // Could be (a) the path simply doesn't exist (creating a new
      // file), or (b) `current` IS a symlink to a non-existent target
      // ("dangling symlink"). The two look identical to `realpath` but
      // need different handling: in case (b) we must follow the symlink
      // manually, otherwise an attacker could plant a dangling link
      // pointing outside and let the subsequent fs.writeFile create the
      // target file outside the workspace.
      let isDanglingLink = false;
      try {
        const stat = await fs.lstat(current);
        isDanglingLink = stat.isSymbolicLink();
      } catch {
        // current itself doesn't exist (case a) — fall through to walk-up.
      }
      if (isDanglingLink) {
        // Wrap readlink: between the lstat above and this call, the
        // entry could be replaced (TOCTOU race). If readlink throws
        // (EINVAL when it became a regular file, ENOENT when it was
        // deleted, etc.), preserve the helper's "never throws" contract
        // by returning a structured failure instead.
        let target: string;
        try {
          target = await fs.readlink(current);
        } catch (linkErr) {
          return {
            ok: false,
            error: `path resolution failed: ${(linkErr as Error)?.message ?? String(linkErr)}`,
          };
        }
        // readlink returns the raw target string; resolve it relative
        // to the symlink's own directory, not the process cwd.
        current = path.resolve(path.dirname(current), target);
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Ran out of ancestors — only happens if even root can't be
        // statted, which is essentially never.
        return { ok: false, error: "path resolution failed: no existing ancestor" };
      }
      const baseName = path.basename(current);
      suffix = suffix ? path.join(baseName, suffix) : baseName;
      current = parent;
    }
  }
  return { ok: false, error: "path resolution failed: too many symlink levels" };
}

/**
 * Open a path with `O_NOFOLLOW` so that if the FINAL component is a
 * symlink the open fails (`ELOOP`) instead of following it. Closes the
 * leaf-symlink half of the resolveInsideWorkspace TOCTOU window: even
 * if an attacker swaps the leaf for a symlink to /etc/passwd between
 * our resolve check and the actual write, the kernel refuses to
 * follow it.
 *
 * **Limitation**: `O_NOFOLLOW` only inspects the leaf. Symlinks in
 * ancestor directories are still followed by the kernel — closing
 * that needs `openat2(RESOLVE_BENEATH)` (Linux 5.6+) or a chained
 * `openat()` walk, neither of which Node's high-level fs API exposes
 * without a native binding. Acceptable for the leader-as-sole-mutator
 * threat model; documented in the parent helper's doc-comment.
 *
 * Re-throws non-ELOOP errors unchanged. Callers can match `code:
 * "ELOOP"` to format a model-facing message.
 */
async function openLeafSafe(
  filePath: string,
  flags: number,
  mode?: number,
): Promise<fs.FileHandle> {
  // `typeof mode === "number"` instead of `mode !== undefined` so a
  // future caller passing `0` (valid mode) still hits the with-mode
  // branch. 
  return typeof mode === "number"
    ? fs.open(filePath, flags | fsConstants.O_NOFOLLOW, mode)
    : fs.open(filePath, flags | fsConstants.O_NOFOLLOW);
}

/**
 * Verify the post-open handle refers to a regular file. `O_NOFOLLOW`
 * blocks symlinks but NOT character devices, block devices, or FIFOs
 * — opening a FIFO at the leaf would block `readFile`/`writeFile`
 * forever (DoS). Reject anything other than a regular file before
 * any I/O happens.
 *
 * Throws an error with `code: "ENOTREG"` so callers can distinguish
 * from ELOOP.
 */
async function assertRegularFile(fd: fs.FileHandle): Promise<void> {
  const stats = await fd.stat();
  if (!stats.isFile()) {
    const err = new Error(
      "target is not a regular file (refused to operate on FIFO / device / directory)",
    ) as NodeJS.ErrnoException;
    err.code = "ENOTREG";
    throw err;
  }
}

/**
 * Read a file with O_NOFOLLOW protection on the leaf. Returns the
 * file's contents as a UTF-8 string. Throws ELOOP if the leaf is a
 * symlink at open time, ENOTREG if the leaf is a FIFO/device/etc.
 *
 * Note: the ELOOP catch in callers is Linux/macOS-specific. Node on
 * Windows maps `O_NOFOLLOW` to `FILE_FLAG_OPEN_REPARSE_POINT`, which
 * does not produce ELOOP — for now we only support Linux/macOS, so
 * this is fine.
 */
export async function safeReadFile(filePath: string): Promise<string> {
  // O_NONBLOCK avoids hanging open() on a FIFO with no writer; for
  // regular files it's a no-op. We still catch the FIFO via the
  // post-open fstat.
  const fd = await openLeafSafe(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    await assertRegularFile(fd);
    return await fd.readFile("utf-8");
  } finally {
    await fd.close();
  }
}

/**
 * Bytes variant of safeReadFile — for binary formats (DOCX / XLSX /
 * PDF) where the UTF-8 path would return garbage. Same TOCTOU and
 * regular-file guarantees.
 */
export async function safeReadFileBytes(filePath: string): Promise<Buffer> {
  const fd = await openLeafSafe(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    await assertRegularFile(fd);
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}

/**
 * Write a file with O_NOFOLLOW protection on the leaf. Creates the
 * file if missing, truncates if it exists. Throws ELOOP if the leaf
 * is a symlink at open time, ENOTREG if it's a FIFO/device/etc.
 */
export async function safeWriteFile(filePath: string, content: string): Promise<void> {
  // O_NONBLOCK as in safeReadFile — prevents open() blocking on a
  // FIFO with no reader before we get a chance to fstat.
  const fd = await openLeafSafe(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NONBLOCK,
    0o644,
  );
  try {
    await assertRegularFile(fd);
    await fd.writeFile(content, "utf-8");
  } finally {
    await fd.close();
  }
}
