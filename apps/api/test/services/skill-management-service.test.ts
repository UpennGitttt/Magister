/**
 * Orchestrator tests that exercise the unified read/write/delete
 * paths in `skill-management-service.ts`. Pool + CLI dirs + DB are
 * all isolated to a temp directory so tests run in parallel and
 * don't touch the developer machine state.
 *
 * Subprocess-spawning paths (`importSkillFromGithub`,
 * `refreshSkill`) aren't covered here — they shell out to
 * `npx skills`. End-to-end coverage for those lives in the manual
 * smoke tests we ran via curl during development.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-mgmt-test-"));
  prev = {
    MAGISTER_AGENTS_HOME: process.env.MAGISTER_AGENTS_HOME,
    MAGISTER_CODEX_HOME: process.env.MAGISTER_CODEX_HOME,
    MAGISTER_CLAUDE_HOME: process.env.MAGISTER_CLAUDE_HOME,
    MAGISTER_OPENCODE_HOME: process.env.MAGISTER_OPENCODE_HOME,
    MAGISTER_DB_PATH: process.env.MAGISTER_DB_PATH,
    MAGISTER_BUILTIN_SKILLS_DIR: process.env.MAGISTER_BUILTIN_SKILLS_DIR,
  };
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");
  process.env.MAGISTER_CODEX_HOME = join(tempDir, "codex");
  process.env.MAGISTER_CLAUDE_HOME = join(tempDir, "claude");
  process.env.MAGISTER_OPENCODE_HOME = join(tempDir, "opencode");
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  // Isolate the bundled-skills source so the repo's actual Magister-
  // bundled skills don't leak into tests that expect a clean pool.
  // listAllSkills + listSkillsForAgent("leader") read bundled skills
  // unconditionally; without this isolation, tests that plant a
  // skill and assert `length === 1` would see 1 + 7 bundled.
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = join(tempDir, "no-bundled");
  await mkdir(join(tempDir, "agents", "skills"), { recursive: true });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function plantSkill(name: string, opts: { frontmatterName?: string } = {}): Promise<void> {
  const dir = join(tempDir, "agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${opts.frontmatterName ?? name}\ndescription: ${name} desc\n---\n\n# ${name}\n\nbody`,
  );
}

test("listAllSkills aggregates pool + per-agent attachments", async () => {
  await plantSkill("a-skill");
  await plantSkill("b-skill");

  const { listAllSkills, setAgentSkills } = await import(
    "../../src/services/skill-management-service"
  );
  await setAgentSkills("leader", ["a-skill"]);
  await setAgentSkills("codex", ["a-skill", "b-skill"]);

  const items = await listAllSkills();
  const a = items.find((i) => i.name === "a-skill");
  const b = items.find((i) => i.name === "b-skill");
  expect(a?.attachedAgents.sort()).toEqual(["codex", "leader"]);
  expect(b?.attachedAgents).toEqual(["codex"]);
});

test("setAgentSkills returns precise diff (attached / detached / failed)", async () => {
  await plantSkill("kept");
  await plantSkill("removed");
  await plantSkill("added");

  const { setAgentSkills } = await import("../../src/services/skill-management-service");

  // Initial state.
  const first = await setAgentSkills("codex", ["kept", "removed"]);
  expect(first.attached.sort()).toEqual(["kept", "removed"]);
  expect(first.detached).toEqual([]);

  // Replace: keep one, drop one, add one.
  const second = await setAgentSkills("codex", ["kept", "added"]);
  expect(second.attached).toEqual(["added"]);
  expect(second.detached).toEqual(["removed"]);
  expect(second.failed).toEqual([]);
});

test("setAgentSkills surfaces per-skill failures without aborting the rest", async () => {
  await plantSkill("ok-one");
  // Don't plant the second skill — attach should fail for it.

  const { setAgentSkills } = await import("../../src/services/skill-management-service");
  const result = await setAgentSkills("codex", ["ok-one", "missing-one"]);
  expect(result.attached).toEqual(["ok-one"]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.name).toBe("missing-one");
  expect(result.failed[0]?.action).toBe("attach");
});

test("deleteSkill cascades through CLI symlinks, leader DB, and pool dir", async () => {
  await plantSkill("victim");
  const { setAgentSkills, deleteSkill, listAllSkills } = await import(
    "../../src/services/skill-management-service"
  );

  await setAgentSkills("leader", ["victim"]);
  await setAgentSkills("codex", ["victim"]);
  await setAgentSkills("claude-code", ["victim"]);

  const result = await deleteSkill("victim");
  expect(result.detachedFromCli.sort()).toEqual(["claude-code", "codex"]);
  expect(result.detachedFromLeader).toBe(true);

  const after = await listAllSkills();
  expect(after).toHaveLength(0);
});

test("deleteSkill works for meta-pack skills with declared name (colon)", async () => {
  await plantSkill("ckm-design", { frontmatterName: "ckm:design" });
  const { setAgentSkills, deleteSkill, listAllSkills } = await import(
    "../../src/services/skill-management-service"
  );
  await setAgentSkills("claude-code", ["ckm:design"]);

  const result = await deleteSkill("ckm:design");
  expect(result.detachedFromCli).toEqual(["claude-code"]);

  const after = await listAllSkills();
  expect(after).toHaveLength(0);
});

test("createManualSkill writes SKILL.md and rejects duplicate names", async () => {
  const { createManualSkill, listAllSkills } = await import(
    "../../src/services/skill-management-service"
  );
  const skill = await createManualSkill({
    name: "manual-test",
    description: "Test description",
    content: "# Body\n\nBody text",
  });
  expect(skill.name).toBe("manual-test");
  expect(skill.sourceKind).toBe("manual");

  const all = await listAllSkills();
  expect(all).toHaveLength(1);

  await expect(
    createManualSkill({ name: "manual-test", description: "x", content: "y" }),
  ).rejects.toThrow(/already exists/);
});

test("createManualSkill rejects invalid names + empty fields", async () => {
  const { createManualSkill } = await import(
    "../../src/services/skill-management-service"
  );

  await expect(
    createManualSkill({ name: "Bad Name", description: "x", content: "y" }),
  ).rejects.toThrow(/Invalid skill name/);
  await expect(
    createManualSkill({ name: "good-name", description: "  ", content: "y" }),
  ).rejects.toThrow(/description is required/);
  await expect(
    createManualSkill({ name: "good-name", description: "x", content: "" }),
  ).rejects.toThrow(/content cannot be empty/);
});

test("updateManualSkill refuses to edit github-sourced skills", async () => {
  await plantSkill("from-upstream");
  // Plant a lock entry so it gets classified as github.
  await writeFile(
    join(tempDir, "agents", ".skill-lock.json"),
    JSON.stringify({ skills: { "from-upstream": { sourceUrl: "https://github.com/x/y.git", sourceType: "github" } } }),
  );

  const { updateManualSkill } = await import(
    "../../src/services/skill-management-service"
  );
  await expect(
    updateManualSkill("from-upstream", { description: "trying to edit" }),
  ).rejects.toThrow(/diverge from upstream/);
});

test("listSkillsForAgent returns DB-only skills as a fallback (legacy support)", async () => {
  // Pre-pool tests / manual seeds wrote rows directly into the
  // `skills` table without a corresponding pool entry. Those
  // should still show up so the leader runtime doesn't lose
  // attachments during the migration window.
  const { createDb, agentSkills, skills } = await import("@magister/db");
  const db = createDb();
  await db.insert(skills).values({
    id: "skill_db_only",
    name: "db-only-skill",
    description: "exists in DB but not in pool",
    content: "body",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({ agentRole: "leader", skillId: "skill_db_only" });

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("leader");
  expect(items.map((i) => i.name)).toEqual(["db-only-skill"]);
});

// ─────────────────────────────────────────────────────────────────────
// Spec §6 — bundled SKILL.md description takes precedence over stale DB row
// (pull-on-read fix, 2026-05-17)
// ─────────────────────────────────────────────────────────────────────

async function plantBundledSkill(
  bundledDir: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(bundledDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody`,
  );
}

test("listSkillsForAgent: bundled SKILL.md description wins over stale DB row (leader)", async () => {
  // Point bundled-skills source at a populated test dir.
  const bundledDir = join(tempDir, "bundled");
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = bundledDir;
  await plantBundledSkill(
    bundledDir,
    "magister-planning",
    "Use when the user wants to plan a multi-step software task. (real bundled desc)",
  );

  // Seed a stale DB row + agent_skills attachment for the same name.
  const { createDb, agentSkills, skills } = await import("@magister/db");
  const db = createDb();
  await db.insert(skills).values({
    id: "skill_magister_planning_stale",
    name: "magister-planning",
    description: "planning desc",  // ← the stale stub the spec calls out
    content: "stale body",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "leader",
    skillId: "skill_magister_planning_stale",
  });

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("leader");
  const ucmPlanning = items.find((i) => i.name === "magister-planning");
  expect(ucmPlanning).toBeDefined();
  expect(ucmPlanning?.description).toContain("real bundled desc");
  expect(ucmPlanning?.description).not.toBe("planning desc");
});

test("listSkillsForAgent: skill_overrides wins over bundled description (leader)", async () => {
  // Precedence chain: skill_overrides > bundled > stale DB row.
  const bundledDir = join(tempDir, "bundled");
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = bundledDir;
  await plantBundledSkill(bundledDir, "magister-planning", "bundled default desc");

  const { setSkillOverride } = await import(
    "../../src/repositories/skill-override-repository"
  );
  await setSkillOverride("leader", "magister-planning", {
    descriptionOverride: "custom override desc",
  });

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("leader");
  const ucmPlanning = items.find((i) => i.name === "magister-planning");
  expect(ucmPlanning?.description).toBe("custom override desc");
});

test("listSkillsForAgent: bundled override path does NOT apply to non-leader roles", async () => {
  // Custom Magister teammate role; bundled SKILL.md should not be auto-
  // attached, and any DB row's description should not be overridden
  // by bundled even when names happen to collide.
  const bundledDir = join(tempDir, "bundled");
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = bundledDir;
  await plantBundledSkill(bundledDir, "magister-planning", "bundled desc");

  const { createDb, agentSkills, skills } = await import("@magister/db");
  const db = createDb();
  await db.insert(skills).values({
    id: "skill_planning_custom",
    name: "magister-planning",
    description: "custom-role-specific desc",
    content: "body",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "custom_translator",
    skillId: "skill_planning_custom",
  });

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("custom_translator");
  const ucmPlanning = items.find((i) => i.name === "magister-planning");
  expect(ucmPlanning?.description).toBe("custom-role-specific desc");
});

test("listSkillsForAgent: leader skill NOT in bundled set keeps its own description", async () => {
  // Negative test (codex review nice-to-have): the replace pass must
  // only touch entries that have a bundled counterpart. A regular
  // pool-sourced or DB-only skill attached to leader keeps its own
  // description unchanged even when bundled skills exist alongside.
  const bundledDir = join(tempDir, "bundled");
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = bundledDir;
  await plantBundledSkill(bundledDir, "magister-planning", "bundled planning desc");

  // Plant a pool-sourced skill (NOT in bundled set) and attach to leader.
  await plantSkill("non-bundled-tool");
  const { setAgentSkills, listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  await setAgentSkills("leader", ["non-bundled-tool"]);

  const items = await listSkillsForAgent("leader");
  const nonBundled = items.find((i) => i.name === "non-bundled-tool");
  expect(nonBundled).toBeDefined();
  // plantSkill writes `description: ${name} desc` via the test helper.
  expect(nonBundled?.description).toBe("non-bundled-tool desc");
});

test("listSkillsForAgent: dedupes same-name DB rows (defense-in-depth)", async () => {
  // The `skills` table doesn't enforce unique `name`, only unique `id`.
  // A misconfigured seed could write two rows with name="magister-planning"
  // both attached to leader → without dedupe the listing would surface
  // both as separate entries. Verify the final dedupe pass collapses
  // them to one (last-write-wins).
  const { createDb, agentSkills, skills } = await import("@magister/db");
  const db = createDb();
  await db.insert(skills).values({
    id: "skill_dup_a",
    name: "shared-name",
    description: "first row",
    content: "body a",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(skills).values({
    id: "skill_dup_b",
    name: "shared-name",
    description: "second row",
    content: "body b",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({ agentRole: "leader", skillId: "skill_dup_a" });
  await db.insert(agentSkills).values({ agentRole: "leader", skillId: "skill_dup_b" });

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("leader");
  const sharedEntries = items.filter((i) => i.name === "shared-name");
  expect(sharedEntries).toHaveLength(1);
});

test("listSkillsForAgent: bundled-only skill (no DB row) still auto-attaches to leader", async () => {
  // Original add-only behavior must keep working: bundled skill with
  // no DB attachment row should still be auto-listed for leader.
  const bundledDir = join(tempDir, "bundled");
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = bundledDir;
  await plantBundledSkill(
    bundledDir,
    "magister-shipping",
    "Use when implementation is complete and ready to ship.",
  );

  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const items = await listSkillsForAgent("leader");
  const ucmShipping = items.find((i) => i.name === "magister-shipping");
  expect(ucmShipping).toBeDefined();
  expect(ucmShipping?.description).toBe("Use when implementation is complete and ready to ship.");
});
