/**
 * Connection pool for MCP servers. Owns one `Client` per enabled
 * server, tracks status, exposes the merged tool list to the
 * leader runtime, and runs the approval gate. Failure-isolated:
 * if one server fails to connect, the others still come up and
 * the bad server's status is `failed` for the dashboard.
 *
 * Pool-mediated dispatch: tool calls go through `pool.dispatch
 * (serverId, toolName, args, ctx)` instead of closure-held client
 * references — disconnected servers fail fast (isError result)
 * instead of hanging on a broken pipe.
 *
 * Approval gate: when `requiresApproval(serverId)` (i.e.,
 * trustLevel !== "trusted"), `dispatch` calls
 * `requestApprovalForTool` before the underlying `callTool`.
 * Without a taskId we fail closed — servers that should never
 * prompt must be explicitly set to trustLevel: "trusted".
 *
 * Lifecycle hooks: `connectAllEnabled` wires SIGTERM/SIGINT/
 * beforeExit so child stdio processes get reaped on bun --watch
 * reload / Ctrl+C. SIGKILL still leaks (no chance to clean up).
 */

import type { LeaderTool } from "./manager-automation/autonomous-loop/autonomous-types";
import { McpServerRepository } from "../repositories/mcp-server-repository";
import {
  mcpToolToLeaderTool,
  namespacedToolName,
  type McpToolDef,
  type McpDispatchResult,
} from "./mcp-tool-converter";
import type { McpPromptContent } from "./prompt-message-projection";
import {
  McpToolPolicyRepository,
  isMcpToolPolicy,
  type McpToolPolicySource,
  type McpToolPolicyValue,
} from "../repositories/mcp-tool-policy-repository";

export type McpStatus =
  | { kind: "connected"; toolCount: number }
  | { kind: "disabled" }
  | { kind: "failed"; error: string };

export type McpToolApprovalReason =
  | "server_ask"
  | "tool_unknown"
  | "tool_mutating"
  | "trusted_read_only";

export type McpToolApprovalRequirement = {
  requiresApproval: boolean;
  serverTrustLevel: "trusted" | "ask";
  policy: McpToolPolicyValue;
  reason: McpToolApprovalReason;
};

export type McpToolPolicyListItem = {
  serverId: string;
  serverName: string;
  toolName: string;
  namespacedName: string;
  policy: McpToolPolicyValue;
  source: McpToolPolicySource | "missing";
  approvalBehavior: "auto_allowed" | "requires_approval";
  approvalReason: McpToolApprovalReason;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  lastDiscoveredAt: string | null;
  status: "discovered" | "saved_only";
};

const DEFAULT_TIMEOUT_MS = 30_000;

// Allowlist of env vars passed to stdio child processes. Default
// MCP servers don't need our internal secrets (DASHSCOPE_API_KEY,
// FEISHU_*, ANTHROPIC_API_KEY) — splatting `process.env` would
// leak credentials to whatever subprocess the user registered.
// Server-specific env (e.g. `GITHUB_TOKEN` for github MCP) comes
// from the per-server `config.env` field.
const STDIO_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "PWD",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
]);

function buildStdioEnv(userEnv: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  if (userEnv) {
    for (const [k, v] of Object.entries(userEnv)) result[k] = v;
  }
  return result;
}

function isMcpToolPolicySource(value: unknown): value is McpToolPolicySource {
  return value === "discovered" || value === "manual" || value === "imported";
}

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeTrustLevel(value: unknown): "trusted" | "ask" {
  return value === "trusted" ? "trusted" : "ask";
}

function buildApprovalRequirement(
  serverTrustLevel: "trusted" | "ask",
  policy: McpToolPolicyValue,
): McpToolApprovalRequirement {
  if (serverTrustLevel !== "trusted") {
    return {
      requiresApproval: true,
      serverTrustLevel,
      policy,
      reason: "server_ask",
    };
  }
  if (policy === "read_only") {
    return {
      requiresApproval: false,
      serverTrustLevel,
      policy,
      reason: "trusted_read_only",
    };
  }
  return {
    requiresApproval: true,
    serverTrustLevel,
    policy,
    reason: policy === "mutating" ? "tool_mutating" : "tool_unknown",
  };
}

type StdioConfig = { command: string[]; env?: Record<string, string>; cwd?: string };
type RemoteConfig = { url: string; headers?: Record<string, string> };

export class McpPool {
  private clients = new Map<string, unknown>();
  private tools = new Map<string, LeaderTool[]>();
  private discoveredTools = new Map<string, { serverName: string; tools: McpToolDef[] }>();
  private status = new Map<string, McpStatus>();
  private trustLevel = new Map<string, "trusted" | "ask">();
  private capabilities = new Map<string, { resources: boolean; prompts: boolean }>();
  private signalsWired = false;

  async connectAllEnabled(): Promise<void> {
    this.wireShutdownSignals();
    const repo = new McpServerRepository();
    const servers = await repo.listEnabled();
    await Promise.all(
      servers.map((server) => {
        this.trustLevel.set(server.id, (server.trustLevel as "trusted" | "ask") ?? "ask");
        return this.connectOne(
          server.id,
          server.name,
          server.transport,
          server.configJson,
          server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      }),
    );
  }

  /** Internal helper used by addOrRefreshServer and removeServer. */
  private async closeOne(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      try {
        await (client as { close: () => Promise<void> }).close();
      } catch {
        // best-effort
      }
    }
    this.clients.delete(serverId);
    this.tools.delete(serverId);
    this.discoveredTools.delete(serverId);
    this.status.delete(serverId);
    this.capabilities.delete(serverId);
    this.trustLevel.delete(serverId);
  }

  private buildLeaderToolsForServer(input: {
    serverId: string;
    serverName: string;
    tools: McpToolDef[];
    policies: Array<{ toolName: string; policy: unknown }>;
  }): LeaderTool[] {
    const policyByTool = new Map(
      input.policies.map((row) => [
        row.toolName,
        isMcpToolPolicy(row.policy) ? row.policy : "unknown",
      ]),
    );
    const dispatchFn = this.dispatch.bind(this);
    return input.tools.map((mcpTool) =>
      mcpToolToLeaderTool({
        serverId: input.serverId,
        serverName: input.serverName,
        mcpTool,
        policy: policyByTool.get(mcpTool.name) ?? "unknown",
        dispatch: dispatchFn,
      }),
    );
  }

  /**
   * Wire process exit signals to graceful disconnect. Without
   * this, stdio MCP child processes survive `bun --watch` reloads
   * as orphans (file handles, ports, sockets); over a dev day
   * you'd accumulate dozens of zombie `npx` processes. Idempotent.
   */
  private wireShutdownSignals(): void {
    if (this.signalsWired) return;
    this.signalsWired = true;
    const cleanup = () => {
      this.disconnectAll().catch(() => undefined);
    };
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
    // 2026-05-16: do NOT wire `beforeExit`. It fires whenever the
    // event loop briefly drains (no pending I/O / timers), not just
    // on real process exit. In scripts that do `await dispatch();
    // await dispatch();` the gap between the two awaits is enough
    // for `beforeExit` to fire and clear the pool state — the next
    // dispatch then sees `status: unknown` even though the stdio
    // child is alive. SIGTERM/SIGINT cover graceful shutdown; the OS
    // reaps any leaked stdio children on hard exit. Discovered by
    // an E2E probe (echo dispatch returned `expired by user`, next
    // call returned `not connected`).
  }

  private async connectOne(
    id: string,
    name: string,
    transport: string,
    configJson: string,
    timeoutMs: number,
  ): Promise<void> {
    let parsed: StdioConfig | RemoteConfig;
    try {
      parsed = JSON.parse(configJson);
    } catch (err) {
      this.status.set(id, {
        kind: "failed",
        error: `Invalid config JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let connectedClient: { close?: () => Promise<void> } | null = null;
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "magister", version: "1.0.0" });
      connectedClient = client as { close?: () => Promise<void> };

      let transportInstance: unknown;
      if (transport === "stdio") {
        const cfg = parsed as StdioConfig;
        const { StdioClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/stdio.js"
        );
        const [cmd, ...args] = cfg.command;
        if (!cmd) {
          this.status.set(id, { kind: "failed", error: "Empty command" });
          return;
        }
        transportInstance = new StdioClientTransport({
          command: cmd,
          args,
          env: buildStdioEnv(cfg.env),
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        });
      } else if (transport === "http") {
        const cfg = parsed as RemoteConfig;
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        transportInstance = new StreamableHTTPClientTransport(new URL(cfg.url), {
          ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
        });
      } else if (transport === "sse") {
        const cfg = parsed as RemoteConfig;
        const { SSEClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/sse.js"
        );
        transportInstance = new SSEClientTransport(new URL(cfg.url), {
          ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
        });
      } else {
        this.status.set(id, { kind: "failed", error: `Unknown transport: ${transport}` });
        return;
      }

      const connectPromise = (client as { connect: (t: unknown) => Promise<void> }).connect(transportInstance);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP connect timeout after ${timeoutMs}ms`)), timeoutMs),
      );
      await Promise.race([connectPromise, timeoutPromise]);

      // Track which sub-protocols this server supports. SDK 1.x exposes
      // the negotiated capabilities via `getServerCapabilities()` after
      // connect resolves; we cache once instead of probing per-call.
      const caps = (client as { getServerCapabilities?: () => unknown }).getServerCapabilities?.() ?? {};
      this.capabilities.set(id, {
        resources: !!(caps as { resources?: unknown }).resources,
        prompts: !!(caps as { prompts?: unknown }).prompts,
      });

      const listResult = await (client as { listTools: () => Promise<{ tools: McpToolDef[] }> }).listTools();
      const policyRepo = new McpToolPolicyRepository();
      const policies = await policyRepo.syncDiscoveredTools({
        serverId: id,
        tools: listResult.tools,
      });
      const leaderTools = this.buildLeaderToolsForServer({
        serverId: id,
        serverName: name,
        tools: listResult.tools,
        policies,
      });

      this.clients.set(id, client);
      connectedClient = null;
      this.discoveredTools.set(id, { serverName: name, tools: listResult.tools });
      this.tools.set(id, leaderTools);
      this.status.set(id, { kind: "connected", toolCount: leaderTools.length });
    } catch (err) {
      if (connectedClient?.close) {
        try {
          await connectedClient.close();
        } catch {
          // best-effort
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.status.set(id, { kind: "failed", error: msg });
      console.warn(`[mcp-pool] failed to connect "${name}" (${id}): ${msg}`);
    }
  }

  async dispatch(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx?: { taskId?: string; requestId?: string; signal?: AbortSignal },
  ): Promise<McpDispatchResult> {
    const status = this.status.get(serverId);
    if (!status || status.kind !== "connected") {
      return {
        content: [
          {
            type: "text",
            text: `MCP server "${serverId}" is not connected (status: ${status?.kind ?? "unknown"}). Re-enable + restart Magister.`,
          },
        ],
        isError: true,
      };
    }
    const client = this.clients.get(serverId);
    if (!client) {
      return {
        content: [
          { type: "text", text: `MCP client for "${serverId}" missing despite status=connected (this is a bug).` },
        ],
        isError: true,
      };
    }

    const approval = await this.resolveApprovalRequirement(serverId, toolName).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: msg,
      };
    });
    if ("error" in approval) {
      return {
        content: [
          {
            type: "text",
            text: `MCP tool policy lookup failed for ${serverId}.${toolName}; refusing to call tool: ${approval.error}`,
          },
        ],
        isError: true,
      };
    }

    if (approval.requiresApproval) {
      if (!ctx?.taskId) {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool "${serverId}.${toolName}" requires approval (server=${approval.serverTrustLevel}, policy=${approval.policy}, reason=${approval.reason}) but no task context was provided. Mark the server trusted and the tool read-only, or run within a task.`,
            },
          ],
          isError: true,
        };
      }
      const { requestApprovalForTool } = await import("./command-approval-service");
      const argsPreview = JSON.stringify(args).slice(0, 200);
      const approvalInput: Parameters<typeof requestApprovalForTool>[0] = {
        taskId: ctx.taskId,
        toolKind: "mcp_tool",
        // Task-trust subject = the MCP server id. When the user
        // checks "Trust this server for the rest of this task" on a
        // prior approval card, subsequent calls to ANY tool on this
        // server short-circuit through the trust ledger (no DB row,
        // no UI prompt). 2026-05-21.
        subjectKey: serverId,
        summary: `MCP ${serverId}.${toolName} (${approval.reason}): ${argsPreview}`,
        metadata: {
          server: serverId,
          tool: toolName,
          serverTrustLevel: approval.serverTrustLevel,
          policy: approval.policy,
          approvalReason: approval.reason,
          args,
        },
      };
      if (ctx.requestId) approvalInput.requestId = ctx.requestId;
      if (ctx.signal) approvalInput.signal = ctx.signal;
      const decision = await requestApprovalForTool(approvalInput);
      if (decision !== "approved") {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool call ${serverId}.${toolName} ${decision} by user.`,
            },
          ],
          isError: true,
        };
      }
    }

    return await (client as {
      callTool: (
        params: { name: string; arguments: Record<string, unknown> },
        schema?: unknown,
        opts?: unknown,
      ) => Promise<McpDispatchResult>;
    }).callTool({ name: toolName, arguments: args }, undefined, { timeout: DEFAULT_TIMEOUT_MS });
  }

  /** Wraps an SDK client call in an 8s timeout. Without this, a
   *  server that advertises a capability but hangs on the actual
   *  call (live-locked stdio, slow remote endpoint) would freeze
   *  the slash menu / model tool call. Phase 1's `dispatch` is
   *  intentionally unwrapped — it already has its own timeout via
   *  `callTool`'s `opts.timeout`. */
  private async withCallTimeout<T>(label: string, op: () => Promise<T>, timeoutMs = 8000): Promise<T> {
    return Promise.race([
      op(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP ${label} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * List the resources a server publishes. Returns empty list if the
   * server isn't connected or doesn't advertise resources — never
   * throws for the "expected" cases (caller renders the empty list).
   * Transport errors during a real call DO throw; the built-in
   * `mcp_list_resources` tool catches and surfaces them as tool errors.
   */
  async listResources(serverId: string): Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  }> {
    const status = this.status.get(serverId);
    if (!status || status.kind !== "connected") return { resources: [] };
    if (!this.capabilities.get(serverId)?.resources) return { resources: [] };
    const client = this.clients.get(serverId);
    if (!client) return { resources: [] };
    const result = await this.withCallTimeout("listResources", () =>
      (client as {
        listResources: () => Promise<{ resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> }>;
      }).listResources(),
    );
    return { resources: result.resources ?? [] };
  }

  /**
   * Read a single resource by URI. Throws on:
   *   - server not connected
   *   - server doesn't support resources (fail-closed: explicit
   *     error, not silent empty)
   *   - transport error
   * Returns the SDK's contents array (text + blob entries).
   */
  async readResource(
    serverId: string,
    uri: string,
  ): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }> {
    const status = this.status.get(serverId);
    if (!status || status.kind !== "connected") {
      throw new Error(`MCP server "${serverId}" is not connected`);
    }
    if (!this.capabilities.get(serverId)?.resources) {
      throw new Error(`MCP server "${serverId}" does not support resources`);
    }
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`MCP client for "${serverId}" missing`);
    const result = await this.withCallTimeout("readResource", () =>
      (client as {
        readResource: (params: { uri: string }) => Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }>;
      }).readResource({ uri }),
    );
    return { contents: result.contents ?? [] };
  }

  /**
   * List the prompts a server publishes. Same empty-on-soft-failure
   * semantics as `listResources`.
   */
  async listPrompts(serverId: string): Promise<{
    prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  }> {
    const status = this.status.get(serverId);
    if (!status || status.kind !== "connected") return { prompts: [] };
    if (!this.capabilities.get(serverId)?.prompts) return { prompts: [] };
    const client = this.clients.get(serverId);
    if (!client) return { prompts: [] };
    const result = await this.withCallTimeout("listPrompts", () =>
      (client as {
        listPrompts: () => Promise<{ prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> }>;
      }).listPrompts(),
    );
    return { prompts: result.prompts ?? [] };
  }

  /**
   * Render a prompt with arguments. Throws on:
   *   - server not connected
   *   - server doesn't support prompts
   *   - transport error
   * Returns the SDK's messages array verbatim — the caller decides
   * how to project this onto a Magister first-turn message.
   */
  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<{
    messages: Array<{
      role: "user" | "assistant";
      content: McpPromptContent;
    }>;
    description?: string;
  }> {
    const status = this.status.get(serverId);
    if (!status || status.kind !== "connected") {
      throw new Error(`MCP server "${serverId}" is not connected`);
    }
    if (!this.capabilities.get(serverId)?.prompts) {
      throw new Error(`MCP server "${serverId}" does not support prompts`);
    }
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`MCP client for "${serverId}" missing`);
    const result = await this.withCallTimeout("getPrompt", () =>
      (client as {
        getPrompt: (params: { name: string; arguments: Record<string, string> }) => Promise<{
          messages: Array<unknown>;
          description?: string;
        }>;
      }).getPrompt({ name, arguments: args }),
    );
    return result as { messages: Array<{ role: "user" | "assistant"; content: McpPromptContent }>; description?: string };
  }

  async resolveApprovalRequirement(
    serverId: string,
    toolName: string,
  ): Promise<McpToolApprovalRequirement> {
    const serverTrustLevel = normalizeTrustLevel(this.trustLevel.get(serverId));
    const policy = await new McpToolPolicyRepository().resolvePolicy(serverId, toolName);
    return buildApprovalRequirement(serverTrustLevel, policy);
  }

  requiresApproval(serverId: string): boolean {
    return this.trustLevel.get(serverId) !== "trusted";
  }

  async refreshToolPolicies(serverId: string): Promise<void> {
    const discovered = this.discoveredTools.get(serverId);
    if (!discovered) return;
    const policies = await new McpToolPolicyRepository().listForServer(serverId);
    const leaderTools = this.buildLeaderToolsForServer({
      serverId,
      serverName: discovered.serverName,
      tools: discovered.tools,
      policies,
    });
    this.tools.set(serverId, leaderTools);
    const status = this.status.get(serverId);
    if (status?.kind === "connected") {
      this.status.set(serverId, { kind: "connected", toolCount: leaderTools.length });
    }
  }

  async listToolPoliciesForServer(serverId: string): Promise<McpToolPolicyListItem[]> {
    const server = await new McpServerRepository().getById(serverId);
    if (!server) return [];
    const rows = await new McpToolPolicyRepository().listForServer(serverId);
    const rowByTool = new Map(rows.map((row) => [row.toolName, row]));
    const discovered = this.discoveredTools.get(serverId);
    const discoveredByTool = new Map((discovered?.tools ?? []).map((tool) => [tool.name, tool]));
    const names = new Set<string>([...rowByTool.keys(), ...discoveredByTool.keys()]);
    const serverName = discovered?.serverName ?? server.name;
    const serverTrustLevel = normalizeTrustLevel(this.trustLevel.get(serverId) ?? server.trustLevel);
    const items: McpToolPolicyListItem[] = [];
    for (const toolName of [...names].sort((a, b) => a.localeCompare(b))) {
      const row = rowByTool.get(toolName);
      const discoveredTool = discoveredByTool.get(toolName);
      const policy = isMcpToolPolicy(row?.policy) ? row.policy : "unknown";
      const source = isMcpToolPolicySource(row?.source) ? row.source : "missing";
      const approval = buildApprovalRequirement(serverTrustLevel, policy);
      items.push({
        serverId,
        serverName,
        toolName,
        namespacedName: namespacedToolName(serverName, toolName),
        policy,
        source,
        approvalBehavior: approval.requiresApproval ? "requires_approval" : "auto_allowed",
        approvalReason: approval.reason,
        description: discoveredTool?.description ?? row?.description ?? null,
        inputSchema: discoveredTool?.inputSchema ?? parseJsonObject(row?.inputSchemaJson ?? null),
        lastDiscoveredAt: row?.lastDiscoveredAt ? row.lastDiscoveredAt.toISOString() : null,
        status: discoveredTool ? "discovered" : "saved_only",
      });
    }
    return items;
  }


  listTools(): LeaderTool[] {
    const all: LeaderTool[] = [];
    for (const list of this.tools.values()) {
      all.push(...list);
    }
    return all;
  }

  statusByServer(): Record<string, McpStatus> {
    return Object.fromEntries(this.status);
  }

  /**
   * Return the merged tool list filtered to the servers attached to
   * `roleId` per `agent_mcp_attachments`. Empty attachment set yields
   * an empty list — strict opt-in. Migration at schema bootstrap
   * preserves Phase 1 + 2 by attaching every existing agent to every
   * existing server.
   */
  async listToolsForRole(roleId: string): Promise<LeaderTool[]> {
    const { AgentMcpAttachmentRepository } = await import("../repositories/agent-mcp-attachment-repository");
    const repo = new AgentMcpAttachmentRepository();
    const attached = new Set(await repo.listForRole(roleId));
    const out: LeaderTool[] = [];
    for (const [serverId, list] of this.tools.entries()) {
      if (!attached.has(serverId)) continue;
      out.push(...list);
    }
    return out;
  }

  /**
   * Aggregate connected server IDs filtered to those attached to
   * `roleId`. Used by `mcp_list_resources` when no `serverId` arg is
   * passed, to scope discovery to the calling agent.
   */
  async listResourcesForRole(roleId: string): Promise<string[]> {
    const { AgentMcpAttachmentRepository } = await import("../repositories/agent-mcp-attachment-repository");
    const repo = new AgentMcpAttachmentRepository();
    const attached = await repo.listForRole(roleId);
    return attached.filter((id) => this.status.get(id)?.kind === "connected");
  }

  /**
   * Check whether `serverId` is attached to `roleId`. Used by the
   * resource-read tool path: `mcp_list_resources` with no `serverId`
   * arg already scopes via `listResourcesForRole`, but the explicit
   * `serverId` branch of `mcp_list_resources` and `mcp_read_resource`
   * accept a server id from the model and need to gate it before
   * dispatching, otherwise an agent could read any registered
   * server's resources by knowing its id.
   */
  async isAttachedToRole(serverId: string, roleId: string): Promise<boolean> {
    const { AgentMcpAttachmentRepository } = await import("../repositories/agent-mcp-attachment-repository");
    const repo = new AgentMcpAttachmentRepository();
    const attached = await repo.listForRole(roleId);
    return attached.includes(serverId);
  }

  /**
   * Same shape as `statusByServer()` but filtered to servers attached
   * to `roleId`. Used by `/mcp/prompts` to scope the slash-menu list
   * to the leader role.
   */
  async statusForRole(roleId: string): Promise<Record<string, McpStatus>> {
    const { AgentMcpAttachmentRepository } = await import("../repositories/agent-mcp-attachment-repository");
    const repo = new AgentMcpAttachmentRepository();
    const attached = new Set(await repo.listForRole(roleId));
    const out: Record<string, McpStatus> = {};
    for (const [serverId, status] of this.status.entries()) {
      if (attached.has(serverId)) out[serverId] = status;
    }
    return out;
  }

  /**
   * Connect (or re-connect) the server identified by `serverId`,
   * reading its current row from the `mcp_servers` table. Idempotent
   * — calling on an already-connected server tears down the old
   * client first so config changes take effect. Called from REST
   * routes after POST /mcp/servers and PUT /mcp/servers/:id.
   *
   * Affects only NEW leader runtimes; running runtimes keep their
   * already-baked tool list — the runtime tool merge in
   * manager-autonomous-runtime.ts only consults the pool at startup.
   */
  async addOrRefreshServer(serverId: string): Promise<void> {
    this.wireShutdownSignals();
    await this.closeOne(serverId);
    const repo = new McpServerRepository();
    const row = await repo.getById(serverId);
    if (!row || !row.enabled) return;
    this.trustLevel.set(row.id, (row.trustLevel as "trusted" | "ask") ?? "ask");
    await this.connectOne(
      row.id,
      row.name,
      row.transport,
      row.configJson,
      row.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * Disconnect + drop all internal state for `serverId`. Called from
   * DELETE /mcp/servers/:id and from PUT when the server is disabled.
   * Per-row attachment cleanup happens in the route layer (drop
   * agent_mcp_attachments rows for the deleted server) — this method
   * only owns the in-memory pool state.
   */
  async removeServer(serverId: string): Promise<void> {
    await this.closeOne(serverId);
  }

  /**
   * Update the in-memory trustLevel map for a server. No reconnect
   * needed — only the approval gate reads this value at dispatch
   * time. Called from PUT /mcp/servers/:id when only trustLevel
   * changed.
   */
  updateTrustLevel(serverId: string, level: "trusted" | "ask"): void {
    this.trustLevel.set(serverId, level);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await (client as { close: () => Promise<void> }).close();
      } catch {
        // best-effort
      }
    }
    this.clients.clear();
    this.tools.clear();
    this.discoveredTools.clear();
    this.status.clear();
    this.capabilities.clear();
    this.trustLevel.clear(); // also clear trustLevel — it leaks across disconnect/reconnect cycles otherwise
  }
}

let globalPool: McpPool | null = null;

export function getMcpPool(): McpPool {
  if (!globalPool) globalPool = new McpPool();
  return globalPool;
}
