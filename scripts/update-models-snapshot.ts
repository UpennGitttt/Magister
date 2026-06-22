#!/usr/bin/env bun
/**
 * Refresh the committed models.dev catalog snapshot.
 *
 *   bun run scripts/update-models-snapshot.ts
 *
 * Fetches https://models.dev/api.json and writes it (atomically) to
 * config/model-catalog/models-snapshot.json. The snapshot is git-tracked and
 * serves as the offline source for `model-catalog-service` (Phase 1 is
 * snapshot-only; no runtime network fetch). Run this manually or in CI to keep
 * model metadata fresh. See docs/plans/2026-06-08-model-catalog-provider-ux.md.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOURCE = process.env.MAGISTER_MODELS_URL?.trim() || "https://models.dev/api.json";
const OUT = join(process.cwd(), "config", "model-catalog", "models-snapshot.json");

async function main() {
  console.log(`[update-models-snapshot] fetching ${SOURCE}`);
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const text = await res.text();

  // Validate it parses and looks like a provider map before persisting.
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const providerCount = Object.keys(parsed).length;
  if (providerCount === 0) throw new Error("catalog is empty — refusing to overwrite snapshot");

  await mkdir(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, OUT); // atomic
  console.log(`[update-models-snapshot] wrote ${providerCount} providers -> ${OUT} (${text.length} bytes)`);
}

main().catch((err) => {
  console.error("[update-models-snapshot] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
