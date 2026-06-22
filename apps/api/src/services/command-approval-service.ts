import { ApprovalRepository } from "../repositories/approval-repository";
import { redactHomePath, redactPathEntries } from "./safe-apply/path-redactor";
import type { ApprovalSelect } from "@magister/db";

/**
 * Sandbox-elevation v4.3 spec acceptance #22 — redact $HOME prefix
 * in path fields landing in operator-facing telemetry. Walks the
 * known v4 payload shape: `escalation.additional_permissions.file_system.entries[*].path`
 * and `escalation.deny_read_requested_but_unsupported[*].path`. UI
 * keeps unredacted paths (different payload — toolArgs at render time);
 * operator logs / trace panel use the redacted form.
 */
function redactPathsInToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const escalation = args.escalation;
  if (!escalation || typeof escalation !== "object") return args;
  const e = escalation as Record<string, unknown>;
  const ap = e.additional_permissions;
  const drr = e.deny_read_requested_but_unsupported;

  let redactedAp: typeof ap = ap;
  // glm-5.1 final-final review LOW — defense in depth: a corrupted DB
  // payload could store a truthy non-array `entries`. Outer caller's
  // catch would swallow the resulting TypeError, but the conflict
  // event would silently drop. Add explicit Array.isArray guard so
  // the redactor stays robust against schema drift.
  if (ap && typeof ap === "object" && !Array.isArray(ap)) {
    const apObj = ap as Record<string, unknown>;
    const fs = apObj.file_system;
    if (fs && typeof fs === "object" && !Array.isArray(fs)) {
      const fsObj = fs as { entries?: unknown };
      if (Array.isArray(fsObj.entries)) {
        const validEntries = (fsObj.entries as unknown[]).filter(
          (e): e is { path: string; access: string } =>
            !!e && typeof e === "object" && "path" in e
            && typeof (e as { path: unknown }).path === "string",
        );
        redactedAp = {
          ...apObj,
          file_system: { ...fsObj, entries: redactPathEntries(validEntries) },
        };
      }
    }
  }

  let redactedDrr: typeof drr = drr;
  if (Array.isArray(drr)) {
    redactedDrr = drr.map((entry) => {
      if (entry && typeof entry === "object" && "path" in entry) {
        return { ...entry, path: redactHomePath((entry as { path: string }).path) };
      }
      return entry;
    });
  }

  if (redactedAp === ap && redactedDrr === drr) return args;
  return {
    ...args,
    escalation: {
      ...e,
      ...(redactedAp !== ap ? { additional_permissions: redactedAp } : {}),
      ...(redactedDrr !== drr ? { deny_read_requested_but_unsupported: redactedDrr } : {}),
    },
  };
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRecord = {
  id: string;
  taskId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string; // 'user' | 'timeout'
};

// 5 min timeout, auto-approve on expiry. Keeps tasks flowing when
// the operator isn't watching. Click Reject within the window to block.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Approvals live in the `approvals` table (packages/db/src/schema.ts).
// Previously this service backed them with a process-local Map, which
// meant every `bash run scripts/restart.sh` or accidental SIGTERM
// silently wiped every pending approval — and the leader task waiting
// on `waitForApproval()` would hang forever on a now-vanished id. The
// DB-backed path survives restarts; on cold start the API loads any
// previously-pending rows by row state and the leader can resume
// `waitForApproval()` against them.
//
// Persistence shape: `approvals.approvalType` stores the kind
// ("bash" | "mcp_tool"), `approvals.state` stores the status, and
// `approvals.payloadJson` carries the structured payload
// (`{ toolName, toolArgs, summary }`). The repo also already has
// `taskId` / `requestedAt` / `resolvedAt` / `resolvedBy` columns we
// reuse directly.
const repo = new ApprovalRepository();

/** Translate a DB row into the ApprovalRecord shape callers expect. */
function rowToRecord(row: ApprovalSelect): ApprovalRecord {
  let payload: { toolName?: string; toolArgs?: Record<string, unknown>; summary?: string } = {};
  if (row.payloadJson) {
    try {
      payload = JSON.parse(row.payloadJson) as typeof payload;
    } catch {
      // Corrupt payload — keep going with empty defaults rather than
      // throwing inside the read path. The leader can still see the
      // approval id and resolve it; the operator will just see less
      // detail in the UI.
    }
  }
  const out: ApprovalRecord = {
    id: row.id,
    taskId: row.taskId,
    toolName: payload.toolName ?? row.approvalType,
    toolArgs: payload.toolArgs ?? {},
    summary: payload.summary ?? "",
    status: (row.state as ApprovalStatus) ?? "pending",
    createdAt: row.requestedAt.getTime(),
  };
  if (row.resolvedAt) out.resolvedAt = row.resolvedAt.getTime();
  if (row.resolvedBy) out.resolvedBy = row.resolvedBy;
  return out;
}

/**
 * Cache / build-output directories that are universally safe to delete:
 * git-ignored, autogenerated, regenerated on next tool run. Matching
 * against this list short-circuits the danger gate so the user doesn't
 * have to click Approve every time they ask the agent to clean
 * `__pycache__` etc. Add only directories whose deletion has zero
 * side effects beyond a one-time recompile/refetch.
 */
const SAFE_CLEANUP_TARGETS = [
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".eggs",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
] as const;

function buildSafeCleanupRegexes(): RegExp[] {
  // Each safe target as a regex-safe alternation.
  const names = SAFE_CLEANUP_TARGETS.map((n) => n.replace(/\./g, "\\.")).join("|");
  // Tolerate a single trailing benign tail: `2>/dev/null`, `; echo …`,
  // `&& echo …` or `&& true`. Anything else (chained rm of an
  // unrelated path, redirects to disk, sudo, etc.) falls through to
  // the danger gate.
  const tail = "(\\s+2>\\s*/dev/null)?(\\s*(;|&&)\\s*(echo\\s+\\S+|true|:))?";
  return [
    // Form A: rm -r[fF]? <word-path-ending-in-safe-name>(/)?
    //   `rm -rf /opt/foo/__pycache__`
    //   `rm -rf foo/.pytest_cache/`
    new RegExp(`^rm\\s+-r[fF]?\\s+\\S*\\/?(?:${names})\\/?${tail}\\s*$`),
    // Form B: find <dir> [-maxdepth N] -type d -name <safe-name> -exec rm -rf {} (+|;)
    new RegExp(
      `^find\\s+\\S+\\s+(?:-maxdepth\\s+\\d+\\s+)?-type\\s+d\\s+-name\\s+['"]?(?:${names})['"]?\\s+-exec\\s+rm\\s+-r[fF]?\\s+\\{\\}\\s+(?:\\+|\\\\;)${tail}\\s*$`,
    ),
  ];
}

const SAFE_CLEANUP_REGEXES = buildSafeCleanupRegexes();

/**
 * True iff the command is one of a small set of well-defined cache /
 * build-output cleanups. Matches `rm -rf <path>/__pycache__`,
 * `find ... -name __pycache__ -exec rm -rf {} +`, and a tolerated
 * `2>/dev/null` / `; echo done` tail. Everything else routes to the
 * danger-gate check below.
 */
export function isSafeCleanupCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_CLEANUP_REGEXES.some((re) => re.test(trimmed));
}

const DANGEROUS_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)\b/, reason: "Recursive/forced file deletion" },
  { pattern: /\brm\s+-rf\b/i, reason: "Recursive/forced file deletion" },
  { pattern: /\brm\s+\S+\s+-rf\b/i, reason: "Recursive/forced file deletion" },
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: "Force push can rewrite remote history" },
  { pattern: /\bgit\s+push\s+-f\b/, reason: "Force push can rewrite remote history" },
  { pattern: /\bgit\s+push\s+\S+\s+\S+\s+-f\b/, reason: "Force push can rewrite remote history" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "Hard reset discards local changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "Git clean force can permanently remove files" },
  { pattern: /\bgit\s+checkout\s+--\s*\./, reason: "Checkout with path reset can discard local changes" },
  { pattern: /\bDROP\s+(TABLE|DATABASE|INDEX)\b/i, reason: "Destructive SQL operation detected" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "Destructive SQL truncation detected" },
  { pattern: /\bDELETE\s+FROM\b.*\bWHERE\b.*1\s*=\s*1/i, reason: "Potential mass SQL delete detected" },
  { pattern: /\bchmod\s+777\b/, reason: "Overly permissive chmod detected" },
  { pattern: /\bchmod\s+-R\s+777\b/, reason: "Recursive overly permissive chmod detected" },
  { pattern: /\bchmod\s+0?777\b/, reason: "Overly permissive chmod detected" },
  { pattern: /\bcurl\s+.*\|\s*sh\b/, reason: "Remote script execution via curl pipe detected" },
  { pattern: /\bcurl\s+.*\|\s*bash\b/, reason: "Remote script execution via curl pipe detected" },
  { pattern: /\bwget\s+.*\|\s*sh\b/, reason: "Remote script execution via wget pipe detected" },
  { pattern: /\bsudo\s+rm\b/, reason: "Privileged file removal detected" },
  { pattern: /\bmkfs\b/, reason: "Filesystem formatting command detected" },
  { pattern: /\bdd\s+if=/, reason: "Raw disk write command detected" },
  { pattern: /\b>\s*\/dev\/sd[a-z]/, reason: "Direct disk device write redirection detected" },
  { pattern: /\bnpm\s+publish\b/, reason: "Package publish command detected" },
  { pattern: /\bdocker\s+rm\s+-f/, reason: "Forceful container deletion detected" },
  { pattern: /\bdocker\s+rm\s+\S+\s+-f\b/, reason: "Forceful container deletion detected" },
  { pattern: /\bdocker\s+system\s+prune/, reason: "Docker system prune can remove resources" },
  { pattern: /\bkill\s+-9\b/, reason: "Force kill command detected" },
  { pattern: /\bkillall\b/, reason: "Killall command detected" },
];

function sanitizeToolArgs(toolArgs: Record<string, unknown>): Record<string, unknown> {
  const command = toolArgs.command;
  if (typeof command !== "string") {
    return toolArgs;
  }

  return {
    ...toolArgs,
    command: sanitizeCommandPreview(command),
  };
}

async function expireApprovalWithTimeout(approvalId: string, now = Date.now()): Promise<void> {
  const landed = await repo.resolve(approvalId, {
    state: "approved",
    resolvedAt: new Date(now),
    resolvedBy: "auto_timeout",
  });
  if (!landed) return;
  const updated = await repo.getById(approvalId);
  if (updated) {
    dispatchHooks(resolvedHooks, rowToRecord(updated));
    await emitApprovalResolvedEvent(updated, "approved");
  }
}

/** Project a `leader.approval_resolved` execution event + WS broadcast
 *  so the web projector's pause counter unblocks and the inline
 *  approval card clears. Fired from BOTH terminal-transition paths
 *  (user click via `resolveApproval`, timeout via
 *  `expireApprovalWithTimeout`). */
async function emitApprovalResolvedEvent(
  row: ApprovalSelect,
  decision: "approved" | "rejected" | "expired",
): Promise<void> {
  try {
    let requestId = "";
    let toolName = row.approvalType;
    if (row.payloadJson) {
      try {
        const payload = JSON.parse(row.payloadJson) as {
          requestId?: string;
          toolName?: string;
        };
        if (typeof payload.requestId === "string") requestId = payload.requestId;
        if (typeof payload.toolName === "string") toolName = payload.toolName;
      } catch {
        /* keep defaults */
      }
    }
    const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
    const { wsHub } = await import("../ws/hub");
    const { taskEventBus } = await import("../sse/task-event-bus");
    const eventRepo = new ExecutionEventRepository();
    const eventId = `event_${crypto.randomUUID()}`;
    const occurredAt = row.resolvedAt ?? new Date();
    const eventPayload = { approvalId: row.id, toolName, decision };
    const seq = await eventRepo.create({
      id: eventId,
      type: "leader.approval_resolved",
      taskId: row.taskId,
      approvalId: row.id,
      ...(requestId ? { requestId } : {}),
      occurredAt,
      payloadJson: JSON.stringify(eventPayload),
    });
    const wirePayload = {
      type: "leader.approval_resolved",
      requestId,
      data: eventPayload,
      timestamp: occurredAt.toISOString(),
      seq,
    };
    wsHub.broadcast(row.taskId, wirePayload);
    // Mirror to SSE bus — without this the chat projector never clears
    // the active pause and the spinner stays "Working" after click.
    taskEventBus.publish(row.taskId, wirePayload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[command-approval] leader.approval_resolved emit failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Sandbox-elevation v4.3 §4.5 (codex Q2) — emit an audit event when
 * a dual-channel resolve collision happens: caller's decision
 * differed from the stored outcome. UI uses the response payload's
 * `conflict` field for the yellow toast; this event captures the
 * full attempt+stored pair for trace + operator log.
 */
async function emitApprovalReplayConflictEvent(
  row: ApprovalSelect,
  attemptedDecision: "approved" | "rejected",
): Promise<void> {
  let requestId = "";
  let toolName = row.approvalType;
  let redactedToolArgs: Record<string, unknown> | undefined;
  if (row.payloadJson) {
    try {
      const payload = JSON.parse(row.payloadJson) as {
        requestId?: string;
        toolName?: string;
        toolArgs?: Record<string, unknown>;
      };
      if (typeof payload.requestId === "string") requestId = payload.requestId;
      if (typeof payload.toolName === "string") toolName = payload.toolName;
      // v4.3 spec acceptance #22 — redact $HOME-prefixed paths in any
      // path fields that land in operator-facing event payloads.
      if (payload.toolArgs) {
        redactedToolArgs = redactPathsInToolArgs(payload.toolArgs);
      }
    } catch {
      /* keep defaults */
    }
  }
  const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
  const { wsHub } = await import("../ws/hub");
  const { taskEventBus } = await import("../sse/task-event-bus");
  const eventRepo = new ExecutionEventRepository();
  const eventId = `event_${crypto.randomUUID()}`;
  const occurredAt = new Date();
  const eventPayload = {
    approvalId: row.id,
    toolName,
    attemptedDecision,
    storedOutcome: row.state,
    ...(redactedToolArgs ? { toolArgs: redactedToolArgs } : {}),
  };
  const seq = await eventRepo.create({
    id: eventId,
    type: "leader.approval_replay_conflict",
    taskId: row.taskId,
    approvalId: row.id,
    ...(requestId ? { requestId } : {}),
    occurredAt,
    payloadJson: JSON.stringify(eventPayload),
  });
  const wirePayload = {
    type: "leader.approval_replay_conflict",
    requestId,
    data: eventPayload,
    timestamp: occurredAt.toISOString(),
    seq,
  };
  wsHub.broadcast(row.taskId, wirePayload);
  taskEventBus.publish(row.taskId, wirePayload);
}

export function sanitizeCommandPreview(command: string): string {
  return command
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
    .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]")
    .replace(/password[=:]\s*\S+/gi, "password=[REDACTED]")
    .replace(/secret[=:]\s*\S+/gi, "secret=[REDACTED]")
    .replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=[REDACTED]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-[REDACTED]")
    .replace(/ark-[a-zA-Z0-9-]{20,}/g, "ark-[REDACTED]");
}

export function isDangerousCommand(command: string): boolean {
  // Whitelist common cache cleanup forms (rm/find on __pycache__,
  // .pytest_cache, etc.) so the agent doesn't have to ask for
  // approval on every "delete the build cache" request — those
  // operations are universally safe and the prompt was pure friction.
  if (isSafeCleanupCommand(command)) return false;
  return DANGEROUS_RULES.some((rule) => rule.pattern.test(command));
}

export function getDangerReason(command: string): string | null {
  if (isSafeCleanupCommand(command)) return null;
  const match = DANGEROUS_RULES.find((rule) => rule.pattern.test(command));
  return match?.reason ?? null;
}

/**
 * Approval lifecycle hooks. Registered by side-channel services
 * (e.g. feishu-approval-outbound-service) so they can react to
 * created/resolved events without command-approval-service.ts having
 * a hard import of the integration layer.
 *
 * Hooks run as fire-and-forget — errors are logged but do not block
 * the approval itself. A failing feishu push must NEVER prevent the
 * web user from approving.
 */
type ApprovalCreatedHook = (record: ApprovalRecord) => void | Promise<void>;
type ApprovalResolvedHook = (record: ApprovalRecord) => void | Promise<void>;

const createdHooks: Set<ApprovalCreatedHook> = new Set();
const resolvedHooks: Set<ApprovalResolvedHook> = new Set();

export function onApprovalCreated(hook: ApprovalCreatedHook): () => void {
  createdHooks.add(hook);
  return () => createdHooks.delete(hook);
}

export function onApprovalResolved(hook: ApprovalResolvedHook): () => void {
  resolvedHooks.add(hook);
  return () => resolvedHooks.delete(hook);
}

function dispatchHooks(hooks: Set<(r: ApprovalRecord) => void | Promise<void>>, record: ApprovalRecord) {
  for (const hook of hooks) {
    try {
      const result = hook(record);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[approval-hook] async hook failed:", err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[approval-hook] sync hook failed:", err instanceof Error ? err.message : err);
    }
  }
}

export async function createApproval(
  taskId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  summary: string,
  /** Per-prompt scope for the approval-requested event. When omitted
   *  (bash legacy path didn't thread it), the broadcast uses the
   *  latest known requestId for the task via a DB lookup so the
   *  web projector can still match an exchange. */
  requestId?: string,
): Promise<ApprovalRecord> {
  const now = Date.now();
  const id = `approval_${crypto.randomUUID()}`;
  const cleanArgs = sanitizeToolArgs(toolArgs);
  const cleanSummary = sanitizeCommandPreview(summary);

  // requestId is resolved below (explicit arg or DB-fallback). Persist
  // it in payloadJson so the symmetric `leader.approval_resolved` emit
  // can tag the same exchange — without this, resolve events would
  // either miss the projector's exchange index or pay another lookup.
  let resolvedRequestId: string = requestId ?? "";
  if (!resolvedRequestId) {
    try {
      const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
      const eventRepo = new ExecutionEventRepository();
      const latest = await eventRepo.listLatestRequestEvents(taskId);
      for (let i = latest.length - 1; i >= 0; i--) {
        const candidate = latest[i]?.requestId;
        if (typeof candidate === "string" && candidate.length > 0) {
          resolvedRequestId = candidate;
          break;
        }
      }
    } catch {
      /* best-effort lookup */
    }
  }

  await repo.create({
    id,
    taskId,
    approvalType: toolName,
    state: "pending",
    requestedAt: new Date(now),
    resolvedAt: null,
    resolvedBy: null,
    payloadJson: JSON.stringify({
      toolName,
      toolArgs: cleanArgs,
      summary: cleanSummary,
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
    }),
  });

  const record: ApprovalRecord = {
    id,
    taskId,
    toolName,
    toolArgs: cleanArgs,
    summary: cleanSummary,
    status: "pending",
    createdAt: now,
  };

  // Emit `leader.approval_requested` so the frontend ApprovalBell +
  // chat surface get notified for ALL approval kinds (was previously
  // only done in the bash-specific code path inside the leader tool
  // adapter; MCP-tool approvals routed via `requestApprovalForTool`
  // were silently invisible to the web UI without this broadcast.
  // Best-effort: persistence/broadcast failure must not block the
  // approval-creation itself — the DB row already exists.
  try {
    const { ExecutionEventRepository } = await import("../repositories/execution-event-repository");
    const { wsHub } = await import("../ws/hub");
    const { taskEventBus } = await import("../sse/task-event-bus");
    const eventRepo = new ExecutionEventRepository();
    const eventId = `event_${crypto.randomUUID()}`;
    const occurredAt = new Date(now);
    // Surface `reason` + `command` at the top level so the web
    // projector's `applyApprovalRequested` can render the inline card
    // with the actual command (was defaulting to "Dangerous command"
    // and an empty pre block after we centralized the emit out of the
    // bash adapter). Bash carries args.command directly; MCP-tool
    // approvals get a server.tool slug since there's no shell command.
    const command =
      typeof cleanArgs.command === "string"
        ? cleanArgs.command
        : typeof cleanArgs.server === "string" && typeof cleanArgs.tool === "string"
          ? `${cleanArgs.server}.${cleanArgs.tool}`
          : "";
    // Surface toolKind + subjectKey so the chat approval card can
    // render accurate trust-checkbox labels and match the subject the
    // server uses for the in-process trust ledger.
    const wireToolKind: "bash" | "mcp_tool" =
      toolName === "mcp_tool" ? "mcp_tool" : "bash";
    const wireSubjectKey =
      wireToolKind === "mcp_tool" && typeof cleanArgs.server === "string"
        ? cleanArgs.server
        : "*";
    const eventPayload = {
      approvalId: id,
      toolName,
      toolKind: wireToolKind,
      subjectKey: wireSubjectKey,
      summary: cleanSummary,
      reason: cleanSummary,
      command,
      args: cleanArgs,
    };
    const seq = await eventRepo.create({
      id: eventId,
      type: "leader.approval_requested",
      taskId,
      approvalId: id,
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
      occurredAt,
      payloadJson: JSON.stringify(eventPayload),
    });
    const wirePayload = {
      type: "leader.approval_requested",
      requestId: resolvedRequestId,
      data: eventPayload,
      timestamp: occurredAt.toISOString(),
      seq,
    };
    wsHub.broadcast(taskId, wirePayload);
    // Also publish through taskEventBus → chat SSE stream listens here.
    // Without this the inline ApprovalCard never appears (the bell
    // worked because it polls /approvals/pending; the chat doesn't).
    taskEventBus.publish(taskId, wirePayload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[command-approval] leader.approval_requested emit failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Side-channel notification (feishu push, etc.). Fire-and-forget;
  // a feishu API outage must not block the approval from being
  // resolvable via web.
  dispatchHooks(createdHooks, record);

  return record;
}

/**
 * Sandbox-elevation v4.3 §4.5 — resolveApproval return shape extended
 * to carry CAS + replay-conflict signals so callers can:
 *  (a) gate trust-ledger writes on `landed === true` (only the CAS
 *      winner gets to write; replays skip)
 *  (b) surface a yellow toast when `conflict === true` (the user's
 *      action lost to a concurrent resolve on another channel)
 */
export type ResolveApprovalOutcome = {
  record: ApprovalRecord;
  /** True iff this call won the CAS — the one that mutated the row. */
  landed: boolean;
  /** True iff caller's decision differed from the stored outcome
   *  (dual-channel collision: Web approved + Feishu rejected, etc.). */
  conflict: boolean;
  /** When `landed === false`, the resolution that's actually stored. */
  storedOutcome: "approved" | "rejected" | "expired" | "pending";
};

export async function resolveApproval(
  id: string,
  decision: "approved" | "rejected",
): Promise<ResolveApprovalOutcome | null> {
  const row = await repo.getById(id);
  if (!row) return null;

  // Already-resolved path — return existing record without re-firing
  // hooks. `conflict` is true iff the decision the caller is trying
  // to apply differs from what's stored. UI surfaces this as a yellow
  // toast (codex review Q2 — HIGH).
  if (row.state !== "pending") {
    const conflict = row.state !== decision;
    if (conflict) {
      // v4.3 §4.5 — emit an audit event for dual-channel conflicts so
      // the trace panel + operator log show what happened. Fire-and-
      // forget; never blocks the caller.
      void emitApprovalReplayConflictEvent(row, decision).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          "[command-approval] leader.approval_replay_conflict emit failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }
    return {
      record: rowToRecord(row),
      landed: false,
      conflict,
      storedOutcome: row.state as ResolveApprovalOutcome["storedOutcome"],
    };
  }

  // CAS write: only mutates if state is still 'pending'. Protects
  // against dual-channel resolve races — web + Feishu both clicking
  // within ms of each other. The loser gets `landed === false` and
  // we return the already-resolved state without re-firing hooks
  // OR writing trust (the caller checks `landed` for both).
  const landed = await repo.resolve(id, {
    state: decision,
    resolvedAt: new Date(),
    resolvedBy: "user",
  });
  const updated = await repo.getById(id);
  if (!updated) return null;
  const record = rowToRecord(updated);
  // Notify side-channels ONLY when this call was the one that landed
  // the write. Otherwise the feishu projector would PATCH the card
  // twice (once per click), confusing the rendered state.
  if (landed) {
    dispatchHooks(resolvedHooks, record);
    await emitApprovalResolvedEvent(updated, decision);
  }
  return {
    record,
    landed,
    conflict: !landed && updated.state !== decision,
    storedOutcome: updated.state as ResolveApprovalOutcome["storedOutcome"],
  };
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const row = await repo.getById(id);
  return row ? rowToRecord(row) : null;
}

export async function getPendingApprovals(): Promise<ApprovalRecord[]> {
  const rows = await repo.listPending();
  return rows.map(rowToRecord);
}

export async function getExpiredApprovals(): Promise<ApprovalRecord[]> {
  const cutoff = Date.now() - APPROVAL_TIMEOUT_MS;
  const rows = await repo.listExpired(cutoff);
  return rows.map(rowToRecord);
}

export async function expireOldApprovals(): Promise<number> {
  const expired = await getExpiredApprovals();
  for (const approval of expired) {
    await expireApprovalWithTimeout(approval.id);
  }
  return expired.length;
}

export async function waitForApproval(
  id: string,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<"approved" | "rejected" | "expired"> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    await expireOldApprovals();

    const row = await repo.getById(id);
    if (!row) return "expired";

    if (row.state === "approved" || row.state === "rejected" || row.state === "expired") {
      return row.state as "approved" | "rejected" | "expired";
    }

    if (signal?.aborted) {
      const landed = await repo.resolve(id, {
        state: "expired",
        resolvedAt: new Date(),
        resolvedBy: "abort",
      });
      // Project a resolution event like the timeout path does. Without
      // it, the `leader.approval_requested` event stays unmatched and
      // the task is stuck on "Waiting for a human approval" forever.
      if (landed) {
        const updated = await repo.getById(id);
        if (updated) {
          dispatchHooks(resolvedHooks, rowToRecord(updated));
          await emitApprovalResolvedEvent(updated, "expired");
        }
      }
      return "expired";
    }

    if (Date.now() >= deadline) {
      await expireApprovalWithTimeout(id);
      return "approved";
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function clearApprovalRecordsForTests(): Promise<void> {
  await repo.deleteAllForTests();
}

/**
 * Task-scoped approval trust ledger.
 *
 * Lets the user check "Trust this server for the rest of this task"
 * or "Trust for 5 minutes" on an approval card — subsequent matching
 * approval requests skip the gate and auto-resolve as "approved".
 *
 * Storage is process-local: a `Map<taskId, TrustEntry[]>`. On API
 * restart all entries clear (acceptable — the user can re-trust on
 * the next prompt; permanent trust lives in `mcp_servers.trustLevel`
 * or `command_approval_rules`, not here).
 *
 * Subject key convention:
 *   bash      → "*"             (any bash command; the broad whitelist)
 *   mcp_tool  → <serverId>      (specific MCP server)
 *
 * Wildcard entries (subjectKey === "*") match any subject; entries
 * also match when subjectKey is the literal "*". Lets bash trust
 * cover all bash and lets MCP trust scope to one server.
 *
 * Terminal cleanup is opportunistic — `clearTaskApprovalTrust(taskId)`
 * is called from process-task-intent-service when a task transitions
 * to a terminal state. Missed cleanup is a small memory leak; not
 * a correctness issue (entries have an `expiry` and never auto-fire
 * after the timestamp).
 */
type ApprovalToolKind = "bash" | "mcp_tool";
type TrustEntry = {
  toolKind: ApprovalToolKind;
  subjectKey: string;
  /** Epoch-ms; v4.3 caps task-scope at +72h (was POSITIVE_INFINITY)
   *  so a task that crashed without clearing trust doesn't leak the
   *  entry until process restart. */
  expiry: number;
  /**
   * Sandbox-elevation v4.3 §4.1 trust split — when present, this
   * entry trusts the specific dangerous-command pattern (e.g. matched
   * by isDangerousCommand). Future bash calls whose match.pattern
   * equals this can short-circuit the danger gate without re-prompt.
   */
  dangerousCommandPattern?: string;
  /**
   * Sandbox-elevation v4.3 §4.1 trust split — when present, this
   * entry trusts a specific additional_permissions profile. Future
   * bash calls whose requested profile is a subset of this profile
   * skip the permission gate.
   */
  additionalPermissions?: { network?: { enabled?: boolean }; file_system?: { entries: Array<{ path: string; access: "read" | "write" }> } };
};

/** Sandbox-elevation v4.3 §4.5 — task-scope trust hard ceiling. */
const TASK_TRUST_MAX_DURATION_MS = 72 * 60 * 60 * 1000;

const taskTrustLedger = new Map<string, TrustEntry[]>();

export function isTrustedForApproval(
  taskId: string,
  toolKind: ApprovalToolKind,
  subjectKey: string,
): boolean {
  const now = Date.now();
  const entries = taskTrustLedger.get(taskId);
  if (!entries) return false;
  return entries.some((e) =>
    e.toolKind === toolKind
    && (e.subjectKey === subjectKey || e.subjectKey === "*")
    && e.expiry > now,
  );
}

/**
 * Sandbox-elevation v4.3 §4.5 — union of active trust-ledger granted
 * `additionalPermissions` for the current task. Returns the union of
 * all active grants with write-covers-read semantics so the bash
 * dispatcher can pass `extraBinds` for AUTOMATIC INHERITANCE (spec
 * §4.2): subsequent bash calls in this task pick up previously
 * granted binds even when the model didn't re-declare them.
 *
 * Returns `null` when no matching entry exists or all have expired.
 */
export function findGrantedAdditionalPermissions(
  taskId: string,
  toolKind: ApprovalToolKind,
): TrustEntry["additionalPermissions"] | null {
  const now = Date.now();
  const entries = taskTrustLedger.get(taskId);
  if (!entries) return null;

  const active = entries.filter((e) =>
    e.toolKind === toolKind
    && e.expiry > now
    && e.additionalPermissions !== undefined,
  );
  if (active.length === 0) return null;

  // Union profile across all active grants. write-covers-read per §4.4.
  const pathMap = new Map<string, "read" | "write">();
  let networkEnabled = false;
  for (const entry of active) {
    const profile = entry.additionalPermissions!;
    if (profile.network?.enabled) networkEnabled = true;
    if (profile.file_system?.entries) {
      for (const fileEntry of profile.file_system.entries) {
        const existing = pathMap.get(fileEntry.path);
        if (existing === "write") continue; // already covers read
        pathMap.set(fileEntry.path, fileEntry.access);
      }
    }
  }
  const fileSystemEntries = Array.from(pathMap.entries()).map(([path, access]) => ({ path, access }));
  return {
    ...(networkEnabled ? { network: { enabled: true } } : {}),
    ...(fileSystemEntries.length > 0 ? { file_system: { entries: fileSystemEntries } } : {}),
  };
}

/**
 * Sandbox-elevation v4.3 §4.2 (codex+kimi Slice-3 review HIGH Q1d) —
 * inspect the ledger for entries that EXPIRED between approval and
 * this bash dispatch. Returns expired-grant paths so the dispatcher
 * can surface `permissionNotices.grantsExpired` in the bash tool
 * result — making expiry model-visible (system prompt promises this).
 *
 * Returns `{ expiredEntries }` where each entry carries path + access
 * + the expired timestamp. Empty array = no expired grants. Note:
 * walks ALL entries for the task (including non-permission ones)
 * and returns ONLY those that had additionalPermissions and have
 * expired since the last dispatch saw them.
 */
export function consumeExpiredAdditionalPermissionsForTask(
  taskId: string,
): Array<{ path: string; access: "read" | "write"; expiredAtMs: number }> {
  const now = Date.now();
  const entries = taskTrustLedger.get(taskId);
  if (!entries) return [];

  // Find expired entries with additionalPermissions
  const expired: Array<{ path: string; access: "read" | "write"; expiredAtMs: number }> = [];
  for (const entry of entries) {
    if (entry.toolKind !== "bash") continue;
    if (entry.expiry > now) continue;
    if (!entry.additionalPermissions?.file_system?.entries) continue;
    for (const fileEntry of entry.additionalPermissions.file_system.entries) {
      expired.push({
        path: fileEntry.path,
        access: fileEntry.access,
        expiredAtMs: entry.expiry,
      });
    }
  }
  // Side effect: drop expired entries from the ledger so the model
  // doesn't see the same grantsExpired notice on every subsequent
  // call. The notice is one-shot per dispatch.
  if (expired.length > 0) {
    const surviving = entries.filter((e) => e.expiry > now);
    if (surviving.length === 0) {
      taskTrustLedger.delete(taskId);
    } else {
      taskTrustLedger.set(taskId, surviving);
    }
  }
  return expired;
}

/**
 * Sandbox-elevation v4.3 §4.5 (codex Slice-3 review BLOCKER Q3c) —
 * subset check: is the model's REQUESTED profile fully covered by the
 * union of active trust grants?
 *
 * Returns the matched covering profile (or null). Used by the bash
 * dispatcher to decide whether to skip the v4 permission approval
 * gate: only skip when the model's request is ENTIRELY covered;
 * surface a delta approval otherwise.
 *
 * Write-covers-read: a request for `read:/a` is covered by a grant
 * of `write:/a` (but not the reverse). Network: `enabled:true`
 * request requires `enabled:true` grant.
 */
export function findCoveringPermissionGrant(
  taskId: string,
  requestedProfile: TrustEntry["additionalPermissions"],
): TrustEntry["additionalPermissions"] | null {
  if (!requestedProfile) return null;
  // Empty profile guard (codex final review Item #2 — defense in depth).
  // If the model passed an empty object `{}` (no network, no entries),
  // there's nothing to grant — return null rather than reporting coverage.
  // The bash dispatcher's v4WithPermsRequested check already filters this
  // out at the callsite, but we defend here too.
  const hasNetworkRequest = requestedProfile.network?.enabled === true;
  const hasFsRequest = (requestedProfile.file_system?.entries.length ?? 0) > 0;
  if (!hasNetworkRequest && !hasFsRequest) return null;

  const granted = findGrantedAdditionalPermissions(taskId, "bash");
  if (!granted) return null;

  // Network coverage
  if (requestedProfile.network?.enabled && !granted.network?.enabled) {
    return null;
  }

  // File-system coverage
  const grantedMap = new Map<string, "read" | "write">();
  for (const e of granted.file_system?.entries ?? []) {
    grantedMap.set(e.path, e.access);
  }
  for (const req of requestedProfile.file_system?.entries ?? []) {
    const grantedAccess = grantedMap.get(req.path);
    if (!grantedAccess) return null;
    // write covers read; read does NOT cover write
    if (req.access === "write" && grantedAccess === "read") return null;
  }
  return granted;
}

/**
 * Sandbox-elevation v4.3 §4.2 (codex+kimi Slice-3 review HIGH Q1a) —
 * inspect the soonest-expiring trust entry covering the requested
 * profile. Returns the entry's expiry timestamp so callers
 * (request_permissions tool) can map it to a scope label:
 *   - expiry > Date.now() + 1h  → "task" (durationMs=null → 72h cap)
 *   - expiry < Date.now() + 1h  → "turn" (5-min trust)
 *   - null (no covering entry)  → "turn" (user approved without trust)
 */
export function findCoveringPermissionGrantExpiry(
  taskId: string,
  requestedProfile: TrustEntry["additionalPermissions"],
): number | null {
  if (!requestedProfile) return null;
  // codex final-final review LOW — mirror the empty-profile guard from
  // findCoveringPermissionGrant. Empty `{}` requested profile would
  // otherwise return the longest-expiry ledger entry's timestamp,
  // misleading the scope reflection in request_permissions.
  const hasNetworkRequest = requestedProfile.network?.enabled === true;
  const hasFsRequest = (requestedProfile.file_system?.entries.length ?? 0) > 0;
  if (!hasNetworkRequest && !hasFsRequest) return null;

  const now = Date.now();
  const entries = taskTrustLedger.get(taskId);
  if (!entries) return null;

  let bestExpiry: number | null = null;
  for (const entry of entries) {
    if (entry.toolKind !== "bash") continue;
    if (entry.expiry <= now) continue;
    if (!entry.additionalPermissions) continue;
    // Check coverage of this single entry
    if (requestedProfile.network?.enabled && !entry.additionalPermissions.network?.enabled) continue;
    const grantedMap = new Map<string, "read" | "write">();
    for (const e of entry.additionalPermissions.file_system?.entries ?? []) {
      grantedMap.set(e.path, e.access);
    }
    let covers = true;
    for (const req of requestedProfile.file_system?.entries ?? []) {
      const grantedAccess = grantedMap.get(req.path);
      if (!grantedAccess) { covers = false; break; }
      if (req.access === "write" && grantedAccess === "read") { covers = false; break; }
    }
    if (!covers) continue;
    // Take the entry with the LONGEST remaining lifetime (best signal
    // of the actual scope the user picked).
    if (bestExpiry === null || entry.expiry > bestExpiry) {
      bestExpiry = entry.expiry;
    }
  }
  return bestExpiry;
}

export function addApprovalTrust(
  taskId: string,
  toolKind: ApprovalToolKind,
  subjectKey: string,
  /** Milliseconds the entry stays valid; null = until task end (capped
   *  at TASK_TRUST_MAX_DURATION_MS — v4.3 §4.5 crash-guard ceiling). */
  durationMs: number | null,
  extras?: { dangerousCommandPattern?: string; additionalPermissions?: TrustEntry["additionalPermissions"] },
): void {
  const expiry = durationMs === null
    ? Date.now() + TASK_TRUST_MAX_DURATION_MS
    : Date.now() + Math.max(0, durationMs);
  const list = taskTrustLedger.get(taskId) ?? [];
  list.push({
    toolKind,
    subjectKey,
    expiry,
    ...(extras?.dangerousCommandPattern ? { dangerousCommandPattern: extras.dangerousCommandPattern } : {}),
    ...(extras?.additionalPermissions ? { additionalPermissions: extras.additionalPermissions } : {}),
  });
  taskTrustLedger.set(taskId, list);
}

export function clearTaskApprovalTrust(taskId: string): void {
  taskTrustLedger.delete(taskId);
}

/** Test hook. */
export function __clearAllApprovalTrustForTests(): void {
  taskTrustLedger.clear();
}

/**
 * Generic approval primitive — used by both the bash danger gate
 * and the MCP tool-call gate. Caller passes `toolKind` so the
 * dashboard can render an appropriate prompt ("Approve dangerous
 * bash command?" vs "Approve MCP tool call to github?"). Resolves
 * to "approved" / "rejected" / "expired".
 *
 * The bash-specific path keeps using `createApproval` directly
 * (it adds danger-regex detection + Feishu notification on top of
 * this primitive). MCP tools always go through approval (gated by
 * per-server trustLevel in the pool), with no danger-regex.
 */
export async function requestApprovalForTool(input: {
  taskId: string;
  /** Per-prompt requestId — required for the web projector to attach
   *  the inline approval card to the correct exchange. Without it the
   *  event lands in a phantom no-id exchange and never renders. */
  requestId?: string;
  toolKind: "bash" | "mcp_tool";
  /** Trust-ledger subject — "*" for broad (bash), or e.g. serverId
   *  for MCP. If the (taskId, toolKind, subjectKey) is currently
   *  trusted, the gate auto-resolves "approved" without writing a
   *  DB row or firing UI events. */
  subjectKey?: string;
  summary: string;
  metadata: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<"approved" | "rejected" | "expired"> {
  const subjectKey = input.subjectKey ?? "*";
  if (isTrustedForApproval(input.taskId, input.toolKind, subjectKey)) {
    return "approved";
  }
  const approval = await createApproval(
    input.taskId,
    input.toolKind,
    input.metadata,
    input.summary,
    input.requestId,
  );
  return waitForApproval(approval.id, input.timeoutMs, input.signal);
}
