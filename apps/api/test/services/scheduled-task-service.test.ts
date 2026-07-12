import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createDb, eq, scheduledTasks } from "@magister/db";

import {
  computeNextRunAt,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  runSchedulerTick,
  updateSchedule,
  validateCronExpression,
} from "../../src/services/scheduled-task-service";

const tempRoot = join(process.cwd(), ".tmp-scheduled-task-service");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `scheduled-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("validateCronExpression accepts valid and rejects invalid", () => {
  expect(validateCronExpression("0 9 * * *")).toBeNull();
  expect(validateCronExpression("*/5 * * * *")).toBeNull();
  expect(validateCronExpression("not a cron")).not.toBeNull();
  expect(validateCronExpression("99 99 * * *")).not.toBeNull();
});

test("computeNextRunAt returns a future date", () => {
  const from = new Date("2026-07-10T08:00:00");
  const next = computeNextRunAt("0 9 * * *", from);
  expect(next).not.toBeNull();
  expect(next!.getTime()).toBeGreaterThan(from.getTime());
});

test("createSchedule persists row with computed nextRunAt", async () => {
  const row = await createSchedule({
    name: "daily research",
    cronExpr: "0 9 * * *",
    prompt: "Research AI news and summarize",
  });
  expect(row.name).toBe("daily research");
  expect(row.enabled).toBe(1);
  expect(row.nextRunAt).not.toBeNull();

  const listed = await listSchedules();
  expect(listed.length).toBe(1);
});

test("createSchedule rejects invalid cron", async () => {
  await expect(
    createSchedule({ name: "bad", cronExpr: "nope", prompt: "x" }),
  ).rejects.toThrow(/Invalid cron expression/);
});

test("updateSchedule disable clears nextRunAt; re-enable recomputes", async () => {
  const row = await createSchedule({
    name: "s",
    cronExpr: "0 9 * * *",
    prompt: "p",
  });

  const disabled = await updateSchedule(row.id, { enabled: false });
  expect(disabled?.enabled).toBe(0);
  expect(disabled?.nextRunAt).toBeNull();

  const enabled = await updateSchedule(row.id, { enabled: true });
  expect(enabled?.enabled).toBe(1);
  expect(enabled?.nextRunAt).not.toBeNull();
});

test("deleteSchedule removes the row", async () => {
  const row = await createSchedule({ name: "s", cronExpr: "0 9 * * *", prompt: "p" });
  expect(await deleteSchedule(row.id)).toBe(true);
  expect(await getSchedule(row.id)).toBeNull();
  expect(await deleteSchedule(row.id)).toBe(false);
});

test("runSchedulerTick skips not-yet-due schedules", async () => {
  await createSchedule({ name: "s", cronExpr: "0 9 * * *", prompt: "p" });
  // nextRunAt is in the future — tick with `now` far in the past finds nothing.
  const result = await runSchedulerTick(new Date(0));
  expect(result.due).toBe(0);
  expect(result.fired.length).toBe(0);
});

test("runSchedulerTick advances nextRunAt for a due schedule even when trigger fails", async () => {
  const row = await createSchedule({ name: "s", cronExpr: "*/5 * * * *", prompt: "p" });

  // Force the row due NOW.
  const db = createDb();
  const past = new Date(Date.now() - 60_000);
  await db.update(scheduledTasks).set({ nextRunAt: past }).where(eq(scheduledTasks.id, row.id));

  // processTaskIntent will fail in this bare test env (no leader
  // provider configured OR spawn a task that errors) — either way the
  // slot must advance and the row must record the attempt exactly once.
  const now = new Date();
  const result = await runSchedulerTick(now);
  expect(result.due).toBe(1);

  const after = await getSchedule(row.id);
  expect(after?.nextRunAt).not.toBeNull();
  expect(after!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());

  // Second tick at the same instant: slot already advanced, so no re-fire.
  const second = await runSchedulerTick(now);
  expect(second.due).toBe(0);
});
