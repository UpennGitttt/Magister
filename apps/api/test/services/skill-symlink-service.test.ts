/**
 * Symlink-based attachment tests for the CLI agent skill flow.
 * The pool itself + each CLI's skill dir are isolated to a temp
 * directory hierarchy via env overrides so tests don't touch the
 * real `~/.agents/skills/` or `~/.codex/skills/`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "skill-symlink-test-"));
  prev = {
    MAGISTER_AGENTS_HOME: process.env.MAGISTER_AGENTS_HOME,
    MAGISTER_CODEX_HOME: process.env.MAGISTER_CODEX_HOME,
    MAGISTER_CLAUDE_HOME: process.env.MAGISTER_CLAUDE_HOME,
    MAGISTER_OPENCODE_HOME: process.env.MAGISTER_OPENCODE_HOME,
  };
  process.env.MAGISTER_AGENTS_HOME = join(tempDir, "agents");
  process.env.MAGISTER_CODEX_HOME = join(tempDir, "codex");
  process.env.MAGISTER_CLAUDE_HOME = join(tempDir, "claude");
  process.env.MAGISTER_OPENCODE_HOME = join(tempDir, "opencode");
  await mkdir(join(tempDir, "agents", "skills"), { recursive: true });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function plantSkill(name: string, frontmatterName = name): Promise<void> {
  const dir = join(tempDir, "agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: test\n---\n\nbody`,
  );
}

test("attach + detach roundtrip via dir name", async () => {
  await plantSkill("simple-skill");
  const { attachSkillToCli, detachSkillFromCli, isSkillAttachedToCli } = await import(
    "../../src/services/skill-symlink-service"
  );

  expect(await isSkillAttachedToCli("codex", "simple-skill")).toBe(false);
  await attachSkillToCli("codex", "simple-skill");
  expect(await isSkillAttachedToCli("codex", "simple-skill")).toBe(true);

  await detachSkillFromCli("codex", "simple-skill");
  expect(await isSkillAttachedToCli("codex", "simple-skill")).toBe(false);
});

test("attach uses dir name even when caller passes declared name (meta-pack case)", async () => {
  await plantSkill("ckm-banner", "ckm:banner");
  const { attachSkillToCli } = await import(
    "../../src/services/skill-symlink-service"
  );

  await attachSkillToCli("claude-code", "ckm:banner");
  // The symlink on disk should be named after the dir, not the
  // declared name — that mirrors what `npx skills` writes and is
  // what the consuming CLI tool expects to find.
  const linkPath = join(tempDir, "claude", "skills", "ckm-banner");
  const stat = await lstat(linkPath);
  expect(stat.isSymbolicLink()).toBe(true);
  // Symlink target is relative ../../agents/skills/ckm-banner.
  const target = await readlink(linkPath);
  expect(target).toContain("ckm-banner");
  expect(target).not.toContain("ckm:banner");
});

test("attach is idempotent — second attach is a no-op", async () => {
  await plantSkill("idempotent");
  const { attachSkillToCli, isSkillAttachedToCli } = await import(
    "../../src/services/skill-symlink-service"
  );
  await attachSkillToCli("codex", "idempotent");
  await attachSkillToCli("codex", "idempotent"); // second call must not throw
  expect(await isSkillAttachedToCli("codex", "idempotent")).toBe(true);
});

test("detach is idempotent — detaching a non-attached skill does not throw", async () => {
  await plantSkill("never-attached");
  const { detachSkillFromCli, isSkillAttachedToCli } = await import(
    "../../src/services/skill-symlink-service"
  );
  await detachSkillFromCli("codex", "never-attached");
  expect(await isSkillAttachedToCli("codex", "never-attached")).toBe(false);
});

test("attach refuses when target skill doesn't exist in the pool", async () => {
  const { attachSkillToCli } = await import(
    "../../src/services/skill-symlink-service"
  );
  await expect(attachSkillToCli("codex", "ghost-skill")).rejects.toThrow(/not found in pool/);
});

test("listAttachedCliSkills returns DECLARED names (not dir names) for meta-pack skills", async () => {
  await plantSkill("ckm-design", "ckm:design");
  await plantSkill("plain-skill", "plain-skill");
  const { attachSkillToCli, listAttachedCliSkills } = await import(
    "../../src/services/skill-symlink-service"
  );

  await attachSkillToCli("claude-code", "ckm:design");
  await attachSkillToCli("claude-code", "plain-skill");

  const attached = await listAttachedCliSkills("claude-code");
  // Sorted alphabetically: ckm:design before plain-skill.
  expect(attached).toEqual(["ckm:design", "plain-skill"]);
});

test("listAttachedCliSkills skips dotfiles and broken/foreign symlinks", async () => {
  await plantSkill("real-skill");
  const { attachSkillToCli, listAttachedCliSkills } = await import(
    "../../src/services/skill-symlink-service"
  );
  await attachSkillToCli("codex", "real-skill");

  // Plant a foreign symlink in the codex skills dir pointing at
  // an unrelated path. listAttachedCliSkills should skip it.
  await mkdir(join(tempDir, "outside"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(
    join(tempDir, "outside"),
    join(tempDir, "codex", "skills", "rogue-link"),
  );
  // Plant a dotfile too.
  await writeFile(join(tempDir, "codex", "skills", ".cache"), "x");

  const attached = await listAttachedCliSkills("codex");
  expect(attached).toEqual(["real-skill"]);
});

test("isSkillAttachedToCli returns false for symlink pointing outside the pool", async () => {
  await plantSkill("decoy");
  const { isSkillAttachedToCli } = await import(
    "../../src/services/skill-symlink-service"
  );
  // Manually plant a symlink pointing outside the pool.
  const codexSkillsDir = join(tempDir, "codex", "skills");
  await mkdir(codexSkillsDir, { recursive: true });
  await mkdir(join(tempDir, "outside"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(join(tempDir, "outside"), join(codexSkillsDir, "decoy"));

  expect(await isSkillAttachedToCli("codex", "decoy")).toBe(false);
});
