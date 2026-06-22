import { and, eq } from "@magister/db";

import {
  agentMcpAttachments,
  createDb,
  getRawSqlite,
} from "@magister/db";

/**
 * CRUD over the (roleId, serverId) join table that records which
 * agent profiles see which MCP servers. Used by the runtime tool
 * merge and by the Settings → Agents UI.
 */
export class AgentMcpAttachmentRepository {
  async attach(roleId: string, serverId: string): Promise<void> {
    const db = createDb();
    await db
      .insert(agentMcpAttachments)
      .values({ roleId, serverId, createdAt: new Date() })
      .onConflictDoNothing();
  }

  async detach(roleId: string, serverId: string): Promise<void> {
    const db = createDb();
    await db
      .delete(agentMcpAttachments)
      .where(and(eq(agentMcpAttachments.roleId, roleId), eq(agentMcpAttachments.serverId, serverId)));
  }

  async detachAllForServer(serverId: string): Promise<void> {
    const db = createDb();
    await db.delete(agentMcpAttachments).where(eq(agentMcpAttachments.serverId, serverId));
  }

  async listForRole(roleId: string): Promise<string[]> {
    const db = createDb();
    const rows = await db.query.agentMcpAttachments.findMany({
      where: eq(agentMcpAttachments.roleId, roleId),
    });
    return rows.map((r) => r.serverId);
  }

  async listForServer(serverId: string): Promise<string[]> {
    const db = createDb();
    const rows = await db.query.agentMcpAttachments.findMany({
      where: eq(agentMcpAttachments.serverId, serverId),
    });
    return rows.map((r) => r.roleId);
  }

  /**
   * Replace the full attachment set for a role atomically — wraps
   * the diff-and-apply in a transaction so concurrent PUTs from the
   * UI can't interleave a partial state. Used by
   * `PUT /agents/:roleId/mcp-servers`.
   */
  async setForRole(roleId: string, serverIds: string[]): Promise<void> {
    const db = createDb();
    const current = new Set(await this.listForRole(roleId));
    const desired = new Set(serverIds);
    const toAdd = serverIds.filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !desired.has(id));
    if (toAdd.length === 0 && toRemove.length === 0) return;
    // Native synchronous transaction (F4 — async drizzle tx is a no-op on
    // bun-sqlite and throws on better-sqlite3).
    const sqlite = getRawSqlite();
    sqlite.transaction(() => {
      if (toAdd.length > 0) {
        db
          .insert(agentMcpAttachments)
          .values(toAdd.map((serverId) => ({ roleId, serverId, createdAt: new Date() })))
          .onConflictDoNothing()
          .run();
      }
      for (const serverId of toRemove) {
        db
          .delete(agentMcpAttachments)
          .where(and(eq(agentMcpAttachments.roleId, roleId), eq(agentMcpAttachments.serverId, serverId)))
          .run();
      }
    })();
  }
}
