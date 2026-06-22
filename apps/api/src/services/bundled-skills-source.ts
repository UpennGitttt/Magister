/**
 * Bundled Magister skills — a leader-only virtual pool that lives inside
 * the repo at `packages/builtin-skills/`, NEVER inside the
 * machine-wide `~/.agents/skills/` pool.
 *
 * Why a separate layer:
 *   - `~/.agents/skills/` is the cross-tool pool that codex CLI
 *     (and through symlinks, claude-code + opencode) scans on its
 *     own. Anything we drop there leaks into every CLI agent's
 *     skill instructions. magister-* skills are leader-only by design,
 *     so they can't go there.
 *   - The bundled skills travel with the repo. Clone-and-run gives
 *     you the leader's full orchestration suite without any
 *     machine-wide install step.
 *
 * What this module exposes:
 *   - `listBundledSkills()`        — enumerate the skills + parsed
 *                                    frontmatter for the Skills UI
 *   - `readBundledSkillContent()`  — raw SKILL.md for `load_skill`
 *                                    and the leader's bootstrap
 *                                    body injection
 *   - `isBundledSkill()`           — name predicate for guards in
 *                                    skill-management-service (CLI
 *                                    attach / pool delete reject)
 */

import { promises as fsp } from "node:fs";
import { join } from "node:path";

import type { SkillPoolEntry } from "./skill-pool-service";

/**
 * Resolve the bundled source directory. Honors `MAGISTER_BUILTIN_SKILLS_DIR`
 * for tests / unusual setups; defaults to `<repo>/packages/builtin-skills`
 * relative to the API server cwd (matches how `restart.sh` boots).
 */
export function resolveBundledSkillsDir(): string {
  return (
    process.env.MAGISTER_BUILTIN_SKILLS_DIR?.trim()
    || join(process.cwd(), "packages", "builtin-skills")
  );
}

/** Parse the frontmatter `name:` and `description:` fields from a
 *  SKILL.md body. Mirrors skill-pool-service's parser so bundled
 *  entries surface identically to pool entries in the UI. */
function parseSkillFrontmatter(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return { name: fallbackName, description: "" };

  const block = match[1] ?? "";
  const lines = block.split("\n");
  let name = fallbackName;
  let description = "";
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  const flush = () => {
    if (currentKey === "name") name = currentValue.join("\n").trim() || fallbackName;
    else if (currentKey === "description") description = currentValue.join("\n").trim();
    currentKey = null;
    currentValue = [];
  };
  for (const raw of lines) {
    const m = raw.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m) {
      flush();
      currentKey = m[1] ?? null;
      currentValue = m[2] ? [m[2]] : [];
    } else if (currentKey) {
      currentValue.push(raw.trim());
    }
  }
  flush();
  return { name, description };
}

let cachedNames: { dir: string; mtimeMs: number; names: Set<string> } | null = null;

async function readBundledDir(): Promise<string[]> {
  const dir = resolveBundledSkillsDir();
  try {
    const st = await fsp.stat(dir);
    if (cachedNames && cachedNames.dir === dir && cachedNames.mtimeMs === st.mtimeMs) {
      return [...cachedNames.names];
    }
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    cachedNames = { dir, mtimeMs: st.mtimeMs, names: new Set(names) };
    return names;
  } catch {
    cachedNames = null;
    return [];
  }
}

/** Synchronous predicate. Reads through a small mtime-keyed cache
 *  so the fast path doesn't hit the FS on every `setAgentSkills`
 *  validation call. */
export async function isBundledSkill(name: string): Promise<boolean> {
  const names = await readBundledDir();
  return names.includes(name);
}

/** Enumerate bundled skills as `SkillPoolEntry` records so the
 *  Skills UI can render them through the same lens as github- and
 *  manual-sourced skills. The dirName equals the declared name —
 *  we don't support the meta-pack `prefix:sub` form here, only
 *  flat `magister-*` names.
 *
 *  When `roleId` is passed, the per-instance description override
 *  for that role replaces the bundled description in the returned
 *  entry. Callers that only need the bundled defaults (UI listing
 *  for users with multiple roles, tests) can omit `roleId`. */
export async function listBundledSkills(
  roleId?: string,
): Promise<SkillPoolEntry[]> {
  const dir = resolveBundledSkillsDir();
  const names = await readBundledDir();
  const overrides = roleId
    ? await (async () => {
        const { getSkillOverridesForRole } = await import(
          "../repositories/skill-override-repository"
        );
        return getSkillOverridesForRole(roleId);
      })()
    : null;
  const out: SkillPoolEntry[] = [];
  for (const name of names) {
    const skillFilePath = join(dir, name, "SKILL.md");
    let content: string;
    try {
      content = await fsp.readFile(skillFilePath, "utf-8");
    } catch {
      continue;
    }
    const { name: declaredName, description } = parseSkillFrontmatter(content, name);
    const override = overrides?.get(declaredName);
    const effectiveDescription = override?.descriptionOverride ?? description;
    out.push({
      name: declaredName,
      dirName: name,
      description: effectiveDescription,
      sourceKind: "builtin",
      skillFilePath,
    });
  }
  return out;
}

/** Whether a bundled-skill row has any per-instance customization
 *  for `roleId`. UI uses this to surface a "modified" badge so users
 *  can tell at a glance which bundled skills they've overridden. */
export async function hasSkillOverride(
  roleId: string,
  skillName: string,
): Promise<boolean> {
  const { getSkillOverride } = await import(
    "../repositories/skill-override-repository"
  );
  const row = await getSkillOverride(roleId, skillName);
  if (!row) return false;
  return row.descriptionOverride !== null || row.contentOverride !== null;
}

/** Read the SKILL.md body for a bundled skill. Returns null if the
 *  identifier isn't a bundled name. Accepts the declared name (what
 *  callers actually have in hand).
 *
 *  When `roleId` is passed, a per-instance content override for that
 *  role replaces the bundled body — the returned string is a fully
 *  reconstructed SKILL.md (frontmatter + body) so callers that
 *  strip the frontmatter via the standard `^---...---` regex still
 *  work uniformly regardless of which storage layer produced the
 *  content. */
export async function readBundledSkillContent(
  identifier: string,
  roleId?: string,
): Promise<string | null> {
  if (!identifier) return null;
  const names = await readBundledDir();
  if (!names.includes(identifier)) return null;

  let bundledRaw: string;
  try {
    bundledRaw = await fsp.readFile(
      join(resolveBundledSkillsDir(), identifier, "SKILL.md"),
      "utf-8",
    );
  } catch {
    return null;
  }

  if (!roleId) return bundledRaw;

  const { getSkillOverride } = await import(
    "../repositories/skill-override-repository"
  );
  const override = await getSkillOverride(roleId, identifier);
  // `null` means "no override on that axis" (the schema's only
  // "absent" signal). Empty-string is a real, intentional value
  // for that axis — the validators upstream reject "" submissions
  // today, but if a row ever lands with "" we honor it. Aligns
  // with `hasSkillOverride`'s `!== null` predicate.
  if (
    !override
    || (override.contentOverride === null && override.descriptionOverride === null)
  ) {
    return bundledRaw;
  }

  // At least one field is overridden — reconstruct the SKILL.md so
  // downstream frontmatter stripping still works. Parse the bundled
  // file's existing description (in case only `contentOverride` was
  // set we keep the bundled description).
  const { name: declaredName, description: bundledDesc } = parseSkillFrontmatter(
    bundledRaw,
    identifier,
  );
  const effectiveDesc = override.descriptionOverride ?? bundledDesc;
  const trimmedDesc = effectiveDesc.replace(/\s+/g, " ").trim();
  const bodyRaw = override.contentOverride
    ?? bundledRaw.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/, "");
  return `---\nname: ${declaredName}\ndescription: ${trimmedDesc}\n---\n\n${bodyRaw}`;
}

/** Test hook — clears the mtime-keyed cache so a test fixture
 *  rewriting the bundled dir takes effect immediately. */
export function _clearBundledSkillsCache(): void {
  cachedNames = null;
}

// (`writeBundledSkill` was removed once the UI edit path moved to
//  the DB-backed override layer. The repo files are now read-only at
//  runtime — operators edit them on disk via their normal git workflow
//  if they want to bump the upstream default for everyone.)
