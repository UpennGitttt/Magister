/**
 * Per-CLI skill attachment via filesystem symlinks. The CLI tools
 * (codex, claude-code, opencode) read their own skill directories
 * — they don't know about the central pool. To "attach" a skill to
 * a CLI we drop a symlink from the CLI's skills dir to the pool
 * entry; to detach we remove the symlink. The CLI sees the change
 * the next time it scans its dir, no Magister-side runtime hook
 * required.
 *
 * Why symlinks (not copies): copying would diverge from the pool
 * the moment `npx skills update` runs, recreating the same sync
 * problem we explicitly avoided in the architecture. Symlinks keep
 * the pool as the single source of truth.
 *
 * Mapping for the three supported CLIs (matches what `npx skills`
 * already does):
 *   codex        → ~/.codex/skills/<name>
 *   claude-code  → ~/.claude/skills/<name>
 *   opencode     → ~/.config/opencode/skills/<name>
 */

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { findSkillDirName, resolveSkillPoolDir, scanSkillPool } from "./skill-pool-service";

export type CliSkillAgent = "codex" | "claude-code" | "opencode";
export const CLI_SKILL_AGENTS: readonly CliSkillAgent[] = ["codex", "claude-code", "opencode"];

export function isCliSkillAgent(roleId: string): roleId is CliSkillAgent {
  return (CLI_SKILL_AGENTS as readonly string[]).includes(roleId);
}

/**
 * Resolve the per-CLI skills directory. Honors per-CLI env overrides
 * for users who run their CLI tools out of a non-default home —
 * keeps the path discovery in one place so a future relocation
 * doesn't require touching every call site.
 */
export function resolveCliSkillsDir(agent: CliSkillAgent): string {
  switch (agent) {
    case "codex":
      return join(process.env.MAGISTER_CODEX_HOME?.trim() || join(homedir(), ".codex"), "skills");
    case "claude-code":
      return join(process.env.MAGISTER_CLAUDE_HOME?.trim() || join(homedir(), ".claude"), "skills");
    case "opencode":
      return join(
        process.env.MAGISTER_OPENCODE_HOME?.trim() || join(homedir(), ".config", "opencode"),
        "skills",
      );
  }
}

/**
 * Check whether a skill is currently attached to a CLI agent.
 * Accepts either declared name or dir name; resolves to dir name
 * before checking the filesystem (the symlink in the CLI dir
 * always uses dir name to match what `npx skills` writes).
 */
export async function isSkillAttachedToCli(
  agent: CliSkillAgent,
  identifier: string,
): Promise<boolean> {
  const dirName = (await findSkillDirName(identifier)) ?? identifier;
  const linkPath = join(resolveCliSkillsDir(agent), dirName);
  try {
    const stat = await fsp.lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const resolved = await fsp.realpath(linkPath);
    const expected = await fsp.realpath(join(resolveSkillPoolDir(), dirName));
    return resolved === expected;
  } catch {
    return false;
  }
}

/**
 * List skill names currently attached to a CLI agent. Returns
 * DECLARED names (the canonical UI-facing identity), which may
 * differ from the dir name for meta-pack skills. Built by reading
 * the CLI's symlink dir → mapping each link target back to the
 * matching pool entry → returning that entry's `name` field.
 *
 * Best-effort scan: missing dir → empty list (CLI not installed /
 * never used skills); broken symlink → silently skipped (don't show
 * dead attachments); links pointing outside the pool → skipped
 * (someone manually rigged the dir, not our state to manage).
 */
export async function listAttachedCliSkills(agent: CliSkillAgent): Promise<string[]> {
  const dir = resolveCliSkillsDir(agent);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const pool = await scanSkillPool();
  const poolDir = await fsp.realpath(resolveSkillPoolDir()).catch(() => resolveSkillPoolDir());
  const dirNameToDeclared = new Map(pool.map((s) => [s.dirName, s.name] as const));

  const result: string[] = [];
  for (const dirEntry of names) {
    if (dirEntry.startsWith(".")) continue;
    const linkPath = join(dir, dirEntry);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(linkPath);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    let resolved: string;
    try {
      resolved = await fsp.realpath(linkPath);
    } catch {
      continue;
    }
    if (!resolved.startsWith(poolDir + "/")) continue;
    const declared = dirNameToDeclared.get(dirEntry) ?? dirEntry;
    result.push(declared);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

/**
 * Create the symlink that attaches a pool skill to a CLI agent.
 * Idempotent: if the symlink already points to the right target,
 * we leave it alone. If something else is at the path (a regular
 * file, or a symlink to somewhere else) we don't overwrite — that
 * would silently destroy whatever the user had there. Caller gets
 * a clear error so they can resolve the conflict in the filesystem.
 */
export async function attachSkillToCli(
  agent: CliSkillAgent,
  identifier: string,
): Promise<void> {
  // Resolve declared/dir name to actual dir on disk. We use the
  // dirName for both the link's target AND the link's own name
  // — that mirrors what `npx skills` writes so foreign tools
  // (e.g. claude-code's own scanner) treat our symlinks the same
  // as theirs.
  const dirName = await findSkillDirName(identifier);
  if (!dirName) {
    throw new Error(
      `Cannot attach "${identifier}" to ${agent}: skill not found in pool. Run "npx skills add" or check ~/.agents/skills/.`,
    );
  }
  const target = join(resolveSkillPoolDir(), dirName);

  const linkDir = resolveCliSkillsDir(agent);
  const linkPath = join(linkDir, dirName);
  await fsp.mkdir(linkDir, { recursive: true });

  // Match the relative-symlink pattern that `npx skills` and the
  // existing claude-code installs use (`../../.agents/skills/<name>`).
  // Relative links survive home-dir moves; absolute would break.
  const relativeTarget = relativeSymlinkTarget(linkPath, target);

  // Idempotency check — if the link already points to where we
  // want, no-op.
  try {
    const stat = await fsp.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = await fsp.readlink(linkPath);
      if (existing === relativeTarget) return;
      // Symlink exists but points elsewhere — error out rather than
      // overwrite. The user almost certainly wants to know.
      throw new Error(
        `Cannot attach "${identifier}" to ${agent}: a symlink already exists at ${linkPath} pointing to "${existing}". Resolve the conflict and try again.`,
      );
    }
    // Some other file type at the path — don't overwrite.
    throw new Error(
      `Cannot attach "${identifier}" to ${agent}: a non-symlink file exists at ${linkPath}. Move it aside and try again.`,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // Path doesn't exist — proceed to create.
  }

  await fsp.symlink(relativeTarget, linkPath);
}

/**
 * Remove the symlink that attaches a pool skill to a CLI agent.
 * Idempotent — silently no-ops if the link is already gone. Refuses
 * to unlink if the target is a regular file (not a symlink), so
 * we don't accidentally delete user content that just happens to
 * share the name.
 */
export async function detachSkillFromCli(
  agent: CliSkillAgent,
  identifier: string,
): Promise<void> {
  // Symlink name on disk is dir-name; resolve declared → dir.
  // Falls back to identifier itself when the skill is gone from
  // the pool entirely (we can still cleanup the link by its
  // surface name).
  const dirName = (await findSkillDirName(identifier)) ?? identifier;
  const linkPath = join(resolveCliSkillsDir(agent), dirName);
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(linkPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `Cannot detach "${identifier}" from ${agent}: ${linkPath} is not a symlink. Remove it manually if intentional.`,
    );
  }
  await fsp.unlink(linkPath);
}

/**
 * Compose the relative path that should be stored INSIDE the
 * symlink (e.g. `../../.agents/skills/find-skills`). Doing this
 * by hand instead of via `path.relative` because we want the
 * relative form to reflect the on-disk layout, not the resolved
 * realpath — that's what matches the existing claude-code install
 * convention and keeps `readlink` output stable across home-dir
 * moves.
 */
function relativeSymlinkTarget(linkPath: string, target: string): string {
  const linkDir = dirname(linkPath);
  // Use Node's path helpers for the actual computation — but ensure
  // we always emit POSIX-style separators since this is what the
  // filesystem layer expects on Linux/macOS hosts where this code
  // runs.
  const { relative } = require("node:path") as typeof import("node:path");
  return relative(linkDir, target);
}
