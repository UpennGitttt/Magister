import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { spawnProcess } from "../../lib/platform/spawn";
import { markPushed, unmarkPushed } from "./pushed-ledger";
import { redactMcpConfig } from "./redaction";
import type { ExternalMcpServer } from "./types";

function claudeConfigPath(home: string): string {
  return join(home, ".claude.json");
}

type ClaudeMcpConfig = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

type ClaudeJson = {
  mcpServers?: Record<string, ClaudeMcpConfig>;
  projects?: Record<string, { mcpServers?: Record<string, ClaudeMcpConfig> }>;
};

function toExternal(
  name: string,
  scope: string,
  cfg: ClaudeMcpConfig,
  redact: boolean,
): ExternalMcpServer {
  const resolvedType: ExternalMcpServer["type"] =
    typeof cfg.type === "string"
      ? (cfg.type as NonNullable<ExternalMcpServer["type"]>)
      : cfg.url
        ? "http"
        : "stdio";
  const rawObj = cfg as unknown as Record<string, unknown>;
  return {
    name,
    cli: "claude-code",
    source: "config-file",
    scope,
    type: resolvedType,
    ...(typeof cfg.command === "string"
      ? { command: [cfg.command, ...(cfg.args ?? [])] }
      : {}),
    ...(typeof cfg.url === "string" ? { url: cfg.url } : {}),
    raw: redact ? redactMcpConfig(rawObj) : rawObj,
  };
}

/**
 * `redact: false` is required by the import path (POST /cli-bridge/mcp/import)
 * so original auth headers / env survive into Magister. Default `true` for any
 * caller whose output reaches the UI or external API responses.
 */
export async function listClaudeCodeMcpServers(
  homeDir: string = homedir(),
  options: { redact?: boolean } = {},
): Promise<ExternalMcpServer[]> {
  const redact = options.redact ?? true;
  let raw: string;
  try {
    raw = await readFile(claudeConfigPath(homeDir), "utf8");
  } catch {
    return [];
  }
  let data: ClaudeJson;
  try {
    data = JSON.parse(raw) as ClaudeJson;
  } catch {
    return [];
  }

  const out: ExternalMcpServer[] = [];

  for (const [name, cfg] of Object.entries(data.mcpServers ?? {})) {
    out.push(toExternal(name, "user", cfg, redact));
  }

  for (const [projectPath, p] of Object.entries(data.projects ?? {})) {
    for (const [name, cfg] of Object.entries(p.mcpServers ?? {})) {
      const ext = toExternal(name, `project: ${projectPath}`, cfg, redact);
      out.push({ ...ext, name: `${name} (${projectPath})` });
    }
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
 * Push an MCP server to Claude Code via `claude mcp add-json --scope user`.
 *
 * Workflow:
 *   1. Parse ~/.claude.json projects map for any same-name server in
 *      project-scope; collect warnings (kimi C3 fix).
 *   2. Pre-emptively `claude mcp remove NAME` to handle Claude's
 *      unverified upsert behavior — remove-then-add guarantees a
 *      clean replace.
 *   3. `claude mcp add-json NAME JSON --scope user`.
 *   4. Mark in pushed-ledger.
 *
 * Returns warnings; caller surfaces in UI.
 */
export async function addClaudeMcpServer(spec: McpServerSpec): Promise<{
  ok: boolean;
  warnings: string[];
}> {
  const cfg = JSON.parse(spec.configJson) as McpConfigShape;
  const warnings: string[] = [];

  // (1) Collision detection against project-scope.
  try {
    const raw = await readFile(claudeConfigPath(homedir()), "utf8");
    const data = JSON.parse(raw) as ClaudeJson;
    for (const [projectPath, p] of Object.entries(data.projects ?? {})) {
      if (p.mcpServers && spec.name in p.mcpServers) {
        warnings.push(
          `Project-scope .mcp.json in ${projectPath} also defines "${spec.name}". Magister's user-scope push will be silently overridden in that workspace.`,
        );
      }
    }
  } catch {
    // ~/.claude.json missing or corrupt — skip collision check.
  }

  // (2) Translate Magister config → Claude Code MCP JSON schema.
  const claudeJson: Record<string, unknown> = {};
  if (cfg.url) {
    claudeJson.type = spec.transport === "sse" ? "sse" : "http";
    claudeJson.url = cfg.url;
    if (cfg.headers) claudeJson.headers = cfg.headers;
  } else if (Array.isArray(cfg.command) && cfg.command.length > 0) {
    claudeJson.type = "stdio";
    claudeJson.command = cfg.command[0];
    claudeJson.args = cfg.command.slice(1);
    if (cfg.env) claudeJson.env = cfg.env;
  } else {
    throw new Error(`addClaudeMcpServer: unsupported config shape — needs url or command[]`);
  }

  // (3) Remove first (best-effort) so the add is a clean replace.
  await spawnProcess(["claude", "mcp", "remove", spec.name]).exited;

  const addProc = spawnProcess([
    "claude",
    "mcp",
    "add-json",
    spec.name,
    JSON.stringify(claudeJson),
    "--scope",
    "user",
  ]);
  const exit = await addProc.exited;
  if (exit !== 0) {
    const stderr = await addProc.stderrText();
    throw new Error(`claude mcp add-json failed (exit ${exit}): ${stderr.trim()}`);
  }

  // (4) Mark.
  await markPushed("claude-code", spec.name, spec.configJson);
  return { ok: true, warnings };
}

export async function removeClaudeMcpServer(name: string): Promise<void> {
  const proc = spawnProcess(["claude", "mcp", "remove", name]);
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await proc.stderrText();
    if (!/not found|no such|does not exist/i.test(stderr)) {
      throw new Error(`claude mcp remove failed (exit ${exit}): ${stderr.trim()}`);
    }
  }
  await unmarkPushed("claude-code", name);
}
