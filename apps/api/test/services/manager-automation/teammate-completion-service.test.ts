/**
 * Tests for writeTeammateCompletionMailbox — specifically the
 * parallel-group-completion aggregation fix: when the last member of a
 * parallel group completes, the `parallel_group_completion` mailbox row
 * must contain a consolidated summary of ALL group members, not just a
 * bare "N done" note.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-teammate-completion-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `tc-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function seedGroupMembers(
  groupId: string,
  taskId: string,
  members: Array<{ id: string; roleId: string; state: string }>,
) {
  const { RoleRuntimeRepository } = await import(
    "../../../src/repositories/role-runtime-repository"
  );
  const repo = new RoleRuntimeRepository();
  const now = new Date();
  for (const m of members) {
    await repo.create({
      id: m.id,
      taskId,
      roleId: m.roleId,
      state: m.state as any,
      parallelGroupId: groupId,
      attemptCount: 0,
      updatedAt: now,
    });
  }
}

async function seedEarlierTeammateCompletionMailbox(
  taskId: string,
  runId: string,
  role: string,
  summary: string,
  completedAtMs: number,
) {
  const { TaskMailboxRepository } = await import(
    "../../../src/repositories/task-mailbox-repository"
  );
  const repo = new TaskMailboxRepository();
  await repo.create({
    id: `msg_async_${runId}_${completedAtMs}`,
    taskId,
    sender: "system",
    content: `[teammate completed] ${role} (${runId}): ${summary.split("\n")[0]?.slice(0, 120) ?? ""}`,
    metadataJson: JSON.stringify({
      type: "teammate_completion",
      teammateRunId: runId,
      role,
      status: "COMPLETED",
      summary,
      spawnedAtMs: completedAtMs - 5000,
      completedAtMs,
      durationMs: 5000,
    }),
    createdAt: new Date(completedAtMs),
  });
}

// ─── tests ────────────────────────────────────────────────────────────────────

test("parallel_group_completion row contains consolidated summaries of all group members", async () => {
  const { writeTeammateCompletionMailbox } = await import(
    "../../../src/services/manager-automation/teammate-completion-service"
  );
  const { TaskMailboxRepository } = await import(
    "../../../src/repositories/task-mailbox-repository"
  );

  const taskId = "task_pg_test_1";
  const groupId = "pg_test_group_3";
  const now = Date.now();

  // Seed the group runtime rows — 3 members, all COMPLETED (group complete).
  await seedGroupMembers(groupId, taskId, [
    { id: "rt_pg_m1", roleId: "architect", state: "COMPLETED" },
    { id: "rt_pg_m2", roleId: "coder", state: "COMPLETED" },
    { id: "rt_pg_m3", roleId: "reviewer", state: "COMPLETED" },
  ]);

  // Seed the earlier members' per-teammate mailbox rows (already written).
  await seedEarlierTeammateCompletionMailbox(
    taskId,
    "rt_pg_m1",
    "architect",
    "Architect full plan: designed the overall system layout with 5 modules.",
    now - 4000,
  );
  await seedEarlierTeammateCompletionMailbox(
    taskId,
    "rt_pg_m2",
    "coder",
    "Coder output: implemented all 5 modules, tests pass.",
    now - 2000,
  );

  // Simulate the LAST member completing (triggers group completion).
  await writeTeammateCompletionMailbox({
    parentTaskId: taskId,
    teammateRunId: "rt_pg_m3",
    role: "reviewer",
    status: "COMPLETED",
    summary: "Reviewer conclusion: code quality is good, approved.",
    spawnedAtMs: now - 10000,
    completedAtMs: now,
    parallelGroupId: groupId,
  });

  // Find the parallel_group_completion row.
  const repo = new TaskMailboxRepository();
  const rows = await repo.listByTaskId(taskId);
  const groupRow = rows.find((r) => {
    if (!r.metadataJson) return false;
    try {
      const m = JSON.parse(r.metadataJson) as { type?: string };
      return m.type === "parallel_group_completion";
    } catch {
      return false;
    }
  });

  expect(groupRow).toBeDefined();

  // The content must mention all three roles and their summaries.
  expect(groupRow!.content).toContain("architect");
  expect(groupRow!.content).toContain("Architect full plan");
  expect(groupRow!.content).toContain("coder");
  expect(groupRow!.content).toContain("Coder output");
  expect(groupRow!.content).toContain("reviewer");
  expect(groupRow!.content).toContain("Reviewer conclusion");

  // Metadata must carry the structured members array.
  const meta = JSON.parse(groupRow!.metadataJson!) as {
    type: string;
    parallelGroupId: string;
    memberCount: number;
    completedAtMs: number;
    members?: Array<{ role: string; runId: string; summary: string }>;
  };
  expect(meta.type).toBe("parallel_group_completion");
  expect(meta.parallelGroupId).toBe(groupId);
  expect(meta.memberCount).toBe(3);
  expect(Array.isArray(meta.members)).toBe(true);
  expect(meta.members!.length).toBe(3);

  const roles = meta.members!.map((m) => m.role).sort();
  expect(roles).toEqual(["architect", "coder", "reviewer"]);

  const arch = meta.members!.find((m) => m.role === "architect");
  expect(arch!.summary).toContain("Architect full plan");
});

test("parallel_group_completion content is capped at ~40000 chars even for large summaries", async () => {
  const { writeTeammateCompletionMailbox } = await import(
    "../../../src/services/manager-automation/teammate-completion-service"
  );
  const { TaskMailboxRepository } = await import(
    "../../../src/repositories/task-mailbox-repository"
  );

  const taskId = "task_pg_test_cap";
  const groupId = "pg_test_cap_2";
  const now = Date.now();

  await seedGroupMembers(groupId, taskId, [
    { id: "rt_cap_m1", roleId: "coder", state: "COMPLETED" },
    { id: "rt_cap_m2", roleId: "architect", state: "COMPLETED" },
  ]);

  // First member with a huge summary (50000 chars).
  const hugeSummary = "A".repeat(50_000);
  await seedEarlierTeammateCompletionMailbox(
    taskId,
    "rt_cap_m1",
    "coder",
    hugeSummary,
    now - 2000,
  );

  await writeTeammateCompletionMailbox({
    parentTaskId: taskId,
    teammateRunId: "rt_cap_m2",
    role: "architect",
    status: "COMPLETED",
    summary: "B".repeat(50_000),
    spawnedAtMs: now - 10000,
    completedAtMs: now,
    parallelGroupId: groupId,
  });

  const repo = new TaskMailboxRepository();
  const rows = await repo.listByTaskId(taskId);
  const groupRow = rows.find((r) => {
    if (!r.metadataJson) return false;
    try {
      const m = JSON.parse(r.metadataJson) as { type?: string };
      return m.type === "parallel_group_completion";
    } catch {
      return false;
    }
  });

  expect(groupRow).toBeDefined();
  // Content must be bounded to ≤ 40000 chars.
  expect(groupRow!.content.length).toBeLessThanOrEqual(40_000);
  // Must still mention both roles.
  expect(groupRow!.content).toContain("coder");
  expect(groupRow!.content).toContain("architect");
});

test("partial group (not all terminal) does NOT write a parallel_group_completion row", async () => {
  const { writeTeammateCompletionMailbox } = await import(
    "../../../src/services/manager-automation/teammate-completion-service"
  );
  const { TaskMailboxRepository } = await import(
    "../../../src/repositories/task-mailbox-repository"
  );

  const taskId = "task_pg_test_partial";
  const groupId = "pg_test_partial_3";
  const now = Date.now();

  // Only 2 of 3 members exist (group encoded size 3); one is still RUNNING.
  await seedGroupMembers(groupId, taskId, [
    { id: "rt_partial_m1", roleId: "coder", state: "COMPLETED" },
    { id: "rt_partial_m2", roleId: "architect", state: "RUNNING" },
  ]);

  await writeTeammateCompletionMailbox({
    parentTaskId: taskId,
    teammateRunId: "rt_partial_m1",
    role: "coder",
    status: "COMPLETED",
    summary: "done",
    spawnedAtMs: now - 10000,
    completedAtMs: now,
    parallelGroupId: groupId,
  });

  const repo = new TaskMailboxRepository();
  const rows = await repo.listByTaskId(taskId);
  const groupRow = rows.find((r) => {
    if (!r.metadataJson) return false;
    try {
      const m = JSON.parse(r.metadataJson) as { type?: string };
      return m.type === "parallel_group_completion";
    } catch {
      return false;
    }
  });

  expect(groupRow).toBeUndefined();
});

test("falls back gracefully when no earlier mailbox rows exist for prior members", async () => {
  const { writeTeammateCompletionMailbox } = await import(
    "../../../src/services/manager-automation/teammate-completion-service"
  );
  const { TaskMailboxRepository } = await import(
    "../../../src/repositories/task-mailbox-repository"
  );

  const taskId = "task_pg_test_fallback";
  const groupId = "pg_test_fallback_2";
  const now = Date.now();

  // Both members exist and are COMPLETED, but only the last one has a
  // teammate_completion mailbox row (simulating a rare lost row).
  await seedGroupMembers(groupId, taskId, [
    { id: "rt_fb_m1", roleId: "coder", state: "COMPLETED" },
    { id: "rt_fb_m2", roleId: "architect", state: "COMPLETED" },
  ]);
  // NOTE: no earlier mailbox row seeded for rt_fb_m1.

  await writeTeammateCompletionMailbox({
    parentTaskId: taskId,
    teammateRunId: "rt_fb_m2",
    role: "architect",
    status: "COMPLETED",
    summary: "Architect done.",
    spawnedAtMs: now - 10000,
    completedAtMs: now,
    parallelGroupId: groupId,
  });

  const repo = new TaskMailboxRepository();
  const rows = await repo.listByTaskId(taskId);
  const groupRow = rows.find((r) => {
    if (!r.metadataJson) return false;
    try {
      const m = JSON.parse(r.metadataJson) as { type?: string };
      return m.type === "parallel_group_completion";
    } catch {
      return false;
    }
  });

  // Should still write a group completion row without throwing.
  expect(groupRow).toBeDefined();
  // Must include the known member.
  expect(groupRow!.content).toContain("architect");
  expect(groupRow!.content).toContain("Architect done.");
});
