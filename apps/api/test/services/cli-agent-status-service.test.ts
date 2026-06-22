import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import * as spawnModule from "../../src/lib/platform/spawn";
import type { SpawnHandle } from "../../src/lib/platform/spawn";

// `getCliAgentStatus` resolves install/version via `probeCliVersions`,
// which shells out through the portable `spawnProcess` seam. Mock that
// seam so we control which CLIs report a version (= "installed").
type BunSpawn = typeof spawnModule.spawnProcess;
const realSpawnProcess = spawnModule.spawnProcess;
let spawnImpl: BunSpawn = realSpawnProcess;

mock.module("../../src/lib/platform/spawn", () => ({
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

const tempRoot = join(process.cwd(), ".tmp-cli-agent-status-test");
let fakeHome: string;
let fakeCodexHome: string;
const origHome = process.env.HOME;
const origCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fakeHome = join(tempRoot, `home-${unique}`);
  fakeCodexHome = join(fakeHome, ".codex");
  // Auth file existence is read off these paths, so point HOME (and
  // CODEX_HOME) at a sandbox the test fully controls.
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".local/share/opencode"), { recursive: true });
  mkdirSync(fakeCodexHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.CODEX_HOME = fakeCodexHome;
  spawnImpl = realSpawnProcess;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = origCodexHome;
  spawnImpl = realSpawnProcess;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("maps installed (version) and authenticated (non-empty auth file) per CLI", async () => {
  // codex: installed + logged in
  // claude-code: installed but NOT logged in
  // opencode: NOT installed but auth file present (logged in)
  const versionByBin: Record<string, string> = {
    codex: "codex-cli 0.129.0",
    claude: "claude 1.2.3",
    // opencode omitted → version probe fails → not installed
  };
  spawnImpl = ((cmd: string[]) => {
    if (cmd[0] === "which") {
      const logical = cmd[1];
      return logical && versionByBin[logical]
        ? mockSubprocess(`/mock/bin/${logical}\n`, 0)
        : mockSubprocess("", 1);
    }
    if (cmd[0] === "bash") {
      const logical = (cmd[2] ?? "").split(" ").at(-1);
      return logical && versionByBin[logical]
        ? mockSubprocess(`/login/bin/${logical}\n`, 0)
        : mockSubprocess("", 1);
    }
    const rawBin = cmd[0] === "bash" ? (cmd[2] ?? "").split(" ").at(-1) : cmd[0];
    const bin = rawBin ? basename(rawBin) : undefined;
    const version = bin ? versionByBin[bin] : undefined;
    if (version) return mockSubprocess(version, 0);
    return mockSubprocess("", 1);
  }) as BunSpawn;

  // codex auth.json — non-empty → authenticated
  writeFileSync(join(fakeCodexHome, "auth.json"), JSON.stringify({ token: "x" }));
  // claude credentials — empty-ish (<= 2 bytes) → NOT authenticated
  writeFileSync(join(fakeHome, ".claude", ".credentials.json"), "{}");
  // opencode auth.json — non-empty → authenticated
  writeFileSync(
    join(fakeHome, ".local/share/opencode/auth.json"),
    JSON.stringify({ key: "y" }),
  );

  const { getCliAgentStatus } = await import("../../src/services/cli-agent-status-service");
  const statuses = await getCliAgentStatus(tempRoot);

  const byCli = (cli: string) => {
    const found = statuses.find((s) => s.cli === cli);
    if (!found) throw new Error(`status for ${cli} not found`);
    return found;
  };

  expect(statuses.map((s) => s.cli)).toEqual(["codex", "claude-code", "opencode"]);

  expect(byCli("codex").installed).toBe(true);
  expect(byCli("codex").version).toBe("codex-cli 0.129.0");
  expect(byCli("codex").authenticated).toBe(true);
  expect(byCli("codex").label).toBe("Codex");

  expect(byCli("claude-code").installed).toBe(true);
  expect(byCli("claude-code").authenticated).toBe(false); // "{}" is 2 bytes

  expect(byCli("opencode").installed).toBe(false);
  expect(byCli("opencode").version).toBeNull();
  expect(byCli("opencode").authenticated).toBe(true);
});

test("missing auth files and uninstalled CLIs report false", async () => {
  spawnImpl = (() => mockSubprocess("", 1)) as BunSpawn; // nothing installed

  const { getCliAgentStatus } = await import("../../src/services/cli-agent-status-service");
  const statuses = await getCliAgentStatus(tempRoot);

  for (const s of statuses) {
    expect(s.installed).toBe(false);
    expect(s.version).toBeNull();
    expect(s.authenticated).toBe(false);
    expect(typeof s.installHint).toBe("string");
    expect(s.installHint.length).toBeGreaterThan(0);
    expect(typeof s.loginHint).toBe("string");
    expect(s.loginHint.length).toBeGreaterThan(0);
  }
});
