import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { buildApp } from "../../src/app";

const tempRoot = join(process.cwd(), ".tmp-system-route-db");
const ORIGINAL_ARTIFACT_RETENTION_ENABLED = process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED;
const ORIGINAL_ARTIFACT_RETENTION_INTERVAL_MS = process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS;
const ORIGINAL_ARTIFACT_RETENTION_GRACE_MS = process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS;
const ORIGINAL_RUNTIME_RECOVERY_ENABLED = process.env.MAGISTER_RUNTIME_RECOVERY_ENABLED;
const ORIGINAL_RUNTIME_RECOVERY_INTERVAL_MS = process.env.MAGISTER_RUNTIME_RECOVERY_INTERVAL_MS;
const ORIGINAL_RUNTIME_RECOVERY_STALE_RUNNING_MS =
  process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS;
const ORIGINAL_RUNTIME_RECOVERY_STUCK_TASK_MS = process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS;
const ORIGINAL_RUNTIME_RECOVERY_MAX_ATTEMPTS = process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS;

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `system-route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED = ORIGINAL_ARTIFACT_RETENTION_ENABLED;
  process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS = ORIGINAL_ARTIFACT_RETENTION_INTERVAL_MS;
  process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS = ORIGINAL_ARTIFACT_RETENTION_GRACE_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_ENABLED = ORIGINAL_RUNTIME_RECOVERY_ENABLED;
  process.env.MAGISTER_RUNTIME_RECOVERY_INTERVAL_MS = ORIGINAL_RUNTIME_RECOVERY_INTERVAL_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS =
    ORIGINAL_RUNTIME_RECOVERY_STALE_RUNNING_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS = ORIGINAL_RUNTIME_RECOVERY_STUCK_TASK_MS;
  process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS = ORIGINAL_RUNTIME_RECOVERY_MAX_ATTEMPTS;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /system/status aggregates artifact retention, runtime recovery, and feishu gateway status", async () => {
  const executionEventRepository = new ExecutionEventRepository();

  process.env.MAGISTER_ARTIFACT_RETENTION_ENABLED = "true";
  process.env.MAGISTER_ARTIFACT_RETENTION_INTERVAL_MS = "90000";
  process.env.MAGISTER_ARTIFACT_RETENTION_GRACE_MS = "45000";
  process.env.MAGISTER_RUNTIME_RECOVERY_ENABLED = "true";
  process.env.MAGISTER_RUNTIME_RECOVERY_INTERVAL_MS = "30000";
  process.env.MAGISTER_RUNTIME_RECOVERY_STALE_RUNNING_MS = "120000";
  process.env.MAGISTER_RUNTIME_RECOVERY_STUCK_TASK_MS = "180000";
  process.env.MAGISTER_RUNTIME_RECOVERY_MAX_ATTEMPTS = "4";

  await executionEventRepository.create({
    id: "event_system_retention_tick",
    type: "worker.artifact_retention.tick",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:30:00.000Z"),
    payloadJson: JSON.stringify({
      windowStart: "2026-04-10T12:28:45.000Z",
      scannedTaskCount: 2,
      eligibleTaskCount: 1,
      cleanedTaskIds: ["task_system_retention_1"],
      deletedArtifactIds: ["artifact_system_retention_log_1"],
      failedTaskIds: ["task_system_retention_failed_1"],
    }),
  });

  await executionEventRepository.create({
    id: "event_system_retention_failed",
    type: "worker.artifact_retention.failed",
    taskId: "task_system_retention_failed_1",
    severity: "error",
    occurredAt: new Date("2026-04-10T12:29:30.000Z"),
    payloadJson: JSON.stringify({
      error: "simulated retention failure",
      failedTaskId: "task_system_retention_failed_1",
    }),
  });

  await executionEventRepository.create({
    id: "event_system_runtime_recovery_tick",
    type: "worker.runtime_recovery.tick",
    severity: "info",
    occurredAt: new Date("2026-04-10T12:31:00.000Z"),
    payloadJson: JSON.stringify({
      scannedRunningCount: 3,
      scannedTaskCount: 2,
      scannedWorkspaceCount: 4,
      recoveredRunIds: ["runtime_system_recovered_1"],
      resumedTaskIds: ["task_system_resumed_1"],
      blockedRunIds: ["runtime_system_blocked_1"],
      cleanupEligibleRunIds: ["runtime_workspace_cleanup_1"],
      missingWorkspaceRunIds: ["runtime_system_recovered_1"],
    }),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/system/status",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      workers: {
        artifactRetention: {
          enabled: true,
          inFlight: false,
          intervalMs: 90000,
          graceMs: 45000,
          lastTickAt: "2026-04-10T12:30:00.000Z",
          lastWindowStart: "2026-04-10T12:28:45.000Z",
          lastScannedTaskCount: 2,
          lastEligibleTaskCount: 1,
          lastCleanedTaskIds: ["task_system_retention_1"],
          lastDeletedArtifactIds: ["artifact_system_retention_log_1"],
          lastFailedTaskIds: ["task_system_retention_failed_1"],
          lastFailureAt: "2026-04-10T12:29:30.000Z",
          lastFailureTaskId: "task_system_retention_failed_1",
          lastFailureMessage: "simulated retention failure",
        },
        runtimeRecovery: {
          enabled: true,
          inFlight: false,
          intervalMs: 30000,
          staleRunningThresholdMs: 120000,
          stuckTaskThresholdMs: 180000,
          maxAttempts: 4,
          lastTickAt: "2026-04-10T12:31:00.000Z",
          lastScannedRunningCount: 3,
          lastScannedTaskCount: 2,
          lastScannedWorkspaceCount: 4,
          lastRecoveredRunIds: ["runtime_system_recovered_1"],
          lastResumedTaskIds: ["task_system_resumed_1"],
          lastBlockedRunIds: ["runtime_system_blocked_1"],
          lastCleanupEligibleRunIds: ["runtime_workspace_cleanup_1"],
          lastMissingWorkspaceRunIds: ["runtime_system_recovered_1"],
        },
      },
      integrations: {
        feishuGateway: expect.objectContaining({
          running: false,
          connectionState: "idle",
        }),
      },
    },
  });
});
