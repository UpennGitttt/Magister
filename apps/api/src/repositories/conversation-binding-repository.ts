import { eq } from "@magister/db";

import {
  conversationBindings,
  createDb,
  type ConversationBindingInsert,
} from "@magister/db";

type UpdateConversationBindingInput = Partial<
  Omit<ConversationBindingInsert, "id" | "channel" | "accountId" | "chatId" | "workspaceId" | "createdAt">
>;

export class ConversationBindingRepository {
  async create(input: ConversationBindingInsert) {
    const db = createDb();
    await db.insert(conversationBindings).values(input);
  }

  async getById(id: string) {
    const db = createDb();
    return db.query.conversationBindings.findFirst({
      where: eq(conversationBindings.id, id),
    });
  }

  async update(id: string, input: UpdateConversationBindingInput) {
    const db = createDb();
    await db.update(conversationBindings).set(input).where(eq(conversationBindings.id, id));
  }

  /**
   * User-initiated rebind to a different workspace (via `/ws` command).
   * Bypasses the default `update`'s omit-list because the
   * conservative default forbids workspace changes — workspace is the
   * tenant scope, and silent rebinds from message-handler code paths
   * would let an inbound message mutate a binding it shouldn't.
   * The slash-command path explicitly opts in here.
   */
  async setWorkspace(id: string, workspaceId: string, when: Date) {
    const db = createDb();
    await db
      .update(conversationBindings)
      .set({ workspaceId, updatedAt: when })
      .where(eq(conversationBindings.id, id));
  }
}
