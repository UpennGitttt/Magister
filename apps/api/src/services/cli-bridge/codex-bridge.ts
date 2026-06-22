import { spawnProcess } from "../../lib/platform/spawn";
import { markPushed, unmarkPushed } from "./pushed-ledger";
import { redactMcpConfig } from "./redaction";
import type { ExternalMcpServer } from "./types";

type CodexServer = {
  name: string;
  enabled: boolean;
  disabled_reason: string | null;
  transport: {
    type: "stdio" | "http" | string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
    env_vars?: string[];
    cwd?: string | null;
    url?: string;
    bearer_token_env_var?: string | null;
  };
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  auth_status?: string;
};

// Allowlist of env vars forwarded into the codex CLI subprocess.
// Mirrors `STDIO_ENV_ALLOWLIST` in mcp-pool-service.ts — splatting
// `process.env` would leak Magister-internal secrets (ANTHROPIC_API_KEY,
// DASHSCOPE_API_KEY, FEISHU_*, ULTIMATE_*) to whatever the codex
// process decides to log, telemetry-ship, or pass into its own
// children. CODEX_HOME is the per-test isolation knob; XDG_*
// covers desktop-config-dir conventions; HTTPS_PROXY family lets
// codex hit the same upstream the parent does.
const CODEX_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "PWD",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function currentProcessEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/**
 * `redact: false` is required by the import path (POST /cli-bridge/mcp/import)
 * so the original Authorization / env values get persisted into Magister and
 * propagated. All other consumers — scan/drift endpoints, UI surfaces — must
 * use the default `true` to avoid leaking secrets in API responses.
 */
export async function listCodexMcpServers(
  options: { redact?: boolean } = {},
): Promise<ExternalMcpServer[]> {
  const redact = options.redact ?? true;
  const proc = spawnProcess(["codex", "mcp", "list", "--json"], {
    env: currentProcessEnv(),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await proc.stderrText();
    throw new Error(`codex mcp list failed (${exitCode}): ${stderr.trim()}`);
  }
  const stdout = (await proc.stdoutText()).trim();
  if (!stdout || stdout === "[]") return [];
  let servers: CodexServer[];
  try {
    servers = JSON.parse(stdout) as CodexServer[];
  } catch (err) {
    throw new Error(
      `codex mcp list --json output not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return servers.map((s): ExternalMcpServer => {
    const rawObj = s as unknown as Record<string, unknown>;
    return {
      name: s.name,
      cli: "codex",
      source: "shell-out",
      type: s.transport?.type === "http" ? "http" : "stdio",
      ...(s.transport?.command
        ? { command: [s.transport.command, ...(s.transport.args ?? [])] }
        : {}),
      ...(s.transport?.url ? { url: s.transport.url } : {}),
      raw: redact ? redactMcpConfig(rawObj) : rawObj,
    };
  });
}

export type McpServerSpec = {
  name: string;
  transport: "stdio" | "http" | "sse";
  configJson: string;
};

type ConfigShape = {
  command?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

/**
 * Push an MCP server to Codex. Idempotent — `codex mcp add` upserts
 * silently on duplicate name. Records in the Magister-pushed ledger so
 * future removals only touch Magister-pushed entries.
 *
 * Security note (single-user assumption): `--env KEY=VALUE` puts the
 * value on argv, visible via /proc/<pid>/cmdline on shared hosts.
 * Magister is single-user per SECURITY.md.
 */
export async function addCodexMcpServer(spec: McpServerSpec): Promise<void> {
  const cfg = JSON.parse(spec.configJson) as ConfigShape;
  const args = ["mcp", "add", spec.name];
  if (cfg.url) {
    args.push("--url", cfg.url);
  } else if (Array.isArray(cfg.command) && cfg.command.length > 0) {
    if (cfg.env) {
      for (const [k, v] of Object.entries(cfg.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    args.push("--", ...cfg.command);
  } else {
    throw new Error(`addCodexMcpServer: unsupported config shape — needs url or command[]`);
  }
  const proc = spawnProcess(["codex", ...args], { env: currentProcessEnv() });
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await proc.stderrText();
    throw new Error(`codex mcp add failed (exit ${exit}): ${stderr.trim()}`);
  }
  await markPushed("codex", spec.name, spec.configJson);
}

/**
 * Remove an MCP server from Codex. Tolerates "not found" (exit non-zero
 * with stderr "not found") as a success.
 */
export async function removeCodexMcpServer(name: string): Promise<void> {
  const proc = spawnProcess(["codex", "mcp", "remove", name], {
    env: currentProcessEnv(),
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const stderr = await proc.stderrText();
    if (!/not found|no such|does not exist/i.test(stderr)) {
      throw new Error(`codex mcp remove failed (exit ${exit}): ${stderr.trim()}`);
    }
  }
  await unmarkPushed("codex", name);
}
