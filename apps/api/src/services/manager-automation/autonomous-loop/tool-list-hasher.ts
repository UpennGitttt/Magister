import { createHash } from "node:crypto";

import { z } from "zod";

import type { LeaderTool } from "./autonomous-types";

/**
 * Spec §4.5 — content-hash short-circuit for the per-turn tool-list
 * reload path.
 *
 * Anthropic's prompt cache prefix covers both `system` and `tools`.
 * A naive per-turn re-query of the tool list would routinely produce
 * byte-different `tools` payloads (DB ordering drift, JSON field
 * ordering, MCP reconnect re-emitting same-schema-with-different-
 * memory) and invalidate the cache every turn — turning cache_read
 * (~0.1× cost) into cache_creation (~1.25× cost) per turn.
 *
 * `hashToolsList` produces a deterministic content hash. When the
 * hash matches the previous turn's, the loop reuses the old
 * `LeaderTool[]` reference verbatim → the bytes sent to the
 * provider are byte-identical → cache stays warm.
 *
 * Hashing strategy:
 *   1. Sort entries by tool name (kills DB-query-order drift).
 *   2. Strip to wire-bearing fields only — name, description,
 *      input schema (kills internal-representation drift such as
 *      `isConcurrencySafe` lambda identity that doesn't reach the
 *      provider).
 *   3. Stable JSON serialization with sorted object keys (kills
 *      JSON.stringify key-ordering drift between Node versions).
 *   4. sha256 hex digest, first 16 chars (collision-proof for our
 *      input space; short enough to log).
 */
export function hashToolsList(tools: readonly LeaderTool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = sorted.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    // The schema actually sent on the wire — when no override is
    // supplied, the provider plugins derive it from the Zod schema
    // via `z.toJSONSchema(tool.inputSchema)` (anthropic-plugin.ts /
    // openai-compat-plugin.ts convertTools). Without this fallback
    // the hash would collapse two tools that differ ONLY in their
    // Zod schema to the same value, defeating the short-circuit's
    // correctness guarantee.
    schema: t.inputJsonSchemaOverride ?? deriveJsonSchema(t.inputSchema),
  }));
  return createHash("sha256").update(stableStringify(canonical)).digest("hex").slice(0, 16);
}

function deriveJsonSchema(zodSchema: LeaderTool["inputSchema"]): unknown {
  try {
    return z.toJSONSchema(zodSchema as z.ZodTypeAny);
  } catch {
    // Schema introspection failure (custom Zod types, transformed
    // schemas, etc.). Treat as a stable opaque value rather than
    // throwing — the hash is best-effort; a stable fallback string
    // keeps determinism.
    return { __unhashable: true };
  }
}

/**
 * Compute added / removed tool names between two tool lists. Returns
 * empty arrays when the lists are identical by name. Order doesn't
 * matter.
 */
export function computeToolListDiff(
  previous: readonly LeaderTool[],
  next: readonly LeaderTool[],
): { added: string[]; removed: string[] } {
  const prevNames = new Set(previous.map((t) => t.name));
  const nextNames = new Set(next.map((t) => t.name));
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of nextNames) {
    if (!prevNames.has(name)) added.push(name);
  }
  for (const name of prevNames) {
    if (!nextNames.has(name)) removed.push(name);
  }
  return { added: added.sort(), removed: removed.sort() };
}

/**
 * JSON.stringify with deterministically-sorted object keys at every
 * depth. Required because Node's default JSON.stringify preserves
 * insertion order, which can drift across rebuilds / DB row reorders
 * even when content is semantically identical.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
