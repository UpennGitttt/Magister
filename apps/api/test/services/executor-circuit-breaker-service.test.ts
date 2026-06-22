import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  getExecutorCircuitState,
  recordExecutorCircuitFailure,
  recordExecutorCircuitSuccess,
  resetExecutorCircuitsForTests,
} from "../../src/services/executor-circuit-breaker-service";

const tempRoot = join(process.cwd(), ".tmp-executor-circuit-db");
const ORIGINAL_STORE_PATH = process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH;
const ORIGINAL_THRESHOLD = process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD;
const ORIGINAL_OPEN_MS = process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH = join(
    tempRoot,
    `circuit-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD = "2";
  process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS = "60000";
});

afterEach(async () => {
  process.env.MAGISTER_EXECUTOR_CIRCUIT_STORE_PATH = ORIGINAL_STORE_PATH;
  process.env.MAGISTER_EXECUTOR_CIRCUIT_FAILURE_THRESHOLD = ORIGINAL_THRESHOLD;
  process.env.MAGISTER_EXECUTOR_CIRCUIT_OPEN_MS = ORIGINAL_OPEN_MS;
  await resetExecutorCircuitsForTests();
  rmSync(tempRoot, { recursive: true, force: true });
});

test("executor circuit opens after consecutive failures and resets after success", async () => {
  await recordExecutorCircuitFailure("codex", {
    code: "executor_timeout",
    now: new Date("2026-04-13T12:00:00.000Z"),
  });

  const first = await getExecutorCircuitState("codex", {
    now: new Date("2026-04-13T12:00:01.000Z"),
  });
  expect(first.state).toBe("closed");
  expect(first.consecutiveFailures).toBe(1);

  await recordExecutorCircuitFailure("codex", {
    code: "executor_timeout",
    now: new Date("2026-04-13T12:00:02.000Z"),
  });

  const second = await getExecutorCircuitState("codex", {
    now: new Date("2026-04-13T12:00:03.000Z"),
  });
  expect(second.state).toBe("open");
  expect(second.consecutiveFailures).toBe(2);
  expect(second.openUntil).toBe("2026-04-13T12:01:02.000Z");

  const halfOpen = await getExecutorCircuitState("codex", {
    now: new Date("2026-04-13T12:01:03.000Z"),
  });
  expect(halfOpen.state).toBe("half_open");

  await recordExecutorCircuitSuccess("codex", {
    now: new Date("2026-04-13T12:01:05.000Z"),
  });
  const recovered = await getExecutorCircuitState("codex", {
    now: new Date("2026-04-13T12:01:06.000Z"),
  });
  expect(recovered.state).toBe("closed");
  expect(recovered.consecutiveFailures).toBe(0);
  expect(recovered.openUntil).toBeNull();
});

