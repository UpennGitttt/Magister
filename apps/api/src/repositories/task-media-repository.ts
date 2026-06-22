import { and, asc, eq } from "@magister/db";

import { createDb, taskMedia, type TaskMediaInsert } from "@magister/db";

export class TaskMediaRepository {
  async create(input: TaskMediaInsert) {
    const db = createDb();
    await db.insert(taskMedia).values(input);
  }

  async getByTaskIdAndId(taskId: string, id: string) {
    const db = createDb();
    return db.query.taskMedia.findFirst({
      where: and(eq(taskMedia.taskId, taskId), eq(taskMedia.id, id)),
    });
  }

  async listByTaskId(taskId: string) {
    const db = createDb();
    return db.query.taskMedia.findMany({
      where: eq(taskMedia.taskId, taskId),
      orderBy: [asc(taskMedia.createdAt), asc(taskMedia.id)],
    });
  }

  /**
   * Media for ONE turn — scoped by (taskId, requestId). The Feishu
   * single-card finalizer uses this (NOT listByTaskId) so a card only
   * inlines media produced in its own turn; listByTaskId would pull in
   * prior turns' media on a resumed task that shares a taskId.
   */
  async listByTaskIdAndRequestId(taskId: string, requestId: string) {
    const db = createDb();
    return db.query.taskMedia.findMany({
      where: and(eq(taskMedia.taskId, taskId), eq(taskMedia.requestId, requestId)),
      orderBy: [asc(taskMedia.createdAt), asc(taskMedia.id)],
    });
  }

  async markDeleted(taskId: string, id: string, deletedAt = new Date()) {
    const db = createDb();
    await db
      .update(taskMedia)
      .set({ status: "deleted", deletedAt })
      .where(and(eq(taskMedia.taskId, taskId), eq(taskMedia.id, id)));
  }

  async deleteByTaskId(taskId: string) {
    const db = createDb();
    await db.delete(taskMedia).where(eq(taskMedia.taskId, taskId));
  }
}

