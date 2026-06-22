import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as spawnModule from "../../../src/lib/platform/spawn";
import type { SpawnHandle } from "../../../src/lib/platform/spawn";
import { unmarkPushed } from "../../../src/services/cli-bridge/pushed-ledger";

// CODEX_HOME must live OUTSIDE /tmp. codex-cli ≥ 0.130 enforces a
// safety rule that silently refuses to persist config when CODEX_HOME
// resolves under the system temp dir (it still prints "Added global
// MCP server 'X'" but never writes). Using the repo workspace satisfies
// the rule while still isolating per-test state via mkdtemp, and it works
// in sandboxes where $HOME is read-only.

let codexHomeDir = "";
let previousCodexHome: string | undefined;
let previousMagisterSecret: string | undefined;

type SpawnProcess = typeof spawnModule.spawnProcess;

const realSpawnProcess = spawnModule.spawnProcess;
let spawnImpl: SpawnProcess = realSpawnProcess;

mock.module("../../../src/lib/platform/spawn", () => ({
  spawnProcess: (cmd: string[], opts?: spawnModule.SpawnOptions) => spawnImpl(cmd, opts),
}));

function setSpawnMock(mockedSpawn: SpawnProcess) {
  spawnImpl = mockedSpawn;
}

function createMockSubprocess(stdout: string, exitCode = 0, stderr = ""): SpawnHandle {
  return {
    exited: Promise.resolve(exitCode),
    stdoutText: async () => stdout,
    stderrText: async () => stderr,
    kill: () => {},
    truncated: false,
  };
}

beforeEach(() => {
  spawnImpl = realSpawnProcess;
  previousCodexHome = process.env.CODEX_HOME;
  previousMagisterSecret = process.env.MAGISTER_TEST_SECRET;
  codexHomeDir = mkdtempSync(join(process.cwd(), ".tmp-codex-home-test-"));
  process.env.CODEX_HOME = codexHomeDir;
  process.env.MAGISTER_TEST_SECRET = "must-not-reach-codex";
});

afterEach(() => {
  spawnImpl = realSpawnProcess;
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  if (previousMagisterSecret === undefined) {
    delete process.env.MAGISTER_TEST_SECRET;
  } else {
    process.env.MAGISTER_TEST_SECRET = previousMagisterSecret;
  }
  if (codexHomeDir) {
    rmSync(codexHomeDir, { recursive: true, force: true });
    codexHomeDir = "";
  }
});

test("listCodexMcpServers: parses codex JSON and forwards only allowlisted env", async () => {
  const spawnMock = mock((cmd: string[], opts?: spawnModule.SpawnOptions) => {
    expect(cmd).toEqual(["codex", "mcp", "list", "--json"]);
    expect(opts?.env?.CODEX_HOME).toBe(codexHomeDir);
    expect(opts?.env?.MAGISTER_TEST_SECRET).toBeUndefined();
    return createMockSubprocess(
      JSON.stringify([
        {
          name: "local",
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "echo", args: ["hello"], env: { API_KEY: "secret" } },
        },
        {
          name: "remote",
          enabled: true,
          disabled_reason: null,
          transport: { type: "http", url: "https://example.com/mcp", bearer_token_env_var: "TOKEN" },
        },
      ]),
    );
  });
  setSpawnMock(spawnMock as unknown as SpawnProcess);
  const { listCodexMcpServers } = await import("../../../src/services/cli-bridge/codex-bridge");

  const result = await listCodexMcpServers();

  expect(result).toEqual([
    expect.objectContaining({
      name: "local",
      cli: "codex",
      source: "shell-out",
      type: "stdio",
      command: ["echo", "hello"],
    }),
    expect.objectContaining({
      name: "remote",
      cli: "codex",
      source: "shell-out",
      type: "http",
      url: "https://example.com/mcp",
    }),
  ]);
  expect(JSON.stringify(result[0]?.raw)).not.toContain("secret");
});

test("listCodexMcpServers: returns empty array for empty codex output", async () => {
  const spawnMock = mock(() => createMockSubprocess("[]\n"));
  setSpawnMock(spawnMock as unknown as SpawnProcess);
  const { listCodexMcpServers } = await import("../../../src/services/cli-bridge/codex-bridge");

  await expect(listCodexMcpServers()).resolves.toEqual([]);
});

test("addCodexMcpServer + removeCodexMcpServer use codex argv contract and ledger", async () => {
  const commands: string[][] = [];
  const spawnMock = mock((cmd: string[]) => {
    commands.push(cmd);
    return createMockSubprocess("");
  });
  setSpawnMock(spawnMock as unknown as SpawnProcess);
  const { addCodexMcpServer, removeCodexMcpServer } = await import(
    "../../../src/services/cli-bridge/codex-bridge"
  );
  const { isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  const testName = `_magister_mock_${Date.now()}`;

  try {
    await addCodexMcpServer({
      name: testName,
      transport: "stdio",
      configJson: JSON.stringify({ command: ["echo", "hello"], env: { FOO: "bar" } }),
    });
    expect(await isUcmPushed("codex", testName)).toBe(true);

    await removeCodexMcpServer(testName);
    expect(await isUcmPushed("codex", testName)).toBe(false);

    expect(commands).toEqual([
      ["codex", "mcp", "add", testName, "--env", "FOO=bar", "--", "echo", "hello"],
      ["codex", "mcp", "remove", testName],
    ]);
  } finally {
    await unmarkPushed("codex", testName).catch(() => undefined);
  }
});

test("addCodexMcpServer: HTTP url config uses --url", async () => {
  const commands: string[][] = [];
  const spawnMock = mock((cmd: string[]) => {
    commands.push(cmd);
    return createMockSubprocess("");
  });
  setSpawnMock(spawnMock as unknown as SpawnProcess);
  const { addCodexMcpServer } = await import("../../../src/services/cli-bridge/codex-bridge");
  const testName = `_magister_mock_url_${Date.now()}`;

  try {
    await addCodexMcpServer({
      name: testName,
      transport: "http",
      configJson: JSON.stringify({ url: "https://example.com/mcp" }),
    });

    expect(commands).toEqual([
      ["codex", "mcp", "add", testName, "--url", "https://example.com/mcp"],
    ]);
  } finally {
    await unmarkPushed("codex", testName).catch(() => undefined);
  }
});

test("removeCodexMcpServer tolerates codex not-found errors and clears ledger", async () => {
  const spawnMock = mock(() => createMockSubprocess("", 1, "server not found"));
  setSpawnMock(spawnMock as unknown as SpawnProcess);
  const { removeCodexMcpServer } = await import("../../../src/services/cli-bridge/codex-bridge");
  const { markPushed, isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  const testName = `_magister_mock_missing_${Date.now()}`;

  await markPushed("codex", testName, "{}");
  await removeCodexMcpServer(testName);

  expect(await isUcmPushed("codex", testName)).toBe(false);
});

// Bun.spawn does NOT forward dynamically-set env vars when `env` is
// omitted — `process.env.X = "v"` set in `beforeEach` won't reach the
// child even though our internal codex-bridge call uses an explicit
// allowlist. Tests that shell out directly must pass `env: process.env`
// so the per-test CODEX_HOME actually applies. (Bun runtime 1.3.12.)
const spawnEnv = () => process.env;

async function runCodexExit(args: string[]): Promise<number | null> {
  try {
    const proc = Bun.spawn({
      cmd: ["codex", ...args],
      env: spawnEnv(),
      stdout: "ignore",
      stderr: "ignore",
    });
    return await proc.exited;
  } catch {
    return null;
  }
}

async function codexCliAvailable(): Promise<boolean> {
  return (await runCodexExit(["--version"])) === 0;
}

function shouldRunCodexIntegration(): boolean {
  return process.env.RUN_CODEX_INTEGRATION === "1";
}

test("listCodexMcpServers: tolerates roundtrip via codex mcp add/remove", async () => {
  if (!shouldRunCodexIntegration()) return;
  // This is more of an integration smoke; if codex is installed we can
  // verify the parser handles a real entry. Use a unique name to avoid
  // colliding with anything the user might have.
  const { listCodexMcpServers } = await import("../../../src/services/cli-bridge/codex-bridge");
  const testName = `_magister_test_${Date.now()}`;
  const addExit = await runCodexExit(["mcp", "add", testName, "--", "echo", "hello"]);
  if (addExit !== 0) return; // codex unavailable, incompatible, or denied — skip

  try {
    const list = await listCodexMcpServers();
    const found = list.find((s) => s.name === testName);
    expect(found).toBeDefined();
    expect(found?.cli).toBe("codex");
    expect(found?.command).toEqual(["echo", "hello"]);
  } finally {
    await runCodexExit(["mcp", "remove", testName]);
  }
});

test("addCodexMcpServer + removeCodexMcpServer roundtrip with ledger", async () => {
  if (!shouldRunCodexIntegration()) return;
  const { addCodexMcpServer, removeCodexMcpServer, listCodexMcpServers } = await import(
    "../../../src/services/cli-bridge/codex-bridge"
  );
  const { isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");

  if (!(await codexCliAvailable())) return;

  const testName = `_magister_test_${Date.now()}`;
  try {
    await addCodexMcpServer({
      name: testName,
      transport: "stdio",
      configJson: JSON.stringify({ command: ["echo", "hello"] }),
    });
    expect(await isUcmPushed("codex", testName)).toBe(true);
    const list = await listCodexMcpServers();
    const found = list.find((s) => s.name === testName);
    expect(found).toBeDefined();
    expect(found?.command).toEqual(["echo", "hello"]);

    await removeCodexMcpServer(testName);
    expect(await isUcmPushed("codex", testName)).toBe(false);
    const after = await listCodexMcpServers();
    expect(after.find((s) => s.name === testName)).toBeUndefined();
  } finally {
    // Best-effort cleanup in case the test bailed mid-flow.
    await runCodexExit(["mcp", "remove", testName]);
    await unmarkPushed("codex", testName).catch(() => undefined);
  }
});

test("addCodexMcpServer: HTTP url config", async () => {
  if (!shouldRunCodexIntegration()) return;
  const { addCodexMcpServer, listCodexMcpServers, removeCodexMcpServer } = await import(
    "../../../src/services/cli-bridge/codex-bridge"
  );
  if (!(await codexCliAvailable())) return;

  const testName = `_magister_test_url_${Date.now()}`;
  try {
    await addCodexMcpServer({
      name: testName,
      transport: "http",
      configJson: JSON.stringify({ url: "https://example.com/mcp" }),
    });
    const list = await listCodexMcpServers();
    const found = list.find((s) => s.name === testName);
    expect(found?.url).toBe("https://example.com/mcp");
  } finally {
    await runCodexExit(["mcp", "remove", testName]);
    await unmarkPushed("codex", testName).catch(() => undefined);
  }
}, 20_000); // spawns the real codex binary 2×; the default 5s can be lost under full-suite load

test("addCodexMcpServer: rejects empty config", async () => {
  const { addCodexMcpServer } = await import("../../../src/services/cli-bridge/codex-bridge");
  await expect(
    addCodexMcpServer({ name: "empty", transport: "stdio", configJson: "{}" }),
  ).rejects.toThrow(/unsupported config shape/);
});
