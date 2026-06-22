/**
 * F4 atomicity test — WorkspaceRepository.setDefault must be a single
 * atomic transaction. The default-row invariant (exactly one is_default=1)
 * is application-enforced; setDefault clears every other default then sets
 * the target. If those two UPDATEs are NOT atomic, a mid-transaction abort
 * leaves the table with ZERO defaults.
 *
 * Strategy: a BEFORE UPDATE trigger that RAISE(ABORT)s on the target's
 * 0→1 default flip (the second UPDATE). With a real transaction the first
 * UPDATE (clear) rolls back too, so the original default survives. With the
 * pre-fix `db.transaction(async cb)` (a no-op on bun-sqlite — commits before
 * the awaited writes), the clear would already be committed → zero defaults.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ws-setdefault-atomicity-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("setDefault rolls back the default-clear when the set aborts (atomicity)", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const { getRawSqlite } = await import("@magister/db");
  const repo = new WorkspaceRepository();

  // workspace_main is the seeded default. Add a second, non-default ws.
  await repo.create({ id: "beta", label: "Beta", basePath: join(tempDir, "beta") });
  expect((await repo.getDefault())?.id).toBe("workspace_main");

  // Trigger: abort any UPDATE that flips a row's default 0 → 1.
  // setDefault("beta") does: clear (workspace_main 1→0), then set (beta 0→1).
  // The set fires this trigger and aborts.
  const sqlite = getRawSqlite();
  sqlite.exec(`
    CREATE TRIGGER abort_set_default BEFORE UPDATE ON workspaces
    WHEN NEW.is_default = 1 AND OLD.is_default = 0
    BEGIN SELECT RAISE(ABORT, 'atomicity-probe'); END;
  `);

  await expect(repo.setDefault("beta")).rejects.toThrow();

  // The clear-update must have rolled back: exactly ONE default, still main.
  sqlite.exec("DROP TRIGGER abort_set_default");
  const all = await repo.listAll();
  const defaults = all.filter((w) => w.isDefault);
  expect(defaults.length).toBe(1);
  expect(defaults[0]?.id).toBe("workspace_main");
});
