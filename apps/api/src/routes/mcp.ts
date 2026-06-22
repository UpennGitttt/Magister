import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { McpServerRepository } from "../repositories/mcp-server-repository";
import { McpToolPolicyRepository } from "../repositories/mcp-tool-policy-repository";
import { getMcpPool } from "../services/mcp-pool-service";
import type { McpServerInsert } from "@magister/db";

/**
 * MCP server registration routes. Per Phase 1: tools-only, no
 * OAuth, registry persisted in `mcp_servers` table. Live
 * connection status comes from the process-wide pool.
 *
 * Endpoints:
 *   GET    /mcp/servers      → list all with live status
 *   POST   /mcp/servers      → register a new server
 *   PUT    /mcp/servers/:id  → patch (rename / toggle / change trustLevel)
 *   GET    /mcp/servers/:id/tools → list per-tool trust policies
 *   PUT    /mcp/servers/:id/tools/:toolName/policy → update one tool policy
 *   DELETE /mcp/servers/:id  → remove from registry
 *
 * Changes take effect on next leader runtime startup — the pool
 * connects servers once at first runtime spawn. Phase 2 candidate:
 * hot-reload / live disconnect.
 */

const stdioConfigSchema = z.object({
  command: z.array(z.string().min(1)).min(1).max(20),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const remoteConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

// Name flows into JSON object keys, lockfile basenames, and shell argv (as
// a discrete arg, not interpolated into a string). The strict charset keeps
// it consistent with the cli-bridge skill-name regex and avoids surprises
// (whitespace / .. / control chars).
const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_.-]+$/, "must match [a-zA-Z0-9_.-]"),
  transport: z.enum(["stdio", "http", "sse"]),
  config: z.union([stdioConfigSchema, remoteConfigSchema]),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  enabled: z.boolean().optional(),
  // Default to "ask". MCP servers are arbitrary remote code, so
  // we require explicit user opt-in (trustLevel: "trusted") to
  // allow read-only tools to skip per-call approval.
  trustLevel: z.enum(["trusted", "ask"]).optional(),
});

const updateSchema = createSchema.partial();
const policyUpdateSchema = z.object({
  policy: z.enum(["unknown", "read_only", "mutating"]),
  rationale: z.string().max(500).nullable().optional(),
});

export async function registerMcpRoutes(app: FastifyInstance) {
  const repo = new McpServerRepository();
  const toolPolicyRepo = new McpToolPolicyRepository();

  app.get("/mcp/servers", async () => {
    const rows = await repo.listAll();
    const pool = getMcpPool();
    const status = pool.statusByServer();
    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          transport: row.transport,
          config: JSON.parse(row.configJson),
          timeoutMs: row.timeoutMs,
          enabled: row.enabled,
          trustLevel: row.trustLevel ?? "ask",
          status: status[row.id] ?? { kind: row.enabled ? "disconnected" : "disabled" },
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      },
    };
  });

  app.get("/mcp/servers/:id/tools", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await repo.getById(id);
    if (!row) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `MCP server "${id}" not found.`,
        },
      };
    }
    const pool = getMcpPool();
    const items = await pool.listToolPoliciesForServer(id);
    return { ok: true, data: { items } };
  });

  app.put("/mcp/servers/:id/tools/:toolName/policy", async (request, reply) => {
    const { id, toolName } = request.params as { id: string; toolName: string };
    const input = policyUpdateSchema.parse(request.body);
    const row = await repo.getById(id);
    if (!row) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `MCP server "${id}" not found.`,
        },
      };
    }
    await toolPolicyRepo.setPolicy({
      serverId: id,
      toolName,
      policy: input.policy,
      rationale: input.rationale ?? null,
    });
    const pool = getMcpPool();
    await pool.refreshToolPolicies(id);
    const [item] = (await pool.listToolPoliciesForServer(id)).filter((entry) => entry.toolName === toolName);
    return { ok: true, data: { item: item ?? null } };
  });

  app.post("/mcp/servers", async (request, reply) => {
    const input = createSchema.parse(request.body);
    // Name-collision guard (kimi Stage 3 review). The mcp_servers
    // table has no UNIQUE on name; a duplicate would create two rows
    // both default-attached to leader and break the ledger's
    // (cli, name) key.
    const existing = await repo.findByName(input.name);
    if (existing) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "name_taken",
          message: `An MCP server named "${input.name}" already exists (id: ${existing.id}). Pick a different name or update the existing entry.`,
        },
      };
    }
    const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    await repo.create({
      id,
      name: input.name,
      transport: input.transport,
      configJson: JSON.stringify(input.config),
      timeoutMs: input.timeoutMs ?? null,
      enabled: input.enabled ?? true,
      trustLevel: input.trustLevel ?? "ask",
      createdAt: now,
      updatedAt: now,
    });
    // Phase 3 hot-reload: connect immediately, no Magister restart needed.
    // New servers default-attach to leader only (smaller blast radius;
    // user opts other roles in via Settings → Agents).
    const pool = getMcpPool();
    await pool.addOrRefreshServer(id);
    const { AgentMcpAttachmentRepository } = await import(
      "../repositories/agent-mcp-attachment-repository"
    );
    const attRepo = new AgentMcpAttachmentRepository();
    await attRepo.attach("leader", id);
    // Stage 3.3 cli-bridge: propagate to CLI configs based on
    // attachment × runtime resolution. Default-leader-only attachment
    // means initially only writes to Magister-runtime CLIs (none of the
    // three external CLIs by default).
    const { propagateMcpToClis } = await import(
      "../services/cli-bridge/mcp-propagator"
    );
    const propagation = await propagateMcpToClis(id);
    reply.status(201);
    return { ok: true, data: { id, propagation } };
  });

  app.put("/mcp/servers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateSchema.parse(request.body);
    const patch: Partial<Omit<McpServerInsert, "id" | "createdAt">> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.transport !== undefined) patch.transport = input.transport;
    if (input.config !== undefined) patch.configJson = JSON.stringify(input.config);
    if (input.timeoutMs !== undefined) patch.timeoutMs = input.timeoutMs;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.trustLevel !== undefined) patch.trustLevel = input.trustLevel;
    await repo.update(id, patch);
    // Phase 3 hot-reload. trustLevel-only updates skip the reconnect
    // (cheap in-memory map update); anything else (config, name,
    // enabled, transport) triggers a full refresh. addOrRefreshServer
    // tears down the existing client first and connects fresh, so
    // config changes (command/url/env) actually take effect.
    const pool = getMcpPool();
    if (input.trustLevel !== undefined) {
      pool.updateTrustLevel(id, input.trustLevel);
    }
    const trustOnly = Object.keys(patch).every((k) => k === "trustLevel" || k === "updatedAt");
    if (!trustOnly) {
      await pool.addOrRefreshServer(id);
    }
    // Stage 3.3 cli-bridge: re-propagate to refresh CLI configs with
    // any new config/name/url/command. trustLevel-only changes skip
    // this since they don't affect the wire-format.
    let propagation: { warnings: string[]; errors: Array<{ cli: string; phase: string; message: string }> } | undefined;
    if (!trustOnly) {
      const { propagateMcpToClis } = await import(
        "../services/cli-bridge/mcp-propagator"
      );
      const result = await propagateMcpToClis(id);
      propagation = { warnings: result.warnings, errors: result.errors };
      // kimi Stage 3 review: log so divergence has a fingerprint.
      if (result.errors.length > 0) {
        console.warn(`[cli-bridge] PUT /mcp/servers/${id} propagation errors:`, result.errors);
      }
      if (result.warnings.length > 0) {
        console.warn(`[cli-bridge] PUT /mcp/servers/${id} warnings:`, result.warnings);
      }
    }
    return { ok: true, ...(propagation ? { data: { propagation } } : {}) };
  });

  app.delete("/mcp/servers/:id", async (request) => {
    const { id } = request.params as { id: string };
    // Phase 3 hot-reload. Drop pool state + attachment rows BEFORE
    // the row delete so the FK-style cleanup happens while the row
    // still exists (in case any future repo method consults it).
    const pool = getMcpPool();
    // Read the row BEFORE deletion so we have the name for cli-bridge
    // removal (the propagator removes by name from each CLI config).
    const row = await repo.getById(id);
    await pool.removeServer(id);
    const { AgentMcpAttachmentRepository } = await import(
      "../repositories/agent-mcp-attachment-repository"
    );
    const attRepo = new AgentMcpAttachmentRepository();
    await attRepo.detachAllForServer(id);
    await toolPolicyRepo.deleteForServer(id);
    await repo.deleteById(id);
    // Stage 3.3 cli-bridge: also remove from each CLI config that Magister
    // pushed to (gated on isUcmPushed; user-installed entries with
    // the same name are left untouched).
    let propagation: { warnings: string[]; errors: Array<{ cli: string; phase: string; message: string }> } | undefined;
    if (row) {
      const { propagateMcpDeletion } = await import(
        "../services/cli-bridge/mcp-propagator"
      );
      const result = await propagateMcpDeletion({ serverId: id, serverName: row.name });
      propagation = { warnings: result.warnings, errors: result.errors };
      if (result.errors.length > 0) {
        console.warn(`[cli-bridge] DELETE /mcp/servers/${id} propagation errors:`, result.errors);
      }
      if (result.warnings.length > 0) {
        console.warn(`[cli-bridge] DELETE /mcp/servers/${id} warnings:`, result.warnings);
      }
    }
    return { ok: true, ...(propagation ? { data: { propagation } } : {}) };
  });

  /**
   * List all prompts from all connected MCP servers. Used by the
   * frontend to populate the slash-command menu in ChatInput.
   * Returns one entry per (server, prompt) pair. Servers that
   * don't advertise the prompts capability simply contribute zero
   * entries (no error). Per-server failures are soft — one
   * broken server shouldn't blank the menu.
   */
  app.get("/mcp/prompts", async () => {
    const pool = getMcpPool();
    // Phase 3: scope to servers attached to the leader role —
    // the slash menu is at the leader level, so only the leader's
    // attached servers' prompts should appear.
    const status = await pool.statusForRole("leader");
    const items: Array<{
      serverId: string;
      serverName: string;
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }> = [];
    const rows = await repo.listAll();
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    for (const [serverId, st] of Object.entries(status)) {
      if (st.kind !== "connected") continue;
      try {
        const { prompts } = await pool.listPrompts(serverId);
        for (const p of prompts) {
          items.push({
            serverId,
            serverName: nameById.get(serverId) ?? serverId,
            name: p.name,
            ...(p.description !== undefined ? { description: p.description } : {}),
            ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
          });
        }
      } catch (err) {
        // Soft-fail per-server — one broken server shouldn't blank
        // the menu — but DO log so a server that consistently 500s
        // on listPrompts leaves a diagnostic trail. Matches the
        // [mcp-pool] warn convention used for connect failures.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp-prompts] listPrompts failed for "${serverId}": ${msg}`);
      }
    }
    return { ok: true, data: { items } };
  });

  /**
   * Render an MCP prompt to a message list. The frontend posts the
   * (serverId, name, args) tuple after the user fills in the
   * arg-collection form; we return the rendered messages so the
   * frontend can submit them as the first turn of a new task via
   * POST /tasks. Pure read; no approval gate.
   */
  const renderSchema = z.object({
    serverId: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.string(), z.string()).default({}),
  });
  app.post("/mcp/prompts/render", async (request, reply) => {
    const input = renderSchema.parse(request.body);
    const pool = getMcpPool();
    try {
      const result = await pool.getPrompt(input.serverId, input.name, input.args);
      return { ok: true, data: result };
    } catch (err) {
      reply.status(400);
      return {
        ok: false,
        error: { code: "render_failed", message: err instanceof Error ? err.message : String(err) },
      };
    }
  });

  /**
   * Per-agent MCP server attachment. Mirrors the agent-skills
   * pattern: GET returns the set of server IDs attached to one
   * agent role; PUT replaces the full set atomically (transactional
   * diff-and-apply in the repo).
   *
   * Phase 3: this is what the Settings → MCP tab's per-server
   * multi-checkbox UI calls when the user toggles attachment.
   */
  const setAgentMcpServersSchema = z.object({
    serverIds: z.array(z.string()).max(50),
  });

  app.get("/agents/:roleId/mcp-servers", async (request) => {
    const { roleId } = request.params as { roleId: string };
    const { AgentMcpAttachmentRepository } = await import(
      "../repositories/agent-mcp-attachment-repository"
    );
    const attRepo = new AgentMcpAttachmentRepository();
    const items = await attRepo.listForRole(roleId);
    return { ok: true, data: { items } };
  });

  app.put("/agents/:roleId/mcp-servers", async (request) => {
    const { roleId } = request.params as { roleId: string };
    const input = setAgentMcpServersSchema.parse(request.body);
    const { AgentMcpAttachmentRepository } = await import(
      "../repositories/agent-mcp-attachment-repository"
    );
    const attRepo = new AgentMcpAttachmentRepository();
    // Diff old → new so we can re-propagate only the affected servers.
    const before = new Set(await attRepo.listForRole(roleId));
    await attRepo.setForRole(roleId, input.serverIds);
    const after = new Set(input.serverIds);
    const changed = new Set<string>();
    for (const id of before) if (!after.has(id)) changed.add(id);
    for (const id of after) if (!before.has(id)) changed.add(id);
    // Stage 3.3 cli-bridge: re-propagate each changed server. Add/remove
    // logic depends on whether the server still has any attached role
    // using a given runtime — propagateMcpToClis recomputes from scratch.
    const propagationDiagnostics: Array<{ serverId: string; warnings: string[]; errors: Array<{ cli: string; phase: string; message: string }> }> = [];
    if (changed.size > 0) {
      const { propagateMcpToClis } = await import(
        "../services/cli-bridge/mcp-propagator"
      );
      await Promise.all(
        [...changed].map(async (sid) => {
          try {
            const r = await propagateMcpToClis(sid);
            if (r.errors.length > 0 || r.warnings.length > 0) {
              propagationDiagnostics.push({ serverId: sid, warnings: r.warnings, errors: r.errors });
              if (r.errors.length > 0) {
                console.warn(`[cli-bridge] PUT /agents/${roleId}/mcp-servers propagation errors for ${sid}:`, r.errors);
              }
            }
          } catch (err) {
            console.warn(`[cli-bridge] PUT /agents/${roleId}/mcp-servers propagateMcpToClis(${sid}) threw:`, err);
          }
        }),
      );
    }
    return {
      ok: true,
      ...(propagationDiagnostics.length > 0 ? { data: { propagationDiagnostics } } : {}),
    };
  });
}
