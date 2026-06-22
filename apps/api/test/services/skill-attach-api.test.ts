import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-attach-api-test-"));
  prev = {
    MAGISTER_AGENTS_HOME: process.env.MAGISTER_AGENTS_HOME,
    MAGISTER_DB_PATH: process.env.MAGISTER_DB_PATH,
    MAGISTER_BUILTIN_SKILLS_DIR: process.env.MAGISTER_BUILTIN_SKILLS_DIR,
  };
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  // Point bundled-skills source at an empty path so tests assert
  // clean pool state without the repo's actual magister-* leaking in.
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

async function plantSkill(name: string): Promise<void> {
  const dir = join(tempDir, "agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n\nbody`,
  );
}

test("setAgentSkills accepts custom role (not just leader/codex/claude-code/opencode)", async () => {
  await plantSkill("test-skill");

  const { setAgentSkills, listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );

  const result = await setAgentSkills("custom_reviewer", ["test-skill"]);
  expect(result.attached).toEqual(["test-skill"]);
  expect(result.failed).toEqual([]);

  const skills = await listSkillsForAgent("custom_reviewer");
  expect(skills.map((s) => s.name)).toEqual(["test-skill"]);
});

test("listSkillsForAgent returns empty array for role with no skills", async () => {
  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );

  const skills = await listSkillsForAgent("no_skills_role");
  expect(skills).toEqual([]);
});

test("load_skill works for builtin teammate roles (reviewer, architect, etc.)", async () => {
  await plantSkill("review-checklist");

  const { setAgentSkills } = await import(
    "../../src/services/skill-management-service"
  );
  await setAgentSkills("reviewer", ["review-checklist"]);

  // Simulate what manager-tools-adapter does for load_skill
  const { listSkillsForAgent } = await import(
    "../../src/services/skill-management-service"
  );
  const attached = await listSkillsForAgent("reviewer");
  expect(attached.some((s) => s.name === "review-checklist")).toBe(true);
});
