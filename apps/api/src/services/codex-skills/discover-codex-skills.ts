import { probeCodexSkills, type CodexSkillEntry } from "./codex-probe";
import {
  scanCodexSkills,
  type CodexSkillSourceLabel,
  type ScannedSkillEntry,
} from "./codex-scan";

/**
 * Discover the skills codex's loader actually sees. Probe-first,
 * scan-fallback:
 *
 *   1. Try `codex debug prompt-input` — produces codex's exact
 *      loader output (see codex-probe.ts).
 *   2. On any probe failure (CLI missing, timeout, parse drift,
 *      empty result, exit code ≠ 0), fall back to scanning the
 *      three known source dirs (codex-scan.ts).
 *
 * The probe path lacks per-entry source labels (codex emits a flat
 * list with file paths), so we infer the source from the file path
 * — `.system/` → bundled, `.agents/skills/` → magister-pool,
 * `.codex/superpowers/` → codex-superpowers. Anything else gets
 * labeled `unknown` (rare; would mean codex started reading a dir
 * we haven't accounted for — surfacing it explicitly is more
 * useful than silently dropping).
 *
 * Cache: 5-minute TTL. Skills change infrequently; the spawn cost
 * (~3.6 s on a typical box) shouldn't repeat per UI refresh. The
 * Settings → Skills tab and the Status panel both pull from this
 * cache. Manual refresh button on the Skills tab can bypass via
 * `discoverCodexSkills({ refresh: true })`.
 */

export type CodexExternalSkill = {
  name: string;
  description: string;
  filePath: string;
  source: CodexSkillSourceLabel | "unknown";
};

export type CodexSkillsDiscovery = {
  /** The full list codex's loader sees. */
  skills: CodexExternalSkill[];
  /** Per-source counts for the UI's grouping/display. */
  countsBySource: Record<CodexSkillSourceLabel | "unknown", number>;
  /** Total = sum of counts; provided for convenience. */
  totalCount: number;
  /** Which path produced the result. UI can label "via codex CLI"
   *  vs "via filesystem scan" so users see when we're degraded. */
  method: "probe" | "scan";
  /** Truthy only when probe failed and we fell through to scan.
   *  UI can render this as a warning. */
  fallbackReason?: string;
  /** When this snapshot was taken. */
  takenAt: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { value: CodexSkillsDiscovery; expiresAt: number } | null = null;
// Kimi review M5 — in-flight promise latch. Two simultaneous calls
// during a cache miss (e.g. status panel + skills tab loading at
// the same time on first paint) used to spawn codex twice. We now
// share the single in-flight promise.
let inflight: Promise<CodexSkillsDiscovery> | null = null;

function emptyCounts(): CodexSkillsDiscovery["countsBySource"] {
  return { "codex-bundled": 0, "magister-pool": 0, "codex-superpowers": 0, unknown: 0 };
}

function inferSourceFromPath(filePath: string): CodexSkillSourceLabel | "unknown" {
  if (filePath.includes("/.codex/skills/.system/")) return "codex-bundled";
  if (filePath.includes("/.agents/skills/")) return "magister-pool";
  if (filePath.includes("/.codex/superpowers/skills/")) return "codex-superpowers";
  return "unknown";
}

function summarizeProbe(
  skills: CodexSkillEntry[],
  fallbackReason: undefined,
): CodexSkillsDiscovery {
  const counts = emptyCounts();
  const enriched = skills.map((s) => {
    const source = inferSourceFromPath(s.filePath);
    counts[source] += 1;
    return { ...s, source };
  });
  return {
    skills: enriched,
    countsBySource: counts,
    totalCount: enriched.length,
    method: "probe",
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    takenAt: new Date().toISOString(),
  };
}

function summarizeScan(
  skills: ScannedSkillEntry[],
  fallbackReason: string,
): CodexSkillsDiscovery {
  const counts = emptyCounts();
  for (const s of skills) counts[s.source] += 1;
  return {
    skills,
    countsBySource: counts,
    totalCount: skills.length,
    method: "scan",
    fallbackReason,
    takenAt: new Date().toISOString(),
  };
}

let warnedReasons: Set<string> = new Set();

export async function discoverCodexSkills(
  opts?: { refresh?: boolean },
): Promise<CodexSkillsDiscovery> {
  const now = Date.now();
  if (!opts?.refresh && cached && cached.expiresAt > now) {
    return cached.value;
  }
  // Latch — return the in-flight promise to overlapping callers
  // instead of spawning a second codex.
  if (inflight) return inflight;

  inflight = (async () => {
    const probe = await probeCodexSkills();
    let value: CodexSkillsDiscovery;
    if (probe.ok) {
      value = summarizeProbe(probe.skills, undefined);
    } else {
      if (!warnedReasons.has(probe.reason)) {
        warnedReasons.add(probe.reason);
        console.warn(
          `[codex-skills] probe failed (${probe.reason}); falling back to directory scan.`,
        );
      }
      const scanned = await scanCodexSkills();
      value = summarizeScan(scanned, probe.reason);
    }
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Invalidate the cache. Call after any mutation that could change
 * what codex sees — npx skills add/update/remove run via the Magister
 * skill management routes. Without this, the status panel + skills
 * tab show stale data for up to 5 minutes after a legitimate change.
 * (Kimi review M4.)
 */
export function invalidateCodexSkillsCache(): void {
  cached = null;
}

/** Test-only: clear the cache so unit tests don't leak state. */
export function __resetCodexSkillsCache(): void {
  cached = null;
  inflight = null;
  warnedReasons = new Set();
}
