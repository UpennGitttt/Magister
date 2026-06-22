/**
 * Scan all CLI skills directories + the Magister canonical pool, classify each
 * entry, and return a structured report for the Settings UI.
 *
 * Background:
 *  - `~/.agents/skills/` is the canonical pool managed by `vercel-labs/skills`
 *    (`npx skills`).
 *  - Each CLI has its own `skills/` dir that typically contains symlinks
 *    back to the pool. Codex is the exception — it uses its own `.system`
 *    skill system and doesn't participate in the pool.
 *  - The pool itself can contain reverse-symlinks (e.g.
 *    `~/.agents/skills/superpowers -> /root/.codex/superpowers/skills`)
 *    where the canonical content actually lives in a CLI's dir. We classify
 *    those as CLI-private under the source CLI.
 *
 * Returns:
 *  - `inPool`: skills whose body lives at `~/.agents/skills/<name>/` (real dir)
 *  - `cliPrivate`: skills whose body lives in a CLI's dir, NOT in the pool.
 *    Includes both reverse-symlinked pool entries and pure CLI installs.
 */

import { lstat, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CliRuntime = "codex" | "claude-code" | "opencode";

export type SkillStatus =
  | { kind: "magister-pool" }
  | { kind: "magister-bundled"; sourcePath: string }
  | { kind: "magister-symlinked"; cli: CliRuntime; symlinkTarget: string }
  | { kind: "cli-private"; cli: CliRuntime; path: string }
  | { kind: "missing"; cli: CliRuntime; expectedPath: string };

export type SkillScanRow = {
  name: string;
  poolPath: string | null;
  description?: string;
  perCli: Partial<Record<CliRuntime, SkillStatus>>;
};

/**
 * CLIs that participate in the `~/.agents/skills/` shared pool via
 * symlinks. Codex is intentionally absent — it uses its own
 * `.system`-marked skill directory.
 */
const POOL_PARTICIPANTS: CliRuntime[] = ["claude-code", "opencode"];

const ALL_CLIS: CliRuntime[] = ["codex", "claude-code", "opencode"];

function cliSkillDirs(home: string): Record<CliRuntime, string> {
  return {
    codex: join(home, ".codex", "skills"),
    "claude-code": join(home, ".claude", "skills"),
    opencode: join(home, ".config", "opencode", "skills"),
  };
}

async function listDirSafe(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

async function isSymlinkPointingTo(linkPath: string): Promise<{
  isSymlink: boolean;
  target: string | null;
}> {
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) return { isSymlink: false, target: null };
    const t = await readlink(linkPath);
    const abs = resolve(linkPath, "..", t);
    return { isSymlink: true, target: abs };
  } catch {
    return { isSymlink: false, target: null };
  }
}

/**
 * Scan skills across the canonical pool + every CLI's skill dir.
 *
 * `homeDir` parameter is injectable for tests. Production callers use the
 * default which reads `homedir()`.
 */
export async function scanSkills(
  homeDir: string = homedir(),
): Promise<{ inPool: SkillScanRow[]; cliPrivate: SkillScanRow[] }> {
  const poolDir = join(homeDir, ".agents", "skills");
  const cliDirs = cliSkillDirs(homeDir);
  const builtinDir = join(process.cwd(), "packages", "builtin-skills");

  const inPool: SkillScanRow[] = [];
  // cliPrivate declared early so the reverse-symlink branch below
  // can push into it from inside the pool loop.
  const cliPrivate: SkillScanRow[] = [];

  const poolEntries = await listDirSafe(poolDir);
  for (const name of poolEntries) {
    if (name.startsWith(".")) continue;
    const poolPath = join(poolDir, name);

    // C1 (kimi): pool entry itself may be a symlink pointing OUT to a
    // CLI dir. Detect by lstat'ing and checking the target prefix.
    const poolStat = await lstat(poolPath).catch(() => null);
    let resolvedTarget: string | null = null;
    if (poolStat?.isSymbolicLink()) {
      const linkPath = await readlink(poolPath).catch(() => "");
      resolvedTarget = linkPath ? resolve(poolPath, "..", linkPath) : null;
    }
    const isReverseSymlink =
      resolvedTarget !== null && !resolvedTarget.startsWith(poolDir);

    const row: SkillScanRow = {
      name,
      poolPath,
      perCli: {},
    };
    if (isReverseSymlink && resolvedTarget) {
      const target = resolvedTarget;

      // Bundled Magister skill: symlink points into the repo's
      // packages/builtin-skills/ directory. Treat as in-pool, not
      // CLI-private.
      if (target.startsWith(builtinDir)) {
        for (const cli of ALL_CLIS) {
          const expectedPath = join(cliDirs[cli], name);
          const { isSymlink, target: t } = await isSymlinkPointingTo(expectedPath);
          if (isSymlink && t?.startsWith(poolDir)) {
            row.perCli[cli] = { kind: "magister-symlinked", cli, symlinkTarget: t };
          } else {
            row.perCli[cli] = { kind: "missing", cli, expectedPath };
          }
        }
        inPool.push(row);
        continue;
      }

      // Pool entry is a symlink to outside the pool — typically into
      // a CLI's private skill dir. Classify as CLI-private under that
      // source CLI.
      const sourceCli: CliRuntime | null = target.startsWith(
        join(homeDir, ".codex"),
      )
        ? "codex"
        : target.startsWith(join(homeDir, ".claude"))
          ? "claude-code"
          : target.startsWith(join(homeDir, ".config", "opencode"))
            ? "opencode"
            : null;
      if (sourceCli) {
        row.perCli[sourceCli] = { kind: "cli-private", cli: sourceCli, path: target };
      }
      cliPrivate.push(row);
      continue; // don't double-count in the per-CLI walk below
    }

    // Pool entry is a real dir. Walk each CLI's skills dir for symlinks
    // pointing back at this entry.
    for (const cli of ALL_CLIS) {
      const expectedPath = join(cliDirs[cli], name);
      const { isSymlink, target } = await isSymlinkPointingTo(expectedPath);
      if (isSymlink && target?.startsWith(poolDir)) {
        row.perCli[cli] = { kind: "magister-symlinked", cli, symlinkTarget: target };
      } else {
        // Both pool participants and Codex record `missing` here. The
        // UI differentiates: Codex never participates so the badge
        // says "Codex (uses own skill system)" instead of "needs symlink".
        row.perCli[cli] = { kind: "missing", cli, expectedPath };
      }
    }
    inPool.push(row);
  }

  // CLI-private dirs in CLI/skills/ that AREN'T symlinks. Group by
  // name across CLIs (one row per name). Already-handled pool entries
  // (reverse-symlinks) are in `cliPrivate` above; merge by name.
  for (const cli of ALL_CLIS) {
    const cliEntries = await listDirSafe(cliDirs[cli]);
    for (const name of cliEntries) {
      if (name.startsWith(".")) continue;
      const path = join(cliDirs[cli], name);
      const { isSymlink, target } = await isSymlinkPointingTo(path);
      if (isSymlink && target?.startsWith(poolDir)) continue; // counted in pool loop
      const st = await lstat(path).catch(() => null);
      if (!st?.isDirectory()) continue;

      let row = cliPrivate.find((r) => r.name === name);
      if (!row) {
        row = { name, poolPath: null, perCli: {} };
        cliPrivate.push(row);
      }
      row.perCli[cli] = { kind: "cli-private", cli, path };
    }
  }

  return { inPool, cliPrivate };
}

export const POOL_PARTICIPANTS_CLI = POOL_PARTICIPANTS;
