import { describe, expect, test } from "bun:test";

import { isBun, wrapBetterSqlite } from "./sqlite";

// NOTE: Bun refuses to load the `better-sqlite3` native addon ("not yet
// supported in Bun"), so we cannot exercise the REAL driver here — and we
// don't need to: under Bun the conditional loader never reaches
// better-sqlite3 (it uses bun:sqlite). What we DO unit-test is the adapter's
// translation logic — the two API shims that bridge better-sqlite3 to the
// bun:sqlite raw surface — against a recording fake. The real better-sqlite3
// integration is covered by the Node smoke test (Step 4) under actual Node.

interface FakeCall {
  op: string;
  sql?: string;
  params?: unknown[];
}

function makeFakeBetterSqlite() {
  const calls: FakeCall[] = [];
  const stmt = (sql: string) => ({
    run: (...params: unknown[]) => {
      calls.push({ op: "stmt.run", sql, params });
      return { changes: 1 };
    },
    get: (...params: unknown[]) => {
      calls.push({ op: "stmt.get", sql, params });
      return { sql, params };
    },
    all: (...params: unknown[]) => {
      calls.push({ op: "stmt.all", sql, params });
      return [{ sql, params }];
    },
  });
  const db = {
    calls,
    prepare: (sql: string) => {
      calls.push({ op: "prepare", sql });
      return stmt(sql);
    },
    exec: (sql: string) => {
      calls.push({ op: "exec", sql });
    },
    transaction: (fn: (...a: unknown[]) => unknown) => {
      const wrapped = (...a: unknown[]) => {
        calls.push({ op: "txn.run" });
        return fn(...a);
      };
      return wrapped;
    },
    close: () => {
      calls.push({ op: "close" });
    },
  };
  // The fake structurally matches what wrapBetterSqlite consumes; cast
  // through the parameter type (its generic `transaction` overload doesn't
  // unify with the fake's concrete signature) while keeping `.calls` typed.
  return db as unknown as Parameters<typeof wrapBetterSqlite>[0] & { calls: FakeCall[] };
}

describe("platform/sqlite", () => {
  test("isBun is true under the bun test runner", () => {
    expect(isBun).toBe(true);
  });

  describe("wrapBetterSqlite — shims better-sqlite3 to the bun:sqlite raw surface", () => {
    test("query(sql) is shimmed to prepare(sql) (bun-only .query method)", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      const row = raw.query("SELECT 1").get();
      expect(fake.calls).toContainEqual({ op: "prepare", sql: "SELECT 1" });
      expect(fake.calls).toContainEqual({ op: "stmt.get", sql: "SELECT 1", params: [] });
      expect(row).toEqual({ sql: "SELECT 1", params: [] });
    });

    test("db-level run(sql, params) is shimmed to prepare(sql).run(...params)", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      raw.run("INSERT INTO t VALUES (?, ?)", ["a", 2]);
      expect(fake.calls).toContainEqual({ op: "prepare", sql: "INSERT INTO t VALUES (?, ?)" });
      // critical: array params must be SPREAD into stmt.run, not passed as one arg
      expect(fake.calls).toContainEqual({
        op: "stmt.run",
        sql: "INSERT INTO t VALUES (?, ?)",
        params: ["a", 2],
      });
    });

    test("db-level run(sql) with no params spreads to zero args", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      raw.run("DELETE FROM t");
      expect(fake.calls).toContainEqual({ op: "stmt.run", sql: "DELETE FROM t", params: [] });
    });

    test("prepare().all(...params) passes through with spread params", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      const rows = raw.prepare("SELECT * FROM t WHERE n > ?").all(0);
      expect(fake.calls).toContainEqual({ op: "stmt.all", sql: "SELECT * FROM t WHERE n > ?", params: [0] });
      expect(rows).toEqual([{ sql: "SELECT * FROM t WHERE n > ?", params: [0] }]);
    });

    test("exec passes through", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      raw.exec("PRAGMA journal_mode = WAL");
      expect(fake.calls).toContainEqual({ op: "exec", sql: "PRAGMA journal_mode = WAL" });
    });

    test("transaction(fn) returns a callable wrapper (bun:sqlite/better-sqlite3 shared semantics)", () => {
      const fake = makeFakeBetterSqlite();
      const raw = wrapBetterSqlite(fake);
      let ran = false;
      const txn = raw.transaction(() => {
        ran = true;
      });
      expect(ran).toBe(false); // not executed until called
      txn();
      expect(ran).toBe(true);
      expect(fake.calls).toContainEqual({ op: "txn.run" });
    });
  });
});
