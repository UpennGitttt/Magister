import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-profile-readonly-test-"));
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `profile-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  delete process.env.MAGISTER_DB_PATH;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("reviewer profile has disallowedTools for write/edit/git tools", async () => {
  const { getAgentProfile } = await import(
    "../../src/services/agent-profile-service"
  );

  const profile = await getAgentProfile("reviewer");
  expect(profile).not.toBeNull();
  expect(profile?.disallowedTools).toContain("write_file");
  expect(profile?.disallowedTools).toContain("edit_file");
  expect(profile?.disallowedTools).toContain("git_commit");
  expect(profile?.disallowedTools).toContain("git_create_branch");
});

test("evaluator profile has disallowedTools for write/edit/git tools", async () => {
  const { getAgentProfile } = await import(
    "../../src/services/agent-profile-service"
  );

  const profile = await getAgentProfile("evaluator");
  expect(profile).not.toBeNull();
  expect(profile?.disallowedTools).toContain("write_file");
  expect(profile?.disallowedTools).toContain("edit_file");
  expect(profile?.disallowedTools).toContain("git_commit");
  expect(profile?.disallowedTools).toContain("git_create_branch");
});

test("coder profile does NOT have disallowedTools", async () => {
  const { getAgentProfile } = await import(
    "../../src/services/agent-profile-service"
  );

  const profile = await getAgentProfile("coder");
  expect(profile).not.toBeNull();
  expect(profile?.disallowedTools).toBeNull();
});

test("disallowedTools backfill works for existing profiles", async () => {
  const { createDb, agentProfiles, eq } = await import("@magister/db");
  const db = createDb();

  // Pre-create a reviewer profile WITHOUT disallowedTools
  const now = new Date();
  await db.insert(agentProfiles).values({
    roleId: "reviewer",
    label: "Reviewer",
    displayName: "Reviewer",
    runtimeType: "ucm",
    systemPromptOverride: "You are a reviewer.",
    disallowedTools: null,
    isBuiltin: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  const { getAgentProfile } = await import(
    "../../src/services/agent-profile-service"
  );

  const profile = await getAgentProfile("reviewer");
  expect(profile?.disallowedTools).toContain("write_file");
  expect(profile?.disallowedTools).toContain("edit_file");
});
