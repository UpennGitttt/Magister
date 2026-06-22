import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";
import { TaskMailboxRepository } from "../repositories/task-mailbox-repository";
import { TaskMediaRepository } from "../repositories/task-media-repository";
import { TaskSummaryStore } from "../observability/task-summary-store";
import { taskEventBus } from "../sse/task-event-bus";
import { cleanupTaskArtifacts } from "../services/cleanup-artifacts-service";
import { processTaskIntent } from "../services/process-task-intent-service";
import { getAbortController, isTaskQueued, taskWorker } from "../services/task-worker";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { getTaskContext } from "../services/get-task-context-service";
import { getTaskOrchestrationHistory } from "../services/get-task-orchestration-history-service";
import { getTaskMemoryView } from "../services/get-task-memory-view-service";
import { getTaskSummary } from "../services/get-task-service";
import { buildTaskTree } from "../services/build-task-tree-service";
import { listTaskArtifacts } from "../services/list-task-artifacts-service";
import { listTaskSummaries } from "../services/list-tasks-service";
import { FOLLOWUP_ROLE_IDS } from "../services/planner-hints";
import { getProjectSpec } from "../services/project-spec-service";
import { getRecentUsage, getTaskUsage } from "../services/token-usage-service";
import { getTaskTurnSummaries } from "../services/turn-summary-service";

const managerHintsSchema = z.object({
  taskType: z.enum(["conversation", "coding", "mixed"]).optional(),
  goal: z.string().min(1).optional(),
  needsHuman: z.boolean().optional(),
  stopCondition: z
    .enum(["reply_sent", "implementation_ready", "review_ready", "landing_ready"])
    .optional(),
  coordinationAction: z
    .enum(["direct_answer", "tool_answer", "clarify", "assign", "handoff", "send_message"])
    .optional(),
  childRuns: z
    .array(
      z.object({
        roleId: z.enum(FOLLOWUP_ROLE_IDS),
        dependsOn: z.array(z.enum(FOLLOWUP_ROLE_IDS)).optional(),
        goal: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

// Single attachment entry — the frontend reads the file in
// JS, base64-encodes it, and sends inside the JSON body. Phase 1
// is image-only; documents (PDF / DOCX / XLSX) plug in via a
// separate processing path in a future commit.
const attachmentSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  dataBase64: z.string().min(1),
});

const createTaskSchema = z.object({
  prompt: z.string().min(1),
  source: z.enum(["cli", "web", "feishu"]),
  workspaceId: z.string().min(1),
  rootChannelBindingId: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional(),
  plannerHints: managerHintsSchema.optional(),
  taskManagerHints: managerHintsSchema.optional(),
  /** When true the leader's system prompt picks up a plan-mode
   *  addendum for THIS turn (spec §3, §11). Per-message; toggling
   *  off restores normal agent self-judgment. */
  planFirst: z.boolean().optional(),
  /** Files attached to this turn's prompt. Phase 1 = images only;
   *  attachment-service.ts validates the mime whitelist + size cap
   *  and rejects offending entries with a structured warning event
   *  rather than failing the whole task. Cap on count is enforced
   *  here to bound JSON parse cost. */
  attachments: z.array(attachmentSchema).max(10).optional(),
  /** MCP-rendered prompt messages — see ProcessTaskIntentInput.
   *  Phase 2: optional; absent for ordinary chat. */
  promptMessages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.any(),  // SDK union; we trust it through to the projection helper.
    }),
  ).optional(),
  /** Goal mode (Ralph loop). When set, the task runs as an
   *  autonomous goal: after each leader turn, if the model didn't
   *  call `mark_goal_complete`, the worker auto-injects a
   *  continuation mailbox row and re-enqueues. Stops on
   *  `mark_goal_complete`, user cancel/pause, or wall-time. The
   *  `prompt` field carries the initial user instruction; the
   *  `objective` field is the durable goal text the loop refers
   *  back to each iteration. Usually identical, but the user can
   *  separate them (e.g. send "let me know when you're done" as
   *  the immediate prompt and a longer doc as the objective). */
  goal: z.object({
    objective: z.string().min(1),
    /** Hard wall-clock safety. NULL/undefined = unlimited. */
    maxWallSeconds: z.number().int().positive().optional(),
  }).optional(),
});

const COMPLETED_TASK_STATES = new Set(["COMPLETED", "DONE", "MERGE_WAITING", "PR_OPEN"]);
const FAILED_TASK_STATES = new Set(["FAILED", "BLOCKED", "CANCELLED"]);
const DEFAULT_SESSION_PERF_LOG_MS = 250;

function sessionPerfLogThresholdMs(): number {
  const raw = process.env.MAGISTER_SESSION_PERF_LOG_MS;
  if (raw === undefined) {
    return DEFAULT_SESSION_PERF_LOG_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_PERF_LOG_MS;
}

function maybeLogSessionPerf(
  route: string,
  startedAt: number,
  fields: Record<string, unknown>,
): void {
  const durationMs = Date.now() - startedAt;
  if (durationMs < sessionPerfLogThresholdMs()) {
    return;
  }
  console.info(`[session-perf] ${route} ${JSON.stringify({ ...fields, durationMs })}`);
}

function getStartOfTodayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Backfill: tasks that reached a terminal `tasks.state` without a
 * corresponding `task:completed/failed/cancelled` execution_event.
 * The chatStore projector treats absence-of-terminal as "still streaming"
 * so the chat surface shows the exchange perpetually "Working…" on
 * long-DONE tasks. Mutates `events` in place: appends a stand-in
 * terminal when the task's stored state contradicts the event stream.
 * Used by /tasks/:id/stream AND /tasks/:id/snapshot.
 */
function maybeAppendSyntheticTerminal(
  events: Array<Record<string, unknown>>,
  taskSummary: { id: string; state?: string | null; workspaceId?: string | null; updatedAt?: string | Date | null } | null,
): void {
  if (!taskSummary) return;
  const stateLower = String(taskSummary.state ?? "").toLowerCase();
  const stateMap: Record<string, "task:completed" | "task:failed" | "task:cancelled"> = {
    done: "task:completed",
    completed: "task:completed",
    paused: "task:completed",
    failed: "task:failed",
    cancelled: "task:cancelled",
  };
  const wantedType = stateMap[stateLower];
  if (!wantedType) return;
  // Find the latest requestId in any event (scanning back, not just
  // the last). Pre-PR-1 legacy tasks have all-null requestIds and the
  // chatStore projector can't match a terminal to any exchange
  // without one — skip emission entirely in that case; those tasks
  // render via the legacy messages fallback path which doesn't need
  // terminal events.
  if (events.length === 0) return;
  const lastEvent = events[events.length - 1]!;
  const lastSeq = (lastEvent as { seq?: number | null }).seq ?? 0;
  let lastRequestId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const candidate = (events[i] as { requestId?: string | null }).requestId;
    if (typeof candidate === "string" && candidate.length > 0) {
      lastRequestId = candidate;
      break;
    }
  }
  if (lastRequestId === null) return;
  const hasTerminalForLatestRequest = events.some(
    (e) =>
      ((e.type === "task:completed" ||
        e.type === "task:failed" ||
        e.type === "task:cancelled") &&
        (e as { requestId?: string | null }).requestId === lastRequestId),
  );
  if (hasTerminalForLatestRequest) return;
  events.push({
    id: `synthetic_terminal_${taskSummary.id}_${lastSeq + 1}`,
    type: wantedType,
    taskId: taskSummary.id,
    roleRuntimeId: null,
    executorSessionId: null,
    approvalId: null,
    artifactId: null,
    conversationBindingId: null,
    workspaceId: taskSummary.workspaceId ?? null,
    severity: "info",
    occurredAt: new Date(taskSummary.updatedAt ?? Date.now()).toISOString(),
    payloadJson: JSON.stringify({
      taskId: taskSummary.id,
      requestId: lastRequestId,
      state: taskSummary.state,
      finalAnswer: null,
      synthetic: true,
    }),
    seq: lastSeq + 1,
    requestId: lastRequestId,
  });
}

function readTeammateName(payloadJson?: string | null): string | null {
  if (!payloadJson) {
    return null;
  }

  try {
    const payload = JSON.parse(payloadJson) as { teammateName?: unknown };
    if (typeof payload.teammateName === "string" && payload.teammateName.trim().length > 0) {
      return payload.teammateName.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}

async function resolveTaskMediaStoragePath(taskId: string, storagePath: string): Promise<string | null> {
  try {
    const root = await realpath(join(process.cwd(), ".magister", "media", "outbound", taskId));
    const target = await realpath(storagePath);
    return isPathInside(root, target) ? target : null;
  } catch {
    return null;
  }
}

export async function registerTaskRoutes(app: FastifyInstance) {
  const taskSummaryStore = new TaskSummaryStore();
  const executionEventRepository = new ExecutionEventRepository();

  app.post("/tasks", async (request, reply) => {
    const input = createTaskSchema.parse(request.body);
    // Resolve default workspaceId from the registry rather than the
    // legacy "workspace_main" string literal. Path A landed first-
    // class workspaces; the registry's default row is the source of
    // truth for "what workspace does this task land in if the
    // caller didn't say?". Falls back to the literal for the brief
    // window between Path-A migration and first-boot bootstrap.
    let resolvedWorkspaceId = input.workspaceId;
    if (!resolvedWorkspaceId) {
      const { WorkspaceRepository } = await import(
        "../repositories/workspace-repository"
      );
      const fallback = await new WorkspaceRepository().getDefault().catch(() => null);
      resolvedWorkspaceId = fallback?.id ?? "workspace_main";
    }
    const result = await processTaskIntent({
      prompt: input.prompt,
      source: input.source ?? "web",
      workspaceId: resolvedWorkspaceId,
      ...(input.rootChannelBindingId ? { channelBindingId: input.rootChannelBindingId } : {}),
      ...(input.planFirst === true ? { planFirst: true } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.promptMessages && input.promptMessages.length > 0
        ? { promptMessages: input.promptMessages }
        : {}),
      ...(input.goal
        ? {
            goal: {
              objective: input.goal.objective,
              ...(input.goal.maxWallSeconds != null
                ? { maxWallSeconds: input.goal.maxWallSeconds }
                : {}),
            },
          }
        : {}),
      ...(input.plannerHints ? { plannerHints: input.plannerHints } : {}),
      ...(input.taskManagerHints ? { taskManagerHints: input.taskManagerHints } : {}),
    });

    reply.status(201);
    return {
      ok: true,
      data: {
        taskId: result.taskId,
        runId: result.runId,
        requestId: result.requestId,
        action: result.action,
        reason: result.reason,
        status: result.status,
      },
    };
  });

  app.post("/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) {
      reply.status(404);
      return { ok: false, error: "Task not found" };
    }
    const cancelAt = new Date();
    await taskRepo.update(taskId, {
      state: "CANCELLED",
      updatedAt: cancelAt,
      // Cancelling the task also cancels any active goal — keeps
      // goal_status from drifting out of sync with the task state.
      // Freeze the elapsed-time timer at the cancel moment.
      ...(task.goalObjective && task.goalStatus !== "complete"
        ? { goalStatus: "cancelled" as const, goalCompletedAt: cancelAt.getTime() }
        : {}),
    });
    // A task can be QUEUED (no AbortController yet) or ACTIVE
    // (running, controller exists). Cancel both paths:
    //   1) cancelQueued() drops it from the pool's queue and flips
    //      role_runtime to CANCELLED (recovery scan won't pick it up).
    //   2) AbortController.abort() interrupts the in-flight loop.
    // Both calls are independently safe; checking which one applies
    // would race with the worker's tryStart-on-finish hand-off.
    const cancelledFromQueue = taskWorker.cancelQueued(taskId);
    if (cancelledFromQueue) {
      const runtimeRepo = new RoleRuntimeRepository();
      const runtimes = await runtimeRepo.listByTaskId(taskId);
      const completedAt = new Date();
      for (const rt of runtimes) {
        if (rt.state === "RUNNING" || rt.state === "PENDING") {
          await runtimeRepo.update(rt.id, {
            state: "CANCELLED",
            updatedAt: completedAt,
            completedAt,
          });
        }
      }
    }
    const ac = getAbortController(taskId);
    if (ac) ac.abort("cancelled");

    // Propagate cancellation to RUNNING background teammates spawned by
    // this task. The parent's AbortController (above) already signals
    // in-process teammate loops (they share the same controller via
    // context.abortController). We just need to mark their runtime rows
    // CANCELLED so recovery doesn't attempt to requeue them.
    try {
      const { RoleRuntimeRepository } = await import("../repositories/role-runtime-repository");
      const bgRuntimeRepo = new RoleRuntimeRepository();
      const backgroundTeammates = await bgRuntimeRepo.listActiveBackgroundTeammates(taskId);
      const cancelAt = new Date();
      for (const rt of backgroundTeammates) {
        await bgRuntimeRepo.update(rt.id, {
          state: "CANCELLED",
          completedAt: cancelAt,
          updatedAt: cancelAt,
        });
      }
    } catch {
      // Best-effort — cancellation is already signalled via AbortController.
    }

    return { ok: true, data: { taskId, state: "CANCELLED" } };
  });

  app.get("/tasks/:taskId/active-teammates", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { RoleRuntimeRepository } = await import("../repositories/role-runtime-repository");
    const runtimeRepo = new RoleRuntimeRepository();
    const active = await runtimeRepo.listActiveBackgroundTeammates(taskId);
    const now = Date.now();
    return {
      ok: true,
      data: {
        active: active.map((rt) => ({
          runId: rt.id,
          role: rt.roleId,
          state: rt.state,
          spawnedAtMs: rt.startedAt ? rt.startedAt.getTime() : rt.updatedAt.getTime(),
          elapsedSec: Math.floor((now - (rt.startedAt ?? rt.updatedAt).getTime()) / 1000),
        })),
      },
    };
  });

  app.post("/tasks/:taskId/compact", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = (request.body ?? {}) as { hint?: string };
    const hint = typeof body.hint === "string" ? body.hint.slice(0, 500) : null;
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) {
      reply.status(404);
      return { ok: false, error: "Task not found" };
    }
    const eventRepo = new ExecutionEventRepository();
    await eventRepo.create({
      id: `event_${crypto.randomUUID()}`,
      type: "leader.compact_requested",
      taskId,
      severity: "info",
      payloadJson: JSON.stringify({ hint }),
      occurredAt: new Date(),
    });
    return { ok: true, data: { queued: true } };
  });

  // User-initiated task delete — drops the row + every child table the
  // retention sweeper would (events, runtimes, runtime-workspaces,
  // approvals, artifacts, attachments, mailbox) and purges the on-disk
  // upload dir + memory scratchpad. Passes `force: true` so non-
  // terminal states are also deletable; the leader-loop abort is
  // triggered in the same way as cancel so a running task doesn't keep
  // writing into rows that are about to disappear.
  // Board "Attention" column dismissal — UI-only signal. Sets a
  // timestamp the Board's `mapTaskToColumn` reads to bucket the task
  // as "completed" instead of "attention", without rewriting the
  // task's actual state (which stays FAILED / BLOCKED / etc. for
  // downstream consumers — feishu projector, metrics, sidebar). The
  // DELETE variant clears the flag for undo within the toast window.
  app.put("/tasks/:taskId/attention-dismiss", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const existing = await taskRepo.getById(taskId);
    if (!existing) {
      reply.status(404);
      return { ok: false, error: "Task not found" };
    }
    const now = new Date();
    await taskRepo.update(taskId, { attentionDismissedAt: now, updatedAt: now });
    return { ok: true, data: { taskId, attentionDismissedAt: now.getTime() } };
  });

  app.delete("/tasks/:taskId/attention-dismiss", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const existing = await taskRepo.getById(taskId);
    if (!existing) {
      reply.status(404);
      return { ok: false, error: "Task not found" };
    }
    await taskRepo.update(taskId, { attentionDismissedAt: null, updatedAt: new Date() });
    return { ok: true, data: { taskId, attentionDismissedAt: null } };
  });

  app.delete("/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) {
      reply.status(404);
      return { ok: false, error: "Task not found" };
    }
    // If the task is still active, abort the leader loop before the
    // delete lands so it can't write a flurry of doomed events.
    const ac = getAbortController(taskId);
    if (ac) ac.abort("deleted");
    taskWorker.cancelQueued(taskId);
    const { deleteTaskRowAndChildren } = await import(
      "../services/task-retention-service"
    );
    const removed = await deleteTaskRowAndChildren(taskId, { force: true });
    if (!removed) {
      reply.status(409);
      return { ok: false, error: "Task could not be deleted" };
    }
    // Drop in-memory trust-ledger entries for this task. Normal
    // task-end is covered by worker terminal paths; this is the
    // explicit-delete path which bypasses the worker.
    try {
      const { clearTaskApprovalTrust } = await import(
        "../services/command-approval-service"
      );
      clearTaskApprovalTrust(taskId);
    } catch { /* best-effort */ }
    return { ok: true, data: { taskId, deleted: true } };
  });

  // ── Goal mode controls ──────────────────────────────────────
  // Pause / Resume / Cancel for the Ralph loop. Operate on the
  // task's goal_status only — they don't touch task.state. The
  // worker's Ralph hook checks goal_status === "active" before
  // re-enqueuing, so flipping to "paused" or "cancelled" stops
  // continuation on the next turn boundary.

  // Mid-conversation goal start. Operates on an existing non-terminal
  // task without an active goal. Token + wall budgets count from the
  // start instant (pre-goal turns are NOT charged).
  app.post("/tasks/:taskId/goal/start", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const startSchema = z.object({
      objective: z.string().min(1),
      tokenBudget: z.number().int().positive().optional(),
      maxWallSeconds: z.number().int().positive().optional(),
    });
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(422);
      return {
        ok: false,
        error: {
          code: "invalid_objective",
          message: parsed.error.issues.map((e: { message: string }) => e.message).join("; "),
        },
      };
    }
    const { startGoalOnExistingTask } = await import(
      "../services/goal-mode/start-goal-service"
    );
    const result = await startGoalOnExistingTask({
      taskId,
      objective: parsed.data.objective,
      ...(parsed.data.tokenBudget !== undefined ? { tokenBudget: parsed.data.tokenBudget } : {}),
      ...(parsed.data.maxWallSeconds !== undefined ? { maxWallSeconds: parsed.data.maxWallSeconds } : {}),
    });
    if (!result.ok) {
      const status = result.error.code === "task_not_found"
        ? 404
        : result.error.code === "invalid_objective"
          ? 422
          : 409;
      reply.status(status);
      return result;
    }
    return result;
  });

  // Context-aware objective optimizer. Reads the leader's checkpoint,
  // snips to 100K tokens, and makes a one-shot LLM call to rewrite the
  // raw objective as a self-contained, context-rich string. Read-only:
  // does not mutate task state or leader history.
  app.post("/tasks/:taskId/goal/optimize", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = (request.body ?? {}) as { objective?: string };
    const { optimizeObjective } = await import(
      "../services/goal-mode/optimize-objective-service"
    );
    const result = await optimizeObjective({
      taskId,
      objective: typeof body.objective === "string" ? body.objective : "",
    });
    if (!result.ok) {
      const statusByCode: Record<string, number> = {
        task_not_found: 404,
        invalid_objective: 400,
        task_terminal: 409,
        goal_already_active: 409,
        no_leader_session: 409,
        model_call_failed: 502,
      };
      reply.status(statusByCode[result.error.code] ?? 500);
      return { ok: false, error: result.error };
    }
    return result;
  });

  // /model — per-task leader model override.
  //
  // GET returns the current effective model (override or agent default) so
  // the picker can highlight the current selection.
  //
  // POST writes `tasks.model_override` (NULL clears). Takes effect at the
  // next runtime spawn boundary — there is no hot-swap of an in-flight
  // turn.
  //
  // Cross-dialect warning gate: when switching dialects, the first POST
  // returns `{ ok: false, requiresWarning: true }` WITHOUT writing.
  // Client must repeat with `confirm: true` to actually commit. This
  // makes the Confirm/Cancel dialog server-authoritative instead of
  // client-theater that left the override in DB even when the user
  // cancelled.
  //
  // Both GET and POST resolve the "default model" via the same chain
  // the real leader uses: prefer `resolveAgentForRole("leader")` (the
  // Magister agent-resolution path), then fall back to the legacy
  // `resolveApiConfigFromRoleRouting`. Otherwise the picker shows a
  // "default" that doesn't match what would actually run.
  //
  // The helper that does this is co-located here because both routes
  // need identical resolution semantics.
  async function resolveLeaderBaseApiConfig(): Promise<{
    provider: import("../providers/types").ProviderConfig;
    model: import("../providers/types").ModelProfile;
    binding: import("../providers/types").ExecutorBinding;
  } | null> {
    const { resolveAgentForRole } = await import("../services/agent-resolution-service");
    const { buildApiConfigFromAgent, resolveApiConfigFromRoleRouting } = await import(
      "../services/process-task-intent-service"
    );
    const { readExecutorConfigFile } = await import("../services/executor-config-service");
    try {
      const leaderAgentConfig = await resolveAgentForRole("leader");
      if (
        leaderAgentConfig &&
        leaderAgentConfig.runtimeType === "ucm" &&
        leaderAgentConfig.provider &&
        leaderAgentConfig.modelName.trim().length > 0
      ) {
        return buildApiConfigFromAgent(leaderAgentConfig);
      }
    } catch {
      // fall through to legacy
    }
    try {
      const config = await readExecutorConfigFile();
      return resolveApiConfigFromRoleRouting(config);
    } catch {
      return null;
    }
  }

  app.get("/tasks/:taskId/model", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepoLocal = new TaskRepository();
    const task = await taskRepoLocal.getById(taskId);
    if (!task) {
      reply.status(404);
      return { ok: false, error: { code: "task_not_found", message: "Task not found" } };
    }
    const baseResolved = await resolveLeaderBaseApiConfig();
    if (!baseResolved) {
      reply.status(500);
      return { ok: false, error: { code: "no_default_model", message: "Could not resolve default leader model" } };
    }
    const { applyModelOverrideToApiConfig } = await import("../services/process-task-intent-service");
    const { readExecutorConfigFile } = await import("../services/executor-config-service");
    const config = await readExecutorConfigFile();
    const effective = task.modelOverride
      ? applyModelOverrideToApiConfig(baseResolved, task.modelOverride, config)
      : baseResolved;
    return {
      ok: true,
      data: {
        override: task.modelOverride ?? null,
        effective: {
          modelName: effective.model.modelName,
          providerId: effective.provider.id,
          providerLabel: effective.provider.label ?? effective.provider.id,
          apiDialect: effective.provider.apiDialect,
          contextWindow: effective.model.contextWindow ?? null,
        },
        defaultModel: {
          modelName: baseResolved.model.modelName,
          providerId: baseResolved.provider.id,
        },
      },
    };
  });

  app.post("/tasks/:taskId/model", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const body = (request.body ?? {}) as {
      modelName?: string | null;
      confirm?: boolean;
      // Compare-and-swap on the override value. Client passes the
      // override it saw at GET time; if the actual current value
      // differs, the server returns 409 stale_override with the
      // current value so the UI can re-prompt rather than silently
      // overwriting another tab's switch. Omitted = no CAS check
      // (inline `/model X` shortcut path, last-writer-wins).
      expectedOverride?: string | null;
    };
    const hasExpectedOverride = Object.prototype.hasOwnProperty.call(body, "expectedOverride");
    const taskRepoLocal = new TaskRepository();
    const task = await taskRepoLocal.getById(taskId);
    if (!task) {
      reply.status(404);
      return { ok: false, error: { code: "task_not_found", message: "Task not found" } };
    }
    // NOTE: terminal tasks (DONE/FAILED/CANCELLED) are intentionally
    // allowed to set a model override. A finished conversation can still
    // receive a follow-up message that re-wakes the leader (POST
    // /tasks/:taskId/messages), and that resume path applies
    // `tasks.model_override` (process-task-intent-service). So switching
    // the model on a finished task IS meaningful — the next turn uses it.
    // Previously this returned 409 task_terminal, which blocked the
    // natural "reply to a finished chat with a different model" flow.

    // Pre-flight CAS short-circuit: if the snapshot we just read
    // already differs from the client's expectation, fail fast. The
    // authoritative atomic CAS happens at write time below, but
    // catching it here lets us skip the validation + resolver work.
    if (hasExpectedOverride) {
      const expected = body.expectedOverride ?? null;
      const current = task.modelOverride ?? null;
      if (expected !== current) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "stale_override",
            message: "Another writer changed the model override between fetch and commit; refresh and retry.",
            expected,
            current,
          },
        };
      }
    }

    const raw = typeof body.modelName === "string" ? body.modelName.trim() : "";
    const next: string | null = raw.length > 0 ? raw : null;
    const confirm = body.confirm === true;

    if (next === null && (task.modelOverride ?? null) === null) {
      return {
        ok: true,
        data: {
          modelOverride: null,
          requiresWarning: false,
          fromDialect: null,
          toDialect: null,
        },
      };
    }

    const { readExecutorConfigFile } = await import("../services/executor-config-service");
    const config = await readExecutorConfigFile();

    if (next !== null) {
      const modelRecord = config.models[next];
      if (!modelRecord) {
        reply.status(400);
        return { ok: false, error: { code: "unknown_model", message: `Model '${next}' is not in config.models` } };
      }
      const providerId = modelRecord.providerRefs?.api;
      if (!providerId || !config.providers[providerId]) {
        reply.status(400);
        return { ok: false, error: { code: "provider_unconfigured", message: `Model '${next}' has no configured API provider` } };
      }
    }

    // Compute cross-dialect warning hint against the SAME resolver the
    // leader actually uses. Picker showed wrong "default" when this
    // diverged from the executeLeaderLoop resolution chain.
    //
    // Fail-CLOSED on resolver error: if anything throws here we cannot
    // be sure the user isn't crossing dialects, so we require confirm.
    // (Prior version defaulted requiresWarning=false on throw, which
    // meant a resolver failure silently let writes through with no
    // dialect warning — a fail-open bug flagged by glm-5.1 review.)
    let requiresWarning = false;
    let fromDialect: string | null = null;
    let toDialect: string | null = null;
    let fromModelName: string | null = null;
    let toModelName: string | null = next;
    try {
      const baseResolved = await resolveLeaderBaseApiConfig();
      if (!baseResolved) {
        throw new Error("Could not resolve leader base config");
      }
      const { applyModelOverrideToApiConfig } = await import("../services/process-task-intent-service");
      const current = task.modelOverride
        ? applyModelOverrideToApiConfig(baseResolved, task.modelOverride, config)
        : baseResolved;
      const after = next
        ? applyModelOverrideToApiConfig(baseResolved, next, config)
        : baseResolved;
      fromDialect = current.provider.apiDialect;
      toDialect = after.provider.apiDialect;
      // Send the EFFECTIVE current model name (not the override slot,
      // which is null when on default). Picker was showing "from: null".
      fromModelName = current.model.modelName ?? null;
      toModelName = after.model.modelName ?? next;
      requiresWarning = fromDialect !== toDialect;
    } catch (err) {
      console.warn("[model-switch] hint computation failed, defaulting to confirm-required:", err instanceof Error ? err.message : String(err));
      requiresWarning = true;
    }

    // Server-authoritative confirmation gate: dialect change (or
    // resolver failure, fail-closed) without `confirm: true` returns
    // the warning hint and does NOT write. This replaces the prior
    // client-only confirm dialog (which left the override in DB even
    // when the user clicked Cancel).
    //
    // The `from` / `to` metadata is folded into `error.details` so the
    // client's request() helper preserves them via ApiError.details.
    if (requiresWarning && !confirm) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "confirm_required",
          message: "Cross-dialect switch requires confirm:true",
          from: { modelName: fromModelName, apiDialect: fromDialect },
          to: { modelName: toModelName, apiDialect: toDialect },
        },
      };
    }

    // Atomic CAS write when expectedOverride was supplied. Closes the
    // TOCTOU window between the pre-flight check above and this
    // write — the leader's own inline `/model X` path (and any other
    // writer) could land between them. On 0 rows updated the actual
    // value has drifted; re-fetch and return stale_override.
    if (hasExpectedOverride) {
      const expected = body.expectedOverride ?? null;
      const changes = await taskRepoLocal.casUpdateModelOverride(taskId, expected, next);
      if (changes === 0) {
        const refreshed = await taskRepoLocal.getById(taskId);
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "stale_override",
            message: "Another writer changed the model override during commit; refresh and retry.",
            expected,
            current: refreshed?.modelOverride ?? null,
          },
        };
      }
    } else {
      await taskRepoLocal.update(taskId, { modelOverride: next, updatedAt: new Date() });
    }

    // Telemetry event so the projector can render a system notice.
    try {
      const eventRepo = new ExecutionEventRepository();
      await eventRepo.create({
        id: `model_switched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "leader.model_switched",
        taskId,
        roleRuntimeId: null,
        requestId: null,
        occurredAt: new Date(),
        payloadJson: JSON.stringify({
          from: fromModelName ?? task.modelOverride ?? null,
          to: next,
          fromDialect,
          toDialect,
          requiresWarning,
        }),
      });
    } catch {
      // best-effort; the override write itself is the source of truth.
    }

    return {
      ok: true,
      data: { modelOverride: next, requiresWarning, fromDialect, toDialect },
    };
  });

  // Slash query endpoints (read-only). Power the chat-input slash
  // commands: zero-cost peeks at goal state without mailbox or LLM.
  app.get("/tasks/:taskId/goal/plan", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo2 = new TaskRepository();
    const task = await taskRepo2.getById(taskId);
    if (!task) { reply.status(404); return { ok: false, error: { code: "task_not_found", message: "Task not found" } }; }
    if (!task.goalObjective) {
      reply.status(409);
      return { ok: false, error: { code: "no_active_goal", message: "Task has no goal" } };
    }
    try {
      const { readPlan } = await import("../services/goal-mode/plan-file-service");
      const planMd = await readPlan(taskId, task.workspaceId);
      return { ok: true, data: { planMd: planMd ?? "", planPath: task.goalPlanPath ?? null } };
    } catch (err) {
      reply.status(500);
      return { ok: false, error: { code: "plan_read_failed", message: err instanceof Error ? err.message : String(err) } };
    }
  });

  app.get("/tasks/:taskId/goal/evaluator", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo2 = new TaskRepository();
    const task = await taskRepo2.getById(taskId);
    if (!task) { reply.status(404); return { ok: false, error: { code: "task_not_found", message: "Task not found" } }; }
    if (!task.goalObjective) {
      reply.status(409);
      return { ok: false, error: { code: "no_active_goal", message: "Task has no goal" } };
    }
    const { VERDICT_FRESHNESS_MS } = await import("../services/goal-mode/evaluator-verifier-service");
    const verdictAt = task.goalLastVerifierAt ?? null;
    const freshnessExpiresAt = verdictAt ? verdictAt + VERDICT_FRESHNESS_MS : null;
    return {
      ok: true,
      data: {
        verdict: task.goalLastVerifierVerdict ?? null,
        verdictAt,
        blocker: task.goalLastVerifierBlocker ?? null,
        freshnessExpiresAt,
        freshnessMs: VERDICT_FRESHNESS_MS,
        parseFailures: task.goalEvaluatorParseFailures ?? 0,
      },
    };
  });

  // Subgoals (mid-flight criteria refinement). CRUD endpoints let the
  // user tighten acceptance criteria while the goal loop is running.
  // Changes take effect on the next turn boundary via continuation
  // template + evaluator system prompt.
  app.get("/tasks/:taskId/goal/subgoals", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { listSubgoals } = await import(
      "../services/goal-mode/subgoal-service"
    );
    const result = await listSubgoals(taskId);
    if (!result.ok) {
      reply.status(result.error.code === "task_not_found" ? 404 : 409);
      return result;
    }
    return result;
  });

  app.post("/tasks/:taskId/goal/subgoals", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parsed = z.object({ subgoal: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      reply.status(422);
      return {
        ok: false,
        error: {
          code: "invalid_subgoal",
          message: parsed.error.issues.map((e: { message: string }) => e.message).join("; "),
        },
      };
    }
    const { addSubgoal } = await import("../services/goal-mode/subgoal-service");
    const result = await addSubgoal(taskId, parsed.data.subgoal);
    if (!result.ok) {
      const status = result.error.code === "task_not_found"
        ? 404
        : result.error.code === "invalid_subgoal"
          ? 422
          : 409;
      reply.status(status);
      return result;
    }
    return result;
  });

  app.delete("/tasks/:taskId/goal/subgoals/:index", async (request, reply) => {
    const { taskId, index } = request.params as { taskId: string; index: string };
    const parsedIndex = Number(index);
    const { removeSubgoal } = await import("../services/goal-mode/subgoal-service");
    const result = await removeSubgoal(taskId, parsedIndex);
    if (!result.ok) {
      const status = result.error.code === "task_not_found"
        ? 404
        : result.error.code === "index_out_of_range"
          ? 422
          : 409;
      reply.status(status);
      return result;
    }
    return result;
  });

  app.delete("/tasks/:taskId/goal/subgoals", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { clearSubgoals } = await import(
      "../services/goal-mode/subgoal-service"
    );
    const result = await clearSubgoals(taskId);
    if (!result.ok) {
      reply.status(result.error.code === "task_not_found" ? 404 : 409);
      return result;
    }
    return result;
  });

  // Mid-flight objective edit. PATCH because we're updating an existing
  // resource (the goal's objective string) rather than triggering a new action.
  app.patch("/tasks/:taskId/goal/objective", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const parsed = z.object({ objective: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      reply.status(422);
      return {
        ok: false,
        error: {
          code: "invalid_objective",
          message: parsed.error.issues.map((e: { message: string }) => e.message).join("; "),
        },
      };
    }
    const { editGoalObjective } = await import(
      "../services/goal-mode/edit-objective-service"
    );
    const result = await editGoalObjective({ taskId, objective: parsed.data.objective });
    if (!result.ok) {
      const status = result.error.code === "task_not_found"
        ? 404
        : result.error.code === "invalid_objective"
          ? 422
          : 409;
      reply.status(status);
      return result;
    }
    return result;
  });

  app.post("/tasks/:taskId/goal/pause", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) { reply.status(404); return { ok: false, error: "Task not found" }; }
    if (!task.goalObjective) {
      reply.status(400);
      return { ok: false, error: { code: "no_goal", message: "Task has no goal" } };
    }
    if (task.goalStatus !== "active") {
      reply.status(409);
      return { ok: false, error: { code: "not_active", message: `Goal is in status "${task.goalStatus}"` } };
    }
    const now = new Date();
    // Freeze the elapsed-time timer at pause. The current turn still
    // runs to completion (pause takes effect at the next turn boundary).
    // goal/resume clears goalCompletedAt so the timer restarts.
    await taskRepo.update(taskId, {
      goalStatus: "paused",
      goalCompletedAt: now.getTime(),
      updatedAt: now,
    });
    return { ok: true, data: { taskId, goalStatus: "paused" } };
  });

  app.post("/tasks/:taskId/goal/resume", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) { reply.status(404); return { ok: false, error: "Task not found" }; }
    if (task.goalStatus !== "paused") {
      reply.status(409);
      return { ok: false, error: { code: "not_paused", message: `Goal is in status "${task.goalStatus}"` } };
    }
    // Refuse if a turn is currently in flight — the AbortController
    // for the running turn is registered with the worker. If we
    // re-enqueued here, the just-resumed mailbox row would race with
    // the in-flight turn finishing and we'd burn an extra iteration
    // for no reason. The user can wait the turn out (or hard-Cancel
    // the task) before resuming.
    if (getAbortController(taskId)) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "turn_in_flight",
          message: "A turn is currently running. Wait for it to finish, then resume.",
        },
      };
    }
    // Flip status; the next "continue" mailbox needs to be
    // injected somehow. Easiest: inject one now manually.
    const { TaskMailboxRepository } = await import("../repositories/task-mailbox-repository");
    const mailbox = new TaskMailboxRepository();
    await mailbox.create({
      id: `msg_goal_resume_${Date.now()}_${randomUUID().slice(0, 8)}`,
      taskId,
      sender: "user",
      content: `<<goal_continuation>>\n\nResumed by user. Continue toward the goal.`,
      createdAt: new Date(),
    });
    // Clear goalCompletedAt so the elapsed-time counter resumes ticking.
    await taskRepo.update(taskId, {
      goalStatus: "active",
      goalCompletedAt: null,
      updatedAt: new Date(),
    });
    // Re-enqueue so the worker picks up the new mailbox row.
    const { taskWorker } = await import("../services/task-worker");
    const { RoleRuntimeRepository } = await import("../repositories/role-runtime-repository");
    const runtimes = new RoleRuntimeRepository();
    const runtimeRows = await runtimes.listByTaskId(taskId);
    const runtime = runtimeRows
      .filter((r) => r.roleId === "leader")
      .sort((a, b) => {
        const at = a.startedAt instanceof Date ? a.startedAt.getTime() : Number(a.startedAt ?? 0);
        const bt = b.startedAt instanceof Date ? b.startedAt.getTime() : Number(b.startedAt ?? 0);
        return bt - at;
      })[0];
    if (runtime) {
      taskWorker.enqueue({
        taskId,
        runId: runtime.id,
        requestId: `req_${randomUUID().slice(0, 12)}`,
        workspaceId: task.workspaceId,
        prompt: "",
        ...(task.rootChannelBindingId ? { channelBindingId: task.rootChannelBindingId } : {}),
      });
    }
    return { ok: true, data: { taskId, goalStatus: "active" } };
  });

  app.post("/tasks/:taskId/goal/cancel", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    if (!task) { reply.status(404); return { ok: false, error: "Task not found" }; }
    if (!task.goalObjective) {
      reply.status(400);
      return { ok: false, error: { code: "no_goal", message: "Task has no goal" } };
    }
    if (task.goalStatus === "complete" || task.goalStatus === "cancelled") {
      // Idempotent — already terminal.
      return { ok: true, data: { taskId, goalStatus: task.goalStatus } };
    }
    // Goal cancel stops the work immediately. Three paths depending
    // on worker state:
    //   1. Active worker (AbortController exists): abort it; the
    //      worker's natural teardown emits task:cancelled and
    //      transitions task state. Same as /tasks/:id/cancel.
    //   2. Queued (not yet active): drop from the worker queue +
    //      cancel role_runtime + emit terminal inline (no worker
    //      will run to do it for us).
    //   3. Idle between Ralph turns (no controller, not queued, but
    //      task may still be EXECUTING — common when Ralph wrote a
    //      mailbox continuation that hasn't been picked up yet, OR
    //      historically when the requeueAfterCurrent regression
    //      silently dropped the next turn): clear pending mailbox
    //      rows so they don't fire later under a cancelled goal,
    //      transition task state inline, emit task:cancelled so the
    //      chat UI knows to stop showing "Working ...".
    const now = new Date();
    await taskRepo.update(taskId, {
      goalStatus: "cancelled",
      goalCompletedAt: now.getTime(),
      updatedAt: now,
    });
    const ac = getAbortController(taskId);
    if (ac) {
      ac.abort("goal_cancelled");
      return { ok: true, data: { taskId, goalStatus: "cancelled" } };
    }
    const wasQueued = taskWorker.cancelQueued(taskId);
    // Re-read task state (may have transitioned between the goal
    // update above and now if a worker was just finishing).
    const taskAfter = await taskRepo.getById(taskId);
    if (!wasQueued && taskAfter && taskAfter.state !== "EXECUTING") {
      // Task is already terminal (DONE/FAILED/CANCELLED) — just
      // the goal-status update was needed. No worker side-effects.
      return { ok: true, data: { taskId, goalStatus: "cancelled" } };
    }
    // Idle-or-queued path: drop any unconsumed mailbox rows (a stale
    // goal continuation must not get picked up by a future
    // user-typed follow-up, or the cancelled goal would resurrect).
    //
    // Exception: async teammate completion rows are preserved
    // (consumed_at stays NULL). A background teammate's result that
    // arrived after goal cancel still has audit value — the row's
    // metadata_json carries the full summary. Don't silently destroy it.
    try {
      const mailbox = new TaskMailboxRepository();
      const pending = await mailbox.getUnconsumed(taskId);
      const drainable = pending.filter((m) => {
        try {
          const meta = m.metadataJson ? JSON.parse(m.metadataJson) as { type?: string } : null;
          return meta?.type !== "teammate_completion";
        } catch {
          return true; // malformed metadata → drain
        }
      });
      if (drainable.length > 0) {
        await mailbox.markConsumed(drainable.map((m) => m.id));
      }
    } catch (err) {
      // Best-effort — failure here just means a stale continuation
      // could fire later. Logging only; don't block the cancel.
      console.warn(
        `[cancel-goal] failed to drain mailbox for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const runtimeRepo = new RoleRuntimeRepository();
    const runtimes = await runtimeRepo.listByTaskId(taskId);
    for (const rt of runtimes) {
      if (rt.state === "RUNNING" || rt.state === "PENDING") {
        await runtimeRepo.update(rt.id, {
          state: "CANCELLED",
          completedAt: now,
          updatedAt: now,
        });
      }
    }
    await taskRepo.update(taskId, {
      state: "CANCELLED",
      completedAt: now,
      updatedAt: now,
    });
    // Emit task:cancelled anchored to the most recent request_id so
    // the chat exchange model has somewhere to attach the terminal
    // marker. Without an anchor, the projector drops the event for
    // having no matching exchange.
    const latestCheckpoint = await executionEventRepository.getLatestByTaskIdAndType(
      taskId,
      "leader.session_checkpoint",
    );
    const anchorRequestId = latestCheckpoint?.requestId ?? `cancel_${randomUUID().slice(0, 8)}`;
    await executionEventRepository.create({
      id: `terminal_task_cancelled_${Date.now()}_${randomUUID().slice(0, 8)}`,
      type: "task:cancelled",
      taskId,
      requestId: anchorRequestId,
      occurredAt: now,
      payloadJson: JSON.stringify({
        taskId,
        requestId: anchorRequestId,
        state: "CANCELLED",
        reason: "goal_cancelled_idle",
      }),
    });
    return { ok: true, data: { taskId, goalStatus: "cancelled" } };
  });

  // Follow-up message body: `content` (text) + optional `attachments[]`
  // (same shape as POST /tasks first-turn). Attachment cap mirrors the
  // first-turn cap: 10 files per message.
  const followUpSchema = z.object({
    content: z.string().min(1),
    attachments: z.array(attachmentSchema).max(10).optional(),
  });

  // Serialize POST /tasks/:taskId/messages on a per-task basis. The
  // routing decision below reads `liveRun`/`queued` state and then
  // either enqueues a mailbox row or calls processTaskIntent — two
  // concurrent requests for the same task can otherwise interleave in
  // the read-decide-write window: both observe "no live run", both fall
  // through to processTaskIntent, both mint their own requestId for the
  // same physical user prompt → duplicate exchange in the chat with the
  // same content split across two requestIds. Per-task mutex closes the
  // window. Per-task (not global) so unrelated tasks stay parallel.
  const taskMessagePostLocks = new Map<string, Promise<unknown>>();
  const withTaskMessageLock = async <T>(taskId: string, op: () => Promise<T>): Promise<T> => {
    const prev = taskMessagePostLocks.get(taskId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    // Chain the new lock onto the previous one so callers run in arrival
    // order. Stash a single `chain` reference for the cleanup check —
    // `prev.then(...)` returns a fresh promise on every call so we have
    // to capture it once or the identity check at the end will always
    // miss and leak entries in the map.
    const chain = prev.then(() => next);
    taskMessagePostLocks.set(taskId, chain);
    try {
      await prev;
      return await op();
    } finally {
      release();
      if (taskMessagePostLocks.get(taskId) === chain) {
        taskMessagePostLocks.delete(taskId);
      }
    }
  };

  app.post("/tasks/:taskId/messages", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    let parsed: z.infer<typeof followUpSchema>;
    try {
      parsed = followUpSchema.parse(request.body);
    } catch (err) {
      reply.status(400);
      return { ok: false, error: err instanceof Error ? err.message : "invalid body" };
    }
    const content = parsed.content.trim();
    if (!content) {
      reply.status(400);
      return { ok: false, error: "content is required" };
    }
    const attachments = parsed.attachments && parsed.attachments.length > 0 ? parsed.attachments : undefined;

    return withTaskMessageLock(taskId, async () => {
    // Two delivery modes:
    //   (a) Mailbox — when a leader run is currently active for this
    //       task, the running loop polls the mailbox between turns and
    //       picks the message up. We don't want to enqueue a fresh
    //       resume in this case — that would race with the live run
    //       and risk concurrent execution from the same checkpoint.
    //   (b) processTaskIntent resume — when no run is active (e.g.
    //       leader halted after `exit_plan_mode` and is in
    //       AWAITING_APPROVAL, or task previously completed and the
    //       user is replying to a stored plan), wake the leader via
    //       the unified intake so the callModel preflight detects
    //       any plan sentinel.
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(taskId);
    const mailbox = new TaskMailboxRepository();

    const liveRun = getAbortController(taskId);
    const queued = isTaskQueued(taskId);
    const hasBinding = !!task?.rootChannelBindingId;

    // Route to mailbox when task is live OR queued. A queued task has
    // no AbortController yet; re-enqueuing via processTaskIntent would
    // silently drop the follow-up. Mailbox is the correct semantic:
    // the leader drains it when it eventually picks up the task.
    if (liveRun || queued || !hasBinding || !task) {
      // (a) — or fallback when there's no binding to resume against.
      // Always mint a requestId for the mailbox row, regardless of
      // attachments. The frontend uses this requestId to bind the
      // optimistic chat exchange to a backend-known id (via
      // bindRequestId), so when the leader later drains this row into
      // a multi-prompt run, the prompt-to-exchange mapping survives
      // the merge. Pre-fix behavior minted requestId only when
      // attachments existed, leaving plain-text follow-ups as orphan
      // optimistic exchanges that confused the chat projector.
      //
      // Save attachments BEFORE the mailbox insert so the loop never
      // sees a row that points at unsaved attachments.
      const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const followUpRequestId = `req_${id}`;
      if (attachments) {
        const { saveAttachments } = await import("../services/attachment-service");
        await saveAttachments(taskId, followUpRequestId, attachments);
      }
      await mailbox.create({
        id,
        taskId,
        content,
        sender: "user",
        createdAt: new Date(),
        requestId: followUpRequestId,
      });
      return {
        ok: true,
        data: { id, taskId, requestId: followUpRequestId, action: "queued_mailbox" },
      };
    }

    // (b) — defer to the unified intake. processTaskIntent finds the
    // active leader session by binding, restores from checkpoint if
    // needed, and enqueues a resume job. Same path POST /tasks takes
    // for follow-up turns. processTaskIntent already handles
    // attachments end-to-end (saveAttachments + leader runtime
    // injection), so we just pass them through.
    const result = await processTaskIntent({
      prompt: content,
      source: task.source as "web" | "cli" | "feishu",
      workspaceId: task.workspaceId,
      channelBindingId: task.rootChannelBindingId!,
      rootChannelBindingId: task.rootChannelBindingId!,
      ...(attachments ? { attachments } : {}),
    });
    return {
      ok: true,
      data: {
        id: result.requestId,
        taskId: result.taskId,
        requestId: result.requestId,
        action: result.action ?? "resumed_session",
      },
    };
    });
  });

  app.get<{ Querystring: { workspaceId?: string; limit?: string } }>("/tasks", async (request) => {
    const startedAt = Date.now();
    // Path A — `?workspaceId=` filters the list to one workspace.
    // Omitted = all tasks (the dashboard-stats path still wants
    // global view; the chat sessions list is the primary filter
    // user). The frontend wires this from the active workspace
    // picker selection.
    const workspaceId =
      typeof request.query.workspaceId === "string" && request.query.workspaceId.length > 0
        ? request.query.workspaceId
        : null;
    // `?limit=N` caps the response — the Sidebar's live-count poll
    // only needs the top ~50 to count "running" tasks.
    const rawLimit = typeof request.query.limit === "string" ? Number(request.query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 500)
      : null;
    const allItems = await listTaskSummaries(workspaceId ? { workspaceId } : undefined);
    const items = limit !== null ? allItems.slice(0, limit) : allItems;
    maybeLogSessionPerf("/tasks", startedAt, {
      workspaceId,
      itemCount: items.length,
      limit,
    });
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.get("/tasks/stats", async () => {
    const taskRepo = new TaskRepository();
    const [tasks, allEvents] = await Promise.all([
      taskRepo.listAll(),
      executionEventRepository.listAll(),
    ]);

    const todayStart = getStartOfTodayLocal().getTime();
    const recentWindowStart = Date.now() - (7 * 24 * 60 * 60 * 1000);

    const activeTasks = tasks.filter((task) => task.state === "EXECUTING").length;
    const completedToday = tasks.filter((task) => {
      if (!COMPLETED_TASK_STATES.has(task.state)) {
        return false;
      }
      return (task.completedAt ?? task.updatedAt).getTime() >= todayStart;
    }).length;
    const failedToday = tasks.filter((task) => {
      if (!FAILED_TASK_STATES.has(task.state)) {
        return false;
      }
      return task.updatedAt.getTime() >= todayStart;
    }).length;

    const completedWithDuration = tasks.filter((task) => {
      if (!task.completedAt || !task.createdAt) {
        return false;
      }
      if (!COMPLETED_TASK_STATES.has(task.state)) {
        return false;
      }
      return task.completedAt.getTime() >= task.createdAt.getTime();
    });

    const avgCompletionMs = completedWithDuration.length > 0
      ? Math.round(
          completedWithDuration.reduce((sum, task) => {
            return sum + (task.completedAt!.getTime() - task.createdAt.getTime());
          }, 0) / completedWithDuration.length,
        )
      : null;

    const recentTeammateSpawnMap = new Map<string, { count: number; lastSpawnedAt: string }>();
    for (const event of allEvents) {
      if (event.type !== "leader.teammate_spawned") {
        continue;
      }
      if (event.occurredAt.getTime() < recentWindowStart) {
        continue;
      }
      const roleId = readTeammateName(event.payloadJson);
      if (!roleId) {
        continue;
      }
      const current = recentTeammateSpawnMap.get(roleId);
      if (!current) {
        recentTeammateSpawnMap.set(roleId, {
          count: 1,
          lastSpawnedAt: event.occurredAt.toISOString(),
        });
        continue;
      }
      recentTeammateSpawnMap.set(roleId, {
        count: current.count + 1,
        lastSpawnedAt:
          current.lastSpawnedAt > event.occurredAt.toISOString()
            ? current.lastSpawnedAt
            : event.occurredAt.toISOString(),
      });
    }

    const recentTeammateSpawns = [...recentTeammateSpawnMap.entries()]
      .map(([roleId, value]) => ({
        roleId,
        count: value.count,
        lastSpawnedAt: value.lastSpawnedAt,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      ok: true,
      data: {
        totalTasks: tasks.length,
        activeTasks,
        completedToday,
        failedToday,
        avgCompletionMs,
        completionSampleSize: completedWithDuration.length,
        recentTeammateSpawns,
      },
    };
  });

  app.get("/usage/today", async () => {
    const records = await getRecentUsage(50);
    return {
      ok: true,
      data: {
        records,
      },
    };
  });

  async function serveTaskMedia(
    request: FastifyRequest<{ Params: { taskId: string; mediaId: string } }>,
    reply: FastifyReply,
  ) {
    const params = z.object({
      taskId: z.string().min(1),
      mediaId: z.string().min(1),
    }).parse(request.params);

    const media = await new TaskMediaRepository().getByTaskIdAndId(params.taskId, params.mediaId);
    if (!media || media.status !== "ready") {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "Media not found" } };
    }

    const storagePath = await resolveTaskMediaStoragePath(params.taskId, media.storagePath);
    if (!storagePath) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "Media file not found" } };
    }

    let fileStat;
    try {
      fileStat = await stat(storagePath);
    } catch {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "Media file not found" } };
    }
    if (!fileStat.isFile()) {
      reply.status(404);
      return { ok: false, error: { code: "not_found", message: "Media file not found" } };
    }

    const size = fileStat.size;
    const isVideo = media.kind === "video";
    reply.header("Content-Type", media.mimeType);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "private, max-age=300");
    reply.header("X-Content-Type-Options", "nosniff");

    const range = isVideo ? parseByteRange(request.headers.range, size) : null;
    if (range === "invalid") {
      reply.status(416);
      reply.header("Content-Range", `bytes */${size}`);
      return "";
    }

    if (range) {
      reply.status(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      reply.header("Content-Length", String(range.end - range.start + 1));
      if (request.method === "HEAD") return "";
      return reply.send(createReadStream(storagePath, { start: range.start, end: range.end }));
    }

    reply.header("Content-Length", String(size));
    if (request.method === "HEAD") return "";
    return reply.send(createReadStream(storagePath));
  }

  app.route({
    method: "GET",
    url: "/tasks/:taskId/media/:mediaId",
    exposeHeadRoute: false,
    handler: serveTaskMedia,
  });
  app.head("/tasks/:taskId/media/:mediaId", serveTaskMedia);

  app.get("/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const taskSummary = await getTaskSummary(params.taskId);

    if (!taskSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: taskSummary,
    };
  });

  app.get("/tasks/:taskId/usage", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    return {
      ok: true,
      data: await getTaskUsage(params.taskId),
    };
  });

  app.get("/tasks/:taskId/turn-summaries", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const taskSummary = await getTaskSummary(params.taskId);
    if (!taskSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }
    return {
      ok: true,
      data: {
        items: await getTaskTurnSummaries(params.taskId),
      },
    };
  });

  app.get("/tasks/:taskId/spec", async (request) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const spec = await getProjectSpec(params.taskId);
    return {
      ok: true,
      data: spec,
    };
  });

  // lazy-load endpoint for the
  // sidechain teammate-transcript drawer (W1 §3.5 will consume this).
  // Same query backs the `read_teammate_transcript` leader tool.
  // Uses the partial index `idx_execution_events_parent_tool` from
  // Step 0b for O(log n) filtering instead of a json_extract scan.
  // `since` is seq-keyed (exclusive) — eliminates OFFSET-based paging
  // inconsistency across live-tail vs cold-load merges.
  app.get("/tasks/:taskId/teammate/:parentToolUseId/transcript", async (request, reply) => {
    const params = z.object({
      taskId: z.string().min(1),
      parentToolUseId: z.string().min(1),
    }).parse(request.params);
    const query = z.object({
      since: z.coerce.number().int().nonnegative().optional(),
      // Codex round-3 [M] — cap at 500 (was 1000). Each event row
      // can carry up to 8KB of outputSummary; a 1000-row page is
      // potentially 8MB JSON. 500 keeps response under ~4MB worst-
      // case and matches the leader tool's PAGE_LIMIT=200 well
      // enough for the drawer's typical scroll-tail.
      limit: z.coerce.number().int().positive().max(500).optional(),
    }).parse(request.query);

    // Codex round-3 [M] — task existence check. Lets the client
    // distinguish "task doesn't exist" (404) from "no more events
    // for this parentToolUseId" (200, empty array). Other tasks.ts
    // endpoints follow the same pattern (e.g. /tasks/:taskId at
    // line 527).
    const task = await taskSummaryStore.get(params.taskId);
    if (!task) {
      reply.status(404);
      return {
        ok: false,
        error: { code: "not_found", message: `Task not found: ${params.taskId}` },
      };
    }

    const limit = query.limit ?? 200;
    const events = await executionEventRepository.listTeammateTranscript(
      params.taskId,
      params.parentToolUseId,
      query.since ?? 0,
      limit,
    );

    if (events.length === 0) {
      // Fail-soft: empty page is a normal end-of-pagination signal.
      // The drawer treats `events: []` as "no more rows".
      return { ok: true, data: { events: [], lastSeq: query.since ?? 0, hasMore: false } };
    }

    const lastSeq = events[events.length - 1]!.seq ?? 0;
    return {
      ok: true,
      data: {
        events,
        lastSeq,
        hasMore: events.length === limit,
      },
    };
  });

  // Non-streaming snapshot — returns { task, events } as a single JSON
  // envelope. Used by ExecutionTimeline and any other panel that wants a
  // one-shot read without subscribing to live events. Mirrors the snapshot
  // payload sent as the first frame of `/tasks/:taskId/stream`, including
  // the `light=true` checkpoint trimming.
  app.get("/tasks/:taskId/snapshot", async (request, reply) => {
    const startedAt = Date.now();
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const url = new URL(request.url, `http://${request.headers.host}`);
    const light = url.searchParams.get("light") === "true";

    // Pull attachment metadata in parallel with the task + events.
    // Surfacing it on the snapshot lets the frontend re-render the
    // user-bubble file chips after a page reload — without this,
    // the chips only live in chatStore (gone on refresh).
    const { TaskAttachmentRepository } = await import("../repositories/task-attachment-repository");
    const attRepo = new TaskAttachmentRepository();

    const [taskSummary, rawEvents, attachmentRows] = await Promise.all([
      taskSummaryStore.get(params.taskId),
      // Latest 30 turns + per-part stream_delta coalescing — see
      // listLatestRequestEvents docstring. Without this, large-history
      // tasks (172k events seen in production) blew the snapshot to
      // 80 MB and the page either never hydrated or hydrated against
      // turn 1 of 50 (the "stuck on stale conversation" bug).
      executionEventRepository.listLatestRequestEvents(params.taskId),
      attRepo.listByTaskId(params.taskId),
    ]);

    if (!taskSummary) {
      reply.status(404);
      return {
        ok: false,
        error: { code: "not_found", message: `Task not found: ${params.taskId}` },
      };
    }

    // Strip the on-disk path; the frontend doesn't need it and it's
    // arguably a small information disclosure (workspace layout).
    const attachments = attachmentRows.map((a) => ({
      requestId: a.requestId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    }));

    const events = light
      ? rawEvents.map((e) => {
          if (e.type === "leader.session_checkpoint" && e.payloadJson) {
            try {
              const p = JSON.parse(e.payloadJson) as { sessionId?: string; turnCount?: number; messages?: unknown[] };
              return {
                ...e,
                payloadJson: JSON.stringify({
                  sessionId: p.sessionId,
                  turnCount: p.turnCount,
                  messageCount: p.messages?.length ?? 0,
                }),
              };
            } catch {
              return e;
            }
          }
          return e;
      })
      : rawEvents;

    maybeAppendSyntheticTerminal(
      events as unknown as Array<Record<string, unknown>>,
      taskSummary as unknown as Parameters<typeof maybeAppendSyntheticTerminal>[1],
    );

    maybeLogSessionPerf("/tasks/:taskId/snapshot", startedAt, {
      taskId: params.taskId,
      light,
      rawEventCount: rawEvents.length,
      eventCount: events.length,
      attachmentCount: attachments.length,
    });

    return { ok: true, data: { task: taskSummary, events, attachments } };
  });

  app.get("/tasks/:taskId/stream", async (request, reply) => {
    const startedAt = Date.now();
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const url = new URL(request.url, `http://${request.headers.host}`);
    const light = url.searchParams.get("light") === "true";

    // Subscribe to the bus BEFORE the DB read. Otherwise events the leader
    // publishes between (a) the DB fetch returning and (b) `subscribe()`
    // landing get dropped: not in the snapshot (already fetched) and not on
    // the live wire (not yet listening). On a hot turn that gap is several
    // text_deltas / tool_calls — the user only sees them after a refresh
    // pulls a fresh snapshot. Buffer events here, drain after snapshot is
    // written (deduped by seq vs the snapshot's max seq).
    let snapshotSent = false;
    let cleaned = false;
    const buffered: Array<{ type: string; payload: string; seq: number }> = [];
    const terminalEventTypes = new Set([
      "leader.session_complete",
      "task:completed",
      "task:failed",
      "task:cancelled",
    ]);
    // Hoisted so `cleanup` can reference them safely. The listener may
    // call `cleanup` before the keepalive/idle timers are wired (e.g. a
    // terminal event arrives during the snapshot drain, between
    // `snapshotSent = true` and the keepAliveTimer line below).
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;

    // Idle timeout — tests override to a small value so `app.inject` can
    // collect the terminal-stream output without hanging for 5 minutes.
    // Production default keeps the stream alive long enough that a user
    // navigating away briefly and coming back to the same task picks up
    // the next turn live without forcing a snapshot reconnect.
    const idleOverride = Number(process.env.MAGISTER_SSE_IDLE_MS ?? NaN);
    const IDLE_TIMEOUT_MS = Number.isFinite(idleOverride) && idleOverride > 0
      ? idleOverride
      : 5 * 60 * 1000;
    function armIdleTimeout(): void {
      if (cleaned) return;
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        cleanup();
      }, IDLE_TIMEOUT_MS);
    }
    function cancelIdleTimeout(): void {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    }

    function emit(type: string, payload: string): boolean {
      try {
        reply.raw.write(`event: ${type}\ndata: ${payload}\n\n`);
        // Force-flush so SSE deltas hit the wire immediately. Without
        // this, Bun/Node may cork small writes and batch them — the
        // client sees nothing for seconds then a burst of events.
        if (typeof (reply.raw as unknown as { flush?: () => void }).flush === "function") {
          (reply.raw as unknown as { flush: () => void }).flush();
        }
        return true;
      } catch {
        return false;
      }
    }

    // Listener stays subscribed across follow-up turns. Closing the
    // stream on terminal events caused a 3s reconnect window (browser
    // EventSource default retry) where new-turn events fired by a
    // PlanCard Approve/Cancel/Revise sentinel got published with no
    // subscriber — buffered to DB only, snapshot would catch them up
    // on reconnect but the user perceived a stall. Instead, on terminal
    // we ARM an idle timer; on any non-terminal event we cancel it.
    // Follow-up turns flow through naturally without forcing reconnect.
    const unsubscribe = taskEventBus.subscribe(params.taskId, (event) => {
      if (cleaned) return;
      const seq = event.seq ?? 0;
      if (!snapshotSent) {
        buffered.push({ type: event.type, payload: JSON.stringify(event), seq });
        return;
      }
      emit(event.type, JSON.stringify(event));
      if (terminalEventTypes.has(event.type)) {
        armIdleTimeout();
      } else {
        cancelIdleTimeout();
      }
    });

    // Same triple-fetch as the snapshot endpoint — attachments are
    // surfaced on the SSE snapshot frame so a chat reload while a
    // task is live still gets the user-bubble file chips.
    const { TaskAttachmentRepository } = await import("../repositories/task-attachment-repository");
    const attRepoStream = new TaskAttachmentRepository();
    const [taskSummary, rawEvents, attachmentRows] = await Promise.all([
      taskSummaryStore.get(params.taskId),
      // Same trim/coalesce as /snapshot — see listLatestRequestEvents.
      executionEventRepository.listLatestRequestEvents(params.taskId),
      attRepoStream.listByTaskId(params.taskId),
    ]);
    const attachments = attachmentRows.map((a) => ({
      requestId: a.requestId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    }));

    if (!taskSummary) {
      unsubscribe();
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    const events = light
      ? rawEvents.map((e) => {
          if (e.type === "leader.session_checkpoint" && e.payloadJson) {
            try {
              const p = JSON.parse(e.payloadJson) as { sessionId?: string; turnCount?: number; messages?: unknown[] };
              return {
                ...e,
                payloadJson: JSON.stringify({
                  sessionId: p.sessionId,
                  turnCount: p.turnCount,
                  messageCount: p.messages?.length ?? 0,
                }),
              };
            } catch {
              return e;
            }
          }
          return e;
        })
      : rawEvents;

    maybeAppendSyntheticTerminal(
      events as unknown as Array<Record<string, unknown>>,
      taskSummary as unknown as Parameters<typeof maybeAppendSyntheticTerminal>[1],
    );

    // Real SSE stream: send snapshot, then forward live events until task completes
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      // Tell nginx / Cloudflare / ALB and other proxies NOT to buffer this
      // response. Without this, intermediate hops collect the full body and
      // ship it at once — exactly the symptom mobile users hit ("nothing,
      // then everything").
      "x-accel-buffering": "no",
      // Defeat any default compression middleware downstream; gzip-encoded
      // SSE has to fill a window before the client sees a delta.
      "content-encoding": "identity",
    });

    // Disable Nagle so each delta hits the wire immediately instead of being
    // batched with the next packet.
    if (typeof (reply.raw.socket as { setNoDelay?: (v: boolean) => void } | undefined)?.setNoDelay === "function") {
      try { reply.raw.socket!.setNoDelay(true); } catch {}
    }

    // 2KB padding comment forces mobile WebKit / iOS Safari to release the
    // EventSource readyState=OPEN early. Without this prelude, some browsers
    // wait until ~2KB of data has arrived before dispatching events.
    reply.raw.write(`:${" ".repeat(2048)}\n\n`);

    const snapshotPayload = JSON.stringify({ task: taskSummary, events, attachments });
    maybeLogSessionPerf("/tasks/:taskId/stream", startedAt, {
      taskId: params.taskId,
      light,
      rawEventCount: rawEvents.length,
      eventCount: events.length,
      attachmentCount: attachments.length,
      snapshotBytes: snapshotPayload.length,
    });

    // Send initial snapshot
    reply.raw.write(`event: task.snapshot\ndata: ${snapshotPayload}\n\n`);
    if (typeof (reply.raw as unknown as { flush?: () => void }).flush === "function") {
      (reply.raw as unknown as { flush: () => void }).flush();
    }

    // Drain any events that were published into our buffer while the DB
    // fetch was in flight. Dedup by seq vs the snapshot's max seq — events
    // already in the snapshot are skipped; new ones are forwarded in order.
    // Track whether the drain saw a terminal or non-terminal event so the
    // post-drain idle-timer arm decision matches what just hit the wire,
    // not the (potentially stale) `taskSummary.state` from the DB read.
    const maxSnapshotSeq = events.reduce((m, e) => {
      const s = (e as { seq?: number | null }).seq ?? 0;
      return s > m ? s : m;
    }, 0);
    snapshotSent = true;
    let drainedNonTerminalAfterSnapshot = false;
    let drainedTerminalAfterSnapshot = false;
    for (const buf of buffered) {
      if (buf.seq > 0 && buf.seq <= maxSnapshotSeq) continue;
      emit(buf.type, buf.payload);
      if (terminalEventTypes.has(buf.type)) {
        drainedTerminalAfterSnapshot = true;
      } else {
        drainedNonTerminalAfterSnapshot = true;
      }
    }
    buffered.length = 0;

    // Idle-timeout policy: stream stays open across follow-up turns.
    // Arm a 5-min timer iff the task is in a terminal state AT THIS
    // MOMENT — meaning either (a) snapshot showed terminal AND the
    // drain only delivered the matching terminal events, or (b) the
    // drain itself ended on a terminal event. If the drain delivered
    // any non-terminal event (a fresh follow-up turn that started
    // during our DB-fetch window), the user IS actively interacting
    // and the idle timer must NOT be armed even though taskSummary
    // happened to show a terminal state.
    const terminalStates = ["DONE", "COMPLETED", "FAILED", "CANCELLED"];
    const snapshotIsTerminal = terminalStates.includes(taskSummary.state);
    const shouldArmAfterDrain = drainedTerminalAfterSnapshot
      || (snapshotIsTerminal && !drainedNonTerminalAfterSnapshot);
    if (shouldArmAfterDrain) {
      armIdleTimeout();
    }

    // Keepalive every 15s to prevent proxy/browser timeout
    keepAliveTimer = setInterval(() => {
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        cleanup();
      }
    }, 15_000);

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (idleTimeout) clearTimeout(idleTimeout);
      unsubscribe();
      try { reply.raw.end(); } catch {}
    }

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    // Don't let Fastify auto-send a response — we're managing the raw stream
    return reply;
  });

  app.get("/tasks/:taskId/artifacts", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const taskSummary = await getTaskSummary(params.taskId);

    if (!taskSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    const items = await listTaskArtifacts(params.taskId);
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.post("/tasks/:taskId/artifacts/cleanup", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const taskSummary = await getTaskSummary(params.taskId);

    if (!taskSummary) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: await cleanupTaskArtifacts(params.taskId),
    };
  });

  app.get("/tasks/:taskId/memory", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const memoryView = await getTaskMemoryView(params.taskId);

    if (!memoryView) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: memoryView,
    };
  });

  app.get("/tasks/:taskId/context", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const taskContext = await getTaskContext(params.taskId);

    if (!taskContext) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: taskContext,
    };
  });

  app.get("/tasks/:taskId/orchestration-history", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const history = await getTaskOrchestrationHistory(params.taskId);

    if (!history) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: history,
    };
  });

  app.get("/tasks/:taskId/events", async (request) => {
    const { taskId } = request.params as { taskId: string };
    const url = new URL(request.url, `http://${request.headers.host}`);
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? "0");

    const repo = new ExecutionEventRepository();
    // When the caller wants a snapshot (sinceSeq=0), give them the
    // LATEST turns, not the oldest 100. For incremental catch-up
    // (sinceSeq>0) the seq-ordered fallback is still correct.
    const events = sinceSeq > 0
      ? await repo.listSinceSeq(taskId, sinceSeq)
      : await repo.listLatestRequestEvents(taskId);

    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    return { ok: true, data: { events, latestSeq: lastEvent?.seq ?? sinceSeq } };
  });

  app.get("/tasks/:taskId/tree", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const tree = await buildTaskTree(taskId);
    if (!tree) {
      reply.status(404);
      return { ok: false, error: { code: "NOT_FOUND", message: "Task not found" } };
    }
    return { ok: true, data: tree };
  });

  app.get("/tasks/:taskId/timeline", async (request, reply) => {
    const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const history = await getTaskOrchestrationHistory(params.taskId);

    if (!history) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Task not found: ${params.taskId}`,
        },
      };
    }

    return {
      ok: true,
      data: history,
    };
  });

  // Paginated checkpoint messages — returns messages in pages to avoid 11MB downloads
  app.get("/tasks/:taskId/messages", async (request) => {
    const startedAt = Date.now();
    const { taskId } = request.params as { taskId: string };
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);
    const rawOffset = Number(url.searchParams.get("offset") ?? "0");
    const rawLimit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 50;
    const tail = url.searchParams.get("tail") === "true";

    const eventRepo = new ExecutionEventRepository();
    const latest = await eventRepo.getLatestByTaskIdAndType(taskId, "leader.session_checkpoint");
    if (!latest?.payloadJson) {
      maybeLogSessionPerf("/tasks/:taskId/messages", startedAt, {
        taskId,
        tail,
        offset,
        limit,
        total: 0,
        returned: 0,
        checkpointPayloadBytes: 0,
      });
      return { ok: true, data: { messages: [], total: 0, offset, limit } };
    }

    try {
      const payload = JSON.parse(latest.payloadJson) as { messages?: unknown[] };
      const rawMessages = payload.messages ?? [];
      // Drop loop-internal meta messages (`[Session Progress]`,
      // `[Previous conversation summary]`) that are model-context only,
      // not user input. Leaking them into the frontend would pair them
      // with exchanges incorrectly.
      const allMessages = rawMessages.filter((m) => {
        if (!m || typeof m !== "object") return true;
        const obj = m as { isMeta?: unknown; type?: unknown; content?: unknown };
        if (obj.isMeta === true) return false;
        // Belt-and-suspenders: a few historical messages (pre-isMeta
        // codepath, or seed-step copies that lost the flag) carry the
        // sentinel text without `isMeta: true`. The two sentinels —
        // `[Session Progress]` and `[Previous conversation summary]`
        // — are reserved for loop-internal context injections and
        // should never reach the user UI.
        if (obj.type === "user") {
          let firstText = "";
          if (typeof obj.content === "string") {
            firstText = obj.content;
          } else if (Array.isArray(obj.content)) {
            const firstBlock = obj.content[0] as { type?: unknown; text?: unknown } | undefined;
            if (firstBlock && firstBlock.type === "text" && typeof firstBlock.text === "string") {
              firstText = firstBlock.text;
            }
          }
          const head = firstText.trimStart();
          if (head.startsWith("[Session Progress]") || head.startsWith("[Previous conversation summary]")) {
            return false;
          }
        }
        return true;
      });
      const total = allMessages.length;
      const pageOffset = tail ? Math.max(0, total - limit) : Math.min(offset, total);
      const page = allMessages.slice(pageOffset, pageOffset + limit);
      maybeLogSessionPerf("/tasks/:taskId/messages", startedAt, {
        taskId,
        tail,
        offset: pageOffset,
        limit,
        total,
        returned: page.length,
        checkpointPayloadBytes: latest.payloadJson.length,
      });
      return { ok: true, data: { messages: page, total, offset: pageOffset, limit } };
    } catch {
      maybeLogSessionPerf("/tasks/:taskId/messages", startedAt, {
        taskId,
        tail,
        offset,
        limit,
        total: 0,
        returned: 0,
        checkpointPayloadBytes: latest.payloadJson.length,
        parseError: true,
      });
      return { ok: true, data: { messages: [], total: 0, offset, limit } };
    }
  });
}
