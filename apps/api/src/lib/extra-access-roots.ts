import path from "node:path";
import { realpathSync } from "node:fs";

import { getMagisterEnv } from "./env";

/**
 * One operator-approved root outside the active workspace that agent
 * tools are allowed to reach. Sourced entirely from
 * `MAGISTER_EXTRA_ACCESS_ROOTS`; nothing here is hard-coded.
 */
export interface ExtraAccessRoot {
  /** Canonical absolute root (trailing slash stripped via path.resolve). */
  root: string;
  /** When true, writes are allowed under this root; otherwise read-only. */
  writable: boolean;
}

type WarnFn = (message: string) => void;

/**
 * Parse the `MAGISTER_EXTRA_ACCESS_ROOTS` allowlist.
 *
 * Format: comma-separated absolute path roots. Each entry is **read-only**
 * by default; an explicit `:rw` suffix grants writes, `:ro` is the
 * explicit read-only form. Examples:
 *
 *   MAGISTER_EXTRA_ACCESS_ROOTS=/srv/shared                  # ro
 *   MAGISTER_EXTRA_ACCESS_ROOTS=/srv/shared,/data/cache:rw   # mixed
 *
 * Unset / empty → returns `[]`, i.e. behaviour identical to before this
 * allowlist existed (the gate stays workspace-only). This is the default,
 * so the feature is strictly opt-in and no path is ever baked in.
 *
 * Invalid entries (non-absolute paths) are skipped with a warning so one
 * bad entry never bricks the tool layer — mirrors `MAGISTER_TOOL_DENYLIST`.
 */
export function parseExtraAccessRoots(
  env: NodeJS.ProcessEnv = process.env,
  warn: WarnFn = (message) => console.warn(message),
): ExtraAccessRoot[] {
  const raw = getMagisterEnv("MAGISTER_EXTRA_ACCESS_ROOTS", env);
  if (!raw) return [];

  const out: ExtraAccessRoot[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;

    let writable = false;
    let candidate = entry;
    const suffix = /:(rw|ro)$/.exec(entry);
    if (suffix) {
      writable = suffix[1] === "rw";
      candidate = entry.slice(0, entry.length - suffix[0].length);
    }

    if (!path.isAbsolute(candidate)) {
      warn(`[extra-access-roots] ignoring non-absolute entry: ${entry}`);
      continue;
    }

    let root = path.resolve(candidate);
    try {
      root = realpathSync(root);
    } catch {
      // Non-existent roots are still parsed so callers can surface normal
      // "not under an allowed root" behavior for future paths.
    }
    const existing = out.find((r) => r.root === root);
    if (existing) {
      // Duplicate root — keep the most permissive access seen.
      if (writable) existing.writable = true;
      continue;
    }
    out.push({ root, writable });
  }
  return out;
}

/**
 * Return the matching root for an already-canonical absolute path, or
 * null. A path matches when it IS a root or sits beneath one.
 *
 * The caller is responsible for passing a realpath-resolved candidate so
 * a symlink can't smuggle the path past the allowlist.
 */
export function matchExtraAccessRoot(
  roots: readonly ExtraAccessRoot[],
  absolutePath: string,
): ExtraAccessRoot | null {
  for (const root of roots) {
    if (absolutePath === root.root || absolutePath.startsWith(root.root + path.sep)) {
      return root;
    }
  }
  return null;
}
