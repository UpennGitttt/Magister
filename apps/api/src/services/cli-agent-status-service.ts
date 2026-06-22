/**
 * CLI agent onboarding status.
 *
 * Reports, for each of the three external CLI coding agents Magister
 * supports (codex / claude-code / opencode), whether the CLI is
 * installed (binary on PATH, version probe succeeds) and whether the
 * user has logged in (the CLI's own auth file exists and is non-empty).
 *
 * Magister reuses each CLI's own login credentials (see
 * `cli-agent-spawn-service.ts` seedCodexHome which copies auth.json),
 * so the user does NOT configure an API key inside Magister — they
 * install + log in to the CLI at the system level, then point a role's
 * Runtime at the CLI in Settings → Roles.
 *
 * Version detection is delegated to `probeCliVersions` — we do not
 * re-implement it here.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { probeCliVersions } from "./cli-bridge/cli-version-probe";
import type { CliRuntime } from "./cli-bridge/types";

export type CliAgentStatus = {
  cli: "codex" | "claude-code" | "opencode";
  label: string; // "Codex" / "Claude Code" / "OpenCode"
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  installHint: string; // install command / instructions
  loginHint: string; // login command
};

type CliMeta = {
  label: string;
  installHint: string;
  loginHint: string;
  /** Resolve the absolute path of the CLI's own auth/credentials file. */
  authPath: () => string;
};

// Resolve the user's home directory. We prefer `process.env.HOME`
// (readable at call time, so tests can sandbox it) and fall back to
// `os.homedir()`. Note: some runtimes (Bun) cache `homedir()` at
// process start and ignore later HOME mutations, hence the env-first
// order.
function resolveHome(): string {
  return process.env.HOME || homedir();
}

const CLI_META: Record<CliRuntime, CliMeta> = {
  codex: {
    label: "Codex",
    installHint: "npm install -g @openai/codex",
    loginHint: "codex login",
    authPath: () => join(process.env.CODEX_HOME || join(resolveHome(), ".codex"), "auth.json"),
  },
  "claude-code": {
    label: "Claude Code",
    installHint: "npm install -g @anthropic-ai/claude-code",
    // `claude` with no args runs the interactive CLI which guides the
    // user through login on first run.
    loginHint: "claude",
    authPath: () => join(resolveHome(), ".claude", ".credentials.json"),
  },
  opencode: {
    label: "OpenCode",
    installHint: "npm install -g opencode-ai",
    loginHint: "opencode auth login",
    authPath: () => join(resolveHome(), ".local/share/opencode/auth.json"),
  },
};

const CLI_ORDER: CliRuntime[] = ["codex", "claude-code", "opencode"];

/**
 * An auth file with <= 2 bytes is effectively empty (e.g. `{}` or a
 * stray newline) — treat it as "not logged in". Any stat error
 * (missing file, permission denied) is also "not logged in".
 */
async function isAuthenticated(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 2;
  } catch {
    return false;
  }
}

export async function getCliAgentStatus(cwd?: string): Promise<CliAgentStatus[]> {
  const versionEntries = await probeCliVersions(cwd);
  const versionByCli = new Map<CliRuntime, string | null>();
  for (const entry of versionEntries) {
    versionByCli.set(entry.cli, entry.version ?? null);
  }

  const statuses = await Promise.all(
    CLI_ORDER.map(async (cli): Promise<CliAgentStatus> => {
      const meta = CLI_META[cli];
      const version = versionByCli.get(cli) ?? null;
      const authenticated = await isAuthenticated(meta.authPath());
      return {
        cli,
        label: meta.label,
        installed: version !== null,
        version,
        authenticated,
        installHint: meta.installHint,
        loginHint: meta.loginHint,
      };
    }),
  );

  return statuses;
}
