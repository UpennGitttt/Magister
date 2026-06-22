/**
 * Skill pool service tests. Each test isolates the pool to a
 * temp directory via `MAGISTER_AGENTS_HOME` so they can run in
 * parallel without stepping on each other or the real
 * `~/.agents/skills/` on the developer machine.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevAgentsHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-pool-test-"));
  prevAgentsHome = process.env.MAGISTER_AGENTS_HOME;
  process.env.MAGISTER_AGENTS_HOME = tempDir;
  await mkdir(join(tempDir, "skills"), { recursive: true });
});

afterEach(async () => {
  if (prevAgentsHome === undefined) delete process.env.MAGISTER_AGENTS_HOME;
  else process.env.MAGISTER_AGENTS_HOME = prevAgentsHome;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function plantSkill(
  name: string,
  opts: { frontmatterName?: string; description?: string; body?: string } = {},
): Promise<void> {
  const dir = join(tempDir, "skills", name);
  await mkdir(dir, { recursive: true });
  const declared = opts.frontmatterName ?? name;
  const desc = opts.description ?? "test skill description";
  const body = opts.body ?? "# Body\n\nbody text";
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${declared}\ndescription: ${desc}\n---\n\n${body}`,
  );
}

async function plantLockEntry(skillsByName: Record<string, { sourceUrl: string; commit?: string }>): Promise<void> {
  const lock = {
    version: 3,
    skills: Object.fromEntries(
      Object.entries(skillsByName).map(([name, info]) => [
        name,
        {
          source: "test/repo",
          sourceType: "github",
          sourceUrl: info.sourceUrl,
          ...(info.commit ? { skillFolderHash: info.commit } : {}),
          installedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
    ),
  };
  await writeFile(join(tempDir, ".skill-lock.json"), JSON.stringify(lock));
}

test("scanSkillPool returns sorted pool entries with frontmatter parsed", async () => {
  await plantSkill("zeta-skill", { description: "z desc" });
  await plantSkill("alpha-skill", { description: "a desc" });
  const { scanSkillPool } = await import("../../src/services/skill-pool-service");

  const pool = await scanSkillPool();
  expect(pool.map((p) => p.name)).toEqual(["alpha-skill", "zeta-skill"]);
  expect(pool[0]?.description).toBe("a desc");
  expect(pool[0]?.dirName).toBe("alpha-skill");
});

test("scanSkillPool tags lock-tracked entries as github and surfaces source metadata", async () => {
  await plantSkill("tracked", { description: "tracked skill" });
  await plantSkill("untracked", { description: "untracked skill" });
  await plantLockEntry({
    tracked: { sourceUrl: "https://github.com/owner/repo.git", commit: "abc1234" },
  });
  const { scanSkillPool } = await import("../../src/services/skill-pool-service");

  const pool = await scanSkillPool();
  const tracked = pool.find((p) => p.name === "tracked");
  const untracked = pool.find((p) => p.name === "untracked");
  expect(tracked?.sourceKind).toBe("github");
  expect(tracked?.sourceUrl).toBe("https://github.com/owner/repo.git");
  expect(tracked?.sourceCommit).toBe("abc1234");
  expect(untracked?.sourceKind).toBe("manual");
  expect(untracked?.sourceUrl).toBeUndefined();
});

test("scanSkillPool reconciles meta-pack skills where dir name and declared name differ", async () => {
  // Reproduces the ckm:* family pattern: dir on disk is
  // `ckm-banner-design`, but SKILL.md frontmatter declares
  // `name: ckm:banner-design` (with colon), and the lock keys by
  // the declared (colon) name.
  await plantSkill("ckm-banner-design", {
    frontmatterName: "ckm:banner-design",
    description: "banner skill",
  });
  await plantLockEntry({
    "ckm:banner-design": { sourceUrl: "https://github.com/x/y.git" },
  });
  const { scanSkillPool } = await import("../../src/services/skill-pool-service");

  const pool = await scanSkillPool();
  expect(pool).toHaveLength(1);
  expect(pool[0]?.name).toBe("ckm:banner-design");
  expect(pool[0]?.dirName).toBe("ckm-banner-design");
  expect(pool[0]?.sourceKind).toBe("github");
});

test("scanSkillPool ignores subdirs without SKILL.md and dotfiles", async () => {
  await plantSkill("real", {});
  await mkdir(join(tempDir, "skills", "incomplete"), { recursive: true });
  await mkdir(join(tempDir, "skills", ".system"), { recursive: true });
  // dotfile that's not a dir
  await writeFile(join(tempDir, "skills", ".tmpfile"), "junk");

  const { scanSkillPool } = await import("../../src/services/skill-pool-service");
  const pool = await scanSkillPool();
  expect(pool.map((p) => p.name)).toEqual(["real"]);
});

test("readSkillContent returns body via either declared name or dir name", async () => {
  await plantSkill("ckm-design", {
    frontmatterName: "ckm:design",
    body: "# Design\n\nDesign body",
  });

  const { readSkillContent } = await import("../../src/services/skill-pool-service");
  const byDir = await readSkillContent("ckm-design");
  const byDeclared = await readSkillContent("ckm:design");
  expect(byDir).toContain("Design body");
  expect(byDeclared).toContain("Design body");
});

test("writeManualSkill creates SKILL.md with frontmatter and refuses to overwrite", async () => {
  const { writeManualSkill, scanSkillPool, readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );

  await writeManualSkill("custom-one", "Test desc", "# Body", "create");
  const pool = await scanSkillPool();
  expect(pool[0]?.name).toBe("custom-one");
  expect(pool[0]?.description).toBe("Test desc");
  const content = await readSkillContent("custom-one");
  expect(content).toContain("name: custom-one");
  expect(content).toContain("description: Test desc");
  expect(content).toContain("# Body");

  await expect(
    writeManualSkill("custom-one", "Different", "different body", "create"),
  ).rejects.toThrow(/already exists/);
});

test("writeManualSkill update mode rewrites in place", async () => {
  const { writeManualSkill, readSkillContent } = await import(
    "../../src/services/skill-pool-service"
  );
  await writeManualSkill("foo", "v1", "first body", "create");
  await writeManualSkill("foo", "v2", "second body", "update");

  const content = await readSkillContent("foo");
  expect(content).toContain("description: v2");
  expect(content).toContain("second body");
  expect(content).not.toContain("first body");
});

test("removeFromPool deletes the dir and removes the lock entry", async () => {
  await plantSkill("rmtest", {});
  await plantLockEntry({ rmtest: { sourceUrl: "x" } });
  const { removeFromPool, scanSkillPool } = await import(
    "../../src/services/skill-pool-service"
  );

  await removeFromPool("rmtest");
  const pool = await scanSkillPool();
  expect(pool).toHaveLength(0);

  const lockRaw = await Bun.file(join(tempDir, ".skill-lock.json")).text();
  const lock = JSON.parse(lockRaw);
  expect(lock.skills?.rmtest).toBeUndefined();
});

test("removeFromPool tolerates missing dir and missing lock entry (idempotent)", async () => {
  const { removeFromPool } = await import("../../src/services/skill-pool-service");
  // Neither file nor lock entry exists — should not throw.
  await removeFromPool("nonexistent");
});

test("removeFromPool handles meta-pack name keyed by declared name in lock", async () => {
  await plantSkill("ckm-slides", { frontmatterName: "ckm:slides" });
  await plantLockEntry({ "ckm:slides": { sourceUrl: "x" } });
  const { removeFromPool, scanSkillPool } = await import(
    "../../src/services/skill-pool-service"
  );

  await removeFromPool("ckm:slides");
  const pool = await scanSkillPool();
  expect(pool).toHaveLength(0);

  const lockRaw = await Bun.file(join(tempDir, ".skill-lock.json")).text();
  const lock = JSON.parse(lockRaw);
  expect(lock.skills?.["ckm:slides"]).toBeUndefined();
});

test("scanSkillPool tags bundled symlink skills as builtin", async () => {
  // Create a fake repo bundle
  const repoDir = join(tempDir, "repo");
  const builtinDir = join(repoDir, "packages", "builtin-skills");
  const skillDir = join(builtinDir, "magister-test-builtin");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: magister-test-builtin\ndescription: bundled desc\n---\n\n# Body\n`,
  );

  // Pool entry is a symlink pointing into the repo bundle
  const poolSkillsDir = join(tempDir, "skills");
  await symlink(skillDir, join(poolSkillsDir, "magister-test-builtin"));

  // Also plant a manual skill (real dir) for contrast
  await plantSkill("manual-skill", { description: "manual desc" });

  const origCwd = process.cwd;
  process.cwd = () => repoDir;
  try {
    const { scanSkillPool } = await import("../../src/services/skill-pool-service");
    const pool = await scanSkillPool();

    const bundled = pool.find((p) => p.name === "magister-test-builtin");
    const manual = pool.find((p) => p.name === "manual-skill");

    expect(bundled?.sourceKind).toBe("builtin");
    expect(bundled?.sourceUrl).toBeUndefined();
    expect(manual?.sourceKind).toBe("manual");
  } finally {
    process.cwd = origCwd;
  }
});
