import type {
  EmptyResponseDiagnostic,
  LeaderLoopParams,
  LeaderLoopState,
  LeaderMessage,
  LeaderAssistantMessage,
  LeaderModelOutputEvent,
  LeaderModelCallParams,
  LeaderTerminal,
  LeaderTool,
  LeaderToolUseContext,
  ToolUseBlock,
  LeaderToolResultMessage,
} from "./autonomous-types";
import { StreamingToolExecutor } from "./streaming-tool-executor";
import { isInProcessTeammate, getTeammateContext } from "./teammate-context";
import {
  computeTokenBudget,
  estimateTokenCount,
  getAutocompactThreshold,
  isOverBudget,
} from "./token-budget";
import {
  truncateLargeToolResults,
  snipOldToolResults,
  dropOldestTurns,
  autocompact,
  extractPreviousSummary,
  getPreserveTailBudget,
  shouldAttemptLlmSummary,
} from "./message-compaction";
import { loadReadFiles } from "./progress-artifacts";
import type {
  BeforeCompactInput,
  BeforeCompactResult,
} from "./autonomous-types";
import {
  buildProgressArtifact,
  buildProgressArtifactFromState,
  formatProgressForInjection,
} from "./progress-artifacts";
import { sanitizeResumedMessages } from "../../leader-session-resume-service";
import { pairLeaderToolMessages } from "./message-pairing";
import { computeToolListDiff, hashToolsList } from "./tool-list-hasher";
import { DoomLoopDetector } from "./doom-loop-detector";
import { acquireAgentStatus, releaseAgentStatus, recordHeartbeat } from "../../agent-heartbeat-service";
import { recordUsage } from "../../token-usage-service";
import { randomUUID } from "crypto";
import { getMagisterEnv } from "../../../lib/env";
import {
  derivePlanStateFromMessages,
  detectPlanResponse,
  isInPlanMode,
  stripSentinelFromMessages,
  systemPromptAddendumFor,
  transitionPlanState,
  type PlanResponse,
  type PlanState,
} from "./plan-mode-state";
import { updateExecutionPolicyAfterTool, escalateToDelegated } from "../../leader-execution-policy-service";
import { findToolByName } from "./tool-registry";

function* yieldMissingToolResultBlocks(
  assistantMessages: LeaderAssistantMessage[],
  errorMessage: string
): Generator<LeaderToolResultMessage> {
  for (const assistantMessage of assistantMessages) {
    const toolUseBlocks = assistantMessage.content.filter(
      (block) => block.type === "tool_use"
    ) as ToolUseBlock[];

    for (const toolUse of toolUseBlocks) {
      yield {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: errorMessage,
        isError: true,
      };
    }
  }
}

function createCompactionModelAdapter(
  callModel: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>,
): (params: LeaderModelCallParams) => AsyncGenerator<LeaderAssistantMessage> {
  return async function* (params: LeaderModelCallParams): AsyncGenerator<LeaderAssistantMessage> {
    for await (const event of callModel(params)) {
      if (event.type === "assistant") {
        yield event;
        continue;
      }
      if (event.type !== "message_complete") {
        continue;
      }
      yield { type: "assistant", content: event.content };
    }
  };
}

function shouldTrackLeaderHeartbeat(runId: string): boolean {
  return runId.startsWith("rt_leader_");
}

// leader status is reference-counted by runId now. With
// the concurrent TaskWorker pool, multiple leader runtimes can be
// active in parallel, all sharing the "leader" row in `agent_profiles`.
// The previous naive `updateAgentStatus("leader", "idle")` at turn end
// would clobber a peer runtime's still-working status. acquire/release
// only writes the DB when the active-runtime set transitions 0↔1.
async function acquireLeaderStatusBestEffort(runId: string): Promise<void> {
  try {
    await acquireAgentStatus("leader", runId, "working");
  } catch {}
}
async function releaseLeaderStatusBestEffort(
  runId: string,
  status: "idle" | "error" = "idle",
): Promise<void> {
  try {
    await releaseAgentStatus("leader", runId, status);
  } catch {}
}

/**
 * Default `onBeforeCompact` implementation. Surfaces the read-files
 * ledger as additional grounding for the summary call so the LLM
 * preserves "the agent already read these files" when compressing
 * older turns. Caller can override by passing a custom
 * `onBeforeCompact` in LeaderLoopParams.
 */
export async function defaultOnBeforeCompact(
  input: BeforeCompactInput,
): Promise<BeforeCompactResult> {
  try {
    const readFiles = await loadReadFiles(input.taskId);
    if (!readFiles || readFiles.length === 0) return {};
    // Cap at 30 paths in the prompt — beyond that the cost of carrying
    // the list outweighs the value, and the [Session Progress] block
    // injected post-compact already shows the top 20.
    const shown = readFiles.slice(0, 30);
    const tail = readFiles.length > shown.length
      ? `\n(...and ${readFiles.length - shown.length} more, omitted from summary context.)`
      : "";
    return {
      extraContext: [
        `The agent has already read these files this session (newest first; do not re-read unless content has changed):\n${shown.map((p) => `- ${p}`).join("\n")}${tail}`,
      ],
    };
  } catch {
    return {};
  }
}

async function recordLeaderHeartbeatBestEffort(): Promise<void> {
  try {
    await recordHeartbeat("leader");
  } catch {}
}

// narrowed: read-only tools (grep, list_dir, read_file,
// repo_structure) are investigation, not implementation. Counting
// them toward the delegation limit punished legitimate exploration —
// a Leader checking ~5 files before deciding whether to act would hit
// the cap before doing any actual work. The cap now tracks
// **implementation** tools only (bash + the two write paths).
const LEADER_DIRECT_WORK_TOOLS = new Set([
  "bash",
  "edit_file",
  "write_file",
]);

// raised 2→4 after the guard kept blocking multi-step
// operator workflows like "fast-forward then restart prod" where
// Leader legitimately needs ~3 bash calls inside one user turn
// (git fetch + git merge + restart). With the per-user-turn reset
// added below, 4 implementation-tool calls per turn is generous
// enough for normal ops without letting Leader run away with
// implementation it should have delegated.
const LEADER_DIRECT_WORK_LIMIT = 4;

function isDelegationGuardEligible(params: LeaderLoopParams): boolean {
  const roleId = params.roleId ?? "leader";
  return roleId === "leader" && !isInProcessTeammate();
}

function isLeaderDirectWorkTool(toolName: string): boolean {
  return LEADER_DIRECT_WORK_TOOLS.has(toolName);
}

function latestUserText(messages: readonly LeaderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.type !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function hasExplicitDirectWorkIntent(messages: readonly LeaderMessage[]): boolean {
  const text = latestUserText(messages);
  if (!text.trim()) return false;

  return [
    /\b(?:do not|don't|no|without)\s+(?:use\s+)?(?:subagents?|sub-agents?|teammates?|delegat(?:e|ion)|spawn(?:ing)?)\b/i,
    /\b(?:do|handle|implement|fix|work)\s+(?:it\s+)?(?:yourself|directly)\b/i,
    /\b(?:leader|you)\s+(?:must|should|please\s+)?(?:do|handle|implement|fix|work)\b.*\b(?:yourself|directly)\b/i,
    /(?:不要|别|禁止).*(?:subagent|sub-agent|teammate|spawn|委派|代理|帮手)/i,
    /(?:直接|亲自).*(?:执行|实现|修复|修改|改|做)/,
  ].some((pattern) => pattern.test(text));
}


export async function* leaderLoop(
  params: LeaderLoopParams
): AsyncGenerator<LeaderMessage, LeaderTerminal> {
  const {
    messages,
    systemPrompt,
    tools: initialTools,
    maxTurns,
    abortController,
    recordEvent,
    callModel,
    onBeforeCompact,
    onAfterCompact,
  } = params;
  // Spec §4 — per-turn tool list reload with content-hash short-
  // circuit. `currentTools` is rebound at each turn boundary; when
  // `reloadTools` is provided AND the new list's content-hash
  // differs from the previous, we replace the reference (and emit
  // `leader.tools_reloaded`). Otherwise we reuse the prior reference
  // so the wire bytes stay identical and the provider's prompt cache
  // prefix (system + tools) keeps hitting. Set via
  // `MAGISTER_TOOLS_HOT_RELOAD=off` to fully disable.
  let currentTools: readonly LeaderTool[] = initialTools;
  let currentToolsHash: string = hashToolsList(initialTools);
  const toolsHotReloadEnabled =
    (getMagisterEnv("MAGISTER_TOOLS_HOT_RELOAD") ?? "on").toLowerCase() !== "off";
  const budgetContextWindow = params.contextWindow;
  const budgetMaxOutputTokens = params.maxOutputTokens;
  const initialMessages = messages.length > 1
    ? sanitizeResumedMessages(messages)
    : messages;

  // Plan-mode state machine. Derive initial state from the message
  // history so a crash mid-AWAITING_APPROVAL is resumed correctly.
  // We wrap the loop's `recordEvent` so that wherever a plan event is
  // emitted (by a tool's call(), by the loop's preflight, by anything
  // else holding `context.recordEvent`), the in-memory state is kept
  // in lockstep with the durable event log. See plan-mode-state.ts
  // and spec §5.
  let planState: PlanState = derivePlanStateFromMessages(initialMessages);
  // Tracks whether the user has approved a plan during THIS run. Set
  // when the preflight detects a `__PLAN_APPROVED__` sentinel; passed
  // into toolUseContext on subsequent turns so the bash danger-command
  // gate can skip its second-layer prompt — the user already approved
  // the plan that listed this command, asking again is friction.
  // Resets to false on process restart (a resumed run starts with the
  // checkpoint replay; if the model is mid-execution-of-approved-plan
  // it will keep emitting tool_use and the user can re-approve at the
  // bash gate as before — strictly safer fallback).
  let planApprovedThisRun = false;
  // Circuit breaker for the LLM autocompact step — three consecutive
  // failures (call rejected, empty response, or pre-existing error)
  // suppress the LLM stage until end-of-loop, falling back to
  // mechanical-only compaction (truncate / snip / drop). Without
  // this guard, a provider that 400s the summarization prompt would
  // be re-asked every turn until the loop hits maxTurns. Reset to 0
  // on every successful compaction so the breaker doesn't spuriously
  // open across long, healthy sessions.
  let compactFailureCount = 0;
  const COMPACT_FAILURE_LIMIT = 3;
  let userCompactHint: string | null = null;
  let forceUserCompact = false;
  // The synthetic `forced=true` plan_mode_entered emitted by the
  // planFirst-toggle path doesn't add an `enter_plan_mode` tool_use
  // to the message log — it's an event-only transition. So a
  // resumed loop walking the message log via
  // `derivePlanStateFromMessages` would never see PLANNING, and a
  // subsequent `exit_plan_mode` tool_use wouldn't transition to
  // AWAITING_APPROVAL (the IDLE→AWAITING_APPROVAL gate requires the
  // intermediate PLANNING state). The durable event log IS the
  // authoritative source: caller passes `initialPlanRequestId` when
  // a `leader.plan_proposed` is open without a matching
  // `leader.plan_mode_exited`. If that's set, force state to
  // AWAITING_APPROVAL regardless of what the messages alone implied.
  if (params.initialPlanRequestId && planState !== "AWAITING_APPROVAL") {
    planState = "AWAITING_APPROVAL";
  }

  // Last-known actual input-token count from the provider response.
  // We use this as the authoritative baseline for compaction decisions
  // — far more accurate than the heuristic estimator since the
  // provider's tokenizer is the same one the model itself uses.
  // For the first turn (before any callModel return) we fall back to
  // the heuristic. After turn 1, the next turn's estimate is the
  // last-actual + heuristic-delta-from-new-messages.
  let lastActualInputTokens: number | null = null;
  // Snapshot of how many messages had been seen at the time
  // `lastActualInputTokens` was recorded — used to scope the
  // delta-estimate to messages added since the last API call.
  let lastActualMessageCount = 0;
  // Tracks the requestId under which the OPEN `leader.plan_proposed`
  // event was stamped. Rewritten into outgoing `leader.plan_mode_exited`
  // events so they land in the same exchange (and PlanCard) as the
  // original proposal — even after a resume that runs under a fresh
  // requestId. Initialized from `params.initialPlanRequestId` (caller
  // looks it up from the event log on resume).
  let currentPlanRequestId: string | null = params.initialPlanRequestId ?? null;
  const planAwareRecordEvent: typeof recordEvent = async (event) => {
    let outgoing = event;
    if (event.type === "leader.plan_mode_exited" && currentPlanRequestId) {
      // Re-stamp with the proposal's requestId so the live and replay
      // projectors apply this to the right exchange.
      outgoing = {
        ...event,
        data: { ...event.data, requestId: currentPlanRequestId },
      };
    }
    await recordEvent(outgoing);
    let transitioned = false;
    if (event.type === "leader.plan_mode_entered") {
      planState = transitionPlanState(planState, "leader.plan_mode_entered");
      transitioned = true;
    } else if (event.type === "leader.plan_proposed") {
      planState = transitionPlanState(planState, "leader.plan_proposed");
      const proposalRequestId = (event.data as { requestId?: string })?.requestId;
      if (proposalRequestId) currentPlanRequestId = proposalRequestId;
      transitioned = true;
    } else if (event.type === "leader.plan_mode_exited") {
      const reason = (event.data as { reason?: "approved" | "cancelled" | "revised" })?.reason;
      planState = transitionPlanState(planState, "leader.plan_mode_exited", reason);
      // Clear the open plan id — next plan flow gets a fresh one.
      currentPlanRequestId = null;
      transitioned = true;
    }
    // Intra-turn freshness: if a tool just transitioned plan state
    // (e.g. enter_plan_mode emitted leader.plan_mode_entered), mutate
    // the live toolUseContext so the NEXT tool call in the same turn
    // sees the updated `inPlanMode` flag. Without this, a turn that
    // does enter_plan_mode → exit_plan_mode back-to-back would have
    // exit_plan_mode see the turn-start snapshot (IDLE) and falsely
    // trip its IDLE guard. The local `toolUseContext` and
    // `state.toolUseContext` are the same reference at executor-
    // construction time, so mutating the property here propagates.
    if (transitioned && state) {
      state.toolUseContext.inPlanMode = isInPlanMode(planState);
      state.toolUseContext.alreadyAwaitingApproval = planState === "AWAITING_APPROVAL";
    }
  };

  let state: LeaderLoopState = {
    messages: initialMessages,
    // Override `recordEvent` with our plan-aware wrapper so the in-memory
    // planState stays in lockstep with whatever any tool's call() emits.
    toolUseContext: {
      ...createToolUseContext(params),
      recordEvent: planAwareRecordEvent,
      ...(params.executionPolicy !== undefined ? { executionPolicy: params.executionPolicy } : {}),
    },
    turnCount: params.startTurnCount ?? 1,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    ...(params.executionPolicy !== undefined ? { executionPolicy: params.executionPolicy } : {}),
  };
  const doomLoopDetector = new DoomLoopDetector();
  if (params.restoredDoomState) doomLoopDetector.restore(params.restoredDoomState);

  /** Build a checkpoint payload with executionPolicy + doomState always included. */
  const buildCheckpoint = (
    messages: LeaderMessage[],
    turnCount: number,
    extra?: Record<string, unknown>,
  ) => ({
    sessionId: params.sessionId ?? params.runId,
    turnCount,
    messages,
    ...(state.executionPolicy !== undefined ? { executionPolicy: state.executionPolicy } : {}),
    doomState: doomLoopDetector.snapshot(),
    ...extra,
  });

  let leaderDirectWorkCount = 0;
  const trackLeaderHeartbeat = shouldTrackLeaderHeartbeat(params.runId);
  const returnWithLeaderStatus = async (
    terminal: LeaderTerminal,
    status: "idle" | "error" = "idle",
  ): Promise<LeaderTerminal> => {
    if (trackLeaderHeartbeat) {
      await releaseLeaderStatusBestEffort(params.runId, status);
    }
    return terminal;
  };

  if (trackLeaderHeartbeat) {
    await acquireLeaderStatusBestEffort(params.runId);
  }

  // Emit one telemetry event for the classified execution policy (TELEMETRY-ONLY — no enforcement).
  if (params.executionPolicy !== undefined) {
    await planAwareRecordEvent({
      type: "leader.execution_policy_set",
      timestamp: new Date().toISOString(),
      data: {
        mode: params.executionPolicy.mode,
        source: params.executionPolicy.source,
        reason: params.executionPolicy.reason,
        requestId: params.requestId,
        turnIndex: params.startTurnCount ?? 1,
        counters: params.executionPolicy.counters,
      },
    });
  }

  // User-toggled plan-first: enforce plan mode at the state-machine
  // level rather than relying on the model to obey the system-prompt
  // instruction to call `enter_plan_mode`. Smaller / less instruction-
  // following models would otherwise silently skip plan mode and fall
  // straight through to write tools (kimi-k2.6 was observed doing
  // exactly this — answering trivial reads without entering plan mode,
  // then committing on the next message). State enforcement is the
  // authoritative gate; the systemPrompt addendum still fires as a hint
  // to the model so it knows it's in plan mode.
  //
  // Idempotent: only fires when state is currently IDLE. If we resumed
  // a session already in PLANNING / AWAITING_APPROVAL, we leave it.
  if (params.planFirst === true && planState === "IDLE") {
    await planAwareRecordEvent({
      type: "leader.plan_mode_entered",
      timestamp: new Date().toISOString(),
      data: {
        taskId: params.taskId,
        requestId: params.requestId,
        runId: params.runId,
        turnIndex: params.startTurnCount ?? 1,
        forced: true,
      },
    });
  }

  while (true) {
    let { toolUseContext } = state;
    let { messages: currentMessages } = state;
    const { turnCount } = state;
    let compactedThisTurn = false;
    let doomLoopBlockedThisTurn = false;

    // Spec §4 — per-turn tool list reload with content-hash short-
    // circuit. When `params.reloadTools` is supplied AND the env
    // escape hatch isn't off, re-resolve the tool list. If its
    // content hash differs from the previous turn's, replace the
    // current reference + emit `leader.tools_reloaded`. Otherwise
    // reuse the existing reference so the wire bytes remain
    // byte-identical (prompt cache stays warm).
    if (toolsHotReloadEnabled && params.reloadTools) {
      try {
        const candidate = await params.reloadTools();
        const candidateHash = hashToolsList(candidate);
        if (candidateHash !== currentToolsHash) {
          const diff = computeToolListDiff(currentTools, candidate);
          await recordEvent({
            type: "leader.tools_reloaded",
            timestamp: new Date().toISOString(),
            data: {
              turnCount,
              added: diff.added,
              removed: diff.removed,
              toolCount: candidate.length,
              previousHash: currentToolsHash,
              nextHash: candidateHash,
              cacheWillInvalidate: true,
            },
          });
          currentTools = candidate;
          currentToolsHash = candidateHash;
        }
      } catch (err) {
        // Best-effort: reload failure leaves the prior tool list
        // intact rather than blocking the turn. The model just
        // doesn't see any newly-attached MCP / skill / profile
        // change this turn; the next turn retries. Emit a
        // structured event so observability tooling can surface
        // persistent reload failures without scraping logs.
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[leader-loop] reloadTools failed; staying on previous tool list (${currentToolsHash}): ${reason}`,
        );
        try {
          await recordEvent({
            type: "leader.tools_reload_failed",
            timestamp: new Date().toISOString(),
            data: {
              turnCount,
              previousHash: currentToolsHash,
              reason: reason.slice(0, 500),
            },
          });
        } catch {
          // Event recording is best-effort itself; don't let it
          // mask the original reload failure.
        }
      }
    }

    if (trackLeaderHeartbeat) {
      await recordLeaderHeartbeatBestEffort();
    }

    if (abortController.signal.aborted) {
      await recordEvent({
        type: "leader.aborted",
        timestamp: new Date().toISOString(),
        data: { turnCount, reason: abortController.signal.reason ?? "unknown" },
      });
      return await returnWithLeaderStatus({ reason: "aborted_streaming", turnCount });
    }

    const queryTracking = {
      chainId: randomUUID(),
      depth: isInProcessTeammate() ? (getTeammateContext()?.agentId?.length ?? 0) + 1 : 0,
    };

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
      messages: currentMessages,
      // Keep `context.tools` in lockstep with the loop's per-turn
      // `currentTools` (spec §4 codex review): tools added/removed
      // by hot-reload must reach any tool callback that inspects
      // `context.tools` (e.g., spawn_teammate description lookup).
      tools: currentTools,
    };

    await recordEvent({
      type: "leader.turn_start",
      timestamp: new Date().toISOString(),
      data: { turnCount, chainId: queryTracking.chainId },
    });

    // F1 (audit 2026-05-08) — drain mailbox at the TOP of the iteration,
    // not the end. Previously mailbox drained at line ~1135 AFTER the
    // AWAITING_APPROVAL short-circuit at ~1082. If a user clicked
    // Approve while a planning turn was still streaming, the resulting
    // mailbox row would never be seen — the next iteration short-
    // circuits on AWAITING_APPROVAL before reaching the drain block,
    // then exits "completed" → loop halts forever. Draining first lets
    // the plan-mode preflight (line ~570) see the sentinel and
    // transition state correctly. Leader-only (depth 0): teammates
    // run in-process and must not intercept human follow-ups.

    // Check for user-triggered compaction requests written by POST /tasks/:id/compact.
    try {
      const { ExecutionEventRepository } = await import("../../../repositories/execution-event-repository");
      const compactEventRepo = new ExecutionEventRepository();
      const compactRequests = await compactEventRepo.listByTaskIdAndType(
        params.taskId,
        "leader.compact_requested",
        1,
      );
      if (compactRequests.length > 0) {
        const payload = JSON.parse(compactRequests[0]!.payloadJson || "{}");
        userCompactHint = typeof payload.hint === "string" ? payload.hint : null;
        forceUserCompact = true;
        await compactEventRepo.deleteById(compactRequests[0]!.id);
        console.log(`[compact] User-requested compaction${userCompactHint ? ` (hint: ${userCompactHint})` : ""}`);
      }
    } catch (err) {
      console.warn("[compact] Failed to check compact requests:", err);
    }

    const isLeaderForMailbox = !isInProcessTeammate();
    if (isLeaderForMailbox) {
      try {
        const { TaskMailboxRepository } = await import("../../../repositories/task-mailbox-repository");
        const mailboxRepo = new TaskMailboxRepository();
        const pending = await mailboxRepo.getUnconsumed(params.taskId);
        if (pending.length > 0) {
          const { loadAttachmentBlocksForRequest } = await import("../../attachment-service");
          const mailboxMessages: LeaderMessage[] = [];
          for (const m of pending) {
            // Check for structured teammate completion metadata first.
            // These messages are injected by the async completion service
            // (not by the user) and need a richer model-facing format.
            let metadata: Record<string, unknown> | null = null;
            try {
              const rawMetadata = (m as { metadataJson?: string | null }).metadataJson;
              metadata = rawMetadata ? JSON.parse(rawMetadata) : null;
            } catch {
              // Ignore malformed metadata — fall through to plain handling.
            }

            if (metadata && metadata.type === "teammate_completion") {
              const role = String(metadata.role ?? "?");
              const runId = String(metadata.teammateRunId ?? "?");
              const status = String(metadata.status ?? "COMPLETED");
              const summary = String(metadata.summary ?? "");
              const statusVerb =
                status === "COMPLETED"
                  ? "completed"
                  : status === "FAILED"
                  ? "failed"
                  : "was cancelled";
              // Inject as a user message so the model sees it in context.
              // isMeta: true marks it as system-injected (not user-typed)
              // so the backend resume filter keeps it durable but does not
              // surface it as a user bubble in the chat history reply.
              mailboxMessages.push({
                type: "user" as const,
                content: `Background teammate ${role} (${runId}) ${statusVerb}.\n\n${summary}`,
                isMeta: true,
              } as LeaderMessage);
              // Emit a dedicated execution event so the chat projector can
              // render a teammate-completion card (not a generic user bubble).
              await recordEvent({
                type: "leader.async_teammate_consumed",
                timestamp: new Date().toISOString(),
                data: { ...metadata },
              });
              continue;
            }

            // Stamp the mailbox row's requestId so the prompt-to-exchange
            // binding survives checkpoint round-trip. When this message
            // is later returned by GET /tasks/:id/messages, the frontend
            // looks up the exchange whose id matches `requestId` — no
            // tail-position guessing. Pre-fix mailbox rows have no
            // requestId (omit field; frontend's tail-pair fallback
            // kicks in for those).
            const rowRequestIdField = m.requestId ? { requestId: m.requestId } : {};
            if (m.requestId) {
              const blocks = await loadAttachmentBlocksForRequest(params.taskId, m.requestId).catch(() => []);
              if (blocks.length > 0) {
                mailboxMessages.push({
                  type: "user" as const,
                  content: [{ type: "text" as const, text: m.content }, ...blocks],
                  ...rowRequestIdField,
                });
                continue;
              }
            }
            mailboxMessages.push({
              type: "user" as const,
              content: m.content,
              ...rowRequestIdField,
            });
          }
          // Append to messages BEFORE marking consumed. If a crash
          // happens between the in-memory append and the next
          // checkpoint write (which captures `state.messages`), the
          // mailbox rows are still pending and will be re-ingested on
          // the next leader resume — strictly safer than the prior
          // "consume first, hope checkpoint catches up later" order
          // (audit Finding F5).
          currentMessages = [...currentMessages, ...mailboxMessages];
          state = { ...state, messages: currentMessages };
          await mailboxRepo.markConsumed(pending.map((m) => m.id));
          // Delegation-guard direct-work counter must
          // reset on a fresh user turn. Before this, the counter
          // accumulated across turns within the same task session,
          // so the operator's third user message in a session would
          // start with a depleted budget and get blocked on the first
          // ops bash. Always reset regardless of guard enable state;
          // the counter is harmless when the guard is disabled.
          if (pending.some((m) => m.sender === "user")) {
            leaderDirectWorkCount = 0;
          }
          await recordEvent({
            type: "leader.mailbox_consumed",
            timestamp: new Date().toISOString(),
            data: { count: pending.length },
          });
          // Per-row merge trace. Each consumed mailbox prompt gets its
          // own event tagged with the run's requestId (the projector
          // defaults to context.requestId, so omitting data.requestId
          // routes the event into the run's exchange). The payload
          // carries `sourceRequestId` so the frontend projector can
          // locate the orphan optimistic exchange that was created when
          // the user POSTed this prompt and fold it into the run's
          // exchange — see chat-projector handler for `task.prompt_merged`.
          // Pre-fix mailbox rows (no requestId minted at POST time) emit
          // null as sourceRequestId; the frontend handles that by
          // appending content directly to the run's exchange without a
          // source-fold step.
          for (const m of pending) {
            // Skip async teammate completion rows. They emit their own
            // `leader.async_teammate_consumed` event (the chat projector
            // renders a dedicated completion chip from that). Without
            // this guard, prompt_merged would ALSO fold the
            // `[teammate completed] ...` text into the user bubble,
            // producing a duplicate render.
            let isTeammateCompletion = false;
            try {
              const rawMeta = (m as { metadataJson?: string | null }).metadataJson;
              if (rawMeta) {
                const meta = JSON.parse(rawMeta) as { type?: string };
                isTeammateCompletion = meta.type === "teammate_completion";
              }
            } catch {
              // ignore malformed metadata
            }
            if (isTeammateCompletion) continue;

            await recordEvent({
              type: "task.prompt_merged",
              timestamp: new Date().toISOString(),
              data: {
                sourceRequestId: m.requestId ?? null,
                intoRequestId: params.requestId,
                content: m.content,
                mailboxRowId: m.id,
              },
            });
          }
        }
      } catch {}
    }

    // --- Compaction check ---
    let messagesForModel = currentMessages;
    // Use durable-state-backed progress artifact (PR2) for the
    // [Session Progress] re-injection block so the leader sees the
    // CURRENT plan / spawned teammates / pending approvals / recent
    // artifacts after compaction, not just what the message stream
    // reveals. Falls back to message-only on any DB error so a
    // flaky DB never blocks compaction.
    const progressArtifact = await buildProgressArtifactFromState(
      messagesForModel,
      { taskId: params.taskId, runId: params.runId },
    ).catch(() => buildProgressArtifact(messagesForModel));
    const budget = computeTokenBudget(budgetContextWindow, budgetMaxOutputTokens);
    // Prefer the provider's actual count from the previous call as
    // the baseline, then add a heuristic estimate for messages added
    // since (assistant tool_use + tool_result blocks from this turn's
    // tail). The estimator is only used pure-form for the very first
    // turn, where there's no prior actual count to lean on.
    const tokenEstimate = lastActualInputTokens !== null
      ? lastActualInputTokens
        + estimateTokenCount(messagesForModel.slice(lastActualMessageCount))
      : estimateTokenCount(messagesForModel);

    // Proactive compaction trigger: fire when the input estimate
    // crosses ~70% of `availableForInput` (configurable). The hard
    // `isOverBudget` check still guards the ceiling — this just
    // brings the trigger forward so cumulative token cost across
    // long sessions stays bounded (each turn re-sends history; an
    // earlier compaction drops the tail before it's replayed N more
    // times). Fix for a previously dead knob — see token-budget.ts.
    const proactiveThreshold = getAutocompactThreshold(budget);
    const shouldCompact =
      forceUserCompact || isOverBudget(tokenEstimate, budget) || tokenEstimate > proactiveThreshold;

    if (shouldCompact) {
      const triggerReason = forceUserCompact ? "user_requested" : isOverBudget(tokenEstimate, budget) ? "hard_cap" : "proactive";
      console.warn(
        `[token-budget] Estimated ${tokenEstimate} tokens (trigger=${triggerReason}, hardCap=${budget.availableForInput}, proactiveThreshold=${proactiveThreshold}) — compacting`,
      );

      // M5 Phase 3 codex-round-3: fire the memory extractor BEFORE
      // mechanical truncate/snip/drop runs, so it sees the full
      // pre-compact context. Previously the extractor only fired
      // inside the LLM-compaction branch via onBeforeCompact;
      // mechanical-only paths (breaker open, LLM disabled, post-mech
      // already under threshold) dropped messages without ever
      // giving the extractor a chance. Fire-and-forget; singleflight
      // in `memory-extractor-service` collapses overlapping calls.
      try {
        const { firePreCompactExtraction } = await import(
          "../../memory/memory-pre-compact-hook"
        );
        const beforeInputPreMech = extractPreviousSummary(messagesForModel);
        void firePreCompactExtraction({
          taskId: params.taskId,
          runId: params.runId,
          messages: messagesForModel,
          previousSummary: beforeInputPreMech.previousSummary,
        });
      } catch {
        // Memory not initialized in legacy/test envs — best-effort.
      }

      let truncatedCount = 0;
      let snippedCount = 0;
      let droppedCount = 0;
      let llmCompacted = false;
      let llmAttempted = false;
      let llmFailedThisTurn = false;
      let summaryText: string | undefined;
      let preservedTailTokens: number | undefined;
      let tailStartMessageIdx: number | undefined;
      let summaryRetryCount: number | undefined;
      const preserveTailBudget = getPreserveTailBudget(budget.availableForInput);

      // Step 1: truncate oversized tool_result payloads (mechanical).
      const truncateResult = truncateLargeToolResults(messagesForModel);
      messagesForModel = truncateResult.messages;
      truncatedCount = truncateResult.truncatedCount;

      // Step 2: snip old tool_result payloads (mechanical, token-budgeted tail).
      const snipResult = snipOldToolResults(messagesForModel, preserveTailBudget);
      messagesForModel = snipResult.messages;
      snippedCount = snipResult.snippedCount;

      // Step 3 (was step 5): LLM autocompact BEFORE drop-oldest-turns
      // — drop discards information that the LLM summary could've
      // captured. Skip when the breaker is open (consecutive prior
      // failures); fall through to mechanical drop.
      //
      // P1.7 — Diagnostics tab on 2026-05-08 showed 13/13 historical
      // compaction events had `llmAttempted = false`. Root cause: the
      // prior `stillNeedsCompaction` check used POST-mechanical tokens.
      // When a single oversized tool_result gets truncated (3M → 3k
      // tokens), the rest of the history is fine — but the conversation
      // is still long enough that an LLM summary would help future
      // turns. Now we attempt LLM whenever the PRE-mechanical input
      // was over threshold, so semantic compaction fires for organic
      // chat growth too, not only for the runaway-blob case mechanical
      // already handled.
      const llmAllowed = compactFailureCount < COMPACT_FAILURE_LIMIT;
      const postMechTokens = estimateTokenCount(messagesForModel);
      // Decide whether to attempt the LLM summary (see shouldAttemptLlmSummary
      // for the full rationale). Key point: a MANUAL `/compact`
      // (forceUserCompact) always attempts it regardless of threshold.
      const attemptLlmSummary = shouldAttemptLlmSummary({
        llmAllowed,
        forceUserCompact,
        preMechTokens: tokenEstimate,
        postMechTokens,
        proactiveThreshold,
        overBudget: isOverBudget(postMechTokens, budget),
      });
      if (attemptLlmSummary) {
        llmAttempted = true;
        // Pre-compact hook: caller-provided override OR our default
        // (read-files ledger). Errors are swallowed — compaction
        // proceeds with no extra context rather than failing the
        // turn.
        const beforeHook = onBeforeCompact ?? defaultOnBeforeCompact;
        let extraContext: string[] | undefined;
        try {
          const beforeInput = extractPreviousSummary(messagesForModel);
          const result = await beforeHook({
            taskId: params.taskId,
            runId: params.runId,
            messages: messagesForModel,
            previousSummary: beforeInput.previousSummary,
          });
          extraContext = result.extraContext;
        } catch (err) {
          console.warn(
            `[compact-hook] onBeforeCompact threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const compactResult = await autocompact(
          messagesForModel,
          createCompactionModelAdapter(callModel),
          systemPrompt,
          {
            preserveTailTokens: preserveTailBudget,
            ...(extraContext && extraContext.length > 0 ? { extraContext } : {}),
          },
        );
        if (compactResult.compacted) {
          messagesForModel = compactResult.messages;
          llmCompacted = true;
          summaryText = compactResult.summaryText;
          preservedTailTokens = compactResult.preservedTailTokens;
          tailStartMessageIdx = compactResult.tailStartMessageIdx;
          summaryRetryCount = compactResult.summaryRetryCount;
          compactFailureCount = 0; // reset on success
          // Post-compact hook fires only on a real successful summary.
          // Errors swallowed — the compaction itself already landed.
          if (onAfterCompact) {
            try {
              await onAfterCompact({
                taskId: params.taskId,
                runId: params.runId,
                summaryText: compactResult.summaryText ?? "",
                preservedTailTokens: compactResult.preservedTailTokens ?? 0,
                tailStartMessageIdx: compactResult.tailStartMessageIdx ?? 0,
                triggerReason,
              });
            } catch (err) {
              console.warn(
                `[compact-hook] onAfterCompact threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else if (compactResult.failed === true) {
          llmFailedThisTurn = true;
          compactFailureCount += 1;
        }
      }

      // Step 4 (was steps 3/4): mechanical drop-oldest as last resort.
      // Only fires when LLM compaction either was skipped (breaker
      // open), errored, or didn't bring us under budget.
      for (let i = 0; i < 3 && isOverBudget(estimateTokenCount(messagesForModel), budget); i++) {
        const dropResult = dropOldestTurns(messagesForModel, 1);
        if (dropResult.droppedCount === 0) {
          break;
        }
        messagesForModel = dropResult.messages;
        droppedCount += dropResult.droppedCount;
      }

      if (truncatedCount > 0 || snippedCount > 0 || droppedCount > 0 || llmCompacted) {
        compactedThisTurn = true;
        // Compaction invalidates the pinned actual-input baseline —
        // we just dropped / collapsed messages, so the previous turn's
        // count no longer corresponds to the message log we're sending.
        // Reset to null so the next compaction check uses pure estimate
        // for ONE turn, then re-pins from the next call's real usage.
        lastActualInputTokens = null;
        lastActualMessageCount = 0;
        currentMessages = messagesForModel;
        currentMessages = [
          { type: "user", content: formatProgressForInjection(progressArtifact), isMeta: true },
          ...currentMessages.filter(
            (m) => !(m.type === "user"
              && m.isMeta
              && typeof m.content === "string"
              && m.content.startsWith("[Session Progress]")),
          ),
        ];
        messagesForModel = currentMessages;
        await recordEvent({
          type: "leader.messages_compacted",
          timestamp: new Date().toISOString(),
          data: {
            triggerReason,
            preCompactTokens: tokenEstimate,
            postCompactTokens: estimateTokenCount(messagesForModel),
            truncatedCount,
            snippedCount,
            droppedCount,
            llmCompacted,
            llmAttempted,
            llmFailedThisTurn,
            consecutiveLlmFailures: compactFailureCount,
            breakerOpen: compactFailureCount >= COMPACT_FAILURE_LIMIT,
            ...(summaryText !== undefined ? { summaryText } : {}),
            ...(preservedTailTokens !== undefined ? { preservedTailTokens } : {}),
            ...(tailStartMessageIdx !== undefined ? { tailStartMessageIdx } : {}),
            ...(summaryRetryCount !== undefined ? { summaryRetryCount } : {}),
          },
        });
      }
    }
    forceUserCompact = false;
    userCompactHint = null;
    // --- End compaction ---

    // --- Plan-mode token preflight (spec §5 + §6) ---
    // When the leader is AWAITING_APPROVAL and the most-recent user
    // message is one of the plan sentinels (__PLAN_APPROVED__,
    // __PLAN_CANCELLED__, __PLAN_REVISED__:fb), emit the corresponding
    // plan_mode_exited event, strip the sentinel from what the model
    // sees, and append a one-line system-prompt addendum for this turn
    // explaining what the user did. Lives between compaction and
    // callModel so it's the only chokepoint for ALL incoming-message
    // paths (fresh send, resume, retry).
    let systemPromptForTurn = systemPrompt;
    if (planState === "AWAITING_APPROVAL") {
      const lastUser = lastUserMessageText(messagesForModel);
      const detected: PlanResponse | null = lastUser ? detectPlanResponse(lastUser) : null;
      if (detected) {
        await planAwareRecordEvent({
          type: "leader.plan_mode_exited",
          timestamp: new Date().toISOString(),
          data: {
            taskId: params.taskId,
            requestId: params.requestId,
            runId: params.runId,
            reason: detected.kind,
            ...(detected.kind === "revised" ? { feedback: detected.feedback } : {}),
          },
        });
        // Strip from BOTH the model-input view AND the durable message
        // log. If we strip only `messagesForModel`, the checkpoint
        // (built from `currentMessages` further down) preserves the
        // raw `__PLAN_APPROVED__` sentinel — on crash + restore, the
        // replayed history feeds the raw token to the model again, and
        // any future preflight pass would re-trigger the same
        // transition. The synthetic substitute (`[user approved the
        // plan]`) is the right durable form.
        messagesForModel = stripSentinelFromMessages(messagesForModel, detected);
        currentMessages = stripSentinelFromMessages(currentMessages, detected);
        state = { ...state, messages: currentMessages };
        systemPromptForTurn = systemPrompt + systemPromptAddendumFor(detected);

        // Bug-A checkpoint IMMEDIATELY after the
        // sentinel strip. Previously the substituted message
        // (`[user approved the plan]`) only landed in the next
        // end-of-turn checkpoint at line ~1100. If the post-approval
        // turn died mid-execution (e.g. spawn_teammate that never
        // returned a tool_result, or the model hit an error after
        // emitting tool_uses), the loop would restart from the
        // PRIOR checkpoint — which still had the raw `__PLAN_APPROVED__`
        // gone but no substitute either, so planState re-derived as
        // AWAITING_APPROVAL and any natural-language follow-up
        // (e.g. "继续") would NOT trigger a re-strip and the loop
        // would halt again. The user thinks they approved; Magister
        // thinks they didn't.
        //
        // Fix: persist the substitute as soon as we know it's safe
        // (i.e. before any model call). approved/revised continue
        // to the model; cancelled checkpoints below as part of the
        // hard-stop. This costs one extra checkpoint write per
        // approval — negligible given the rarity.
        if (params.onCheckpoint && detected.kind !== "cancelled") {
          await params.onCheckpoint(buildCheckpoint(currentMessages, turnCount));
        }

        // Approve unlocks the bash danger-command gate for the rest
        // of this run — the user already audited the plan, so a
        // second prompt on each `rm -rf` listed in it is redundant
        // friction. Cancel/revise leave the gate active (cancel
        // short-circuits below; revise loops back to PLANNING).
        if (detected.kind === "approved") {
          planApprovedThisRun = true;
        }

        // Cancel hard-stop. The system-prompt addendum tells the model
        // "user cancelled, do not execute." But less-instruction-
        // following models (qwen3.6 / kimi-k2.6 observed) ignore that
        // and proceed to do the cancelled work directly. State-level
        // enforcement: short-circuit the run BEFORE callModel — emit
        // a deterministic acknowledgment text, persist the checkpoint
        // with the substituted message log, fire session_complete,
        // and exit. Approve and revise still go through the model
        // (approve → execute the plan, revise → produce a new plan).
        if (detected.kind === "cancelled") {
          const ackMessage: LeaderAssistantMessage = {
            type: "assistant",
            content: [{ type: "text", text: "Plan cancelled. No changes made." }],
          };
          yield ackMessage;
          if (params.onCheckpoint) {
            await params.onCheckpoint(buildCheckpoint([...currentMessages, ackMessage], turnCount));
          }
          await recordEvent({
            type: "leader.session_complete",
            timestamp: new Date().toISOString(),
            data: {
              taskId: params.taskId,
              requestId: params.requestId,
              runId: params.runId,
              reason: "plan_cancelled",
            },
          });
          return await returnWithLeaderStatus({ reason: "completed", turnCount });
        }
      }
    }
    // --- End plan-mode preflight ---

    // Refresh the toolUseContext for THIS turn with the current
    // inPlanMode flag derived from planState (plus the latest
    // messages for tool execution context).
    //
    // CRITICAL: must reassign the LOCAL `toolUseContext` — the
    // `StreamingToolExecutor` constructed below reads from this local,
    // not from `state.toolUseContext`. Earlier draft only updated
    // state.* and the executor saw a stale `inPlanMode: undefined` —
    // every plan-mode turn would have bypassed the plan-safe gate.
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForModel,
      tools: currentTools,  // spec §4 — match the top-of-turn snapshot
      inPlanMode: isInPlanMode(planState),
      alreadyAwaitingApproval: planState === "AWAITING_APPROVAL",
      planApprovedThisRun,
      turnIndex: turnCount,
    };
    state.toolUseContext = toolUseContext;

    const assistantMessages: LeaderAssistantMessage[] = [];
    const toolUseBlocks: ToolUseBlock[] = [];
    let needsFollowUp = false;

    const streamingExecutor = new StreamingToolExecutor(currentTools, toolUseContext);
    const pendingBlockedToolResults: LeaderToolResultMessage[] = [];
    const blockedToolResultsForTurn: LeaderToolResultMessage[] = [];
    const toolUseGateById = new Map<string, { blocked: boolean }>();
    let decisionTraceRecorded = false;
    const delegationGuardEnabled =
      isDelegationGuardEligible(params)
      && !isInPlanMode(planState)
      && !hasExplicitDirectWorkIntent(currentMessages)
      && currentTools.some((tool) => tool.name === "spawn_teammate");

    const noteDelegationGuardToolResult = (message: LeaderMessage): void => {
      if (!delegationGuardEnabled || message.type !== "tool_result" || message.isError === true) {
        return;
      }
      const toolName = toolUseBlocks.find((block) => block.id === message.toolUseId)?.name;
      if (toolName === "spawn_teammate") {
        leaderDirectWorkCount = 0;
        return;
      }
      if (toolName && isLeaderDirectWorkTool(toolName)) {
        leaderDirectWorkCount += 1;
        if (leaderDirectWorkCount >= LEADER_DIRECT_WORK_LIMIT && typeof message.content === "string") {
          message.content += `\n\n[Note: You have used ${leaderDirectWorkCount} direct implementation tools this turn. Consider whether this work should be delegated — load \`magister-delegating\` to review delegation criteria. This is a suggestion, not a block.]`;
        }
      }
    };

    const emitDecisionTrace = async (): Promise<void> => {
      if (decisionTraceRecorded) {
        return;
      }
      decisionTraceRecorded = true;
      const contextTokensEstimate = estimateTokenCount(messagesForModel);

      await recordEvent({
        type: "leader.decision_trace",
        timestamp: new Date().toISOString(),
        data: {
          turnCount,
          contextTokensEstimate,
          contextUtilization: budget.availableForInput > 0
            ? Math.round((contextTokensEstimate / budget.availableForInput) * 100)
            : 0,
          toolsCalled: toolUseBlocks.map((block) => block.name),
          toolCount: toolUseBlocks.length,
          hasText: assistantMessages.some((message) => message.content.some((block) => block.type === "text")),
          compacted: compactedThisTurn,
          doomLoopBlocked: doomLoopBlockedThisTurn,
        },
      });
    };

    const queueToolUseBlocks = async (
      blocks: ToolUseBlock[],
      assistantMessage: LeaderAssistantMessage,
    ): Promise<void> => {
      for (const toolBlock of blocks) {
        const existingGate = toolUseGateById.get(toolBlock.id);
        if (existingGate) {
          if (!existingGate.blocked) {
            streamingExecutor.addTool(toolBlock, assistantMessage);
          }
          continue;
        }

        const doomCheck = doomLoopDetector.record(toolBlock.name, toolBlock.input);
        if (doomCheck.isDoomLoop) {
          doomLoopBlockedThisTurn = true;
          const warningMessage = doomCheck.warningMessage
            ?? doomLoopDetector.getWarningMessage(toolBlock.name, doomCheck.count);

          await recordEvent({
            type: "leader.doom_loop_detected",
            timestamp: new Date().toISOString(),
            data: {
              toolName: toolBlock.name,
              fingerprint: doomCheck.fingerprint,
              count: doomCheck.count,
              message: warningMessage,
            },
          });

          // M5 Phase 3 codex-round-3: doom_loop is its OWN
          // failure signal — the loop continues past this point
          // (just blocks the offending tool call), so the outer
          // catch never sees it. Fire reflection directly here.
          // Memory module is dynamic-imported so the leader loop
          // doesn't take a hard dep.
          try {
            const { fireFailureReflection } = await import(
              "../../memory/memory-failure-reflection"
            );
            fireFailureReflection({
              kind: "doom_loop_detected",
              taskId: params.taskId,
              summary: `Doom loop on tool "${toolBlock.name}" — same fingerprint ${doomCheck.count} times`,
              detail: warningMessage,
            });
          } catch {
            // Reflection is best-effort.
          }

          const message: LeaderToolResultMessage = {
            type: "tool_result",
            toolUseId: toolBlock.id,
            content: `⚠️ ${warningMessage} Please try a different approach or tool.`,
            isError: true,
          };

          blockedToolResultsForTurn.push(message);
          pendingBlockedToolResults.push(message);
          toolUseGateById.set(toolBlock.id, { blocked: true });
          continue;
        }


        toolUseGateById.set(toolBlock.id, { blocked: false });
        streamingExecutor.addTool(toolBlock, assistantMessage);
      }
    };

    // F3 (audit 2026-05-08) — sanitize tool_use/tool_result pairing
    // immediately before EVERY callModel. A turn that aborts mid-flight
    // (parent cancel race, tool-executor error after tool_use emission,
    // wait:false teammate that never lands its result) leaves an orphan
    // tool_use in `messagesForModel` whose tool_result never arrived.
    // The next API call would 400 with "tool_use ids found without
    // tool_result" and the conversation becomes unrecoverable. The
    // pairing pass is pure + idempotent — cheap insurance even on
    // already-clean histories.
    messagesForModel = pairLeaderToolMessages(messagesForModel);

    try {
      for await (const modelEvent of callModel({
        messages: messagesForModel,
        // Use the per-turn system prompt so plan-mode addenda
        // (approved/revised/cancelled) reach the model when a
        // sentinel was detected in the preflight above.
        systemPrompt: systemPromptForTurn,
        tools: currentTools,
        ...(params.modelOverride ? { model: params.modelOverride } : {}),
        signal: abortController.signal,
      })) {
        if (abortController.signal.aborted) {
          break;
        }

        if (modelEvent.type === "assistant") {
          assistantMessages.push(modelEvent);
          const msgToolUseBlocks = modelEvent.content.filter(
            (block) => block.type === "tool_use"
          ) as ToolUseBlock[];

          if (msgToolUseBlocks.length > 0) {
            toolUseBlocks.push(...msgToolUseBlocks);
            needsFollowUp = true;
            await queueToolUseBlocks(msgToolUseBlocks, modelEvent);
          }

          while (pendingBlockedToolResults.length > 0) {
            yield pendingBlockedToolResults.shift()!;
          }

          for (const result of streamingExecutor.getCompletedResults()) {
            if (result.message) {
              noteDelegationGuardToolResult(result.message);
              yield result.message;
            }
          }
          continue;
        }

        if (modelEvent.type !== "message_complete") {
          await recordEvent({
            type: "leader.stream_delta",
            timestamp: new Date().toISOString(),
            data: modelEvent as unknown as Record<string, unknown>,
          });
          continue;
        }

        if (modelEvent.isError) {
          const textBlock = modelEvent.content.find((block) => block.type === "text" && block.text.trim());
          const errorMessage = textBlock?.type === "text"
            ? textBlock.text.trim()
            : "Model returned an error message_complete event";
          assistantMessages.push({
            type: "assistant",
            content: modelEvent.content,
          });
          await emitDecisionTrace();

          await recordEvent({
            type: "leader.model_error",
            timestamp: new Date().toISOString(),
            data: {
              error: errorMessage,
              // Upstream HTTP context (status/provider/body) when the error
              // came from a non-OK provider response — lets us diagnose WHY
              // from the event alone (e.g. 400 max_tokens / thinking).
              ...(modelEvent.errorDetail ? { detail: modelEvent.errorDetail } : {}),
            },
          });
          return await returnWithLeaderStatus({ reason: "model_error", error: new Error(errorMessage) }, "error");
        }

        // Record token usage — from API response or fallback to estimate
        try {
          const estimatedInput = estimateTokenCount(messagesForModel);
          const inputTokens = modelEvent.usage?.inputTokens ?? estimatedInput;
          const outputTokens = modelEvent.usage?.outputTokens
            ?? estimateTokenCount([{ type: "assistant", content: modelEvent.content }]);
          await recordUsage({
            taskId: params.taskId,
            runId: params.runId,
            requestId: params.requestId,
            roleId: params.roleId ?? "leader",
            turnNumber: turnCount,
            model: modelEvent.model ?? params.modelOverride ?? "unknown",
            provider: modelEvent.provider ?? "unknown",
            inputTokens,
            outputTokens,
            totalTokens: modelEvent.usage?.totalTokens ?? inputTokens + outputTokens,
            usageSource: modelEvent.usage ? (modelEvent.usage.source ?? "provider") : "estimated",
            estimatedPromptTokens: estimatedInput,
            ...(modelEvent.usage?.nonCachedInputTokens != null
              ? { nonCachedInputTokens: modelEvent.usage.nonCachedInputTokens }
              : {}),
            ...(modelEvent.usage?.cacheReadTokens != null
              ? { cacheReadTokens: modelEvent.usage.cacheReadTokens }
              : {}),
            ...(modelEvent.usage?.cacheWriteTokens != null
              ? { cacheWriteTokens: modelEvent.usage.cacheWriteTokens }
              : {}),
            ...(modelEvent.usage?.reasoningTokens != null
              ? { reasoningTokens: modelEvent.usage.reasoningTokens }
              : {}),
            ...(modelEvent.usage?.rawUsage !== undefined
              ? { rawUsage: modelEvent.usage.rawUsage }
              : {}),
          });
          // Snapshot the provider's authoritative input-token count
          // for next-turn compaction baseline. We pin it to whatever
          // the model actually saw — `messagesForModel.length` is the
          // exact count of messages contributing to that input.
          if (typeof modelEvent.usage?.inputTokens === "number") {
            lastActualInputTokens = modelEvent.usage.inputTokens;
            lastActualMessageCount = messagesForModel.length;
          }
        } catch {}

        const message: LeaderAssistantMessage = {
          type: "assistant",
          content: modelEvent.content,
        };

        assistantMessages.push(message);

        const msgToolUseBlocks = message.content.filter((block) => block.type === "tool_use") as ToolUseBlock[];

        if (msgToolUseBlocks.length > 0) {
          toolUseBlocks.push(...msgToolUseBlocks);
          needsFollowUp = true;
          await queueToolUseBlocks(msgToolUseBlocks, message);
        }

        while (pendingBlockedToolResults.length > 0) {
          yield pendingBlockedToolResults.shift()!;
        }

        for (const result of streamingExecutor.getCompletedResults()) {
          if (result.message) {
            noteDelegationGuardToolResult(result.message);
            yield result.message;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage);

      await recordEvent({
        type: "leader.model_error",
        timestamp: new Date().toISOString(),
        data: { error: errorMessage },
      });
      return await returnWithLeaderStatus({
        reason: "model_error",
        error: error instanceof Error ? error : new Error(errorMessage),
      }, "error");
    }

    await emitDecisionTrace();

    if (abortController.signal.aborted) {
      for await (const update of streamingExecutor.getRemainingResults()) {
        if (update.message) {
          noteDelegationGuardToolResult(update.message);
          yield update.message;
        }
      }
      return await returnWithLeaderStatus({ reason: "aborted_streaming", turnCount });
    }

    if (!needsFollowUp) {
      const hasNonEmptyText = assistantMessages.some((m) =>
        m.content.some(
          (b) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
        ),
      );
      const hasToolUse = assistantMessages.some((m) =>
        m.content.some((b) => b.type === "tool_use"),
      );
      const hasThinkingOnly = !hasNonEmptyText && !hasToolUse && assistantMessages.some((m) =>
        m.content.some((b) => b.type === "thinking" && b.thinking.trim() !== ""),
      );

      // Thinking-only response: model produced reasoning but no
      // visible output. Instead of exiting "completed" with nothing
      // to show the user, inject a continuation prompt and loop.
      if (hasThinkingOnly) {
        console.log(`[leader-loop] thinking-only response on turn ${turnCount} — injecting continuation`);
        await recordEvent({
          type: "leader.thinking_only_continuation",
          timestamp: new Date().toISOString(),
          data: { turnCount },
        });
        const nextTurnCount = turnCount + 1;
        // Enforce maxTurns HERE too. This `continue` bypasses the standard
        // cap check at the bottom of the loop, so without this a run
        // (especially one resumed near the cap) could overshoot maxTurns by
        // chaining thinking-only continuations.
        if (maxTurns && nextTurnCount > maxTurns) {
          await recordEvent({
            type: "leader.max_turns",
            timestamp: new Date().toISOString(),
            data: { maxTurns, turnCount: nextTurnCount },
          });
          return await returnWithLeaderStatus({ reason: "max_turns", turnCount: nextTurnCount });
        }
        const continuationMessages: LeaderMessage[] = [
          ...currentMessages,
          ...assistantMessages,
          {
            type: "user",
            content: [{ type: "text", text: "Continue — provide your response." }],
            isMeta: true,
          },
        ];
        state = {
          messages: continuationMessages,
          toolUseContext: { ...toolUseContext, messages: continuationMessages },
          turnCount: nextTurnCount,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          transition: { reason: "next_turn" },
          ...(state.executionPolicy !== undefined ? { executionPolicy: state.executionPolicy } : {}),
        };
        // Checkpoint BEFORE continuing so a crash replays from the injected
        // continuation state (turnCount already advanced, continuation
        // message appended) rather than re-running the thinking-only turn.
        if (params.onCheckpoint) {
          await params.onCheckpoint(buildCheckpoint(continuationMessages, nextTurnCount));
        }
        continue;
      }
      let emptyResponseDiagnostic: EmptyResponseDiagnostic | undefined;
      if (!hasNonEmptyText && !hasToolUse) {
        // Walk THIS TURN's tool_results only. Kimi review M3 — naively
        // walking all of `currentMessages` would attribute the empty
        // response to a tool result from many turns ago when the
        // current turn produced nothing. Stop walking when we cross
        // the most recent non-meta user message (turn boundary).
        let lastToolName: string | null = null;
        let lastToolResultLength: number | null = null;
        let lastToolWasError: boolean | null = null;
        let turnBoundary = 0;
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg && msg.type === "user" && !msg.isMeta) {
            turnBoundary = i + 1;
            break;
          }
        }
        for (let i = currentMessages.length - 1; i >= turnBoundary; i--) {
          const msg = currentMessages[i];
          if (msg && msg.type === "tool_result") {
            lastToolResultLength = typeof msg.content === "string" ? msg.content.length : 0;
            lastToolWasError = msg.isError === true;
            const targetId = msg.toolUseId;
            for (let j = i - 1; j >= turnBoundary; j--) {
              const prior = currentMessages[j];
              if (!prior || prior.type !== "assistant") continue;
              const tu = prior.content.find(
                (b) => b.type === "tool_use" && b.id === targetId,
              );
              if (tu && tu.type === "tool_use") {
                lastToolName = tu.name;
                break;
              }
            }
            break;
          }
        }
        emptyResponseDiagnostic = {
          contextTokensEstimate: estimateTokenCount(messagesForModel),
          turnCount,
          lastToolName,
          lastToolResultLength,
          lastToolWasError,
        };
      }

      // Kimi review M5 — write the checkpoint BEFORE emitting the
      // observability event so a recordEvent failure can never strand
      // the session unrecoverable. Checkpoint is the durable record
      // of the turn; events are advisory.
      if (params.onCheckpoint) {
        const checkpointMessages = [...currentMessages, ...assistantMessages];
        // terminal: this is the final-answer turn — the loop yields and
        // returns "completed" right after. Recovery uses this to finalize
        // (not re-run) a task that completed but crashed before its
        // terminal task/runtime/event write landed.
        await params.onCheckpoint(buildCheckpoint(checkpointMessages, turnCount, { terminal: true }));
      }

      if (emptyResponseDiagnostic) {
        // Wrap recordEvent so an event-system failure can't take down
        // the terminal branch. The structured log line below is the
        // floor — even with no event projector, we leave a breadcrumb.
        try {
          await recordEvent({
            type: "leader.empty_response_detected",
            timestamp: new Date().toISOString(),
            data: emptyResponseDiagnostic,
          });
        } catch (err) {
          console.warn(
            `[leader-loop] failed to emit empty_response_detected event: ${(err as Error)?.message ?? err}`,
          );
        }
      }

      // Yield final assistant messages so callers (e.g. spawn_teammate) can read them
      for (const msg of assistantMessages) {
        yield msg;
      }

      await recordEvent({
        type: "leader.turn_complete",
        timestamp: new Date().toISOString(),
        data: { turnCount, hasToolUse: false },
      });
      return await returnWithLeaderStatus({
        reason: "completed",
        turnCount,
        ...(emptyResponseDiagnostic ? { emptyResponse: emptyResponseDiagnostic } : {}),
      });
    }

    const toolResults: LeaderMessage[] = [...blockedToolResultsForTurn];

    for await (const update of streamingExecutor.getRemainingResults()) {
      if (update.message) {
        noteDelegationGuardToolResult(update.message);
        yield update.message;
        toolResults.push(update.message);
      }
      if (update.newContext) {
        toolUseContext = update.newContext;
      }
    }

    // Part A — update execution-policy counters after each tool result.
    // Guard: only when a policy is active. toolResults contains ALL results
    // for this turn (blocked + streaming). toolUseBlocks (accumulated above)
    // is the parallel tool_use list — we match by toolUseId to get toolName
    // and toolInput for each result.
    if (state.executionPolicy ?? toolUseContext.executionPolicy) {
      let updatedPolicy = (state.executionPolicy ?? toolUseContext.executionPolicy)!;
      for (const msg of toolResults) {
        if (msg.type !== "tool_result") continue;
        const block = toolUseBlocks.find((b) => b.id === msg.toolUseId);
        if (!block) continue;
        const toolName = block.name;
        const toolInput = (block.input ?? {}) as Record<string, unknown>;
        const isError = msg.isError === true;
        // Compute isReadOnly the same way the gate does: bash is never
        // read-only, otherwise look up the tool definition.
        let toolIsReadOnly = false;
        if (toolName !== "bash") {
          const toolDef = findToolByName(currentTools, toolName);
          toolIsReadOnly = toolDef ? toolDef.isReadOnly(toolInput) : false;
        }
        updatedPolicy = updateExecutionPolicyAfterTool({
          policy: updatedPolicy,
          toolName,
          toolInput,
          toolIsReadOnly,
          toolOutput: msg.content,
          isError,
        });
      }
      // Propagate updated counters into the local toolUseContext so the
      // state rebuild below carries them into the next turn's gate.
      toolUseContext = { ...toolUseContext, executionPolicy: updatedPolicy };

      // Part B — escalate direct_simple to delegated_coding when budget exceeded.
      const c = updatedPolicy.constraints;
      const cnts = updatedPolicy.counters;
      if (updatedPolicy.mode === "direct_simple") {
        const fileBudgetExceeded = cnts.writtenPaths.length > (c.maxWriteFiles ?? 2);
        const discoveryBudgetExceeded =
          cnts.writeToolCalls === 0 &&
          cnts.discoveryToolCalls > (c.maxDiscoveryToolCallsBeforeWrite ?? 3);
        if (fileBudgetExceeded || discoveryBudgetExceeded) {
          const escalationReason = "direct_simple budget exceeded at runtime";
          updatedPolicy = escalateToDelegated(updatedPolicy, escalationReason);
          toolUseContext = { ...toolUseContext, executionPolicy: updatedPolicy };
          await planAwareRecordEvent({
            type: "leader.execution_policy_escalated",
            timestamp: new Date().toISOString(),
            data: {
              from: "direct_simple",
              to: "delegated_coding",
              reason: escalationReason,
              counters: updatedPolicy.counters,
              requestId: params.requestId,
              turnIndex: turnCount,
            },
          });
        }
      }

      // Sync state.executionPolicy — carried into next turn via state rebuild.
      state = { ...state, executionPolicy: updatedPolicy };
    }

    if (abortController.signal.aborted) {
      return await returnWithLeaderStatus({ reason: "aborted_tools", turnCount });
    }

    await recordEvent({
      type: "leader.turn_complete",
      timestamp: new Date().toISOString(),
      data: { turnCount, hasToolUse: true },
    });

    // Goal-complete halt enforcement. When mark_goal_complete succeeds,
    // the goal_status flips to "complete" in the DB. The model SHOULD
    // respond with a brief acknowledgement and end the turn, but observed
    // behavior: confused models keep emitting tool_use after seeing the
    // goal-complete tool_result (often triggered by stale continuation
    // context still in their messages, or by hallucinated tangents).
    // Without this guard the loop runs unbounded post-completion.
    //
    // Check directly via DB read; tool-result inspection is fragile
    // (multiple tool types could transition the goal).
    try {
      const { TaskRepository } = await import("../../../repositories/task-repository");
      const _task = await new TaskRepository().getById(params.taskId);
      if (_task?.goalObjective && _task.goalStatus === "complete") {
        await recordEvent({
          type: "leader.goal_complete_halt",
          timestamp: new Date().toISOString(),
          data: { turnCount, goalId: _task.goalId ?? null },
        });
        return await returnWithLeaderStatus({ reason: "completed", turnCount });
      }
    } catch {
      // Best-effort — fall through to normal loop continuation
    }

    // Plan-mode halt enforcement: if `exit_plan_mode` ran this turn
    // and the state transitioned to AWAITING_APPROVAL, force the
    // loop to terminate. Spec §5 step 3: "runLeaderLoop exits the
    // turn loop normally". The tool_result halt-instruction is a
    // hint for the model — but smaller / less instruction-following
    // models may keep generating tool_use blocks after, which the
    // loop would otherwise dutifully execute (and which all get
    // blocked by the plan-safe gate, except `exit_plan_mode` which
    // is plan-safe and would re-fire creating duplicate PlanCards).
    //
    // Hard-stop the run here so the user sees one PlanCard, the
    // expected halt-state, and resume picks up from the user reply.
    if (planState === "AWAITING_APPROVAL") {
      // Persist a checkpoint so resume from user reply restores the
      // halted state cleanly — same path the no-tool-use branch above
      // takes.
      if (params.onCheckpoint) {
        await params.onCheckpoint(buildCheckpoint([...currentMessages, ...assistantMessages, ...toolResults], turnCount));
      }
      // Yield assistant messages so callers can read the model's
      // halt-acknowledgement text (if any).
      for (const msg of assistantMessages) yield msg;
      await recordEvent({
        type: "leader.session_complete",
        timestamp: new Date().toISOString(),
        data: { taskId: params.taskId, requestId: params.requestId, runId: params.runId, reason: "plan_awaiting_approval" },
      });
      return await returnWithLeaderStatus({ reason: "completed", turnCount });
    }

    const nextTurnCount = turnCount + 1;

    if (maxTurns && nextTurnCount > maxTurns) {
      await recordEvent({
        type: "leader.max_turns",
        timestamp: new Date().toISOString(),
        data: { maxTurns, turnCount: nextTurnCount },
      });
      return await returnWithLeaderStatus({ reason: "max_turns", turnCount: nextTurnCount });
    }

    state = {
      messages: [...currentMessages, ...assistantMessages, ...toolResults],
      toolUseContext: {
        ...toolUseContext,
        messages: [...currentMessages, ...assistantMessages, ...toolResults],
      },
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      transition: { reason: "next_turn" },
      // Carry updated executionPolicy (counters mutated by Part A/B above)
      // so the next-turn top-of-loop spread into toolUseContext has it.
      ...(state.executionPolicy !== undefined ? { executionPolicy: state.executionPolicy } : {}),
    };

    if (params.onCheckpoint) {
      await params.onCheckpoint(buildCheckpoint(state.messages, nextTurnCount));
    }

    // Mailbox drain moved to top of iteration (F1 fix above) —
    // intentionally no end-of-turn drain here.
  }
}

/**
 * Pluck the textual content of the most-recent user message, if any.
 * Used by the plan-mode preflight to test for approval/revise/cancel
 * sentinels. Returns null if the last user message has no string-form
 * content (e.g. it's a tool_result-only structured user message).
 */
function lastUserMessageText(messages: LeaderMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "user") continue;
    if (typeof m.content === "string") return m.content;
    // Structured content — concatenate text blocks.
    if (Array.isArray(m.content)) {
      const parts = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (parts.length > 0) return parts.join("\n");
    }
    return null;
  }
  return null;
}

function createToolUseContext(params: LeaderLoopParams): LeaderToolUseContext {
  let inProgressToolUseIDs: Set<string> = new Set();

  return {
    taskId: params.taskId,
    runId: params.runId,
    requestId: params.requestId,
    workspaceDir: params.workspaceDir,
    abortController: params.abortController,
    messages: params.messages,
    tools: params.tools,
    recordEvent: params.recordEvent,
    ...(params.requestApproval ? { requestApproval: params.requestApproval } : {}),
    getInProgressToolUseIDs: () => inProgressToolUseIDs,
    setInProgressToolUseIDs: (f) => {
      inProgressToolUseIDs = f(inProgressToolUseIDs);
    },
    callModel: params.callModel,
  };
}
