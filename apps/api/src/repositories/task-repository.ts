import { and, eq, gte, inArray, isNull } from "@magister/db";

import { createDb, tasks, type TaskInsert } from "@magister/db";

type CreateTaskInput = Omit<TaskInsert, "priority" | "rootChannelBindingId" | "createdBy" | "completedAt"> &
  Partial<Pick<TaskInsert, "priority" | "rootChannelBindingId" | "createdBy" | "completedAt">>;
type UpdateTaskInput = Partial<
  Omit<TaskInsert, "id" | "workspaceId" | "source" | "createdAt">
>;

export class TaskRepository {
  async create(input: CreateTaskInput) {
    const db = createDb();
    await db.insert(tasks).values(input);
  }

  async listAll() {
    const db = createDb();
    return db.query.tasks.findMany();
  }

  async listRecentByWorkspaceId(workspaceId: string, limit = 5) {
    const db = createDb();
    return db.query.tasks.findMany({
      where: eq(tasks.workspaceId, workspaceId),
      orderBy: (taskTable, { desc }) => [desc(taskTable.updatedAt)],
      limit,
    });
  }

  async listRecentByRootChannelBindingId(
    rootChannelBindingId: string,
    options?: {
      limit?: number;
      excludeTaskId?: string;
    },
  ) {
    const db = createDb();
    const limit = options?.limit ?? 5;

    return db.query.tasks.findMany({
      where: (taskTable, { and, eq: tableEq, ne }) =>
        options?.excludeTaskId
          ? and(
              tableEq(taskTable.rootChannelBindingId, rootChannelBindingId),
              ne(taskTable.id, options.excludeTaskId),
            )
          : tableEq(taskTable.rootChannelBindingId, rootChannelBindingId),
      orderBy: (taskTable, { desc }) => [desc(taskTable.updatedAt)],
      limit,
    });
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.tasks.findFirst({
      where: eq(tasks.id, id),
    });
  }

  async listTerminalUpdatedSince(updatedSince?: Date) {
    const db = createDb();
    return db.query.tasks.findMany({
      where: updatedSince
        ? and(inArray(tasks.state, ["COMPLETED", "BLOCKED"]), gte(tasks.updatedAt, updatedSince))
        : inArray(tasks.state, ["COMPLETED", "BLOCKED"]),
      orderBy: (taskTable, { desc }) => [desc(taskTable.updatedAt)],
    });
  }

  async update(id: string, input: UpdateTaskInput) {
    const db = createDb();
    await db.update(tasks).set(input).where(eq(tasks.id, id));
  }

  /**
   * Atomic compare-and-swap on `model_override` for the /model slash
   * command's concurrent-POST race. SQLite + the leader's inline-write
   * path can both touch this column from outside the route handler, so
   * a check-then-write in route code has a real (though narrow) TOCTOU
   * window. This collapses it into a single conditional UPDATE.
   *
   * Returns the number of rows updated (1 = success, 0 = stale: the
   * actual value differed from `expected`). On 0, the caller must
   * re-read the row to surface the current value to the client.
   *
   * `expected === null` matches when the column is NULL (no override).
   * Mixing `null` and `""` would defeat CAS; the column is always
   * NULL or a non-empty string by route-level validation.
   */
  async casUpdateModelOverride(
    id: string,
    expected: string | null,
    next: string | null,
  ): Promise<number> {
    const db = createDb();
    const expectedCond = expected === null
      ? isNull(tasks.modelOverride)
      : eq(tasks.modelOverride, expected);
    const result = await db
      .update(tasks)
      .set({ modelOverride: next, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), expectedCond));
    // Drizzle returns a driver-specific result. For Bun's SQLite the
    // shape is `{ changes: number, lastInsertRowid: number }`. Read
    // defensively so unit tests using a stub don't crash.
    const changes = (result as { changes?: number } | undefined)?.changes;
    return typeof changes === "number" ? changes : 0;
  }
}
