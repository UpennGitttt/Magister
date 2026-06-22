/**
 * MemoryProvenanceRepository tests — verify the audit-trail mirror
 * stays in lockstep with the on-disk memory store across upsert/
 * delete cycles. (P2-#6, 2026-05-15.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "magister-mem-prov-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("record() inserts a new provenance row with first_* and last_* set", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  await repo.record({
    path: "user-global/feedback/x",
    scope: "user-global",
    type: "feedback",
    authority: "leader-tool",
    writtenAt: new Date(),
    taskId: "task_42",
    requestId: "req_99",
  });
  const row = await repo.getByPath("user-global/feedback/x");
  expect(row).toBeDefined();
  expect(row!.firstWriteAuthority).toBe("leader-tool");
  expect(row!.firstWriteTaskId).toBe("task_42");
  expect(row!.firstWriteRequestId).toBe("req_99");
  expect(row!.lastWriteTaskId).toBe("task_42");
});

test("record() refreshes last_* on subsequent write, keeps first_* stable", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  const t1 = new Date(2026, 4, 15, 10, 0, 0);
  await repo.record({
    path: "user-global/feedback/x",
    scope: "user-global",
    type: "feedback",
    authority: "leader-tool",
    writtenAt: t1,
    taskId: "task_1",
    requestId: "req_1",
  });
  const before = await repo.getByPath("user-global/feedback/x");
  const t2 = new Date(t1.getTime() + 1000);
  await repo.record({
    path: "user-global/feedback/x",
    scope: "user-global",
    type: "feedback",
    authority: "leader-extractor",
    writtenAt: t2,
    taskId: "task_2",
    requestId: "req_2",
  });
  const after = await repo.getByPath("user-global/feedback/x");
  expect(after!.firstWriteAuthority).toBe("leader-tool");
  expect(after!.firstWriteTaskId).toBe("task_1");
  expect(after!.lastWriteAuthority).toBe("leader-extractor");
  expect(after!.lastWriteTaskId).toBe("task_2");
  expect(after!.lastWrittenAt.getTime()).toBeGreaterThanOrEqual(
    before!.lastWrittenAt.getTime(),
  );
});

test("forgetPath() drops the row", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  await repo.record({
    path: "user-global/feedback/x",
    scope: "user-global",
    type: "feedback",
    authority: "leader-tool",
    writtenAt: new Date(),
  });
  await repo.forgetPath("user-global/feedback/x");
  expect(await repo.getByPath("user-global/feedback/x")).toBeUndefined();
});

test("listRecent() returns newest first", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  await repo.record({
    path: "a",
    scope: "user-global",
    type: "user",
    authority: "leader-tool",
    writtenAt: new Date(2026, 4, 15, 10, 0, 0),
  });
  await repo.record({
    path: "b",
    scope: "user-global",
    type: "user",
    authority: "leader-tool",
    writtenAt: new Date(2026, 4, 15, 10, 0, 1),
  });
  const rows = await repo.listRecent(10);
  expect(rows[0]!.path).toBe("b");
  expect(rows[1]!.path).toBe("a");
});

// MEDIUM-9: concurrent first writes don't race on PK insert.
test("record() is an atomic upsert — concurrent first writes don't throw", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  const now = new Date();
  await Promise.all(
    Array.from({ length: 20 }).map((_, i) =>
      repo.record({
        path: "user-global/feedback/race",
        scope: "user-global",
        type: "feedback",
        authority: "leader-tool",
        writtenAt: new Date(now.getTime() + i),
        taskId: `task_${i}`,
      }),
    ),
  );
  const row = await repo.getByPath("user-global/feedback/race");
  expect(row).toBeDefined();
  // The latest writer (highest writtenAt) wins last_*.
  expect(row!.lastWriteTaskId).toBe("task_19");
});

// MEDIUM-12: stale writes can't overwrite newer last_* via the
// SQL guard `WHERE excluded.last_written_at >= memory_entries.last_written_at`.
test("record() rejects a stale-timestamp write from overwriting fresher state", async () => {
  const { MemoryProvenanceRepository } = await import(
    "../../src/repositories/memory-provenance-repository"
  );
  const repo = new MemoryProvenanceRepository();
  const newer = new Date(2026, 4, 15, 10, 0, 10);
  const older = new Date(2026, 4, 15, 10, 0, 0);
  await repo.record({
    path: "p",
    scope: "user-global",
    type: "user",
    authority: "leader-tool",
    writtenAt: newer,
    taskId: "fresh",
  });
  // Now apply a stale write — older timestamp; must NOT overwrite.
  await repo.record({
    path: "p",
    scope: "user-global",
    type: "user",
    authority: "leader-extractor",
    writtenAt: older,
    taskId: "stale",
  });
  const row = await repo.getByPath("p");
  expect(row!.lastWriteTaskId).toBe("fresh");
  expect(row!.lastWriteAuthority).toBe("leader-tool");
});
