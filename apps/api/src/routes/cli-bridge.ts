import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { McpServerRepository } from "../repositories/mcp-server-repository";
import { scanCliBridges, detectMcpDrift } from "../services/cli-bridge";
import { getMcpPool } from "../services/mcp-pool-service";
import {
  promoteSkill,
  syncSkillToCli,
} from "../services/cli-bridge/skill-sync-service";

/**
 * CLI bridge routes — visibility + management of skills + MCP
 * servers across the three coding CLI runtimes (Codex, Claude
 * Code, OpenCode).
 *
 * Stage 1: read-only scan.
 * Stage 2: skills promote + push.
 * Stage 3+: MCP push/pull (TODO).
 */
export async function registerCliBridgeRoutes(app: FastifyInstance) {
  const repo = new McpServerRepository();

  app.get("/cli-bridge/scan", async () => {
    const data = await scanCliBridges();
    return { ok: true, data };
  });

  // Stage 4: on-demand MCP drift detection.
  // Compares Magister-pushed ledger vs current CLI scan; surfaces
  // removed-externally / added-externally / modified-externally entries.
  // Triggered on Settings tab open + manual refresh + post-mutation.
  // NO polling — on-demand only (per kimi M1 review).
  app.get("/cli-bridge/drift", async () => {
    const drift = await detectMcpDrift();
    return { ok: true, data: { drift } };
  });

  // Stage 2: promote a CLI-private skill into the Magister pool.
  // Body: { name, sourceCli }
  const promoteSchema = z.object({
    name: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, "must match [a-zA-Z0-9_-]"),
    sourceCli: z.enum(["codex", "claude-code", "opencode"]),
  });
  app.post("/cli-bridge/skills/promote", async (request, reply) => {
    let input: { name: string; sourceCli: "codex" | "claude-code" | "opencode" };
    try {
      input = promoteSchema.parse(request.body);
    } catch (err) {
      reply.status(400);
      return { ok: false, error: { code: "invalid_body", message: err instanceof Error ? err.message : String(err) } };
    }
    try {
      const result = await promoteSkill(input);
      return { ok: true, data: result };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: { code: "promote_failed", message: err instanceof Error ? err.message : String(err) } };
    }
  });

  // Stage 2: sync a pool skill across all participating CLIs (claude-code,
  // opencode). Idempotent — fixes "missing" symlinks.
  const syncSchema = z.object({ name: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, "must match [a-zA-Z0-9_-]") });
  app.post("/cli-bridge/skills/sync", async (request, reply) => {
    let input: { name: string };
    try {
      input = syncSchema.parse(request.body);
    } catch (err) {
      reply.status(400);
      return { ok: false, error: { code: "invalid_body", message: err instanceof Error ? err.message : String(err) } };
    }
    try {
      const result = await syncSkillToCli(input);
      return { ok: true, data: result };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: { code: "sync_failed", message: err instanceof Error ? err.message : String(err) } };
    }
  });

  // Stage 3.4: import an external MCP server (one currently registered
  // in a CLI's config) into Magister's mcp_servers table. Body identifies
  // the entry via {cli, name}. We read the current config from the
  // bridge's scan, translate to Magister's mcp_servers schema, insert a row,
  // connect via the pool, then propagate (which writes to all CLIs
  // attached to the imported-default leader role — uniform spread).
  const importSchema = z.object({
    cli: z.enum(["codex", "claude-code", "opencode"]),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9_.-]+$/, "must match [a-zA-Z0-9_.-]"),
  });
  app.post("/cli-bridge/mcp/import", async (request, reply) => {
    let input: { cli: "codex" | "claude-code" | "opencode"; name: string };
    try {
      input = importSchema.parse(request.body);
    } catch (err) {
      reply.status(400);
      return { ok: false, error: { code: "invalid_body", message: err instanceof Error ? err.message : String(err) } };
    }
    try {
      // Read the source config UNREDACTED. The scan output that flows to
      // the UI (/cli-bridge/scan, /cli-bridge/drift) goes through redaction
      // because Authorization/env can leak in API responses; but the import
      // handler needs the original values so they persist into mcp_servers
      // and get pushed to other CLIs intact. Without `redact: false` here
      // we'd persist the literal string "[REDACTED]" as the auth token and
      // overwrite the user's real Authorization in propagated CLI configs.
      const scan = await scanCliBridges({ redact: false });
      const list = scan.mcpByCli[input.cli] ?? [];
      const entry = list.find((s) => s.name === input.name || s.name.startsWith(`${input.name} (`));
      if (!entry) {
        reply.status(404);
        return { ok: false, error: { code: "not_found", message: `No external MCP server "${input.name}" found in ${input.cli}` } };
      }

      // Translate to Magister schema.
      const transport: "stdio" | "http" | "sse" =
        entry.url ? (entry.type === "sse" ? "sse" : "http") : "stdio";
      const config: Record<string, unknown> = {};
      if (entry.url) {
        config.url = entry.url;
        const headers = (entry.raw as { headers?: Record<string, string> }).headers;
        if (headers) config.headers = headers;
      } else if (entry.command) {
        config.command = entry.command;
        const env = (entry.raw as { env?: Record<string, string>; environment?: Record<string, string> }).env
          ?? (entry.raw as { environment?: Record<string, string> }).environment;
        if (env) config.env = env;
      } else {
        reply.status(400);
        return { ok: false, error: { code: "unsupported_shape", message: "External entry has neither url nor command" } };
      }

      // input.name is the bare server name. Frontend strips the
      // project-scope annotation (e.g. "playwright (/path/to/project)"
      // → "playwright") before posting; the route trusts that.
      const baseName = input.name;

      // Name-collision guard (kimi Stage 3 review).
      const existing = await repo.findByName(baseName);
      if (existing) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "name_taken",
            message: `Magister already has a server named "${baseName}" (id: ${existing.id}). Skip import to avoid duplicate; or rename the existing entry first.`,
          },
        };
      }

      // For project-scope Claude Code imports, surface a warning so
      // the user knows the future user-scope push will create a
      // shadow entry alongside the original project-scope one.
      const importWarnings: string[] = [];
      if (entry.scope?.startsWith("project:")) {
        importWarnings.push(
          `"${baseName}" is project-scope in ${entry.scope}; importing it into Magister means future Magister pushes go to user-scope, creating a SECOND entry in ~/.claude.json. Consider running 'claude mcp remove ${baseName}' in the project workspace first.`,
        );
      }

      // Insert row.
      const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date();
      await repo.create({
        id,
        name: baseName,
        transport,
        configJson: JSON.stringify(config),
        timeoutMs: null,
        enabled: true,
        trustLevel: "ask",
        createdAt: now,
        updatedAt: now,
      });
      // Default-attach to leader (same convention as POST /mcp/servers).
      const { AgentMcpAttachmentRepository } = await import(
        "../repositories/agent-mcp-attachment-repository"
      );
      const attRepo = new AgentMcpAttachmentRepository();
      await attRepo.attach("leader", id);

      // Connect via pool (so it shows up in the leader's tool list).
      const pool = getMcpPool();
      await pool.addOrRefreshServer(id);

      // Propagate to other CLIs (initially leader-only attachment →
      // no other CLIs get it; user can attach to other roles later).
      const { propagateMcpToClis } = await import(
        "../services/cli-bridge/mcp-propagator"
      );
      const propagation = await propagateMcpToClis(id);

      reply.status(201);
      return {
        ok: true,
        data: {
          id,
          propagation,
          warnings: [...importWarnings, ...propagation.warnings],
        },
      };
    } catch (err) {
      reply.status(500);
      return { ok: false, error: { code: "import_failed", message: err instanceof Error ? err.message : String(err) } };
    }
  });
}
