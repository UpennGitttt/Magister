import type { LeaderMessage } from "./autonomous-types";

export type ProgressArtifact = {
  completedSteps: string[];
  currentStep: string | null;
  modifiedFiles: string[];
  toolsUsed: string[];
  turnCount: number;
  /** Latest update_plan snapshot if any. Pulled from durable
   *  execution_events when buildProgressArtifactFromState is used. */
  plan?: Array<{
    content: string;
    activeForm: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
  /** Active teammate spawns belonging to this leader run. */
  activeTeammates?: Array<{ runId: string; roleId: string; state: string }>;
  /** Pending approvals (e.g. dangerous bash commands). */
  pendingApprovals?: Array<{ id: string; reason: string }>;
  /** Recent durable artifacts produced by this task. */
  recentArtifacts?: Array<{ name: string; kind: string }>;
  /** Files this session has already read at least once, ordered most
   *  recent first. Derived from `leader.tool_call` events with
   *  `toolName === "read_file"`. Used to inform the leader after
   *  compaction so it doesn't re-read files unnecessarily. */
  readFiles?: string[];
};

const FILE_TOOLS = new Set(["write_file", "edit_file", "read_file"]);

function toRecentStep(text: string): string {
  return text.slice(-200);
}

function isNonErrorToolResult(message: LeaderMessage): boolean {
  return message.type === "tool_result" && message.isError !== true;
}

function readFilePath(input: Record<string, unknown>): string | null {
  const pathValue = input.path;
  if (typeof pathValue === "string" && pathValue.trim().length > 0) {
    return pathValue;
  }

  const filePathValue = input.file_path;
  if (typeof filePathValue === "string" && filePathValue.trim().length > 0) {
    return filePathValue;
  }

  return null;
}

export function buildProgressArtifact(messages: LeaderMessage[]): ProgressArtifact {
  const completedSteps: string[] = [];
  const modifiedFiles = new Set<string>();
  const toolsUsed = new Set<string>();

  let currentStep: string | null = null;
  let turnCount = 0;

  for (const message of messages) {
    if (message.type === "user") {
      turnCount += 1;
      continue;
    }

    if (message.type === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          currentStep = toRecentStep(block.text);
          continue;
        }

        if (block.type === "tool_use") {
          toolsUsed.add(block.name);
          if (FILE_TOOLS.has(block.name)) {
            const filePath = readFilePath(block.input);
            if (filePath) {
              modifiedFiles.add(filePath);
            }
          }
        }
      }
      continue;
    }

    if (isNonErrorToolResult(message) && currentStep) {
      completedSteps.push(currentStep);
      currentStep = null;
    }
  }

  return {
    completedSteps: completedSteps.slice(-10),
    currentStep,
    modifiedFiles: [...modifiedFiles],
    toolsUsed: [...toolsUsed],
    turnCount,
  };
}

/**
 * Build a richer ProgressArtifact pulling from durable stores rather
 * than scanning the message log:
 *  - plan: latest `update_plan` tool_call event's `input.todos`
 *  - activeTeammates: role_runtimes rows with parentRunId === runId
 *    that are still RUNNING / QUEUED
 *  - pendingApprovals: open approvals for this task
 *  - recentArtifacts: latest 5 artifact rows by createdAt
 *
 * Falls back to the message-stream artifact for completed/current
 * step / files / toolsUsed since those don't have first-class durable
 * sources yet.
 *
 * Best-effort: any DB lookup failure degrades to the message-only
 * artifact so a flaky DB doesn't break compaction.
 */
export async function buildProgressArtifactFromState(
  messages: LeaderMessage[],
  context: { taskId: string; runId: string },
): Promise<ProgressArtifact> {
  const baseline = buildProgressArtifact(messages);

  const plan = await loadLatestPlan(context.taskId).catch(() => undefined);
  const activeTeammates = await loadActiveTeammates(context.taskId, context.runId).catch(() => undefined);
  const pendingApprovals = await loadPendingApprovals(context.taskId).catch(() => undefined);
  const recentArtifacts = await loadRecentArtifacts(context.taskId).catch(() => undefined);
  const readFiles = await loadReadFiles(context.taskId).catch(() => undefined);

  return {
    ...baseline,
    ...(plan && plan.length > 0 ? { plan } : {}),
    ...(activeTeammates && activeTeammates.length > 0 ? { activeTeammates } : {}),
    ...(pendingApprovals && pendingApprovals.length > 0 ? { pendingApprovals } : {}),
    ...(recentArtifacts && recentArtifacts.length > 0 ? { recentArtifacts } : {}),
    ...(readFiles && readFiles.length > 0 ? { readFiles } : {}),
  };
}

/**
 * Walks the task's `leader.tool_call` events for `read_file`
 * invocations and returns the deduped file paths, most recent first.
 *
 * Uses the typed `listByTaskIdAndType` query so we don't pay for
 * scanning leader.stream_delta events (which dominate volume by
 * ~100×). loadReadFiles runs every turn via
 * buildProgressArtifactFromState — kept O(tool_calls), not
 * O(all_events) .
 */
export async function loadReadFiles(taskId: string): Promise<string[] | undefined> {
  const { ExecutionEventRepository } = await import("../../../repositories/execution-event-repository");
  const repo = new ExecutionEventRepository();
  const events = await repo.listByTaskIdAndType(taskId, "leader.tool_call");
  const seen = new Set<string>();
  const orderedNewestFirst: string[] = [];
  // Events are returned DESC by seq, so iterating naturally gives
  // newest-first. Stop once we hit the cap.
  for (const ev of events) {
    let payload: { toolName?: string; input?: { path?: unknown; file_path?: unknown } } = {};
    try {
      payload = JSON.parse(ev.payloadJson ?? "{}");
    } catch {
      continue;
    }
    if (payload.toolName !== "read_file") continue;
    const rawPath =
      typeof payload.input?.path === "string" ? payload.input.path
      : typeof payload.input?.file_path === "string" ? payload.input.file_path
      : null;
    if (!rawPath) continue;
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    orderedNewestFirst.push(rawPath);
    // Cap at 50 — beyond that the prompt cost outweighs the value.
    if (orderedNewestFirst.length >= 50) break;
  }
  return orderedNewestFirst.length > 0 ? orderedNewestFirst : undefined;
}

async function loadLatestPlan(taskId: string): Promise<ProgressArtifact["plan"] | undefined> {
  const { ExecutionEventRepository } = await import("../../../repositories/execution-event-repository");
  const repo = new ExecutionEventRepository();
  // Typed query — only fetch leader.tool_call events. Avoids scanning
  // ~100× more leader.stream_delta events on long sessions (kimi
  // review of PR3). DESC order so we walk newest-first naturally.
  const events = await repo.listByTaskIdAndType(taskId, "leader.tool_call");
  for (const ev of events) {
    let payload: { toolName?: string; input?: { todos?: unknown } } = {};
    try {
      payload = JSON.parse(ev.payloadJson ?? "{}");
    } catch {
      continue;
    }
    if (payload.toolName !== "update_plan") continue;
    const todos = payload.input?.todos;
    if (!Array.isArray(todos)) continue;
    const out: NonNullable<ProgressArtifact["plan"]> = [];
    for (const t of todos) {
      if (!t || typeof t !== "object") continue;
      const r = t as Record<string, unknown>;
      const content = typeof r.content === "string" ? r.content : "";
      const activeForm = typeof r.activeForm === "string" ? r.activeForm : "";
      const status = typeof r.status === "string" ? r.status : "";
      if (
        !content
        || (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled")
      ) continue;
      out.push({ content, activeForm, status });
    }
    return out;
  }
  return undefined;
}

async function loadActiveTeammates(
  taskId: string,
  parentRunId: string,
): Promise<ProgressArtifact["activeTeammates"] | undefined> {
  const { RoleRuntimeRepository } = await import("../../../repositories/role-runtime-repository");
  const runtimes = await new RoleRuntimeRepository().listByTaskId(taskId);
  const active = runtimes
    .filter((r) => r.parentRunId === parentRunId)
    .filter((r) => r.state === "RUNNING" || r.state === "QUEUED")
    .map((r) => ({ runId: r.id, roleId: r.roleId, state: r.state }));
  return active;
}

async function loadPendingApprovals(
  taskId: string,
): Promise<ProgressArtifact["pendingApprovals"] | undefined> {
  const { ApprovalRepository } = await import("../../../repositories/approval-repository");
  const approvals = await new ApprovalRepository().listByTaskId(taskId);
  return approvals
    .filter((a) => a.state === "pending")
    .map((a) => {
      // approvalType is short ("dangerous_command", "tool_use", etc.).
      // Pull a richer reason from payload_json when available so the
      // leader sees why the approval is gating it. Precedence:
      // explicit `reason` > `message` > `command` (the actual command
      // string is often the most useful signal for dangerous-bash
      // approvals — kimi review).
      let reason = a.approvalType;
      try {
        const payload = a.payloadJson ? JSON.parse(a.payloadJson) : null;
        if (payload && typeof payload === "object") {
          const r = payload as { reason?: string; message?: string; command?: string };
          const payloadReason = r.reason ?? r.message ?? r.command;
          if (typeof payloadReason === "string" && payloadReason.length > 0) {
            reason = `${a.approvalType}: ${payloadReason.slice(0, 120)}`;
          }
        }
      } catch {}
      return { id: a.id, reason };
    });
}

async function loadRecentArtifacts(
  taskId: string,
): Promise<ProgressArtifact["recentArtifacts"] | undefined> {
  const { ArtifactRepository } = await import("../../../repositories/artifact-repository");
  const all = await new ArtifactRepository().listByTaskId(taskId);
  // listByTaskId order isn't guaranteed — use createdAt to grab the
  // newest 5. Reverse-sort defensively in case the underlying query
  // returns in any order.
  const sorted = [...all].sort((a, b) => {
    const aTs = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const bTs = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    return bTs - aTs;
  });
  return sorted.slice(0, 5).map((a) => ({
    name: a.title,
    kind: a.artifactType,
  }));
}

export function formatProgressForInjection(artifact: ProgressArtifact): string {
  const completedLines = artifact.completedSteps.length > 0
    ? artifact.completedSteps.map((step) => `  ✓ ${step}`).join("\n")
    : "  ✓ (none)";

  const current = artifact.currentStep ?? "(none)";
  const modifiedFiles = artifact.modifiedFiles.length > 0
    ? artifact.modifiedFiles.join(", ")
    : "(none)";
  const toolsUsed = artifact.toolsUsed.length > 0
    ? artifact.toolsUsed.join(", ")
    : "(none)";

  const sections: string[] = [
    "[Session Progress]",
    `Completed:\n${completedLines}`,
    `Current: ${current}`,
    `Files touched: ${modifiedFiles}`,
    `Tools used: ${toolsUsed}`,
    `Turns completed: ${artifact.turnCount}`,
  ];

  if (artifact.plan && artifact.plan.length > 0) {
    const planLines = artifact.plan
      .map((t) => {
        const glyph =
          t.status === "completed" ? "✔"
          : t.status === "in_progress" ? "▶"
          : t.status === "cancelled" ? "⊘"
          : "□";
        const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return `  ${glyph} ${label}`;
      })
      .join("\n");
    sections.push(`Current plan:\n${planLines}`);
  }
  if (artifact.activeTeammates && artifact.activeTeammates.length > 0) {
    const lines = artifact.activeTeammates
      .map((t) => `  - ${t.roleId} (${t.runId}, state=${t.state})`)
      .join("\n");
    sections.push(`Active teammates:\n${lines}`);
  }
  if (artifact.pendingApprovals && artifact.pendingApprovals.length > 0) {
    const lines = artifact.pendingApprovals
      .map((a) => `  - ${a.id}: ${a.reason}`)
      .join("\n");
    sections.push(`Pending approvals:\n${lines}`);
  }
  if (artifact.recentArtifacts && artifact.recentArtifacts.length > 0) {
    const lines = artifact.recentArtifacts
      .map((a) => `  - ${a.kind}: ${a.name}`)
      .join("\n");
    sections.push(`Recent artifacts:\n${lines}`);
  }
  if (artifact.readFiles && artifact.readFiles.length > 0) {
    // Cap at 20 in the rendered block — the full list is preserved
    // in the artifact and used for compaction's extraContext, but
    // the inline [Session Progress] panel doesn't need all 50.
    const shown = artifact.readFiles.slice(0, 20);
    const tail = artifact.readFiles.length > shown.length
      ? `\n  …and ${artifact.readFiles.length - shown.length} more`
      : "";
    sections.push(`Already read this session (most recent first):\n${shown.map((p) => `  - ${p}`).join("\n")}${tail}`);
  }

  return sections.join("\n");
}
