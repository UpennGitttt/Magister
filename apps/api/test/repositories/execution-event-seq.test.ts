import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";

const tempRoot = join(process.cwd(), ".tmp-seq-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(tempRoot, `seq-${Date.now()}.sqlite`);
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("create assigns sequential seq numbers", async () => {
  const repo = new ExecutionEventRepository();
  const seq1 = await repo.create({ id: "e1", type: "test", occurredAt: new Date(), taskId: "t1" });
  const seq2 = await repo.create({ id: "e2", type: "test", occurredAt: new Date(), taskId: "t1" });
  expect(seq2).toBeGreaterThan(seq1);
});

test("listSinceSeq returns events after given seq", async () => {
  const repo = new ExecutionEventRepository();
  await repo.create({ id: "e1", type: "test", occurredAt: new Date(), taskId: "t1" });
  const seq = await repo.create({ id: "e2", type: "test", occurredAt: new Date(), taskId: "t1" });
  await repo.create({ id: "e3", type: "test", occurredAt: new Date(), taskId: "t1" });

  const results = await repo.listSinceSeq("t1", seq);
  expect(results.length).toBe(1);
  expect(results[0]?.id).toBe("e3");
});
