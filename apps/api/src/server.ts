import { join } from "node:path";
import { homedir } from "node:os";

import { buildApp } from "./app";
import { startFeishuWebSocketGateway, stopFeishuWebSocketGateway } from "./integrations/feishu/feishu-websocket-gateway";
import { startSlackSocketGateway, stopSlackSocketGateway } from "./integrations/slack/slack-socket-gateway";
import { assertBindSafe, hasApiToken } from "./lib/api-auth";
import { getMagisterEnv } from "./lib/env";
import { migrateLegacyUltimateDirs } from "./lib/magister-migration";
import { ensureDefaultAgentProfiles } from "./services/agent-profile-service";
import { resolveAgentForRole } from "./services/agent-resolution-service";
import { startArtifactRetentionLoop, stopArtifactRetentionLoop } from "./services/artifact-retention-service";
import { seedBuiltinSkills } from "./services/builtin-skills-bootstrap";
import { probeCliVersions } from "./services/cli-bridge/cli-version-probe";
import { recoverStaleTasks } from "./services/crash-recovery-service";
import { startAgingSweeperLoop } from "./services/memory/memory-aging-sweeper";
import { cleanupTmpFiles } from "./services/memory/memory-fs-service";
import { initMemoryRuntime } from "./services/memory/memory-runtime";
import { materializePendingChangeReviewDrafts } from "./services/safe-apply/change-review-state-service";
import { startRuntimeRecoveryLoop, stopRuntimeRecoveryLoop } from "./services/runtime-recovery-service";
import { startRuntimeWorkspaceCleanupLoop, stopRuntimeWorkspaceCleanupLoop } from "./services/runtime-workspace-service";
import { startScheduledTaskLoop, stopScheduledTaskLoop } from "./services/scheduled-task-service";
import { startSentinelLoop, stopSentinelLoop } from "./services/sentinel-service";
import { startTaskRetentionLoop, stopTaskRetentionLoop } from "./services/task-retention-service";
import { acquireProcessLock } from "./utils/process-lock";
import { runGracefulShutdown } from "./utils/graceful-shutdown";

const port = Number(process.env.PORT ?? 3700);
const host = process.env.HOST ?? "127.0.0.1";
const memoryUserHome = getMagisterEnv("MAGISTER_MEMORY_USER_DIR") ?? homedir();

migrateLegacyUltimateDirs({
  projectDir: process.cwd(),
  userHomeDir: memoryUserHome,
});

const lockPath =
  getMagisterEnv("MAGISTER_API_LOCK_PATH", process.env, console.warn, "MAGISTER_API_LOCK_PATH")?.trim()
  || join(process.cwd(), ".magister", "api-server.lock");

const app = buildApp();
await ensureDefaultAgentProfiles();
// Seed bundled Magister skills from repo into the canonical pool. Must
// run before any leader runtime spawns and reads agent_skills.
await seedBuiltinSkills().catch((err) =>
  console.warn("[startup] Builtin skill seed failed:", err instanceof Error ? err.message : String(err)),
);
// Probe CLI versions at startup — soft-fail; a missing CLI is not a blocker.
await probeCliVersions().catch((err) => console.warn("[startup] CLI version probe failed:", err instanceof Error ? err.message : String(err)));
await materializePendingChangeReviewDrafts({ limit: 500 }).catch((err) =>
  console.warn("[startup] Safe Apply change review backfill failed:", err instanceof Error ? err.message : String(err)),
);

try {
  const agentConfig = await resolveAgentForRole("leader");
  if (agentConfig) {
    console.log(
      `[startup] Leader agent: ${agentConfig.agent.label} (${agentConfig.runtimeType}, model=${agentConfig.modelName})`,
    );
  } else {
    // The builtin leader profile may carry no model (chat resolves through
    // config roleRouting instead). Before warning, check the roleRouting
    // fallback the chat intake actually uses — only warn if THAT is empty.
    const { readExecutorConfigFile } = await import("./services/executor-config-service");
    const { resolveApiConfigFromRoleRouting } = await import("./services/process-task-intent-service");
    const routed = resolveApiConfigFromRoleRouting(await readExecutorConfigFile());
    if (routed) {
      console.log(`[startup] Leader via role routing: model=${routed.model.modelName}`);
    } else {
      console.warn(
        "[startup] WARNING: No leader model configured (neither an agent profile nor config roleRouting.leader resolves). Set a provider key + leader model in Settings, or copy config/executors.example.json → config/executors.json. Chat will not work until then.",
      );
    }
  }
} catch (err) {
  console.warn("[startup] Failed to resolve leader agent:", err instanceof Error ? err.message : String(err));
}
const lock = await acquireProcessLock(lockPath);

// Crash recovery runs only AFTER the process lock is held. Otherwise a
// second instance racing startup would read the same EXECUTING tasks and
// requeue/resume them from the same checkpoint before losing the lock
// contest — a double-run. The lock is the mutual-exclusion guarantee, so
// recovery (which enqueues + starts resuming) must come after it.
const recovery = await recoverStaleTasks();
if (recovery.failed > 0) {
  console.log(
    `[startup] Crash recovery: ${recovery.failed} stale tasks marked FAILED (${recovery.recovered} had checkpoints)`,
  );
}

// Memory runtime — must init after acquireProcessLock so a second
// instance that loses the lock contest never runs cleanup/sweep.
const userMemoryRoot = join(
  memoryUserHome,
  ".magister",
  "memory",
);
const projectMemoryRoot = join(process.cwd(), ".magister", "memory");
initMemoryRuntime({ userScopeRoot: userMemoryRoot, projectScopeRoot: projectMemoryRoot });
await cleanupTmpFiles().catch((err) =>
  console.warn("[startup] Memory tmp cleanup failed:", err instanceof Error ? err.message : String(err)),
);
const memorySweeper = startAgingSweeperLoop();

// Startup reconciliation: revert any change_reviews stuck in
// apply_state='applying' beyond the lock TTL (10 min). A process crash
// mid-apply would otherwise leave the row pinned forever.
void (async () => {
  try {
    const { reconcileOrphanApplyingReviews } = await import(
      "./services/safe-apply/leader-apply-service"
    );
    const res = await reconcileOrphanApplyingReviews();
    if (res.reverted > 0) {
      console.log(
        "[startup] Reverted %d orphan applying change_reviews",
        res.reverted,
      );
    }
  } catch (err) {
    console.warn(
      "[startup] Orphan apply reconcile failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
})();
// Startup reconciliation (F14): reclaim leader safe-apply worktrees left
// under `.worktrees/` by a crashed previous process. Safe here because the
// process lock is held (no other instance of this checkout is alive) and
// the in-memory worktree map is empty (this process owns none of them).
void (async () => {
  try {
    const { reconcileOrphanWorktrees } = await import("./services/worktree-service");
    const res = reconcileOrphanWorktrees(process.cwd());
    if (res.removed.length > 0) {
      console.log(
        "[startup] Reclaimed %d orphan worktree(s): %s",
        res.removed.length,
        res.removed.join(", "),
      );
    }
  } catch (err) {
    console.warn(
      "[startup] Orphan worktree reconcile failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
})();
// Seed the FTS5 search index from on-disk memory files. Idempotent
// (skips if the table already has rows). Fire-and-forget; missed
// searches between boot and seed-done gracefully return empty.
void (async () => {
  try {
    const { backfillSearchIndex } = await import(
      "./services/memory/memory-search-service"
    );
    const res = await backfillSearchIndex();
    if (!res.alreadyPopulated) {
      console.log(
        "[startup] Memory search backfill: %d scanned, %d inserted",
        res.scanned,
        res.inserted,
      );
    }
  } catch (err) {
    console.warn(
      "[startup] Memory search backfill failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
})();
console.log("[startup] Memory runtime initialised (user=%s, project=%s)", userMemoryRoot, projectMemoryRoot);

app.addHook("onClose", async () => {
  await memorySweeper.stop();
  // Flush any pending debounced index rebuild so _index.md +
  // _refs.json reflect the final state at shutdown. Without this,
  // a recent upsert's rebuild could be lost mid-debounce.
  try {
    const { flushIndexRebuild } = await import("./services/memory/memory-index-service");
    await flushIndexRebuild();
  } catch {
    // best-effort
  }
  await stopArtifactRetentionLoop();
  await stopRuntimeRecoveryLoop();
  await stopRuntimeWorkspaceCleanupLoop();
  await stopTaskRetentionLoop();
  await stopScheduledTaskLoop();
  await stopSentinelLoop();
  await stopFeishuWebSocketGateway();
  await stopSlackSocketGateway();
  await lock.release();
});

// `bun --watch` (and Ctrl-C) sends SIGTERM/SIGINT to restart on file
// changes. Without an explicit handler the lock stays on disk and the
// next instance fails with "Process lock already held" — a recurring
// dev paper-cut that left commits dormant after the user expected
// auto-reload to pick them up. Release the lock on the signal path so
// the next process can acquire cleanly. `app.close()` triggers the
// onClose hook which itself calls `lock.release()`; the explicit
// release below is a belt-and-suspenders for the case where close
// throws before the hook runs.
let signalHandled = false;
async function handleShutdownSignal(): Promise<void> {
  if (signalHandled) return;
  signalHandled = true;
  // Bounded shutdown: `app.close()` waits for SSE long-connections that
  // never drain, so race it against a timeout — otherwise the process
  // ignores SIGTERM until restart.sh SIGKILLs it. See graceful-shutdown.ts.
  const exitCode = await runGracefulShutdown({
    closeApp: () => app.close(),
    releaseLock: () => lock.release(),
  });
  process.exit(exitCode);
}
process.once("SIGINT", () => void handleShutdownSignal());
process.once("SIGTERM", () => void handleShutdownSignal());

assertBindSafe(host, hasApiToken());

try {
  await app.listen({
    port,
    host,
  });
} catch (error) {
  await lock.release();
  throw error;
}

await startFeishuWebSocketGateway();
await startSlackSocketGateway();
await startRuntimeRecoveryLoop();
await startArtifactRetentionLoop();
await startRuntimeWorkspaceCleanupLoop();
await startTaskRetentionLoop();
await startScheduledTaskLoop();
await startSentinelLoop();

// Feishu outbound — registers approval lifecycle hooks so creating
// a dangerous-command approval also pushes a card to the bound
// feishu chat. Pure subscription; no-op when feishu env isn't set.
const { registerFeishuRouter } = await import(
  "./services/feishu/feishu-router"
);
registerFeishuRouter();

// Slack outbound — approval Block Kit cards on the same approval
// lifecycle hook. No-op when Slack tokens aren't configured.
const { registerSlackRouter } = await import(
  "./services/slack/slack-router"
);
registerSlackRouter();

// Feishu chat-session TTL sweeper — closes sessions that never received
// a terminal event (process crash mid-run, gateway disconnect, etc.).
// Without this, dead sessions linger in the registry until the process
// dies. Runs every 60s; sessions older than 30 min get auto-closed.
const { feishuChatSessionRegistry } = await import(
  "./services/feishu/feishu-chat-session"
);
setInterval(() => {
  void feishuChatSessionRegistry.sweep().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(
      "[feishu-session] sweep failed:",
      err instanceof Error ? err.message : err,
    );
  });
}, 60_000);

// Feishu outbound delivery lease reaper — releases claimed locks whose
// holder crashed before finalizing (state='claimed', expired lease).
// Without this, a process crash during delivery leaves the lock stuck
// forever and the outbound message is silently lost. Runs every 2 min;
// the reaper only touches rows whose lease has already elapsed so it
// never races with a live in-flight delivery.
{
  const {
    ChannelOutboundDeliveryClaimRepository,
    OUTBOUND_CLAIM_REAPER_INTERVAL_MS,
  } = await import("./repositories/channel-outbound-delivery-claim-repository");
  const outboundClaimRepo = new ChannelOutboundDeliveryClaimRepository();
  setInterval(() => {
    void outboundClaimRepo.reapExpiredClaims(Date.now()).then((count) => {
      if (count > 0) {
        // eslint-disable-next-line no-console
        console.log(`[outbound-claim-reaper] reaped ${count} expired claim(s)`);
      }
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[outbound-claim-reaper] reap failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, OUTBOUND_CLAIM_REAPER_INTERVAL_MS);
}

console.log(`API listening on http://${host}:${port}`);
