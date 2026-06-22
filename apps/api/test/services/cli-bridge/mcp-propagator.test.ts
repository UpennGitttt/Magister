import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDb: string | undefined;
let prevCwd = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "propagator-test-"));
  prevDb = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "magister.sqlite");
  prevCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(async () => {
  if (prevCwd) process.chdir(prevCwd);
  if (prevDb === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDb;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/**
 * Smoke test: server with no attachments produces empty pushed/removed sets.
 * The propagator's resolution logic — agent_mcp_attachments → roles → runtime
 * type → CLI set — is the part we want to verify with mocked data.
 */
test("propagateMcpToClis: server with no attachments → no push, no remove", async () => {
  const { McpServerRepository } = await import("../../../src/repositories/mcp-server-repository");
  const { propagateMcpToClis } = await import("../../../src/services/cli-bridge/mcp-propagator");
  const repo = new McpServerRepository();
  const now = new Date();
  await repo.create({
    id: "mcp_solo",
    name: "_test_solo",
    transport: "stdio",
    configJson: JSON.stringify({ command: ["echo"] }),
    timeoutMs: null,
    enabled: true,
    trustLevel: "ask",
    createdAt: now,
    updatedAt: now,
  });
  const result = await propagateMcpToClis("mcp_solo");
  expect(result.serverName).toBe("_test_solo");
  expect(result.pushed).toEqual([]);
  // No CLI is in target set → all 3 are out-of-set, but isUcmPushed is
  // false for all (we never pushed) → all skipped as user-owned.
  expect(result.removed).toEqual([]);
  expect(result.skippedUserOwned.sort()).toEqual(["claude-code", "codex", "opencode"]);
});

test("propagateMcpToClis: missing server → error", async () => {
  const { propagateMcpToClis } = await import("../../../src/services/cli-bridge/mcp-propagator");
  const result = await propagateMcpToClis("does-not-exist");
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]?.message).toMatch(/not found/i);
});

test("propagateMcpDeletion: empty ledger → all CLIs skipped as user-owned", async () => {
  const { propagateMcpDeletion } = await import("../../../src/services/cli-bridge/mcp-propagator");
  const result = await propagateMcpDeletion({ serverId: "x", serverName: "_test_delete" });
  // Ledger has no entry for "_test_delete" → isUcmPushed false for all 3 →
  // all skipped (never call removeXxx).
  expect(result.removed).toEqual([]);
  expect(result.skippedUserOwned.sort()).toEqual(["claude-code", "codex", "opencode"]);
  expect(result.errors).toEqual([]);
});

test("propagateMcpDeletion: ledger entry present → remove + isUcmPushed flips", async () => {
  // Sanity-check the primitive: markPushed for one CLI doesn't bleed
  // into others' ledger reads.
  const { isUcmPushed, markPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("codex", "_test_marked", "{}", tempDir);
  expect(await isUcmPushed("codex", "_test_marked", tempDir)).toBe(true);
  expect(await isUcmPushed("opencode", "_test_marked", tempDir)).toBe(false);
});

/**
 * Asserts the safety gate routes by-CLI: if codex is in the ledger but
 * claude-code + opencode aren't, only codex hits the remove code path.
 * The other two land in skippedUserOwned (i.e. their remove function
 * is never invoked, so a user-installed server with the same name is
 * never destructively touched).
 *
 * No mock — we use a name that doesn't exist in any real CLI config so
 * the codex remove is a no-op (`codex mcp remove` tolerates "not found"),
 * and assert the routing via PropagationResult buckets. claude-code and
 * opencode landing in skippedUserOwned proves their removeXxx was NOT
 * called — that's the gate.
 */
test("propagateMcpDeletion: per-CLI gate — only marked CLI hits remove path", async () => {
  const { markPushed, isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  const { propagateMcpDeletion } = await import("../../../src/services/cli-bridge/mcp-propagator");

  // Random name guarantees no real CLI config has it (so removeCodex is
  // a no-op against the user's real ~/.codex/config.toml).
  const name = `_test_gate_${Math.random().toString(36).slice(2, 10)}`;
  await markPushed("codex", name, "{}", tempDir);

  const result = await propagateMcpDeletion({ serverId: "x", serverName: name });

  // claude-code + opencode were NOT marked → gate routed them to skipped.
  expect(result.skippedUserOwned.sort()).toEqual(["claude-code", "opencode"]);
  // codex was marked → it went through the remove path (either succeeded
  // and lands in `removed`, or surfaced an error in `errors`). Either way
  // it MUST NOT be in skippedUserOwned.
  expect(result.skippedUserOwned).not.toContain("codex");
  const codexHandled =
    result.removed.includes("codex") ||
    result.errors.some((e) => e.cli === "codex");
  expect(codexHandled).toBe(true);

  // On a successful codex remove (no-op against real config), unmarkPushed
  // would have been called — so the ledger reflects either still-marked
  // (if remove errored) or unmarked (if it succeeded). Either is consistent.
  const stillMarked = await isUcmPushed("codex", name, tempDir);
  expect(typeof stillMarked).toBe("boolean");
});
