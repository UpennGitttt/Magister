import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  formatMemoryFile,
  parseMemoryFile,
} from "./memory-frontmatter";
import {
  atomicWrite,
  listMemory,
  resolveWorkspaceHeadSha,
} from "./memory-fs-service";
import { scheduleIndexRebuild } from "./memory-index-service";
import { memoryLog } from "./memory-log";
import { getMemoryRuntime } from "./memory-runtime";
import { recordSweeper } from "./memory-telemetry";
import type { MemoryScope } from "./memory-types";
import { MEMORY_CONFIG } from "../../config/memory-defaults";

export async function sweepAging(): Promise<void> {
  const start = Date.now();
  const rt = getMemoryRuntime();
  const now = Date.now();
  const agingMs = MEMORY_CONFIG.agingDays * 86400_000;
  const staleMs = MEMORY_CONFIG.staleDays * 86400_000;
  // Resolve the workspace HEAD once per tick. Entries with a
  // gitAnchor that doesn't match get `codeChanged: true`; entries
  // whose anchor matches get the flag cleared (the recorded code
  // state is current again — e.g. a checkout went back). Null
  // workspace HEAD (no git, no anchor to compare against) → no
  // change to any entry's codeChanged.
  const workspaceHead = await resolveWorkspaceHeadSha(rt.roots.project);

  // Build the set of valid paths once so the dangling-ref repair
  // pass below can detect references to entries that have been
  // deleted. listMemory is already used by the index rebuild so
  // we're not paying a new full-scope walk per tick — both
  // ride the same readdir.
  const listing = await listMemory();
  const allPaths = new Set<string>();
  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    for (const entry of listing[scope]) allPaths.add(entry.path);
  }

  let updated = 0;
  let refsRepaired = 0;
  let mtimeRaceSkips = 0;
  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    const headForScope = scope === "project" ? workspaceHead : null;
    const scopeResult = await sweepScope(
      rt.roots[scope],
      now,
      agingMs,
      staleMs,
      headForScope,
      allPaths,
    );
    updated += scopeResult.updated;
    refsRepaired += scopeResult.refsRepaired;
    mtimeRaceSkips += scopeResult.mtimeRaceSkips;
  }
  if (updated > 0) scheduleIndexRebuild();
  const durationMs = Date.now() - start;
  memoryLog.info("aging-sweep", {
    durationMs,
    updated,
    refsRepaired,
    mtimeRaceSkips,
    workspaceHead: workspaceHead ?? undefined,
  });
  recordSweeper({ durationMs, updated, refsRepaired, mtimeRaceSkips });
}

interface ScopeSweepResult {
  updated: number;
  refsRepaired: number;
  mtimeRaceSkips: number;
}

async function sweepScope(
  root: string,
  now: number,
  agingMs: number,
  staleMs: number,
  workspaceHead: string | null,
  allPaths: ReadonlySet<string>,
): Promise<ScopeSweepResult> {
  let typeDirs: string[];
  try {
    typeDirs = await fs.readdir(root);
  } catch {
    return { updated: 0, refsRepaired: 0, mtimeRaceSkips: 0 };
  }
  let updated = 0;
  let refsRepaired = 0;
  let mtimeRaceSkips = 0;
  for (const t of typeDirs) {
    if (t.startsWith(".") || t.startsWith("_")) continue;
    let files: string[];
    try {
      files = await fs.readdir(join(root, t));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const full = join(root, t, f);
      try {
        // P0-1 (2026-05-15): capture mtime at read time, re-stat
        // before atomicWrite, and bail if mtime advanced. That means
        // a concurrent writer (upsertMemory, view-touch,
        // patchMemoryLinks) landed in between — our parsed snapshot
        // would otherwise clobber their body update. Microsecond
        // TOCTOU window remains between the second stat and rename,
        // but the multi-second read-modify-write race is closed.
        const statAtRead = await fs.stat(full);
        const mtimeAtRead = statAtRead.mtimeMs;
        const raw = await fs.readFile(full, "utf8");
        const parsed = parseMemoryFile(raw);
        const last = new Date(parsed.frontmatter.lastAccessedAt).getTime();
        const age = now - last;
        let nextAging: "aging" | "stale" | undefined;
        if (age > staleMs) nextAging = "stale";
        else if (age > agingMs) nextAging = "aging";
        else nextAging = undefined;

        // codeChanged maintenance for project-scope entries that
        // carry a gitAnchor. Compare against the workspace HEAD
        // resolved once per tick — anchor mismatch → set true,
        // anchor match → clear the flag.
        let nextCodeChanged: boolean | undefined;
        if (
          workspaceHead &&
          parsed.frontmatter.gitAnchor &&
          parsed.frontmatter.gitAnchor !== workspaceHead
        ) {
          nextCodeChanged = true;
        } else if (
          workspaceHead &&
          parsed.frontmatter.gitAnchor === workspaceHead
        ) {
          nextCodeChanged = undefined;
        } else {
          // Either no workspace HEAD (non-git workspace) or no anchor
          // on this entry → leave the existing codeChanged value as-is.
          nextCodeChanged = parsed.frontmatter.codeChanged;
        }

        // Dangling-ref repair: drop supersedes / supersededBy /
        // related entries that point at paths that no longer exist.
        // Idempotent — next sweep over the same set is a no-op
        // because the dropped refs are gone. The metric is bumped
        // only AFTER atomicWrite below succeeds so a mtime-race skip
        // doesn't inflate the counter.
        const repair = repairDanglingRefs(parsed.frontmatter, allPaths);

        const agingDiffers = nextAging !== parsed.frontmatter.agingFlag;
        const codeChangedDiffers =
          nextCodeChanged !== parsed.frontmatter.codeChanged;
        if (!agingDiffers && !codeChangedDiffers && !repair.repaired) continue;

        if (nextAging === undefined) {
          delete parsed.frontmatter.agingFlag;
        } else {
          parsed.frontmatter.agingFlag = nextAging;
        }
        if (nextCodeChanged === undefined) {
          delete parsed.frontmatter.codeChanged;
        } else {
          parsed.frontmatter.codeChanged = nextCodeChanged;
        }
        // Second stat: bail if mtime advanced since our read.
        let statBeforeWrite: import("node:fs").Stats;
        try {
          statBeforeWrite = await fs.stat(full);
        } catch {
          // Disappeared (concurrent delete) — silent skip.
          continue;
        }
        if (statBeforeWrite.mtimeMs !== mtimeAtRead) {
          memoryLog.info("aging-sweep-skip-race", { file: full });
          mtimeRaceSkips++;
          continue;
        }
        await atomicWrite(full, formatMemoryFile(parsed.frontmatter, parsed.body));
        updated++;
        if (repair.repaired) refsRepaired += repair.removed;
      } catch (err) {
        memoryLog.warn("aging-sweep-skip", {
          file: full,
          err: (err as Error).message,
        });
      }
    }
  }
  return { updated, refsRepaired, mtimeRaceSkips };
}

interface RepairResult {
  repaired: boolean;
  removed: number;
}

function repairDanglingRefs(
  fm: import("./memory-types").MemoryFrontmatter,
  allPaths: ReadonlySet<string>,
): RepairResult {
  let removed = 0;
  if (fm.supersedes && !allPaths.has(fm.supersedes)) {
    delete fm.supersedes;
    removed++;
  }
  if (fm.supersededBy && !allPaths.has(fm.supersededBy)) {
    delete fm.supersededBy;
    removed++;
  }
  if (fm.related && fm.related.length > 0) {
    const filtered = fm.related.filter((p) => allPaths.has(p));
    if (filtered.length !== fm.related.length) {
      removed += fm.related.length - filtered.length;
      if (filtered.length > 0) fm.related = filtered;
      else delete fm.related;
    }
  }
  return { repaired: removed > 0, removed };
}

export function startAgingSweeperLoop(): { stop: () => Promise<void> } {
  let stopped = false;
  let currentSweep: Promise<void> | null = null;
  let nextTimer: ReturnType<typeof setTimeout> | null = null;

  const runTickAndScheduleNext = async (): Promise<void> => {
    if (stopped) return;
    currentSweep = sweepAging().catch((err) => {
      memoryLog.error("aging-sweep-failed", err);
    });
    try {
      await currentSweep;
    } finally {
      currentSweep = null;
    }
    if (stopped) return;
    nextTimer = setTimeout(() => {
      nextTimer = null;
      void runTickAndScheduleNext();
    }, MEMORY_CONFIG.sweeperIntervalMs);
  };

  // Fire-and-forget initial tick; future ticks chain via setTimeout.
  void runTickAndScheduleNext();

  return {
    stop: async () => {
      stopped = true;
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
      if (currentSweep) {
        await currentSweep;
      }
    },
  };
}
