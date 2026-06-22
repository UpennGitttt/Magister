import { and, eq, inArray } from "@magister/db";

import { createDb, roleRuntimes, type RoleRuntimeInsert } from "@magister/db";

type UpdateRoleRuntimeInput = Partial<
  Omit<RoleRuntimeInsert, "id" | "taskId" | "roleId">
>;

export class RoleRuntimeRepository {
  async create(input: RoleRuntimeInsert) {
    const db = createDb();
    await db.insert(roleRuntimes).values(input);
  }

  async listAll() {
    const db = createDb();
    return db.query.roleRuntimes.findMany();
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.roleRuntimes.findFirst({
      where: eq(roleRuntimes.id, id),
    });
  }

  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.roleRuntimes.findMany({
      where: eq(roleRuntimes.taskId, taskId),
    });
  }

  /**
   * Returns all RUNNING role_runtime rows that were spawned with
   * wait: false (spawned_async = true) for the given parent task.
   * Used at the end of a leader turn to decide whether to transition
   * the task to AWAITING_TEAMMATES instead of DONE.
   */
  async listActiveBackgroundTeammates(parentTaskId: string) {
    const db = createDb();
    return db.query.roleRuntimes.findMany({
      where: and(
        eq(roleRuntimes.taskId, parentTaskId),
        eq(roleRuntimes.state, "RUNNING"),
        eq(roleRuntimes.spawnedAsync, true),
      ),
    });
  }

  async listByParallelGroupId(groupId: string) {
    const db = createDb();
    return db.query.roleRuntimes.findMany({
      where: eq(roleRuntimes.parallelGroupId, groupId),
    });
  }

  async update(id: string, input: UpdateRoleRuntimeInput) {
    const db = createDb();
    await db.update(roleRuntimes).set(input).where(eq(roleRuntimes.id, id));
  }

  /**
   * Conditional update — only applies the patch if the row's current
   * `state` is in `expectedStates`. Returns the number of rows that
   * were actually updated, so the caller can detect a TOCTOU race
   * (e.g. two concurrent resume attempts on the same teammateRunId).
   *
   * Used by spawn_teammate's resume path to atomically flip a
   * COMPLETED/FAILED record back to RUNNING and lose-the-race losers
   * cleanly .
   */
  async updateIfStateIn(
    id: string,
    expectedStates: Array<RoleRuntimeInsert["state"]>,
    input: UpdateRoleRuntimeInput,
  ): Promise<number> {
    const db = createDb();
    const result = await db
      .update(roleRuntimes)
      .set(input)
      .where(
        and(eq(roleRuntimes.id, id), inArray(roleRuntimes.state, expectedStates)),
      );
    // Drizzle's better-sqlite3 driver returns { changes } on the run
    // result — fall back to 0 if not surfaced (e.g. test mock).
    return (result as unknown as { changes?: number }).changes ?? 0;
  }
}
