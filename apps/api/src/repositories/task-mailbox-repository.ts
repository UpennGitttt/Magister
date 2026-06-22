import { eq, isNull, and } from "@magister/db";
import { createDb, taskMailbox, type TaskMailboxInsert } from "@magister/db";

export class TaskMailboxRepository {
  async create(input: TaskMailboxInsert) {
    const db = createDb();
    await db.insert(taskMailbox).values(input);
  }

  async getUnconsumed(taskId: string) {
    const db = createDb();
    return db.query.taskMailbox.findMany({
      where: and(eq(taskMailbox.taskId, taskId), isNull(taskMailbox.consumedAt)),
      orderBy: [taskMailbox.createdAt],
    });
  }

  async markConsumed(ids: string[]) {
    if (ids.length === 0) return;
    const db = createDb();
    const now = new Date();
    for (const id of ids) {
      await db.update(taskMailbox).set({ consumedAt: now }).where(eq(taskMailbox.id, id));
    }
  }

  /**
   * Return all mailbox rows for a task (consumed or not), ordered by
   * creation time. Used to recover earlier members' summaries when
   * building the consolidated parallel-group-completion message.
   */
  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.taskMailbox.findMany({
      where: eq(taskMailbox.taskId, taskId),
      orderBy: [taskMailbox.createdAt],
    });
  }

  /**
   * Count unconsumed mailbox rows tagged as async teammate completions.
   * Used by the leader's turn-end logic to detect "teammate already
   * finished and wrote a result but I haven't processed it yet" so the
   * task transitions to AWAITING_TEAMMATES (not DONE) and the deferred
   * wake-up reenqueue lands cleanly.
   */
  async countUnconsumedTeammateCompletions(taskId: string): Promise<number> {
    const db = createDb();
    const rows = await db.query.taskMailbox.findMany({
      where: and(eq(taskMailbox.taskId, taskId), isNull(taskMailbox.consumedAt)),
    });
    return rows.filter((r) => {
      if (!r.metadataJson) return false;
      try {
        const m = JSON.parse(r.metadataJson) as { type?: string };
        return m.type === "teammate_completion";
      } catch {
        return false;
      }
    }).length;
  }
}
