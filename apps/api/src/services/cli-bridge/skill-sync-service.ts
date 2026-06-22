/**
 * Skills sync service. Implements Stage 2 of the CLI bridge plan:
 *
 *   - `promoteSkill`: move a CLI-private skill into the canonical
 *     `~/.agents/skills/` pool; replace the original with a symlink;
 *     also symlink to other pool-participating CLIs (claude-code,
 *     opencode). Codex never gets a symlink (locked decision — uses
 *     its own skill system).
 *
 *   - `syncSkillToCli`: for a skill already in the pool, ensure
 *     symlinks exist in claude-code and opencode skill dirs. Used
 *     when Magister imports a new skill or detects "missing" status.
 *
 * SAFETY:
 *   - Skill names are validated against /^[a-zA-Z0-9_-]{1,80}$/ to
 *     prevent path traversal.
 *   - We use `lstat` on every path and never follow symlinks blindly.
 *   - All filesystem mutations are best-effort with structured error
 *     reporting; partial failures don't leave the pool corrupted.
 */

import { lstat, mkdir, readdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CliRuntime } from "./types";

const VALID_SKILL_NAME = /^[a-zA-Z0-9_-]{1,80}$/;

const POOL_PARTICIPANTS: CliRuntime[] = ["claude-code", "opencode"];

function validateName(name: string): void {
  if (!VALID_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: ${JSON.stringify(name)}. Must match ${VALID_SKILL_NAME}`);
  }
}

function poolDir(home: string): string {
  return join(home, ".agents", "skills");
}

function cliSkillDir(home: string, cli: CliRuntime): string {
  switch (cli) {
    case "codex":       return join(home, ".codex", "skills");
    case "claude-code": return join(home, ".claude", "skills");
    case "opencode":    return join(home, ".config", "opencode", "skills");
  }
}

async function pathKind(p: string): Promise<"missing" | "symlink" | "dir" | "other"> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory())    return "dir";
    return "other";
  } catch {
    return "missing";
  }
}

async function readSymlinkTarget(p: string): Promise<string | null> {
  try {
    const t = await readlink(p);
    return resolve(p, "..", t);
  } catch {
    return null;
  }
}

export type PromoteResult = {
  ok: boolean;
  poolPath: string;
  symlinkedCli: CliRuntime[];     // CLIs that got a fresh symlink
  message?: string;
};

export type SyncResult = {
  ok: boolean;
  symlinksCreated: CliRuntime[];
  symlinksRemovedStale: CliRuntime[];
  warnings: string[];
};

/**
 * Move a CLI-private skill into the Magister pool. Steps:
 *   1. Validate the skill name.
 *   2. Verify the source path is a real dir (or a symlink whose
 *      target is a real dir, in the reverse-symlink case).
 *   3. If the source is a real dir under a CLI's skills dir:
 *        - rename the dir into ~/.agents/skills/<name>/
 *        - symlink ~/.{cli}/skills/<name> -> ~/.agents/skills/<name>
 *   4. Symlink to all pool participants that don't already have one.
 *   5. Codex always skipped (no symlink ever written to ~/.codex/skills/).
 */
export async function promoteSkill(input: {
  name: string;
  sourceCli: CliRuntime;
  homeDir?: string;
}): Promise<PromoteResult> {
  const { name, sourceCli } = input;
  const home = input.homeDir ?? homedir();
  validateName(name);

  // Defense-in-depth : UI hides the Promote button for
  // Codex private skills, but the service must also reject — Codex
  // is intentionally NOT a pool participant. Promoting from Codex
  // would move the dir into the pool and symlink claude-code +
  // opencode back, leaving Codex without its skill (silent loss).
  if (sourceCli === "codex") {
    throw new Error(
      `promoteSkill: refusing to promote from codex — Codex uses its own skill system and is not a pool participant.`,
    );
  }

  const sourcePath = join(cliSkillDir(home, sourceCli), name);
  const targetPath = join(poolDir(home), name);

  // Verify the source: either a real dir, or a reverse-symlink case
  // where the canonical content is in a CLI dir but the pool entry
  // itself is a symlink TO that CLI dir.
  const srcKind = await pathKind(sourcePath);
  if (srcKind === "missing") {
    throw new Error(`promoteSkill: source ${sourcePath} does not exist`);
  }
  if (srcKind === "symlink") {
    // The CLI dir entry is itself a symlink. Resolve it; if it points
    // back to the pool, this is already promoted — no-op.
    const tgt = await readSymlinkTarget(sourcePath);
    if (tgt && tgt.startsWith(poolDir(home))) {
      return { ok: true, poolPath: tgt, symlinkedCli: [], message: "already in pool" };
    }
    throw new Error(`promoteSkill: source ${sourcePath} is a symlink to ${tgt} (unexpected; resolve manually)`);
  }
  if (srcKind === "other") {
    throw new Error(`promoteSkill: source ${sourcePath} is not a directory`);
  }

  // Target may already exist in pool (e.g. previous partial promote).
  const targetKind = await pathKind(targetPath);
  if (targetKind !== "missing") {
    throw new Error(`promoteSkill: pool entry ${targetPath} already exists; refusing to overwrite`);
  }

  // Ensure pool dir exists.
  await mkdir(poolDir(home), { recursive: true });

  // Move source dir into pool, then symlink back. If the back-symlink
  // fails (EPERM / disk full / race), roll the rename back so the
  // source CLI doesn't lose its skill silently (kimi rollback fix).
  await rename(sourcePath, targetPath);
  try {
    await symlink(targetPath, sourcePath);
  } catch (err) {
    // Rollback: move dir back to original location.
    try {
      await rename(targetPath, sourcePath);
    } catch (rollbackErr) {
      // Both rename and rollback failed — surface BOTH paths so the
      // user can recover manually. This shouldn't happen on a
      // healthy filesystem.
      throw new Error(
        `promoteSkill: symlink failed (${err instanceof Error ? err.message : String(err)}) AND rollback failed (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}). Skill content is at ${targetPath}; original location ${sourcePath} is empty. Move it back manually.`,
      );
    }
    throw new Error(
      `promoteSkill: symlink failed (${err instanceof Error ? err.message : String(err)}). Rolled back — skill is back at ${sourcePath}.`,
    );
  }

  // Symlink to other pool participants (skip Codex always).
  const symlinkedCli: CliRuntime[] = [sourceCli];
  for (const cli of POOL_PARTICIPANTS) {
    if (cli === sourceCli) continue;
    const cliDir = cliSkillDir(home, cli);
    await mkdir(cliDir, { recursive: true });
    const linkPath = join(cliDir, name);
    const linkKind = await pathKind(linkPath);
    if (linkKind === "missing") {
      await symlink(targetPath, linkPath);
      symlinkedCli.push(cli);
    }
    // If linkKind is "symlink" or "dir" already, leave it — don't
    // overwrite user state. They may have a different version.
  }

  return { ok: true, poolPath: targetPath, symlinkedCli };
}

/**
 * Ensure a pool skill is symlinked from claude-code and opencode
 * skill dirs. Codex is intentionally skipped. Removes stale symlinks
 * (those pointing to non-pool targets or dangling).
 */
export async function syncSkillToCli(input: {
  name: string;
  homeDir?: string;
}): Promise<SyncResult> {
  const { name } = input;
  const home = input.homeDir ?? homedir();
  validateName(name);

  const result: SyncResult = {
    ok: true,
    symlinksCreated: [],
    symlinksRemovedStale: [],
    warnings: [],
  };

  const target = join(poolDir(home), name);
  const targetKind = await pathKind(target);
  if (targetKind !== "dir") {
    if (targetKind === "missing") {
      throw new Error(`syncSkillToCli: pool entry ${target} does not exist`);
    }
    if (targetKind === "symlink") {
      // Reverse-symlink case: pool entry is symlink to CLI dir.
      // Don't try to sync from this entry — it's a borrowed alias.
      result.warnings.push(`Pool entry ${name} is a reverse-symlink; skipping sync.`);
      return result;
    }
    throw new Error(`syncSkillToCli: pool entry ${target} is not a directory`);
  }

  for (const cli of POOL_PARTICIPANTS) {
    const cliDir = cliSkillDir(home, cli);
    await mkdir(cliDir, { recursive: true });
    const linkPath = join(cliDir, name);
    const linkKind = await pathKind(linkPath);

    if (linkKind === "missing") {
      await symlink(target, linkPath);
      result.symlinksCreated.push(cli);
    } else if (linkKind === "symlink") {
      const tgt = await readSymlinkTarget(linkPath);
      if (tgt !== target) {
        // Stale symlink — points elsewhere. Remove + recreate.
        await unlink(linkPath);
        await symlink(target, linkPath);
        result.symlinksRemovedStale.push(cli);
        result.symlinksCreated.push(cli);
      }
      // else: already correct, no-op
    } else if (linkKind === "dir") {
      result.warnings.push(`${cli} has a real dir at ${linkPath} (would conflict with pool entry); skipping. User may want to promote it first.`);
    } else {
      result.warnings.push(`${cli} has unexpected entry at ${linkPath}; skipping.`);
    }
  }

  return result;
}
