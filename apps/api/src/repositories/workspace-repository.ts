import { eq, ne } from "@magister/db";

import { createDb, getRawSqlite, workspaces, type WorkspaceInsert, type WorkspaceSelect } from "@magister/db";

/**
 * Per-machine workspace registry CRUD. Workspace identity is the
 * `id` slug (e.g. "default", "myapp"); `base_path` is the directory
 * the agent operates in for tasks bound to this workspace.
 *
 * Default-row invariant: exactly one row has `is_default = true` at
 * any time. `setDefault` is the only entry point that flips this
 * flag and does so transactionally — every UPDATE clears the
 * previous default in the same statement-pair.
 */
export type CreateWorkspaceInput = Omit<
  WorkspaceInsert,
  "createdAt" | "updatedAt" | "isDefault"
> & {
  isDefault?: boolean;
};

export type UpdateWorkspaceInput = Partial<
  Pick<WorkspaceInsert, "label" | "basePath">
>;

export class WorkspaceRepository {
  async listAll(): Promise<WorkspaceSelect[]> {
    const db = createDb();
    return db.query.workspaces.findMany({
      orderBy: (table, { desc, asc }) => [
        // Default first, then by createdAt — keeps the picker order
        // predictable: your primary workspace is always at the top.
        desc(table.isDefault),
        asc(table.createdAt),
      ],
    });
  }

  async getById(id: string): Promise<WorkspaceSelect | null> {
    const db = createDb();
    const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
    return row ?? null;
  }

  async getDefault(): Promise<WorkspaceSelect | null> {
    const db = createDb();
    const row = await db.query.workspaces.findFirst({
      where: eq(workspaces.isDefault, true),
    });
    return row ?? null;
  }

  async findByBasePath(basePath: string): Promise<WorkspaceSelect | null> {
    const db = createDb();
    const row = await db.query.workspaces.findFirst({
      where: eq(workspaces.basePath, basePath),
    });
    return row ?? null;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceSelect> {
    const db = createDb();
    const now = new Date();
    const row: WorkspaceInsert = {
      id: input.id,
      label: input.label,
      basePath: input.basePath,
      isDefault: input.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    };

    if (row.isDefault) {
      // Kimi review C1 — wrap clear-and-insert in a transaction so a
      // concurrent setDefault can't observe a zero-default state and
      // a crash between statements can't leak two defaults.
      // Native synchronous transaction. drizzle's `db.transaction(async cb)`
      // is a no-op on bun-sqlite (commits before awaited writes) and THROWS
      // on better-sqlite3 — see docs/plans/2026-06-02-runtime-portability.md F4.
      const sqlite = getRawSqlite();
      sqlite.transaction(() => {
        db
          .update(workspaces)
          .set({ isDefault: false, updatedAt: now })
          .where(eq(workspaces.isDefault, true))
          .run();
        db.insert(workspaces).values(row).run();
      })();
    } else {
      await db.insert(workspaces).values(row);
    }
    const created = await this.getById(input.id);
    if (!created) throw new Error(`workspace ${input.id} not found after insert`);
    return created;
  }

  async update(id: string, input: UpdateWorkspaceInput): Promise<WorkspaceSelect | null> {
    const db = createDb();
    const now = new Date();
    const patch: Partial<WorkspaceInsert> = { updatedAt: now };
    if (input.label !== undefined) patch.label = input.label;
    if (input.basePath !== undefined) patch.basePath = input.basePath;
    await db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.getById(id);
  }

  /**
   * Flip the default flag to `id` and clear it on every other row.
   * Idempotent — calling with an id that's already default is a
   * no-op (still bumps updatedAt). Throws if `id` doesn't exist.
   *
   * Kimi review C1 — both UPDATEs run inside a single transaction
   * so a parallel setDefault, an external writer, or a crash mid-
   * way can never leave the table with zero or two default rows.
   */
  async setDefault(id: string): Promise<WorkspaceSelect> {
    const target = await this.getById(id);
    if (!target) throw new Error(`workspace not found: ${id}`);
    const db = createDb();
    const now = new Date();
    // Native synchronous transaction (F4 — async drizzle tx is a no-op on
    // bun-sqlite and throws on better-sqlite3).
    const sqlite = getRawSqlite();
    sqlite.transaction(() => {
      // Clear all other defaults first (could in theory be > 1 row
      // if an external writer broke the invariant). `ne` keeps this
      // idempotent for the already-default case.
      db
        .update(workspaces)
        .set({ isDefault: false, updatedAt: now })
        .where(ne(workspaces.id, id))
        .run();
      db
        .update(workspaces)
        .set({ isDefault: true, updatedAt: now })
        .where(eq(workspaces.id, id))
        .run();
    })();
    const after = await this.getById(id);
    if (!after) throw new Error(`workspace ${id} disappeared during setDefault`);
    return after;
  }

  /**
   * Delete a workspace. Refuses if the target is the current default
   * (caller must setDefault on another workspace first) or if it
   * would leave the registry empty.
   *
   * Cascade: live channel-routing rows (`conversation_bindings`,
   * `channel_sessions`) that pointed at this workspace are re-pointed to
   * the default workspace in the SAME transaction as the row delete.
   * Without this, a Feishu/web conversation bound to the deleted
   * workspace kept resolving to a dangling id — a new inbound message
   * created a task against a workspace that no longer exists, which
   * stranded the web picker on "Loading…". Historical rows
   * (`tasks`/`runtime_workspaces`/`execution_events`/`change_reviews`)
   * keep their original `workspaceId`: re-pointing history would move
   * past sessions into the default workspace (lossy); once the workspace
   * is gone they simply aren't surfaced.
   */
  async deleteById(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    createDb();
    const row = await this.getById(id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.isDefault) return { ok: false, reason: "is_default" };
    const all = await this.listAll();
    if (all.length <= 1) return { ok: false, reason: "last_workspace" };
    // Default row is guaranteed to exist and differ from `id` (we just
    // refused is_default + last_workspace above).
    const fallbackId =
      all.find((w) => w.isDefault)?.id ?? all.find((w) => w.id !== id)?.id;
    if (!fallbackId) return { ok: false, reason: "last_workspace" };

    const now = Date.now();
    const sqlite = getRawSqlite();
    const cascade = sqlite.transaction(() => {
      sqlite
        .prepare(
          "UPDATE conversation_bindings SET workspace_id = ?, updated_at = ? WHERE workspace_id = ?",
        )
        .run(fallbackId, now, id);
      sqlite
        .prepare(
          "UPDATE channel_sessions SET workspace_id = ?, updated_at = ? WHERE workspace_id = ?",
        )
        .run(fallbackId, now, id);
      sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    });
    cascade();
    return { ok: true };
  }
}
