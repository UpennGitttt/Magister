/**
 * Tiny `{{ var }}` template renderer for goal-mode prompts.
 *
 * Each prompt variant lives in its own .md file, the call site picks
 * one and passes vars. Compared to the previous monolithic
 * `buildGoalContinuationV2` function this:
 *
 *   1. lets reviewers diff each prompt variant in isolation
 *   2. keeps prompt text as plain markdown (no JS string concat noise)
 *   3. gives each goal-state (normal / budget-exhausted / objective-
 *      edited) its own focused prompt instead of a single function
 *      branching on flags.
 *
 * The renderer intentionally stays minimal: no nested vars, no
 * conditionals, no loops, no escape modes. The caller is responsible
 * for XML/HTML-escaping anything that needs it (see escape-xml.ts).
 * Unknown placeholders are left as-is (so reviewers can grep for
 * `{{` in rendered output to find them) — this also matters when a
 * placeholder happens to literally be the value the user wants.
 *
 * Templates are loaded lazily on first use and cached for the process
 * lifetime. v3 spec §P1-6.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type TemplateName = "continuation" | "budget_limit" | "objective_updated";

const PROMPTS_DIR = join(import.meta.dirname, "prompts");
const cache = new Map<TemplateName, string>();

function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const path = join(PROMPTS_DIR, `${name}.md`);
  const body = readFileSync(path, "utf-8");
  cache.set(name, body);
  return body;
}

export function renderTemplate(
  name: TemplateName,
  vars: Record<string, string>,
): string {
  const body = loadTemplate(name);
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value !== undefined ? value : match;
  });
}

/** Test-only: drop the cache so a test can mutate templates on disk
 *  and re-load. Not exported in the production import path. */
export function _resetTemplateCacheForTest(): void {
  cache.clear();
}
