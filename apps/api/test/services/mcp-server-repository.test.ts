import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-repo-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});
afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("create + listAll roundtrip", async () => {
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_test_1",
    name: "fs-local",
    transport: "stdio",
    configJson: JSON.stringify({ command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }),
    timeoutMs: 30_000,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const all = await repo.listAll();
  expect(all).toHaveLength(1);
  expect(all[0]?.name).toBe("fs-local");
  expect(all[0]?.transport).toBe("stdio");
});

test("listEnabled filters out disabled servers", async () => {
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_a",
    name: "enabled",
    transport: "stdio",
    configJson: "{}",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await repo.create({
    id: "mcp_b",
    name: "disabled",
    transport: "stdio",
    configJson: "{}",
    enabled: false,
    createdAt: now,
    updatedAt: now,
  });
  const enabled = await repo.listEnabled();
  expect(enabled.map((s) => s.name)).toEqual(["enabled"]);
});

test("trustLevel defaults to 'ask' when not provided", async () => {
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_default_trust",
    name: "ask-default",
    transport: "stdio",
    configJson: "{}",
    enabled: true,
    // trustLevel intentionally omitted — schema default applies.
    createdAt: now,
    updatedAt: now,
  });
  const row = await repo.getById("mcp_default_trust");
  expect(row?.trustLevel).toBe("ask");
});

test("trustLevel is persisted when explicitly set to 'trusted'", async () => {
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_trusted",
    name: "trusted-server",
    transport: "stdio",
    configJson: "{}",
    enabled: true,
    trustLevel: "trusted",
    createdAt: now,
    updatedAt: now,
  });
  const row = await repo.getById("mcp_trusted");
  expect(row?.trustLevel).toBe("trusted");
});

test("update + delete", async () => {
  const { McpServerRepository } = await import(
    "../../src/repositories/mcp-server-repository"
  );
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_x",
    name: "old-name",
    transport: "stdio",
    configJson: "{}",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await repo.update("mcp_x", { name: "new-name", updatedAt: new Date() });
  const after = await repo.getById("mcp_x");
  expect(after?.name).toBe("new-name");
  await repo.deleteById("mcp_x");
  const gone = await repo.getById("mcp_x");
  expect(gone).toBeUndefined();
});
