import { createRequire } from "node:module";

/**
 * Runtime-portable SQLite seam — "Bun-first, Node-capable".
 *
 * Under Bun we use the built-in `bun:sqlite` + `drizzle-orm/bun-sqlite`.
 * Under stock Node we use `better-sqlite3` + `drizzle-orm/better-sqlite3`.
 *
 * Both the driver AND the drizzle adapter are loaded conditionally by
 * COMPUTED module name via `createRequire`, so neither runtime's static
 * resolver ever tries to resolve the other runtime's module (Bun does not
 * support the `better-sqlite3` native addon at all; Node cannot resolve the
 * `bun:sqlite` builtin). DB construction stays synchronous, which the rest
 * of the codebase depends on.
 *
 * See docs/plans/2026-06-02-runtime-portability.md.
 */

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const require_ = createRequire(import.meta.url);

/**
 * Prepared-statement surface shared by bun:sqlite and better-sqlite3.
 * `get`/`all`/`run` return `any` to match bun:sqlite's existing ergonomics —
 * raw SQL rows are dynamically shaped and callers cast at the use site.
 */
export interface RawStatement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...params: unknown[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(...params: unknown[]): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(...params: unknown[]): any;
}

/**
 * The raw-handle surface our `getRawSqlite()` consumers and the bootstrap
 * migrations in client.ts depend on. bun:sqlite's `Database` satisfies this
 * structurally; better-sqlite3 is bridged via {@link wrapBetterSqlite}.
 */
export interface RawSqlite {
  prepare(sql: string): RawStatement;
  /** bun:sqlite-only convenience (cached prepared statement). */
  query(sql: string): RawStatement;
  /** DB-level parameterised run (bun:sqlite-only convenience). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(sql: string, params?: unknown[]): any;
  exec(sql: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

/** Minimal better-sqlite3 `Database` shape we rely on. */
interface BetterSqliteDb {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

/**
 * Bridge a better-sqlite3 `Database` to the {@link RawSqlite} surface. The
 * only two gaps vs bun:sqlite are the `.query()` convenience method and the
 * DB-level `.run(sql, params)` form — both shimmed onto `.prepare()`.
 * better-sqlite3 caches prepared statements internally, so `query → prepare`
 * carries no measurable cost.
 */
export function wrapBetterSqlite(db: BetterSqliteDb): RawSqlite {
  return {
    prepare: (sql) => db.prepare(sql),
    query: (sql) => db.prepare(sql),
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

/**
 * Open a native SQLite handle for the current runtime and return both the
 * native handle (for the matching drizzle adapter) and a portable
 * {@link RawSqlite} view (for getRawSqlite + bootstrap migrations).
 */
export function openSqlite(path: string): { native: unknown; raw: RawSqlite } {
  if (isBun) {
    const { Database } = require_("bun:sqlite") as { Database: new (p: string) => RawSqlite };
    const native = new Database(path);
    // bun:sqlite's Database already satisfies RawSqlite structurally.
    return { native, raw: native };
  }
  const Database = require_("better-sqlite3") as new (p: string) => BetterSqliteDb;
  const native = new Database(path);
  return { native, raw: wrapBetterSqlite(native) };
}

/**
 * Build a drizzle handle over the native sqlite handle using the adapter
 * matching the current runtime. `schema` is passed in to avoid coupling this
 * module to the schema definition.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDrizzle(native: unknown, schema: Record<string, unknown>): any {
  const drizzle = (
    isBun
      ? require_("drizzle-orm/bun-sqlite")
      : require_("drizzle-orm/better-sqlite3")
  ).drizzle as (n: unknown, opts: { schema: Record<string, unknown> }) => unknown;
  return drizzle(native, { schema });
}
