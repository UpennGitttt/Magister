import { ApprovalRepository } from "../repositories/approval-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { getMcpPool } from "./mcp-pool-service";

/**
 * Proactive risk sentinel — patrol worker that collects team-progress
 * signals (stalled runtimes, overdue approvals, risk events, external
 * MCP checks) and records each as a `sentinel.signal` execution event.
 * The daily digest tick (digest-service.ts) aggregates these events.
 *
 * Spec: docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md
 * Loop shape mirrors scheduled-task-service.ts. Off by default
 * (MAGISTER_SENTINEL_ENABLED=true to enable). Every source is
 * best-effort: a failing source logs and never aborts the tick.
 */

const DEFAULT_SENTINEL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALL_MS = 30 * 60 * 1000;
const DEFAULT_APPROVAL_OVERDUE_MS = 30 * 60 * 1000;

const RISK_EVENT_TYPES = [
  "leader.doom_loop_detected",
  "goal.budget_exhausted",
] as const;

export const SENTINEL_SIGNAL_EVENT_TYPE = "sentinel.signal";

export type SentinelSignalType =
  | "stalled_runtime"
  | "approval_overdue"
  | "risk_event"
  | "mcp_check";

export interface SentinelSignalPayload {
  signalType: SentinelSignalType;
  /** Stable reference to the underlying object (runtime id, approval id, PR url…). */
  ref: string;
  summary: string;
  /** Dedup key: same fingerprint is recorded at most once per day. */
  fingerprint: string;
  /** Raw source detail (MCP tool result text, event payload…), for the digest LLM. */
  detail?: unknown;
}

interface McpCheckConfig {
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
  label?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMcpChecks(raw: string | undefined): McpCheckConfig[] {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is McpCheckConfig =>
        typeof c === "object" && c !== null &&
        typeof (c as McpCheckConfig).serverId === "string" &&
        typeof (c as McpCheckConfig).toolName === "string",
    );
  } catch {
    console.warn("[sentinel] MAGISTER_SENTINEL_MCP_CHECKS is not valid JSON; ignoring");
    return [];
  }
}

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildEventId(): string {
  return `event_sentinel_${crypto.randomUUID()}`;
}

export interface SentinelTickDependencies {
  eventRepository?: ExecutionEventRepository;
  roleRuntimeRepository?: RoleRuntimeRepository;
  approvalRepository?: ApprovalRepository;
  /** Injectable for tests; defaults to the shared MCP pool. */
  mcpDispatch?: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content?: unknown }>;
}

export interface SentinelTickResult {
  recorded: number;
  deduped: number;
}

/**
 * One patrol pass: collect signals from every source, dedup against
 * today's already-recorded fingerprints, record the rest. Pure enough
 * to be called directly from tests with a seeded DB.
 */
export async function runSentinelTick(
  now: Date,
  dependencies: SentinelTickDependencies = {},
): Promise<SentinelTickResult> {
  const eventRepo = dependencies.eventRepository ?? new ExecutionEventRepository();
  const runtimeRepo = dependencies.roleRuntimeRepository ?? new RoleRuntimeRepository();
  const approvalRepo = dependencies.approvalRepository ?? new ApprovalRepository();
  const mcpDispatch =
    dependencies.mcpDispatch ??
    ((serverId: string, toolName: string, args: Record<string, unknown>) =>
      getMcpPool().dispatch(serverId, toolName, args));

  const stallMs = parsePositiveInt(process.env.MAGISTER_SENTINEL_STALL_MS, DEFAULT_STALL_MS);
  const approvalOverdueMs = parsePositiveInt(
    process.env.MAGISTER_SENTINEL_APPROVAL_OVERDUE_MS,
    DEFAULT_APPROVAL_OVERDUE_MS,
  );

  const signals: SentinelSignalPayload[] = [];

  // Source 1 — stalled runtimes (same staleness signal runtime-recovery uses).
  try {
    const runtimes = await runtimeRepo.listAll();
    for (const runtime of runtimes) {
      if (runtime.state !== "RUNNING") continue;
      const idleMs = now.getTime() - runtime.updatedAt.getTime();
      if (idleMs < stallMs) continue;
      signals.push({
        signalType: "stalled_runtime",
        ref: runtime.id,
        summary: `Runtime ${runtime.id} (role ${runtime.roleId}, task ${runtime.taskId}) has been RUNNING with no update for ${Math.round(idleMs / 60_000)} min`,
        fingerprint: `stalled_runtime:${runtime.id}`,
      });
    }
  } catch (err) {
    console.warn(`[sentinel] stalled-runtime scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 2 — overdue approvals.
  try {
    const overdue = await approvalRepo.listExpired(now.getTime() - approvalOverdueMs);
    for (const approval of overdue) {
      signals.push({
        signalType: "approval_overdue",
        ref: approval.id,
        summary: `Approval ${approval.id} (task ${approval.taskId}) pending since ${approval.requestedAt.toISOString()}`,
        fingerprint: `approval_overdue:${approval.id}`,
      });
    }
  } catch (err) {
    console.warn(`[sentinel] approval scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 3 — risk events emitted since start of day (doom loop, budget).
  try {
    const riskEvents = await eventRepo.listByTypesSince([...RISK_EVENT_TYPES], startOfDay(now));
    for (const event of riskEvents) {
      signals.push({
        signalType: "risk_event",
        ref: event.id,
        summary: `${event.type} on task ${event.taskId ?? "unknown"}`,
        fingerprint: `risk_event:${event.id}`,
      });
    }
  } catch (err) {
    console.warn(`[sentinel] risk-event scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Source 4 — external MCP checks (read-only; untrusted servers are
  // rejected by the pool because we pass no task ctx — fail-safe by design).
  const checks = parseMcpChecks(process.env.MAGISTER_SENTINEL_MCP_CHECKS);
  for (const check of checks) {
    try {
      const result = await mcpDispatch(check.serverId, check.toolName, check.args ?? {});
      if (result.isError) {
        console.warn(`[sentinel] MCP check ${check.serverId}.${check.toolName} refused/errored; skipping`);
        continue;
      }
      const label = check.label ?? `${check.serverId}.${check.toolName}`;
      signals.push({
        signalType: "mcp_check",
        ref: label,
        summary: `MCP check ${label}`,
        // Date-scoped so external state is re-sampled each day.
        fingerprint: `mcp_check:${label}:${now.toISOString().slice(0, 10)}`,
        detail: result.content,
      });
    } catch (err) {
      console.warn(`[sentinel] MCP check ${check.serverId}.${check.toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dedup against today's recorded fingerprints, then record.
  let recorded = 0;
  let deduped = 0;
  try {
    const todays = await eventRepo.listByTypesSince([SENTINEL_SIGNAL_EVENT_TYPE], startOfDay(now));
    const seen = new Set<string>();
    for (const event of todays) {
      try {
        const payload = JSON.parse(event.payloadJson ?? "{}") as Partial<SentinelSignalPayload>;
        if (typeof payload.fingerprint === "string") seen.add(payload.fingerprint);
      } catch {
        // ignore unparseable historical payloads
      }
    }

    for (const signal of signals) {
      if (seen.has(signal.fingerprint)) {
        deduped += 1;
        continue;
      }
      seen.add(signal.fingerprint);
      await eventRepo.create({
        id: buildEventId(),
        type: SENTINEL_SIGNAL_EVENT_TYPE,
        severity: "warn",
        occurredAt: now,
        payloadJson: JSON.stringify(signal),
      });
      recorded += 1;
    }
  } catch (err) {
    console.warn(`[sentinel] signal recording failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { recorded, deduped };
}

// ──────────────────────────────────────────────────────────────────────
// Periodic loop (same shape as startScheduledTaskLoop)
// ──────────────────────────────────────────────────────────────────────

let sentinelLoopTimer: ReturnType<typeof setInterval> | null = null;
let sentinelLoopInFlight = false;

/** Off by default; enable with MAGISTER_SENTINEL_ENABLED=true. */
export async function startSentinelLoop() {
  const enabled = (process.env.MAGISTER_SENTINEL_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled || sentinelLoopTimer) return;

  const intervalMs = parsePositiveInt(
    process.env.MAGISTER_SENTINEL_INTERVAL_MS,
    DEFAULT_SENTINEL_INTERVAL_MS,
  );

  const tick = async () => {
    if (sentinelLoopInFlight) return;
    sentinelLoopInFlight = true;
    try {
      await runSentinelTick(new Date());
    } catch (err) {
      console.warn(`[sentinel] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sentinelLoopInFlight = false;
    }
  };

  await tick();
  sentinelLoopTimer = setInterval(() => { void tick(); }, intervalMs);
}

export async function stopSentinelLoop() {
  if (!sentinelLoopTimer) return;
  clearInterval(sentinelLoopTimer);
  sentinelLoopTimer = null;
}
