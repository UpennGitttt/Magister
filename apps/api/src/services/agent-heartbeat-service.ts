import { agentProfiles, createDb } from "@magister/db";
import { eq } from "@magister/db";

export const STALE_THRESHOLD_MS = 2 * 60 * 1000;

export type AgentLifecycleStatus = "idle" | "working" | "blocked" | "error" | "offline";

export type AgentStatusSnapshot = {
  roleId: string;
  label: string | null;
  status: string | null;
  lastHeartbeatAt: number | null;
  modelName: string | null;
  runtimeType: string | null;
};

function normalizeRoleId(roleId: string): string {
  return roleId.trim();
}

export async function updateAgentStatus(roleId: string, status: AgentLifecycleStatus): Promise<void> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    return;
  }

  const db = createDb();
  await db.update(agentProfiles)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentProfiles.roleId, normalizedRoleId));
}

// ───────────────────────────────────────────────────────────────────
// Multi-runtime status
// ───────────────────────────────────────────────────────────────────
//
// `agent_profiles.status` is keyed by role_id — one row per role, not
// per runtime. With the concurrent TaskWorker, multiple leader runtimes
// can be active in parallel, all sharing the "leader" row. The naive
// "set working at turn start, set idle at turn end" pattern races:
// runtime A's idle write would overwrite runtime B's still-working
// status.
//
// Fix: reference-count active runIds per role IN MEMORY. Status writes
// to the DB only happen when:
//   - acquire: bump count; if it goes 0→1, write `status` (typically
//     "working") to DB. Subsequent acquires for the same role are
//     no-ops on the DB side.
//   - release: drop count; if it goes 1→0, write the terminal status
//     (typically "idle") to DB. Intermediate releases are no-ops.
//
// On API restart the counts reset to 0 — crash recovery's stale-task
// pass already updates the DB state to match, so the in-memory miss
// is self-healing.

const activeRunIdsByRole = new Map<string, Set<string>>();

/**
 * Mark a role active for a specific runId. The first acquire for a
 * role writes the working-state to the DB; subsequent acquires are
 * memory-only. Callers that want a different "working" label (e.g.
 * "blocked") can pass it as `status` — the first acquire wins.
 */
export async function acquireAgentStatus(
  roleId: string,
  runId: string,
  status: AgentLifecycleStatus = "working",
): Promise<void> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId || !runId) return;
  // Every acquire is also a heartbeat — the role just became active.
  // Persist to DB (not just in-memory) so non-leader roles' last-run
  // history survives API restarts. Pre-fix, the teammate spawn path
  // only bumped the in-memory map here, and the per-turn DB write in
  // autonomous-loop-service is gated to runIds starting with
  // "rt_leader_" — so teammate roles' `lastHeartbeatAt` stayed NULL
  // forever, and the dashboard showed "never run" for them after any
  // restart.
  await recordHeartbeat(normalizedRoleId);
  const existing = activeRunIdsByRole.get(normalizedRoleId);
  if (existing) {
    existing.add(runId);
    return; // already-active role → DB write would be redundant
  }
  const set = new Set<string>([runId]);
  activeRunIdsByRole.set(normalizedRoleId, set);
  await updateAgentStatus(normalizedRoleId, status);
}

/**
 * Release a runId for a role. When the last runId for a role
 * releases, write the terminal status (default "idle") to the DB.
 * Releasing an unknown (roleId, runId) is a noop — keeps the
 * function safe to call defensively in `finally` blocks.
 */
export async function releaseAgentStatus(
  roleId: string,
  runId: string,
  terminalStatus: AgentLifecycleStatus = "idle",
): Promise<void> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId || !runId) return;
  const set = activeRunIdsByRole.get(normalizedRoleId);
  if (!set) return;
  set.delete(runId);
  if (set.size === 0) {
    activeRunIdsByRole.delete(normalizedRoleId);
    await updateAgentStatus(normalizedRoleId, terminalStatus);
  }
}

/**
 * How many runs are currently holding `roleId` active. Used by
 * /system/status for the agent panel and by tests.
 */
export function activeRunCount(roleId: string): number {
  return activeRunIdsByRole.get(normalizeRoleId(roleId))?.size ?? 0;
}

export async function recordHeartbeat(roleId: string): Promise<void> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    return;
  }

  recordRoleHeartbeat(normalizedRoleId);

  const db = createDb();
  await db.update(agentProfiles)
    .set({ lastHeartbeatAt: Date.now(), updatedAt: new Date() })
    .where(eq(agentProfiles.roleId, normalizedRoleId));
}

// ───────────────────────────────────────────────────────────────────
// In-memory per-role heartbeat
// ───────────────────────────────────────────────────────────────────
//
// `recordHeartbeat` above persists to the DB and is called once per
// leader-loop turn. That's the right cadence for crash recovery and
// stale-task sweeps, but it's overkill for the dashboard's `LIVE · Xs`
// indicator which wants updates whenever ANY agent (leader / teammate /
// CLI runtime) is touched.
//
// `recordRoleHeartbeat` is the cheap in-memory hook: callers in the
// teammate spawn path and CLI agent spawn path bump the role's last-
// seen timestamp without paying a DB round-trip. The dashboard polls
// `/agents/heartbeats` every 5s; the in-memory map is the freshest
// signal, with the DB-persisted `lastHeartbeatAt` as fallback for
// processes that haven't been touched since boot.
//
// On API restart the map empties. That's fine — the DB-persisted
// `agent_profiles.lastHeartbeatAt` carries the last known signal and
// the panel will show "idle" / time-since for those roles until they
// run again.

const roleHeartbeats = new Map<string, number>();

export function recordRoleHeartbeat(roleId: string, at: number = Date.now()): void {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) return;
  roleHeartbeats.set(normalizedRoleId, at);
}

export function getRoleHeartbeat(roleId: string): number | null {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) return null;
  return roleHeartbeats.get(normalizedRoleId) ?? null;
}

export function getRoleHeartbeatsSnapshot(): Map<string, number> {
  return new Map(roleHeartbeats);
}

/** Test-only. Clears the in-memory map between test cases. */
export function __resetRoleHeartbeatsForTest(): void {
  roleHeartbeats.clear();
}

export async function isAgentStale(roleId: string): Promise<boolean> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    return false;
  }

  const db = createDb();
  const profile = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, normalizedRoleId),
    columns: {
      lastHeartbeatAt: true,
    },
  });

  if (!profile || typeof profile.lastHeartbeatAt !== "number") {
    return false;
  }

  return Date.now() - profile.lastHeartbeatAt > STALE_THRESHOLD_MS;
}

export async function getAgentStatuses(): Promise<AgentStatusSnapshot[]> {
  const db = createDb();
  const profiles = await db.query.agentProfiles.findMany({
    columns: {
      roleId: true,
      label: true,
      status: true,
      lastHeartbeatAt: true,
      modelName: true,
      modelOverride: true,
      runtimeType: true,
    },
  });

  return profiles.map((profile) => ({
    roleId: profile.roleId,
    label: profile.label ?? null,
    status: profile.status ?? null,
    lastHeartbeatAt: typeof profile.lastHeartbeatAt === "number" ? profile.lastHeartbeatAt : null,
    modelName: profile.modelName ?? profile.modelOverride ?? null,
    runtimeType: profile.runtimeType ?? null,
  }));
}
