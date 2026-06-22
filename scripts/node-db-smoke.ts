/**
 * Node-path smoke for the SQLite portability seam (Step 2 validation).
 * Run under stock Node via tsx: `node_modules/.bin/tsx scripts/node-db-smoke.ts`
 *
 * Validates the runtime traps codex flagged:
 *  - conditional driver + drizzle adapter load (better-sqlite3 on Node)
 *  - `import.meta.url` migration-path resolution (the old import.meta.dir)
 *  - better-sqlite3 ships FTS5 (bm25) — risk R3
 *  - the wrapBetterSqlite `.query` / db-level `.run(sql, params)` shims
 */
import { rmSync } from "node:fs";

import { eq } from "drizzle-orm";

const dbPath = "/tmp/magister-node-db-smoke.sqlite";
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
process.env.MAGISTER_DB_PATH = dbPath;

const { createDb, getRawSqlite } = await import("../packages/db/src/client");
const { workspaces } = await import("../packages/db/src/schema");
const { isBun } = await import("../packages/db/src/platform/sqlite");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("SMOKE FAIL: " + msg);
}

assert(isBun === false, "expected isBun=false under Node/tsx, got " + isBun);

// 1) createDb() — conditional load (better-sqlite3 + drizzle/better-sqlite3)
//    + bootstrap migration via import.meta.url path resolution.
const db = createDb();
console.log("[1] createDb() ok (better-sqlite3 + drizzle adapter loaded, migrations ran)");

// 2) drizzle query through the better-sqlite3 adapter — the bootstrap seeds
//    a default workspace, so this must return >= 1 row.
const ws = db.select().from(workspaces).all();
assert(ws.length >= 1, "expected seeded default workspace, got " + ws.length);
console.log("[2] drizzle/better-sqlite3 select ok (" + ws.length + " workspace rows)");

// 3) getRawSqlite() + FTS5 bm25 (proves better-sqlite3 ships FTS5).
const raw = getRawSqlite();
raw.exec(
  "INSERT INTO memory_search (path, scope, type, description, body) VALUES ('p1','user','feedback','hello world','some body text')",
);
const fts = raw
  .prepare("SELECT path, bm25(memory_search) AS score FROM memory_search WHERE memory_search MATCH ? ORDER BY score")
  .all("hello");
assert(fts.length === 1, "expected 1 FTS5 match, got " + fts.length);
console.log("[3] getRawSqlite() + FTS5 bm25() ok (" + fts.length + " match)");

// 4) wrapBetterSqlite shims: db-level run(sql, params) + query(sql).get().
raw.run("INSERT INTO memory_search (path, scope, type, description, body) VALUES (?,?,?,?,?)", [
  "p2",
  "user",
  "feedback",
  "second entry",
  "more body",
]);
const cnt = raw.query("SELECT COUNT(*) AS n FROM memory_search").get() as { n: number };
assert(cnt.n === 2, "expected 2 rows after run() shim, got " + cnt.n);
console.log("[4] wrapBetterSqlite run(sql,params) + query().get() shims ok (" + cnt.n + " rows)");

for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
console.log("NODE_SMOKE_OK");
