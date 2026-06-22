import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome = "";
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "opencode-bridge-"));
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
});

async function writeConfig(home: string, data: unknown) {
  const dir = join(home, ".config", "opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "opencode.json"), JSON.stringify(data));
}

async function writeLegacyConfig(home: string, data: unknown) {
  const dir = join(home, ".opencode");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "opencode.json"), JSON.stringify(data));
}

test("listOpenCodeMcpServers: returns empty when config missing", async () => {
  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  expect(await listOpenCodeMcpServers(tempHome)).toEqual([]);
});

test("listOpenCodeMcpServers: parses remote MCP entry", async () => {
  await writeConfig(tempHome, {
    mcp: { WebSearch: { type: "remote", url: "https://example/mcp", enabled: true } },
  });
  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const result = await listOpenCodeMcpServers(tempHome);
  expect(result).toHaveLength(1);
  expect(result[0]!.name).toBe("WebSearch");
  expect(result[0]!.type).toBe("remote");
  expect(result[0]!.url).toBe("https://example/mcp");
});

test("listOpenCodeMcpServers: prefers XDG_CONFIG_HOME when present", async () => {
  const xdgRoot = join(tempHome, "xdg-config");
  process.env.XDG_CONFIG_HOME = xdgRoot;
  await mkdir(join(xdgRoot, "opencode"), { recursive: true });
  await writeFile(
    join(xdgRoot, "opencode", "opencode.json"),
    JSON.stringify({ mcp: { xdg_server: { type: "remote", url: "https://xdg", enabled: true } } }),
  );
  await writeConfig(tempHome, {
    mcp: { home_server: { type: "remote", url: "https://home", enabled: true } },
  });

  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const result = await listOpenCodeMcpServers(tempHome);

  expect(result.map((item) => item.name)).toEqual(["xdg_server"]);
});

test("listOpenCodeMcpServers: falls back to legacy ~/.opencode/opencode.json", async () => {
  await writeLegacyConfig(tempHome, {
    mcp: { legacy_server: { type: "remote", url: "https://legacy", enabled: true } },
  });

  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const result = await listOpenCodeMcpServers(tempHome);

  expect(result.map((item) => item.name)).toEqual(["legacy_server"]);
});

test("listOpenCodeMcpServers: parses local MCP entry", async () => {
  await writeConfig(tempHome, {
    mcp: { fs: { type: "local", command: ["npx", "fs-mcp"], enabled: true } },
  });
  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const result = await listOpenCodeMcpServers(tempHome);
  expect(result[0]!.command).toEqual(["npx", "fs-mcp"]);
});

test("listOpenCodeMcpServers: skips disabled entries", async () => {
  await writeConfig(tempHome, {
    mcp: {
      enabled_one: { type: "remote", url: "https://e", enabled: true },
      disabled_one: { type: "remote", url: "https://d", enabled: false },
    },
  });
  const { listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const result = await listOpenCodeMcpServers(tempHome);
  expect(result.map((s) => s.name)).toEqual(["enabled_one"]);
});

test("addOpenCodeMcpServer: writes remote MCP entry to opencode.json", async () => {
  const { addOpenCodeMcpServer, listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const { isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");

  await addOpenCodeMcpServer(
    {
      name: "test-remote",
      transport: "http",
      configJson: JSON.stringify({ url: "https://example/mcp" }),
    },
    tempHome,
  );

  const list = await listOpenCodeMcpServers(tempHome);
  expect(list).toHaveLength(1);
  expect(list[0]!.name).toBe("test-remote");
  expect(list[0]!.url).toBe("https://example/mcp");
  expect(list[0]!.type).toBe("remote");
  // Note: pushed-ledger uses process.cwd() for the ledger location;
  // in this test we don't override it, so the ledger entry lands in
  // the real .magister/ — verify only that markPushed was called by
  // checking isUcmPushed (which reads the same default location).
  expect(await isUcmPushed("opencode", "test-remote")).toBe(true);
  // Cleanup the ledger entry so subsequent tests aren't polluted.
  const { unmarkPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await unmarkPushed("opencode", "test-remote");
});

test("addOpenCodeMcpServer: writes local MCP entry", async () => {
  const { addOpenCodeMcpServer, listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  await addOpenCodeMcpServer(
    {
      name: "test-local",
      transport: "stdio",
      configJson: JSON.stringify({ command: ["npx", "fs-mcp"] }),
    },
    tempHome,
  );
  const list = await listOpenCodeMcpServers(tempHome);
  expect(list[0]!.command).toEqual(["npx", "fs-mcp"]);
  const { unmarkPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await unmarkPushed("opencode", "test-local");
});

test("removeOpenCodeMcpServer: drops entry + ledger row", async () => {
  const { addOpenCodeMcpServer, removeOpenCodeMcpServer, listOpenCodeMcpServers } = await import(
    "../../../src/services/cli-bridge/opencode-bridge"
  );
  const { isUcmPushed } = await import("../../../src/services/cli-bridge/pushed-ledger");
  await addOpenCodeMcpServer(
    {
      name: "to-remove",
      transport: "http",
      configJson: JSON.stringify({ url: "https://x" }),
    },
    tempHome,
  );
  expect(await isUcmPushed("opencode", "to-remove")).toBe(true);
  await removeOpenCodeMcpServer("to-remove", tempHome);
  expect(await isUcmPushed("opencode", "to-remove")).toBe(false);
  expect(await listOpenCodeMcpServers(tempHome)).toEqual([]);
});

test("addOpenCodeMcpServer: rejects empty config", async () => {
  const { addOpenCodeMcpServer } = await import("../../../src/services/cli-bridge/opencode-bridge");
  await expect(
    addOpenCodeMcpServer(
      { name: "empty", transport: "stdio", configJson: "{}" },
      tempHome,
    ),
  ).rejects.toThrow(/unsupported config shape/);
});
