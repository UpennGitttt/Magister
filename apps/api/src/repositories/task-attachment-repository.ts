import { and, eq } from "@magister/db";

import {
  createDb,
  taskAttachments,
  type TaskAttachmentInsert,
  type TaskAttachmentSelect,
} from "@magister/db";

/**
 * Metadata access for files uploaded with a user prompt. Bytes
 * live on disk under `<cwd>/.magister/uploads/<task_id>/`; this
 * repo only owns the index rows. Cleanup of the on-disk files is
 * handled by `attachment-service.ts`'s `purgeForTask`.
 */
export class TaskAttachmentRepository {
  async create(input: TaskAttachmentInsert): Promise<void> {
    const db = createDb();
    await db.insert(taskAttachments).values(input);
  }

  async listByTaskId(taskId: string): Promise<TaskAttachmentSelect[]> {
    const db = createDb();
    return db.query.taskAttachments.findMany({
      where: eq(taskAttachments.taskId, taskId),
    });
  }

  /**
   * Per-turn lookup. Used when building the leader's user message
   * for a specific request — only that turn's uploads should be
   * inlined as image content blocks; prior turns' attachments stay
   * in the conversation history through their original messages
   * already.
   */
  async listByTaskIdAndRequest(
    taskId: string,
    requestId: string,
  ): Promise<TaskAttachmentSelect[]> {
    const db = createDb();
    return db.query.taskAttachments.findMany({
      where: and(
        eq(taskAttachments.taskId, taskId),
        eq(taskAttachments.requestId, requestId),
      ),
    });
  }

  async deleteByTaskId(taskId: string): Promise<void> {
    const db = createDb();
    await db.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId));
  }
}
