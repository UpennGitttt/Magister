import { test, expect, beforeEach } from "bun:test";

import { TaskRepository } from "../../src/repositories/task-repository";

// CAS guard for the /model slash command's concurrent-POST race
// (a99d52c → tightened per deepseek review). Verifies the atomic
// conditional UPDATE actually returns 0 changes when the expected
// value drifts mid-flight.

const repo = new TaskRepository();

async function makeTask(id: string, modelOverride: string | null = null) {
  await repo.create({
    id,
    workspaceId: "workspace_main",
    source: "web",
    title: `CAS test ${id}`,
    state: "EXECUTING",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  if (modelOverride !== null) {
    await repo.update(id, { modelOverride });
  }
}

beforeEach(async () => {
  // Lightweight cleanup — tests use fresh ids so collision is unlikely,
  // but we still want a known floor.
});

test("casUpdateModelOverride: expected=null on null column writes and returns 1", async () => {
  const id = `cas_${Date.now()}_a`;
  await makeTask(id, null);
  const changes = await repo.casUpdateModelOverride(id, null, "new-model");
  expect(changes).toBe(1);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBe("new-model");
});

test("casUpdateModelOverride: expected matches current value writes and returns 1", async () => {
  const id = `cas_${Date.now()}_b`;
  await makeTask(id, "old-model");
  const changes = await repo.casUpdateModelOverride(id, "old-model", "newer-model");
  expect(changes).toBe(1);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBe("newer-model");
});

test("casUpdateModelOverride: expected stale (null vs actual value) returns 0 and does NOT write", async () => {
  const id = `cas_${Date.now()}_c`;
  await makeTask(id, "concurrent-write");
  // Caller saw null at GET time; another tab landed "concurrent-write"
  // before commit. CAS must refuse.
  const changes = await repo.casUpdateModelOverride(id, null, "doomed");
  expect(changes).toBe(0);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBe("concurrent-write");
});

test("casUpdateModelOverride: expected stale (value vs actual null) returns 0", async () => {
  const id = `cas_${Date.now()}_d`;
  await makeTask(id, null);
  const changes = await repo.casUpdateModelOverride(id, "expected-something", "doomed");
  expect(changes).toBe(0);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBeNull();
});

test("casUpdateModelOverride: expected stale (value mismatch) returns 0", async () => {
  const id = `cas_${Date.now()}_e`;
  await makeTask(id, "model-x");
  const changes = await repo.casUpdateModelOverride(id, "model-y", "doomed");
  expect(changes).toBe(0);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBe("model-x");
});

test("casUpdateModelOverride: set back to null on match writes", async () => {
  const id = `cas_${Date.now()}_f`;
  await makeTask(id, "model-x");
  const changes = await repo.casUpdateModelOverride(id, "model-x", null);
  expect(changes).toBe(1);
  const after = await repo.getById(id);
  expect(after?.modelOverride).toBeNull();
});
