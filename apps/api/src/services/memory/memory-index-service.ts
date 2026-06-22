import { promises as fs } from "node:fs";
import { join } from "node:path";
import { MEMORY_CONFIG } from "../../config/memory-defaults";
import { listMemory } from "./memory-fs-service";
import { memoryLog } from "./memory-log";
import { getMemoryRuntime } from "./memory-runtime";
import type { MemoryEntry, MemoryScope, MemoryType } from "./memory-types";

const TYPE_ORDER: MemoryType[] = ["user", "project", "feedback", "reference"];

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildInFlight: Promise<void> | null = null;
let rebuildQueued = false;

export function scheduleIndexRebuild(): void {
  // If a rebuild is in flight, mark it queued — do NOT debounce a new timer
  // (the queued rebuild will run immediately after current completes).
  if (rebuildInFlight) {
    rebuildQueued = true;
    return;
  }
  // If a timer is already pending, the upcoming rebuild will capture
  // any newly-written files at fire time.
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    triggerRebuild();
  }, MEMORY_CONFIG.indexRebuildDebounceMs);
}

function triggerRebuild(): void {
  if (rebuildInFlight) {
    rebuildQueued = true;
    return;
  }
  rebuildInFlight = (async () => {
    try {
      await rebuildIndex();
    } catch (err) {
      memoryLog.error("index-rebuild-failed", err);
    } finally {
      rebuildInFlight = null;
      if (rebuildQueued) {
        rebuildQueued = false;
        triggerRebuild();
      }
    }
  })();
}

export async function flushIndexRebuild(): Promise<void> {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    triggerRebuild();
  }
  // Drain any in-flight + queued rebuilds.
  while (rebuildInFlight) {
    await rebuildInFlight;
  }
}

export async function rebuildIndex(): Promise<void> {
  const start = Date.now();
  const rt = getMemoryRuntime();
  const listing = await listMemory();

  // Build a set of every virtual path that actually exists. The
  // reverse-index writer uses this so it doesn't emit edges into
  // ghost targets. Repairing those ghost edges is the aging
  // sweeper's job (mutation), not ours.
  const allPaths = new Set<string>();
  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    for (const entry of listing[scope]) allPaths.add(entry.path);
  }

  for (const scope of ["user-global", "project"] as MemoryScope[]) {
    const text = buildIndexMarkdown(scope, listing[scope]);
    await fs.mkdir(rt.roots[scope], { recursive: true });
    await fs.writeFile(join(rt.roots[scope], "_index.md"), text, "utf8");

    const refs = buildReverseIndex(listing[scope], allPaths);
    await fs.writeFile(
      join(rt.roots[scope], "_refs.json"),
      JSON.stringify(refs, null, 2) + "\n",
      "utf8",
    );
  }
  memoryLog.info("index-rebuild", {
    durationMs: Date.now() - start,
    entries: listing["user-global"].length + listing.project.length,
  });
}

export type ReverseRefEdge = {
  /** Path of the entry that points AT the target. */
  from: string;
  /** Which field on the source entry holds the reference. */
  kind: "supersedes" | "supersededBy" | "related";
};

export type ReverseIndex = Record<string, ReverseRefEdge[]>;

function buildReverseIndex(
  entries: MemoryEntry[],
  allPaths: ReadonlySet<string>,
): ReverseIndex {
  const refs: ReverseIndex = {};
  const push = (target: string, edge: ReverseRefEdge) => {
    if (!allPaths.has(target)) return; // skip ghost targets
    const bucket = refs[target] ?? [];
    bucket.push(edge);
    refs[target] = bucket;
  };
  for (const entry of entries) {
    const fm = entry.frontmatter;
    if (fm.supersedes) push(fm.supersedes, { from: entry.path, kind: "supersedes" });
    if (fm.supersededBy) push(fm.supersededBy, { from: entry.path, kind: "supersededBy" });
    if (fm.related) {
      for (const target of fm.related) {
        push(target, { from: entry.path, kind: "related" });
      }
    }
  }
  // Stable ordering inside each bucket so the JSON doesn't churn on
  // repeated rebuilds.
  for (const target of Object.keys(refs)) {
    refs[target]!.sort((a, b) => {
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      return a.kind.localeCompare(b.kind);
    });
  }
  return refs;
}

function buildIndexMarkdown(scope: MemoryScope, entries: MemoryEntry[]): string {
  const lines: string[] = [`# Memory Index (${scope})`, ""];
  for (const type of TYPE_ORDER) {
    const group = entries.filter((e) => e.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${type}`);
    for (const e of group) {
      const flag = e.frontmatter.agingFlag
        ? ` [${e.frontmatter.agingFlag}]`
        : "";
      lines.push(`- ${e.name} — ${e.frontmatter.description}${flag}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
