/**
 * MCP propagation — bridges Magister's mcp_servers + agent_mcp_attachments
 * tables into the right CLI configs (Codex / Claude Code / OpenCode).
 *
 * Uses A方案 attachment semantics: per-runtime, not per-role. A server
 * attached to ANY role using runtime X gets pushed to that CLI's config
 * (because CLI subprocesses share the runtime-level config file). When
 * detached from the LAST role using a runtime, removed from that CLI.
 *
 * Removal safety (kimi I1): only call removeXxxMcpServer when
 * `isUcmPushed(cli, name)` returns true. Servers the user installed
 * directly (e.g. via `codex mcp add`) are never touched by Magister, even
 * if their name happens to match a Magister server later detached from a
 * role.
 */

import { McpServerRepository } from "../../repositories/mcp-server-repository";
import { AgentMcpAttachmentRepository } from "../../repositories/agent-mcp-attachment-repository";
import { listAgentProfiles } from "../agent-profile-service";

import {
  addCodexMcpServer,
  removeCodexMcpServer,
} from "./codex-bridge";
import {
  addClaudeMcpServer,
  removeClaudeMcpServer,
} from "./claude-code-bridge";
import {
  addOpenCodeMcpServer,
  removeOpenCodeMcpServer,
} from "./opencode-bridge";
import { isUcmPushed } from "./pushed-ledger";
import type { CliRuntime } from "./types";

const PROPAGATABLE_RUNTIMES: CliRuntime[] = ["codex", "claude-code", "opencode"];

export type PropagationResult = {
  serverId: string;
  serverName: string;
  pushed: CliRuntime[];          // CLIs we pushed to (markPushed called)
  removed: CliRuntime[];         // CLIs we removed from (after isUcmPushed gate)
  skippedUserOwned: CliRuntime[]; // CLIs where the entry exists but Magister didn't write it; skipped
  warnings: string[];
  errors: Array<{ cli: CliRuntime; phase: "push" | "remove"; message: string }>;
};

/**
 * Compute which CLI runtimes should have this server based on the
 * attachment table × agent profiles. Returns a Set for O(1) checks.
 */
async function computeTargetRuntimes(serverId: string): Promise<Set<CliRuntime>> {
  const attRepo = new AgentMcpAttachmentRepository();
  const attachedRoles = await attRepo.listForServer(serverId);
  if (attachedRoles.length === 0) return new Set();
  const profiles = await listAgentProfiles();
  const set = new Set<CliRuntime>();
  for (const role of attachedRoles) {
    const profile = profiles.find((p) => p.roleId === role);
    const rt = profile?.runtimeType ?? "ucm";
    if ((PROPAGATABLE_RUNTIMES as string[]).includes(rt)) {
      set.add(rt as CliRuntime);
    }
    // ucm runtime is intentionally not propagated — leader/evaluator
    // see Magister's own pool directly via the per-agent attachment filter.
  }
  return set;
}

/**
 * Propagate the current Magister state (server config + attachments) to all
 * CLI configs. Computes the diff between (a) what CLIs SHOULD have this
 * server per attachment, and (b) what CLIs currently have it pushed by
 * Magister (via the ledger). Pushes to CLIs in (a)\(b); removes from (b)\(a).
 *
 * Called from: POST /mcp/servers (after row insert), PUT /mcp/servers/:id
 * (after config update), PUT /agents/:roleId/mcp-servers (after attachment
 * change). DELETE /mcp/servers/:id calls a different path that removes
 * from ALL CLIs (see `propagateMcpDeletion`).
 */
export async function propagateMcpToClis(serverId: string): Promise<PropagationResult> {
  const serverRepo = new McpServerRepository();
  const server = await serverRepo.getById(serverId);
  if (!server) {
    return {
      serverId,
      serverName: "",
      pushed: [],
      removed: [],
      skippedUserOwned: [],
      warnings: [],
      errors: [{ cli: "codex", phase: "push", message: "Server not found in mcp_servers" }],
    };
  }

  const result: PropagationResult = {
    serverId,
    serverName: server.name,
    pushed: [],
    removed: [],
    skippedUserOwned: [],
    warnings: [],
    errors: [],
  };

  const target = await computeTargetRuntimes(serverId);

  // Push to each target CLI.
  for (const cli of target) {
    try {
      await pushToCli(cli, server.name, server.transport, server.configJson, result);
    } catch (err) {
      result.errors.push({
        cli,
        phase: "push",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Remove from each non-target CLI, IF Magister pushed it there before.
  for (const cli of PROPAGATABLE_RUNTIMES) {
    if (target.has(cli)) continue;
    const isOurs = await isUcmPushed(cli, server.name).catch(() => false);
    if (!isOurs) {
      result.skippedUserOwned.push(cli);
      continue;
    }
    try {
      await removeFromCli(cli, server.name);
      result.removed.push(cli);
    } catch (err) {
      result.errors.push({
        cli,
        phase: "remove",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Remove a server from ALL CLIs that Magister pushed it to. Called after
 * the user deletes a server from Magister (DELETE /mcp/servers/:id).
 */
export async function propagateMcpDeletion(input: {
  serverId: string;
  serverName: string;
}): Promise<PropagationResult> {
  const result: PropagationResult = {
    serverId: input.serverId,
    serverName: input.serverName,
    pushed: [],
    removed: [],
    skippedUserOwned: [],
    warnings: [],
    errors: [],
  };
  for (const cli of PROPAGATABLE_RUNTIMES) {
    const isOurs = await isUcmPushed(cli, input.serverName).catch(() => false);
    if (!isOurs) {
      result.skippedUserOwned.push(cli);
      continue;
    }
    try {
      await removeFromCli(cli, input.serverName);
      result.removed.push(cli);
    } catch (err) {
      result.errors.push({
        cli,
        phase: "remove",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function pushToCli(
  cli: CliRuntime,
  name: string,
  transport: string,
  configJson: string,
  result: PropagationResult,
): Promise<void> {
  const spec = {
    name,
    transport: transport as "stdio" | "http" | "sse",
    configJson,
  };
  switch (cli) {
    case "codex":
      await addCodexMcpServer(spec);
      result.pushed.push(cli);
      break;
    case "claude-code": {
      const r = await addClaudeMcpServer(spec);
      result.pushed.push(cli);
      result.warnings.push(...r.warnings);
      break;
    }
    case "opencode":
      await addOpenCodeMcpServer(spec);
      result.pushed.push(cli);
      break;
  }
}

async function removeFromCli(cli: CliRuntime, name: string): Promise<void> {
  switch (cli) {
    case "codex":       return removeCodexMcpServer(name);
    case "claude-code": return removeClaudeMcpServer(name);
    case "opencode":    return removeOpenCodeMcpServer(name);
  }
}
