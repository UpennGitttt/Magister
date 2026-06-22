import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { markPushed, unmarkPushed } from "./pushed-ledger";
import { redactMcpConfig } from "./redaction";
import type { ExternalMcpServer } from "./types";

function opencodeConfigPath(home: string): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return join(xdgConfigHome, "opencode", "opencode.json");
  }
  return join(home, ".config", "opencode", "opencode.json");
}

function opencodeReadConfigPaths(home: string): string[] {
  const paths = [opencodeConfigPath(home)];
  const defaultPath = join(home, ".config", "opencode", "opencode.json");
  if (!paths.includes(defaultPath)) {
    paths.push(defaultPath);
  }
  paths.push(join(home, ".opencode", "opencode.json"));
  return paths;
}

type OpenCodeMcpConfig = {
  type?: "remote" | "local";
  url?: string;
  headers?: Record<string, string>;
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};

type OpenCodeJson = {
  mcp?: Record<string, OpenCodeMcpConfig>;
};

/**
 * `redact: false` is required by the import path (POST /cli-bridge/mcp/import)
 * so original auth headers / env survive into Magister. Default `true` for any
 * caller whose output reaches the UI or external API responses.
 */
export async function listOpenCodeMcpServers(
  homeDir: string = homedir(),
  options: { redact?: boolean } = {},
): Promise<ExternalMcpServer[]> {
  const redact = options.redact ?? true;
  let raw = "";
  let found = false;
  for (const path of opencodeReadConfigPaths(homeDir)) {
    try {
      raw = await readFile(path, "utf8");
      found = true;
      break;
    } catch {
      // Try the next known OpenCode config location.
    }
  }
  if (!found) {
    return [];
  }
  let data: OpenCodeJson;
  try {
    data = JSON.parse(raw) as OpenCodeJson;
  } catch {
    return [];
  }
  const out: ExternalMcpServer[] = [];
  for (const [name, cfg] of Object.entries(data.mcp ?? {})) {
    if (cfg.enabled === false) continue;
    const rawObj = cfg as unknown as Record<string, unknown>;
    out.push({
      name,
      cli: "opencode",
      source: "config-file",
      type: cfg.type === "remote" ? "remote" : "local",
      ...(cfg.type === "remote" && typeof cfg.url === "string" ? { url: cfg.url } : {}),
      ...(cfg.type === "local" && Array.isArray(cfg.command) ? { command: cfg.command } : {}),
      raw: redact ? redactMcpConfig(rawObj) : rawObj,
    });
  }
  return out;
}

export type McpServerSpec = {
  name: string;
  transport: "stdio" | "http" | "sse";
  configJson: string;
};

type McpConfigShape = {
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/**
 * Push an MCP server to OpenCode by editing ~/.config/opencode/opencode.json.
 * Wrapped in `proper-lockfile` to serialize concurrent Magister writes (and
 * to fail-fast against OpenCode-itself's writes).
 */
export async function addOpenCodeMcpServer(
  spec: McpServerSpec,
  homeDir: string = homedir(),
): Promise<void> {
  const path = opencodeConfigPath(homeDir);
  // Touch the file if missing so proper-lockfile has something to lock.
  try {
    await readFile(path, "utf8");
  } catch {
    await mkdir(join(homeDir, ".config", "opencode"), { recursive: true });
    await writeFile(path, JSON.stringify({}, null, 2), "utf8");
  }
  const release = await lockfile
    .lock(path, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2000 },
      stale: 10_000,
      realpath: false,
    })
    .catch(() => null);
  try {
    const raw = await readFile(path, "utf8");
    let data: { mcp?: Record<string, unknown> };
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
    data.mcp ??= {};

    const cfg = JSON.parse(spec.configJson) as McpConfigShape;
    if (cfg.url) {
      data.mcp[spec.name] = {
        type: "remote",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        enabled: true,
      };
    } else if (Array.isArray(cfg.command) && cfg.command.length > 0) {
      data.mcp[spec.name] = {
        type: "local",
        command: cfg.command,
        ...(cfg.env ? { environment: cfg.env } : {}),
        enabled: true,
      };
    } else {
      throw new Error(`addOpenCodeMcpServer: unsupported config shape — needs url or command[]`);
    }

    // Atomic write: temp file + rename.
    const tmp = `${path}.magister-tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
    await markPushed("opencode", spec.name, spec.configJson);
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

export async function removeOpenCodeMcpServer(
  name: string,
  homeDir: string = homedir(),
): Promise<void> {
  const path = opencodeConfigPath(homeDir);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2000 },
      stale: 10_000,
      realpath: false,
    });
  } catch {
    release = null;
  }
  try {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) {
      await unmarkPushed("opencode", name);
      return;
    }
    let data: { mcp?: Record<string, unknown> };
    try {
      data = JSON.parse(raw);
    } catch {
      await unmarkPushed("opencode", name);
      return;
    }
    if (!data.mcp || !(name in data.mcp)) {
      await unmarkPushed("opencode", name);
      return;
    }
    delete data.mcp[name];
    const tmp = `${path}.magister-tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, path);
    await unmarkPushed("opencode", name);
  } finally {
    if (release) await release().catch(() => undefined);
  }
}
