import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempCwd = "";

beforeEach(async () => {
  tempCwd = await mkdtemp(join(tmpdir(), "magister-ledger-"));
});

afterEach(async () => {
  if (tempCwd) await rm(tempCwd, { recursive: true, force: true });
});

test("markPushed / isUcmPushed roundtrip", async () => {
  const { markPushed, isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  expect(await isUcmPushed("codex", "github", tempCwd)).toBe(false);
  await markPushed("codex", "github", JSON.stringify({ url: "https://example/mcp" }), tempCwd);
  expect(await isUcmPushed("codex", "github", tempCwd)).toBe(true);
  expect(await isUcmPushed("claude-code", "github", tempCwd)).toBe(false);
});

test("unmarkPushed removes one entry, leaves the rest", async () => {
  const { markPushed, unmarkPushed, isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("codex", "a", "{}", tempCwd);
  await markPushed("codex", "b", "{}", tempCwd);
  await unmarkPushed("codex", "a", tempCwd);
  expect(await isUcmPushed("codex", "a", tempCwd)).toBe(false);
  expect(await isUcmPushed("codex", "b", tempCwd)).toBe(true);
});

test("markPushed: same (cli, name) updates configHash and pushedAt", async () => {
  const { markPushed, readPushedLedger } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await markPushed("opencode", "fs", JSON.stringify({ command: ["echo", "hello"] }), tempCwd);
  const before = (await readPushedLedger(tempCwd))[0]!;
  // Wait a ms then re-mark with different config.
  await new Promise((r) => setTimeout(r, 5));
  await markPushed("opencode", "fs", JSON.stringify({ command: ["echo", "world"] }), tempCwd);
  const after = (await readPushedLedger(tempCwd))[0]!;
  expect(after.name).toBe("fs");
  expect(after.configHash).not.toBe(before.configHash);
  expect(after.pushedAt).toBeGreaterThan(before.pushedAt);
  expect((await readPushedLedger(tempCwd))).toHaveLength(1); // still one entry, not duplicated
});

test("readPushedLedger: empty when no pushes yet", async () => {
  const { readPushedLedger } = await import("../../../src/services/cli-bridge/pushed-ledger");
  expect(await readPushedLedger(tempCwd)).toEqual([]);
});

test("isUcmPushed: same name across two CLIs is independent", async () => {
  const { markPushed, unmarkPushed, isUcmPushed } = await import(
    "../../../src/services/cli-bridge/pushed-ledger"
  );
  await markPushed("codex", "playwright", "{}", tempCwd);
  await markPushed("claude-code", "playwright", "{}", tempCwd);
  expect(await isUcmPushed("codex", "playwright", tempCwd)).toBe(true);
  expect(await isUcmPushed("claude-code", "playwright", tempCwd)).toBe(true);
  await unmarkPushed("codex", "playwright", tempCwd);
  expect(await isUcmPushed("codex", "playwright", tempCwd)).toBe(false);
  expect(await isUcmPushed("claude-code", "playwright", tempCwd)).toBe(true);
});
