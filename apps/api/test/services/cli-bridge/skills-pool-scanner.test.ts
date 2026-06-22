import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome = "";

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "skills-scan-"));
});

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
});

async function setupSkillDir(home: string, cli: string, name: string) {
  const dir = cli === "config/opencode"
    ? join(home, ".config", "opencode", "skills", name)
    : join(home, `.${cli}`, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

async function setupPoolSkill(home: string, name: string) {
  const dir = join(home, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

async function setupCliSymlinkToPool(home: string, cli: string, name: string) {
  const cliDir = cli === "config/opencode"
    ? join(home, ".config", "opencode", "skills")
    : join(home, `.${cli}`, "skills");
  await mkdir(cliDir, { recursive: true });
  const target = join(home, ".agents", "skills", name);
  await symlink(target, join(cliDir, name));
}

test("scanSkills: empty home → empty result", async () => {
  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const result = await scanSkills(tempHome);
  expect(result.inPool).toEqual([]);
  expect(result.cliPrivate).toEqual([]);
});

test("scanSkills: pool skill with symlinks in claude-code + opencode → magister-symlinked", async () => {
  await setupPoolSkill(tempHome, "find-skills");
  await setupCliSymlinkToPool(tempHome, "claude", "find-skills");
  await setupCliSymlinkToPool(tempHome, "config/opencode", "find-skills");

  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const { inPool, cliPrivate } = await scanSkills(tempHome);
  expect(inPool).toHaveLength(1);
  expect(inPool[0]!.name).toBe("find-skills");
  expect(inPool[0]!.perCli["claude-code"]?.kind).toBe("magister-symlinked");
  expect(inPool[0]!.perCli["opencode"]?.kind).toBe("magister-symlinked");
  expect(inPool[0]!.perCli["codex"]?.kind).toBe("missing");
  expect(cliPrivate).toHaveLength(0);
});

test("scanSkills: cli-private skill (real dir, not symlink) → cli-private", async () => {
  await setupSkillDir(tempHome, "codex", "imagegen");
  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const { inPool, cliPrivate } = await scanSkills(tempHome);
  expect(inPool).toHaveLength(0);
  expect(cliPrivate).toHaveLength(1);
  expect(cliPrivate[0]!.name).toBe("imagegen");
  expect(cliPrivate[0]!.perCli["codex"]?.kind).toBe("cli-private");
});

test("scanSkills: pool skill missing in opencode → missing in that CLI only", async () => {
  await setupPoolSkill(tempHome, "frontend-design");
  await setupCliSymlinkToPool(tempHome, "claude", "frontend-design");
  // No opencode symlink.

  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const { inPool } = await scanSkills(tempHome);
  expect(inPool[0]!.perCli["claude-code"]?.kind).toBe("magister-symlinked");
  expect(inPool[0]!.perCli["opencode"]?.kind).toBe("missing");
});

test("scanSkills: reverse-symlink (pool entry → CLI dir) → cli-private under source CLI (kimi C1)", async () => {
  // Set up: ~/.codex/superpowers/skills exists as a real dir,
  // and ~/.agents/skills/superpowers symlinks to it.
  const codexSuperpowers = join(tempHome, ".codex", "superpowers", "skills");
  await mkdir(codexSuperpowers, { recursive: true });
  await writeFile(join(codexSuperpowers, "SKILL.md"), `---\nname: superpowers\n---\n`);
  const poolDir = join(tempHome, ".agents", "skills");
  await mkdir(poolDir, { recursive: true });
  await symlink(codexSuperpowers, join(poolDir, "superpowers"));

  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const { inPool, cliPrivate } = await scanSkills(tempHome);
  expect(inPool).toHaveLength(0);
  expect(cliPrivate).toHaveLength(1);
  expect(cliPrivate[0]!.name).toBe("superpowers");
  expect(cliPrivate[0]!.perCli["codex"]?.kind).toBe("cli-private");
});

test("scanSkills: codex never gets magister-symlinked status (uses own skill system)", async () => {
  await setupPoolSkill(tempHome, "find-skills");
  // Even if codex has a symlink (which it shouldn't normally), or no symlink,
  // codex should be reported as `missing` (not `magister-symlinked`).
  // Here we leave codex with no symlink — should be missing, not crash.

  const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
  const { inPool } = await scanSkills(tempHome);
  expect(inPool[0]!.perCli["codex"]?.kind).toBe("missing");
});

test("scanSkills: bundled skill symlink (pool → repo packages/builtin-skills/) → inPool, not cliPrivate", async () => {
  // Set up: repo has packages/builtin-skills/my-bundle/SKILL.md
  const repoDir = join(tempHome, "repo");
  const builtinDir = join(repoDir, "packages", "builtin-skills");
  const skillDir = join(builtinDir, "my-bundle");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: my-bundle\n---\n`);

  // Pool entry symlinks to repo bundle
  const poolDir = join(tempHome, ".agents", "skills");
  await mkdir(poolDir, { recursive: true });
  await symlink(skillDir, join(poolDir, "my-bundle"));

  const origCwd = process.cwd;
  process.cwd = () => repoDir;
  try {
    const { scanSkills } = await import("../../../src/services/cli-bridge/skills-pool-scanner");
    const { inPool, cliPrivate } = await scanSkills(tempHome);
    expect(inPool).toHaveLength(1);
    expect(inPool[0]!.name).toBe("my-bundle");
    // All CLIs show missing because no CLI symlinks are set up
    expect(inPool[0]!.perCli["claude-code"]?.kind).toBe("missing");
    expect(inPool[0]!.perCli["opencode"]?.kind).toBe("missing");
    expect(inPool[0]!.perCli["codex"]?.kind).toBe("missing");
    expect(cliPrivate).toHaveLength(0);
  } finally {
    process.cwd = origCwd;
  }
});
