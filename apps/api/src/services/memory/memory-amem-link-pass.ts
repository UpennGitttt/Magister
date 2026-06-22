import { listMemory, patchMemoryLinks } from "./memory-fs-service";
import { runMemoryExtractor } from "./memory-extractor-service";
import { memoryLog } from "./memory-log";
import type { MemoryEntry, MemoryScope } from "./memory-types";
import { parseMemoryPath } from "./memory-path";

/**
 * Phase 3 A-MEM (Agentic Memory) link pass. After a typed entry is
 * upserted, this fire-and-forget routine:
 *   1. Lists existing entries in the same scope
 *   2. Picks the K=3 nearest by Jaccard token overlap on description
 *   3. Asks the extractor to propose `supersedes` / `related` edges
 *      that link the new entry to those neighbors
 *
 * Why this shape:
 *   - NO embeddings. The decisions doc parks vector search to
 *     Phase 4 if needed; keyword Jaccard over short descriptions
 *     gives "good enough" candidate generation for K=3.
 *   - K=3 keeps the extractor prompt bounded; even at 50 nearby
 *     entries we only pay the extractor budget for the 3 closest.
 *   - Extractor decides — the link pass doesn't auto-link. We
 *     pre-filter candidates; the model judges whether any genuine
 *     supersede/related relationship exists.
 *
 * Recursion guard: extractor invokes upsertMemory with
 * `skipLinkPass: true` so its own ops don't trigger another link
 * pass on the same entry. Without this, link pass → extractor →
 * upsert → link pass → … could spiral.
 */

const K_NEAREST = 3;
const MIN_OVERLAP_FOR_CANDIDATE = 1; // need at least one shared meaningful token
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "for",
  "with",
  "to",
  "is",
  "are",
  "was",
  "were",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "be",
  "by",
  "at",
  "as",
  "from",
]);

export function fireAmemLinkPass(input: {
  newEntryPath: string;
  newEntryDescription: string;
  newEntryBody: string;
  scope: MemoryScope;
}): void {
  void (async () => {
    try {
      const listing = await listMemory();
      const sameScope = listing[input.scope] ?? [];
      const candidates = pickNearestCandidates(
        input.newEntryPath,
        input.newEntryDescription,
        sameScope,
      );
      if (candidates.length === 0) {
        memoryLog.info("amem-skipped-no-candidates", {
          path: input.newEntryPath,
        });
        return;
      }
      const prompt = buildLinkPrompt({
        newEntryPath: input.newEntryPath,
        newEntryDescription: input.newEntryDescription,
        newEntryBody: input.newEntryBody,
        candidates,
      });
      // applyOps:false — we apply ourselves so the extractor's
      // op CAN'T overwrite the entry's body/description. The
      // model is instructed to preserve those verbatim, but
      // any drift would silently clobber real content. We
      // accept ONLY link-field deltas (supersedes/supersededBy/
      // related) targeted at the new entry's path.
      const result = await runMemoryExtractor({
        reason: "amem_link",
        userPrompt: prompt,
        applyOps: false,
        // Singleflight key on the target entry path so different
        // entries' link passes don't coalesce — but a duplicate
        // pass for the SAME entry (e.g., back-to-back upserts of
        // the same path) does, which is the safe collapse.
        dedupeKey: input.newEntryPath,
      });
      const applied = await applyLinkOnlyMerge({
        newEntryPath: input.newEntryPath,
        candidateSet: new Set(candidates.map((c) => c.path)),
        parsedOps: result.parsedOps,
      });
      memoryLog.info("amem-link-pass-fired", {
        path: input.newEntryPath,
        candidates: candidates.length,
        applied,
        proposedOps: result.parsedOps.length,
      });
    } catch (err) {
      memoryLog.warn("amem-link-pass-error", {
        path: input.newEntryPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

/**
 * Apply ONLY link-field deltas from the extractor's proposals.
 *
 * Defense against model drift (codex review 2026-05-14): the extractor
 * might propose ops that rewrite the new entry's body/description
 * along with the link fields. We re-fetch the entry's current state
 * and merge ONLY the link fields, with three additional guardrails:
 *   - the op must target the new entry's exact path (we don't let
 *     A-MEM mutate neighbors)
 *   - supersedes/supersededBy targets MUST be in the candidate set
 *     we surfaced; the model can't link to arbitrary paths it
 *     fabricated
 *   - `related` is filtered down to candidates as well
 *
 * Returns the count of entries actually updated (0 or 1 — there's
 * only one target).
 */
async function applyLinkOnlyMerge(input: {
  newEntryPath: string;
  candidateSet: ReadonlySet<string>;
  parsedOps: Array<{
    op: "upsert";
    path: string;
    description: string;
    body: string;
    supersedes?: string;
    supersededBy?: string;
    related?: string[];
  }>;
}): Promise<number> {
  const targeted = input.parsedOps.find(
    (op) => op.op === "upsert" && op.path === input.newEntryPath,
  );
  if (!targeted) return 0;

  // Compute the link-field deltas that survive validation.
  const supersedes =
    targeted.supersedes && input.candidateSet.has(targeted.supersedes)
      ? targeted.supersedes
      : undefined;
  const supersededBy =
    targeted.supersededBy && input.candidateSet.has(targeted.supersededBy)
      ? targeted.supersededBy
      : undefined;
  const related = Array.isArray(targeted.related)
    ? targeted.related.filter((p) => input.candidateSet.has(p))
    : undefined;

  if (
    supersedes === undefined &&
    supersededBy === undefined &&
    (!related || related.length === 0)
  ) {
    return 0;
  }

  // Use the targeted link-patch helper, NOT upsertMemory. The latter
  // rebuilds the entire frontmatter from scratch — it would wipe
  // agingFlag / codeChanged / gitAnchor that the sweeper has set.
  // patchMemoryLinks preserves every other field and only updates
  // the link deltas. (Codex final review 2026-05-14.)
  const patched = await patchMemoryLinks(
    input.newEntryPath,
    {
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      ...(related && related.length > 0 ? { related } : {}),
    },
    "leader-amem-link",
  );
  return patched ? 1 : 0;
}

export interface AmemCandidate {
  path: string;
  description: string;
  overlap: number;
}

export function pickNearestCandidates(
  newEntryPath: string,
  newEntryDescription: string,
  scopedEntries: MemoryEntry[],
): AmemCandidate[] {
  const newTokens = tokenize(newEntryDescription);
  if (newTokens.size === 0) return [];
  const scored: AmemCandidate[] = [];
  for (const entry of scopedEntries) {
    if (entry.path === newEntryPath) continue;
    // Skip pinned shapes — they're not part of the typed linkable
    // graph. A cheatsheet doesn't supersede a typed entry.
    if (entry.type === "cheatsheet" || entry.type === "scratchpad") continue;
    const otherTokens = tokenize(entry.frontmatter.description);
    const overlap = jaccardSize(newTokens, otherTokens);
    if (overlap < MIN_OVERLAP_FOR_CANDIDATE) continue;
    scored.push({
      path: entry.path,
      description: entry.frontmatter.description,
      overlap,
    });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, K_NEAREST);
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccardSize(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  return inter;
}

function buildLinkPrompt(input: {
  newEntryPath: string;
  newEntryDescription: string;
  newEntryBody: string;
  candidates: AmemCandidate[];
}): string {
  const lines: string[] = [];
  lines.push(`# A-MEM link pass`);
  lines.push(``);
  lines.push(
    `A new memory entry was just written. Decide whether it should be linked to any of the K nearest existing entries via \`supersedes\` (this entry STRICTLY REPLACES an old one) or \`related\` (same topic, neither replaces the other). When in doubt, return an empty operations array — over-linking is worse than no linking.`,
  );
  lines.push(``);
  lines.push(`## New entry`);
  lines.push(`- path: ${input.newEntryPath}`);
  lines.push(`- description: ${input.newEntryDescription}`);
  lines.push(`- body:`);
  lines.push(input.newEntryBody.slice(0, 2000));
  lines.push(``);
  lines.push(`## Nearest existing entries (by description keyword overlap)`);
  for (const c of input.candidates) {
    lines.push(`- ${c.path} — ${c.description}`);
  }
  lines.push(``);
  lines.push(
    `Output: at most one upsert op that updates the NEW entry (path = "${input.newEntryPath}") with appropriate \`supersedes\` and/or \`related\` fields. Preserve the original description and body verbatim (we'll fold your fields into the existing record). If no clear relationship: return \`operations: []\`.`,
  );
  return lines.join("\n");
}

/**
 * Helper for upsertMemory to decide whether the new entry shape is
 * eligible for an A-MEM link pass. Only typed entries qualify;
 * cheatsheet and scratchpad are pinned shapes that aren't part of
 * the linkable graph.
 */
export function isAmemEligible(virtualPath: string): boolean {
  try {
    const parsed = parseMemoryPath(virtualPath);
    return parsed.kind === "typed";
  } catch {
    return false;
  }
}
