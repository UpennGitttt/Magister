/**
 * Sandbox-elevation v4.3 §4.1 / §4.3 — additional_permissions profile
 * types, Zod schema, and the normalization + validation pipeline for
 * model-supplied permission requests.
 *
 * The pipeline runs in this order (mirrors spec §4.1 validation steps
 * + §4.1 normalization order):
 *
 *   1. Schema parse (Zod .strict() — unknown fields rejected)
 *   2. Path char whitelist (no \n, \r, \0, control chars; ≤ 4096 chars)
 *   3. Glob ban (no *, ?, [, ], {, })
 *   4. Path canonicalization (path.resolve + fs.realpathSync.native if exists)
 *   5. Absoluteness check (post-canonical, starts with /)
 *   6. access:"none" interception (strip + collect as metadata; never
 *      promote sandbox mode — v4.3 fix, addresses codex+kimi review)
 *   7. Per-array dedupe by canonical-path string equality
 *   8. Merge read+write into write-only when same path is in both
 *   9. Sum cap (read.length + write.length ≤ 16)
 *  10. Empty-after-strip check (with_additional_permissions + 0 entries → error)
 *  11. Sensitivity classification + deny-list check
 *
 * Throws ToolUseError on any rejection. Caller wraps as a tool_use_error
 * response. Errors are LOUD by design — silently accepting malformed
 * input opens elevation surfaces.
 */
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";

import {
  classifyPathSensitivity,
  type AccessMode,
  type ClassifyPathOptions,
  type PathSensitivity,
} from "./path-sensitivity";

// ---------- Types ----------

export type FileSystemAccessMode = AccessMode;

export type FileSystemEntry = {
  /** Canonical absolute path. */
  path: string;
  access: FileSystemAccessMode;
  /** Filled by validateAndNormalize — caller uses for UI rendering. */
  sensitivity: PathSensitivity;
  /** Human-readable from path-sensitivity classifier. */
  sensitivityReason: string;
};

export type NetworkPermissions = {
  enabled?: boolean;
};

export type AdditionalPermissionProfile = {
  network?: NetworkPermissions;
  file_system?: { entries: FileSystemEntry[] };
};

export type SandboxPermissionsMode =
  | "use_default"
  | "with_additional_permissions"
  | "require_escalated";

// ---------- Zod schemas ----------

const MAX_PER_ARRAY = 16;
const MAX_PATH_LENGTH = 4096;

const networkSchema = z.object({ enabled: z.boolean().optional() }).strict();

// Note: `access: "none"` is NOT in this schema. We intercept it
// BEFORE Zod parse (see stripAccessNoneEntries) so the codex-trace
// shape can flow in but doesn't promote our sandbox mode.
const fileSystemSchema = z.object({
  read: z.array(z.string().min(1)).max(MAX_PER_ARRAY).optional(),
  write: z.array(z.string().min(1)).max(MAX_PER_ARRAY).optional(),
}).strict();

export const additionalPermissionsSchema = z.object({
  network: networkSchema.optional(),
  file_system: fileSystemSchema.optional(),
}).strict();

export const sandboxPermissionsModeSchema = z
  .enum(["use_default", "with_additional_permissions", "require_escalated"])
  .or(
    // Deprecated alias for one release — "default" → "use_default"
    z.literal("default").transform(() => "use_default" as const),
  );

// ---------- Errors ----------

export class PermissionValidationError extends Error {
  readonly code: string;
  readonly toolUseError: string;   // safe-to-show-to-model string
  constructor(code: string, modelMessage: string) {
    super(`PermissionValidationError[${code}]: ${modelMessage}`);
    this.code = code;
    this.toolUseError = modelMessage;
  }
}

// ---------- Internal helpers ----------

/**
 * Strip `access: "none"` entries from the raw inbound JSON BEFORE
 * Zod parse. v4.3 design — these entries are metadata-only (model's
 * intent surfaced to user) and never affect the sandbox bind list.
 *
 * Returns the stripped JSON + the list of paths that the model
 * wanted to deny-read.
 */
function stripAccessNoneEntries(raw: unknown): {
  cleaned: unknown;
  denyReadRequestedButUnsupported: Array<{ path: string }>;
} {
  const denyReadRequestedButUnsupported: Array<{ path: string }> = [];
  if (!raw || typeof raw !== "object") {
    return { cleaned: raw, denyReadRequestedButUnsupported };
  }
  const rawObj = raw as Record<string, unknown>;
  const fs = rawObj.file_system;
  if (!fs || typeof fs !== "object") {
    return { cleaned: raw, denyReadRequestedButUnsupported };
  }
  const fsObj = fs as Record<string, unknown>;

  const hasEntries = Array.isArray(fsObj.entries);
  const hasReadOrWrite = Array.isArray(fsObj.read) || Array.isArray(fsObj.write);

  // Kimi A.2 review BLOCKER B1: mixed shape is silent data loss.
  // Model traces use one shape consistently — entries[] (codex) OR
  // read[]/write[] (v4 native). When both are present, the
  // entries-branch overwrites read/write fields. That's not just
  // a transform bug: an attacker could smuggle paths via entries
  // hoping the read/write fields are merged when they're actually
  // dropped. Reject outright.
  if (hasEntries && hasReadOrWrite) {
    throw new PermissionValidationError(
      "mixed_shape",
      `additional_permissions.file_system must use EITHER entries[] (codex shape) OR read[]/write[] (v4 shape), not both`,
    );
  }

  // Codex trace shape: file_system.entries: [{path, access}]
  if (hasEntries) {
    const entries = fsObj.entries as unknown[];
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).access === "none") {
        const p = (entry as Record<string, unknown>).path;
        if (typeof p === "string") denyReadRequestedButUnsupported.push({ path: p });
      } else {
        kept.push(entry);
      }
    }
    // Convert legacy entries[] to read[]/write[] arrays for downstream.
    const read: string[] = [];
    const write: string[] = [];
    for (const entry of kept) {
      if (!entry || typeof entry !== "object") continue;
      const eo = entry as Record<string, unknown>;
      if (typeof eo.path !== "string") continue;
      if (eo.access === "write") write.push(eo.path);
      else if (eo.access === "read") read.push(eo.path);
      // Other access values (including unexpected strings) are dropped.
      // Zod .strict() can't catch this because we've already left the
      // entries shape; an unknown access value is a model bug and we
      // surface it by simply omitting from the bind list.
    }
    // Build cleaned object: strip `entries`, install read/write only
    // if they contributed any paths. The rest of the file_system
    // object is preserved (Zod .strict() will catch any other
    // unknown fields).
    const cleanedFs: Record<string, unknown> = { ...fsObj };
    delete cleanedFs.entries;
    if (read.length) cleanedFs.read = read;
    if (write.length) cleanedFs.write = write;
    return {
      cleaned: { ...rawObj, file_system: cleanedFs },
      denyReadRequestedButUnsupported,
    };
  }
  // Native v4 shape: file_system: { read: [...], write: [...] } — no
  // access: "none" to strip; pass through.
  return { cleaned: raw, denyReadRequestedButUnsupported };
}

const GLOB_CHAR_RE = /[*?[\]{}]/;
// C0 controls + DEL + C1 controls (U+0080-U+009F). C1 chars are valid
// Linux filename bytes but make approval-card display ambiguous (most
// terminals/UI fonts render them invisibly or as boxes), enabling path
// display-spoofing attacks. Kimi A.2 review MEDIUM #M1.
const FORBIDDEN_PATH_CHAR_RE = /[\x00-\x1F\x7F-\x9F]/;

function validatePathString(rawPath: string): void {
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new PermissionValidationError(
      "path_too_long",
      `path exceeds ${MAX_PATH_LENGTH} chars: ${rawPath.slice(0, 80)}...`,
    );
  }
  if (FORBIDDEN_PATH_CHAR_RE.test(rawPath)) {
    throw new PermissionValidationError(
      "path_forbidden_chars",
      `path contains control characters (\\n / \\r / \\0 / etc.): ${JSON.stringify(rawPath)}`,
    );
  }
  if (GLOB_CHAR_RE.test(rawPath)) {
    throw new PermissionValidationError(
      "path_glob_unsupported",
      `glob patterns are not supported in v4 — enumerate exact paths: ${rawPath}`,
    );
  }
}

/**
 * Canonicalize a path. Resolves `..` / `.` via path.resolve, then
 * dereferences symlinks via realpath if the path exists.
 *
 * Kimi A.2 review HIGH #H1: errno DISTINCTION matters here.
 *
 *   ENOENT — path doesn't exist. Acceptable; return the resolved
 *            (no-realpath) form. Caller decides whether that's OK
 *            for the context (inline grant: ok; persistent rule /
 *            task-scope ledger: must exist — caller is responsible
 *            for that gate, not us).
 *
 *   EACCES / ELOOP / ENAMETOOLONG / ENOTDIR etc. — path may exist
 *            but server can't canonicalize it. Bind-time bwrap runs
 *            with elevated privilege and DOES dereference the symlink,
 *            so silently accepting the unresolved form lets an
 *            attacker plant a symlink in a server-unreadable
 *            directory pointing at a critical file. Throw LOUD so
 *            the caller turns it into a tool_use_error.
 */
export function canonicalizePath(rawPath: string): string {
  const resolved = resolvePath(rawPath);
  try {
    return realpathSync.native(resolved);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      // Documented "doesn't exist" path — caller validates this is OK.
      return resolved;
    }
    throw new PermissionValidationError(
      "path_canonicalize_failed",
      `cannot canonicalize path (${code ?? "unknown error"}): symlink target unreadable or path inaccessible — request a different path`,
    );
  }
}

// ---------- Public API ----------

export type ValidateAndNormalizeInput = {
  /** Raw `additional_permissions` JSON from the model. */
  raw: unknown;
  /** What sandbox_permissions mode the model declared. */
  mode: SandboxPermissionsMode;
  /** ClassifyPathOptions for the sensitivity classifier. */
  classifyOptions?: ClassifyPathOptions;
  /** Override canonicalizer (tests). Defaults to canonicalizePath above. */
  canonicalize?: (p: string) => string;
};

export type ValidateAndNormalizeResult = {
  /** What mode the dispatcher should use. Falls back to use_default if
   *  with_additional_permissions's entries were all access:none and
   *  got stripped. */
  effectiveMode: SandboxPermissionsMode;
  /** Validated + normalized profile ready for the bind list. */
  profile: AdditionalPermissionProfile;
  /** Paths the model said access:none on — surfaced in approval UI. */
  denyReadRequestedButUnsupported: Array<{ path: string; classification: PathSensitivity }>;
};

export function validateAndNormalize(input: ValidateAndNormalizeInput): ValidateAndNormalizeResult {
  const canonicalize = input.canonicalize ?? canonicalizePath;
  const classifyOpts = input.classifyOptions ?? {};

  // Step 1 — strip access:none BEFORE Zod parse
  const { cleaned, denyReadRequestedButUnsupported: denyRaw } = stripAccessNoneEntries(input.raw);

  // Classify deny-read-requested paths for UI rendering (even though
  // they don't enter the bind list, the user needs to see them with
  // the right sensitivity tag).
  const denyReadRequestedButUnsupported: ValidateAndNormalizeResult["denyReadRequestedButUnsupported"] = [];
  for (const { path: p } of denyRaw) {
    let canonical = p;
    try {
      validatePathString(p);
      canonical = canonicalize(p);
    } catch {
      // If the deny-read path itself fails validation, still surface
      // it with the raw string — the user should know about the model's
      // attempt even if it was malformed.
      denyReadRequestedButUnsupported.push({ path: p, classification: "caution" });
      continue;
    }
    let classification: PathSensitivity = "caution";
    try {
      classification = classifyPathSensitivity(
        canonical,
        "read",
        classifyOpts,
      ).level;
    } catch {
      // Non-canonical path slipped through canonicalize (shouldn't
      // happen but be defensive) — default caution.
    }
    denyReadRequestedButUnsupported.push({ path: canonical, classification });
  }

  // Step 2 — Zod parse the cleaned object (or accept undefined/null)
  let parsed: z.infer<typeof additionalPermissionsSchema> | undefined;
  if (cleaned !== undefined && cleaned !== null) {
    const result = additionalPermissionsSchema.safeParse(cleaned);
    if (!result.success) {
      throw new PermissionValidationError(
        "schema_invalid",
        `additional_permissions schema rejected: ${result.error.message}`,
      );
    }
    parsed = result.data;
  }

  const inputRead = parsed?.file_system?.read ?? [];
  const inputWrite = parsed?.file_system?.write ?? [];

  // Step 3 — per-path validation (char whitelist, glob, length)
  for (const p of [...inputRead, ...inputWrite]) {
    validatePathString(p);
  }

  // Step 4 — canonicalize each path
  const canonicalRead = inputRead.map(canonicalize);
  const canonicalWrite = inputWrite.map(canonicalize);

  // Step 5 — absoluteness check
  for (const p of [...canonicalRead, ...canonicalWrite]) {
    if (!p.startsWith("/")) {
      throw new PermissionValidationError(
        "path_not_absolute",
        `canonical path is not absolute: ${p}`,
      );
    }
  }

  // Step 6 — dedupe per-array (by canonical string)
  const dedupedRead = Array.from(new Set(canonicalRead));
  const dedupedWrite = Array.from(new Set(canonicalWrite));

  // Step 7 — merge read+write: if a path is in both, keep in write only
  // (write strictly covers read in bind translation; matches codex
  // protocol/src/permissions.rs:166-174 wider-access-wins).
  const writeSet = new Set(dedupedWrite);
  const finalRead = dedupedRead.filter((p) => !writeSet.has(p));
  const finalWrite = dedupedWrite;

  const totalCount = finalRead.length + finalWrite.length;

  // Step 8 — sum cap
  if (totalCount > MAX_PER_ARRAY) {
    throw new PermissionValidationError(
      "path_count_exceeded",
      `additional_permissions has ${totalCount} paths after normalization; max ${MAX_PER_ARRAY} per request — split across multiple request_permissions calls if you need more`,
    );
  }

  // Step 9 — empty-after-strip check
  //
  // Two distinct empty cases:
  //  (a) Model passed all access:"none" entries → stripped → now empty.
  //      v4.3 design: silently demote to use_default; the deny-read
  //      intent is surfaced separately via denyReadRequestedButUnsupported.
  //      Do NOT throw — that would punish the model for a codex-trace
  //      pattern we deliberately accept.
  //  (b) Model passed empty/missing read+write with no access:"none"
  //      stripped + no network → genuinely empty. Throw.
  const networkPresent = parsed?.network !== undefined;
  const denyReadStrippedSomething = denyReadRequestedButUnsupported.length > 0;
  if (
    input.mode === "with_additional_permissions"
    && totalCount === 0
    && !networkPresent
    && !denyReadStrippedSomething
  ) {
    throw new PermissionValidationError(
      "with_additional_permissions_empty",
      `sandbox_permissions: "with_additional_permissions" requires at least one entry in additional_permissions.file_system.{read,write} or additional_permissions.network`,
    );
  }

  // Step 10 — classify + deny-list check
  const entries: FileSystemEntry[] = [];
  for (const p of finalWrite) {
    const cls = classifyPathSensitivity(p, "write", classifyOpts);
    if (cls.level === "critical") {
      // Kimi A.2 review MEDIUM #M2: don't echo the raw path or the
      // specific deny-list reason back to the model — both let the
      // model enumerate the deny-list via reconnaissance. The audit
      // log captures full detail for operators.
      throw new PermissionValidationError(
        "path_on_deny_list",
        `requested path is on a non-grantable list (cannot be added to sandbox binds) — pick a different approach`,
      );
    }
    entries.push({ path: p, access: "write", sensitivity: cls.level, sensitivityReason: cls.reason });
  }
  for (const p of finalRead) {
    const cls = classifyPathSensitivity(p, "read", classifyOpts);
    if (cls.level === "critical") {
      // Kimi A.2 review MEDIUM #M2: don't echo the raw path or the
      // specific deny-list reason back to the model — both let the
      // model enumerate the deny-list via reconnaissance. The audit
      // log captures full detail for operators.
      throw new PermissionValidationError(
        "path_on_deny_list",
        `requested path is on a non-grantable list (cannot be added to sandbox binds) — pick a different approach`,
      );
    }
    entries.push({ path: p, access: "read", sensitivity: cls.level, sensitivityReason: cls.reason });
  }

  // Step 11 — effectiveMode
  //
  // Demote with_additional_permissions to use_default ONLY when the
  // entries were stripped by access:"none" interception AND there's
  // no network ask. The model "asked for elevation" but everything
  // it asked for was a deny-read we can't honor — running in the
  // default sandbox is the safe outcome (NOT escalating).
  let effectiveMode: SandboxPermissionsMode = input.mode;
  if (
    input.mode === "with_additional_permissions"
    && totalCount === 0
    && !networkPresent
    && denyReadStrippedSomething
  ) {
    effectiveMode = "use_default";
  }

  // Build profile (omit file_system entirely if no entries; same for network)
  const profile: AdditionalPermissionProfile = {};
  if (entries.length > 0) {
    profile.file_system = { entries };
  }
  if (parsed?.network !== undefined) {
    // Build NetworkPermissions explicitly (Zod's inferred type has
    // `enabled?: boolean | undefined`; the NetworkPermissions type
    // under exactOptionalPropertyTypes expects `enabled?: boolean`
    // without the `| undefined` variant).
    const network: NetworkPermissions = {};
    if (parsed.network.enabled !== undefined) network.enabled = parsed.network.enabled;
    profile.network = network;
  }

  return {
    effectiveMode,
    profile,
    denyReadRequestedButUnsupported,
  };
}

