/**
 * Single front door for the unified skill model. Composes:
 *   - `skill-pool-service` (filesystem read of the central pool)
 *   - `skill-symlink-service` (per-CLI attachments via symlinks)
 *   - `agent_skills` table (leader's attachment, since it has no
 *     filesystem skills dir to symlink into)
 *
 * Callers (HTTP routes, the leader runtime) depend on this module
 * rather than touching the three sub-systems directly. If we ever
 * change how a skill gets to a particular agent (e.g. switch
 * leader from DB-attachment to a synthetic symlink), all the
 * callers stay the same.
 */

import {
  type SkillPoolEntry,
  removeFromPool,
  scanSkillPool,
  writeManualSkill,
} from "./skill-pool-service";
import {
  CLI_SKILL_AGENTS,
  type CliSkillAgent,
  attachSkillToCli,
  detachSkillFromCli,
  isCliSkillAgent,
  listAttachedCliSkills,
  resolveCliSkillsDir,
} from "./skill-symlink-service";
import {
  hasSkillOverride,
  isBundledSkill,
  listBundledSkills,
} from "./bundled-skills-source";
import {
  clearSkillOverride,
  setSkillOverride,
} from "../repositories/skill-override-repository";
import { isValidSkillName, isValidSkillSource, runSkillsCli, type SkillCliResult } from "./skill-cli-runner";

/**
 * Legacy type kept for backwards compatibility with callers that
 * expect the old 4-role enum. The skill system now accepts ANY
 * role string — leader, CLI agents, builtin teammates, and custom
 * roles all go through DB-backed attachment (except CLI roles
 * which use symlinks).
 *
 * The four roles that get the curated multi-checkbox UI on the
 * Skills tab. The leader is fixed and always present; the three
 * CLIs match what `npx skills` natively manages. Custom Magister
 * teammate roles aren't in this list — they still get DB-backed
 * attachment (same code path as leader) but are managed via the
 * teammate creation flow rather than the Skills tab.
 */
export type SkillAgentRole = "leader" | CliSkillAgent;
export const SKILL_AGENT_ROLES: readonly SkillAgentRole[] = ["leader", ...CLI_SKILL_AGENTS];

/**
 * @deprecated All roles can now attach skills. Use direct string
 * comparison or accept any roleId. This function is kept for
 * backwards compatibility with the Skills tab UI.
 */
export function isSkillAgentRole(roleId: string): roleId is SkillAgentRole {
  return (SKILL_AGENT_ROLES as readonly string[]).includes(roleId);
}

/**
 * Whether the role uses DB-backed attachment (`agent_skills` rows)
 * vs filesystem-backed (per-CLI symlinks). The leader and any
 * custom Magister teammate role go through DB; the three CLI roles go
 * through symlinks. The split reflects how the consumer reads
 * skills: in-process leader/teammate runtimes pull from DB at
 * prompt build time; CLI tools scan their own filesystem skills
 * dir at startup, which we manage via symlink.
 */
function usesSymlinkAttachment(role: string): role is CliSkillAgent {
  return isCliSkillAgent(role);
}

export type SkillView = SkillPoolEntry & {
  /** Roles this skill is currently attached to. Always a subset of
   *  `SKILL_AGENT_ROLES`. Empty when the skill is in the pool but
   *  no agent uses it — those still show in the UI so the user can
   *  attach them. */
  attachedAgents: SkillAgentRole[];
  /** True only for `sourceKind === "builtin"` rows whose leader-scoped
   *  override row exists with at least one field set. UI uses this
   *  to render a "Modified" badge + show the "Reset to default"
   *  button. Pool skills (github/manual) always report `false`. */
  hasOverride?: boolean;
};

/**
 * List every skill in the pool, enriched with which agents it's
 * attached to. This is what the Skills tab renders.
 *
 * The lookup runs three queries in parallel:
 *   - `scanSkillPool()` (reads filesystem)
 *   - per-CLI symlink scans (reads each `~/.{cli}/skills/`)
 *   - `agent_skills` rows for `agent_role = "leader"` (reads DB)
 * Each is cheap on its own; running in parallel keeps page load
 * under ~50ms even on slow disks.
 */
export async function listAllSkills(): Promise<SkillView[]> {
  // Pass "leader" into listBundledSkills so override descriptions
  // (per-instance edits) replace the bundled defaults in the UI
  // listing. Leader is the only role with bundled skills today, so
  // this is unambiguous; when other roles get bundled skills, this
  // becomes per-role and we revisit.
  const [pool, bundled, codexAttached, claudeAttached, opencodeAttached, leaderAttached] = await Promise.all([
    scanSkillPool(),
    listBundledSkills("leader"),
    listAttachedCliSkills("codex"),
    listAttachedCliSkills("claude-code"),
    listAttachedCliSkills("opencode"),
    listLeaderAttachedSkillNames(),
  ]);

  const codex = new Set(codexAttached);
  const claude = new Set(claudeAttached);
  const opencode = new Set(opencodeAttached);
  const leader = new Set(leaderAttached);

  const poolView = pool.map((entry) => {
    const attached: SkillAgentRole[] = [];
    if (leader.has(entry.name)) attached.push("leader");
    if (codex.has(entry.name)) attached.push("codex");
    if (claude.has(entry.name)) attached.push("claude-code");
    if (opencode.has(entry.name)) attached.push("opencode");
    return { ...entry, attachedAgents: attached };
  });

  // Bundled skills are leader-only by construction: they live in the
  // repo and never get symlinked into any CLI's skill dir or into
  // the machine-wide pool. The UI shouldn't render per-CLI
  // checkboxes for them — we still ship them through this same list
  // so the user sees them in the Skills tab.
  //
  // `hasOverride` reflects the per-instance edit state. The flag is
  // computed per-bundled-row via a separate lookup so the SkillView
  // payload tells the UI both "what would the leader see?" (the
  // entry's effective description, merged in listBundledSkills) and
  // "is this customized?" (the hasOverride flag, for the badge).
  const bundledView: SkillView[] = await Promise.all(
    bundled.map(async (entry) => ({
      ...entry,
      attachedAgents: ["leader" as SkillAgentRole],
      hasOverride: await hasSkillOverride("leader", entry.name),
    })),
  );

  // Stable order: bundled first (always-on leader skills), then the
  // user's own pool entries. Within each group, alphabetical by name.
  bundledView.sort((a, b) => a.name.localeCompare(b.name));
  return [...bundledView, ...poolView];
}

/**
 * List skills currently attached to a single agent. Used by the
 * `GET /agents/:roleId/skills` endpoint and the runtime skill
 * injection in `appendAgentSkills`. Accepts any role string —
 * custom Magister teammate roles (e.g., `custom_translator`) go through
 * the DB path same as `leader`.
 */
export async function listSkillsForAgent(role: string): Promise<SkillPoolEntry[]> {
  const all = await scanSkillPool();
  const byName = new Map(all.map((s) => [s.name, s] as const));
  const attached = usesSymlinkAttachment(role)
    ? await listAttachedCliSkills(role)
    : await listDbAttachedSkillNames(role);
  // Filter to skills that exist in the pool. DB rows for skills
  // that never made it into the pool (or were removed externally)
  // are silently dropped — listing them with no body would just
  // confuse the model.
  const fromPool = attached
    .map((name) => byName.get(name))
    .filter((entry): entry is SkillPoolEntry => entry !== undefined);
  // For DB-backed roles, also surface skills whose `skills` row
  // exists but isn't mirrored in the pool yet (legacy seeded data,
  // tests, manual DB inserts). We synthesize a SkillPoolEntry from
  // the DB row so existing callers (and the test fixtures that
  // pre-date the pool model) keep working.
  let result: SkillPoolEntry[];
  if (!usesSymlinkAttachment(role)) {
    const dbOnly = await listDbOnlySkills(role, new Set(fromPool.map((s) => s.name)));
    result = [...fromPool, ...dbOnly];
  } else {
    result = fromPool;
  }

  // Leader-only injection: bundled Magister skills are auto-attached to
  // leader without requiring an `agent_skills` row. They live in
  // `packages/builtin-skills/` (inside the repo) — physically
  // separate from the machine-wide pool so codex / claude-code /
  // opencode can't see them. Other roles never see bundled skills,
  // even if they have explicit DB rows referencing them (the rows
  // wouldn't resolve in the pool scan, so they'd be dropped above).
  //
  // Pass `role` into `listBundledSkills` so per-instance overrides
  // (skill_overrides table) take effect — a leader with an override
  // on `magister-planning` sees the override description, not the bundled
  // default.
  // Spec §6: bundled SKILL.md frontmatter is the source
  // of truth for built-in leader skills. The DB row's `description`
  // is a cache that can fall stale (concrete symptom 2026-05-16:
  // `magister-planning` had DB description = "planning desc" while the
  // SKILL.md frontmatter had the real 321-char firing condition).
  //
  // Two passes:
  //   1. REPLACE — for any entry already in `result` whose name has
  //      a bundled counterpart, override the description from the
  //      bundled side so stale DB cache loses to current frontmatter.
  //      `listBundledSkills(role)` already merges per-role
  //      `skill_overrides` entries, so the precedence chain becomes:
  //      `skill_overrides` > bundled SKILL.md > stale DB row.
  //   2. ADD — append bundled entries that aren't yet in `result`
  //      (the original auto-attach behavior).
  //
  // Body / content is NOT touched here — `load_skill` reads
  // `readSkillContent` from the filesystem on demand, so content
  // drift isn't a symptom today. If it ever becomes one, apply the
  // same pull-on-read pattern to the body field.
  if (role === "leader") {
    const bundled = await listBundledSkills(role);
    const bundledByName = new Map(bundled.map((s) => [s.name, s] as const));

    // Pass 1: replace description from bundled where bundled exists.
    result = result.map((entry) => {
      const bundledOverride = bundledByName.get(entry.name);
      if (!bundledOverride) return entry;
      return {
        ...entry,
        description: bundledOverride.description,
      };
    });

    // Pass 2: add bundled entries not yet in result.
    const seen = new Set(result.map((s) => s.name));
    for (const entry of bundled) {
      if (!seen.has(entry.name)) {
        result.push(entry);
      }
    }
  }

  // Defense-in-depth (codex review 2026-05-17): collapse any
  // same-name duplicates that slipped in. The merge logic above
  // doesn't introduce duplicates by itself (fromPool / dbOnly are
  // disjoint by name; bundled-add is gated on `seen`), but the
  // upstream `skills` table doesn't constrain `name` to be unique,
  // so a misconfigured seed with two rows sharing the same name
  // attached to the same role could land twice in `result`. Keep
  // last-write-wins so any bundled-applied description survives.
  if (result.length > 1) {
    const dedupedByName = new Map<string, SkillPoolEntry>();
    for (const entry of result) {
      dedupedByName.set(entry.name, entry);
    }
    if (dedupedByName.size !== result.length) {
      return Array.from(dedupedByName.values());
    }
  }
  return result;
}

/**
 * Replace the full attachment set for an agent. The frontend POSTs
 * the desired final state (a list of skill names); we diff against
 * the current state and apply only the additions/removals.
 *
 * Failures are partial: if attaching/detaching one skill fails, we
 * surface the error but don't roll back successful ones — the user
 * sees a precise message about what worked and what didn't, and
 * can retry or fix. Returns a structured summary so the UI can
 * show feedback per-skill.
 */
export async function setAgentSkills(
  role: string,
  desiredNames: string[],
): Promise<{
  attached: string[];
  detached: string[];
  failed: Array<{ name: string; action: "attach" | "detach"; error: string }>;
}> {
  const desired = new Set(desiredNames);
  const current = new Set(
    usesSymlinkAttachment(role)
      ? await listAttachedCliSkills(role)
      : await listDbAttachedSkillNames(role),
  );

  const toAttach = [...desired].filter((n) => !current.has(n));
  const toDetach = [...current].filter((n) => !desired.has(n));

  const attached: string[] = [];
  const detached: string[] = [];
  const failed: Array<{ name: string; action: "attach" | "detach"; error: string }> = [];

  for (const name of toAttach) {
    try {
      // Bundled Magister skills are leader-only by construction. Reject
      // attempts to attach them to CLI roles (would create a dead
      // symlink target since they're not in the pool) or to non-leader
      // DB roles (would create a useless agent_skills row that the
      // listSkillsForAgent filter drops anyway). Leader doesn't need
      // this code path — bundled skills auto-attach in listSkillsForAgent.
      if (role !== "leader" && (await isBundledSkill(name))) {
        failed.push({
          name,
          action: "attach",
          error: `Skill "${name}" is a Magister-bundled leader-only skill and cannot be attached to ${role}.`,
        });
        continue;
      }
      if (usesSymlinkAttachment(role)) {
        await attachSkillToCli(role, name);
      } else {
        await attachSkillToDbRole(role, name);
      }
      attached.push(name);
    } catch (err) {
      failed.push({
        name,
        action: "attach",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const name of toDetach) {
    try {
      if (usesSymlinkAttachment(role)) {
        await detachSkillFromCli(role, name);
      } else {
        await detachSkillFromDbRole(role, name);
      }
      detached.push(name);
    } catch (err) {
      failed.push({
        name,
        action: "detach",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { attached, detached, failed };
}

// ---------------------------------------------------------------
// DB-backed attachment (leader + custom Magister teammates). Kept
// private so the public API is uniform across roles — callers
// shouldn't care that leader uses rows and CLIs use symlinks.
// ---------------------------------------------------------------

async function listLeaderAttachedSkillNames(): Promise<string[]> {
  return listDbAttachedSkillNames("leader");
}

async function listDbAttachedSkillNames(role: string): Promise<string[]> {
  const { createDb, agentSkills } = await import("@magister/db");
  const { eq } = await import("@magister/db");
  const db = createDb();
  const links = await db.query.agentSkills.findMany({
    where: eq(agentSkills.agentRole, role),
  });
  if (links.length === 0) return [];
  const skillIds = links.map((l) => l.skillId);
  const rows = await db.query.skills.findMany({
    where: (s, ops) => ops.inArray(s.id, skillIds),
  });
  return rows.map((r) => r.name).filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * Return DB-only skills attached to `role` whose names are NOT
 * already in `excludeNames` (i.e., skills that exist purely in DB
 * with no pool counterpart). We synthesize SkillPoolEntry shape so
 * the runtime injection flow doesn't have to care about the
 * source. Pre-pool tests / manual seeds fall into this bucket;
 * once the pool model fully takes over they go away.
 */
async function listDbOnlySkills(
  role: string,
  excludeNames: Set<string>,
): Promise<SkillPoolEntry[]> {
  const { createDb, agentSkills } = await import("@magister/db");
  const { eq } = await import("@magister/db");
  const db = createDb();
  const links = await db.query.agentSkills.findMany({
    where: eq(agentSkills.agentRole, role),
  });
  if (links.length === 0) return [];
  const ids = links.map((l) => l.skillId);
  const rows = await db.query.skills.findMany({
    where: (s, ops) => ops.inArray(s.id, ids),
  });
  return rows
    .filter((r) => typeof r.name === "string" && r.name.length > 0 && !excludeNames.has(r.name))
    .map((r) => ({
      name: r.name as string,
      // Synthetic entries have no filesystem dir — surface the
      // declared name as `dirName` so any code that wants to use
      // it for a path still resolves to a sensible (though missing)
      // target rather than undefined behavior.
      dirName: r.name as string,
      description: r.description ?? "",
      sourceKind: "manual" as const,
      skillFilePath: "(db-only, no pool entry)",
    }));
}

async function attachSkillToDbRole(roleId: string, skillName: string): Promise<void> {
  const { createDb, agentSkills, skills } = await import("@magister/db");

  // Verify the skill exists in the pool. We don't cache its
  // content/description in the DB — leader runtime reads
  // `appendAgentSkills` and `load_skill` directly from the pool so
  // `npx skills update` is reflected without a re-attach. The
  // `skills` table here is purely an attachment-target index;
  // `description` is stored as a hint for legacy consumers (older
  // SkillList API surface) but the source of truth is always the
  // pool.
  const pool = await scanSkillPool();
  const entry = pool.find((e) => e.name === skillName);
  if (!entry) {
    throw new Error(
      `Cannot attach "${skillName}" to ${roleId}: skill not found in the central pool.`,
    );
  }

  const db = createDb();
  // Deterministic id `skill_<name>` so two concurrent attach calls
  // (two browser tabs, refresh + click in quick succession) both
  // target the same row instead of inserting siblings. Schema
  // has no UNIQUE on `name`, so the previous timestamp-suffixed id
  // could leak duplicate rows through a race. `onConflictDoUpdate`
  // makes attach idempotent by id.
  //
  // Migration note: any pre-existing rows from the timestamp-id
  // era (`skill_<name>_<ts>`) are left in place but no longer
  // attached. `detachSkillFromDbRole` cleans them up by name on
  // next detach. They're harmless — leader runtime never reads
  // through them.
  const skillId = `skill_${skillName}`;
  // Empty `content` on attach: the `skills.content` column is
  // only populated by `createManualSkill` (where the user is the
  // source of truth in the absence of a pool body). For pool
  // skills attached to any role, the body lives in the pool —
  // writing it into the DB just creates a stale duplicate that
  // someone might accidentally trust as authoritative.
  await db
    .insert(skills)
    .values({
      id: skillId,
      name: skillName,
      description: entry.description,
      content: "",
      createdBy: "skill-pool",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: skills.id,
      set: {
        description: entry.description,
        updatedAt: new Date(),
      },
    });

  // INSERT IGNORE — already-attached is a no-op, not an error.
  await db
    .insert(agentSkills)
    .values({ agentRole: roleId, skillId })
    .onConflictDoNothing();
}

/** Detach a skill from EVERY DB role at once. Used by deleteSkill so
 *  pool removal doesn't leave orphan `agent_skills` rows pointing at a
 *  skill that no longer exists. Keeps the cached `skills` row for
 *  history (createdBy / createdAt) — identical policy to the per-role
 *  detacher below, just no role filter on the WHERE. */
async function detachSkillFromAllDbRoles(skillName: string): Promise<void> {
  const { createDb, agentSkills, skills } = await import("@magister/db");
  const { eq, inArray } = await import("@magister/db");
  const db = createDb();

  const matches = await db.query.skills.findMany({
    where: eq(skills.name, skillName),
  });
  if (matches.length === 0) return;
  const ids = matches.map((m) => m.id);
  await db.delete(agentSkills).where(inArray(agentSkills.skillId, ids));
}

async function detachSkillFromDbRole(roleId: string, skillName: string): Promise<void> {
  const { createDb, agentSkills, skills } = await import("@magister/db");
  const { and, eq } = await import("@magister/db");
  const db = createDb();

  const matches = await db.query.skills.findMany({
    where: eq(skills.name, skillName),
  });
  if (matches.length === 0) return;
  const ids = matches.map((m) => m.id);
  // Remove the attachment rows but keep the cached skill row — that
  // way re-attaching later is faster (no fresh read) and history
  // (createdBy / createdAt) is preserved.
  for (const id of ids) {
    await db
      .delete(agentSkills)
      .where(and(eq(agentSkills.agentRole, roleId), eq(agentSkills.skillId, id)));
  }
}

// Backwards compatibility wrappers — old callers still work.
async function attachSkillToLeader(skillName: string): Promise<void> {
  return attachSkillToDbRole("leader", skillName);
}

async function detachSkillFromLeader(skillName: string): Promise<void> {
  return detachSkillFromDbRole("leader", skillName);
}

// ---------------------------------------------------------------
// Phase 3: GitHub install / update via the `skills` CLI.
// ---------------------------------------------------------------

export type SkillImportResult = {
  ok: boolean;
  source: string;
  cli: SkillCliResult;
  /** The skill that landed in the pool, if we can identify it
   *  unambiguously from the install. Null when the CLI installed
   *  multiple sub-skills (a meta-pack) or when the install
   *  failed. */
  skill?: SkillPoolEntry;
};

/**
 * Install a skill from a GitHub source string (`<owner>/<repo>` or
 * `<owner>/<repo>@<skill>`). Wraps `npx skills add -g -y <source>`.
 * `-g` writes to the global pool (~/.agents/skills/) which is what
 * we want; `-y` skips interactive prompts so the subprocess never
 * hangs on stdin.
 *
 * Returns the raw CLI result so the UI can surface stderr verbatim
 * on failure — those messages are usually informative (network
 * down, repo not found, etc.) and we don't want to repackage them
 * into a vague error.
 */
export async function importSkillFromGithub(source: string): Promise<SkillImportResult> {
  if (!isValidSkillSource(source)) {
    return {
      ok: false,
      source,
      cli: {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `Invalid source format: "${source}". Expected "<owner>/<repo>" or "<owner>/<repo>@<skill>".`,
        timedOut: false,
        truncated: false,
        durationMs: 0,
      },
    };
  }

  // Capture pool state before/after so we can identify what got
  // added — `npx skills add` doesn't print the skill name on
  // stdout in a stable format we can rely on.
  const before = new Set((await scanSkillPool()).map((s) => s.name));
  const cli = await runSkillsCli(["add", "-g", "-y", source]);
  if (!cli.ok) {
    return { ok: false, source, cli };
  }

  const after = await scanSkillPool();
  const newEntries = after.filter((s) => !before.has(s.name));
  // For a single-skill install we expect exactly one new entry; a
  // meta-pack might add multiple. Either way return ok=true and
  // let the UI re-fetch /skills to see the full new state.
  return {
    ok: true,
    source,
    cli,
    ...(newEntries.length === 1 ? { skill: newEntries[0] } : {}),
  };
}

export type SkillRefreshResult = {
  ok: boolean;
  name: string;
  cli: SkillCliResult;
  skill?: SkillPoolEntry;
};

/**
 * Re-pull a GitHub-sourced skill via `npx skills update <name>`.
 * Manual skills are rejected — there's nothing to refresh against.
 * The CLI's update command performs a `git pull` in the skill's
 * cached repo and rewrites the lock entry's commit hash; we rely
 * on it doing that correctly rather than touching the lock file
 * ourselves.
 */
export async function refreshSkill(name: string): Promise<SkillRefreshResult> {
  // Looser than the create-time check (allows `:` for meta-pack
  // names). Pool lookup below is the real validator.
  if (!name.trim() || name.includes("/") || name.includes("..") || name.includes("\\")) {
    return refreshFailure(name, `Invalid skill name "${name}".`);
  }
  const pool = await scanSkillPool();
  const entry = pool.find((s) => s.name === name);
  if (!entry) {
    return refreshFailure(name, `Skill "${name}" is not installed.`);
  }
  if (entry.sourceKind !== "github") {
    return refreshFailure(
      name,
      `Skill "${name}" is a manual skill — there's no upstream source to refresh from. Edit its content directly instead.`,
    );
  }

  const cli = await runSkillsCli(["update", name]);
  if (!cli.ok) {
    return { ok: false, name, cli };
  }
  const after = await scanSkillPool();
  const updated = after.find((s) => s.name === name);
  return { ok: true, name, cli, ...(updated ? { skill: updated } : {}) };
}

function refreshFailure(name: string, message: string): SkillRefreshResult {
  return {
    ok: false,
    name,
    cli: {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: message,
      timedOut: false,
      truncated: false,
      durationMs: 0,
    },
  };
}

// ---------------------------------------------------------------
// Phase 4: manual skill CRUD + universal delete.
// ---------------------------------------------------------------

export type ManualSkillInput = {
  name: string;
  description: string;
  content: string;
};

/**
 * Create a brand-new manually-authored skill. Refuses to write
 * over an existing pool entry — the caller must delete the old
 * one first or pick a different name. Validates name shape so the
 * resulting directory is always safe to feed into other tools.
 */
export async function createManualSkill(input: ManualSkillInput): Promise<SkillPoolEntry> {
  const { name, description, content } = input;
  if (!isValidSkillName(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use lowercase letters, digits, and hyphens; must start with a letter; max 64 chars.`,
    );
  }
  if (!description.trim()) {
    throw new Error("Skill description is required — it's the firing condition the model uses to decide when to load this skill.");
  }
  if (!content.trim()) {
    throw new Error("Skill content cannot be empty.");
  }
  await writeManualSkill(name, description, content, "create");

  const pool = await scanSkillPool();
  const entry = pool.find((s) => s.name === name);
  if (!entry) {
    // Should not happen — write succeeded, scan didn't find it.
    // Surfacing this rather than swallowing protects against
    // silent filesystem misconfiguration (wrong pool dir, etc.).
    throw new Error(`Skill "${name}" was written but not visible in the pool scan. Check ${name}/SKILL.md for frontmatter errors.`);
  }
  return entry;
}

/**
 * Update a manual skill's description and/or content. We rewrite
 * the SKILL.md from scratch with the new frontmatter + body,
 * preserving the name (renames need delete+create to keep the
 * model stateless about renames). GitHub-sourced skills are
 * rejected — editing them locally would diverge from upstream and
 * `npx skills update` would later try to re-pull the original.
 */
export async function updateManualSkill(
  name: string,
  patch: { description?: string; content?: string },
): Promise<SkillPoolEntry> {
  // Bundled Magister skills get their own write path — they live in the
  // repo (`packages/builtin-skills/<name>/SKILL.md`), not in the
  // pool. Same edit-by-name UX from the UI's perspective, different
  // filesystem target. Operator is expected to commit the change.
  if (await isBundledSkill(name)) {
    return updateBundledSkill(name, patch);
  }
  const pool = await scanSkillPool();
  const existing = pool.find((s) => s.name === name);
  if (!existing) {
    throw new Error(`Skill "${name}" is not installed.`);
  }
  if (existing.sourceKind !== "manual") {
    throw new Error(
      `Skill "${name}" came from ${existing.sourceUrl ?? "GitHub"}. Editing it locally would diverge from upstream and break refresh. Fork the repo if you want to customize.`,
    );
  }

  const description = patch.description ?? existing.description;
  // For content, we have to read what's there now (only frontmatter
  // is in the SkillPoolEntry). If the caller didn't supply new
  // content, keep the body as-is.
  const { readSkillContent } = await import("./skill-pool-service");
  const currentRaw = (await readSkillContent(name)) ?? "";
  // Strip the existing frontmatter from raw — `writeManualSkill`
  // re-emits its own frontmatter from `description`.
  const body = patch.content ?? currentRaw.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/, "");

  if (!description.trim()) {
    throw new Error("Skill description cannot be empty.");
  }
  if (!body.trim()) {
    throw new Error("Skill content cannot be empty.");
  }
  await writeManualSkill(name, description, body, "update");

  const refreshed = await scanSkillPool();
  const entry = refreshed.find((s) => s.name === name);
  if (!entry) {
    throw new Error(`Skill "${name}" disappeared mid-update. Check the filesystem.`);
  }
  return entry;
}

/** Bundled write path — UI edit lands here. We never modify the repo
 *  file; instead, the change is recorded as a per-instance override
 *  in the `skill_overrides` table, keyed by (role, skill_name).
 *  Defaults are still the bundled file, so users on a fresh clone
 *  see Magister's recommended orchestration suite; users who customized
 *  see their version; both can revert per-skill via the "Reset to
 *  default" button (clearSkillOverride).
 *
 *  This is the parallel to `agent_profiles.system_prompt_override`:
 *  same shape, same UX, same migration semantics (delete the
 *  override row to restore the bundled default).
 *
 *  Partial-patch semantics (the contract callers can rely on):
 *    - `patch.description` omitted → keep whatever override is
 *      currently in effect for description (or bundled default if
 *      no override)
 *    - `patch.content` omitted → same for content
 *    - Either field equal to the bundled default → that axis's
 *      override row is cleared (we store null so the row stays slim)
 *    - Both axes match bundled → the whole override row is dropped
 *
 *  The "missing field falls back to existing override" rule is what
 *  makes partial PATCHes safe — without it, a description-only edit
 *  would silently wipe the content override (codex review MUST-FIX #1).
 */
async function updateBundledSkill(
  name: string,
  patch: { description?: string; content?: string },
): Promise<SkillPoolEntry> {
  // Bundled defaults — what we compare patches against to decide
  // whether to store an override on each axis.
  const bundledList = await listBundledSkills();
  const bundledEntry = bundledList.find((s) => s.name === name);
  if (!bundledEntry) {
    // Should be impossible given the dispatcher gate, but defend.
    throw new Error(`Bundled skill "${name}" not found.`);
  }
  const { readBundledSkillContent } = await import("./bundled-skills-source");
  const bundledRaw = (await readBundledSkillContent(name)) ?? "";
  const bundledBody = bundledRaw.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/, "");
  const bundledDesc = bundledEntry.description;

  // Existing override (if any) — used to fill in fields the patch
  // omits so we don't silently wipe the other axis.
  const { getSkillOverride } = await import(
    "../repositories/skill-override-repository"
  );
  const existing = await getSkillOverride("leader", name);

  // Effective values: user-provided > existing override > bundled.
  const description = patch.description
    ?? existing?.descriptionOverride
    ?? bundledDesc;
  const body = patch.content
    ?? existing?.contentOverride
    ?? bundledBody;

  if (!description.trim()) {
    throw new Error("Skill description cannot be empty.");
  }
  if (!body.trim()) {
    throw new Error("Skill content cannot be empty.");
  }

  // Compute axis-level override state by comparing the effective
  // value to the bundled default. Equal → store null (no override
  // on that axis). Different → store the value.
  const descChanged = description !== bundledDesc;
  const contentChanged = body !== bundledBody;

  if (!descChanged && !contentChanged) {
    // Effective value matches bundled on both axes — drop the row
    // entirely so the UI's "Modified" badge clears.
    await clearSkillOverride("leader", name);
  } else {
    await setSkillOverride("leader", name, {
      descriptionOverride: descChanged ? description : null,
      contentOverride: contentChanged ? body : null,
    });
  }

  const refreshed = (await listBundledSkills("leader")).find((s) => s.name === name);
  if (!refreshed) {
    throw new Error(`Bundled skill "${name}" disappeared mid-update.`);
  }
  return refreshed;
}

/** Drop a bundled skill's override row, restoring the bundled
 *  default. Idempotent — clearing a non-existent override is a
 *  no-op. Used by the "Reset to default" button. */
export async function resetBundledSkillOverride(
  roleId: string,
  skillName: string,
): Promise<void> {
  if (!(await isBundledSkill(skillName))) {
    throw new Error(`"${skillName}" is not a Magister-bundled skill.`);
  }
  await clearSkillOverride(roleId, skillName);
}

export type SkillDeleteResult = {
  /** Always true if we got this far without throwing — partial
   *  failures bubble as exceptions. The shape is kept for
   *  symmetry with import / refresh in case we add per-step
   *  reporting later. */
  ok: true;
  name: string;
  /** Per-CLI symlinks we removed before deleting from the pool. */
  detachedFromCli: string[];
  /** True if a leader DB attachment was removed. */
  detachedFromLeader: boolean;
};

/**
 * Universal delete. Walks the cleanup in dependency order:
 *   1. Detach from leader (DB row).
 *   2. Detach from each CLI (remove symlinks). Done before the
 *      pool delete so the symlinks don't dangle for even a moment.
 *   3. Remove from the central pool (rmdir + drop lock entry).
 *
 * Order matters: if we deleted the pool first and crashed before
 * detaching, the CLIs would scan a dir of dangling symlinks
 * which `npx skills check` might then try to "repair" in
 * surprising ways. Doing it in this order means the pool entry
 * stays valid until the moment everything else is gone.
 */
export async function deleteSkill(name: string): Promise<SkillDeleteResult> {
  // Don't apply the strict slug validator here — meta-pack skills
  // declared with a `<prefix>:<sub>` name (e.g. ckm:banner-design)
  // would otherwise be undeletable through this endpoint. The pool
  // resolver (`findSkillDirName`) is the actual safety boundary —
  // it only operates on entries that exist in `~/.agents/skills/`.
  if (!name.trim()) {
    throw new Error("Skill name cannot be empty.");
  }
  // Bundled Magister skills live in the repo and are leader-only by
  // construction. Deleting one would orphan the leader's
  // orchestration suite for any user pulling the repo. The Skills UI
  // hides the delete button on bundled rows; this server-side guard
  // is the second line of defense against a curl or stale client.
  if (await isBundledSkill(name)) {
    throw new Error(
      `"${name}" is a Magister-bundled leader-only skill and cannot be deleted from this UI. Edit it in packages/builtin-skills/ instead.`,
    );
  }
  // Defense-in-depth against path traversal. Skill names from `npx
  // skills` are safe by construction; this guard catches a buggy
  // caller passing a relative path.
  if (name.includes("/") || name.includes("..") || name.includes("\\")) {
    throw new Error(`Invalid skill name "${name}" (path-like characters not allowed).`);
  }

  // Capture which CLIs had it attached, so we can report back.
  const detachedFromCli: string[] = [];
  for (const cli of CLI_SKILL_AGENTS) {
    const attached = await listAttachedCliSkills(cli);
    if (attached.includes(name)) {
      await detachSkillFromCli(cli, name);
      detachedFromCli.push(cli);
    }
  }

  // Detach every DB-backed attachment in one shot. Pre-Phase-3 this
  // only iterated leader, but role-broadening (ab55c1d) lets ANY role
  // hold an agent_skills row — builtin teammates (coder/reviewer/…)
  // and custom Magister agents included. Filtering by skillId reaps them
  // all atomically; orphan rows that survive a delete-and-reimport
  // were the original symptom this fixes.
  const leaderAttached = (await listLeaderAttachedSkillNames()).includes(name);
  await detachSkillFromAllDbRoles(name);

  await removeFromPool(name);

  return { ok: true, name, detachedFromCli, detachedFromLeader: leaderAttached };
}

// Suppress unused-import warning when only some helpers are used
// (e.g. `resolveCliSkillsDir` is exposed for future endpoints but
// currently only consumed by the symlink module).
void resolveCliSkillsDir;
