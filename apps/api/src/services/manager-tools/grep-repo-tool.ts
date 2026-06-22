import { open, readdir, realpath, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";

import {
  hasBinaryExtension,
  isBinaryContent,
  resolveInsideWorkspace,
} from "./workspace-path";

/**
 * Directories never worth grepping. Includes standard VCS directories,
 * Magister-specific entries (.local, .magister), and common build
 * outputs. The 2026-05-03 incident fired
 * because `.local` was missing from this set — without it, the walker
 * descended into `.local/control-plane.sqlite`, returned binary noise
 * mixed with recursive event payload text, and poisoned the next
 * model turn.
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
  ".local",
  ".magister",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".svelte-kit",
  ".cache",
]);

/** Per-match settings. */
const DEFAULT_HEAD_LIMIT = 250;
const MAX_RESULT_SIZE_CHARS = 20_000;
const MAX_LINE_CHARS = 500;
/** First-N-bytes peek for binary detection on text-extension files. */
const BINARY_PEEK_BYTES = 8192;
/** Per-file read cap. Even a "text" file of 200 MB would OOM the
 *  worker before our match-set caps kick in. Real source/log files
 *  worth grepping are well under 2 MB; the cap stops a stray bundled
 *  fixture or auto-generated artifact from breaking the loop. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(root, entry.name);
      // Kimi review C1 — never traverse symlinks during the walk. A
      // benign-named symlink at the workspace root could point to
      // /etc/passwd or any external file; without this check the
      // walker would happily open and grep its target. Layer 1's
      // denylist only validates the *starting* path, not every leaf
      // discovered during recursion. Symlinks also create cycles that
      // would loop the walker.
      if (entry.isSymbolicLink()) return [] as string[];
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) return [] as string[];
        return walkFiles(fullPath);
      }
      // Skip known-binary extensions outright — no read at all.
      if (hasBinaryExtension(entry.name)) return [] as string[];
      return [fullPath];
    }),
  );
  return nested.flat();
}

async function readForGrep(filePath: string): Promise<string | null> {
  // Open + peek the first BINARY_PEEK_BYTES to decide binary vs text.
  // Avoids loading the full file into memory just to discover it's
  // binary — important for repo roots with stray large files.
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    // Kimi review M2 — refuse files larger than MAX_FILE_BYTES before
    // the full read. Without this, a multi-hundred-MB text log gets
    // entirely loaded into memory before MAX_RESULT_SIZE_CHARS even
    // applies (caps are per-match, not per-file).
    const stats = await fd.stat();
    if (stats.size > MAX_FILE_BYTES) return null;
    const peekBuf = Buffer.alloc(BINARY_PEEK_BYTES);
    const { bytesRead } = await fd.read(peekBuf, 0, BINARY_PEEK_BYTES, 0);
    const peek = peekBuf.subarray(0, bytesRead);
    if (isBinaryContent(peek)) return null;
    // Looks like text — read the rest. We could keep streaming the
    // peek, but a fresh full read is simpler and the overhead is
    // negligible at typical source-file sizes.
    const full = await fd.readFile("utf8");
    return full;
  } catch {
    return null;
  } finally {
    // fd may be undefined only if the outer try/catch above returned
    // early; in that case we never enter this finally branch (the
    // early `return null` short-circuits before reaching here). The
    // `fd?.` guards a different race: a future refactor that moves
    // an early-throw inside this try block. (kimi review item #3 —
    // the current code is clean, but the explicit guard is cheap.)
    await fd?.close().catch(() => {});
  }
}

export async function executeGrepRepoTool(input: {
  workspaceDir: string;
  query: string;
  path?: string;
}) {
  const relativePath = input.path?.trim() || ".";
  const result = await resolveInsideWorkspace(input.workspaceDir, relativePath, { intent: "read" });
  if (!result.ok) {
    throw new Error(`Cannot grep ${relativePath}: ${result.error}`);
  }
  const resolvedRoot = result.resolved;
  const realWorkspaceDir = await realpath(input.workspaceDir).catch(() => resolve(input.workspaceDir));
  const rootStats = await stat(resolvedRoot);
  const files = rootStats.isDirectory() ? await walkFiles(resolvedRoot) : [resolvedRoot];

  const matches: Array<{ path: string; line: number; snippet: string }> = [];
  let totalChars = 0;
  let truncated = false;

  outer: for (const file of files) {
    const content = await readForGrep(file);
    if (content === null) continue;

    const lines = content.replace(/\r\n/g, "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes(input.query)) continue;
      let snippet = line.trim();
      if (snippet.length > MAX_LINE_CHARS) {
        snippet = snippet.slice(0, MAX_LINE_CHARS) + "…[line truncated]";
      }
      const entry = {
        path: relative(realWorkspaceDir, file),
        line: index + 1,
        snippet,
      };
      // Approximate per-entry size cost. Cheap to overshoot; the cap
      // is here to stop runaway noise, not to be precise.
      const approx = entry.path.length + snippet.length + 16;
      if (
        matches.length >= DEFAULT_HEAD_LIMIT ||
        totalChars + approx > MAX_RESULT_SIZE_CHARS
      ) {
        truncated = true;
        break outer;
      }
      matches.push(entry);
      totalChars += approx;
    }
  }

  return {
    query: input.query,
    path: relativePath,
    matches,
    ...(truncated
      ? { truncated: true, note: `Result truncated at ${DEFAULT_HEAD_LIMIT} matches or ${MAX_RESULT_SIZE_CHARS} chars. Narrow the query or path to see more.` }
      : {}),
  };
}
