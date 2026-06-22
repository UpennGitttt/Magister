import { and, eq } from "@magister/db";
import { createHash } from "node:crypto";

import {
  createDb,
  mcpToolPolicies,
  type McpToolPolicyInsert,
  type McpToolPolicySelect,
} from "@magister/db";

export type McpToolPolicyValue = "unknown" | "read_only" | "mutating";
export type McpToolPolicySource = "discovered" | "manual" | "imported";

export type DiscoveredMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function policyId(serverId: string, toolName: string): string {
  const digest = createHash("sha256")
    .update(serverId)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, 24);
  return `mcp_tool_policy_${digest}`;
}

function serializeInputSchema(inputSchema: Record<string, unknown> | undefined): string | null {
  return inputSchema === undefined ? null : JSON.stringify(inputSchema);
}

export class McpToolPolicyRepository {
  async listForServer(serverId: string): Promise<McpToolPolicySelect[]> {
    const db = createDb();
    return db.query.mcpToolPolicies.findMany({
      where: eq(mcpToolPolicies.serverId, serverId),
    });
  }

  async listAll(): Promise<McpToolPolicySelect[]> {
    const db = createDb();
    return db.query.mcpToolPolicies.findMany();
  }

  async get(serverId: string, toolName: string): Promise<McpToolPolicySelect | undefined> {
    const db = createDb();
    return db.query.mcpToolPolicies.findFirst({
      where: and(
        eq(mcpToolPolicies.serverId, serverId),
        eq(mcpToolPolicies.toolName, toolName),
      ),
    });
  }

  async resolvePolicy(serverId: string, toolName: string): Promise<McpToolPolicyValue> {
    const row = await this.get(serverId, toolName);
    return isMcpToolPolicy(row?.policy) ? row.policy : "unknown";
  }

  async syncDiscoveredTools(input: {
    serverId: string;
    tools: DiscoveredMcpTool[];
    now?: Date;
  }): Promise<McpToolPolicySelect[]> {
    const db = createDb();
    const now = input.now ?? new Date();
    for (const tool of input.tools) {
      const row: McpToolPolicyInsert = {
        id: policyId(input.serverId, tool.name),
        serverId: input.serverId,
        toolName: tool.name,
        policy: "unknown",
        source: "discovered",
        rationale: null,
        description: tool.description ?? null,
        inputSchemaJson: serializeInputSchema(tool.inputSchema),
        lastDiscoveredAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await db
        .insert(mcpToolPolicies)
        .values(row)
        .onConflictDoUpdate({
          target: [mcpToolPolicies.serverId, mcpToolPolicies.toolName],
          set: {
            description: row.description,
            inputSchemaJson: row.inputSchemaJson,
            lastDiscoveredAt: row.lastDiscoveredAt,
            updatedAt: row.updatedAt,
          },
        });
    }
    return this.listForServer(input.serverId);
  }

  async setPolicy(input: {
    serverId: string;
    toolName: string;
    policy: McpToolPolicyValue;
    rationale?: string | null;
    now?: Date;
  }): Promise<McpToolPolicySelect> {
    const db = createDb();
    const now = input.now ?? new Date();
    const row: McpToolPolicyInsert = {
      id: policyId(input.serverId, input.toolName),
      serverId: input.serverId,
      toolName: input.toolName,
      policy: input.policy,
      source: "manual",
      rationale: input.rationale ?? null,
      description: null,
      inputSchemaJson: null,
      lastDiscoveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db
      .insert(mcpToolPolicies)
      .values(row)
      .onConflictDoUpdate({
        target: [mcpToolPolicies.serverId, mcpToolPolicies.toolName],
        set: {
          policy: row.policy,
          source: row.source,
          rationale: row.rationale,
          updatedAt: row.updatedAt,
        },
      });
    const saved = await this.get(input.serverId, input.toolName);
    if (!saved) {
      throw new Error(`MCP tool policy write failed for ${input.serverId}.${input.toolName}`);
    }
    return saved;
  }

  async deleteForServer(serverId: string): Promise<void> {
    const db = createDb();
    await db.delete(mcpToolPolicies).where(eq(mcpToolPolicies.serverId, serverId));
  }
}

export function isMcpToolPolicy(value: unknown): value is McpToolPolicyValue {
  return value === "unknown" || value === "read_only" || value === "mutating";
}
