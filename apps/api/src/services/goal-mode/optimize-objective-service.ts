/**
 * Optimizer orchestrator for goal objectives.
 *
 * Reads the leader's checkpoint messages for the given task, snips them
 * to fit a 100K token budget, then makes a one-shot LLM call asking the
 * model to rewrite the raw objective as a self-contained, context-rich
 * string. Returns the rewritten text without writing anything to the DB.
 *
 * Architecture: read-only fork of leader's context. No mutations.
 */

import { TaskRepository } from "../../repositories/task-repository";
import { RoleRuntimeRepository } from "../../repositories/role-runtime-repository";
import { LeaderSessionStore } from "../leader-session-store";
import { resolveAgentForRole } from "../agent-resolution-service";
import { applyModelOverrideToApiConfig, buildApiConfigFromAgent } from "../process-task-intent-service";
import { readExecutorConfigFile } from "../executor-config-service";
import { callStreamingApi } from "../manager-automation/autonomous-loop/streaming-api-caller";
import { snipForOptimizer } from "./optimizer-context-service";
import type { LeaderMessage } from "../manager-automation/autonomous-loop/autonomous-types";

/** States that refuse optimizer requests — matches start-goal-service.ts REFUSED_STATES. */
const REFUSED_STATES = new Set(["CANCELLED", "FAILED"]);

/** 32 KB byte cap — matches MAX_OBJECTIVE_BYTES in start-goal-service.ts. */
const MAX_OBJECTIVE_BYTES = 32 * 1024;

const OPTIMIZER_SYSTEM_PROMPT = `You are rewriting a user's goal objective so it is self-contained.
A separate agent will execute the goal in an autonomous loop where
older conversation context will be trimmed away. Your job is to
ensure the rewritten objective carries all the context needed for
execution to succeed without referring back to the conversation.

Output ONLY the rewritten objective text. No explanation, no markdown
headers, no preamble. Plain text the executor will read as its task.`;

export type OptimizeObjectiveResult =
  | {
      ok: true;
      data: {
        optimized: string;
        original: string;
        compressed: boolean;
        inputTokens: number;
        /**
         * Non-null when the per-task `/model` override was supposed
         * to apply but couldn't (model removed from config, executors
         * file failed to read, etc). Optimizer fell back to the agent
         * default model; UI should surface this so the user doesn't
         * silently get a result that ignored their model pick.
         */
        overrideWarning?: string | null;
      };
    }
  | {
      ok: false;
      error: {
        code:
          | "task_not_found"
          | "task_terminal"
          | "goal_already_active"
          | "no_leader_session"
          | "model_call_failed"
          | "invalid_objective";
        message: string;
      };
    };

/**
 * UTF-8-safe truncation to at most `maxBytes` bytes.
 * Cuts on a codepoint boundary so we never split a multi-byte character.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  // Decode the first maxBytes bytes — TextDecoder with default options
  // replaces broken sequences; we then strip the replacement char.
  const slice = encoded.subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false })
    .decode(slice)
    .replace(/�$/, "");
}

export async function optimizeObjective(input: {
  taskId: string;
  objective: string;
}): Promise<OptimizeObjectiveResult> {
  // ── Validation ──────────────────────────────────────────────────────
  const trimmedObjective = input.objective.trim();
  if (trimmedObjective.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_objective", message: "Objective is empty" },
    };
  }

  // ── Task validation ─────────────────────────────────────────────────
  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(input.taskId);
  if (!task) {
    return {
      ok: false,
      error: { code: "task_not_found", message: `Task ${input.taskId} not found` },
    };
  }
  if (REFUSED_STATES.has(task.state)) {
    return {
      ok: false,
      error: {
        code: "task_terminal",
        message: `Task is in terminal state "${task.state}"; cannot optimize a goal for it`,
      },
    };
  }
  if (task.goalObjective && task.goalStatus && task.goalStatus !== "cancelled") {
    return {
      ok: false,
      error: {
        code: "goal_already_active",
        message: `Task already has a goal (status: ${task.goalStatus}). Cancel or complete it before optimizing a new one.`,
      },
    };
  }

  // ── Leader runtime / checkpoint lookup ──────────────────────────────
  const runtimeRepo = new RoleRuntimeRepository();
  const runtimes = await runtimeRepo.listByTaskId(input.taskId);
  // Filter to leader runtimes — role_id is "leader" or the run id uses
  // the "rt_leader_" prefix (legacy naming).
  const leaderRuntimes = runtimes.filter(
    (r) => r.roleId === "leader" || r.id.startsWith("rt_leader_"),
  );
  if (leaderRuntimes.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_leader_session",
        message: "Task has no leader runtime; optimize needs an existing conversation to fork from",
      },
    };
  }

  // Take the most recently created leader runtime (highest createdAt or
  // last in list — listByTaskId uses insertion order).
  const latestRuntime = leaderRuntimes[leaderRuntimes.length - 1]!;

  const sessionStore = new LeaderSessionStore();
  const checkpoint = await sessionStore.getLatestCheckpoint(latestRuntime.id);
  if (!checkpoint || checkpoint.messages.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_leader_session",
        message: "No checkpoint found for the leader session; optimize needs at least one completed turn",
      },
    };
  }

  // ── Snip context to 100K token budget ───────────────────────────────
  const snipResult = snipForOptimizer(checkpoint.messages);

  // ── Resolve leader model / provider ─────────────────────────────────
  const leaderAgentConfig = await resolveAgentForRole("leader");
  if (!leaderAgentConfig || !leaderAgentConfig.provider) {
    return {
      ok: false,
      error: {
        code: "model_call_failed",
        message: "Could not resolve leader agent config; check executors.json",
      },
    };
  }

  // Apply the same per-task `/model` override the leader uses. Without
  // this, the optimizer always ran on the agent default — so after
  // `/model gpt-5.5`, the user's optimize click silently used the old
  // model. The override is best-effort; on resolver failure we fall
  // back to the agent-default apiConfig.
  //
  // Surface the fallback case to the caller so the UI can warn the
  // user instead of silently running on the wrong model. Two failure
  // modes: (1) executors.json read threw, (2) the override model was
  // removed/misconfigured between /model write and now —
  // applyModelOverrideToApiConfig returns the original apiConfig
  // unchanged in that case (logged at warn level), so we detect it
  // by comparing the post-apply modelName.
  let apiConfig = buildApiConfigFromAgent(leaderAgentConfig);
  let overrideWarning: string | null = null;
  if (task.modelOverride) {
    try {
      const executorConfig = await readExecutorConfigFile();
      const after = applyModelOverrideToApiConfig(apiConfig, task.modelOverride, executorConfig);
      if (after.model.modelName !== task.modelOverride) {
        // applyModelOverrideToApiConfig returned the default — model
        // record missing, providerRef missing, or provider deleted.
        overrideWarning = `Override model '${task.modelOverride}' is no longer configured; optimizer ran on agent default ('${apiConfig.model.modelName}').`;
        console.warn(`[goal-optimize] ${overrideWarning}`);
      } else {
        apiConfig = after;
      }
    } catch (err) {
      overrideWarning = `Failed to load executor config; optimizer ran on agent default ('${apiConfig.model.modelName}'): ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[goal-optimize] ${overrideWarning}`);
    }
  }

  // ── Build optimizer messages ─────────────────────────────────────────
  const userTurnContent = `Rewrite this goal to be self-contained, embedding any constraints, file paths, requirements, or decisions from the conversation above that the executor needs to know:\n\n<<<\n${trimmedObjective}\n>>>`;
  const optimizerMessages: LeaderMessage[] = [
    ...snipResult.messages,
    { type: "user", content: userTurnContent },
  ];

  // ── One-shot model call ──────────────────────────────────────────────
  // 60s timeout — optimizer should be fast (a short rewrite, not real
  // work); if the model hangs, fail fast rather than blocking the UX
  // forever.
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort("optimize_timeout"), 60_000);
  let rawOutput = "";

  try {
    for await (const event of callStreamingApi(
      {
        messages: optimizerMessages,
        systemPrompt: OPTIMIZER_SYSTEM_PROMPT,
        tools: [],
        signal: abortController.signal,
      },
      {
        provider: apiConfig.provider,
        model: apiConfig.model,
        binding: apiConfig.binding,
        ...(apiConfig.fallbackProvider ? { fallbackProvider: apiConfig.fallbackProvider } : {}),
      },
    )) {
      if (event.type === "text_delta") {
        rawOutput += event.text;
      }
    }
  } catch (err) {
    console.error(
      "[goal/optimizer] model call failed:",
      err instanceof Error ? err.message : String(err),
    );
    const timedOut = abortController.signal.aborted && abortController.signal.reason === "optimize_timeout";
    return {
      ok: false,
      error: {
        code: "model_call_failed",
        message: timedOut
          ? "Optimizer timed out after 60s — try activating without optimization"
          : (err instanceof Error ? err.message : "Optimizer model call failed"),
      },
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  const trimmedOutput = rawOutput.trim();
  if (!trimmedOutput) {
    return {
      ok: false,
      error: { code: "model_call_failed", message: "Optimizer returned empty output" },
    };
  }

  // Truncate to 32KB on a UTF-8 boundary to match objective byte cap.
  const optimized = truncateUtf8(trimmedOutput, MAX_OBJECTIVE_BYTES);

  return {
    ok: true,
    data: {
      optimized,
      original: trimmedObjective,
      compressed: snipResult.compressed,
      inputTokens: snipResult.inputTokens,
      ...(overrideWarning ? { overrideWarning } : {}),
    },
  };
}
