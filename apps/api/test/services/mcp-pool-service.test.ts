import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-pool-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});
afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("connectAllEnabled returns empty when no servers configured", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  await pool.connectAllEnabled();
  expect(pool.listTools().length).toBe(0);
  expect(pool.statusByServer()).toEqual({});
});

test("connectAllEnabled isolates failures per server", async () => {
  // We can't easily spawn a real MCP server in tests, so this
  // case relies on a stdio command we know will fail (a
  // command that doesn't exist). The pool should mark that
  // server failed and continue without crashing.
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_bad",
    name: "broken",
    transport: "stdio",
    configJson: JSON.stringify({ command: ["this-command-does-not-exist-xyzzy"] }),
    timeoutMs: 2000,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const pool = new McpPool();
  await pool.connectAllEnabled();
  const status = pool.statusByServer();
  expect(status["mcp_bad"]?.kind).toBe("failed");
  expect(pool.listTools().length).toBe(0);
});

test("dispatch on a non-connected server returns an isError result fast (no hang)", async () => {
  // The closure-held-client bug from the original review: with
  // closure dispatch this would call client.callTool on a dead
  // pipe and hang for 30s. Pool-mediated dispatch checks status
  // first and synthesizes an error.
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  const result = await pool.dispatch("does-not-exist", "any_tool", {}, { taskId: "t1" });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("not connected");
});

test("dispatch on an approval-required server with no taskId fails closed", async () => {
  // Approval gate: trustLevel defaults to "ask". Without a taskId
  // we have no audit context, so the pool refuses rather than
  // silently auto-approving.
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  // Direct injection — simulating a connected status without
  // actually spawning a server.
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_ask", {
    kind: "connected",
    toolCount: 1,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_ask", {
    callTool: async () => {
      throw new Error("should not be reached — approval gate must short-circuit");
    },
  });
  (pool as unknown as { trustLevel: Map<string, string> }).trustLevel.set("mcp_ask", "ask");

  const result = await pool.dispatch("mcp_ask", "any_tool", {}, { /* no taskId */ });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("requires approval");
});

test("disconnectAll cleanly closes all connections", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  await pool.connectAllEnabled();
  await pool.disconnectAll();
  expect(pool.listTools().length).toBe(0);
});

test("listResources / listPrompts return empty on a server that doesn't advertise the capability", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_no_caps", {
    kind: "connected",
    toolCount: 0,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_no_caps", {
    callTool: async () => ({ content: [] }),
  });
  (pool as unknown as { capabilities: Map<string, { resources: boolean; prompts: boolean }> }).capabilities.set(
    "mcp_no_caps",
    { resources: false, prompts: false },
  );

  expect(await pool.listResources("mcp_no_caps")).toEqual({ resources: [] });
  expect(await pool.listPrompts("mcp_no_caps")).toEqual({ prompts: [] });
});

test("readResource / getPrompt fail closed on a server that doesn't advertise the capability", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_no_caps", {
    kind: "connected",
    toolCount: 0,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_no_caps", {
    readResource: async () => {
      throw new Error("should not be reached");
    },
    getPrompt: async () => {
      throw new Error("should not be reached");
    },
  });
  (pool as unknown as { capabilities: Map<string, { resources: boolean; prompts: boolean }> }).capabilities.set(
    "mcp_no_caps",
    { resources: false, prompts: false },
  );

  await expect(pool.readResource("mcp_no_caps", "file:///x")).rejects.toThrow(/does not support resources/);
  await expect(pool.getPrompt("mcp_no_caps", "any", {})).rejects.toThrow(/does not support prompts/);
});

test("listResources / listPrompts on disconnected server return empty (not throw)", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  expect(await pool.listResources("does-not-exist")).toEqual({ resources: [] });
  expect(await pool.listPrompts("does-not-exist")).toEqual({ prompts: [] });
});

test("listToolsForRole filters by attached server set", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "srv_a");
  // srv_b NOT attached to leader.

  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 1 });
  (pool as unknown as { status: Map<string, unknown> }).status.set("srv_b", { kind: "connected", toolCount: 1 });
  (pool as unknown as { tools: Map<string, unknown> }).tools.set("srv_a", [{ name: "mcp__a__x" }]);
  (pool as unknown as { tools: Map<string, unknown> }).tools.set("srv_b", [{ name: "mcp__b__x" }]);

  const filtered = await pool.listToolsForRole("leader");
  expect(filtered.map((t) => (t as { name: string }).name)).toEqual(["mcp__a__x"]);
});

test("isAttachedToRole returns true only for attached (roleId, serverId) pairs", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "srv_attached");
  // srv_other is NOT attached to leader.

  const pool = new McpPool();
  expect(await pool.isAttachedToRole("srv_attached", "leader")).toBe(true);
  expect(await pool.isAttachedToRole("srv_other", "leader")).toBe(false);
  // Different role: even attached-for-leader doesn't grant for "coder".
  expect(await pool.isAttachedToRole("srv_attached", "coder")).toBe(false);
});

test("addOrRefreshServer: adds a new entry without restart, idempotent", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { McpServerRepository } = await import("../../src/repositories/mcp-server-repository");
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_hr",
    name: "hot-reload-test",
    transport: "stdio",
    configJson: JSON.stringify({ command: ["this-cmd-fails-xyzzy"] }),
    timeoutMs: 1000,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  const pool = new McpPool();
  await pool.addOrRefreshServer("mcp_hr");
  expect(pool.statusByServer()["mcp_hr"]?.kind).toBe("failed");

  // Idempotent.
  await pool.addOrRefreshServer("mcp_hr");
  expect(pool.statusByServer()["mcp_hr"]?.kind).toBe("failed");
});

test("removeServer: drops all internal state for the server", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_drop", { kind: "connected", toolCount: 0 });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_drop", { close: async () => undefined });
  (pool as unknown as { tools: Map<string, unknown> }).tools.set("mcp_drop", []);
  (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("mcp_drop", { resources: false, prompts: false });
  (pool as unknown as { trustLevel: Map<string, unknown> }).trustLevel.set("mcp_drop", "ask");

  await pool.removeServer("mcp_drop");
  expect(pool.statusByServer()["mcp_drop"]).toBeUndefined();
  expect((pool as unknown as { clients: Map<string, unknown> }).clients.has("mcp_drop")).toBe(false);
  expect((pool as unknown as { tools: Map<string, unknown> }).tools.has("mcp_drop")).toBe(false);
});

test("updateTrustLevel: changes in-memory map without reconnect", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  (pool as unknown as { trustLevel: Map<string, unknown> }).trustLevel.set("mcp_t", "ask");
  expect(pool.requiresApproval("mcp_t")).toBe(true);
  pool.updateTrustLevel("mcp_t", "trusted");
  expect(pool.requiresApproval("mcp_t")).toBe(false);
});

test("dispatch skips approval only for trusted read-only MCP tools", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
  });

  let callCount = 0;
  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_docs", {
    kind: "connected",
    toolCount: 1,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_docs", {
    callTool: async () => {
      callCount++;
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  (pool as unknown as { trustLevel: Map<string, string> }).trustLevel.set("mcp_docs", "trusted");

  const result = await pool.dispatch("mcp_docs", "search", {}, { /* no taskId */ });

  expect(result.isError).toBeUndefined();
  expect(callCount).toBe(1);
});

test("dispatch requires approval for trusted mutating or unknown MCP tools", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_write",
    toolName: "write",
    policy: "mutating",
  });

  const pool = new McpPool();
  for (const serverId of ["mcp_write", "mcp_unknown"]) {
    (pool as unknown as { status: Map<string, unknown> }).status.set(serverId, {
      kind: "connected",
      toolCount: 1,
    });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set(serverId, {
      callTool: async () => {
        throw new Error("should not be reached");
      },
    });
    (pool as unknown as { trustLevel: Map<string, string> }).trustLevel.set(serverId, "trusted");
  }

  const mutating = await pool.dispatch("mcp_write", "write", {}, { /* no taskId */ });
  const unknown = await pool.dispatch("mcp_unknown", "missing_policy", {}, { /* no taskId */ });

  expect(mutating.isError).toBe(true);
  expect(mutating.content[0]?.text).toContain("requires approval");
  expect(unknown.isError).toBe(true);
  expect(unknown.content[0]?.text).toContain("requires approval");
});

test("dispatch requires approval for ask servers even when the tool is read-only", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
  });

  const pool = new McpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_docs", {
    kind: "connected",
    toolCount: 1,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set("mcp_docs", {
    callTool: async () => {
      throw new Error("should not be reached");
    },
  });
  (pool as unknown as { trustLevel: Map<string, string> }).trustLevel.set("mcp_docs", "ask");

  const result = await pool.dispatch("mcp_docs", "search", {}, { /* no taskId */ });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("requires approval");
});

test("refreshToolPolicies updates in-memory LeaderTool safety flags without reconnect", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const pool = new McpPool();
  const discoveredTool = {
    name: "search",
    description: "Search docs",
    inputSchema: { type: "object" as const, properties: {} },
  };
  (pool as unknown as { discoveredTools: Map<string, unknown> }).discoveredTools.set("mcp_docs", {
    serverName: "docs",
    tools: [discoveredTool],
  });
  (pool as unknown as { tools: Map<string, unknown> }).tools.set("mcp_docs", [
    { name: "mcp__docs__search", isReadOnly: () => false, isPlanSafe: () => false },
  ]);
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_docs", {
    kind: "connected",
    toolCount: 1,
  });
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
  });

  await pool.refreshToolPolicies("mcp_docs");

  const [tool] = pool.listTools();
  expect(tool?.isReadOnly?.({})).toBe(true);
  expect(tool?.isPlanSafe?.({})).toBe(true);
});

// 2026-05-16 regression: a `beforeExit` cleanup was wired alongside
// SIGTERM/SIGINT, which fires whenever the event loop briefly drains
// (between two awaits). The cleanup called `disconnectAll()` which
// `status.clear()`ed the pool, so a second `dispatch()` immediately
// after the first saw `status: unknown` even though the stdio child
// was alive. Discovered by an E2E probe that did
// `await dispatch(echo); await dispatch(add)` — the second call
// returned `MCP server ... is not connected`. Fix: drop the
// `beforeExit` registration; SIGTERM/SIGINT cover graceful shutdown.
test("`beforeExit` does not clear pool state mid-script", async () => {
  const { McpPool } = await import("../../src/services/mcp-pool-service");
  const pool = new McpPool();
  // Manually populate state so we don't need a real stdio child.
  (pool as unknown as { status: Map<string, unknown> }).status.set("mcp_x", {
    kind: "connected",
    toolCount: 1,
  });
  (pool as unknown as { clients: Map<string, unknown> }).clients.set(
    "mcp_x",
    { close: async () => undefined },
  );
  // Force the shutdown wire (private — invoke via a captured spy on
  // process.once instead of touching internals). Trigger by faking
  // an empty connectAllEnabled — that path calls wireShutdownSignals.
  await pool.connectAllEnabled();
  // Emit beforeExit synthetically. After this, status must STILL be
  // there. If `beforeExit` were wired to disconnectAll, the next
  // line would observe an empty status map.
  process.emit("beforeExit" as never, 0 as never);
  // Yield once so any synthetic listener has a chance to run.
  await new Promise((r) => setImmediate(r));
  expect(pool.statusByServer()["mcp_x"]).toEqual({
    kind: "connected",
    toolCount: 1,
  });
});
