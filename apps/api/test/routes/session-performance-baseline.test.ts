import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import {
  makeLargeSessionEvents,
  seedLargeSessionFixture,
} from "../fixtures/large-session-fixture";

const tempRoot = join(process.cwd(), ".tmp-session-performance-baseline-db");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `session-performance-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_SSE_IDLE_MS = "50";
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_SSE_IDLE_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("large-session fixture covers required event-count baselines", () => {
  for (const eventCount of [1, 10, 100, 1_000, 10_000]) {
    const events = makeLargeSessionEvents({
      taskId: `task_large_${eventCount}`,
      runId: `rt_large_${eventCount}`,
      eventCount,
    });
    expect(events).toHaveLength(eventCount);
    expect(new Set(events.map((event) => event.requestId)).size).toBeGreaterThan(0);
  }
});

test("GET /tasks/:taskId/events uses bounded latest-turn hydration for large sessions", async () => {
  const taskId = "task_large_events_route";
  await seedLargeSessionFixture({
    taskId,
    runId: "rt_large_events_route",
    eventCount: 1_000,
    requestCount: 50,
  });

  const response = await buildApp().inject({
    method: "GET",
    url: `/tasks/${taskId}/events`,
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json() as {
    data: { events: Array<{ requestId: string | null }>; latestSeq: number };
  };
  expect(payload.data.events.length).toBeGreaterThan(0);
  expect(payload.data.events.length).toBeLessThan(1_000);
  expect(new Set(payload.data.events.map((event) => event.requestId))).toHaveLength(30);
  expect(payload.data.latestSeq).toBeGreaterThan(0);
});
