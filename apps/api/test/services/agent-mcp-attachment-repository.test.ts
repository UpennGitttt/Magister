import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDb: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ama-repo-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
});
afterEach(async () => {
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("attach + listForRole roundtrip", async () => {
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "mcp_a");
  await repo.attach("leader", "mcp_b");
  await repo.attach("coder", "mcp_a");
  const leaderServers = await repo.listForRole("leader");
  expect(leaderServers.sort()).toEqual(["mcp_a", "mcp_b"]);
  const coderServers = await repo.listForRole("coder");
  expect(coderServers).toEqual(["mcp_a"]);
});

test("listForServer returns roles attached to a server", async () => {
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "mcp_x");
  await repo.attach("coder", "mcp_x");
  const roles = await repo.listForServer("mcp_x");
  expect(roles.sort()).toEqual(["coder", "leader"]);
});

test("setForRole replaces the full set atomically", async () => {
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "mcp_a");
  await repo.attach("leader", "mcp_b");
  await repo.setForRole("leader", ["mcp_b", "mcp_c"]);
  const after = await repo.listForRole("leader");
  expect(after.sort()).toEqual(["mcp_b", "mcp_c"]);
});

test("detach removes one pair, leaves the rest", async () => {
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "mcp_a");
  await repo.attach("leader", "mcp_b");
  await repo.detach("leader", "mcp_a");
  expect(await repo.listForRole("leader")).toEqual(["mcp_b"]);
});

test("detachAllForServer removes all pairs for a deleted server", async () => {
  const { AgentMcpAttachmentRepository } = await import(
    "../../src/repositories/agent-mcp-attachment-repository"
  );
  const repo = new AgentMcpAttachmentRepository();
  await repo.attach("leader", "mcp_x");
  await repo.attach("coder", "mcp_x");
  await repo.attach("leader", "mcp_other");
  await repo.detachAllForServer("mcp_x");
  expect(await repo.listForRole("leader")).toEqual(["mcp_other"]);
  expect(await repo.listForRole("coder")).toEqual([]);
});
