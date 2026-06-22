/**
 * M5 P2-#7 (2026-05-15): BM25 retrieval over the FTS5-mirrored memory
 * index. SQLite's FTS5 ships in bun:sqlite; `bm25()` is its built-in
 * scorer (smaller = better match).
 *
 * Why this exists: without ranking, the leader has to "browse" the
 * typed-entry index by reading every line in the `<memories>` block.
 * That's fine at 30 entries but becomes prompt noise at 300+ and
 * makes targeted recall ("did the user say anything about X?")
 * O(N) on the model's attention. With BM25 the model can call
 * `search_memory(query)` and get the top-k relevant entries by
 * description+body match.
 *
 * Scope / type filters are applied AFTER the BM25 match, not as
 * extra MATCH terms, so a query like "auth" returns the same ranking
 * whether you filter to project or user-global.
 *
 * Mirror lifecycle:
 *   - `mirrorWrite(path, ...)` inserts/replaces the row
 *   - `mirrorDelete(path)` drops the row
 *   - Called best-effort from `memory-fs-service` after on-disk
 *     atomicWrite / unlink succeed. The on-disk store is
 *     authoritative; mirror failure is logged + non-fatal.
 *   - The aging sweeper does NOT touch this mirror (its writes are
 *     metadata-only — aging flag, codeChanged — that don't change
 *     searchable text).
 */
import { getRawSqlite } from "@magister/db";
import { memoryLog } from "./memory-log";
import type { MemoryScope, MemoryType } from "./memory-types";

export interface MemorySearchHit {
  path: string;
  scope: MemoryScope;
  type: MemoryType;
  /** Snippet of the description with the matched span highlighted. */
  descriptionSnippet: string;
  /** BM25 score; smaller is a stronger match (FTS5 convention). */
  score: number;
}

export interface MemorySearchOptions {
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function searchMemory(
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
  );
  // MEDIUM-8 (2026-05-15 follow-up): tokenize the input and wrap each
  // token as its own FTS5 phrase, joined by spaces (implicit AND).
  // This preserves BM25's multi-term scoring — earlier version
  // wrapped the whole query in a single phrase quote, which forced
  // every word to appear contiguously in that exact order, defeating
  // BM25 ranking on natural multi-word queries like "auth flow".
  //
  // Per-token phrase quoting still blocks FTS5 operator injection
  // (AND/OR/NOT/NEAR/*/:) and prefix-glob abuse — inside a quoted
  // phrase, FTS5 treats everything literally except `"` (escaped by
  // doubling). Tokens are split on whitespace and any non-alphanumeric
  // character; empty tokens after split are dropped.
  const tokens = trimmed
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const safeQuery = tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  try {
    const sqlite = getRawSqlite();
    // MEDIUM-7 (2026-05-15 follow-up): FTS5's bm25() weight vector
    // is indexed by column declaration order across ALL columns,
    // INCLUDING UNINDEXED ones. The schema is:
    //   path(UNINDEXED), scope(UNINDEXED), type(UNINDEXED), description, body
    // So we need five weights. UNINDEXED columns contribute nothing
    // to the score regardless of their weight, but we must take up
    // their positional slots; description (col 3) is then 2.0 and
    // body (col 4) is 1.0 — the actual hand-vs-body emphasis we
    // want. Earlier version passed only `(2.0, 1.0)` which silently
    // landed on `path` and `scope` and left description/body at
    // their default 1.0/1.0.
    let sql =
      "SELECT path, scope, type, snippet(memory_search, 3, '«', '»', '…', 16) AS desc_snippet, bm25(memory_search, 1.0, 1.0, 1.0, 2.0, 1.0) AS score FROM memory_search WHERE memory_search MATCH ?";
    const params: unknown[] = [safeQuery];
    if (options.scope) {
      sql += " AND scope = ?";
      params.push(options.scope);
    }
    if (options.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }
    sql += " ORDER BY score LIMIT ?";
    params.push(limit);
    const rows = sqlite.prepare(sql).all(...(params as any[])) as Array<{
      path: string;
      scope: string;
      type: string;
      desc_snippet: string;
      score: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      scope: r.scope as MemoryScope,
      type: r.type as MemoryType,
      descriptionSnippet: r.desc_snippet,
      score: r.score,
    }));
  } catch (err) {
    memoryLog.warn("memory-search-failed", {
      query: trimmed.slice(0, 100),
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function mirrorWrite(input: {
  path: string;
  scope: MemoryScope;
  type: MemoryType;
  description: string;
  body: string;
}): Promise<void> {
  try {
    const sqlite = getRawSqlite();
    // Idempotent upsert: FTS5 doesn't support `ON CONFLICT DO UPDATE`,
    // so we delete-then-insert. Both ops are in a single transaction
    // so a concurrent read never sees the path missing entirely.
    sqlite.transaction(() => {
      sqlite
        .prepare("DELETE FROM memory_search WHERE path = ?")
        .run(input.path);
      sqlite
        .prepare(
          "INSERT INTO memory_search (path, scope, type, description, body) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.path,
          input.scope,
          input.type,
          input.description,
          input.body,
        );
    })();
  } catch (err) {
    memoryLog.warn("memory-search-mirror-write-failed", {
      path: input.path,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * HIGH-2 (2026-05-15 follow-up): seed memory_search from on-disk
 * memory files when the FTS table is empty. Without this, memory
 * files that existed before the table was created are invisible to
 * `search_memory` until each one gets individually re-upserted.
 *
 * Called once at server startup AFTER `initMemoryRuntime` so
 * `listMemory()` knows where to scan. Idempotent — only runs the
 * seed pass if the table is empty (subsequent boots see populated
 * rows and skip the work).
 *
 * Best-effort: per-entry failures don't abort the loop; the table
 * may end up partially populated, which is fine — the next manual
 * upsert of a missing entry will fill it in.
 */
export async function backfillSearchIndex(): Promise<{
  scanned: number;
  inserted: number;
  alreadyPopulated: boolean;
}> {
  try {
    const sqlite = getRawSqlite();
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM memory_search")
      .get() as { n: number } | undefined;
    if (row && row.n > 0) {
      return { scanned: 0, inserted: 0, alreadyPopulated: true };
    }
    const { listMemory } = await import("./memory-fs-service");
    const listing = await listMemory();
    let scanned = 0;
    let inserted = 0;
    for (const scope of ["user-global", "project"] as MemoryScope[]) {
      for (const entry of listing[scope]) {
        scanned++;
        try {
          await mirrorWrite({
            path: entry.path,
            scope: entry.scope,
            type: entry.type,
            description: entry.frontmatter.description,
            body: entry.body,
          });
          inserted++;
        } catch (err) {
          memoryLog.warn("backfill-entry-failed", {
            path: entry.path,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    memoryLog.info("memory-search-backfill", { scanned, inserted });
    return { scanned, inserted, alreadyPopulated: false };
  } catch (err) {
    memoryLog.warn("memory-search-backfill-failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { scanned: 0, inserted: 0, alreadyPopulated: false };
  }
}

export async function mirrorDelete(path: string): Promise<void> {
  try {
    const sqlite = getRawSqlite();
    sqlite.prepare("DELETE FROM memory_search WHERE path = ?").run(path);
  } catch (err) {
    memoryLog.warn("memory-search-mirror-delete-failed", {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
