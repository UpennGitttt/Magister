/**
 * Run `codex --version`, `claude --version`, `opencode --version`
 * once at server startup; cache results in `.magister/cli-versions.json`.
 *
 * Helpful for post-mortem when a CLI's schema changes — the
 * cached version pinpoints when the upgrade happened.
 *
 * Soft-fail per CLI: a missing CLI is not a Magister startup blocker.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { spawnProcess } from "../../lib/platform/spawn";
import { resolveCliExecutable } from "./cli-executable-resolver";
import type { CliRuntime } from "./types";

export type CliVersionEntry = {
  cli: CliRuntime;
  version: string | null;
  error?: string;
};

const CLIS: CliRuntime[] = ["codex", "claude-code", "opencode"];
async function runVersion(cli: CliRuntime): Promise<CliVersionEntry> {
  try {
    const resolved = await resolveCliExecutable(cli);
    const proc = spawnProcess([resolved.command, "--version"]);
    const exit = await proc.exited;
    if (exit === 0) {
      const stdout = (await proc.stdoutText()).trim();
      return { cli, version: stdout };
    }
    const stderr = await proc.stderrText();
    return { cli, version: null, error: `${resolved.command} --version failed: ${stderr.trim()}` };
  } catch (err) {
    return { cli, version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * fast CLI-version lookup for the spawn
 * service. Reads the cached probe result; returns the version string
 * (e.g. "codex-cli 0.129.0") or null on cache miss / stale runtime.
 *
 * Cached in module scope after first read so each teammate spawn
 * doesn't pay for a JSON disk read; refresh via `probeCliVersions`
 * (called on server startup).
 */
let cachedVersionMap: Record<string, string | null> | null = null;
let cacheLoadedFromPath: string | null = null;

export async function getCachedCliVersion(
  cli: CliRuntime,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const path = join(cwd, ".magister", "cli-versions.json");
  if (cachedVersionMap === null || cacheLoadedFromPath !== path) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as { entries?: CliVersionEntry[] };
      const map: Record<string, string | null> = {};
      for (const e of parsed.entries ?? []) {
        if (e.cli) map[e.cli] = e.version ?? null;
      }
      cachedVersionMap = map;
      cacheLoadedFromPath = path;
    } catch {
      cachedVersionMap = {};
      cacheLoadedFromPath = path;
    }
  }
  return cachedVersionMap[cli] ?? null;
}

export async function probeCliVersions(cwd: string = process.cwd()): Promise<CliVersionEntry[]> {
  // Invalidate the in-process cache so subsequent getCachedCliVersion
  // calls pick up the fresh values once we've rewritten the file.
  cachedVersionMap = null;
  cacheLoadedFromPath = null;
  const entries = await Promise.all(CLIS.map(runVersion));
  const path = join(cwd, ".magister", "cli-versions.json");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ probedAt: new Date().toISOString(), entries }, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort; don't block startup on cache write failure.
  }
  // Log to console for immediate visibility, and flag any drift from
  // the buildCliArgs-tested baseline. Drift means flag syntax may
  // have changed and the next teammate spawn could E2BIG / "file
  // not found" / etc. — the warning gives maintainers a starting
  // point for "what changed since this code was written".
  const { CLI_ARGS_BASELINE_VERSIONS } = await import("../cli-agent-spawn-service");
  for (const e of entries) {
    if (e.version) {
      console.log(`[cli-bridge] ${e.cli} version: ${e.version}`);
      const baseline = CLI_ARGS_BASELINE_VERSIONS[e.cli];
      if (baseline && !e.version.includes(baseline)) {
        console.warn(
          `[cli-bridge] ${e.cli} version drift: installed "${e.version}" doesn't match buildCliArgs baseline "${baseline}". `
          + `Flag syntax may have changed — re-run E2E (codex -i, opencode -f-after-prompt, claude -p+file-list).`,
        );
      }
    } else {
      console.warn(`[cli-bridge] ${e.cli} not available: ${e.error}`);
    }
  }
  return entries;
}
