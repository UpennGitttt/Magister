import { and, eq, lt, asc } from "@magister/db";

import { approvals, createDb, type ApprovalInsert } from "@magister/db";

export class ApprovalRepository {
  async create(input: ApprovalInsert) {
    const db = createDb();
    await db.insert(approvals).values(input);
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.approvals.findFirst({
      where: eq(approvals.id, id),
    });
  }

  async listAll() {
    const db = createDb();
    return db.query.approvals.findMany();
  }

  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.approvals.findMany({
      where: eq(approvals.taskId, taskId),
    });
  }

  /** All pending approvals, ordered oldest-first. */
  async listPending() {
    const db = createDb();
    return db.query.approvals.findMany({
      where: eq(approvals.state, "pending"),
      orderBy: [asc(approvals.requestedAt)],
    });
  }

  /** Pending approvals older than the cutoff timestamp (ms epoch). */
  async listExpired(beforeMs: number) {
    const db = createDb();
    return db.query.approvals.findMany({
      where: and(
        eq(approvals.state, "pending"),
        lt(approvals.requestedAt, new Date(beforeMs)),
      ),
      orderBy: [asc(approvals.requestedAt)],
    });
  }

  /**
   * Resolve an approval. Returns `true` if THIS call landed the
   * write, `false` if someone else got there first (already
   * resolved). Critical for dual-channel race avoidance: web +
   * Feishu can both click "Approve" within a few ms; only one
   * should win, the other gets a no-op + sees the existing state.
   *
   * Uses CAS `WHERE id = ? AND state = 'pending'` so a second
   * resolver sees zero affected rows. SQLite's `changes` field
   * is exposed by drizzle's better-sqlite3 / bun:sqlite drivers.
   */
  async resolve(
    id: string,
    input: {
      state: string;
      resolvedAt: Date;
      resolvedBy?: string;
      payloadJson?: string;
    },
  ): Promise<boolean> {
    const db = createDb();
    const result = await db
      .update(approvals)
      .set({
        state: input.state,
        resolvedAt: input.resolvedAt,
        resolvedBy: input.resolvedBy,
        payloadJson: input.payloadJson,
      })
      .where(and(eq(approvals.id, id), eq(approvals.state, "pending")));
    // drizzle's run() result shape varies by driver. bun:sqlite +
    // better-sqlite3 both expose `changes` (number). Fall back to
    // treating any thrown / shape-mismatched response as "best-effort
    // happened" — the second-resolver case will still notice via the
    // re-read at the call site.
    const changes = (result as unknown as { changes?: number })?.changes;
    if (typeof changes === "number") return changes > 0;
    return true;
  }

  /** Delete every row — only used by test setup. */
  async deleteAllForTests() {
    const db = createDb();
    await db.delete(approvals);
  }
}
