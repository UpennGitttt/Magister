import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevEnv: Record<string, string | undefined> = {};

const BUNDLED_NAMES = [
  "magister-using-skills",
  "magister-planning",
  "magister-delegating",
  "magister-cli-subagents",
  "magister-tdd-and-review",
  "magister-debugging",
  "magister-shipping",
] as const;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orch-skills-test-"));
  prevEnv = {
    MAGISTER_AGENTS_HOME: process.env.MAGISTER_AGENTS_HOME,
    MAGISTER_DB_PATH: process.env.MAGISTER_DB_PATH,
    MAGISTER_BUILTIN_SKILLS_DIR: process.env.MAGISTER_BUILTIN_SKILLS_DIR,
  };
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );

  // Plant the 7 orchestration skills in a temp BUNDLED dir rather
  // than the machine-wide pool. The new design (2026-05-12) keeps
  // bundled skills out of `~/.agents/skills/` entirely — they live
  // in `packages/builtin-skills/` (repo) and are leader-only.
  const builtinDir = join(tempDir, "bundled");
  await mkdir(builtinDir, { recursive: true });
  const skillBodies: Record<(typeof BUNDLED_NAMES)[number], string> = {
    "magister-using-skills": `---\nname: magister-using-skills\ndescription: Use this skill. This is the bootstrap for the Magister agent orchestration suite.\n---\n\n# BOOTSTRAP BODY\nRed flag: STOP.`,
    "magister-planning": `---\nname: magister-planning\ndescription: Use when planning a multi-step task.\n---\n\n# PLANNING BODY\nDesign Gate.`,
    "magister-delegating": `---\nname: magister-delegating\ndescription: Use when delegating to teammates.\n---\n\n# DELEGATING BODY\nRole matrix.`,
    "magister-cli-subagents": `---\nname: magister-cli-subagents\ndescription: Use when spawning CLI subagents.\n---\n\n# CLI BODY\nCLI constraints.`,
    "magister-tdd-and-review": `---\nname: magister-tdd-and-review\ndescription: Use for build and review phases.\n---\n\n# TDD BODY\nRed-green-refactor.`,
    "magister-debugging": `---\nname: magister-debugging\ndescription: Use when debugging.\n---\n\n# DEBUG BODY\n5 phases.`,
    "magister-shipping": `---\nname: magister-shipping\ndescription: Use when shipping completed work.\n---\n\n# SHIP BODY\n4-Option Gate.`,
  };
  for (const name of BUNDLED_NAMES) {
    const skillDir = join(builtinDir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skillBodies[name]);
  }
  process.env.MAGISTER_BUILTIN_SKILLS_DIR = builtinDir;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("bundled Magister skills do NOT appear in the machine-wide pool", async () => {
  // Codex CLI scans ~/.agents/skills/ directly. If bundled skills land
  // there, every codex spawn picks them up via its own loader — the
  // exact leak the new design closes. Verify the pool stays empty
  // even though bundled is fully populated.
  const { scanSkillPool } = await import(
    "../../src/services/skill-pool-service"
  );
  const pool = await scanSkillPool();
  expect(pool).toHaveLength(0);
});

test("listBundledSkills enumerates all 7 orchestration skills", async () => {
  const { listBundledSkills } = await import(
    "../../src/services/bundled-skills-source"
  );
  const items = await listBundledSkills();
  const names = items.map((s) => s.name).sort();
  expect(names).toEqual([...BUNDLED_NAMES].sort());
  for (const item of items) {
    expect(item.sourceKind).toBe("builtin");
  }
});

test("leader auto-attaches bundled skills without an explicit setAgentSkills call", async () => {
  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const attached = await listSkillsForAgent("leader");
  const names = attached.map((s) => s.name).sort();
  expect(names).toEqual([...BUNDLED_NAMES].sort());
});

test("leader appendAgentSkills injects bootstrap body and lists others progressively", async () => {
  // No setAgentSkills call needed — bundled skills are auto-attached
  // to leader by the bundled-source layer.
  const { appendAgentSkills } = await import(
    "../../src/services/manager-automation/teammate-system-prompts"
  );
  const result = await appendAgentSkills("leader", "BASE PROMPT");

  // Bootstrap body injected inline.
  expect(result).toContain("BOOTSTRAP BODY");
  expect(result).toContain("Red flag: STOP");

  // magister-using-skills NOT in the progressive-disclosure list.
  expect(result).not.toContain("- magister-using-skills:");

  // Other bundled skills listed progressively.
  expect(result).toContain("- magister-planning:");
  expect(result).toContain("- magister-delegating:");
  expect(result).toContain("Use when planning");
  expect(result).toContain("Use when delegating");

  // Skills protocol header present.
  expect(result).toContain("# Available skills");
});

test("load_skill returns full body for bundled skill", async () => {
  // Simulate what manager-tools-adapter does for load_skill.
  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const { readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );
  const attached = await listSkillsForAgent("leader");
  expect(attached.some((s) => s.name === "magister-planning")).toBe(true);

  const content = await readSkillContent("magister-planning");
  expect(content).toContain("PLANNING BODY");
  expect(content).toContain("Design Gate");
});

test("setAgentSkills refuses to attach bundled Magister skills to non-leader roles", async () => {
  const { setAgentSkills } = await import(
    "../../src/services/skill-management-service"
  );
  // reviewer is a builtin teammate role, custom_security is an
  // arbitrary custom role — both must be rejected for bundled names.
  for (const role of ["reviewer", "coder", "custom_security"]) {
    const result = await setAgentSkills(role, ["magister-debugging"]);
    expect(result.attached).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain("Magister-bundled");
  }
});

test("non-leader roles never see bundled Magister skills via listSkillsForAgent", async () => {
  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  // Even with no explicit attachment, reviewer / coder / custom roles
  // must NOT pick up bundled skills.
  for (const role of ["reviewer", "coder", "custom_security"]) {
    const attached = await listSkillsForAgent(role);
    const names = attached.map((s) => s.name);
    for (const bundled of BUNDLED_NAMES) {
      expect(names).not.toContain(bundled);
    }
  }
});

test("deleteSkill refuses to delete bundled Magister skills", async () => {
  const { deleteSkill } = await import(
    "../../src/services/skill-management-service"
  );
  await expect(deleteSkill("magister-planning")).rejects.toThrow("Magister-bundled");
});

test("editing a bundled skill writes a DB override, not the repo file", async () => {
  // The bundled file on disk should remain untouched; the override
  // table should carry the new description/body and the next read
  // through listSkillsForAgent must return the override.
  const { updateManualSkill, listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const { readBundledSkillContent } = await import(
    "../../src/services/bundled-skills-source"
  );

  await updateManualSkill("magister-planning", {
    description: "OVERRIDDEN description",
    content: "OVERRIDDEN body",
  });

  // Bundled file untouched (raw read, no roleId).
  const rawBundled = await readBundledSkillContent("magister-planning");
  expect(rawBundled).toContain("PLANNING BODY");
  expect(rawBundled).not.toContain("OVERRIDDEN");

  // Leader sees override.
  const leaderSkills = await listSkillsForAgent("leader");
  const planning = leaderSkills.find((s) => s.name === "magister-planning");
  expect(planning?.description).toBe("OVERRIDDEN description");

  // load_skill (readSkillContent with role) gets the override body too.
  const { readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );
  const leaderBody = await readSkillContent("magister-planning", "leader");
  expect(leaderBody).toContain("OVERRIDDEN body");
  expect(leaderBody).toContain("OVERRIDDEN description");
});

test("resetBundledSkillOverride restores the bundled default", async () => {
  const { updateManualSkill, resetBundledSkillOverride, listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );

  await updateManualSkill("magister-planning", {
    description: "TEMP override",
  });
  let leader = await listSkillsForAgent("leader");
  expect(leader.find((s) => s.name === "magister-planning")?.description).toBe("TEMP override");

  await resetBundledSkillOverride("leader", "magister-planning");
  leader = await listSkillsForAgent("leader");
  expect(leader.find((s) => s.name === "magister-planning")?.description).toContain("Use when planning");
});

test("description-only override doesn't shadow the bundled body", async () => {
  // Common case: user tweaks just the firing condition. The override
  // row should carry description=X, content=null — and a subsequent
  // body read still returns the bundled content (with the new
  // description in frontmatter).
  const { updateManualSkill } = await import(
    "../../src/services/skill-management-service"
  );
  const { readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );

  await updateManualSkill("magister-debugging", { description: "Only-desc override" });

  const body = await readSkillContent("magister-debugging", "leader");
  expect(body).toContain("Only-desc override"); // override in frontmatter
  expect(body).toContain("DEBUG BODY"); // bundled body preserved
});

test("partial PATCH preserves the other axis's existing override (codex review MUST-FIX #1)", async () => {
  // Regression: previously a description-only PATCH after both axes
  // were already overridden would silently null the content override.
  // Now an omitted patch field falls back to the existing override
  // (or the bundled default if there is none).
  const { updateManualSkill } = await import(
    "../../src/services/skill-management-service"
  );
  const { readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );

  // Seed both axes.
  await updateManualSkill("magister-shipping", {
    description: "OVERRIDE DESC",
    content: "OVERRIDE BODY",
  });

  // PATCH only the description.
  await updateManualSkill("magister-shipping", { description: "NEW DESC" });

  // Body override must survive.
  const body = await readSkillContent("magister-shipping", "leader");
  expect(body).toContain("OVERRIDE BODY");
  expect(body).toContain("NEW DESC");
  expect(body).not.toContain("SHIP BODY"); // bundled body should NOT have leaked back
});
