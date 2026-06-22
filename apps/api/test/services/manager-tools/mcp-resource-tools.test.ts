import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-resource-tools-test-"));
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  // Reset the global pool's internal state so tests don't bleed
  // into one another. The pool is a process-wide singleton; we
  // poke its private maps directly (Phase 1 convention).
  const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
  const pool = getMcpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.clear();
  (pool as unknown as { clients: Map<string, unknown> }).clients.clear();
  (pool as unknown as { tools: Map<string, unknown> }).tools.clear();
  (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.clear();
  (pool as unknown as { trustLevel: Map<string, unknown> }).trustLevel.clear();
});

afterEach(async () => {
  delete process.env.MAGISTER_DB_PATH;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
  const pool = getMcpPool();
  (pool as unknown as { status: Map<string, unknown> }).status.clear();
  (pool as unknown as { clients: Map<string, unknown> }).clients.clear();
  (pool as unknown as { tools: Map<string, unknown> }).tools.clear();
  (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.clear();
  (pool as unknown as { trustLevel: Map<string, unknown> }).trustLevel.clear();
});

const tavilyOff = { enabled: false, baseUrl: "", timeoutSeconds: 0 };

describe("mcp_list_resources tool", () => {
  test("aggregates resources across all connected servers", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 0 });
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_b", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_a", { resources: true, prompts: false });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_b", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_a", {
      listResources: async () => ({ resources: [{ uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain" }] }),
    });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_b", {
      listResources: async () => ({ resources: [{ uri: "file:///b.json", name: "b.json", mimeType: "application/json" }] }),
    });

    // Attach both servers to "leader" so the role filter passes them through.
    const repo = new AgentMcpAttachmentRepository();
    await repo.attach("leader", "srv_a");
    await repo.attach("leader", "srv_b");

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_list_resources");
    expect(tool).toBeDefined();
    const result = await (tool as any).call({}, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toContain("srv_a");
    expect(result.data).toContain("file:///a.txt");
    expect(result.data).toContain("srv_b");
    expect(result.data).toContain("file:///b.json");
  });

  test("filters to one server when serverId is provided", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 0 });
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_b", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_a", { resources: true, prompts: false });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_b", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_a", {
      listResources: async () => ({ resources: [{ uri: "file:///a.txt", name: "a.txt" }] }),
    });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_b", {
      listResources: async () => ({ resources: [{ uri: "file:///b.json", name: "b.json" }] }),
    });

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_list_resources");
    const result = await (tool as any).call({ serverId: "srv_a" }, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toContain("srv_a");
    expect(result.data).not.toContain("srv_b");
  });

  test("one server hanging or failing doesn't block others (Promise.allSettled)", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_good", { kind: "connected", toolCount: 0 });
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_bad", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_good", { resources: true, prompts: false });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_bad", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_good", {
      listResources: async () => ({ resources: [{ uri: "file:///ok.txt", name: "ok.txt" }] }),
    });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_bad", {
      listResources: async () => {
        throw new Error("server exploded");
      },
    });

    // Attach both servers to "leader" so the role filter passes them through.
    const repo = new AgentMcpAttachmentRepository();
    await repo.attach("leader", "srv_good");
    await repo.attach("leader", "srv_bad");

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_list_resources");
    const result = await (tool as any).call({}, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toContain("srv_good");
    expect(result.data).toContain("file:///ok.txt");
    expect(result.data).toContain("srv_bad");
    expect(result.data).toContain("server exploded");
  });
});

describe("mcp_read_resource tool", () => {
  test("returns text content concatenated", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_a", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_a", {
      readResource: async (params: { uri: string }) => ({
        contents: [{ uri: params.uri, text: "hello world", mimeType: "text/plain" }],
      }),
    });
    // Per-agent attachment gate (spec §7.2 cluster A): pass the role-attachment check.
    await new AgentMcpAttachmentRepository().attach("leader", "srv_a");

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_read_resource");
    const result = await (tool as any).call(
      { serverId: "srv_a", uri: "file:///hello.txt" },
      { taskId: "t1", abortController: new AbortController() },
    );
    expect(result.data).toContain("hello world");
  });

  test("blob content surfaces as a placeholder", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_blob", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_blob", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_blob", {
      readResource: async () => ({
        contents: [{ uri: "file:///x.bin", blob: "AAAA", mimeType: "application/octet-stream" }],
      }),
    });
    await new AgentMcpAttachmentRepository().attach("leader", "srv_blob");

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_read_resource");
    const result = await (tool as any).call(
      { serverId: "srv_blob", uri: "file:///x.bin" },
      { taskId: "t1", abortController: new AbortController() },
    );
    expect(result.data).toMatch(/\[base64-blob.*application\/octet-stream\]/);
  });

  test("throws on disconnected server (model sees it as a hard refusal)", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );
    // Attach the (would-be) server to leader so we get PAST the attachment
    // gate; the test's actual intent is the "server attached but pool has
    // no connection" error path.
    await new AgentMcpAttachmentRepository().attach("leader", "does-not-exist");

    const tools = createLeaderTools("/tmp", tavilyOff, undefined, { spawnTeammateDescription: "x", callerRoleId: "leader" });
    const tool = tools.find((t) => t.name === "mcp_read_resource");
    await expect(
      (tool as any).call(
        { serverId: "does-not-exist", uri: "file:///x" },
        { taskId: "t1", abortController: new AbortController() },
      ),
    ).rejects.toThrow(/not connected/);
  });
});

describe("mcp_list_resources tool: per-agent filtering", () => {
  test("when serverId is omitted, only attached servers contribute", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");
    const { AgentMcpAttachmentRepository } = await import(
      "../../../src/repositories/agent-mcp-attachment-repository"
    );

    // Attach srv_a to "leader" but NOT srv_b.
    const repo = new AgentMcpAttachmentRepository();
    await repo.attach("leader", "srv_a");

    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 0 });
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_b", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_a", { resources: true, prompts: false });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_b", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_a", {
      listResources: async () => ({ resources: [{ uri: "file:///a", name: "a" }] }),
    });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_b", {
      listResources: async () => ({ resources: [{ uri: "file:///b", name: "b" }] }),
    });

    const tools = createLeaderTools(
      "/tmp",
      { enabled: false, baseUrl: "", timeoutSeconds: 0 },
      undefined,
      { spawnTeammateDescription: "x", callerRoleId: "leader" },
    );
    const tool = tools.find((t) => t.name === "mcp_list_resources");
    const result = await (tool as any).call({}, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toContain("srv_a");
    expect(result.data).toContain("file:///a");
    expect(result.data).not.toContain("srv_b");
  });

  test("explicit serverId arg bypasses the per-agent filter", async () => {
    const { createLeaderTools } = await import(
      "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter"
    );
    const { getMcpPool } = await import("../../../src/services/mcp-pool-service");

    // No attachment for "leader" → srv_a is NOT in the role's
    // attachment set, but the model passes serverId explicitly.
    const pool = getMcpPool();
    (pool as unknown as { status: Map<string, unknown> }).status.set("srv_a", { kind: "connected", toolCount: 0 });
    (pool as unknown as { capabilities: Map<string, unknown> }).capabilities.set("srv_a", { resources: true, prompts: false });
    (pool as unknown as { clients: Map<string, unknown> }).clients.set("srv_a", {
      listResources: async () => ({ resources: [{ uri: "file:///a", name: "a" }] }),
    });

    const tools = createLeaderTools(
      "/tmp",
      { enabled: false, baseUrl: "", timeoutSeconds: 0 },
      undefined,
      { spawnTeammateDescription: "x", callerRoleId: "leader" },
    );
    const tool = tools.find((t) => t.name === "mcp_list_resources");
    const result = await (tool as any).call({ serverId: "srv_a" }, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toContain("srv_a");
  });
});
