import type { LeaderMessage } from "./manager-automation/autonomous-loop/autonomous-types";
import { LeaderSessionStore } from "./leader-session-store";
import { createEventProjector } from "./leader-event-projector";
import { runLeaderRuntime } from "./manager-automation/autonomous-loop/manager-autonomous-runtime";
import { resolveWorkspaceBaseDir } from "./runtime-workspace-service";
import { readExecutorConfigFile } from "./executor-config-service";
import { LEADER_SYSTEM_PROMPT, appendMemoryBlock } from "./manager-automation/teammate-system-prompts";
import { applyModelOverrideToApiConfig, resolveApiConfigFromRoleRouting } from "./process-task-intent-service";
import { parseTavilyWebSearchConfigFromEnv } from "./tavily-web-search-service";
import { classifyExecutionPolicy, buildSystemPromptWithPolicy, resolveAvailableRoles, type ExecutionPolicy } from "./leader-execution-policy-service";
import { TaskRepository } from "../repositories/task-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { wsHub } from "../ws/hub";
import { taskEventBus } from "../sse/task-event-bus";
import { registerAbortController, removeAbortController } from "./task-worker";

type ResumeInput = {
  taskId: string;
  runId: string;
  workspaceId: string;
  channelBindingId?: string;
  appendMessage?: string;
};

type ResumeResult = {
  ok: boolean;
  reason: string;
  turnCount: number;
  finalAnswer?: string;
};

export function repairToolResultPairing(messages: LeaderMessage[]): LeaderMessage[] {
  const assistantToolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.type === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          assistantToolUseIds.add(block.id);
        }
      }
    }
    if (msg.type === "tool_result") {
      toolResultIds.add(msg.toolUseId);
    }
  }

  const pairedToolUseIds = new Set<string>();
  for (const toolUseId of assistantToolUseIds) {
    if (toolResultIds.has(toolUseId)) {
      pairedToolUseIds.add(toolUseId);
    }
  }

  return messages
    .map((msg) => {
      if (msg.type === "assistant") {
        const filteredContent = msg.content.filter((block) => {
          if (block.type !== "tool_use") return true;
          return pairedToolUseIds.has(block.id);
        });
        if (filteredContent.length === 0) return null;
        return { ...msg, content: filteredContent };
      }

      if (msg.type === "tool_result") {
        if (!pairedToolUseIds.has(msg.toolUseId)) {
          return null;
        }
        return msg;
      }

      return msg;
    })
    .filter((msg): msg is LeaderMessage => msg !== null);
}

/**
 * @deprecated Stripping thinking blocks on resume breaks the provider
 * API contract (providers expect thinking content passed back). No-op
 * now; the safety net for legacy thinking-less checkpoints lives in
 * `anthropic-plugin.convertLeaderMessageToAnthropic`.
 *
 * Kept exported for back-compat; calls are a no-op (return-as-is).
 */
export function sanitizeThinkingBlocks(messages: LeaderMessage[]): LeaderMessage[] {
  return messages;
}

// Spec §2 — tool_result.content widened to LeaderResultContent
// (string | LeaderResultBlock[]). Resume's user-content shape mirrors
// LeaderContentBlock here.
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: import("./manager-automation/autonomous-loop/autonomous-types").LeaderResultContent; is_error?: boolean };

function asUserContentBlocks(
  message: LeaderMessage,
): UserContentBlock[] {
  if (message.type === "tool_result") {
    return [{
      type: "tool_result",
      tool_use_id: message.toolUseId,
      content: message.content,
      ...(message.isError ? { is_error: true } : {}),
    }];
  }
  if (message.type === "user") {
    if (typeof message.content === "string") {
      return [{ type: "text", text: message.content }];
    }
    return message.content.filter(
      (block): block is UserContentBlock =>
        block.type === "text" || block.type === "tool_result",
    );
  }
  return [];
}

function resolveAnthropicRole(message: LeaderMessage): "user" | "assistant" {
  if (message.type === "assistant") return "assistant";
  return "user";
}

export function enforceAlternatingTurns(messages: LeaderMessage[]): LeaderMessage[] {
  if (messages.length <= 1) return messages;

  const result: LeaderMessage[] = [messages[0] as LeaderMessage];

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    if (!current) continue;

    const prev = result[result.length - 1];
    if (!prev) {
      result.push(current);
      continue;
    }

    const prevRole = resolveAnthropicRole(prev);
    const currentRole = resolveAnthropicRole(current);

    if (prevRole !== currentRole) {
      result.push(current);
      continue;
    }

    // Merge consecutive user-role messages (user, tool_result — both
    // are "user" for Anthropic). Preserve LeaderMessageBase fields
    // — especially `requestId`, which is how the frontend binds the
    // user prompt to its chat exchange. Without this, mailbox-drained
    // user prompts (which always sit adjacent to a preceding
    // tool_result and thus always get merged here on resume) lose
    // their requestId on the second turn after a session resume, and
    // the chat UI falls back to tail-pair pairing for them. Prefer
    // the later message's requestId — that's the user-typed prompt
    // we want to keep identified; the tool_result it merges with has
    // no meaningful chat identity.
    if (currentRole === "user" && prevRole === "user") {
      const prevContent = asUserContentBlocks(prev as Extract<LeaderMessage, { type: "user" }> | Extract<LeaderMessage, { type: "tool_result" }>);
      const currentContent = asUserContentBlocks(current as Extract<LeaderMessage, { type: "user" }> | Extract<LeaderMessage, { type: "tool_result" }>);
      const carriedRequestId = current.requestId ?? prev.requestId;
      const carriedUuid = current.uuid ?? prev.uuid;
      const carriedTimestamp = current.timestamp ?? prev.timestamp;
      const carriedIsMeta = current.isMeta || prev.isMeta;
      result[result.length - 1] = {
        type: "user",
        content: [...prevContent, ...currentContent],
        ...(carriedRequestId ? { requestId: carriedRequestId } : {}),
        ...(carriedUuid ? { uuid: carriedUuid } : {}),
        ...(carriedTimestamp ? { timestamp: carriedTimestamp } : {}),
        ...(carriedIsMeta ? { isMeta: true } : {}),
      };
      continue;
    }

    // Merge consecutive assistant messages
    if (prev.type === "assistant" && current.type === "assistant") {
      result[result.length - 1] = {
        ...prev,
        content: [...prev.content, ...current.content],
      };
      continue;
    }

    // Fallback: insert spacer to maintain alternation
    if (currentRole === "user") {
      result.push({
        type: "assistant",
        content: [{ type: "text", text: "[resume spacer]" }],
        isMeta: true,
      });
      result.push(current);
      continue;
    }

    result.push({
      type: "user",
      content: "[resume spacer]",
      isMeta: true,
    });
    result.push(current);
  }

  return result;
}

export function sanitizeResumedMessages(messages: LeaderMessage[]): LeaderMessage[] {
  let result = repairToolResultPairing(messages);
  result = sanitizeThinkingBlocks(result);
  result = enforceAlternatingTurns(result);
  return result;
}

/**
 * Pure helper: compose the canonical leader base prompt (with memory block
 * already appended) with a policy addendum. Exported for unit tests.
 */
export function buildResumeSystemPrompt(base: string, policy: ExecutionPolicy, roles: string[]): string {
  return buildSystemPromptWithPolicy(base, policy, roles);
}

export async function resumeLeaderFromCheckpoint(
  input: ResumeInput,
): Promise<ResumeResult> {
  const sessionStore = new LeaderSessionStore();
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();

  // 1. Load checkpoint
  const checkpoint = await sessionStore.getLatestCheckpoint(input.runId);
  if (!checkpoint) {
    return { ok: false, reason: "no_checkpoint", turnCount: 0 };
  }

  // Recover the original requestId so post-resume events stay within the
  // same per-prompt scope on the client. Legacy checkpoints written before
  // this field existed return null; for those we fall back to the runId
  // (preserves pre-refactor behavior; new turns won't hit this path).
  const recoveredRequestId = checkpoint.requestId ?? input.runId;

  // 2. Sanitize resumed messages
  let messages = sanitizeResumedMessages(checkpoint.messages);

  // 3. Append new user message if provided
  if (input.appendMessage) {
    messages = [
      ...messages,
      { type: "user" as const, content: input.appendMessage },
    ];
  }

  // 4. Record resume event
  const projector = createEventProjector({
    taskId: input.taskId,
    runId: input.runId,
    requestId: recoveredRequestId,
    ...(input.channelBindingId ? { channelBindingId: input.channelBindingId } : {}),
  });
  await projector({
    type: "leader.session_resumed",
    timestamp: new Date().toISOString(),
    data: {
      turnCount: checkpoint.turnCount,
      messageCount: messages.length,
    },
  });

  // 5. Update states
  await taskRepo.update(input.taskId, {
    state: "EXECUTING",
    updatedAt: new Date(),
  });
  await runtimeRepo.update(input.runId, {
    state: "RUNNING",
    updatedAt: new Date(),
  });

  // Resume timing + event sink — declared before config resolution so the
  // failure helper below can emit a terminal event from any early-return
  // path. `markResumeFailed` finalizes a failed resume: it marks the
  // task+runtime FAILED (unless the task already reached a terminal state
  // out-of-band — don't clobber a DONE/CANCELLED row) and emits the
  // terminal event. Used by the workspace/config early returns AND the
  // catch, so a resume that bails before or inside the loop never leaves
  // the task stuck EXECUTING.
  const resumeStartMs = Date.now();
  const eventRepository = new ExecutionEventRepository();
  const TERMINAL_TASK_STATES = new Set(["DONE", "FAILED", "CANCELLED"]);
  const markResumeFailed = async (reason: string, detail: string): Promise<void> => {
    const current = await taskRepo.getById(input.taskId);
    // Derive effective final state from task row — if task is CANCELLED
    // (cancel fired while we were winding down), preserve CANCELLED rather
    // than overwriting with FAILED (#43).
    const failEffective: "FAILED" | "CANCELLED" =
      current?.state === "CANCELLED" ? "CANCELLED" : "FAILED";
    if (!current || !TERMINAL_TASK_STATES.has(current.state)) {
      await taskRepo.update(input.taskId, {
        state: "FAILED",
        completedAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await runtimeRepo.update(input.runId, {
      state: failEffective,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    await emitResumeTerminalEvent({
      taskId: input.taskId,
      runId: input.runId,
      requestId: recoveredRequestId,
      reason,
      effectiveTaskFinal: failEffective,
      finalAnswer: detail,
      resumeStartMs,
      eventRepository,
    });
  };

  // 6. Resolve config
  let workspaceDir: string;
  try {
    workspaceDir = await resolveWorkspaceBaseDir(input.workspaceId);
  } catch {
    await markResumeFailed("workspace_error", "resume aborted: workspace could not be resolved");
    return { ok: false, reason: "workspace_error", turnCount: 0 };
  }

  let apiConfig;
  try {
    const executorConfig = await readExecutorConfigFile();
    const resolved = resolveApiConfigFromRoleRouting(executorConfig);
    if (!resolved) {
      await markResumeFailed("configuration_error", "resume aborted: no API config resolved from role routing");
      return { ok: false, reason: "configuration_error", turnCount: 0 };
    }
    // Honor per-task `/model` override across crash recovery and resume.
    // Without this, every restart silently resets the leader to the
    // agent default — the user's override would appear to "randomly
    // forget itself" after a process restart.
    try {
      const taskRow = await new TaskRepository().getById(input.taskId);
      const override = taskRow?.modelOverride ?? null;
      apiConfig = override
        ? applyModelOverrideToApiConfig(resolved, override, executorConfig)
        : resolved;
    } catch {
      apiConfig = resolved;
    }
  } catch {
    await markResumeFailed("configuration_error", "resume aborted: executor config could not be read");
    return { ok: false, reason: "configuration_error", turnCount: 0 };
  }

  const tavilyConfig = parseTavilyWebSearchConfigFromEnv();

  // 7. Rebuild canonical leader system prompt + execution policy on resume.
  //    The minimalPrompt ("helpful AI assistant") that previously lived here
  //    downgraded a crash-recovered leader into a generic write-code assistant,
  //    losing the orchestration persona AND the execution policy. We now restore
  //    the canonical LEADER_SYSTEM_PROMPT and reclassify the execution policy
  //    from whatever user text is available.
  //
  //    v1: reclassify policy on resume. TODO(follow-up): persist executionPolicy
  //    (incl. counters + runtime_escalation) in the checkpoint so a mid-task
  //    escalation survives restart (Codex review S3).
  const systemPrompt = await appendMemoryBlock("leader", LEADER_SYSTEM_PROMPT, input.taskId);

  // Derive the best available user text for policy reclassification:
  //   1. input.appendMessage (new user turn appended to this resume)
  //   2. Last user message in the restored checkpoint
  //   3. Empty string (classifier degrades gracefully to direct_answer)
  let policyUserText = input.appendMessage ?? "";
  if (!policyUserText) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.type === "user") {
        if (typeof msg.content === "string") {
          policyUserText = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textBlock = (msg.content as Array<{ type: string; text?: string }>)
            .find((b) => b.type === "text" && typeof b.text === "string");
          if (textBlock?.text) policyUserText = textBlock.text;
        }
        break;
      }
    }
  }

  const availableRoles = await resolveAvailableRoles();

  // Part 2 — Gated reclassify (Codex C9): prefer the persisted execution
  // policy so mid-task escalation counters + runtime_escalation source
  // survive a crash restart. Only reclassify from the current prompt when
  // the checkpoint has no policy (legacy checkpoints written before this
  // field existed). This ensures a task that escalated to "delegated_coding"
  // mid-run resumes with that policy intact, not silently downgraded.
  const executionPolicy: ExecutionPolicy = checkpoint.executionPolicy ?? {
    ...classifyExecutionPolicy({ prompt: policyUserText, source: "feishu", availableRoles }),
    source: "resume_recovered",
  };
  const systemPromptWithPolicy = buildSystemPromptWithPolicy(systemPrompt, executionPolicy, availableRoles);

  // Run leader loop with restored messages, canonical prompt, and fully
  // restored state (turnCount + doomState threaded through — Part 1).
  //
  // C8: Register the AbortController with the task-worker registry so
  // a crash-recovered run is cancellable (cancel route checks
  // getAbortController(taskId)). Without this, resumed runs had no
  // registered controller and were invisible to the cancel path AND
  // the stuck-EXECUTING reaper (which skips tasks with a live AC).
  const resumeAc = new AbortController();
  registerAbortController(input.taskId, resumeAc);
  try {
    const result = await runLeaderRuntime({
      taskId: input.taskId,
      runId: input.runId,
      requestId: recoveredRequestId,
      workspaceDir,
      systemPrompt: systemPromptWithPolicy,
      initialPrompt: input.appendMessage ?? "",
      restoredMessages: messages,
      ...(input.channelBindingId ? { channelBindingId: input.channelBindingId } : {}),
      apiConfig,
      tavilyConfig,
      executionPolicy,
      // Part 1: thread restored turnCount so the loop continues counting
      // from the right offset (not reset to 0 on every crash recovery).
      startTurnCount: checkpoint.turnCount,
      // Part 1: thread restored doom-loop snapshot so the detector doesn't
      // lose its fingerprint window across crash/restart.
      ...(checkpoint.doomState !== undefined ? { restoredDoomState: checkpoint.doomState } : {}),
      abortController: resumeAc,
    });

    let finalAnswer: string | undefined;
    for (const msg of result.messages) {
      if (msg.type === "assistant") {
        const content = (
          msg as {
            type: "assistant";
            content?: Array<{ type: string; text?: string }>;
          }
        ).content;
        if (content) {
          for (const block of content) {
            if (block.type === "text" && block.text) finalAnswer = block.text;
          }
        }
      }
    }

    const finalState = result.reason === "completed" ? "DONE" : "FAILED";
    // Guard: if the task already reached a terminal state out-of-band
    // (e.g. the cancel route set CANCELLED while this resumed run was
    // winding down — a cancel surfaces as an aborted_* reason, NOT a
    // throw, so it lands here, not in the catch), don't clobber it with
    // DONE/FAILED. The runtime + terminal event still reflect this run.
    const taskBeforeFinalize = await taskRepo.getById(input.taskId);
    // Derive the effective terminal state from the task row when it is
    // ALREADY terminal — preserves CANCELLED/DONE/FAILED across runtime+event
    // so they don't go inconsistent with the row (#43). Covers any terminal
    // state set out-of-band (cancel → CANCELLED; an earlier failure → FAILED).
    const effectiveTaskFinal: "DONE" | "FAILED" | "CANCELLED" =
      taskBeforeFinalize && TERMINAL_TASK_STATES.has(taskBeforeFinalize.state)
        ? (taskBeforeFinalize.state as "DONE" | "FAILED" | "CANCELLED")
        : finalState;
    if (!taskBeforeFinalize || !TERMINAL_TASK_STATES.has(taskBeforeFinalize.state)) {
      await taskRepo.update(input.taskId, {
        state: finalState,
        updatedAt: new Date(),
        completedAt: new Date(),
      });
    }
    const runtimeFinalState =
      effectiveTaskFinal === "DONE"
        ? "COMPLETED"
        : effectiveTaskFinal === "CANCELLED"
          ? "CANCELLED"
          : "FAILED";
    await runtimeRepo.update(input.runId, {
      state: runtimeFinalState,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    // Part 3 — emit terminal event so replay and live UI see the outcome.
    // The normal async path does this in processTaskExecution; the resume
    // path never did, leaving the chat exchange "stuck working" after reload.
    // Use effectiveTaskFinal so CANCELLED tasks get task:cancelled (not task:failed).
    await emitResumeTerminalEvent({
      taskId: input.taskId,
      runId: input.runId,
      requestId: recoveredRequestId,
      reason: result.reason,
      effectiveTaskFinal,
      ...(finalAnswer !== undefined ? { finalAnswer } : {}),
      resumeStartMs,
      eventRepository,
    });

    return {
      ok: true,
      reason: result.reason,
      turnCount: result.turnCount,
      ...(finalAnswer !== undefined ? { finalAnswer } : {}),
    };
  } catch (error) {
    // Mark the TASK row FAILED too — not just the runtime — so a resumed
    // run that throws doesn't leave the task stuck EXECUTING forever (the
    // reaper would keep re-reaping it). markResumeFailed guards against
    // clobbering a task already terminal out-of-band and emits the
    // terminal event.
    const errMsg = error instanceof Error ? error.message : String(error);
    await markResumeFailed("error", errMsg);

    return {
      ok: false,
      reason: "error",
      turnCount: 0,
      finalAnswer: errMsg,
    };
  } finally {
    // C8: Deregister the AbortController once the run completes (or
    // throws). Keeps the registry clean so subsequent reaper ticks
    // don't see a stale controller for a long-finished task.
    removeAbortController(input.taskId);
  }
}

/**
 * Persist + broadcast the terminal event for a resumed task.
 * Mirrors `publishSyncTerminalEvent` in process-task-intent-service.ts
 * but scoped to the resume path (no timing-breakdown complexity).
 *
 * `effectiveTaskFinal` lets callers override the event type derived from
 * `reason` — specifically, a CANCELLED task should emit `task:cancelled`
 * (not `task:failed`) even when the loop returned an `aborted_*` reason
 * rather than throwing (#43).
 */
async function emitResumeTerminalEvent(input: {
  taskId: string;
  runId: string;
  requestId: string;
  reason: string;
  effectiveTaskFinal?: "DONE" | "FAILED" | "CANCELLED";
  finalAnswer?: string;
  resumeStartMs: number;
  eventRepository: ExecutionEventRepository;
}): Promise<void> {
  // Derive terminal event type from effective task state so CANCELLED
  // is preserved in replay/Feishu rather than showing as failed.
  const effective = input.effectiveTaskFinal;
  const terminalType =
    effective === "DONE" || input.reason === "completed"
      ? "task:completed"
      : effective === "CANCELLED"
        ? "task:cancelled"
        : "task:failed";
  const terminalTimestamp = new Date().toISOString();
  const terminalData = {
    taskId: input.taskId,
    requestId: input.requestId,
    state:
      effective === "DONE" || input.reason === "completed"
        ? "DONE"
        : effective === "CANCELLED"
          ? "CANCELLED"
          : "FAILED",
    finalAnswer: input.finalAnswer ?? null,
  };
  let terminalSeq: number | undefined;
  try {
    terminalSeq = await input.eventRepository.create({
      id: `terminal_${terminalType.replace(":", "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: terminalType,
      taskId: input.taskId,
      roleRuntimeId: input.runId,
      requestId: input.requestId,
      occurredAt: new Date(terminalTimestamp),
      payloadJson: JSON.stringify(terminalData),
    });
  } catch {
    /* best-effort — broadcast still proceeds */
  }
  const broadcastPayload = {
    type: terminalType,
    requestId: input.requestId,
    data: terminalData,
    timestamp: terminalTimestamp,
    ...(terminalSeq !== undefined ? { seq: terminalSeq } : {}),
  };
  wsHub.broadcast(input.taskId, broadcastPayload);
  taskEventBus.publish(input.taskId, broadcastPayload);
}
