import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { McpServerRepository } from "../../src/repositories/mcp-server-repository";
import { McpToolPolicyRepository } from "../../src/repositories/mcp-tool-policy-repository";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-tool-policy-route-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});

afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function seedServer(id = "mcp_docs") {
  const now = new Date("2026-05-14T00:00:00.000Z");
  await new McpServerRepository().create({
    id,
    name: "docs",
    transport: "stdio",
    configJson: JSON.stringify({ command: ["echo"] }),
    timeoutMs: 1000,
    enabled: false,
    trustLevel: "trusted",
    createdAt: now,
    updatedAt: now,
  });
}

test("GET /mcp/servers/:id/tools returns persisted MCP tool policies", async () => {
  await seedServer();
  await new McpToolPolicyRepository().setPolicy({
    serverId: "mcp_docs",
    toolName: "search",
    policy: "read_only",
    rationale: "pure lookup",
  });

  const response = await buildApp().inject({
    method: "GET",
    url: "/mcp/servers/mcp_docs/tools",
  });
  const body = response.json();

  expect(response.statusCode).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.data.items).toMatchObject([
    {
      serverId: "mcp_docs",
      serverName: "docs",
      toolName: "search",
      namespacedName: "mcp__docs__search",
      policy: "read_only",
      source: "manual",
      approvalBehavior: "auto_allowed",
      approvalReason: "trusted_read_only",
      status: "saved_only",
    },
  ]);
});

test("PUT /mcp/servers/:id/tools/:toolName/policy stores a manual policy", async () => {
  await seedServer();

  const response = await buildApp().inject({
    method: "PUT",
    url: "/mcp/servers/mcp_docs/tools/search/policy",
    payload: {
      policy: "mutating",
      rationale: "writes remote state",
    },
  });
  const row = await new McpToolPolicyRepository().get("mcp_docs", "search");

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      item: {
        serverId: "mcp_docs",
        toolName: "search",
        policy: "mutating",
        source: "manual",
        approvalBehavior: "requires_approval",
        approvalReason: "tool_mutating",
      },
    },
  });
  expect(row?.policy).toBe("mutating");
  expect(row?.rationale).toBe("writes remote state");
});

test("DELETE /mcp/servers/:id deletes persisted MCP tool policies", async () => {
  const serverId = `mcp_delete_${Math.random().toString(36).slice(2, 8)}`;
  await seedServer(serverId);
  const policyRepo = new McpToolPolicyRepository();
  await policyRepo.setPolicy({
    serverId,
    toolName: "search",
    policy: "read_only",
  });

  const response = await buildApp().inject({
    method: "DELETE",
    url: `/mcp/servers/${serverId}`,
  });

  expect(response.statusCode).toBe(200);
  expect(await policyRepo.listForServer(serverId)).toEqual([]);
});
