import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import * as spawnModule from "../../src/lib/platform/spawn";
import type { SpawnHandle } from "../../src/lib/platform/spawn";
import {
  clearDiscoveredModelCache,
  discoverModels,
} from "../../src/services/model-discovery-service";

// Discovery now spawns through the portable `spawnProcess` seam, so we
// mock that module instead of reassigning `Bun.spawn`. The module mock
// delegates to a swappable `spawnImpl`; each test sets it to a mock and
// before/afterEach restore the real impl, so other test files importing
// this module in the same `bun test` process are unaffected.
type BunSpawn = typeof spawnModule.spawnProcess;

const realSpawnProcess = spawnModule.spawnProcess;
let spawnImpl: BunSpawn = realSpawnProcess;

mock.module("../../src/lib/platform/spawn", () => ({
  spawnProcess: (cmd: string[], opts?: spawnModule.SpawnOptions) => spawnImpl(cmd, opts),
}));

function setSpawnMock(mockedSpawn: BunSpawn) {
  spawnImpl = mockedSpawn;
}

function createMockSubprocess(stdout: string, exitCode = 0): SpawnHandle {
  return {
    exited: Promise.resolve(exitCode),
    stdoutText: async () => stdout,
    stderrText: async () => "",
    kill: () => {},
    truncated: false,
  };
}

beforeEach(() => {
  clearDiscoveredModelCache();
  spawnImpl = realSpawnProcess;
});

afterEach(() => {
  clearDiscoveredModelCache();
  spawnImpl = realSpawnProcess;
});

test("discoverModels for opencode returns parsed model list", async () => {
  const spawnMock = mock((cmd: string[]) => {
    if (cmd[0] === "which") {
      return createMockSubprocess("/home/user/.opencode/bin/opencode\n");
    }
    return createMockSubprocess("openai/gpt-4o\nalibaba-cn/kimi-k2\n");
  });
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("opencode");

  expect(models).toEqual([
    { id: "openai/gpt-4o", provider: "openai", label: "gpt-4o" },
    { id: "alibaba-cn/kimi-k2", provider: "alibaba-cn", label: "kimi-k2" },
  ]);
});

test("discoverModels for codex reads the CLI debug model catalog", async () => {
  const spawnMock = mock((cmd: string[]) => {
    if (cmd[0] === "which") {
      return createMockSubprocess("/opt/homebrew/bin/codex\n");
    }
    return createMockSubprocess(
      JSON.stringify({
        models: [
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "hidden-model", display_name: "Hidden", visibility: "hidden" },
        ],
      }),
    );
  });
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("codex");

  expect(spawnMock).toHaveBeenCalledWith(["/opt/homebrew/bin/codex", "debug", "models"], undefined);
  expect(models).toEqual([
    {
      id: "gpt-5.5",
      provider: "openai",
      label: "GPT-5.5",
      isDefault: true,
    },
  ]);
});

test("discoverModels for codex resolves logical command paths from Settings", async () => {
  const spawnMock = mock((cmd: string[]) => {
    if (cmd[0] === "which") {
      return createMockSubprocess("/opt/homebrew/bin/codex\n");
    }
    return createMockSubprocess(
      JSON.stringify({
        models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }],
      }),
    );
  });
  setSpawnMock(spawnMock as unknown as BunSpawn);

  await discoverModels("codex", "codex");

  expect(spawnMock).toHaveBeenCalledWith(["/opt/homebrew/bin/codex", "debug", "models"], undefined);
});

test("discoverModels for codex falls back to the bundled catalog when CLI discovery fails", async () => {
  const spawnMock = mock(() => createMockSubprocess("", 1));
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("codex");

  expect(models).toContainEqual({
    id: "gpt-5.4",
    provider: "openai",
    label: "gpt-5.4",
    isDefault: true,
  });
});

test("discoverModels for claude-code reads local CLI model tokens", async () => {
  const spawnMock = mock((cmd: string[]) => {
    if (cmd[0] === "which") {
      return createMockSubprocess("/usr/bin/claude\n");
    }
    if (cmd[0] === "strings") {
      return createMockSubprocess(
        [
          "claude-opus-4-7",
          "claude-opus-4-6",
          "claude-sonnet-4-6",
          "claude-opus-4-5-20251101",
          "claude-haiku-4-5",
        ].join("\n"),
      );
    }
    return createMockSubprocess("", 1);
  });
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("claude-code");

  expect(models).toContainEqual({
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "claude-opus-4-7",
  });
  expect(models).toContainEqual({
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "claude-sonnet-4-6",
    isDefault: true,
  });
  expect(models.some((model) => model.id === "claude-opus-4-5-20251101")).toBe(false);
});

test("discoverModels for claude-code falls back to the bundled catalog when local discovery fails", async () => {
  const spawnMock = mock(() => createMockSubprocess("", 1));
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("claude-code");

  expect(models).toContainEqual({
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "claude-sonnet-4-6",
    isDefault: true,
  });
});

test("discoverModels for ucm returns empty array", async () => {
  const models = await discoverModels("ucm");
  expect(models).toEqual([]);
});

test("discoverModels caches results for 60 seconds", async () => {
  const spawnMock = mock(() => createMockSubprocess("openai/gpt-4o\n"));
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const first = await discoverModels("opencode");
  const second = await discoverModels("opencode");

  expect(first).toEqual(second);
  expect(spawnMock).toHaveBeenCalledTimes(2);
});

test("discoverModels caches by runtime and command path", async () => {
  const spawnMock = mock((cmd: string[]) => createMockSubprocess(`${cmd[0]}/model\n`));
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const first = await discoverModels("opencode", "/opt/opencode-a");
  const second = await discoverModels("opencode", "/opt/opencode-b");

  expect(first[0]?.id).toBe("/opt/opencode-a/model");
  expect(second[0]?.id).toBe("/opt/opencode-b/model");
  expect(spawnMock).toHaveBeenCalledTimes(2);
});

test("discoverModels bypasses cache when refresh is requested", async () => {
  const spawnMock = mock(() => createMockSubprocess("openai/gpt-4o\n"));
  setSpawnMock(spawnMock as unknown as BunSpawn);

  await discoverModels("opencode", undefined, { refresh: true });
  await discoverModels("opencode", undefined, { refresh: true });

  expect(spawnMock).toHaveBeenCalledTimes(4);
});

test("discoverModels with missing binary returns empty array", async () => {
  const spawnMock = mock(() => {
    throw new Error("spawn ENOENT");
  });
  setSpawnMock(spawnMock as unknown as BunSpawn);

  const models = await discoverModels("opencode");
  expect(models).toEqual([]);
});
