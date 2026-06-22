import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../components/layout/PageHeader";
import { Skeleton } from "../components/ui/Skeleton";
import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { getSystemStatus } from "../lib/api";
import { getModSymbol } from "../lib/platform";
import { request } from "../lib/request";
import type { SystemStatus, TaskSummary } from "../lib/types";
import "../styles/dashboard.css";

// Single source of truth for the polling intervals. The panel-heading
// meta strings render these values directly so the displayed "refreshes
// 5s" never lies about the actual refresh cadence.
const DASHBOARD_REFRESH_MS = 30_000;
const HEARTBEAT_POLL_MS = 5_000;
const TASK_FETCH_LIMIT = 10;

type AgentStatusItem = {
  roleId: string;
  status: string | null;
  lastHeartbeatAt: number | null;
  [key: string]: unknown;
};

type AgentHeartbeatItem = {
  roleId: string;
  label: string | null;
  lastSeenAt: number | null;
  secondsAgo: number | null;
  isLive: boolean;
};

const HEARTBEAT_LIVE_THRESHOLD_MS = 120_000;

type LiveIndicator =
  | { kind: "live"; secondsAgo: number }
  | { kind: "idle"; lastSeenAt: number }
  | { kind: "never" };

type AgentPoolTone = "live" | "ready" | "stale" | "blocked" | "error" | "config";

type AgentPoolCardState = {
  label: string;
  tone: AgentPoolTone;
  modelLabel: string;
  footer: string;
  title: string;
};

type SystemHealthSummary = {
  tone: "ok" | "warn" | "crit";
  label: string;
  pill: string;
  sub: string;
};

const WORKER_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

function parseEpochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function deriveSystemHealth({
  systemStatus,
  dashboardError,
  nowTick,
}: {
  systemStatus: SystemStatus | null;
  dashboardError: string | null;
  nowTick: number;
}): SystemHealthSummary {
  // Dashboard couldn't even reach /system/status — that's the only
  // input we have, so we report unknown rather than guessing OK.
  if (!systemStatus) {
    return {
      tone: dashboardError ? "crit" : "warn",
      label: dashboardError ? "Offline" : "Unknown",
      pill: dashboardError ? "ERR" : "—",
      sub: dashboardError ? "API unreachable — check API process" : "Loading…",
    };
  }

  const retention = systemStatus.workers.artifactRetention;
  const recovery = systemStatus.workers.runtimeRecovery;
  const taskWorker = systemStatus.workers.taskWorker;
  const feishu = systemStatus.integrations?.feishuGateway;

  // Real degradations — these lower the health pill.
  const issues: string[] = [];
  // Informational notices — show in the sub-line, but DON'T lower the
  // pill. A worker the operator intentionally disabled (e.g. retention
  // off-by-default) is not a system failure.
  const notices: string[] = [];
  let tone: SystemHealthSummary["tone"] = "ok";

  if (!retention.enabled) notices.push("retention off");
  if (!recovery.enabled) notices.push("recovery off");
  if (feishu?.disabled) notices.push("feishu disabled");
  else if (feishu && !feishu.configured) notices.push("feishu not configured");
  if (feishu?.configured && feishu.connectionState === "error") {
    issues.push("feishu error");
    tone = "crit";
  }

  // Stale ticks ONLY count as real issues if the worker is supposed
  // to be running (enabled). A disabled worker has no `lastTickAt`
  // anyway, so the check is implicitly a no-op there.
  const retentionAge = parseEpochMs(retention.lastTickAt);
  const recoveryAge = parseEpochMs(recovery.lastTickAt);
  if (retention.enabled && retentionAge !== null && nowTick - retentionAge > WORKER_STALE_THRESHOLD_MS) {
    issues.push("retention stalled");
    if (tone === "ok") tone = "warn";
  }
  if (recovery.enabled && recoveryAge !== null && nowTick - recoveryAge > WORKER_STALE_THRESHOLD_MS) {
    issues.push("recovery stalled");
    if (tone === "ok") tone = "warn";
  }
  if (retention.lastFailureMessage) {
    issues.push("retention error");
    if (tone === "ok") tone = "warn";
  }
  if (dashboardError) {
    issues.push("dashboard load failed");
    if (tone !== "crit") tone = "warn";
  }

  if (issues.length) {
    return {
      tone,
      label: tone === "crit" ? "Degraded" : "Partial",
      pill: tone === "crit" ? "CRIT" : "WARN",
      sub: issues.slice(0, 2).join(" · "),
    };
  }

  // No real issues — system is Operational. Build the sub-line from
  // real signals; fall back to notices when the workers haven't run
  // (so the user still sees WHY there's no retention timestamp).
  const subBits: string[] = [];
  if (retention.enabled && retentionAge !== null) {
    subBits.push(`retention ${formatRelativeTime(retentionAge)}`);
  }
  if (recovery.enabled && recoveryAge !== null) {
    subBits.push(`recovery ${formatRelativeTime(recoveryAge)}`);
  }
  if (taskWorker) {
    subBits.push(`workers ${taskWorker.activeCount}/${taskWorker.concurrency}`);
  }
  // Append notices at the tail so the positive signals come first.
  for (const notice of notices) {
    if (subBits.length >= 2) break;
    subBits.push(notice);
  }
  const sub = subBits.length
    ? subBits.slice(0, 2).join(" · ")
    : notices.length
      ? notices.slice(0, 2).join(" · ")
      : "All workers healthy";
  return { tone: "ok", label: "Operational", pill: "OK", sub };
}

function computeLiveIndicator(
  lastSeenAt: number | null,
  now: number,
): LiveIndicator {
  if (lastSeenAt === null) return { kind: "never" };
  const ageMs = Math.max(0, now - lastSeenAt);
  if (ageMs < HEARTBEAT_LIVE_THRESHOLD_MS) {
    return { kind: "live", secondsAgo: Math.floor(ageMs / 1000) };
  }
  return { kind: "idle", lastSeenAt };
}

type PendingApproval = {
  id: string;
  taskId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  summary: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
};

type FeishuStatus = "connected" | "disconnected" | "disabled" | "unknown";

const AGENT_CHAIN = ["leader", "coder", "reviewer", "architect", "lander", "evaluator"] as const;
const AGENT_NAME_MAP: Record<string, string> = {
  manager: "Leader",
  leader: "Leader",
  coder: "Coder",
  reviewer: "Reviewer",
  evaluator: "Evaluator",
  lander: "Lander",
  architect: "Architect",
  deepresearcher: "Deep Researcher",
};

function normalizeRoleId(roleId: string | undefined): string {
  return (roleId ?? "").trim().toLowerCase();
}

function prettyRoleName(roleId: string): string {
  const normalized = normalizeRoleId(roleId);
  if (AGENT_NAME_MAP[normalized]) return AGENT_NAME_MAP[normalized];
  if (!normalized) return "Agent";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatRelativeTime(value: string | number | null | undefined): string {
  const timestamp = toMs(value);
  if (!timestamp) return "--";

  const diffMs = Math.max(0, Date.now() - timestamp);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  return `${Math.floor(month / 12)}y ago`;
}

/** Split `Xs/Ym/Zh ago` into the value and the trailing word so the
 *  status-strip can render the value big and "sec ago" / "min ago" as
 *  a smaller sub-label inline. */
function splitRelativeTime(value: string | number | null | undefined): { value: string; unit: string | null } {
  const timestamp = toMs(value);
  if (!timestamp) return { value: "--", unit: null };
  const diffMs = Math.max(0, Date.now() - timestamp);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 10) return { value: "just", unit: "now" };
  if (sec < 60) return { value: String(sec), unit: "sec ago" };
  const min = Math.floor(sec / 60);
  if (min < 60) return { value: String(min), unit: "min ago" };
  const hour = Math.floor(min / 60);
  if (hour < 24) return { value: String(hour), unit: "hr ago" };
  const day = Math.floor(hour / 24);
  if (day < 30) return { value: String(day), unit: "d ago" };
  const month = Math.floor(day / 30);
  if (month < 12) return { value: String(month), unit: "mo ago" };
  return { value: String(Math.floor(month / 12)), unit: "yr ago" };
}

type WorkQueueStateGlyph = {
  glyph: string;
  label: string;
  tone: "running" | "done" | "failed" | "queued" | "blocked" | "neutral";
};

/** Map a task.state into the mockup's glyph+label form
 *  (●/○/♦/▸/◆). The toned classes are styled in dashboard.css. */
function workQueueStateGlyph(state: string): WorkQueueStateGlyph {
  const normalized = state.trim().toLowerCase();
  if (["done", "completed", "success", "pr_open", "merge_waiting"].some((v) => normalized.includes(v))) {
    return { glyph: "○", label: "DONE", tone: "done" };
  }
  if (["failed", "error", "cancel"].some((v) => normalized.includes(v))) {
    return { glyph: "♦", label: "FAILED", tone: "failed" };
  }
  if (["blocked"].some((v) => normalized.includes(v))) {
    return { glyph: "◆", label: "BLOCKED", tone: "blocked" };
  }
  if (["queued", "pending", "intake"].some((v) => normalized.includes(v))) {
    return { glyph: "▸", label: "QUEUED", tone: "queued" };
  }
  if (
    [
      "running",
      "working",
      "in_progress",
      "executing",
      "reviewing",
      "testing",
      "clarifying",
      "planning",
      "waiting",
      "paused",
      "awaiting",
    ].some((v) => normalized.includes(v))
  ) {
    return { glyph: "●", label: "RUNNING", tone: "running" };
  }
  return { glyph: "·", label: state.toUpperCase(), tone: "neutral" };
}

function sourceLabel(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === "feishu") return "Feishu";
  if (normalized === "cli") return "CLI";
  return "Web";
}

function sourceClassName(source: string | undefined): string {
  const normalized = source?.trim().toLowerCase();
  if (normalized === "feishu") return "dashboard-source-badge dashboard-source-badge--feishu";
  if (normalized === "cli") return "dashboard-source-badge dashboard-source-badge--cli";
  return "dashboard-source-badge dashboard-source-badge--web";
}

function inferTaskAgent(_task: TaskSummary): string {
  // Most tasks are handled directly by the leader.
  // Teammate delegation is visible in the event stream, not the task record.
  return "Leader";
}

function isFailedTask(task: TaskSummary): boolean {
  const state = task.state.toLowerCase();
  return state.includes("failed") || state.includes("error");
}

function isRunningTask(task: TaskSummary): boolean {
  const state = task.state.toLowerCase();
  return (
    state.includes("running") ||
    state.includes("executing") ||
    state.includes("in_progress") ||
    state.includes("reviewing") ||
    state.includes("testing")
  );
}

function isBlockedTask(task: TaskSummary): boolean {
  const state = task.state.toLowerCase();
  return state.includes("blocked") || state.includes("waiting") || Boolean(task.latestBlocker) || Boolean(task.waitReason);
}

function resolveAgentModel(agent: AgentStatusItem): string {
  return (
    asString(agent.modelName) ||
    asString(agent.model) ||
    asString(agent.modelId) ||
    asString(agent.resolvedModel) ||
    "Model unavailable"
  );
}

function resolveAgentConfiguredModel(agent: AgentStatusItem): string | null {
  return (
    asString(agent.modelName) ||
    asString(agent.model) ||
    asString(agent.modelId) ||
    asString(agent.resolvedModel)
  );
}

function agentLastSeenTitle(lastSeenAt: number | null): string {
  return lastSeenAt ? new Date(lastSeenAt).toLocaleString() : "Never run";
}

function agentLastActiveFooter(lastSeenAt: number): string {
  return `last active ${formatRelativeTime(lastSeenAt)}`;
}

function resolveAgentPoolState(
  agent: AgentStatusItem,
  lastSeenAt: number | null,
  now: number,
): AgentPoolCardState {
  const modelLabel = resolveAgentModel(agent);
  const configuredModel = resolveAgentConfiguredModel(agent);
  const lifecycle = asString(agent.status)?.toLowerCase() ?? "";
  const indicator = computeLiveIndicator(lastSeenAt, now);
  const turnCount = typeof agent.turnCount === "number" ? agent.turnCount : null;
  const title = agentLastSeenTitle(lastSeenAt);

  if (!configuredModel) {
    return {
      label: "CONFIG",
      tone: "config",
      modelLabel,
      footer: "model unavailable",
      title: "Model unavailable",
    };
  }

  if (lifecycle === "error") {
    return {
      label: "ERROR",
      tone: "error",
      modelLabel,
      footer: indicator.kind === "never" ? "no heartbeat" : agentLastActiveFooter(lastSeenAt!),
      title,
    };
  }

  if (lifecycle === "blocked") {
    return {
      label: "BLOCKED",
      tone: "blocked",
      modelLabel,
      footer: indicator.kind === "never" ? "no heartbeat" : agentLastActiveFooter(lastSeenAt!),
      title,
    };
  }

  if (lifecycle === "offline") {
    return {
      label: "OFFLINE",
      tone: "stale",
      modelLabel,
      footer: indicator.kind === "never" ? "never run" : agentLastActiveFooter(lastSeenAt!),
      title,
    };
  }

  if (indicator.kind === "live" && lifecycle === "working") {
    return {
      label: "LIVE",
      tone: "live",
      modelLabel,
      footer: `${turnCount !== null ? `turn ${turnCount} · ` : ""}${indicator.secondsAgo}s ago`,
      title,
    };
  }

  if (indicator.kind === "idle") {
    return {
      label: "STALE",
      tone: "stale",
      modelLabel,
      footer: agentLastActiveFooter(indicator.lastSeenAt),
      title,
    };
  }

  return {
    label: "READY",
    tone: "ready",
    modelLabel,
    footer: "never run",
    title,
  };
}

function agentPoolToneClass(base: string, tone: AgentPoolTone): string {
  return `${base} ${base}--${tone}`;
}

function summarizeApproval(approval: PendingApproval): string {
  if (approval.summary?.trim()) return approval.summary.trim();
  if (approval.toolName?.trim()) return `${approval.toolName} request`;
  return "Approval required";
}

/** Trailing alphanumeric chars from a task id — e.g. `task_abcdef` → `def`.
 *  Used for the mockup's `task #abc` short identifiers in attention rows. */
function shortTaskId(id: string): string {
  const trimmed = id.replace(/[^a-z0-9]/gi, "");
  if (trimmed.length === 0) return id;
  return trimmed.slice(-3).toLowerCase();
}

function formatClockHHMM(now: number): string {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function DashboardPage() {
  // Platform-aware modifier glyph (⌘ on Mac, Ctrl elsewhere) used by
  // the inline shortcut hint in the page-header description. Stable
  // per session.
  const modSym = useMemo(() => getModSymbol(), []);
  const [agents, setAgents] = useState<AgentStatusItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>("unknown");
  // Full /system/status snapshot — drives the System Health value/sub
  // strings (replaced what was previously two literal labels) plus the
  // Feishu sub-line. Polled in lockstep with everything else in
  // loadDashboard so it doesn't burn an extra request.
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  // Per-agent heartbeats are fetched independently from the main
  // dashboard refresh (every 5s vs the 30s reload) so the LIVE
  // indicator stays fresh without re-pulling the whole dashboard.
  // `nowTick` re-renders every second so the displayed `Xs ago`
  // counter advances without re-fetching.
  const [heartbeats, setHeartbeats] = useState<AgentHeartbeatItem[]>([]);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Path A — recent-tasks panel must scope to the active workspace,
  // otherwise the dashboard surfaces tasks from other workspaces and
  // breaks the tenant-switch model. URL `:wid` wins (deeplinks);
  // picker active id is the cross-page default.
  const { wid: urlWorkspaceId } = useParams<{ wid?: string }>();
  const { activeId: pickerWorkspaceId } = useActiveWorkspace();
  const effectiveWorkspaceId = urlWorkspaceId ?? pickerWorkspaceId ?? null;

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);

    const tasksQs = effectiveWorkspaceId
      ? `?limit=${TASK_FETCH_LIMIT}&workspaceId=${encodeURIComponent(effectiveWorkspaceId)}`
      : `?limit=${TASK_FETCH_LIMIT}`;
    const [agentRes, approvalRes, taskRes, systemRes] = await Promise.allSettled([
      request<{ items?: AgentStatusItem[] }>("/settings/agents/statuses"),
      request<{ items?: PendingApproval[] }>("/approvals/pending"),
      request<{ items?: TaskSummary[] } | TaskSummary[]>(`/tasks${tasksQs}`),
      getSystemStatus(),
    ]);

    if (agentRes.status === "fulfilled") {
      setAgents(agentRes.value.items ?? []);
    } else {
      setAgents([]);
      setError((prev) => prev ?? "Failed to load agent statuses");
    }

    if (approvalRes.status === "fulfilled") {
      setApprovals(approvalRes.value.items ?? []);
    } else {
      setApprovals([]);
      setError((prev) => prev ?? "Failed to load pending approvals");
    }

    if (taskRes.status === "fulfilled") {
      const rawTasks = Array.isArray(taskRes.value) ? taskRes.value : (taskRes.value.items ?? []);
      setTasks([...rawTasks].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
    } else {
      setTasks([]);
      setError((prev) => prev ?? "Failed to load tasks");
    }

    if (systemRes.status === "fulfilled") {
      setSystemStatus(systemRes.value);
      const feishuGateway = systemRes.value.integrations?.feishuGateway;
      const connected = Boolean(feishuGateway?.running) && feishuGateway?.connectionState === "running";
      setFeishuStatus(feishuGateway?.disabled ? "disabled" : connected ? "connected" : "disconnected");
    } else {
      setSystemStatus(null);
      setFeishuStatus("unknown");
      setError((prev) => prev ?? "Failed to load system status");
    }

    setLoading(false);
  }, [effectiveWorkspaceId]);

  useEffect(() => {
    void loadDashboard();

    const timer = window.setInterval(() => {
      void loadDashboard();
    }, DASHBOARD_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [loadDashboard]);

  // Heartbeat poll: every 5s grab the freshest per-role lastSeenAt
  // from the API. Decoupled from the 30s dashboard refresh because
  // the LIVE indicator needs a much tighter freshness window.
  useEffect(() => {
    let cancelled = false;
    const fetchHeartbeats = async () => {
      try {
        const res = await request<{ items?: AgentHeartbeatItem[] }>("/agents/heartbeats");
        if (!cancelled) {
          setHeartbeats(res.items ?? []);
        }
      } catch {
        // best-effort — fall back silently to stale data
      }
    };
    void fetchHeartbeats();
    const id = window.setInterval(fetchHeartbeats, HEARTBEAT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // 1s render tick — re-evaluates the `Xs ago` counter without
  // refetching. Cheap because we only touch a single state value.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const heartbeatByRole = useMemo(() => {
    const map = new Map<string, AgentHeartbeatItem>();
    for (const item of heartbeats) {
      map.set(normalizeRoleId(item.roleId), item);
    }
    return map;
  }, [heartbeats]);

  const latestTaskActivity = useMemo(() => {
    return tasks.reduce<number | null>((latest, task) => {
      const ms = toMs(task.updatedAt);
      if (!ms) return latest;
      if (!latest || ms > latest) return ms;
      return latest;
    }, null);
  }, [tasks]);

  const streamingTask = useMemo(() => tasks.find(isRunningTask) ?? null, [tasks]);

  const poolAgents = useMemo(() => {
    const order = new Map<string, number>(AGENT_CHAIN.map((roleId, index) => [roleId, index]));
    return [...agents].sort((a, b) => {
      const roleA = normalizeRoleId(a.roleId);
      const roleB = normalizeRoleId(b.roleId);
      const orderA = order.get(roleA);
      const orderB = order.get(roleB);
      if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return roleA.localeCompare(roleB);
    });
  }, [agents]);

  const failedTasks = useMemo(() => tasks.filter(isFailedTask), [tasks]);
  const blockedTasks = useMemo(() => tasks.filter(isBlockedTask), [tasks]);

  const attentionTotal = approvals.length + failedTasks.length + blockedTasks.length;

  // Derive System Health from real /system/status signals: artifact-
  // retention worker liveness + runtime-recovery worker liveness +
  // taskWorker queue health. Tone resolves to:
  //   ok       — workers running, no recent failures, dashboard load OK
  //   warn     — at least one worker disabled or stale tick
  //   crit     — load error or feishu gateway in "error" state
  // The sub-line shows the freshest concrete signal so the user can act
  // (e.g. "retention 12m ago · workers 1/4") instead of reading
  // "Investigate logs" with no pointer.
  const healthDerived = useMemo(() => {
    return deriveSystemHealth({ systemStatus, dashboardError: error, nowTick });
  }, [systemStatus, error, nowTick]);
  const systemHealthy = healthDerived.tone === "ok";

  // Feishu sub-line: real connection mode + last started/error info
  // pulled from the gateway snapshot. Was hardcoded "Connected via
  // webhook" regardless of mode.
  const feishuSubLine = useMemo(() => {
    const gw = systemStatus?.integrations?.feishuGateway;
    if (!gw) return null;
    const mode = (gw.mode ?? "").trim();
    if (gw.disabled) return "Disabled by MAGISTER_DISABLE_CHANNELS";
    if (!gw.configured) return "Not configured";
    if (gw.connectionState === "error") {
      return gw.lastError ? `Error: ${gw.lastError}` : "Gateway error";
    }
    if (gw.connectionState === "running") {
      const since = gw.startedAt ? formatRelativeTime(gw.startedAt) : null;
      return [mode || "live", since ? `up ${since}` : null].filter(Boolean).join(" · ");
    }
    if (gw.connectionState === "starting") return `${mode || "gateway"} · starting`;
    if (gw.connectionState === "stopped") return `${mode || "gateway"} · stopped`;
    return mode || gw.connectionState || null;
  }, [systemStatus]);

  // Cell sub-line for AGENTS: comma-separated role list. CSS wraps to
  // two lines once the row overflows.
  const agentRoleLine = poolAgents
    .map((agent) => prettyRoleName(agent.roleId))
    .join(" · ");

  const agentPoolSummary = useMemo(() => {
    let seen = 0;
    let configIssues = 0;
    for (const agent of poolAgents) {
      const normalizedRole = normalizeRoleId(agent.roleId);
      const heartbeat = heartbeatByRole.get(normalizedRole);
      const lastSeenAt = heartbeat?.lastSeenAt
        ?? (typeof agent.lastHeartbeatAt === "number" ? agent.lastHeartbeatAt : null);
      if (lastSeenAt !== null) seen++;
      if (!resolveAgentConfiguredModel(agent)) configIssues++;
    }
    const parts = [
      `${poolAgents.length || 5} profiles`,
      `${seen} seen`,
      ...(configIssues > 0 ? [`${configIssues} config issue${configIssues === 1 ? "" : "s"}`] : []),
      `polls ${Math.round(HEARTBEAT_POLL_MS / 1000)}s`,
    ];
    return parts.join(" · ");
  }, [heartbeatByRole, poolAgents]);

  // Cell sub-line for APPROVALS: first 1-2 tool names joined.
  const approvalToolLine = approvals
    .slice(0, 2)
    .map((a) => a.toolName)
    .filter(Boolean)
    .join(" · ");

  const lastActivitySplit = splitRelativeTime(latestTaskActivity);
  const streamingSubLine = streamingTask
    ? `task #${shortTaskId(streamingTask.id)} streaming`
    : null;

  const clockTime = formatClockHHMM(nowTick);
  const hostLabel = typeof window !== "undefined" ? window.location.hostname || "Local" : "Local";

  return (
    <div className="page dashboard-page">
      <div className="dashboard-layout">
        {/* Keyboard shortcut chips are folded INTO the description text
            as quiet mono hints instead of floating kbd boxes on the
            right. Dashboard-first users wouldn't see the shortcuts on
            the Sessions search input / chat composer otherwise. */}
        <PageHeader
          title="Control Center"
          description={`workspace overview · ${modSym}K search · ${modSym}⏎ dispatch`}
        />

        <section className="dashboard-card dashboard-status-strip" aria-label="System status bar">
          {/* System health — fully driven by /system/status. The
              pill/label/sub come from `deriveSystemHealth()` which
              reads the artifact-retention + runtime-recovery + task-
              worker snapshots. Nothing hardcoded. */}
          <div className="dashboard-status-strip__cell">
            <div className="dashboard-status-strip__top">
              <span className="dashboard-status-strip__label">System Health</span>
              <span
                className={`dashboard-status-strip__pill${
                  healthDerived.tone === "ok"
                    ? ""
                    : healthDerived.tone === "crit"
                      ? " dashboard-status-strip__pill--red"
                      : " dashboard-status-strip__pill--warn"
                }`}
              >
                {healthDerived.pill}
              </span>
            </div>
            <div className="dashboard-status-strip__value dashboard-status-strip__value--text">
              {healthDerived.label}
            </div>
            <div className="dashboard-status-strip__sub">{healthDerived.sub}</div>
          </div>

          {/* Agents available */}
          <div className="dashboard-status-strip__cell">
            <div className="dashboard-status-strip__top">
              <span className="dashboard-status-strip__label">Agents Available</span>
            </div>
            <div className="dashboard-status-strip__value">{agents.length}</div>
            {agentRoleLine ? (
              <div className="dashboard-status-strip__sub dashboard-status-strip__sub--wrap">{agentRoleLine}</div>
            ) : null}
          </div>

          {/* Pending approvals */}
          <div className="dashboard-status-strip__cell">
            <div className="dashboard-status-strip__top">
              <span className="dashboard-status-strip__label">Pending Approvals</span>
              {approvals.length > 0 ? (
                <span className="dashboard-status-strip__pill dashboard-status-strip__pill--warn">
                  {approvals.length}
                </span>
              ) : null}
            </div>
            <div className="dashboard-status-strip__value">
              {approvals.length}
              <span className="dashboard-status-strip__value-sub">tools</span>
            </div>
            {approvalToolLine ? (
              <div className="dashboard-status-strip__sub">{approvalToolLine}</div>
            ) : null}
          </div>

          {/* Feishu integration */}
          <div className="dashboard-status-strip__cell">
            <div className="dashboard-status-strip__top">
              <span className="dashboard-status-strip__label">Feishu Integration</span>
            </div>
            <div className="dashboard-status-strip__value dashboard-status-strip__value--text">
              {feishuStatus === "connected"
                ? "Connected"
                : feishuStatus === "disabled"
                  ? "Disabled"
                  : feishuStatus === "disconnected"
                    ? "Disconnected"
                    : "Unknown"}
            </div>
            {feishuSubLine ? (
              <div className="dashboard-status-strip__sub">{feishuSubLine}</div>
            ) : null}
          </div>

          {/* Last activity */}
          <div className="dashboard-status-strip__cell">
            <div className="dashboard-status-strip__top">
              <span className="dashboard-status-strip__label">Last Activity</span>
            </div>
            <div className="dashboard-status-strip__value">
              {lastActivitySplit.value}
              {lastActivitySplit.unit ? (
                <span className="dashboard-status-strip__value-sub">{lastActivitySplit.unit}</span>
              ) : null}
            </div>
            {streamingSubLine ? (
              <div className="dashboard-status-strip__sub">{streamingSubLine}</div>
            ) : null}
          </div>
        </section>

        <div className="dashboard-main-row">
          <section className="dashboard-card work-queue-panel" aria-label="Work queue">
            <div className="dashboard-panel-heading">
              <h2>Work Queue</h2>
              <span className="dashboard-panel-heading__meta">
                {TASK_FETCH_LIMIT} most recent · refreshes {Math.round(DASHBOARD_REFRESH_MS / 1000)}s
              </span>
            </div>

            {error ? <p className="dashboard-inline-error">{error}</p> : null}

            <div className="work-queue-table-wrap">
              <table className="work-queue-table">
                <colgroup>
                  <col className="work-queue-col--task" />
                  <col className="work-queue-col--source" />
                  <col className="work-queue-col--agent" />
                  <col className="work-queue-col--state" />
                  <col className="work-queue-col--upd" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Source</th>
                    <th>Agent</th>
                    <th>State</th>
                    <th>Upd</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="work-queue-empty">No recent tasks</td>
                    </tr>
                  ) : (
                    tasks.map((task) => {
                      const stateGlyph = workQueueStateGlyph(task.state);
                      return (
                        <tr key={task.id}>
                          <td>
                            <Link to={`/w/${task.workspaceId}/sessions/${task.id}`} className="work-queue-task-link">
                              {task.title || "Untitled task"}
                            </Link>
                          </td>
                          <td>
                            <span className={sourceClassName(task.source)}>{sourceLabel(task.source).toUpperCase()}</span>
                          </td>
                          <td>{inferTaskAgent(task)}</td>
                          <td>
                            <span
                              className={`work-queue-state work-queue-state--${stateGlyph.tone}`}
                              data-state-tone={stateGlyph.tone}
                            >
                              <span className="work-queue-state__glyph" aria-hidden="true">{stateGlyph.glyph}</span>
                              <span className="work-queue-state__label">{stateGlyph.label}</span>
                            </span>
                          </td>
                          <td className="work-queue-table__upd">{formatRelativeTime(task.updatedAt)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="dashboard-card attention-panel" aria-label="Needs attention">
            <div className="dashboard-panel-heading">
              <h2>Needs Attention</h2>
              <span className="dashboard-panel-heading__meta">{attentionTotal} items · grouped</span>
            </div>

            <div className="attention-section" data-tone="ochre">
              <div className="attention-section__head">
                <span className="attention-section__dot" aria-hidden="true" />
                <h3>Approval Required</h3>
                <span className="attention-section__count">{approvals.length}</span>
              </div>
              {approvals.length === 0 ? (
                <p className="attention-empty">No pending approvals</p>
              ) : (
                <ul className="attention-list">
                  {approvals.slice(0, 4).map((approval) => (
                    <li key={approval.id} className="attention-item attention-item--stacked">
                      <span className="attention-item-title attention-item-title--code">
                        {summarizeApproval(approval)}
                      </span>
                      <span className="attention-item-meta">
                        task #{shortTaskId(approval.taskId)} · {formatRelativeTime(approval.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="attention-section" data-tone="red">
              <div className="attention-section__head">
                <span className="attention-section__dot" aria-hidden="true" />
                <h3>Failed</h3>
                <span className="attention-section__count">{failedTasks.length}</span>
              </div>
              {failedTasks.length === 0 ? (
                <p className="attention-empty">No failed tasks</p>
              ) : (
                <ul className="attention-list">
                  {failedTasks.slice(0, 4).map((task) => (
                    <li key={`failed-${task.id}`} className="attention-item attention-item--stacked">
                      <Link to={`/w/${task.workspaceId}/sessions/${task.id}`} className="attention-item-title">
                        {task.title || "Untitled task"}
                      </Link>
                      <span className="attention-item-meta">
                        task #{shortTaskId(task.id)} · {formatRelativeTime(task.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="attention-section" data-tone="blue">
              <div className="attention-section__head">
                <span className="attention-section__dot" aria-hidden="true" />
                <h3>Blocked</h3>
                <span className="attention-section__count">{blockedTasks.length}</span>
              </div>
              {blockedTasks.length === 0 ? (
                <p className="attention-empty">No blocked tasks</p>
              ) : (
                <ul className="attention-list">
                  {blockedTasks.slice(0, 4).map((task) => (
                    <li key={`blocked-${task.id}`} className="attention-item attention-item--stacked">
                      <Link to={`/w/${task.workspaceId}/sessions/${task.id}`} className="attention-item-title">
                        {task.title || "Untitled task"}
                      </Link>
                      <span className="attention-item-meta">
                        task #{shortTaskId(task.id)} · {formatRelativeTime(task.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <section className="dashboard-card agent-pool" aria-label="Agent pool">
          <div className="dashboard-panel-heading">
            <h2>Agent Pool</h2>
            <span className="dashboard-panel-heading__meta">
              {agentPoolSummary}
            </span>
          </div>

          {poolAgents.length === 0 ? (
            <div className="agent-pool-grid">
              {Array.from({ length: 5 }).map((_, idx) => (
                <article className="agent-pool-card agent-pool-card--skeleton" key={`skeleton-${idx}`}>
                  <Skeleton lines={3} />
                </article>
              ))}
            </div>
          ) : (
            <div className="agent-pool-grid">
              {poolAgents.map((agent) => {
                const normalizedRole = normalizeRoleId(agent.roleId);
                const heartbeat = heartbeatByRole.get(normalizedRole);
                // Prefer the dedicated /agents/heartbeats payload
                // (in-memory + DB merged, freshest), fall back to
                // the AgentStatusItem's persisted lastHeartbeatAt.
                const lastSeenAt = heartbeat?.lastSeenAt
                  ?? (typeof agent.lastHeartbeatAt === "number" ? agent.lastHeartbeatAt : null);
                const poolState = resolveAgentPoolState(agent, lastSeenAt, nowTick);
                return (
                  <article className={`agent-pool-card agent-pool-card--${poolState.tone}`} key={agent.roleId}>
                    <div className="agent-pool-top">
                      <span
                        className={agentPoolToneClass("agent-pool-dot", poolState.tone)}
                        aria-hidden="true"
                      />
                      <span className="agent-pool-name">{prettyRoleName(agent.roleId)}</span>
                      <span
                        className={agentPoolToneClass("agent-pool-tag", poolState.tone)}
                        title={poolState.title}
                      >
                        {poolState.label}
                      </span>
                    </div>
                    <div className="agent-pool-model">{poolState.modelLabel}</div>
                    <div className="agent-pool-heartbeat">{poolState.footer}</div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <footer className="dashboard-footer">
          {/* Real build provenance — vite injects __MAGISTER_BUILD_SHA__
              (short git commit) + __MAGISTER_BUILD_AT__ (ISO 8601 build
              timestamp) at compile time. Was previously a literal
              "v5.1 · MMXXVI" that drifted as soon as it was written. */}
          <span
            className="dashboard-footer__brand"
            title={`built ${__MAGISTER_BUILD_AT__}`}
          >
            Magister · build {__MAGISTER_BUILD_SHA__}
          </span>
          <span className="dashboard-footer__meta">
            {hostLabel} · <span className="dashboard-footer__status">{systemStatus ? "online" : "offline"}</span> · {clockTime}
          </span>
        </footer>
      </div>
    </div>
  );
}
