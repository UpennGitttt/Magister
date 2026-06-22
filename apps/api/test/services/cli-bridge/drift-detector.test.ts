import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempCwd = "";
let prevCwd = "";

beforeEach(async () => {
  tempCwd = await mkdtemp(join(tmpdir(), "drift-test-"));
  prevCwd = process.cwd();
  process.chdir(tempCwd);
});

afterEach(async () => {
  if (prevCwd) process.chdir(prevCwd);
  if (tempCwd) await rm(tempCwd, { recursive: true, force: true });
});

test("detectMcpDrift: empty ledger → only added-externally entries (or empty if CLIs have none)", async () => {
  // No ledger file exists; all scan entries therefore appear as
  // "added-externally" since Magister never pushed them. In envs with
  // no real CLI installed, the array may be empty; in envs with real
  // CLIs configured (e.g. claude-code with playwright) entries appear.
  // Key invariant: none may be "removed-externally" when ledger is empty.
  const { detectMcpDrift } = await import("../../../src/services/cli-bridge/drift-detector");
  const drift = await detectMcpDrift();
  for (const d of drift) {
    expect(d.kind).not.toBe("removed-externally");
  }
});

test("detectMcpDrift: ledger entry not in scan → removed-externally", async () => {
  // Write a ledger entry for a server that doesn't actually exist in
  // any CLI scan (CLIs won't have "ghost" since we never added it).
  const { markPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("codex", "ghost", JSON.stringify({ command: ["x"] }));

  // detectMcpDrift reads the ledger, scans CLIs (which will return
  // empty or error-fallback), and flags "ghost" as removed-externally.
  const { detectMcpDrift } = await import("../../../src/services/cli-bridge/drift-detector");
  const drift = await detectMcpDrift();
  const ghost = drift.find((d) => d.name === "ghost");
  expect(ghost?.kind).toBe("removed-externally");
  expect(ghost?.cli).toBe("codex");
});

test("detectMcpDrift: multiple ledger entries across CLIs all removed-externally", async () => {
  const { markPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("codex", "ghost-codex", JSON.stringify({ command: ["x"] }));
  await markPushed("claude-code", "ghost-claude", JSON.stringify({ url: "http://localhost:9999" }));
  await markPushed("opencode", "ghost-opencode", JSON.stringify({ command: ["y"] }));

  const { detectMcpDrift } = await import("../../../src/services/cli-bridge/drift-detector");
  const drift = await detectMcpDrift();

  const removedNames = drift
    .filter((d) => d.kind === "removed-externally")
    .map((d) => d.name);

  expect(removedNames).toContain("ghost-codex");
  expect(removedNames).toContain("ghost-claude");
  expect(removedNames).toContain("ghost-opencode");
});

test("detectMcpDrift: drift entries have correct cli + ledger fields", async () => {
  const { markPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("codex", "my-server", JSON.stringify({ command: ["mcp-server"] }));

  const { detectMcpDrift } = await import("../../../src/services/cli-bridge/drift-detector");
  const drift = await detectMcpDrift();
  const entry = drift.find((d) => d.name === "my-server" && d.cli === "codex");

  expect(entry).toBeDefined();
  expect(entry?.kind).toBe("removed-externally");
  expect(entry?.ledger).toBeDefined();
  expect(entry?.ledger?.cli).toBe("codex");
  expect(entry?.ledger?.name).toBe("my-server");
});
