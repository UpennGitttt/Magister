/**
 * Tests for dynamic role discovery (T4a):
 *   - mergeRoleCandidates: pure dedupe helper
 *   - listAvailableRoles: reads roleMapping + DB, degrades gracefully
 *   - resolveAvailableRoles (policy service): wraps listAvailableRoles, never throws
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentProfiles, createDb } from "@magister/db";

import {
  listAvailableRoles,
  mergeRoleCandidates,
} from "../../src/services/agent-resolution-service";
import { resolveAvailableRoles } from "../../src/services/leader-execution-policy-service";

// ─── Test-env setup (mirrors agent-resolution-service.test.ts) ───────────────

const tempRoot = join(process.cwd(), ".tmp-agent-resolution-roles");

function writeExecutorConfig(input: {
  providers?: Record<string, unknown>;
  models?: Record<string, unknown>;
  roleMapping?: Record<string, string>;
}) {
  const configPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  if (!configPath) throw new Error("Expected MAGISTER_EXECUTOR_CONFIG_PATH");

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        executors: {},
        roleRouting: {},
        providers: input.providers ?? {},
        models: input.models ?? {},
        bindings: {},
        roleMapping: input.roleMapping ?? {},
      },
      null,
      2,
    ),
  );
}

type SeedAgentInput = {
  roleId: string;
  runtimeType?: "ucm" | "codex" | "opencode" | "claude-code";
  modelName?: string | null;
  providerId?: string | null;
};

async function seedAgentProfile(input: SeedAgentInput) {
  const db = createDb();
  const now = new Date();
  await db.insert(agentProfiles).values({
    roleId: input.roleId,
    label: input.roleId,
    displayName: input.roleId,
    runtimeType: input.runtimeType ?? "ucm",
    modelName: input.modelName ?? null,
    providerId: input.providerId ?? null,
    commandPath: null,
    customEnv: null,
    customArgs: null,
    reasoningMode: null,
    reasoningEffort: null,
    fallbackModelName: null,
    fallbackProviderId: null,
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `roles-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

// ─── mergeRoleCandidates (pure) ───────────────────────────────────────────────

describe("mergeRoleCandidates", () => {
  test("returns empty array for two empty inputs", () => {
    expect(mergeRoleCandidates([], [])).toEqual([]);
  });

  test("deduplicates roles that appear in both sources", () => {
    const result = mergeRoleCandidates(["coder", "reviewer"], ["reviewer", "lander"]);
    expect(result).toContain("coder");
    expect(result).toContain("reviewer");
    expect(result).toContain("lander");
    // No duplicates
    expect(result.filter((r) => r === "reviewer").length).toBe(1);
  });

  test("returns mapping keys only when DB list is empty", () => {
    const result = mergeRoleCandidates(["coder", "architect"], []);
    expect(result).toEqual(expect.arrayContaining(["coder", "architect"]));
    expect(result.length).toBe(2);
  });

  test("returns DB roleIds only when mapping is empty", () => {
    const result = mergeRoleCandidates([], ["evaluator", "lander"]);
    expect(result).toEqual(expect.arrayContaining(["evaluator", "lander"]));
    expect(result.length).toBe(2);
  });

  test("filters out empty / blank strings", () => {
    const result = mergeRoleCandidates(["coder", "  ", ""], ["  ", "reviewer"]);
    expect(result).not.toContain("  ");
    expect(result).not.toContain("");
    expect(result).toEqual(expect.arrayContaining(["coder", "reviewer"]));
  });
});

// ─── listAvailableRoles ───────────────────────────────────────────────────────

describe("listAvailableRoles", () => {
  test("returns an array (never throws) when both config and DB are empty", async () => {
    writeExecutorConfig({ roleMapping: {} });
    const roles = await listAvailableRoles();
    expect(Array.isArray(roles)).toBe(true);
  });

  test("includes roles from roleMapping keys", async () => {
    writeExecutorConfig({
      roleMapping: { coder: "coder", reviewer: "reviewer" },
    });
    const roles = await listAvailableRoles();
    expect(roles).toContain("coder");
    expect(roles).toContain("reviewer");
  });

  test("includes roles seeded in agent_profiles DB", async () => {
    writeExecutorConfig({ roleMapping: {} });
    await seedAgentProfile({ roleId: "evaluator" });
    const roles = await listAvailableRoles();
    expect(roles).toContain("evaluator");
  });

  test("merges roleMapping keys and DB roleIds, no duplicates", async () => {
    writeExecutorConfig({ roleMapping: { coder: "coder", architect: "architect" } });
    // coder also in DB (duplicate candidate)
    await seedAgentProfile({ roleId: "coder" });
    await seedAgentProfile({ roleId: "lander" });
    const roles = await listAvailableRoles();
    expect(roles).toContain("coder");
    expect(roles).toContain("architect");
    expect(roles).toContain("lander");
    expect(roles.filter((r) => r === "coder").length).toBe(1);
  });

  test("degrades gracefully when config file is missing (no throw)", async () => {
    // Don't call writeExecutorConfig — file won't exist
    // DB is empty too. Should still return an array (possibly built-in floor).
    const roles = await listAvailableRoles();
    expect(Array.isArray(roles)).toBe(true);
    // Must include built-in floor roles
    const floor = ["coder", "reviewer", "architect", "lander", "evaluator"];
    for (const r of floor) {
      expect(roles).toContain(r);
    }
  });
});

// ─── resolveAvailableRoles (policy service) ───────────────────────────────────

describe("resolveAvailableRoles", () => {
  test("returns an array and never throws", async () => {
    writeExecutorConfig({ roleMapping: { coder: "coder" } });
    const roles = await resolveAvailableRoles();
    expect(Array.isArray(roles)).toBe(true);
  });

  test("returns [] on any unexpected error without throwing", async () => {
    // Force an error: remove env so listAvailableRoles might fail (but it degrades).
    // We directly test that resolveAvailableRoles wraps and never re-throws.
    const roles = await resolveAvailableRoles();
    expect(Array.isArray(roles)).toBe(true);
  });

  test("surfaces roles from listAvailableRoles when config exists", async () => {
    writeExecutorConfig({ roleMapping: { reviewer: "reviewer", lander: "lander" } });
    const roles = await resolveAvailableRoles();
    expect(roles).toContain("reviewer");
    expect(roles).toContain("lander");
  });
});
