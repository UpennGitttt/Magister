/**
 * Verify the repo's bundled Magister skills are readable, and prune any
 * legacy `~/.agents/skills/magister-*` symlinks left over from earlier
 * versions that mirrored bundled skills into the global pool.
 *
 * Source of truth: `<repoRoot>/packages/builtin-skills/<name>/SKILL.md`.
 *
 * Bundled skills NEVER touch the machine-wide pool. They're served via
 * a dedicated bundled-source lookup (`bundled-skills-source.ts`) that
 * the leader's prompt builder reads directly. This bootstrap:
 *   - sanity-checks that the bundled dir is reachable at startup
 *   - sweeps up any legacy pool symlinks pointing at the bundled dir
 *
 * Idempotent and best-effort: failures are warnings, never fatal.
 */

import { lstat, readdir, readlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function getBuiltinDir(): string {
  return join(process.cwd(), "packages", "builtin-skills");
}

function getPoolDir(): string {
  return join(homedir(), ".agents", "skills");
}

/** Return the list of bundled skill names found in the repo. */
export async function listBundledSkillNames(builtinDir?: string): Promise<string[]> {
  const dir = builtinDir ?? getBuiltinDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const skillDir = join(dir, name);
    const st = await lstat(skillDir).catch(() => null);
    if (st?.isDirectory()) {
      names.push(name);
    }
  }
  return names;
}

type SeedOptions = {
  /** Override the pool directory (for tests). Defaults to `~/.agents/skills`. */
  poolDir?: string;
  /** Override the builtin source directory (for tests). Defaults to `cwd/packages/builtin-skills`. */
  builtinDir?: string;
};

export type SeedReport = {
  /** Names found in the bundled source dir. */
  bundled: string[];
  /** Legacy pool symlinks that pointed at the bundled dir and were removed. */
  prunedLegacy: string[];
  /** DB skill rows renamed from the old bundled skill names. */
  renamedSkills: number;
  /** DB skill override rows renamed from the old bundled skill names. */
  renamedSkillOverrides: number;
  /** Non-fatal warnings (missing source, unlink failures, etc.). */
  warnings: string[];
};

const LEGACY_BUILTIN_SKILL_RENAMES: Record<string, string> = {
  "ucm-shipping": "magister-shipping",
  "ucm-debugging": "magister-debugging",
  "ucm-using-skills": "magister-using-skills",
  "ucm-cli-subagents": "magister-cli-subagents",
  "ucm-planning": "magister-planning",
  "ucm-tdd-and-review": "magister-tdd-and-review",
  "ucm-delegating": "magister-delegating",
};

export type LegacyBuiltinSkillMigrationReport = {
  renamedSkills: number;
  renamedSkillOverrides: number;
};

export async function migrateLegacyBuiltinSkillNames(): Promise<LegacyBuiltinSkillMigrationReport> {
  const { createSqliteClient, ensureDatabaseInitialized } = await import("@magister/db");
  const sqlite = createSqliteClient();
  ensureDatabaseInitialized(sqlite);

  let renamedSkills = 0;
  let renamedSkillOverrides = 0;
  const now = Date.now();

  const updateSkills = sqlite.prepare(
    "UPDATE skills SET name = ?, updated_at = ? WHERE name = ?",
  );
  const updateOverrides = sqlite.prepare(`
    UPDATE skill_overrides
    SET skill_name = ?, updated_at = ?
    WHERE skill_name = ?
      AND NOT EXISTS (
        SELECT 1
        FROM skill_overrides existing
        WHERE existing.role_id = skill_overrides.role_id
          AND existing.skill_name = ?
      )
  `);
  const deleteLegacyOverrides = sqlite.prepare(
    "DELETE FROM skill_overrides WHERE skill_name = ?",
  );

  try {
    for (const [legacyName, newName] of Object.entries(LEGACY_BUILTIN_SKILL_RENAMES)) {
      renamedSkills += updateSkills.run(newName, now, legacyName).changes;
      renamedSkillOverrides += updateOverrides.run(newName, now, legacyName, newName).changes;
      deleteLegacyOverrides.run(legacyName);
    }
  } finally {
    sqlite.close();
  }

  return { renamedSkills, renamedSkillOverrides };
}

/**
 * Verify the bundled source dir is readable + sweep up any legacy
 * `~/.agents/skills/<name>` symlinks that still point at it. Returns
 * a structured report for observability.
 */
export async function seedBuiltinSkills(options: SeedOptions = {}): Promise<SeedReport> {
  const report: SeedReport = {
    bundled: [],
    prunedLegacy: [],
    renamedSkills: 0,
    renamedSkillOverrides: 0,
    warnings: [],
  };

  try {
    const migration = await migrateLegacyBuiltinSkillNames();
    report.renamedSkills = migration.renamedSkills;
    report.renamedSkillOverrides = migration.renamedSkillOverrides;
  } catch (err) {
    report.warnings.push(
      `Failed to migrate legacy bundled skill names: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const builtinDir = options.builtinDir ?? getBuiltinDir();
  const poolDir = options.poolDir ?? getPoolDir();

  report.bundled = await listBundledSkillNames(builtinDir);
  if (report.bundled.length === 0) {
    // Not a fatal error — bundled dir might be missing in a stripped
    // deployment. Just note it for diagnostics.
    report.warnings.push(
      `No bundled skills found in ${builtinDir}. Leader will start without Magister-managed skills.`,
    );
  }

  // Sweep legacy pool symlinks. The previous version of this file
  // created `~/.agents/skills/<bundled>` -> `<repo>/packages/builtin-skills/<bundled>`.
  // We remove any symlink in the pool whose resolved target lives
  // inside the bundled dir, regardless of name — that catches both
  // the canonical magister-* family and any user-renamed leftovers.
  let poolEntries: string[];
  try {
    poolEntries = await readdir(poolDir);
  } catch {
    // Pool dir doesn't exist — nothing to sweep. Not an error.
    return report;
  }

  for (const name of poolEntries) {
    if (name.startsWith(".")) continue;
    const poolPath = join(poolDir, name);
    const st = await lstat(poolPath).catch(() => null);
    if (!st?.isSymbolicLink()) continue;

    const target = await readlink(poolPath).catch(() => "");
    if (!target) continue;
    const resolvedTarget = resolve(poolPath, "..", target);
    if (!resolvedTarget.startsWith(builtinDir)) continue;

    try {
      await unlink(poolPath);
      report.prunedLegacy.push(name);
    } catch (err) {
      report.warnings.push(
        `Failed to prune legacy pool symlink ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (report.prunedLegacy.length > 0) {
    console.log(
      `[builtin-skills] Pruned ${report.prunedLegacy.length} legacy pool symlink(s): ${report.prunedLegacy.join(", ")}`,
    );
  }
  for (const w of report.warnings) {
    console.warn(`[builtin-skills] ${w}`);
  }

  return report;
}
