import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServerRepository } from "../../../src/repositories/mcp-server-repository";
import { McpToolPolicyRepository } from "../../../src/repositories/mcp-tool-policy-repository";
import { buildMcpToolRisk } from "../../../src/services/safe-apply/mcp-tool-risk-service";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-tool-risk-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});

afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function seedServer(input: { id: string; name: string; trustLevel?: "trusted" | "ask" }) {
  const now = new Date("2026-05-14T00:00:00.000Z");
  await new McpServerRepository().create({
    id: input.id,
    name: input.name,
    transport: "stdio",
    configJson: JSON.stringify({ command: ["echo"] }),
    timeoutMs: 1000,
    enabled: true,
    trustLevel: input.trustLevel ?? "trusted",
    createdAt: now,
    updatedAt: now,
  });
}

test("buildMcpToolRisk classifies read-only, mutating, and unknown MCP tool calls", async () => {
  await seedServer({ id: "mcp_github", name: "github" });
  await seedServer({ id: "mcp_docs", name: "docs" });
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_github",
    toolName: "create_issue",
    policy: "mutating",
  });
  await policyRepo.setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
  });

  const risk = await buildMcpToolRisk([
    { type: "tool.call", toolName: "mcp__github__create_issue" },
    { type: "tool.result", toolName: "mcp__github__create_issue" },
    { type: "tool.call", toolName: "mcp__docs__search" },
    { type: "tool.call", toolName: "mcp__docs__missing_policy" },
  ]);

  expect(risk).toEqual([
    expect.objectContaining({
      namespacedToolName: "mcp__github__create_issue",
      serverId: "mcp_github",
      policy: "mutating",
      callCount: 1,
      risk: "requires_review",
      reason: "tool_mutating",
    }),
    expect.objectContaining({
      namespacedToolName: "mcp__docs__search",
      serverId: "mcp_docs",
      policy: "read_only",
      callCount: 1,
      risk: "none",
      reason: "tool_read_only",
    }),
    expect.objectContaining({
      namespacedToolName: "mcp__docs__missing_policy",
      serverId: "mcp_docs",
      policy: "unknown",
      callCount: 1,
      risk: "requires_review",
      reason: "tool_unknown",
    }),
  ]);
});

test("buildMcpToolRisk marks sanitized name collisions as unresolved", async () => {
  await seedServer({ id: "mcp_a", name: "my.server" });
  await seedServer({ id: "mcp_b", name: "my_server" });
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId: "mcp_a",
    toolName: "run",
    policy: "read_only",
  });
  await policyRepo.setPolicy({
    serverId: "mcp_b",
    toolName: "run",
    policy: "read_only",
  });

  const risk = await buildMcpToolRisk([
    { type: "tool.call", toolName: "mcp__my_server__run" },
  ]);

  expect(risk).toEqual([
    expect.objectContaining({
      namespacedToolName: "mcp__my_server__run",
      serverId: null,
      source: "unresolved",
      policy: "unknown",
      risk: "requires_review",
      reason: "tool_unresolved",
    }),
  ]);
});

test("buildMcpToolRisk ignores non-MCP tools and built-in MCP resource helpers", async () => {
  await seedServer({ id: "mcp_docs", name: "docs" });
  await new McpToolPolicyRepository().setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
  });

  const risk = await buildMcpToolRisk([
    { type: "tool.call", toolName: "bash" },
    { type: "tool.call", toolName: "mcp_list_resources" },
    { type: "tool.call", toolName: "mcp_read_resource" },
    { type: "tool.call", toolName: "mcp__docs__search" },
  ]);

  expect(risk).toHaveLength(1);
  expect(risk[0]).toMatchObject({
    namespacedToolName: "mcp__docs__search",
    reason: "tool_read_only",
  });
});
