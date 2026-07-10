import { listClaudeCodeMcpServers } from "./claude-code-bridge";
import { listCodexMcpServers } from "./codex-bridge";
import { listOpenCodeMcpServers } from "./opencode-bridge";
import { scanSkills } from "./skills-pool-scanner";
import type { CliRuntime, ExternalMcpServer } from "./types";

export type CliBridgeScan = {
  skills: Awaited<ReturnType<typeof scanSkills>>;
  mcpByCli: Record<CliRuntime, ExternalMcpServer[]>;
  errors: Array<{ cli: CliRuntime | "skills"; message: string }>;
};

/**
 * Default redacts secrets in raw configs — the scan output reaches API
 * responses (/cli-bridge/scan, /cli-bridge/drift) and the Settings UI.
 * Pass `{ redact: false }` ONLY in trusted server-internal flows (currently
 * just the import handler, which needs the real Authorization / env values
 * to persist + propagate).
 */
export async function scanCliBridges(
  options: { redact?: boolean } = {},
): Promise<CliBridgeScan> {
  const redact = options.redact ?? true;
  const errors: CliBridgeScan["errors"] = [];

  const skills = await scanSkills().catch((e) => {
    errors.push({ cli: "skills", message: e instanceof Error ? e.message : String(e) });
    return { inPool: [], cliPrivate: [] };
  });

  const mcpByCli: Record<CliRuntime, ExternalMcpServer[]> = {
    codex: await listCodexMcpServers({ redact }).catch((e) => {
      errors.push({ cli: "codex", message: e instanceof Error ? e.message : String(e) });
      return [];
    }),
    "claude-code": await listClaudeCodeMcpServers(undefined, { redact }).catch((e) => {
      errors.push({ cli: "claude-code", message: e instanceof Error ? e.message : String(e) });
      return [];
    }),
    opencode: await listOpenCodeMcpServers(undefined, { redact }).catch((e) => {
      errors.push({ cli: "opencode", message: e instanceof Error ? e.message : String(e) });
      return [];
    }),
    // ponytail: no external MCP scanner for kiro yet — add a lister when
    // kiro-cli exposes an `mcp list` equivalent worth bridging.
    kiro: [],
  };

  return { skills, mcpByCli, errors };
}

export type { CliRuntime, ExternalMcpServer } from "./types";
export type { SkillScanRow, SkillStatus } from "./skills-pool-scanner";
export type { DriftEntry, DriftKind } from "./drift-detector";
export { detectMcpDrift } from "./drift-detector";
