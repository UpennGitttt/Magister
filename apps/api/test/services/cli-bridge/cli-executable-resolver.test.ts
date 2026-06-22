import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import * as spawnModule from "../../../src/lib/platform/spawn";
import type { SpawnHandle } from "../../../src/lib/platform/spawn";

type BunSpawn = typeof spawnModule.spawnProcess;
const realSpawnProcess = spawnModule.spawnProcess;
let spawnImpl: BunSpawn = realSpawnProcess;

mock.module("../../../src/lib/platform/spawn", () => ({
  spawnProcess: (cmd: string[], opts?: spawnModule.SpawnOptions) => spawnImpl(cmd, opts),
}));

function mockSubprocess(stdout: string, exitCode = 0): SpawnHandle {
  return {
    exited: Promise.resolve(exitCode),
    stdoutText: async () => stdout,
    stderrText: async () => "",
    kill: () => {},
    truncated: false,
  };
}

const tempRoot = join(process.cwd(), ".tmp-cli-executable-resolver-test");
const envKeys = [
  "HOME",
  "MAGISTER_CODEX_BIN",
  "MAGISTER_OPENCODE_BIN",
  "MAGISTER_CLAUDE_CODE_BIN",
] as const;
const originalEnv = new Map<string, string | undefined>();
for (const key of envKeys) {
  originalEnv.set(key, process.env[key]);
}

function restoreEnv() {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  restoreEnv();
  spawnImpl = realSpawnProcess;
});

afterEach(() => {
  restoreEnv();
  spawnImpl = realSpawnProcess;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("resolveCliExecutable prefers explicit command paths", async () => {
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("codex", "/custom/bin/codex");

  expect(result.command).toBe("/custom/bin/codex");
  expect(result.source).toBe("explicit");
});

test("resolveCliExecutable treats logical commandPath as auto-routed", async () => {
  spawnImpl = ((cmd: string[]) => {
    if (cmd[0] === "which") {
      return mockSubprocess("/opt/homebrew/bin/codex\n", 0);
    }
    return mockSubprocess("", 1);
  }) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("codex", "codex");

  expect(result.command).toBe("/opt/homebrew/bin/codex");
  expect(result.source).toBe("path");
});

test("resolveCliExecutable treats legacy Linux defaults as auto-routed", async () => {
  spawnImpl = ((cmd: string[]) => {
    if (cmd[0] === "which") {
      return mockSubprocess("/opt/homebrew/bin/opencode\n", 0);
    }
    return mockSubprocess("", 1);
  }) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("opencode", "/usr/bin/opencode");

  expect(result.command).toBe("/opt/homebrew/bin/opencode");
  expect(result.source).toBe("path");
});

test("resolveCliExecutable prefers runtime env override before PATH", async () => {
  process.env.MAGISTER_OPENCODE_BIN = "/env/bin/opencode";
  spawnImpl = (() => mockSubprocess("/path/bin/opencode\n", 0)) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("opencode");

  expect(result.command).toBe("/env/bin/opencode");
  expect(result.source).toBe("env");
});

test("resolveCliExecutable falls back from direct PATH to login shell PATH", async () => {
  const calls: string[][] = [];
  spawnImpl = ((cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "which") {
      return mockSubprocess("", 1);
    }
    if (cmd[0] === "bash") {
      return mockSubprocess("/opt/homebrew/bin/codex\n", 0);
    }
    return mockSubprocess("", 1);
  }) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("codex");

  expect(result.command).toBe("/opt/homebrew/bin/codex");
  expect(result.source).toBe("login_shell");
  expect(calls).toEqual([
    ["which", "codex"],
    ["bash", "-lc", "command -v codex"],
  ]);
});

test("resolveCliExecutable falls back to known installation candidates", async () => {
  const candidate = join(tempRoot, "opencode");
  writeFileSync(candidate, "#!/bin/sh\n");
  chmodSync(candidate, 0o755);
  spawnImpl = (() => mockSubprocess("", 1)) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("opencode", null, { candidates: [candidate] });

  expect(result.command).toBe(candidate);
  expect(result.source).toBe("candidate");
});

test("resolveCliExecutable returns logical command when no probe succeeds", async () => {
  spawnImpl = (() => mockSubprocess("", 1)) as BunSpawn;
  const { resolveCliExecutable } = await import("../../../src/services/cli-bridge/cli-executable-resolver");

  const result = await resolveCliExecutable("claude-code", null, { candidates: [] });

  expect(result.command).toBe("claude");
  expect(result.source).toBe("logical");
});
