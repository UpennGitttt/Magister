import { eq } from "@magister/db";

import {
  channelSessions,
  createDb,
  type ChannelSessionInsert,
} from "@magister/db";

type UpdateChannelSessionInput = Partial<
  Omit<ChannelSessionInsert, "id" | "createdAt">
>;

export class ChannelSessionRepository {
  async create(input: ChannelSessionInsert) {
    const db = createDb();
    await db.insert(channelSessions).values(input);
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.channelSessions.findFirst({
      where: eq(channelSessions.id, id),
    });
  }

  async getByBindingId(bindingId: string) {
    const db = createDb();
    return db.query.channelSessions.findFirst({
      where: eq(channelSessions.bindingId, bindingId),
    });
  }

  /**
   * Reverse lookup: find the channel session currently scoped to a
   * specific task. Used by the feishu approval outbound to map an
   * approval (which carries `taskId`) back to the chat + binding
   * that originated it.
   *
   * Single row at most: `currentTaskId` is per-session and the
   * session is per-binding-per-channel, so collisions are not
   * expected. Returns null when the task wasn't created via a
   * channel (e.g. web-only tasks have no channelSessions row).
   */
  async findByCurrentTaskId(taskId: string) {
    const db = createDb();
    return db.query.channelSessions.findFirst({
      where: eq(channelSessions.currentTaskId, taskId),
    });
  }

  async update(id: string, input: UpdateChannelSessionInput) {
    const db = createDb();
    await db.update(channelSessions).set(input).where(eq(channelSessions.id, id));
  }

  /**
   * Slash-command `/ws` rebind path. Workspace mutation requires
   * explicit opt-in (not allowed via the default update shape).
   */
  async setWorkspace(id: string, workspaceId: string, when: Date) {
    const db = createDb();
    await db
      .update(channelSessions)
      .set({ workspaceId, updatedAt: when })
      .where(eq(channelSessions.id, id));
  }
}
