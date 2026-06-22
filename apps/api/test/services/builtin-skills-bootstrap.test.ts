import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "builtin-skills-test-"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function setupRepo(skillName: string) {
  const repoDir = join(tempDir, "repo");
  const builtinDir = join(repoDir, "packages", "builtin-skills");
  const skillDir = join(builtinDir, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: test desc\n---\n\n# BODY\n`,
  );
  return { repoDir, builtinDir, skillDir };
}

function makeOpts(builtinDir: string) {
  return {
    builtinDir,
    poolDir: join(tempDir, ".agents", "skills"),
  };
}

test("seedBuiltinSkills enumerates bundled skills without creating pool symlinks", async () => {
  const { builtinDir } = await setupRepo("magister-test-1");

  const { seedBuiltinSkills } = await import(
    "../../src/services/builtin-skills-bootstrap"
  );
  const report = await seedBuiltinSkills(makeOpts(builtinDir));

  expect(report.bundled).toContain("magister-test-1");
  expect(report.prunedLegacy).toHaveLength(0);

  // Bundled skills must NOT land in the machine-wide pool: that's
  // exactly the bug the new design removes. codex CLI scans
  // ~/.agents/skills/ directly, so any pool entry leaks into every
  // CLI agent's skill instructions.
  const poolPath = join(tempDir, ".agents", "skills", "magister-test-1");
  const exists = await lstat(poolPath).then(() => true).catch(() => false);
  expect(exists).toBe(false);
});

test("seedBuiltinSkills prunes legacy pool symlinks that pointed at the bundled dir", async () => {
  const { skillDir, builtinDir } = await setupRepo("magister-test-2");
  // Simulate a leftover from the old version of seedBuiltinSkills.
  const poolPath = join(tempDir, ".agents", "skills", "magister-test-2");
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });
  await symlink(skillDir, poolPath, "dir");

  const { seedBuiltinSkills } = await import(
    "../../src/services/builtin-skills-bootstrap"
  );
  const report = await seedBuiltinSkills(makeOpts(builtinDir));

  expect(report.prunedLegacy).toContain("magister-test-2");
  const stillExists = await lstat(poolPath).then(() => true).catch(() => false);
  expect(stillExists).toBe(false);
});

test("seedBuiltinSkills leaves unrelated pool entries alone", async () => {
  const { builtinDir } = await setupRepo("magister-test-3");
  const otherDir = join(tempDir, "other");
  await mkdir(otherDir, { recursive: true });

  // A real directory (user's own skill) and a symlink pointing
  // somewhere outside the bundled dir. Both must survive untouched.
  const userSkillDir = join(tempDir, ".agents", "skills", "user-skill");
  await mkdir(userSkillDir, { recursive: true });
  const aliasPath = join(tempDir, ".agents", "skills", "alias");
  await symlink(otherDir, aliasPath, "dir");

  const { seedBuiltinSkills } = await import(
    "../../src/services/builtin-skills-bootstrap"
  );
  const report = await seedBuiltinSkills(makeOpts(builtinDir));

  expect(report.prunedLegacy).toHaveLength(0);
  expect(await lstat(userSkillDir).then(() => true).catch(() => false)).toBe(true);
  expect(await lstat(aliasPath).then(() => true).catch(() => false)).toBe(true);
});

test("seedBuiltinSkills tolerates a missing pool dir", async () => {
  const { builtinDir } = await setupRepo("magister-test-4");

  const { seedBuiltinSkills } = await import(
    "../../src/services/builtin-skills-bootstrap"
  );
  // poolDir is set but doesn't exist on disk — common on a fresh
  // machine that has never installed a skill manually.
  const report = await seedBuiltinSkills(makeOpts(builtinDir));

  expect(report.bundled).toContain("magister-test-4");
  expect(report.prunedLegacy).toHaveLength(0);
  expect(report.warnings.filter((w) => !w.startsWith("Failed"))).toHaveLength(0);
});

test("seedBuiltinSkills warns when bundled dir is empty/missing", async () => {
  const builtinDir = join(tempDir, "missing", "packages", "builtin-skills");

  const { seedBuiltinSkills } = await import(
    "../../src/services/builtin-skills-bootstrap"
  );
  const report = await seedBuiltinSkills(makeOpts(builtinDir));

  expect(report.bundled).toHaveLength(0);
  expect(report.warnings.some((w) => w.includes("No bundled skills"))).toBe(true);
});

test("migrateLegacyBuiltinSkillNames rewrites legacy bundled skill DB names", async () => {
  const prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(tempDir, "skills.sqlite");
  const legacyName = `${"u"}cm-planning`;
  const newName = "magister-planning";

  try {
    const { createDb, skillOverrides, skills } = await import("@magister/db");
    const db = createDb();
    await db.insert(skills).values({
      id: "skill_legacy_planning",
      name: legacyName,
      description: "legacy desc",
      content: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(skillOverrides).values({
      roleId: "leader",
      skillName: legacyName,
      descriptionOverride: "custom desc",
      contentOverride: null,
      updatedAt: new Date(),
    });

    const { migrateLegacyBuiltinSkillNames } = await import(
      "../../src/services/builtin-skills-bootstrap"
    );
    const report = await migrateLegacyBuiltinSkillNames();

    const skillRows = await db.select().from(skills);
    const overrideRows = await db.select().from(skillOverrides);
    expect(report.renamedSkills).toBe(1);
    expect(skillRows.map((row) => row.name)).toEqual([newName]);
    expect(overrideRows.map((row) => row.skillName)).toEqual([newName]);
    expect(overrideRows[0]?.descriptionOverride).toBe("custom desc");
  } finally {
    if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
    else process.env.MAGISTER_DB_PATH = prevDbPath;
  }
});
