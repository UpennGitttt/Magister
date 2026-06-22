import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-agent-profile-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `agent-profile-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("upsert agent with runtimeType=codex stores commandPath", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "custom_codex",
    label: "Custom Codex",
    runtimeType: "codex",
    commandPath: "/usr/bin/codex",
    modelOverride: "gpt-5.4",
  });

  const profile = await getAgentProfile("custom_codex");
  expect(profile).not.toBeNull();
  expect(profile?.runtimeType).toBe("codex");
  expect(profile?.commandPath).toBe("/usr/bin/codex");
});

test("upsert agent with runtimeType=ucm stores provider", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "custom_magister",
    label: "Custom Magister",
    runtimeType: "ucm",
    provider: "volcengine-ark",
    modelOverride: "kimi-k2.6-ark",
  });

  const profile = await getAgentProfile("custom_magister");
  expect(profile).not.toBeNull();
  expect(profile?.runtimeType).toBe("ucm");
  expect(profile?.provider).toBe("volcengine-ark");
});

test("leader profile runtimeType is coerced to ucm", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "leader",
    label: "Leader",
    runtimeType: "codex",
    commandPath: "/usr/bin/codex",
    modelOverride: "gpt-5.4",
  });

  const profile = await getAgentProfile("leader");
  expect(profile).not.toBeNull();
  expect(profile?.runtimeType).toBe("ucm");
});

test("get agent with runtimeType=codex returns full config", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "custom_codex_full",
    label: "Custom Codex Full",
    runtimeType: "codex",
    commandPath: "/opt/bin/codex",
    modelOverride: "gpt-5.4",
    customEnv: '{"FOO":"BAR"}',
    customArgs: '["--approval-mode","full-auto"]',
  });

  const profile = await getAgentProfile("custom_codex_full");
  expect(profile).not.toBeNull();
  expect(profile?.runtimeType).toBe("codex");
  expect(profile?.commandPath).toBe("/opt/bin/codex");
  expect(profile?.customEnv).toBe('{"FOO":"BAR"}');
  expect(profile?.customArgs).toBe('["--approval-mode","full-auto"]');
});

test("builtin agents default to runtimeType=ucm", async () => {
  const { listAgentProfiles } = await import("../../src/services/agent-profile-service");

  const profiles = await listAgentProfiles();
  const builtinRoleIds = new Set(["coder", "reviewer", "architect", "lander"]);
  const builtinProfiles = profiles.filter((profile) => builtinRoleIds.has(profile.roleId));

  expect(builtinProfiles.length).toBe(4);
  for (const profile of builtinProfiles) {
    expect(profile.runtimeType).toBe("ucm");
  }
});

test("memory-extractor builtin is seeded with classifier defaults and NO hardcoded model", async () => {
  const { listAgentProfiles } = await import("../../src/services/agent-profile-service");
  const profiles = await listAgentProfiles();
  const me = profiles.find((p) => p.roleId === "memory-extractor");
  expect(me).toBeDefined();
  expect(me?.runtimeType).toBe("ucm");
  // No hardcoded model/provider: it inherits the leader's default binding at
  // resolution time (resolveAgentConfig), so a fresh install works on
  // whatever provider the operator configured.
  expect(me?.modelName ?? null).toBeNull();
  expect(me?.providerId ?? null).toBeNull();
  expect(me?.fallbackModelName ?? null).toBeNull();
  expect(me?.fallbackProviderId ?? null).toBeNull();
  expect(me?.omitSkills).toBe(true);
  expect(me?.maxTurns).toBe(1);
  expect(me?.toolProfile).toBe("minimal");
  // System prompt must be the M5 Phase 3 extractor instructions.
  expect(me?.systemPromptOverride).toContain("MEMORY-EXTRACTOR");
  expect(me?.systemPromptOverride).toContain('"operations"');
});

test("leader builtin profile uses leader-facing label and backfills the legacy task manager label", async () => {
  const { createDb, agentProfiles } = await import("@magister/db");
  const { getAgentProfile } = await import("../../src/services/agent-profile-service");

  const db = createDb();
  const now = new Date();
  await db.insert(agentProfiles).values({
    roleId: "leader",
    label: "Task Manager",
    displayName: "Task Manager",
    runtimeType: "ucm",
    systemPromptOverride: "customized leader prompt",
    isBuiltin: 1,
    createdAt: now,
    updatedAt: now,
  });

  const profile = await getAgentProfile("leader");

  expect(profile).toMatchObject({
    roleId: "leader",
    label: "Leader",
    displayName: "Leader",
  });
});

test("upsert agent with allowedTools and disallowedTools round-trips parsed lists", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "tool_limited",
    label: "Tool Limited",
    allowedTools: ["bash", "read_file"],
    disallowedTools: ["web_search"],
  });

  const profile = await getAgentProfile("tool_limited");
  expect(profile?.allowedTools).toEqual(["bash", "read_file"]);
  expect(profile?.disallowedTools).toEqual(["web_search"]);
});

test("upsert agent normalizes empty tool restriction arrays to null", async () => {
  const { upsertAgentProfile, getAgentProfile } = await import("../../src/services/agent-profile-service");

  await upsertAgentProfile({
    roleId: "empty_tools",
    label: "Empty Tools",
    allowedTools: [],
    disallowedTools: [],
  });

  const profile = await getAgentProfile("empty_tools");
  expect(profile?.allowedTools).toBeNull();
  expect(profile?.disallowedTools).toBeNull();
});

test("upsert agent rejects overlapping allowed and disallowed tools", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");

  await expect(upsertAgentProfile({
    roleId: "overlapping_tools",
    label: "Overlapping Tools",
    allowedTools: ["bash", "read_file"],
    disallowedTools: ["bash"],
  })).rejects.toThrow("cannot appear in both allowedTools and disallowedTools: bash");
});

test("upsert agent rejects unknown tool names", async () => {
  const { upsertAgentProfile } = await import("../../src/services/agent-profile-service");

  await expect(upsertAgentProfile({
    roleId: "unknown_tools",
    label: "Unknown Tools",
    allowedTools: ["bash", "not_a_tool"],
  })).rejects.toThrow("Unknown tool name in allowedTools: not_a_tool");
});
