/**
 * MCP drift detection — compare bridge scan vs Magister-pushed ledger
 * to find:
 *   - removed externally (in ledger, not in scan)
 *   - added externally (in scan, not in ledger)
 *   - modified externally (in both, configHash mismatch)
 *
 * Stage 4 of the CLI bridge plan. On-demand only, NOT periodically
 * polled (per kimi M1 fix).
 */

import { listClaudeCodeMcpServers } from "./claude-code-bridge";
import { listCodexMcpServers } from "./codex-bridge";
import { listOpenCodeMcpServers } from "./opencode-bridge";
import { readPushedLedger, type PushedEntry } from "./pushed-ledger";
import type { CliRuntime, ExternalMcpServer } from "./types";

export type DriftKind =
  | "removed-externally"   // in ledger, NOT in scan — user removed it via CLI
  | "added-externally"     // in scan, NOT in ledger — user installed it directly
  | "modified-externally"; // in both — user mutated Magister-pushed entry

export type DriftEntry = {
  kind: DriftKind;
  cli: CliRuntime;
  name: string;
  ledger?: PushedEntry;
  scan?: ExternalMcpServer;
};

/**
 * Compute current drift state. Reads ledger + scans all 3 CLIs in
 * parallel, joins by (cli, name), classifies entries.
 */
export async function detectMcpDrift(): Promise<DriftEntry[]> {
  const [ledger, codexScan, claudeScan, opencodeScan] = await Promise.all([
    readPushedLedger(),
    listCodexMcpServers().catch(() => []),
    listClaudeCodeMcpServers().catch(() => []),
    listOpenCodeMcpServers().catch(() => []),
  ]);
  const scanByCli: Record<CliRuntime, ExternalMcpServer[]> = {
    codex: codexScan,
    "claude-code": claudeScan,
    opencode: opencodeScan,
    // ponytail: kiro has no MCP scanner yet (see cli-bridge/index.ts)
    kiro: [],
  };

  const drift: DriftEntry[] = [];

  // Pass 1: walk the ledger; find removed-externally + modified-externally.
  for (const entry of ledger) {
    const list = scanByCli[entry.cli] ?? [];
    // Match by exact name; for Claude Code, scan items may have an
    // annotation like " (workspacePath)" appended for project-scope —
    // strip before comparing.
    const match = list.find((s) => stripAnnotation(s.name) === entry.name);
    if (!match) {
      drift.push({ kind: "removed-externally", cli: entry.cli, name: entry.name, ledger: entry });
      continue;
    }
    // Check configHash drift. Reconstruct configJson from the scan
    // entry's wire shape, hash it, compare. Note: this is best-effort
    // — the scan output is the CLI's stored shape, which may not
    // round-trip exactly with what Magister originally pushed (e.g. Codex
    // adds `enabled`, `auth_status`, etc. that Magister never wrote).
    // For Stage 4 v1 we only flag DEFINITE drift (e.g. command/args/url
    // changed), not normalization noise.
    //
    // TODO(v2): implement canonical normalization of both sides —
    // extract {command, url} from the scan entry's raw field and
    // compare against a re-serialized version of ledger.configHash
    // to detect true material diff. Returning false here avoids any
    // false positives but silently misses actual "modified-externally"
    // cases.
    if (hasMaterialConfigDrift(entry, match)) {
      drift.push({ kind: "modified-externally", cli: entry.cli, name: entry.name, ledger: entry, scan: match });
    }
  }

  // Pass 2: walk each CLI's scan; find added-externally (in scan, not in ledger).
  // Annotation (` (project-path)` for Claude project-scope entries) is
  // ONLY stripped for the ledger-match lookup. The drift entry keeps
  // the full original name so the UI can distinguish entries that share
  // a base name across different scopes (e.g. `playwright` registered
  // in two project-scope `~/.claude.json` entries renders as two
  // distinguishable lines instead of two identical "playwright" rows).
  for (const cli of ["codex", "claude-code", "opencode"] as CliRuntime[]) {
    for (const entry of scanByCli[cli] ?? []) {
      const baseName = stripAnnotation(entry.name);
      const inLedger = ledger.some((l) => l.cli === cli && l.name === baseName);
      if (!inLedger) {
        drift.push({
          kind: "added-externally",
          cli,
          name: entry.name,
          scan: entry,
        });
      }
    }
  }

  return drift;
}

function stripAnnotation(name: string): string {
  return name.replace(/\s+\(.*\)$/, "");
}

/**
 * Best-effort detection of "material" config drift: did command,
 * args, or url change? Skip incidental fields (enabled, auth_status,
 * etc.) that the CLI might mutate without user intent.
 *
 * v1: always returns false to avoid false positives. The ledger's
 * configHash is the sha256 of the original configJson Magister pushed —
 * we can't perfectly invert that from the scan output without
 * canonicalizing both sides. The "removed-externally" and
 * "added-externally" cases are surfaced cleanly; "modified-externally"
 * is deferred to v2.
 *
 * TODO(v2): extract {command?, url?} from scan entry's raw field,
 * compare against ledger-stored configJson parsed fields.
 */
function hasMaterialConfigDrift(entry: PushedEntry, scan: ExternalMcpServer): boolean {
  void entry; void scan;
  return false;
}
