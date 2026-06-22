import { eq } from "@magister/db";

import {
  createDb,
  mcpServers,
  type McpServerInsert,
  type McpServerSelect,
} from "@magister/db";

/**
 * CRUD over the `mcp_servers` table. Bytes-on-disk concerns
 * (per-server lifecycle) live in `mcp-pool-service.ts`; this repo
 * is purely the metadata index.
 */
export class McpServerRepository {
  async create(input: McpServerInsert): Promise<void> {
    const db = createDb();
    await db.insert(mcpServers).values(input);
  }

  async listAll(): Promise<McpServerSelect[]> {
    const db = createDb();
    return db.query.mcpServers.findMany();
  }

  async listEnabled(): Promise<McpServerSelect[]> {
    const db = createDb();
    return db.query.mcpServers.findMany({
      where: eq(mcpServers.enabled, true),
    });
  }

  async getById(id: string): Promise<McpServerSelect | undefined> {
    const db = createDb();
    return db.query.mcpServers.findFirst({
      where: eq(mcpServers.id, id),
    });
  }

  async findByName(name: string): Promise<McpServerSelect | undefined> {
    const db = createDb();
    return db.query.mcpServers.findFirst({
      where: eq(mcpServers.name, name),
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<McpServerInsert, "id" | "createdAt">>,
  ): Promise<void> {
    const db = createDb();
    await db.update(mcpServers).set(patch).where(eq(mcpServers.id, id));
  }

  async deleteById(id: string): Promise<void> {
    const db = createDb();
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
  }
}
