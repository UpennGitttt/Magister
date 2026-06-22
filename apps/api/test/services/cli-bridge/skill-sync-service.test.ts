import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome = "";

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "skill-sync-"));
});

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
});

async function createCliPrivateSkill(home: string, cli: "codex" | "claude-code" | "opencode", name: string) {
  const cliDir = cli === "claude-code" ? join(home, ".claude", "skills")
    : cli === "opencode" ? join(home, ".config", "opencode", "skills")
    : join(home, ".codex", "skills");
  const skillDir = join(cliDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return skillDir;
}

async function createPoolSkill(home: string, name: string) {
  const dir = join(home, ".agents", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return dir;
}

test("promoteSkill: rejects invalid skill name (path traversal guard)", async () => {
  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  await expect(promoteSkill({ name: "../etc/passwd", sourceCli: "codex", homeDir: tempHome })).rejects.toThrow(/Invalid skill name/);
  await expect(promoteSkill({ name: "skill/with/slash", sourceCli: "codex", homeDir: tempHome })).rejects.toThrow(/Invalid skill name/);
});

test("promoteSkill: moves CLI-private dir into pool, symlinks back to source CLI + other participants", async () => {
  await createCliPrivateSkill(tempHome, "claude-code", "my-skill");

  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  const result = await promoteSkill({ name: "my-skill", sourceCli: "claude-code", homeDir: tempHome });
  expect(result.ok).toBe(true);

  // Pool now has the real dir.
  const poolPath = join(tempHome, ".agents", "skills", "my-skill");
  const poolStat = await lstat(poolPath);
  expect(poolStat.isDirectory()).toBe(true);

  // Original CLI location is now a symlink to pool.
  const claudePath = join(tempHome, ".claude", "skills", "my-skill");
  const claudeStat = await lstat(claudePath);
  expect(claudeStat.isSymbolicLink()).toBe(true);
  expect(await readlink(claudePath)).toBe(poolPath);

  // OpenCode also got a symlink.
  const opencodePath = join(tempHome, ".config", "opencode", "skills", "my-skill");
  expect((await lstat(opencodePath)).isSymbolicLink()).toBe(true);

  // Codex did NOT get a symlink (skipped per locked decision).
  let codexExists = true;
  try { await lstat(join(tempHome, ".codex", "skills", "my-skill")); } catch { codexExists = false; }
  expect(codexExists).toBe(false);

  expect(result.symlinkedCli.sort()).toEqual(["claude-code", "opencode"]);
});

test("promoteSkill: refuses when pool entry already exists", async () => {
  await createCliPrivateSkill(tempHome, "claude-code", "dup");
  await createPoolSkill(tempHome, "dup");

  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  await expect(promoteSkill({ name: "dup", sourceCli: "claude-code", homeDir: tempHome }))
    .rejects.toThrow(/already exists/);
});

test("promoteSkill: detects already-promoted via symlink, returns no-op", async () => {
  // Pool has the real dir; CLI has a symlink already.
  await createPoolSkill(tempHome, "already");
  const cliPath = join(tempHome, ".claude", "skills", "already");
  await mkdir(join(tempHome, ".claude", "skills"), { recursive: true });
  await symlink(join(tempHome, ".agents", "skills", "already"), cliPath);

  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  // Source path is the symlink, NOT a real dir. Function should detect and no-op.
  const result = await promoteSkill({ name: "already", sourceCli: "claude-code", homeDir: tempHome });
  expect(result.ok).toBe(true);
  expect(result.message).toBe("already in pool");
});

test("syncSkillToCli: creates missing symlinks in claude-code + opencode", async () => {
  await createPoolSkill(tempHome, "needs-sync");

  const { syncSkillToCli } = await import("../../../src/services/cli-bridge/skill-sync-service");
  const result = await syncSkillToCli({ name: "needs-sync", homeDir: tempHome });
  expect(result.ok).toBe(true);
  expect(result.symlinksCreated.sort()).toEqual(["claude-code", "opencode"]);

  expect((await lstat(join(tempHome, ".claude", "skills", "needs-sync"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(tempHome, ".config", "opencode", "skills", "needs-sync"))).isSymbolicLink()).toBe(true);

  // Codex never linked.
  let codex = true;
  try { await lstat(join(tempHome, ".codex", "skills", "needs-sync")); } catch { codex = false; }
  expect(codex).toBe(false);
});

test("syncSkillToCli: idempotent — running twice doesn't error", async () => {
  await createPoolSkill(tempHome, "idem");
  const { syncSkillToCli } = await import("../../../src/services/cli-bridge/skill-sync-service");
  const r1 = await syncSkillToCli({ name: "idem", homeDir: tempHome });
  const r2 = await syncSkillToCli({ name: "idem", homeDir: tempHome });
  expect(r1.symlinksCreated).toHaveLength(2);
  expect(r2.symlinksCreated).toHaveLength(0); // already correct, no-op
});

test("syncSkillToCli: replaces stale symlink that points elsewhere", async () => {
  await createPoolSkill(tempHome, "stale");
  // Manually create a stale symlink in claude-code → wrong target
  const claudeDir = join(tempHome, ".claude", "skills");
  await mkdir(claudeDir, { recursive: true });
  await symlink("/nonexistent/wrong/target", join(claudeDir, "stale"));

  const { syncSkillToCli } = await import("../../../src/services/cli-bridge/skill-sync-service");
  const result = await syncSkillToCli({ name: "stale", homeDir: tempHome });
  expect(result.symlinksRemovedStale).toContain("claude-code");

  const tgt = await readlink(join(claudeDir, "stale"));
  expect(tgt).toBe(join(tempHome, ".agents", "skills", "stale"));
});

test("syncSkillToCli: warns when pool entry is reverse-symlink (skips sync)", async () => {
  // Reverse-symlink case: pool entry is a symlink to outside the pool.
  const codexDir = join(tempHome, ".codex", "superpowers", "skills");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "SKILL.md"), "---\nname: superpowers\n---\n");
  const poolDirPath = join(tempHome, ".agents", "skills");
  await mkdir(poolDirPath, { recursive: true });
  await symlink(codexDir, join(poolDirPath, "superpowers"));

  const { syncSkillToCli } = await import("../../../src/services/cli-bridge/skill-sync-service");
  const result = await syncSkillToCli({ name: "superpowers", homeDir: tempHome });
  expect(result.ok).toBe(true);
  expect(result.warnings.some((w) => /reverse-symlink/.test(w))).toBe(true);
  expect(result.symlinksCreated).toHaveLength(0);
});

test("promoteSkill: rejects when source missing", async () => {
  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  await expect(promoteSkill({ name: "missing", sourceCli: "claude-code", homeDir: tempHome }))
    .rejects.toThrow(/does not exist/);
});

test("promoteSkill: rejects sourceCli=codex (kimi defense-in-depth)", async () => {
  const { promoteSkill } = await import("../../../src/services/cli-bridge/skill-sync-service");
  await expect(
    promoteSkill({ name: "anything", sourceCli: "codex", homeDir: tempHome }),
  ).rejects.toThrow(/not a pool participant/);
});
