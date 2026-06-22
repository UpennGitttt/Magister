import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-tool-policy-repo-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});

afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("syncDiscoveredTools inserts unknown policy rows and is idempotent", async () => {
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const repo = new McpToolPolicyRepository();
  const now = new Date("2026-05-14T00:00:00.000Z");

  await repo.syncDiscoveredTools({
    serverId: "mcp_1",
    tools: [
      {
        name: "search_issues",
        description: "Search issues",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    now,
  });
  await repo.syncDiscoveredTools({
    serverId: "mcp_1",
    tools: [{ name: "search_issues", description: "Search issues v2" }],
    now,
  });

  const rows = await repo.listForServer("mcp_1");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.toolName).toBe("search_issues");
  expect(rows[0]?.policy).toBe("unknown");
  expect(rows[0]?.source).toBe("discovered");
  expect(rows[0]?.description).toBe("Search issues v2");
});

test("manual policy survives later discovery sync", async () => {
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const repo = new McpToolPolicyRepository();

  await repo.syncDiscoveredTools({
    serverId: "mcp_1",
    tools: [{ name: "get_issue", description: "Get issue" }],
  });
  await repo.setPolicy({
    serverId: "mcp_1",
    toolName: "get_issue",
    policy: "read_only",
    rationale: "Only fetches issue metadata",
  });
  await repo.syncDiscoveredTools({
    serverId: "mcp_1",
    tools: [{ name: "get_issue", description: "Get issue v2" }],
  });

  const row = await repo.get("mcp_1", "get_issue");
  expect(row?.policy).toBe("read_only");
  expect(row?.source).toBe("manual");
  expect(row?.rationale).toBe("Only fetches issue metadata");
  expect(row?.description).toBe("Get issue v2");
});

test("setPolicy can create a row before discovery and resolvePolicy defaults missing to unknown", async () => {
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const repo = new McpToolPolicyRepository();

  expect(await repo.resolvePolicy("mcp_1", "missing")).toBe("unknown");

  const row = await repo.setPolicy({
    serverId: "mcp_1",
    toolName: "delete_repo",
    policy: "mutating",
  });

  expect(row.toolName).toBe("delete_repo");
  expect(row.policy).toBe("mutating");
  expect(row.source).toBe("manual");
  expect(await repo.resolvePolicy("mcp_1", "delete_repo")).toBe("mutating");
});

test("deleteForServer removes only the target server rows", async () => {
  const { McpToolPolicyRepository } = await import(
    "../../src/repositories/mcp-tool-policy-repository"
  );
  const repo = new McpToolPolicyRepository();

  await repo.setPolicy({ serverId: "mcp_a", toolName: "x", policy: "read_only" });
  await repo.setPolicy({ serverId: "mcp_b", toolName: "x", policy: "mutating" });

  await repo.deleteForServer("mcp_a");

  expect(await repo.listForServer("mcp_a")).toEqual([]);
  expect((await repo.listForServer("mcp_b")).map((row) => row.toolName)).toEqual(["x"]);
});
