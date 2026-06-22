import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

let prevBuiltinDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "teammate-prompts-test-"));
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `prompts-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  // Isolate the bundled-skills source — without this the repo's
  // real `packages/builtin-skills/` is read on every leader prompt
  // build and tests that plant their own `magister-using-skills` would
  // see both copies (asserting one but getting two).
  prevBuiltinDir = process.env.MAGISTER_BUILTIN_SKILLS_DIR;
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = join(tempDir, "no-bundled");
});

afterEach(async () => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_AGENTS_HOME;
  if (prevBuiltinDir === undefined) {
    delete process.env.MAGISTER_BUILTIN_SKILLS_DIR;
  } else {
    process.env.MAGISTER_BUILTIN_SKILLS_DIR = prevBuiltinDir;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("getTeammateSystemPrompt returns prompt for each role", async () => {
  const { getTeammateSystemPrompt } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );

  const roles = ["coder", "reviewer", "architect", "lander"] as const;
  for (const role of roles) {
    const prompt = getTeammateSystemPrompt(role);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(20);
  }
});

test("getTeammateTools excludes spawn_teammate for teammates", async () => {
  const { getTeammateTools } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );

  const tools = await getTeammateTools("/tmp/test-workspace");
  const names = tools.map((t) => t.name);
  expect(names).toContain("bash");
  expect(names).toContain("read_file");
  expect(names).not.toContain("spawn_teammate");
  expect(names).not.toContain("spawn_subagent");
  expect(names).not.toContain("request_human_input");
});

test("appendAgentSkills returns base prompt unchanged when no skills are linked", async () => {
  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );

  const result = await appendAgentSkills("coder", "BASE PROMPT");
  expect(result).toBe("BASE PROMPT");
});

test("appendAgentSkills emits metadata-only listing (progressive disclosure)", async () => {
  // Pre-2026-04-30 behavior was to inline every skill's full body
  // into the system prompt up front. New behavior follows
  // Anthropic's Claude Skills pattern: only `name + description` is
  // in the prompt; the full body is loaded on demand by the
  // `load_skill` tool. This test pins the new shape so a future
  // refactor doesn't silently regress to the inline format and
  // re-explode prompt size.
  //
  // SK1: the skill must have a pool entry so it passes the
  // loadable-skill filter in appendAgentSkills. Plant it in both
  // the pool AND the DB so the attach resolves.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "i18n_basics"), { recursive: true });
  await writeFile(
    join(poolDir, "i18n_basics", "SKILL.md"),
    "---\nname: i18n_basics\ndescription: Locale handling primer\n---\n\nUse ICU MessageFormat for plural / select.",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_localization",
    name: "i18n_basics",
    description: "Locale handling primer",
    content: "Use ICU MessageFormat for plural / select.",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "custom_translator",
    skillId: "skill_test_localization",
  });

  const result = await appendAgentSkills("custom_translator", "BASE PROMPT");
  expect(result).toContain("BASE PROMPT");
  // Header + per-skill `- name: description` line.
  expect(result).toContain("# Available skills");
  expect(result).toContain("- i18n_basics: Locale handling primer");
  // Body MUST NOT be in the prompt — that's the whole point of the
  // progressive-disclosure refactor.
  expect(result).not.toContain("Use ICU MessageFormat");
  // Protocol mentions the loader tool by name so the model knows
  // how to fetch a body when it decides one is relevant.
  expect(result).toContain("load_skill");
});

test("appendAgentSkills flags skills with no description so the gap is visible", async () => {
  // A skill without a description gives the model nothing to decide
  // on — flag it inline so the operator knows to fill it in via
  // the Skills tab. We don't hide the skill entirely because that
  // would create an "I attached it but it doesn't show up" mystery.
  //
  // SK1: the skill must have a pool entry so it passes the
  // loadable-skill filter. Plant it in the pool with an empty
  // description to exercise the "(no description)" flag path.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "no_desc_skill"), { recursive: true });
  await writeFile(
    join(poolDir, "no_desc_skill", "SKILL.md"),
    // Intentionally omit description from frontmatter to exercise the
    // no-description flag path — the pool entry will have description "".
    "---\nname: no_desc_skill\n---\n\nbody",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_nodesc",
    name: "no_desc_skill",
    description: null,
    content: "body",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "custom_translator",
    skillId: "skill_test_nodesc",
  });

  const result = await appendAgentSkills("custom_translator", "BASE PROMPT");
  expect(result).toContain("- no_desc_skill: (no description");
});

test("appendAgentSkills degrades silently to base prompt on DB error", async () => {
  // Point at a path the DB layer can't open — appendAgentSkills must
  // still return the base prompt rather than throwing, so spawn never
  // breaks because of a skill lookup hiccup.
  process.env.MAGISTER_DB_PATH = "/dev/null/nonexistent.sqlite";
  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );

  const result = await appendAgentSkills("coder", "BASE PROMPT");
  expect(result).toBe("BASE PROMPT");
});

test("appendAgentSkills injects magister-using-skills body for leader", async () => {
  // Plant the bootstrap skill in a temp pool so readSkillContent can find it.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "magister-using-skills"), { recursive: true });
  await writeFile(
    join(poolDir, "magister-using-skills", "SKILL.md"),
    "---\nname: magister-using-skills\ndescription: bootstrap desc\n---\n\n# BOOTSTRAP BODY\nRed flag 1: STOP.",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_bootstrap",
    name: "magister-using-skills",
    description: "bootstrap desc",
    content: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "leader",
    skillId: "skill_test_bootstrap",
  });

  const result = await appendAgentSkills("leader", "BASE PROMPT");
  // Bootstrap body must be inline
  expect(result).toContain("BOOTSTRAP BODY");
  expect(result).toContain("Red flag 1");
  // The skill should NOT appear in the progressive-disclosure list
  expect(result).not.toContain("- magister-using-skills:");
});

test("appendAgentSkills does NOT inject body for non-leader", async () => {
  // SK1: skill must have a pool entry to be advertised.
  // Plant the skill in the pool so appendAgentSkills can list it.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "magister-using-skills"), { recursive: true });
  await writeFile(
    join(poolDir, "magister-using-skills", "SKILL.md"),
    "---\nname: magister-using-skills\ndescription: bootstrap desc\n---\n\n# BOOTSTRAP BODY",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_bootstrap2",
    name: "magister-using-skills",
    description: "bootstrap desc",
    content: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "reviewer",
    skillId: "skill_test_bootstrap2",
  });

  const result = await appendAgentSkills("reviewer", "BASE PROMPT");
  // Only description listed, body NOT injected (bootstrap is leader-only)
  expect(result).toContain("- magister-using-skills:");
  expect(result).not.toContain("BOOTSTRAP BODY");
});

test("appendAgentSkills gracefully handles missing magister-using-skills body", async () => {
  // Isolate pool to an empty temp dir so readSkillContent can't find
  // any pre-existing magister-using-skills in the real ~/.agents/skills/.
  // SK1 behavior: since the pool file is absent, the skill is NOT advertised
  // (the old fallback "description-only listing" was removed — advertising
  // an unloadable skill leads the model to call load_skill and get an error).
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "empty-pool");
  await mkdir(join(tempDir, "empty-pool", "skills"), { recursive: true });

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_bootstrap3",
    name: "magister-using-skills",
    description: "bootstrap desc",
    content: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "leader",
    skillId: "skill_test_bootstrap3",
  });

  // No pool dir planted — skill is pool-missing and must NOT be advertised.
  const result = await appendAgentSkills("leader", "BASE PROMPT");
  // SK1: DB-only skill filtered out → base prompt returned unchanged.
  expect(result).toBe("BASE PROMPT");
  expect(result).not.toContain("- magister-using-skills:");
});

test("appendAgentSkills lists other skills progressively when bootstrap is injected", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "magister-using-skills"), { recursive: true });
  await writeFile(
    join(poolDir, "magister-using-skills", "SKILL.md"),
    "---\nname: magister-using-skills\ndescription: bootstrap desc\n---\n\n# BOOTSTRAP BODY",
  );
  // SK1: also plant magister-planning in the pool so it passes the
  // loadable-skill filter. Without a pool file it would be filtered out.
  await mkdir(join(poolDir, "magister-planning"), { recursive: true });
  await writeFile(
    join(poolDir, "magister-planning", "SKILL.md"),
    "---\nname: magister-planning\ndescription: planning desc\n---\n\nplanning body",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_test_bootstrap4",
    name: "magister-using-skills",
    description: "bootstrap desc",
    content: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "leader",
    skillId: "skill_test_bootstrap4",
  });
  await db.insert(skills).values({
    id: "skill_test_planning",
    name: "magister-planning",
    description: "planning desc",
    content: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "leader",
    skillId: "skill_test_planning",
  });

  const result = await appendAgentSkills("leader", "BASE PROMPT");
  // Bootstrap body inline
  expect(result).toContain("BOOTSTRAP BODY");
  // magister-using-skills NOT in the list
  expect(result).not.toContain("- magister-using-skills:");
  // Other skill still listed progressively
  expect(result).toContain("- magister-planning:");
  expect(result).toContain("planning desc");
  // Protocol still present
  expect(result).toContain("# Available skills");
});

test("SK1: DB-attached skill with no pool entry is NOT advertised in appendAgentSkills", async () => {
  // A skill that exists in agent_skills + skills tables but has no
  // corresponding SKILL.md in the pool can't be loaded by load_skill.
  // Advertising it leads the model to call load_skill and get an error.
  // The fix: appendAgentSkills filters out DB-only entries.
  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  // Point at an empty pool — no SKILL.md files.
  const { join } = await import("node:path");
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "empty-pool");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_db_only_sk1",
    name: "db-only-unloadable",
    description: "This skill has no pool file",
    content: "body only in DB",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "custom_translator",
    skillId: "skill_db_only_sk1",
  });

  const result = await appendAgentSkills("custom_translator", "BASE PROMPT");
  // DB-only skill must NOT appear in the advertised list.
  expect(result).not.toContain("db-only-unloadable");
  // With no loadable skills, the base prompt is returned unchanged.
  expect(result).toBe("BASE PROMPT");
});

test("SK1: pool-backed DB-attached skill IS advertised (unchanged behavior)", async () => {
  // Confirm pool-backed skills still appear — the filter must only
  // remove pool-missing entries, not all DB-attached skills.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const poolDir = join(tempDir, "agents", "skills");
  await mkdir(join(poolDir, "pool-backed-skill"), { recursive: true });
  await writeFile(
    join(poolDir, "pool-backed-skill", "SKILL.md"),
    "---\nname: pool-backed-skill\ndescription: Has a real pool file\n---\n\nbody text",
  );
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");

  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const { createDb, agentSkills, skills } = await import("@magister/db");

  const db = createDb();
  await db.insert(skills).values({
    id: "skill_pool_backed_sk1",
    name: "pool-backed-skill",
    description: "Has a real pool file",
    content: "body text",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agentSkills).values({
    agentRole: "custom_translator",
    skillId: "skill_pool_backed_sk1",
  });

  const result = await appendAgentSkills("custom_translator", "BASE PROMPT");
  // Pool-backed skill must still be advertised.
  expect(result).toContain("- pool-backed-skill: Has a real pool file");
  expect(result).toContain("# Available skills");
});
