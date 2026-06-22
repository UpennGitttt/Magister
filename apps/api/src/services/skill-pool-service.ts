/**
 * Read-through view over the machine-wide skill pool managed by
 * `npx skills` at `~/.agents/skills/`. Magister never mirrors skill
 * content into its own storage — the pool's filesystem layout is
 * the single source of truth, and this service is the lens Magister
 * uses to look at it.
 *
 * Skill content lives at:
 *   ~/.agents/skills/<name>/SKILL.md
 *
 * Source metadata (GitHub repo URL, commit hash, install time) lives
 * at:
 *   ~/.agents/.skill-lock.json
 *
 * `npx skills` writes both. We only WRITE this layout when adding
 * manually-authored skills that don't have a GitHub source — those
 * get a SKILL.md but no entry in the lock file (we treat
 * "in pool but not in lock" as the canonical signal for manual
 * skills, so we never have to mutate the lock file in normal
 * operation).
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SkillSourceKind = "github" | "manual" | "builtin";

export type SkillPoolEntry = {
  /**
   * The canonical name as declared in `SKILL.md` frontmatter.
   * For most skills this matches the directory name; for
   * meta-pack skills (e.g., the `ckm-*` family installed by
   * `nextlevelbuilder/ui-ux-pro-max-skill`) the declared name uses
   * a `<prefix>:<sub>` form while the directory uses
   * `<prefix>-<sub>` because POSIX filesystems treat `:` as
   * tolerable but tools-unfriendly. The skill lock file keys by
   * declared name; CLI symlinks use directory name. We surface
   * both so the right one can be used at the right layer.
   */
  name: string;
  /** Filesystem directory under `~/.agents/skills/`. */
  dirName: string;
  description: string;
  /** Source classification — "github" if present in lock file,
   *  otherwise "manual". */
  sourceKind: SkillSourceKind;
  /** Git URL pulled from the lock file. Only set for `github`. */
  sourceUrl?: string;
  /** Git commit hash from the lock file. Only set for `github`. */
  sourceCommit?: string;
  /** ISO timestamps from the lock file. Only set for `github`. */
  installedAt?: string;
  updatedAt?: string;
  /** Absolute path to the SKILL.md file. */
  skillFilePath: string;
};

/**
 * Resolve the central pool root. Honors `MAGISTER_AGENTS_HOME` for
 * tests and unusual setups; defaults to `~/.agents`.
 */
export function resolveAgentsHome(): string {
  return process.env.MAGISTER_AGENTS_HOME?.trim() || join(homedir(), ".agents");
}

export function resolveSkillPoolDir(): string {
  return join(resolveAgentsHome(), "skills");
}

export function resolveSkillLockPath(): string {
  return join(resolveAgentsHome(), ".skill-lock.json");
}

type LockFile = {
  version?: number;
  skills?: Record<string, {
    source?: string;
    sourceType?: string;
    sourceUrl?: string;
    skillPath?: string;
    skillFolderHash?: string;
    installedAt?: string;
    updatedAt?: string;
  }>;
};

/**
 * Parse YAML frontmatter from a SKILL.md file. We only need `name`
 * and `description` — the SKILL.md format is simple key:value lines
 * between `---` delimiters, no nested structures, so a regex pass
 * is enough and avoids pulling in a YAML dep just for two fields.
 *
 * Falls back to deriving `name` from the directory if the file
 * doesn't have a frontmatter block (some hand-written skills omit
 * it). Description defaults to empty string in that case — the
 * Skills UI flags missing descriptions so the user can fix them.
 */
function parseSkillFrontmatter(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return { name: fallbackName, description: "" };
  }
  const block = match[1] ?? "";
  const lines = block.split("\n");
  let name = fallbackName;
  let description = "";
  // Frontmatter often spans multi-line description fields. We
  // implement just the format `npx skills` emits: each top-level
  // key is on its own line, `key: value` with the value continuing
  // until the next key or the end of the block.
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  const flush = () => {
    if (currentKey === "name") name = currentValue.join("\n").trim() || fallbackName;
    else if (currentKey === "description") description = currentValue.join("\n").trim();
    currentKey = null;
    currentValue = [];
  };
  for (const rawLine of lines) {
    const m = rawLine.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) {
      flush();
      currentKey = m[1] ?? null;
      currentValue = m[2] ? [m[2]] : [];
    } else if (currentKey) {
      currentValue.push(rawLine.trim());
    }
  }
  flush();
  return { name, description };
}

async function readLockFile(): Promise<LockFile> {
  try {
    const raw = await fsp.readFile(resolveSkillLockPath(), "utf-8");
    return JSON.parse(raw) as LockFile;
  } catch {
    // Missing or malformed lock file — treat all pool skills as manual.
    return {};
  }
}

/**
 * Scan the central pool. Returns one entry per `<pool>/<name>/`
 * subdirectory that contains a readable `SKILL.md`. Subdirs without
 * a SKILL.md are skipped silently (they may be partial installs or
 * unrelated content from other tools).
 *
 * The scan is best-effort: a missing pool dir returns an empty list
 * (no skills installed yet); per-skill read errors log a warning
 * but don't fail the whole scan, so one bad entry can't hide all
 * the others.
 */
export async function scanSkillPool(): Promise<SkillPoolEntry[]> {
  const poolDir = resolveSkillPoolDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(poolDir);
  } catch {
    return [];
  }

  const lock = await readLockFile();
  const lockEntries = lock.skills ?? {};

  const results: SkillPoolEntry[] = [];
  for (const name of entries) {
    // Skip dotfiles and the system marker dir (`.system/` for codex).
    if (name.startsWith(".")) continue;
    const skillDir = join(poolDir, name);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(skillDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;

    const skillFilePath = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = await fsp.readFile(skillFilePath, "utf-8");
    } catch {
      // Subdir without a SKILL.md — silently skip. Could be a partial
      // install or unrelated tool data.
      continue;
    }

    const { name: parsedName, description } = parseSkillFrontmatter(content, name);
    const declaredName = parsedName || name;

    // Detect bundled Magister skills: pool entry is a symlink pointing
    // into the repo's packages/builtin-skills/ directory.
    let sourceKind: SkillSourceKind = "manual";
    let isGithub = false;
    let lockInfo = lockEntries[declaredName] ?? lockEntries[name];

    if (stat.isSymbolicLink()) {
      try {
        const linkTarget = await fsp.readlink(skillDir);
        const resolved = resolve(skillDir, "..", linkTarget);
        const builtinDir = join(process.cwd(), "packages", "builtin-skills");
        if (resolved.startsWith(builtinDir)) {
          sourceKind = "builtin";
          lockInfo = undefined;
        }
      } catch {
        // readlink failed — fall through to normal classification
      }
    }

    if (sourceKind !== "builtin" && lockInfo) {
      isGithub =
        lockInfo.sourceType === "github" || typeof lockInfo.sourceUrl === "string";
      if (isGithub) {
        sourceKind = "github";
      }
    }

    results.push({
      name: declaredName,
      dirName: name,
      description,
      sourceKind,
      ...(isGithub && lockInfo?.sourceUrl ? { sourceUrl: lockInfo.sourceUrl } : {}),
      ...(isGithub && lockInfo?.skillFolderHash ? { sourceCommit: lockInfo.skillFolderHash } : {}),
      ...(isGithub && lockInfo?.installedAt ? { installedAt: lockInfo.installedAt } : {}),
      ...(isGithub && lockInfo?.updatedAt ? { updatedAt: lockInfo.updatedAt } : {}),
      skillFilePath,
    });
  }

  // Stable sort by name so UI ordering is predictable across reloads.
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Resolve a skill identifier (declared name or directory name)
 * back to its filesystem directory entry. Returns null if the
 * skill isn't in the pool. Most callers pass the declared name
 * (what UI/users see); we accept either so mid-stack code paths
 * don't have to remember which is which.
 */
export async function findSkillDirName(identifier: string): Promise<string | null> {
  if (!identifier) return null;
  // Fast path: identifier IS the directory name (the common case
  // where declared name == dir name). Skip the full scan when
  // possible.
  try {
    await fsp.stat(join(resolveSkillPoolDir(), identifier, "SKILL.md"));
    return identifier;
  } catch {
    // fall through to scan for declared-name match
  }
  const pool = await scanSkillPool();
  const match = pool.find((s) => s.name === identifier || s.dirName === identifier);
  return match?.dirName ?? null;
}

/**
 * Read raw SKILL.md content for a specific pool entry. Accepts
 * either the declared name (preferred — what the UI shows) or
 * the directory name. Returns null if the skill isn't in the pool.
 *
 * Bundled Magister skills (those in `packages/builtin-skills/`, leader-only,
 * never symlinked into the pool) are transparently resolved through
 * the bundled-skills-source layer so `load_skill` and the leader's
 * bootstrap-body injection both find them without callers having to
 * know which storage layer owns the skill.
 *
 * `roleId` only matters for bundled skills — when provided, the
 * per-instance content/description override for that role is applied
 * before returning. Pool skills (github / manual) have no override
 * concept; their pool file is the source of truth.
 */
export async function readSkillContent(
  identifier: string,
  roleId?: string,
): Promise<string | null> {
  const dirName = await findSkillDirName(identifier);
  if (dirName) {
    try {
      const path = join(resolveSkillPoolDir(), dirName, "SKILL.md");
      return await fsp.readFile(path, "utf-8");
    } catch {
      // Fall through to bundled source.
    }
  }
  // Bundled-source fallback. Lazy-import to keep the dependency
  // direction one-way (skill-management imports skill-pool, not
  // the other way around — but the bundled source is a sibling so
  // we import it directly here).
  const { readBundledSkillContent } = await import("./bundled-skills-source");
  return readBundledSkillContent(identifier, roleId);
}

/**
 * Write a manually-authored skill into the pool. Always creates a
 * fresh `<name>/SKILL.md` with `---` frontmatter (name +
 * description) followed by `body`. Caller is responsible for
 * validating `name` against `isValidSkillName` first — this layer
 * trusts what it gets.
 *
 * Idempotency: if the dir already exists and `mode === "create"`
 * we error out so the caller can show a useful message. For
 * `mode === "update"` we overwrite without checking — the caller
 * has already confirmed the skill exists and is editable
 * (i.e. manual, not GitHub-sourced).
 */
export async function writeManualSkill(
  name: string,
  description: string,
  body: string,
  mode: "create" | "update",
): Promise<{ skillFilePath: string }> {
  const dir = join(resolveSkillPoolDir(), name);
  if (mode === "create") {
    try {
      await fsp.access(dir);
      throw new Error(
        `A skill named "${name}" already exists in the pool. Pick a different name or edit the existing skill.`,
      );
    } catch (err: unknown) {
      // ENOENT is what we want — proceed to create. Anything else
      // (including the "already exists" we just threw) bubbles.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  await fsp.mkdir(dir, { recursive: true });

  // Frontmatter: keep it minimal and exactly what `npx skills`
  // emits. Description is single-line — caller should have
  // collapsed any newlines before passing it in. The trailing
  // newline before the body is required by the format.
  const trimmedDesc = description.replace(/\s+/g, " ").trim();
  const frontmatter = `---\nname: ${name}\ndescription: ${trimmedDesc}\n---\n\n`;
  // Use atomic-ish write: stage to a sibling temp file then rename.
  // Renames within the same directory are atomic on POSIX, so a
  // concurrent reader will only ever see "old" or "new", never
  // a half-written file.
  const finalPath = join(dir, "SKILL.md");
  const tmpPath = join(dir, `.SKILL.md.tmp.${process.pid}.${Date.now()}`);
  await fsp.writeFile(tmpPath, frontmatter + body, { encoding: "utf-8" });
  await fsp.rename(tmpPath, finalPath);
  return { skillFilePath: finalPath };
}

/**
 * Remove a skill from the central pool. Deletes the directory
 * recursively and (if the skill was tracked in `.skill-lock.json`)
 * removes its lock entry. Accepts either declared name or dir
 * name. The lock entry is keyed by declared name; we remove both
 * the dir and the lock entry to keep the two in lockstep.
 *
 * Caller is responsible for cleaning up symlinks and DB
 * attachments BEFORE calling this — once the pool dir is gone,
 * those become dangling links / orphan rows.
 */
export async function removeFromPool(identifier: string): Promise<void> {
  // Resolve identifier → dirName. If we can't (skill already
  // gone), keep going with `identifier` for both lookups and
  // accept that the lock cleanup might miss — delete is
  // idempotent best-effort.
  const dirName = await findSkillDirName(identifier);
  // Look up the declared name from the pool entry when possible
  // (lock keys by declared name for meta-pack skills, e.g.
  // `ckm:banner-design` while dir is `ckm-banner-design`). Fall
  // back to the identifier for both — covers manual skills where
  // declared name == dir name == identifier.
  const pool = await scanSkillPool();
  const entry = pool.find((p) => p.dirName === dirName || p.name === identifier);
  const declaredName = entry?.name ?? identifier;
  const dir = join(resolveSkillPoolDir(), dirName ?? identifier);
  // recursive + force: missing dir is fine, that's our success
  // condition. Older Node versions need rm with `force: true` to
  // tolerate ENOENT.
  await fsp.rm(dir, { recursive: true, force: true });

  const lockPath = resolveSkillLockPath();
  let lockRaw: string;
  try {
    lockRaw = await fsp.readFile(lockPath, "utf-8");
  } catch {
    // No lock file — manual-only setup, nothing to update.
    return;
  }
  let lock: LockFile;
  try {
    lock = JSON.parse(lockRaw) as LockFile;
  } catch {
    // Don't trash a corrupted lock; the user can fix it manually.
    return;
  }
  if (!lock.skills) return;
  // Lock entries can be keyed by either declared name OR dir name
  // depending on the install path; remove whichever matches.
  let removed = false;
  if (lock.skills[declaredName]) {
    delete lock.skills[declaredName];
    removed = true;
  }
  if (dirName && dirName !== declaredName && lock.skills[dirName]) {
    delete lock.skills[dirName];
    removed = true;
  }
  if (!removed) return;

  const tmp = `${lockPath}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(lock, null, 2), { encoding: "utf-8" });
  await fsp.rename(tmp, lockPath);
}
