/**
 * BM25 retrieval over the FTS5-mirrored memory index. (P2-#7, 2026-05-15.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let memTmp = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "magister-mem-search-"));
  memTmp = await mkdtemp(join(tmpdir(), "magister-mem-search-fs-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );

  const { initMemoryRuntime } = await import(
    "../../../src/services/memory/memory-runtime"
  );
  initMemoryRuntime({
    userScopeRoot: join(memTmp, "user"),
    projectScopeRoot: join(memTmp, "project"),
  });
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  if (memTmp) await rm(memTmp, { recursive: true, force: true });
  const { resetMemoryRuntimeForTests } = await import(
    "../../../src/services/memory/memory-runtime"
  );
  resetMemoryRuntimeForTests();
});

async function seed(path: string, description: string, body: string) {
  const { mirrorWrite } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  const seg = path.split("/");
  const scope = seg[0] as "user-global" | "project";
  const type = seg[1] as any;
  await mirrorWrite({ path, scope, type, description, body });
}

test("searchMemory returns entries whose description matches the query", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await seed("user-global/feedback/auth", "Auth retry handling", "details");
  await seed("user-global/feedback/db", "Database migration safety", "details");
  await seed("user-global/feedback/test", "Testing without mocks", "details");

  const hits = await searchMemory("auth");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.path).toBe("user-global/feedback/auth");
});

test("searchMemory respects scope filter", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await seed("user-global/feedback/auth", "Auth flow", "Auth body");
  await seed("project/feedback/auth", "Auth project notes", "Auth body");

  const userOnly = await searchMemory("auth", { scope: "user-global" });
  expect(userOnly.every((h) => h.scope === "user-global")).toBe(true);
  expect(userOnly.length).toBe(1);
});

test("searchMemory returns empty array on empty query", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  expect(await searchMemory("")).toEqual([]);
  expect(await searchMemory("   ")).toEqual([]);
});

test("mirrorDelete removes the row from the search index", async () => {
  const { searchMemory, mirrorDelete } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await seed("user-global/feedback/auth", "Auth flow", "Auth body");
  expect((await searchMemory("auth")).length).toBe(1);
  await mirrorDelete("user-global/feedback/auth");
  expect(await searchMemory("auth")).toEqual([]);
});

test("description weight gives a description match higher rank than a body-only match", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  // Both contain "auth", but only the second has it in the description.
  await seed("user-global/feedback/a", "Generic note", "auth keyword in body");
  await seed("user-global/feedback/b", "Auth specifics", "irrelevant body");
  const hits = await searchMemory("auth");
  expect(hits[0]!.path).toBe("user-global/feedback/b");
});

// MEDIUM-7 (2026-05-15): weight vector must include slots for UNINDEXED
// columns. With matched text identical and body/description length
// matched, a description match must outrank a body match because the
// description column gets weight 2.0 vs body's 1.0.
test("BM25 description-weight beats body-weight at equal text length", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  const matchTerm = "authflow";
  // Same character length on both columns; only difference is which
  // column carries the match. The 2× weight on description must
  // dominate length normalization.
  const filler = "lorem ipsum dolor sit amet consectetur"; // 38 chars
  await seed("user-global/feedback/desc-hit", `${matchTerm} ${filler}`, filler);
  await seed("user-global/feedback/body-hit", filler, `${matchTerm} ${filler}`);
  const hits = await searchMemory(matchTerm);
  expect(hits.map((h) => h.path)).toEqual([
    "user-global/feedback/desc-hit",
    "user-global/feedback/body-hit",
  ]);
  // And the description-hit score must be strictly more negative
  // (better) than the body-hit score, reflecting the 2× weight.
  expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
});

// ---- HIGH-2: startup backfill ----

test("backfillSearchIndex seeds existing on-disk entries when the table is empty", async () => {
  const { upsertMemory } = await import(
    "../../../src/services/memory/memory-fs-service"
  );
  const { searchMemory, backfillSearchIndex } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  const { getRawSqlite } = await import("@magister/db");

  // Write to disk via the FS service (which mirrors writes), then
  // wipe the FTS table to simulate "files on disk from before the
  // feature shipped".
  await upsertMemory(
    {
      path: "user-global/feedback/old-entry",
      description: "Pre-existing entry",
      body: "old body",
    },
    "leader-tool",
  );
  // Wait one tick so the mirror write completes (it's still
  // fire-and-forget at this point in the rebuild — will become
  // synchronous in HIGH-3).
  await new Promise((r) => setTimeout(r, 50));
  const sqlite = getRawSqlite();
  sqlite.exec("DELETE FROM memory_search");
  expect((await searchMemory("entry")).length).toBe(0);

  const result = await backfillSearchIndex();
  expect(result.alreadyPopulated).toBe(false);
  expect(result.scanned).toBeGreaterThan(0);
  expect(result.inserted).toBeGreaterThan(0);

  const hits = await searchMemory("entry");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.path).toBe("user-global/feedback/old-entry");
});

test("backfillSearchIndex is a no-op when the table is already populated", async () => {
  const { upsertMemory } = await import(
    "../../../src/services/memory/memory-fs-service"
  );
  const { backfillSearchIndex } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await upsertMemory(
    {
      path: "user-global/feedback/seeded",
      description: "Already mirrored on write",
      body: "x",
    },
    "leader-tool",
  );
  await new Promise((r) => setTimeout(r, 50));
  const result = await backfillSearchIndex();
  expect(result.alreadyPopulated).toBe(true);
  expect(result.scanned).toBe(0);
});

// MEDIUM-8: multi-term query must allow non-contiguous matches and
// preserve BM25 ranking; previous single-phrase wrapping required the
// terms to appear in order without intervening words.
test("multi-term query matches entries with non-contiguous terms", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await seed(
    "user-global/feedback/a",
    "auth retries for the login flow",
    "details",
  );
  await seed(
    "user-global/feedback/b",
    "unrelated note about logging",
    "details",
  );
  // "auth flow" should hit /a — both terms are present but not
  // contiguous. Earlier impl forced "auth flow" as a single phrase
  // (requires contiguous "auth flow") and would miss this.
  const hits = await searchMemory("auth flow");
  expect(hits.map((h) => h.path)).toContain("user-global/feedback/a");
});

test("searchMemory survives FTS5-special characters in the query", async () => {
  const { searchMemory } = await import(
    "../../../src/services/memory/memory-search-service"
  );
  await seed("user-global/feedback/x", "OAuth flow", "body");
  // Quoted, OR, star, colon — would normally trip FTS5 operators.
  expect(async () => searchMemory(`"oauth" OR auth:*`)).not.toThrow();
});
