import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSpec } from "../../src/services/project-spec-service";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "project-spec-test-"));
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `spec-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  delete process.env.MAGISTER_DB_PATH;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

import {
  parseProjectSpec,
  getNextPendingFeature,
  updateFeatureStatus,
  formatSpecForPrompt,
  isProjectComplete,
} from "../../src/services/project-spec-service";

function buildSpec(overrides?: Partial<ProjectSpec>): ProjectSpec {
  return {
    projectName: "User Auth System",
    description: "Auth service features",
    features: [
      {
        id: "F1",
        title: "Login endpoint",
        criteria: ["POST /auth/login returns JWT", "invalid creds return 401"],
        status: "pending",
      },
    ],
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("project-spec-service", () => {
  test("parseProjectSpec parses valid JSON spec", () => {
    const raw = JSON.stringify(
      buildSpec({
        projectName: "User Auth System",
      }),
    );

    const parsed = parseProjectSpec(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.projectName).toBe("User Auth System");
    expect(parsed?.features.length).toBe(1);
    expect(parsed?.features[0]?.id).toBe("F1");
  });

  test("parseProjectSpec rejects invalid spec", () => {
    const raw = JSON.stringify({
      projectName: "Bad Spec",
      features: "not-an-array",
    });

    expect(parseProjectSpec(raw)).toBeNull();
    expect(parseProjectSpec("{invalid-json")).toBeNull();
  });

  test("getNextPendingFeature returns first pending feature", () => {
    const spec = buildSpec({
      features: [
        {
          id: "F1",
          title: "Scaffold auth module",
          criteria: ["module exists"],
          status: "in_progress",
        },
        {
          id: "F2",
          title: "Login endpoint",
          criteria: ["POST /auth/login returns JWT"],
          status: "pending",
        },
        {
          id: "F3",
          title: "Refresh token endpoint",
          criteria: ["POST /auth/refresh returns new JWT"],
          status: "pending",
        },
      ],
    });

    const feature = getNextPendingFeature(spec);
    expect(feature?.id).toBe("F2");
  });

  test("getNextPendingFeature returns null when all done", () => {
    const spec = buildSpec({
      features: [
        {
          id: "F1",
          title: "Login endpoint",
          criteria: ["POST /auth/login returns JWT"],
          status: "implemented",
        },
        {
          id: "F2",
          title: "Evaluator verification",
          criteria: ["all auth tests pass"],
          status: "verified",
        },
      ],
    });

    const feature = getNextPendingFeature(spec);
    expect(feature).toBeNull();
  });

  test("updateFeatureStatus updates status correctly", () => {
    const spec = buildSpec();

    updateFeatureStatus(spec, "F1", "implemented", "Auth endpoint merged");

    expect(spec.features[0]?.status).toBe("implemented");
    expect(spec.features[0]?.result).toBe("Auth endpoint merged");
  });

  test("formatSpecForPrompt produces readable summary", () => {
    const spec = buildSpec({
      features: [
        {
          id: "F1",
          title: "Login endpoint",
          description: "JWT login API",
          criteria: ["POST /auth/login returns JWT", "invalid creds return 401"],
          status: "pending",
        },
        {
          id: "F2",
          title: "Refresh endpoint",
          criteria: ["POST /auth/refresh returns token"],
          status: "verified",
        },
      ],
    });

    const summary = formatSpecForPrompt(spec);
    expect(summary).toContain("Project: User Auth System");
    expect(summary).toContain("F1");
    expect(summary).toContain("F2");
    expect(summary).toContain("POST /auth/login returns JWT");
    expect(summary).toContain("⏳");
    expect(summary).toContain("✅");
  });
});

import {
  createProjectSpec as createProjectSpecDb,
  getProjectSpec as getProjectSpecDb,
  updateProjectSpecOrchestration,
} from "../../src/services/project-spec-service";

describe("project-spec-service DB persistence", () => {
  test("createProjectSpec writes to DB and getProjectSpec reads it back", async () => {
    const spec = buildSpec({ projectName: "DB Test" });
    await createProjectSpecDb("task-123", spec);

    const retrieved = await getProjectSpecDb("task-123");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.projectName).toBe("DB Test");
    expect(retrieved?.features.length).toBe(1);
    expect(retrieved?.features[0]?.id).toBe("F1");
  });

  test("getProjectSpec returns null for unknown taskId", async () => {
    const retrieved = await getProjectSpecDb("unknown-task");
    expect(retrieved).toBeNull();
  });

  test("createProjectSpec overwrites existing spec for same taskId", async () => {
    const spec1 = buildSpec({ projectName: "First" });
    await createProjectSpecDb("task-456", spec1);

    const spec2 = buildSpec({ projectName: "Second" });
    await createProjectSpecDb("task-456", spec2);

    const retrieved = await getProjectSpecDb("task-456");
    expect(retrieved?.projectName).toBe("Second");
  });

  test("updateProjectSpecOrchestration stores and retrieves orchestration state", async () => {
    const spec = buildSpec();
    await createProjectSpecDb("task-789", spec);

    const orchestration = {
      spawnedRuns: [{ role: "coder", goalHash: "abc123", isolate: true, status: "DONE" }],
      baselineTests: { count: 47, allGreen: true, timestamp: "2026-05-08T00:00:00Z" },
    };

    await updateProjectSpecOrchestration("task-789", orchestration);

    const retrieved = await getProjectSpecDb("task-789");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.orchestration).toEqual(orchestration);
  });

  test("updateProjectSpecOrchestration returns error for unknown taskId", async () => {
    const result = await updateProjectSpecOrchestration("unknown-task", { spawnedRuns: [] });
    expect(result).toEqual({ error: "No project spec found for task unknown-task" });
  });

  test("spec survives process restart (DB persistence)", async () => {
    const spec = buildSpec({ projectName: "Survives Restart" });
    await createProjectSpecDb("task-restart", spec);

    // Simulate process restart by re-importing the module
    const { getProjectSpec: getProjectSpec2 } = await import(
      "../../src/services/project-spec-service"
    );

    const retrieved = await getProjectSpec2("task-restart");
    expect(retrieved?.projectName).toBe("Survives Restart");
  });
});
