import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-feishu-trace-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `trace-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("queueFeishuRuntimeTraceIfEnabled handles leader.tool_call event without throwing", async () => {
  const { queueFeishuRuntimeTraceIfEnabled } = await import(
    "../../src/services/queue-feishu-runtime-trace-service"
  );

  let threw = false;
  try {
    await queueFeishuRuntimeTraceIfEnabled({
      taskId: "t-1",
      runId: "r-1",
      bindingId: "b-1",
      eventType: "leader.tool_call",
      payload: { toolName: "bash", inputSummary: "ls -la" },
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);
});

test("queueFeishuRuntimeTraceIfEnabled handles leader.session_complete event", async () => {
  const { queueFeishuRuntimeTraceIfEnabled } = await import(
    "../../src/services/queue-feishu-runtime-trace-service"
  );

  let threw = false;
  try {
    await queueFeishuRuntimeTraceIfEnabled({
      taskId: "t-1",
      runId: "r-1",
      bindingId: "b-1",
      eventType: "leader.session_complete",
      payload: { reason: "completed", totalTurns: 3, finalAnswer: "Done" },
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);
});
