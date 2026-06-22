import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { agentProfiles, createDb, eq } from "@magister/db";

const tempRoot = join(process.cwd(), ".tmp-agent-heartbeat-test");

function buildDbPath() {
  return join(
    tempRoot,
    `agent-heartbeat-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
}

async function seedAgent(input: {
  roleId: string;
  status: string;
  lastHeartbeatAt?: number | null;
}) {
  const db = createDb();
  const now = new Date();

  await db.insert(agentProfiles).values({
    roleId: input.roleId,
    label: input.roleId,
    displayName: input.roleId,
    status: input.status,
    ...(typeof input.lastHeartbeatAt === "number" ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = buildDbPath();
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("updateAgentStatus changes status in DB", async () => {
  const { updateAgentStatus } = await import("../../src/services/agent-heartbeat-service");

  await seedAgent({ roleId: "leader", status: "idle" });
  await updateAgentStatus("leader", "working");

  const db = createDb();
  const agent = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, "leader"),
  });

  expect(agent).not.toBeNull();
  expect(agent?.status).toBe("working");
});

test("recordHeartbeat updates lastHeartbeatAt", async () => {
  const { recordHeartbeat } = await import("../../src/services/agent-heartbeat-service");

  await seedAgent({ roleId: "leader", status: "working" });
  const before = Date.now();

  await recordHeartbeat("leader");

  const after = Date.now();
  const db = createDb();
  const agent = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, "leader"),
  });

  expect(agent).not.toBeNull();
  expect(typeof agent?.lastHeartbeatAt).toBe("number");
  expect((agent?.lastHeartbeatAt ?? 0)).toBeGreaterThanOrEqual(before);
  expect((agent?.lastHeartbeatAt ?? 0)).toBeLessThanOrEqual(after);
});

test("isAgentStale returns true when heartbeat older than threshold", async () => {
  const { isAgentStale, STALE_THRESHOLD_MS } = await import("../../src/services/agent-heartbeat-service");

  await seedAgent({
    roleId: "leader",
    status: "working",
    lastHeartbeatAt: Date.now() - STALE_THRESHOLD_MS - 1,
  });

  const stale = await isAgentStale("leader");
  expect(stale).toBe(true);
});

test("isAgentStale returns false for recent heartbeat", async () => {
  const { isAgentStale, STALE_THRESHOLD_MS } = await import("../../src/services/agent-heartbeat-service");

  await seedAgent({
    roleId: "leader",
    status: "working",
    lastHeartbeatAt: Date.now() - Math.floor(STALE_THRESHOLD_MS / 2),
  });

  const stale = await isAgentStale("leader");
  expect(stale).toBe(false);
});

test("recordRoleHeartbeat writes in-memory snapshot retrievable via getRoleHeartbeatsSnapshot", async () => {
  const mod = await import("../../src/services/agent-heartbeat-service");
  mod.__resetRoleHeartbeatsForTest();

  expect(mod.getRoleHeartbeat("coder")).toBeNull();
  mod.recordRoleHeartbeat("coder");
  expect(typeof mod.getRoleHeartbeat("coder")).toBe("number");

  // Whitespace + casing tolerated by normalizeRoleId
  mod.recordRoleHeartbeat("  Reviewer ", 1_000);
  const snapshot = mod.getRoleHeartbeatsSnapshot();
  expect(snapshot.get("Reviewer")).toBe(1_000);
  expect(snapshot.get("coder")).toBeGreaterThan(0);

  // Returned map must be a defensive copy — mutating it should not
  // leak back into the service's internal state.
  snapshot.delete("coder");
  expect(mod.getRoleHeartbeat("coder")).not.toBeNull();
});

test("recordHeartbeat also bumps the in-memory snapshot", async () => {
  const mod = await import("../../src/services/agent-heartbeat-service");
  mod.__resetRoleHeartbeatsForTest();

  await seedAgent({ roleId: "lander", status: "idle" });
  const before = Date.now();
  await mod.recordHeartbeat("lander");
  const after = Date.now();

  const seen = mod.getRoleHeartbeat("lander");
  expect(typeof seen).toBe("number");
  expect(seen).toBeGreaterThanOrEqual(before);
  expect(seen).toBeLessThanOrEqual(after);
});

test("acquireAgentStatus bumps the in-memory heartbeat for the role", async () => {
  const mod = await import("../../src/services/agent-heartbeat-service");
  mod.__resetRoleHeartbeatsForTest();

  await seedAgent({ roleId: "architect", status: "idle" });
  expect(mod.getRoleHeartbeat("architect")).toBeNull();
  await mod.acquireAgentStatus("architect", "run-xyz", "working");

  expect(typeof mod.getRoleHeartbeat("architect")).toBe("number");

  await mod.releaseAgentStatus("architect", "run-xyz");
});

test("getRoleHeartbeatsSnapshot expires nothing automatically — caller computes staleness", async () => {
  // Per the design comment in the service, the in-memory map is a
  // simple last-seen tracker; the expiration policy (live vs idle
  // vs offline) lives at the caller / route level.
  const mod = await import("../../src/services/agent-heartbeat-service");
  mod.__resetRoleHeartbeatsForTest();

  const ancient = Date.now() - 10 * 60 * 1000;
  mod.recordRoleHeartbeat("evaluator", ancient);
  expect(mod.getRoleHeartbeat("evaluator")).toBe(ancient);

  // Threshold + staleness check is left to consumers.
  expect(Date.now() - (mod.getRoleHeartbeat("evaluator") ?? 0)).toBeGreaterThan(mod.STALE_THRESHOLD_MS);
});

test("getAgentStatuses returns all agents with status", async () => {
  const { getAgentStatuses } = await import("../../src/services/agent-heartbeat-service");

  await seedAgent({
    roleId: "leader",
    status: "idle",
    lastHeartbeatAt: 111,
  });

  await seedAgent({
    roleId: "coder",
    status: "working",
    lastHeartbeatAt: 222,
  });

  const statuses = await getAgentStatuses();
  const byRoleId = [...statuses].sort((a, b) => a.roleId.localeCompare(b.roleId));

  expect(byRoleId).toEqual([
    expect.objectContaining({
      roleId: "coder",
      status: "working",
      lastHeartbeatAt: 222,
    }),
    expect.objectContaining({
      roleId: "leader",
      status: "idle",
      lastHeartbeatAt: 111,
    }),
  ]);
});
