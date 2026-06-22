import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnProcess } from "../../lib/platform/spawn";
import { MEMORY_CONFIG } from "../../config/memory-defaults";
import {
  MemoryAuthError,
  MemoryCapacityError,
  MemoryIOError,
} from "./memory-errors";
import {
  formatMemoryFile,
  parseMemoryFile,
} from "./memory-frontmatter";
import { scheduleIndexRebuild } from "./memory-index-service";
import { memoryLog } from "./memory-log";
import {
  buildMemoryPath,
  parseMemoryPath,
  type ParsedMemoryPath,
} from "./memory-path";
import { getMemoryRuntime } from "./memory-runtime";
import {
  ALL_MEMORY_WRITE_AUTHORITIES,
  CHEATSHEET_NAME,
  TYPED_MEMORY_TYPES,
  type MemoryEntry,
  type MemoryFrontmatter,
  type MemoryScope,
  type MemoryWriteAuthority,
  type MemoryWriteInput,
} from "./memory-types";

// P0-2: every write entry calls this first. The check is intentionally
// minimal — catches accidental nullish from a generated/wired path and
// rejects unknown values. Real defense lives at tool-registration (the
// memory tools are never wired into teammate contexts).
function assertWriteAuthority(authority: MemoryWriteAuthority): void {
  if (!authority || !ALL_MEMORY_WRITE_AUTHORITIES.has(authority)) {
    // Telemetry: import dynamically to keep the module graph clean
    // when memory is used without the telemetry module loaded.
    void (async () => {
      try {
        const { recordAuthReject } = await import("./memory-telemetry");
        recordAuthReject();
      } catch {
        // never let telemetry failures shadow the auth error
      }
    })();
    throw new MemoryAuthError(
      `memory write rejected: invalid authority '${String(authority)}'`,
    );
  }
}

// Subdirectories we recognize under a scope root. Anything else is a
// stray (warned + skipped) — without this gate, a user-created
// `project/.magister/memory/notes/` would leak into the leader's
// <memories> injection and the typed-error parsing path. The
// allowlist mirrors the discriminated union in memory-path.ts.
// (Codex review 2026-05-14.)
const VALID_SUBDIRS: ReadonlySet<string> = new Set<string>([
  ...TYPED_MEMORY_TYPES,
  "scratchpad",
]);

export interface UpsertResult {
  path: string;
  created: boolean;
}
export interface DeleteResult {
  path: string;
  deleted: boolean;
}
export type MemoryListing = Record<MemoryScope, MemoryEntry[]>;

function physPath(parsed: ParsedMemoryPath): string {
  const rt = getMemoryRuntime();
  const root = rt.roots[parsed.scope];
  let target: string;
  switch (parsed.kind) {
    case "typed":
      target = join(root, parsed.type, `${parsed.name}.md`);
      break;
    case "cheatsheet":
      // Sits at the scope root — no type directory wrapping it.
      target = join(root, `${CHEATSHEET_NAME}.md`);
      break;
    case "scratchpad":
      target = join(root, "scratchpad", `${parsed.taskId}.md`);
      break;
  }
  // Defense in depth: resolve both paths and confirm target stays
  // inside the scope root. The path parser already rejects `..`
  // and absolute paths, but a symlink planted under the memory dir
  // could redirect writes outside. Reject any target whose resolved
  // form escapes the scope. (Codex final review 2026-05-14.)
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + "/")
  ) {
    throw new MemoryIOError(
      `memory path escapes scope root: ${target}`,
    );
  }
  return target;
}

function bodyCapsFor(parsed: ParsedMemoryPath): {
  maxBytes: number;
  maxLines: number;
} {
  switch (parsed.kind) {
    case "typed":
      return {
        maxBytes: MEMORY_CONFIG.typedEntryBodyMaxBytes,
        maxLines: MEMORY_CONFIG.typedEntryBodyMaxLines,
      };
    case "cheatsheet":
      return {
        maxBytes: MEMORY_CONFIG.cheatsheetBodyMaxBytes,
        maxLines: MEMORY_CONFIG.cheatsheetBodyMaxLines,
      };
    case "scratchpad":
      return {
        maxBytes: MEMORY_CONFIG.scratchpadBodyMaxBytes,
        maxLines: MEMORY_CONFIG.scratchpadBodyMaxLines,
      };
  }
}

export async function upsertMemory(
  input: MemoryWriteInput,
  authority: MemoryWriteAuthority,
): Promise<UpsertResult> {
  assertWriteAuthority(authority);
  if (input.description.length > MEMORY_CONFIG.descriptionMaxChars) {
    throw new MemoryCapacityError(
      `description exceeds ${MEMORY_CONFIG.descriptionMaxChars} chars`
    );
  }
  const parsed = parseMemoryPath(input.path);
  const caps = bodyCapsFor(parsed);
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (bodyBytes > caps.maxBytes) {
    throw new MemoryCapacityError(
      `body exceeds ${caps.maxBytes} bytes for ${parsed.kind} entry`,
    );
  }
  const bodyLines = input.body.split("\n").length;
  if (bodyLines > caps.maxLines) {
    throw new MemoryCapacityError(
      `body exceeds ${caps.maxLines} lines for ${parsed.kind} entry`,
    );
  }
  const full = physPath(parsed);

  const now = new Date().toISOString();
  let createdAt = now;
  let existed = false;
  try {
    const raw = await fs.readFile(full, "utf8");
    const old = parseMemoryFile(raw);
    createdAt = old.frontmatter.createdAt;
    existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MemoryIOError(`failed reading existing ${full}`, err);
    }
  }

  const rt = getMemoryRuntime();
  const fm: MemoryFrontmatter = {
    schemaVersion: rt.schemaVersion,
    name: parsed.name,
    description: input.description,
    type: parsed.type,
    createdAt,
    lastAccessedAt: now,
  };
  if (input.supersedes !== undefined) fm.supersedes = input.supersedes;
  if (input.supersededBy !== undefined) fm.supersededBy = input.supersededBy;
  if (input.related !== undefined) fm.related = input.related;
  if (parsed.kind === "scratchpad") fm.taskId = parsed.taskId;
  // Phase 3: stamp the workspace's current HEAD commit on typed
  // project-scope entries so the aging sweeper can detect when the
  // code the entry was written against has moved. Best-effort —
  // non-git workspaces and git failures simply leave `gitAnchor`
  // undefined.
  if (parsed.kind === "typed" && parsed.scope === "project") {
    const anchor = await resolveWorkspaceHeadSha(rt.roots.project);
    if (anchor) fm.gitAnchor = anchor;
  }
  const content = formatMemoryFile(fm, input.body);
  await atomicWrite(full, content);
  scheduleIndexRebuild();
  memoryLog.info("upsert", {
    path: input.path,
    bytes: bodyBytes,
    created: !existed,
  });
  // P2-#6 / HIGH-5 (2026-05-15 follow-up): provenance mirror.
  // AWAITED — the previous fire-and-forget shape let a follow-up
  // read in the same turn miss the just-written row. Failures are
  // still best-effort (logged, never propagated) so a DB hiccup
  // can't poison the on-disk write that already committed.
  //
  // We also pass `writtenAt: now` (captured BEFORE this await) so
  // the provenance timestamp reflects when the FS write actually
  // committed, not when the mirror callback happened to run.
  // Without this, MEDIUM-12 lets an older slow task overwrite a
  // newer fast one with stale authorship.
  try {
    const { MemoryProvenanceRepository } = await import(
      "../../repositories/memory-provenance-repository"
    );
    await new MemoryProvenanceRepository().record({
      path: buildMemoryPath(parsed),
      scope: parsed.scope,
      type: parsed.type,
      authority,
      writtenAt: new Date(now),
      ...(input.provenance?.taskId ? { taskId: input.provenance.taskId } : {}),
      ...(input.provenance?.requestId
        ? { requestId: input.provenance.requestId }
        : {}),
    });
  } catch (err) {
    memoryLog.warn("provenance-record-failed", {
      path: input.path,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // P2-#7 / HIGH-3 (2026-05-15 follow-up): FTS5 BM25 mirror, AWAITED.
  // Same rationale as provenance — a leader can call upsert_memory
  // and search_memory back-to-back, and the second call must see
  // the first call's row. Best-effort error handling preserved.
  try {
    const { mirrorWrite } = await import("./memory-search-service");
    await mirrorWrite({
      path: buildMemoryPath(parsed),
      scope: parsed.scope,
      type: parsed.type,
      description: input.description,
      body: input.body,
    });
  } catch (err) {
    memoryLog.warn("search-mirror-write-failed", {
      path: input.path,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase 3 A-MEM link pass: fire-and-forget after the write
  // commits. Only typed entries enter the link graph (cheatsheet +
  // scratchpad are pinned shapes that don't link). The
  // `skipLinkPass` guard prevents the extractor's own ops from
  // re-triggering the pass on themselves — `runMemoryExtractor`
  // sets it when applying its operations. Dynamic import keeps the
  // fs-service module graph independent of the extractor / model
  // path so memory works fine on a no-LLM setup.
  if (input.skipLinkPass !== true && parsed.kind === "typed") {
    void (async () => {
      try {
        const { fireAmemLinkPass } = await import("./memory-amem-link-pass");
        fireAmemLinkPass({
          newEntryPath: buildMemoryPath(parsed),
          newEntryDescription: input.description,
          newEntryBody: input.body,
          scope: parsed.scope,
        });
      } catch {
        // never poison the write path
      }
    })();
  }

  return { path: buildMemoryPath(parsed), created: !existed };
}

/**
 * Targeted patch that updates ONLY the link fields (supersedes /
 * supersededBy / related) on an existing entry, preserving every
 * other frontmatter field — createdAt, lastAccessedAt, agingFlag,
 * codeChanged, gitAnchor, taskId, schemaVersion.
 *
 * This exists because `upsertMemory` rebuilds frontmatter from
 * scratch on every call (re-stamps gitAnchor, drops sweep-set
 * flags). A-MEM's link pass needs to merge links into the entry
 * WITHOUT clobbering staleness flags the sweeper has computed.
 * (Codex final review 2026-05-14.)
 */
export async function patchMemoryLinks(
  virtualPath: string,
  patch: {
    supersedes?: string;
    supersededBy?: string;
    related?: string[];
  },
  authority: MemoryWriteAuthority,
): Promise<boolean> {
  assertWriteAuthority(authority);
  const parsed = parseMemoryPath(virtualPath);
  const full = physPath(parsed);
  let raw: string;
  try {
    raw = await fs.readFile(full, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new MemoryIOError(`failed reading ${full}`, err);
  }
  const file = parseMemoryFile(raw);
  let dirty = false;
  if (patch.supersedes !== undefined) {
    if (file.frontmatter.supersedes !== patch.supersedes) {
      file.frontmatter.supersedes = patch.supersedes;
      dirty = true;
    }
  }
  if (patch.supersededBy !== undefined) {
    if (file.frontmatter.supersededBy !== patch.supersededBy) {
      file.frontmatter.supersededBy = patch.supersededBy;
      dirty = true;
    }
  }
  if (patch.related !== undefined) {
    const before = JSON.stringify(file.frontmatter.related ?? []);
    const after = JSON.stringify(patch.related);
    if (before !== after) {
      if (patch.related.length > 0) file.frontmatter.related = patch.related;
      else delete file.frontmatter.related;
      dirty = true;
    }
  }
  if (!dirty) return false;
  await atomicWrite(full, formatMemoryFile(file.frontmatter, file.body));
  scheduleIndexRebuild();
  memoryLog.info("link-patch", { path: virtualPath });
  return true;
}

export async function deleteMemory(
  virtualPath: string,
  authority: MemoryWriteAuthority,
): Promise<DeleteResult> {
  assertWriteAuthority(authority);
  const parsed = parseMemoryPath(virtualPath);
  const full = physPath(parsed);
  const canonicalPath = buildMemoryPath(parsed);
  let unlinkedNow = false;
  try {
    await fs.unlink(full);
    unlinkedNow = true;
    // Eager dangling-ref cleanup: any entry whose supersedes /
    // supersededBy / related still points at the path we just
    // deleted gets the orphan reference dropped now, in-process.
    // Without this the aging sweeper would clean up at the daily
    // cadence, leaving up to 24h of stale `supersededBy` badges
    // in the UI (and stale fields in `_refs.json` until the next
    // index rebuild). (Codex Phase 3 review.)
    const repaired = await eagerRepairReferencesTo(canonicalPath);
    scheduleIndexRebuild();
    memoryLog.info("delete", {
      path: virtualPath,
      deleted: true,
      referencesRepaired: repaired,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MemoryIOError(`failed deleting ${full}`, err);
    }
    memoryLog.info("delete-noop", { path: virtualPath });
  }
  // MEDIUM-10 (2026-05-15 follow-up): mirror cleanup runs on BOTH the
  // successful-unlink and ENOENT branches. The previous shape early-
  // returned on ENOENT and skipped mirror cleanup entirely, so if a
  // first call succeeded the unlink but failed the mirror delete, a
  // second call would short-circuit on ENOENT and leave the mirror
  // row orphaned. Now both branches sync mirrors (idempotent — mirror
  // delete is a `DELETE WHERE path=?` no-op when the row is gone).
  //
  // HIGH-4 (2026-05-15): mirror deletes are AWAITED so a follow-up
  // search in the same turn doesn't return the just-removed entry.
  try {
    const { MemoryProvenanceRepository } = await import(
      "../../repositories/memory-provenance-repository"
    );
    await new MemoryProvenanceRepository().forgetPath(canonicalPath);
  } catch (err) {
    memoryLog.warn("provenance-forget-failed", {
      path: virtualPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const { mirrorDelete } = await import("./memory-search-service");
    await mirrorDelete(canonicalPath);
  } catch (err) {
    memoryLog.warn("search-mirror-delete-failed", {
      path: virtualPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return { path: canonicalPath, deleted: unlinkedNow };
}

/**
 * Scan every entry in both scopes and drop any reference whose
 * target equals `deletedPath`. Returns the count of repaired
 * entries.
 *
 * Best-effort: a per-entry parse failure is logged + skipped
 * rather than aborting the cleanup. The aging sweeper's repair
 * pass remains as the safety net for entries this misses (e.g.
 * a parse error here is retried in 24h).
 */
async function eagerRepairReferencesTo(
  deletedPath: string,
): Promise<number> {
  const rt = getMemoryRuntime();
  let repaired = 0;
  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    let topEntries: string[];
    try {
      topEntries = await fs.readdir(rt.roots[scope]);
    } catch {
      continue;
    }
    for (const top of topEntries) {
      if (top.startsWith(".") || top.startsWith("_")) continue;
      if (top === `${CHEATSHEET_NAME}.md`) {
        // Cheatsheet doesn't carry supersedes/related fields in
        // practice (pinned shape), but check anyway for safety.
        const full = join(rt.roots[scope], top);
        if (await repairSingleFile(full, deletedPath)) repaired++;
        continue;
      }
      const subdir = join(rt.roots[scope], top);
      let files: string[];
      try {
        files = await fs.readdir(subdir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const full = join(subdir, f);
        if (await repairSingleFile(full, deletedPath)) repaired++;
      }
    }
  }
  return repaired;
}

async function repairSingleFile(
  fullPath: string,
  deletedPath: string,
): Promise<boolean> {
  try {
    // Skip symlinks — never rewrite a file we don't own. (Same
    // hardening as listScope; without this, a malicious symlink
    // could redirect our rewrite outside the memory scope.)
    const fileStat = await fs.lstat(fullPath).catch(() => null);
    if (!fileStat || fileStat.isSymbolicLink()) {
      return false;
    }
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = parseMemoryFile(raw);
    let dirty = false;
    if (parsed.frontmatter.supersedes === deletedPath) {
      delete parsed.frontmatter.supersedes;
      dirty = true;
    }
    if (parsed.frontmatter.supersededBy === deletedPath) {
      delete parsed.frontmatter.supersededBy;
      dirty = true;
    }
    if (parsed.frontmatter.related?.includes(deletedPath)) {
      const filtered = parsed.frontmatter.related.filter(
        (p) => p !== deletedPath,
      );
      if (filtered.length > 0) parsed.frontmatter.related = filtered;
      else delete parsed.frontmatter.related;
      dirty = true;
    }
    if (!dirty) return false;
    await atomicWrite(fullPath, formatMemoryFile(parsed.frontmatter, parsed.body));
    return true;
  } catch (err) {
    memoryLog.warn("delete-repair-skip", {
      file: fullPath,
      err: (err as Error).message,
    });
    return false;
  }
}

export async function viewMemory(
  virtualPath: string
): Promise<MemoryEntry | null> {
  const parsed = parseMemoryPath(virtualPath);
  const full = physPath(parsed);
  let raw: string;
  try {
    raw = await fs.readFile(full, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MemoryIOError(`failed reading ${full}`, err);
  }
  const file = parseMemoryFile(raw);
  const now = new Date();
  // Only rewrite when the recorded lastAccessedAt is more than an
  // hour old. The aging-flag thresholds are 30 / 90 days, so
  // hourly precision is plenty. Avoiding the rewrite on every
  // view collapses a real race window where a concurrent
  // upsertMemory between our read and our write would silently
  // lose the upserter's body update. (Codex final review
  // 2026-05-14.)
  const VIEW_TOUCH_MIN_DELTA_MS = 60 * 60 * 1000; // 1h
  const prev = Date.parse(file.frontmatter.lastAccessedAt);
  if (
    !Number.isFinite(prev) ||
    now.getTime() - prev > VIEW_TOUCH_MIN_DELTA_MS
  ) {
    file.frontmatter.lastAccessedAt = now.toISOString();
    const refreshed = formatMemoryFile(file.frontmatter, file.body);
    try {
      await atomicWrite(full, refreshed);
    } catch (err) {
      memoryLog.warn("view-touch-failed", { path: virtualPath, err });
    }
  }
  return {
    scope: parsed.scope,
    type: parsed.type,
    name: parsed.name,
    path: buildMemoryPath(parsed),
    frontmatter: file.frontmatter,
    body: file.body,
  };
}

export async function listMemory(): Promise<MemoryListing> {
  const rt = getMemoryRuntime();
  const result: MemoryListing = { "user-global": [], project: [] };
  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    result[scope] = await listScope(scope, rt.roots[scope]);
  }
  return result;
}

async function listScope(
  scope: MemoryScope,
  root: string
): Promise<MemoryEntry[]> {
  let topEntries: string[];
  try {
    topEntries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MemoryIOError(`failed listing ${root}`, err);
  }
  const entries: MemoryEntry[] = [];
  for (const top of topEntries) {
    if (top.startsWith(".") || top.startsWith("_")) continue;
    const full = join(root, top);

    // Top-level cheatsheet.md — flat file at the scope root.
    if (top === `${CHEATSHEET_NAME}.md`) {
      try {
        // lstat-guard: cheatsheet planted as a symlink would
        // otherwise leak its target's content. (Self-audit.)
        const csStat = await fs.lstat(full);
        if (csStat.isSymbolicLink()) {
          memoryLog.warn("list-skip-symlink", {
            path: `${scope}/${CHEATSHEET_NAME}`,
          });
          continue;
        }
        const raw = await fs.readFile(full, "utf8");
        const fileParsed = parseMemoryFile(raw);
        entries.push({
          scope,
          type: fileParsed.frontmatter.type,
          name: CHEATSHEET_NAME,
          path: `${scope}/${CHEATSHEET_NAME}`,
          frontmatter: fileParsed.frontmatter,
          body: fileParsed.body,
        });
      } catch (err) {
        memoryLog.warn("list-parse-skipped", {
          path: `${scope}/${CHEATSHEET_NAME}`,
          err: (err as Error).message,
        });
      }
      continue;
    }

    // Anything else with a `.md` extension at the scope root is an
    // unexpected stray — skip with a log so the operator can clean
    // up rather than letting it leak into the listing.
    if (top.endsWith(".md")) {
      memoryLog.warn("list-unexpected-file", { path: `${scope}/${top}` });
      continue;
    }

    // Subdir — must be one of the allowlisted shapes (typed-type
    // dir or `scratchpad/`). Anything else is an unexpected stray;
    // skip with a log instead of recursing.
    if (!VALID_SUBDIRS.has(top)) {
      memoryLog.warn("list-unexpected-subdir", { path: `${scope}/${top}/` });
      continue;
    }
    // lstat the subdir entry before recursing: a symlinked
    // top-level dir would otherwise redirect the listing walk
    // outside the scope root. Skip + warn instead of following.
    // (Self-audit 2026-05-14.)
    try {
      const dirStat = await fs.lstat(full);
      if (dirStat.isSymbolicLink()) {
        memoryLog.warn("list-skip-symlink-dir", { path: `${scope}/${top}/` });
        continue;
      }
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = await fs.readdir(full);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      const virtualPath = `${scope}/${top}/${name}`;
      try {
        const filePath = join(full, f);
        // Same lstat guard for individual .md entries — a planted
        // symlink in a typed-type dir could otherwise leak content
        // from outside the scope into the listing.
        const fileStat = await fs.lstat(filePath);
        if (fileStat.isSymbolicLink()) {
          memoryLog.warn("list-skip-symlink", { path: virtualPath });
          continue;
        }
        const raw = await fs.readFile(filePath, "utf8");
        const fileParsed = parseMemoryFile(raw);
        entries.push({
          scope,
          type: fileParsed.frontmatter.type,
          name,
          path: virtualPath,
          frontmatter: fileParsed.frontmatter,
          body: fileParsed.body,
        });
      } catch (err) {
        memoryLog.warn("list-parse-skipped", {
          path: virtualPath,
          err: (err as Error).message,
        });
      }
    }
  }
  return entries;
}

/**
 * Workspace dir derived from the project memory root. project memory
 * lives at `<workspace>/.magister/memory`, so the workspace is two
 * levels up. Exposed so the aging sweeper can run git commands
 * against the same dir the upsert path stamped its anchor from.
 */
export function resolveWorkspaceFromProjectRoot(projectRoot: string): string {
  return resolve(dirname(dirname(projectRoot)));
}

/**
 * Best-effort `git rev-parse HEAD` for the workspace owning the
 * project memory scope. Returns `null` when not a git checkout or
 * git is absent — caller treats that as "no anchor", matching
 * `repo_structure`'s degraded-mode behavior.
 */
export async function resolveWorkspaceHeadSha(
  projectRoot: string,
): Promise<string | null> {
  const cwd = resolveWorkspaceFromProjectRoot(projectRoot);
  try {
    const proc = spawnProcess(["git", "rev-parse", "HEAD"], {
      cwd,
      env: process.env as Record<string, string>,
    });
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const sha = (await proc.stdoutText()).trim();
    return sha.length >= 7 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort removal of the per-task scratchpad file. Called by
 * `task-retention-service` when a task is purged so the on-disk
 * scratchpad doesn't leak space without metadata pointing at it.
 *
 * Mirrors `purgeAttachmentFiles`: never throws, never blocks the
 * sweep on a filesystem hiccup. Idempotent — ENOENT is fine.
 */
export async function purgeScratchpadForTask(taskId: string): Promise<void> {
  // Validate taskId before joining it into a path — a poisoned DB
  // row could otherwise contain `..` / `/` and let the unlink
  // escape the scratchpad dir. The character class matches what
  // process-task-intent-service mints and what parseMemoryPath
  // accepts for scratchpad names. (Codex final review 2026-05-14.)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(taskId)) {
    memoryLog.warn("scratchpad-purge-invalid-taskid", { taskId });
    return;
  }
  const rt = getMemoryRuntime();
  const full = join(rt.roots.project, "scratchpad", `${taskId}.md`);
  try {
    await fs.unlink(full);
    scheduleIndexRebuild();
    memoryLog.info("scratchpad-purge", { taskId, deleted: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      memoryLog.warn("scratchpad-purge-failed", {
        taskId,
        err: (err as Error).message,
      });
    }
  }
}

export async function cleanupTmpFiles(): Promise<void> {
  const rt = getMemoryRuntime();
  let cleaned = 0;
  for (const root of Object.values(rt.roots) as string[]) {
    try {
      cleaned += await walkAndCleanTmp(root);
    } catch (err) {
      memoryLog.warn("tmp-cleanup-failed", {
        root,
        err: (err as Error).message,
      });
    }
  }
  memoryLog.info("tmp-cleanup", { cleaned });
}

export async function atomicWrite(target: string, content: string): Promise<void> {
  // Crash-durable write per decisions doc §113:
  //   1. write to <target>.tmp.<uuid>
  //   2. fsync the tmp file so contents reach disk
  //   3. rename tmp → target (atomic on POSIX)
  //   4. fsync the parent directory so the rename is durable
  // Without the fsyncs, a kernel crash between write and rename
  // could leave a zero-byte target. (Codex final review 2026-05-14.)
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
  // fsync the parent dir to make the rename itself durable. Best-
  // effort: not every filesystem supports directory fsync (Windows
  // historically), so swallow errors here.
  try {
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync unsupported on this fs — accept the residual
    // durability gap; the file-level fsync above already gives us
    // crash-correct contents.
  }
}

async function walkAndCleanTmp(root: string): Promise<number> {
  let count = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(root, e);
    let stat;
    try {
      // lstat (NOT stat) — don't follow symlinks. A symlinked
      // subdir could otherwise redirect the walk outside the
      // memory scope. (Codex final review 2026-05-14.)
      stat = await fs.lstat(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      // Skip symlinks entirely; they aren't part of the canonical
      // memory layout. Log so a human can clean up.
      memoryLog.warn("tmp-cleanup-skip-symlink", { path: full });
      continue;
    }
    if (stat.isDirectory()) {
      count += await walkAndCleanTmp(full);
    } else if (e.includes(".tmp.")) {
      try {
        await fs.unlink(full);
        count++;
      } catch {
        /* skip */
      }
    }
  }
  return count;
}
