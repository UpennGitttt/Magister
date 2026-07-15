import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../../src/repositories/role-runtime-repository";
import {
  SENTINEL_SIGNAL_EVENT_TYPE,
  runSentinelTick,
  type SentinelSignalPayload,
} from "../../src/services/sentinel-service";

const tempRoot = join(process.cwd(), ".tmp-sentinel-test");

const NOW = new Date("2026-07-14T12:00:00Z");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `sentinel-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  delete process.env.MAGISTER_SENTINEL_MCP_CHECKS;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_SENTINEL_MCP_CHECKS;
  rmSync(tempRoot, { recursive: true, force: true });
});

async function listSignals(): Promise<SentinelSignalPayload[]> {
  const repo = new ExecutionEventRepository();
  const events = await repo.listByTypesSince(
    [SENTINEL_SIGNAL_EVENT_TYPE],
    new Date("2026-07-14T00:00:00Z"),
  );
  return events.map((e) => JSON.parse(e.payloadJson!) as SentinelSignalPayload);
}

async function seedStalledRuntime() {
  await new RoleRuntimeRepository().create({
    id: "run-stalled",
    taskId: "t-1",
    roleId: "coder",
    state: "RUNNING",
    updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 60 min idle
  });
}

async function seedOverdueApproval() {
  await new ApprovalRepository().create({
    id: "appr-overdue",
    taskId: "t-1",
    approvalType: "command",
    state: "pending",
    requestedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
  });
}

test("tick records signals for stalled runtime and overdue approval", async () => {
  await seedStalledRuntime();
  await seedOverdueApproval();

  const result = await runSentinelTick(NOW);

  expect(result.recorded).toBe(2);
  const signals = await listSignals();
  const types = signals.map((s) => s.signalType).sort();
  expect(types).toEqual(["approval_overdue", "stalled_runtime"]);
  const stalled = signals.find((s) => s.signalType === "stalled_runtime")!;
  expect(stalled.ref).toBe("run-stalled");
  expect(stalled.fingerprint).toBe("stalled_runtime:run-stalled");
});

test("second tick with same state dedups (0 new signals)", async () => {
  await seedStalledRuntime();

  const first = await runSentinelTick(NOW);
  expect(first.recorded).toBe(1);

  const second = await runSentinelTick(new Date(NOW.getTime() + 5 * 60 * 1000));
  expect(second.recorded).toBe(0);
  expect(second.deduped).toBe(1);
  expect(await listSignals()).toHaveLength(1);
});

test("healthy runtime and fresh approval produce no signals", async () => {
  await new RoleRuntimeRepository().create({
    id: "run-healthy",
    taskId: "t-1",
    roleId: "coder",
    state: "RUNNING",
    updatedAt: new Date(NOW.getTime() - 60 * 1000), // 1 min idle
  });
  await new ApprovalRepository().create({
    id: "appr-fresh",
    taskId: "t-1",
    approvalType: "command",
    state: "pending",
    requestedAt: new Date(NOW.getTime() - 60 * 1000),
  });

  const result = await runSentinelTick(NOW);
  expect(result.recorded).toBe(0);
  expect(await listSignals()).toHaveLength(0);
});

test("risk events since start of day become signals", async () => {
  await new ExecutionEventRepository().create({
    id: "evt-doom",
    type: "leader.doom_loop_detected",
    taskId: "t-doom",
    occurredAt: new Date("2026-07-14T08:00:00Z"),
    payloadJson: "{}",
  });

  const result = await runSentinelTick(NOW);
  expect(result.recorded).toBe(1);
  const signals = await listSignals();
  expect(signals[0]!.signalType).toBe("risk_event");
  expect(signals[0]!.ref).toBe("evt-doom");
});

test("bad MCP checks JSON does not throw; valid check records signal with detail", async () => {
  process.env.MAGISTER_SENTINEL_MCP_CHECKS = "not-json{";
  const noChecks = await runSentinelTick(NOW);
  expect(noChecks.recorded).toBe(0);

  process.env.MAGISTER_SENTINEL_MCP_CHECKS = JSON.stringify([
    { serverId: "github", toolName: "list_prs", label: "gh-prs" },
  ]);
  const dispatched: string[] = [];
  const result = await runSentinelTick(NOW, {
    mcpDispatch: async (serverId, toolName) => {
      dispatched.push(`${serverId}.${toolName}`);
      return { isError: false, content: [{ type: "text", text: "PR #7 stuck" }] };
    },
  });

  expect(dispatched).toEqual(["github.list_prs"]);
  expect(result.recorded).toBe(1);
  const signals = await listSignals();
  expect(signals[0]!.signalType).toBe("mcp_check");
  expect(signals[0]!.detail).toEqual([{ type: "text", text: "PR #7 stuck" }]);
});

test("MCP dispatch error is swallowed (fail-safe), other sources still record", async () => {
  await seedStalledRuntime();
  process.env.MAGISTER_SENTINEL_MCP_CHECKS = JSON.stringify([
    { serverId: "github", toolName: "boom" },
  ]);

  const result = await runSentinelTick(NOW, {
    mcpDispatch: async () => {
      throw new Error("connection refused");
    },
  });

  expect(result.recorded).toBe(1);
  const signals = await listSignals();
  expect(signals[0]!.signalType).toBe("stalled_runtime");
});
