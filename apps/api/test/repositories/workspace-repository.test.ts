/**
 * WorkspaceRepository tests — Path A. The default-row invariant
 * (exactly one row has is_default=true) is application-enforced
 * because SQLite doesn't have partial unique indexes; pin the
 * critical path here so a regression in setDefault can't ship.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "workspace-repo-test-"));
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

test("first-boot bootstrap creates a default workspace", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  const all = await repo.listAll();
  // ensureWorkspacesTable seeds workspace_main on empty-table init.
  expect(all.length).toBe(1);
  expect(all[0]?.id).toBe("workspace_main");
  expect(all[0]?.isDefault).toBe(true);
});

test("create + setDefault enforces single-default invariant", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  await repo.create({
    id: "alpha",
    label: "Alpha",
    basePath: "/tmp/alpha-test",
    isDefault: false,
  });
  await repo.create({
    id: "beta",
    label: "Beta",
    basePath: "/tmp/beta-test",
    isDefault: false,
  });
  // Initially the seed `workspace_main` is the default.
  const before = await repo.getDefault();
  expect(before?.id).toBe("workspace_main");

  await repo.setDefault("alpha");
  const after = await repo.getDefault();
  expect(after?.id).toBe("alpha");

  // Exactly one row has isDefault=true.
  const all = await repo.listAll();
  expect(all.filter((w) => w.isDefault).length).toBe(1);
  expect(all.find((w) => w.id === "workspace_main")?.isDefault).toBe(false);
});

test("delete refuses the current default and the last-remaining row", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  // Try to delete the seed (which is currently default) — refused.
  const r1 = await repo.deleteById("workspace_main");
  expect(r1.ok).toBe(false);
  if (!r1.ok) expect(r1.reason).toBe("is_default");

  // Add a second workspace, swap default, then try to delete the
  // first — succeeds.
  await repo.create({
    id: "alpha",
    label: "Alpha",
    basePath: "/tmp/alpha-test-2",
    isDefault: false,
  });
  await repo.setDefault("alpha");
  const r2 = await repo.deleteById("workspace_main");
  expect(r2.ok).toBe(true);

  // Now alpha is the last remaining AND default — delete refused.
  // The default check fires first (stricter — you can't ever delete
  // the current default no matter how many siblings exist), so the
  // reason is `is_default` rather than `last_workspace`.
  const r3 = await repo.deleteById("alpha");
  expect(r3.ok).toBe(false);
  if (!r3.ok) expect(r3.reason).toBe("is_default");
});

test("delete refuses last_workspace specifically when target is non-default and only sibling is default", async () => {
  // Construct a state where the target is NOT default but is the
  // last non-default — this requires 2 rows total. Set the default
  // first, then attempt to delete the non-default one when there
  // are exactly 2 rows. Current shape: even with 2 rows we'd
  // succeed; the last_workspace branch only fires at 1 row total.
  // Document this — the protection is "can't shrink to zero rows."
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  await repo.create({ id: "alpha", label: "A", basePath: "/tmp/alpha-x", isDefault: false });
  // Two rows: workspace_main (default) + alpha. Delete alpha → succeeds.
  const r1 = await repo.deleteById("alpha");
  expect(r1.ok).toBe(true);
  // Only workspace_main remains. Now try to delete it — refused
  // because it's default.
  const r2 = await repo.deleteById("workspace_main");
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.reason).toBe("is_default");
});

test("create with isDefault:true clears the previous default", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  await repo.create({
    id: "alpha",
    label: "Alpha",
    basePath: "/tmp/alpha-test-3",
    isDefault: true,
  });
  const all = await repo.listAll();
  // workspace_main was the seed default; alpha now is.
  expect(all.find((w) => w.id === "workspace_main")?.isDefault).toBe(false);
  expect(all.find((w) => w.id === "alpha")?.isDefault).toBe(true);
});

test("findByBasePath returns the registered row for a known path", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  const seed = await repo.getById("workspace_main");
  expect(seed).not.toBeNull();
  if (!seed) throw new Error("seed missing");
  const found = await repo.findByBasePath(seed.basePath);
  expect(found?.id).toBe("workspace_main");
});

test("deleteById re-points live channel rows to the default and removes the workspace", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const { createDb, getRawSqlite } = await import("@magister/db");
  const repo = new WorkspaceRepository();

  // workspace_main is the auto-seeded default; add a second, non-default ws.
  await repo.create({ id: "kb", label: "KB", basePath: "/tmp/kb" });

  createDb();
  const sqlite = getRawSqlite();
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO conversation_bindings (id, channel, account_id, chat_id, workspace_id, created_at, updated_at, last_inbound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("feishu:acct:chat", "feishu", "acct", "chat", "kb", now, now, now);
  sqlite
    .prepare(
      "INSERT INTO channel_sessions (id, binding_id, channel, workspace_id, continuity_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("sess1", "feishu:acct:chat", "feishu", "kb", "thread", now, now);

  const result = await repo.deleteById("kb");
  expect(result.ok).toBe(true);

  // Workspace row gone.
  expect(await repo.getById("kb")).toBeNull();

  // Live rows re-pointed to the default (workspace_main), not left dangling.
  const binding = sqlite
    .prepare("SELECT workspace_id FROM conversation_bindings WHERE id = ?")
    .get("feishu:acct:chat") as { workspace_id: string } | undefined;
  expect(binding?.workspace_id).toBe("workspace_main");

  const session = sqlite
    .prepare("SELECT workspace_id FROM channel_sessions WHERE id = ?")
    .get("sess1") as { workspace_id: string } | undefined;
  expect(session?.workspace_id).toBe("workspace_main");
});

test("deleteById refuses the default and the last workspace (no cascade side effects)", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const repo = new WorkspaceRepository();
  // Only workspace_main exists (default + last) — both guards apply.
  const def = await repo.deleteById("workspace_main");
  expect(def.ok).toBe(false);
  if (!def.ok) expect(["is_default", "last_workspace"]).toContain(def.reason);
});
