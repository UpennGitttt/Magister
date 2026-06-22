import { eq, desc } from "@magister/db";

import {
  createDb,
  getRawSqlite,
  memoryEntries,
  type MemoryEntryProvenanceSelect,
} from "@magister/db";

import type { MemoryWriteAuthority } from "../services/memory/memory-types";

/**
 * Provenance mirror for memory entries. The on-disk file is
 * authoritative; this table records "who wrote, when, from which
 * task/request" so the UI / audit / replay paths don't have to
 * scrape execution_events to reconstruct authorship.
 *
 * Lifecycle:
 *   - upsertMemory → `record(path, ...)` (first call sets first_*; later
 *     calls refresh last_*)
 *   - deleteMemory → `forgetPath(path)` drops the row. If the entry comes
 *     back later, that's a fresh row (no resurrection bookkeeping).
 *   - The sweeper does NOT call into this repo — its writes are
 *     metadata-only (aging flag, codeChanged, ref repair) and shouldn't
 *     count as "authored" events.
 */
export class MemoryProvenanceRepository {
  /**
   * Atomic upsert keyed by `path`. Uses SQLite's
   * `INSERT … ON CONFLICT(path) DO UPDATE` to avoid race conditions
   * between concurrent first writes.
   *
   * `writtenAt` is a required caller-supplied timestamp (captured at
   * FS write time) to prevent stale overwrites from slow async tasks.
   *
   * `last_*` always reflects the latest write. `first_*` is set only
   * on the initial insert (preserved on subsequent updates via SQL).
   */
  async record(input: {
    path: string;
    scope: "user-global" | "project";
    type: string;
    authority: MemoryWriteAuthority;
    writtenAt: Date;
    taskId?: string | null;
    requestId?: string | null;
  }): Promise<void> {
    const sqlite = getRawSqlite();
    sqlite
      .prepare(
        `INSERT INTO memory_entries (
          path, scope, type,
          first_write_authority, first_write_task_id, first_write_request_id, first_written_at,
          last_write_authority, last_write_task_id, last_write_request_id, last_written_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          scope = excluded.scope,
          type = excluded.type,
          last_write_authority = excluded.last_write_authority,
          last_write_task_id = excluded.last_write_task_id,
          last_write_request_id = excluded.last_write_request_id,
          last_written_at = excluded.last_written_at
        WHERE excluded.last_written_at >= memory_entries.last_written_at`,
      )
      .run(
        input.path,
        input.scope,
        input.type,
        input.authority,
        input.taskId ?? null,
        input.requestId ?? null,
        input.writtenAt.getTime(),
        input.authority,
        input.taskId ?? null,
        input.requestId ?? null,
        input.writtenAt.getTime(),
      );
  }

  async forgetPath(path: string): Promise<void> {
    const db = createDb();
    await db.delete(memoryEntries).where(eq(memoryEntries.path, path));
  }

  async getByPath(
    path: string,
  ): Promise<MemoryEntryProvenanceSelect | undefined> {
    const db = createDb();
    return db.query.memoryEntries.findFirst({
      where: eq(memoryEntries.path, path),
    });
  }

  /** Recent writes, newest first. Used by the (future) Diagnostics view. */
  async listRecent(limit: number): Promise<MemoryEntryProvenanceSelect[]> {
    const db = createDb();
    return db.query.memoryEntries.findMany({
      orderBy: [desc(memoryEntries.lastWrittenAt)],
      limit,
    });
  }
}
