import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { ExecutorErrorCategory } from "@magister/core";
import type { ArtifactInsert, ExecutionEventInsert } from "@magister/db";

import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorDispatchFailure,
  ExecutorDispatchResult,
  ExecutorSlotSnapshot,
} from "./executor-adapter";
import { createStubExecutorAdapter } from "./stub-executor-adapter";
import { extractExplicitToolEventsFromJsonLines } from "./tool-event-utils";
import { buildRuntimeContextDocument } from "../services/build-runtime-context-document-service";
import { getManagerCapabilityPromptLines } from "../services/manager-capability-registry-service";
import { runManagerLoop } from "../services/manager-loop-service";
import { extractManagerDecisionOutput } from "../services/manager-decision-service";
import {
  coerceGroundedManagerReply,
  getManagerGroundingRequirement,
  shouldUseConversationalShortcutTask,
} from "../services/conversation-shortcut-service";
import { queueFeishuRuntimeTraceIfEnabled } from "../services/queue-feishu-runtime-trace-service";
import { writeRuntimeContract } from "../services/runtime-contract-service";
import {
  finalizeRuntimeWorkspace,
  prepareRuntimeWorkspace,
  type RuntimeWorkspaceLease,
} from "../services/runtime-workspace-service";
import { buildRuntimeEnv } from "../services/safe-apply/runtime-env-service";
import {
  assessExecutionSandbox,
  prepareExecutionSandboxCommand,
} from "../services/safe-apply/execution-sandbox-service";
import {
  derivePermissionMode,
  extractPermissionRelevantArgvFlags,
} from "../services/safe-apply/permission-mode-service";
import type {
  RuntimeSecurityMetadata,
  RuntimeWorkspaceStrategy,
} from "../services/safe-apply/safe-apply-types";
import { collectRuntimeDiff } from "../services/safe-apply/runtime-diff-service";
import { classifyStaticGate } from "../services/safe-apply/static-gate-service";
import { createChangeReviewDraft } from "../services/safe-apply/change-review-draft-service";
import { materializeChangeReviewFromDraftBestEffort } from "../services/safe-apply/change-review-state-service";
import { buildMcpToolRisk } from "../services/safe-apply/mcp-tool-risk-service";
import { runSastAdvisory } from "../services/safe-apply/sast-advisory-service";

type CodexCommandInvocation = {
  command: string;
  args: string[];
  prompt: string;
  cwd: string;
  outputPath: string;
  timeoutMs: number;
  killGraceMs: number;
  env?: Record<string, string>;
};

type CodexCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string;
  durationMs?: number;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
  invocationError?: string;
};

type CodexExecutorOptions = {
  workspaceDir?: string;
  artifactsRootDir?: string;
  codexHomeDir?: string;
  codexCommand?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  runCommand?: (invocation: CodexCommandInvocation) => Promise<CodexCommandResult>;
};

type CodexFailureDetails = {
  code: ExecutorDispatchFailure["code"];
  category: ExecutorErrorCategory;
  message: string;
  suggestion: string;
};

type CodexInvocationMode = "fresh" | "resume";

const DEFAULT_CLI_EXECUTOR_TIMEOUT_MS = 7_200_000;

function buildCodexRuntimeSecurity(input: {
  commandPath: string;
  args: string[];
  sandboxMode: ExecutorSlotSnapshot["sandboxMode"];
  envPermissionHints: string[];
  runtimeWorkspaceStrategy: RuntimeWorkspaceStrategy;
  executionSandbox: RuntimeSecurityMetadata["executionSandbox"];
}): RuntimeSecurityMetadata {
  const sandboxMode = input.sandboxMode ?? "workspace-write";
  const permission = derivePermissionMode({
    runtimeSource: "codex",
    argv: input.args,
    sandboxMode,
    envPermissionHints: input.envPermissionHints,
    hasInteractiveApprovalChannel: false,
  });
  return {
    runtimeSource: "codex",
    commandPath: input.commandPath,
    argvFlags: extractPermissionRelevantArgvFlags(input.args),
    sandboxMode,
    permissionMode: permission.permissionMode,
    permissionSignals: permission.permissionSignals,
    envPermissionHints: input.envPermissionHints,
    runtimeWorkspaceStrategy: input.runtimeWorkspaceStrategy,
    executionSandbox: input.executionSandbox ?? null,
  };
}

function getArtifactDescriptor(roleId: string) {
  switch (roleId) {
    case "reviewer":
      return {
        artifactType: "review",
        title: "Reviewer execution note",
      };
    default:
      return {
        artifactType: "execution_note",
        title: `${roleId[0]?.toUpperCase() ?? ""}${roleId.slice(1)} execution note`,
      };
  }
}

function createEvent(
  context: ExecutorDispatchContext,
  event: ExecutionEventInsert,
): ExecutionEventInsert {
  return {
    ...event,
    id: event.id ?? `event_${context.createId?.() ?? crypto.randomUUID()}`,
  };
}

async function recordParsedToolEvents(
  context: ExecutorDispatchContext,
  toolEvents: ReturnType<typeof extractExplicitToolEventsFromJsonLines>,
  occurredAt: Date,
) {
  for (const toolEvent of toolEvents) {
    await context.dependencies.observabilityAdapter.recordEvent(
      createEvent(context, {
        id: `event_${context.createId?.() ?? crypto.randomUUID()}`,
        type: toolEvent.type,
        taskId: context.task.id,
        roleRuntimeId: context.runtime.id,
        executorSessionId: context.runtime.currentSessionId ?? null,
        workspaceId: context.task.workspaceId,
        severity: toolEvent.type === "tool.error" ? "error" : "info",
        occurredAt,
        payloadJson: JSON.stringify({
          message: toolEvent.summary,
          toolName: toolEvent.toolName,
          ...(toolEvent.toolCallId ? { toolCallId: toolEvent.toolCallId } : {}),
          ...(toolEvent.arguments !== undefined ? { arguments: toolEvent.arguments } : {}),
          ...(toolEvent.result !== undefined ? { result: toolEvent.result } : {}),
          ...(toolEvent.errorMessage ? { errorMessage: toolEvent.errorMessage } : {}),
          source: context.slot.adapterId,
        }),
      }),
    );

    await queueFeishuRuntimeTraceIfEnabled({
      source: context.task.source ?? "",
      rootChannelBindingId: context.task.rootChannelBindingId,
      workspaceId: context.task.workspaceId,
      taskId: context.task.id,
      sourceEventId: `${toolEvent.type}:${context.runtime.id}:${toolEvent.toolCallId ?? toolEvent.toolName}:${occurredAt.toISOString()}`,
      eventType: toolEvent.type,
      summary:
        toolEvent.type === "tool.call"
          ? `Tool call: ${toolEvent.toolName}`
          : toolEvent.type === "tool.result"
            ? `Tool result: ${toolEvent.toolName}`
            : `Tool error: ${toolEvent.toolName}`,
      details: {
        toolName: toolEvent.toolName,
        ...(toolEvent.toolCallId ? { toolCallId: toolEvent.toolCallId } : {}),
        ...(toolEvent.arguments !== undefined ? { arguments: toolEvent.arguments } : {}),
        ...(toolEvent.result !== undefined
          ? {
              result: toolEvent.result,
              resultSummary: toolEvent.summary,
            }
          : {}),
        ...(toolEvent.errorMessage ? { errorMessage: toolEvent.errorMessage } : {}),
      },
      roleId: context.runtime.roleId,
      executorId: context.slot.adapterId,
      sessionId: context.runtime.currentSessionId ?? undefined,
      attemptCount: context.runtime.attemptCount + 1,
    });
  }
}

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function summarizeText(input: string, maxLength = 160) {
  const normalized = collapseWhitespace(input);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatWallClockContext(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(2, "0");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC${sign}${offsetHours}:${offsetRemainderMinutes} (${timezone})`;
}

const CODEX_PLUGIN_DEFAULT_PROMPT_WARN_PATTERN =
  /codex_core::plugins::manifest: ignoring interface\.defaultPrompt: prompt must be at most 128 characters/i;
const CODEX_SHELL_SNAPSHOT_WARN_PATTERN =
  /codex_core::shell_snapshot: Failed to delete shell snapshot/i;
const READING_STDIN_LINE_PATTERN = /^Reading additional input from stdin\.\.\.$/i;

type CondensedCodexDiagnostics = {
  message: string;
  pluginWarningCount: number;
  shellSnapshotWarningCount: number;
};

function stripCodexLogPrefix(line: string) {
  return line
    .replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+/,
      "",
    )
    .trim();
}

function looksLikeCodexDiagnosticsLog(input: string) {
  return (
    CODEX_PLUGIN_DEFAULT_PROMPT_WARN_PATTERN.test(input) ||
    CODEX_SHELL_SNAPSHOT_WARN_PATTERN.test(input) ||
    READING_STDIN_LINE_PATTERN.test(input)
  );
}

function condenseCodexDiagnostics(input: string, maxVisibleLines = 6): CondensedCodexDiagnostics | null {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let pluginWarningCount = 0;
  let shellSnapshotWarningCount = 0;
  const retainedLines: string[] = [];

  for (const line of lines) {
    if (READING_STDIN_LINE_PATTERN.test(line)) {
      continue;
    }
    const normalizedLine = stripCodexLogPrefix(line);
    if (CODEX_PLUGIN_DEFAULT_PROMPT_WARN_PATTERN.test(normalizedLine)) {
      pluginWarningCount += 1;
      continue;
    }
    if (CODEX_SHELL_SNAPSHOT_WARN_PATTERN.test(normalizedLine)) {
      shellSnapshotWarningCount += 1;
      continue;
    }
    retainedLines.push(normalizedLine);
  }

  const deduped: Array<{ line: string; count: number }> = [];
  for (const line of retainedLines) {
    const existing = deduped.find((item) => item.line === line);
    if (existing) {
      existing.count += 1;
      continue;
    }
    deduped.push({ line, count: 1 });
  }

  const isHighSignal = (line: string) =>
    /(timed out|timeout|failed|error|fatal|panic|exception|denied|unavailable|not found)/i.test(
      line,
    );
  const ordered = [
    ...deduped.filter((item) => isHighSignal(item.line)),
    ...deduped.filter((item) => !isHighSignal(item.line)),
  ];

  const visibleEntries = ordered.slice(0, maxVisibleLines);
  const omittedLines = ordered.length - visibleEntries.length;
  const formattedVisibleLines = visibleEntries.map((entry) =>
    entry.count > 1 ? `${entry.line} (repeated ${entry.count} times)` : entry.line,
  );

  if (omittedLines > 0) {
    formattedVisibleLines.push(`... plus ${omittedLines} additional diagnostic lines.`);
  }
  if (pluginWarningCount > 0) {
    formattedVisibleLines.push(
      `Suppressed ${pluginWarningCount} repetitive plugin manifest warnings (interface.defaultPrompt > 128 chars).`,
    );
  }
  if (shellSnapshotWarningCount > 0) {
    formattedVisibleLines.push(
      `Suppressed ${shellSnapshotWarningCount} shell snapshot cleanup warning(s) for already-removed temp files.`,
    );
  }

  if (formattedVisibleLines.length === 0) {
    return null;
  }

  return {
    message: formattedVisibleLines.join("\n"),
    pluginWarningCount,
    shellSnapshotWarningCount,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractStructuredCodexErrors(stdout: string) {
  const errors: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }

      const directType = typeof parsed.type === "string" ? parsed.type : undefined;
      const directMessage = typeof parsed.message === "string" ? parsed.message : undefined;
      if (directType === "error" && directMessage) {
        errors.push(directMessage);
        continue;
      }

      const item = parsed.item;
      if (!isPlainObject(item)) {
        continue;
      }

      const itemType = typeof item.type === "string" ? item.type : undefined;
      const itemMessage =
        typeof item.message === "string"
          ? item.message
          : typeof item.text === "string"
            ? item.text
            : undefined;

      if (itemType === "error" && itemMessage) {
        errors.push(itemMessage);
      }
    } catch {
      continue;
    }
  }

  return errors;
}

function extractCodexSessionId(stdout: string) {
  const directKeys = ["thread_id", "session_id", "sessionId", "conversation_id"] as const;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }

      for (const key of directKeys) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }

      const item = isPlainObject(parsed.item) ? parsed.item : null;
      if (item) {
        for (const key of directKeys) {
          const value = item[key];
          if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function quoteArg(value: string) {
  return value.length === 0 || /[\s"'\\]/.test(value)
    ? JSON.stringify(value)
    : value;
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].map((segment) => quoteArg(segment)).join(" ");
}

function buildPromptCommonSections(input: {
  context: ExecutorDispatchContext;
  runtimeWorkspaceDir: string;
  runtimeContractPath?: string | null;
  forceRehydration?: boolean;
}) {
  const context = input.context;
  const delegationInstructions =
    context.runtime.delegationMode === "delegate_with_context"
      ? [
          "Delegation Mode: handoff",
          "You are continuing a task-manager handoff. Reuse the existing task context and carry the work forward from prior delegated execution.",
        ]
      : [
          "Delegation Mode: assign",
          "You are handling a fresh assignment. Solve the requested work item independently without assuming hidden upstream context.",
        ];
  const runtimeContractPath =
    input.runtimeContractPath && input.runtimeContractPath.trim().length > 0
      ? relative(input.runtimeWorkspaceDir, input.runtimeContractPath) || "."
      : null;
  const runtimeContractInstructions = runtimeContractPath
    ? [
        `- Before acting, read the run contract at \`${runtimeContractPath}\`.`,
        "- Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
      ]
    : [];
  const rehydrationFallbackInstructions = input.forceRehydration
    ? [
        "- Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
        "- Do not assume any prior session memory survived the failed resume.",
      ]
    : [];

  return [
    `Role: ${context.runtime.roleId}`,
    `Task ID: ${context.task.id}`,
    `Workspace ID: ${context.task.workspaceId}`,
    `Task Title: ${context.task.title ?? context.task.id}`,
    `Task Description: ${context.task.description?.trim() || context.task.title || context.task.id}`,
    `Current Task State: ${context.task.state}`,
    ...delegationInstructions,
    "",
    "Instructions:",
    "- Work only inside the current workspace.",
    "- Do not ask interactive questions.",
    "- Prefer deterministic edits and concise execution notes.",
    ...runtimeContractInstructions,
    ...rehydrationFallbackInstructions,
    "- Do not treat bootstrap, environment checks, or session setup as task completion.",
    "- After satisfying workspace bootstrap requirements, continue with the actual task request.",
    "- If you fail, explain the blocker and the most useful next action.",
    "",
    "Return sections exactly:",
    "Objective",
    "Actions",
    "Outcome",
  ];
}

function buildWorkerPrompt(input: {
  context: ExecutorDispatchContext;
  runtimeWorkspaceDir: string;
  runtimeContractPath?: string | null;
  forceRehydration?: boolean;
}) {
  const sections = buildPromptCommonSections(input);
  return [
    "You are Codex running inside Magister.",
    "You are a delegated execution subagent inside Magister.",
    ...sections,
  ].join("\n");
}

function buildManagerPrompt(input: {
  context: ExecutorDispatchContext;
  runtimeWorkspaceDir: string;
  runtimeContractPath?: string | null;
  forceRehydration?: boolean;
  currentWallClock?: Date;
}) {
  return [
    "You are the leader agent for Magister.",
    `Role: ${input.context.runtime.roleId}`,
    `Task ID: ${input.context.task.id}`,
    `Workspace ID: ${input.context.task.workspaceId}`,
    `Task Title: ${input.context.task.title ?? input.context.task.id}`,
    `Task Description: ${input.context.task.description?.trim() || input.context.task.title || input.context.task.id}`,
    `Current Task State: ${input.context.task.state}`,
    ...(input.currentWallClock
      ? [`Current Wall Clock: ${formatWallClockContext(input.currentWallClock)}`]
      : []),
    input.context.runtime.delegationMode === "delegate_with_context"
      ? "Delegation Mode: handoff"
      : "Delegation Mode: assign",
    input.context.runtime.delegationMode === "delegate_with_context"
      ? "You are continuing a task-manager handoff. Reuse the existing task context and carry the work forward from prior delegated execution."
      : "You are handling a fresh assignment. Interpret the request, decide the next system action, and avoid unnecessary delegation.",
    "",
    "Instructions:",
    "- You are responsible for orchestration, not code execution.",
    "- You are the primary semantic runtime for this task. Downstream coding or review work should be treated as delegated subagent execution.",
    "- Assume the current workspace is the repository or codebase the user means unless they explicitly point elsewhere.",
    "- Do not ask the user for the repo path, project name, or frontend location when the current workspace already scopes the request.",
    "- Requests to inspect, review, explain, or summarize code in this workspace should be treated as in-repo work, not as missing-context questions.",
    "- The current wall clock above is authoritative runtime context. Use it directly for questions about current time/date/day, and do not claim you lack realtime access for those questions.",
    "- For local workspace facts such as current directory, visible files, repository layout, or file contents, prefer base tools over unsupported guesswork.",
    "- Before answering local workspace facts such as current directory, visible files, repository layout, or file contents, you must call the relevant base tool first.",
    "- Do not infer local workspace facts from workspace ids, placeholder paths, or unstated assumptions when a base tool can observe them directly.",
    "- For weather and air-quality questions, never infer the user's city or location from timezone, locale, IP, workspace, or prior unrelated context.",
    "- If a weather or air-quality question does not include a resolvable city or location, ask the user for it instead of guessing.",
    "- If a weather or air-quality question does include a city or location, prefer web tools and answer directly; do not delegate coder, reviewer, architect, or lander for that information lookup.",
    "- Use ask_user_question only when the missing information can only come from the user and is not available from runtime context, workspace tools, or web tools.",
    "- Decide whether the task should be answered directly, clarified, delegated, or waited on.",
    ...getManagerCapabilityPromptLines(),
    '- Set "executionMode" to "immediate", "bounded_execution", or "long_running" based on whether the task should finish now, run in one bounded orchestration burst, or continue durably across waits and future wakeups.',
    "- Answer the user directly when possible; do not delegate work that you can resolve without spawning child work items.",
    "- Treat child run results as internal orchestration signals, not as final user-visible answers.",
    '- Set "taskType" to one of: "conversation", "coding", "mixed", "clarify", "wait".',
    '- Set "decision" to one of: "direct_answer", "ask_user", "spawn_work_items", "sleep_until".',
    '- For "direct_answer" and "ask_user", set executionMode to "immediate", include a non-empty reply, and do not include childWorkItems, nextWakeupAt, or downstream execution.',
    '- For "spawn_work_items", set executionMode to "bounded_execution" or "long_running", include one or more childWorkItems, and ensure the output remains valid JSON.',
    '- For "sleep_until", set executionMode to "long_running", include nextWakeupAt and optional waitingFor, and do not include reply or childWorkItems.',
    "- Keep the response concise, structured, and machine-readable.",
    "- Do not emit markdown sections, XML tags, or tool-call wrappers.",
    "- Do not use `use_skill`; answer directly, ask the user, delegate downstream work, or wait.",
    "- If the JSON would violate the ManagerDecision contract, repair it before replying and still return one JSON object only.",
    "- Do not use legacy childWorkItem fields like delegateAgent, taskDescription, description, action, details, or expectedOutput.",
    "- Do not treat bootstrap, environment checks, or session setup as task completion.",
    "- If you fail, explain the blocker and the most useful next action.",
    "",
    "Return only a single valid JSON object with these top-level fields:",
    "taskType, executionMode, decision, reply, confidence, childWorkItems, waitingFor, nextWakeupAt, warnings",
  ].join("\n");
}

function buildCodexPrompt(input: {
  context: ExecutorDispatchContext;
  runtimeWorkspaceDir: string;
  runtimeContractPath?: string | null;
  forceRehydration?: boolean;
  currentWallClock?: Date;
}) {
  return input.context.runtime.roleId === "leader"
    ? buildManagerPrompt(input)
    : buildWorkerPrompt(input);
}

async function copyFileIfMissing(sourcePath: string, targetPath: string) {
  try {
    await access(targetPath);
    return;
  } catch {
    // Target does not exist yet.
  }

  try {
    await copyFile(sourcePath, targetPath);
  } catch {
    // Best effort: local codex home can still work without seeded files.
  }
}

async function seedCodexHome(codexHomeDir: string) {
  await mkdir(codexHomeDir, { recursive: true });

  const sourceCodexHome =
    process.env.MAGISTER_CODEX_HOME_SEED?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(homedir(), ".codex");

  if (!sourceCodexHome || sourceCodexHome === codexHomeDir) {
    return;
  }

  await copyFileIfMissing(join(sourceCodexHome, "auth.json"), join(codexHomeDir, "auth.json"));
  await copyFileIfMissing(join(sourceCodexHome, "config.toml"), join(codexHomeDir, "config.toml"));
}

async function resolveResumeWorkdir(defaultWorkspaceDir: string, priorWorkdir: string | null) {
  const candidate = priorWorkdir?.trim();
  if (!candidate) {
    return defaultWorkspaceDir;
  }

  try {
    await access(candidate);
    return candidate;
  } catch {
    return defaultWorkspaceDir;
  }
}

async function runCodexCommand(
  invocation: CodexCommandInvocation,
): Promise<CodexCommandResult> {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(invocation.command, [...invocation.args, invocation.prompt], {
      cwd: invocation.cwd,
      env: invocation.env ?? {
        PATH: process.env.PATH ?? "",
        CI: process.env.CI || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: Timer | undefined;
    let timeoutTimer: Timer | undefined;

    const finalize = async (input: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      invocationError?: string;
    }) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }

      try {
        const lastMessage = await readFile(invocation.outputPath, "utf8").catch(() => "");
        resolve({
          exitCode: input.exitCode ?? (timedOut ? 124 : 1),
          stdout,
          stderr,
          lastMessage,
          durationMs: Date.now() - startedAt,
          timedOut,
          signal: input.signal ?? signal,
          ...(input.invocationError ? { invocationError: input.invocationError } : {}),
        });
      } catch (error) {
        reject(error);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      void finalize({
        exitCode: 1,
        invocationError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode, closeSignal) => {
      signal = closeSignal;
      void finalize({
        exitCode,
        signal: closeSignal,
      });
    });

    if (invocation.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `Codex timed out after ${invocation.timeoutMs}ms\n`;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, invocation.killGraceMs);
      }, invocation.timeoutMs);
    }
  });
}

function buildCodexFreshSandboxArgs(sandboxMode: ExecutorSlotSnapshot["sandboxMode"]) {
  if (sandboxMode === "danger-full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  return ["--sandbox", sandboxMode ?? "workspace-write"];
}

function buildCodexResumeSandboxArgs(sandboxMode: ExecutorSlotSnapshot["sandboxMode"]) {
  if (sandboxMode === "danger-full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  if ((sandboxMode ?? "workspace-write") === "workspace-write") {
    return ["--sandbox", "workspace-write"];
  }

  return [];
}

function buildCodexInvocation(input: {
  mode: CodexInvocationMode;
  configuredModel: string;
  workspaceDir: string;
  outputPath: string;
  prompt: string;
  codexCommand: string;
  sandboxMode: ExecutorSlotSnapshot["sandboxMode"];
  timeoutMs: number;
  killGraceMs: number;
  priorSessionId?: string | null;
}): CodexCommandInvocation {
  const sharedArgs = [
    "--skip-git-repo-check",
    ...(input.mode === "resume"
      ? buildCodexResumeSandboxArgs(input.sandboxMode)
      : buildCodexFreshSandboxArgs(input.sandboxMode)),
    "--json",
    "--model",
    input.configuredModel,
    "--output-last-message",
    input.outputPath,
  ];

  const args =
    input.mode === "resume"
      ? [
          "exec",
          "resume",
          ...sharedArgs,
          input.priorSessionId?.trim() ?? "",
        ]
      : [
          "exec",
          ...sharedArgs,
          "--color",
          "never",
          "-C",
          input.workspaceDir,
        ];

  return {
    command: input.codexCommand,
    cwd: input.workspaceDir,
    outputPath: input.outputPath,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    killGraceMs: input.killGraceMs,
    args,
  };
}

function classifyResumeFailureReason(result: NormalizedCodexCommandResult) {
  const haystack = [
    result.stderr,
    result.stdout,
    result.lastMessage,
    result.invocationError,
    ...result.structuredErrors,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (
    haystack.includes("session not found") ||
    haystack.includes("unknown session") ||
    haystack.includes("no such session") ||
    haystack.includes("unable to resume") ||
    haystack.includes("cannot resume") ||
    haystack.includes("resume failed")
  ) {
    return "resume_session_unavailable";
  }

  return null;
}

async function materializeArtifact(
  context: ExecutorDispatchContext,
  input: {
    artifactId: string;
    artifactType: string;
    title: string;
    summary: string;
    filePath: string;
    contents: string;
    createdAt: Date;
  },
) {
  await writeFile(input.filePath, input.contents, "utf8");
  await context.dependencies.artifactRepository.create({
    id: input.artifactId,
    taskId: context.task.id,
    roleRuntimeId: context.runtime.id,
    artifactType: input.artifactType,
    title: input.title,
    storageKind: "file",
    storageRef: input.filePath,
    summary: input.summary,
    createdAt: input.createdAt,
  } satisfies ArtifactInsert);
}

function buildInvocationFailure(
  context: ExecutorDispatchContext,
  input: Pick<CodexFailureDetails, "code" | "message">,
): ExecutorDispatchFailure {
  return {
    ok: false,
    runId: context.runtime.id,
    adapterId: context.slot.adapterId,
    state: "FAILED",
    code: input.code,
    message: input.message,
  };
}

function classifyCodexFailure(
  context: ExecutorDispatchContext,
  result: NormalizedCodexCommandResult,
): CodexFailureDetails {
  const roleLabel = context.runtime.roleId;
  const haystack = [result.stderr, result.stdout, result.lastMessage, result.invocationError]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (result.structuredErrors.length > 0) {
    return {
      code: "executor_invocation_failed",
      category: "execution_error",
      message: `Codex reported an internal error while dispatching the ${roleLabel} run`,
      suggestion:
        "Inspect the Codex stdout/stderr artifacts, resolve the reported CLI/runtime error, and retry the run.",
    };
  }

  if (result.timedOut || haystack.includes("timed out") || haystack.includes("timeout")) {
    return {
      code: "executor_timeout",
      category: "timeout",
      message: `Codex timed out while dispatching the ${roleLabel} run`,
      suggestion:
        "Reduce the task scope or increase the Codex timeout before retrying this run.",
    };
  }

  if (
    haystack.includes("authentication failed") ||
    haystack.includes("unauthorized") ||
    haystack.includes("forbidden") ||
    haystack.includes("invalid api key") ||
    haystack.includes("login required") ||
    haystack.includes("token")
  ) {
    return {
      code: "executor_auth_failed",
      category: "auth_error",
      message: `Codex authentication failed while dispatching the ${roleLabel} run`,
      suggestion:
        "Refresh the Codex credentials or API token, then retry the run once authentication is healthy.",
    };
  }

  if (
    haystack.includes("permission denied") ||
    haystack.includes("operation not permitted") ||
    haystack.includes("readonly database") ||
    haystack.includes("cannot access session files") ||
    haystack.includes("attempt to write a readonly database")
  ) {
    return {
      code: "executor_unavailable",
      category: "runtime_unavailable",
      message: `Codex runtime storage is not writable while dispatching the ${roleLabel} run`,
      suggestion:
        "Configure MAGISTER_CODEX_HOME to a writable directory (for example <workspace>/.magister/codex-home) and ensure Codex auth is available there before retrying.",
    };
  }

  if (
    haystack.includes("enoent") ||
    haystack.includes("command not found") ||
    haystack.includes("spawn codex")
  ) {
    return {
      code: "executor_unavailable",
      category: "runtime_unavailable",
      message: `Codex CLI is unavailable while dispatching the ${roleLabel} run`,
      suggestion:
        "Verify the Codex binary is installed and available on PATH before retrying this run.",
    };
  }

  return {
    code: "executor_invocation_failed",
    category: "execution_error",
    message: `Codex exited with code ${result.exitCode} while dispatching the ${roleLabel} run`,
    suggestion: "Inspect stderr and the Codex last-message artifact, then retry the run.",
  };
}

function normalizeCommandResult(result: CodexCommandResult): NormalizedCodexCommandResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    lastMessage: result.lastMessage,
    structuredErrors: extractStructuredCodexErrors(result.stdout),
    durationMs: result.durationMs ?? 0,
    timedOut: result.timedOut ?? false,
    signal: result.signal ?? null,
    ...(result.invocationError ? { invocationError: result.invocationError } : {}),
  };
}

export function createCodexExecutorAdapter(
  slot: ExecutorSlotSnapshot,
  options: CodexExecutorOptions = {},
): ExecutorAdapter {
  return {
    slot,
    async execute(context: ExecutorDispatchContext): Promise<ExecutorDispatchResult> {
      const configuredModel = context.slot.configuredModel?.trim();
      if (!configuredModel) {
        return await createStubExecutorAdapter(slot).execute(context);
      }

      const createId = context.createId ?? (() => crypto.randomUUID());
      const now = context.now ?? (() => new Date());
      const generatedSessionId = `session_${createId()}`;
      const stdoutArtifactId = `artifact_${createId()}`;
      const stderrArtifactId = `artifact_${createId()}`;
      const noteArtifactId = `artifact_${createId()}`;
      const metadataArtifactId = `artifact_${createId()}`;
      const startedAt = now();
      const shouldUseLeanManagerHarnessContext =
        context.runtime.roleId === "leader" &&
        !context.runtime.priorSessionId?.trim() &&
        context.runtime.resumePolicy !== "resume_first" &&
        context.runtime.resumePolicy !== "rehydrate_only" &&
        shouldUseConversationalShortcutTask(
          {
            title: context.task.title ?? context.task.id,
            description: context.task.description ?? null,
          },
          { policy: "broad" },
        );
      const managedWorkspaceLease: RuntimeWorkspaceLease | null =
        shouldUseLeanManagerHarnessContext
          ? null
          : options.workspaceDir && options.artifactsRootDir && options.codexHomeDir
          ? null
          : context.runtimeWorkspace ??
            await prepareRuntimeWorkspace({
              runId: context.runtime.id,
              taskId: context.task.id,
              roleId: context.runtime.roleId,
              workspaceId: context.task.workspaceId,
            });
      let runtimeWorkspaceStatus: "completed" | "failed" = "failed";
      const workspaceDir =
        options.workspaceDir ??
        managedWorkspaceLease?.workspaceDir ??
        process.cwd();
      const priorSessionId = context.runtime.priorSessionId?.trim() ?? null;
      const resumePolicy = context.runtime.resumePolicy?.trim() ?? null;
      const resumeRequested = resumePolicy === "resume_first" && Boolean(priorSessionId);
      const resumeWorkspaceDir = await resolveResumeWorkdir(
        workspaceDir,
        context.runtime.priorWorkdir ?? null,
      );
      const artifactsRootDir =
        options.artifactsRootDir ??
        join(
          managedWorkspaceLease?.artifactsBaseDir ?? join(process.cwd(), ".magister", "executor-artifacts", context.runtime.id),
          generatedSessionId,
        );
      const codexHomeDir =
        options.codexHomeDir ??
        process.env.MAGISTER_CODEX_HOME?.trim() ??
        managedWorkspaceLease?.codexHomeDir ??
        join(process.cwd(), ".magister", "codex-home");
      const codexCommand =
        context.slot.commandPath?.trim() ||
        options.codexCommand ||
        process.env.MAGISTER_CODEX_BIN?.trim() ||
        "codex";
      const sandboxMode = context.slot.sandboxMode ?? "workspace-write";
      const timeoutMs =
        context.slot.timeoutMs ?? options.timeoutMs ?? DEFAULT_CLI_EXECUTOR_TIMEOUT_MS;
      const killGraceMs = options.killGraceMs ?? 2_000;
      const runCodex = options.runCommand ?? runCodexCommand;
      try {
        await mkdir(artifactsRootDir, { recursive: true });
        await seedCodexHome(codexHomeDir);

        const shouldMaterializeRuntimeContext =
          !shouldUseLeanManagerHarnessContext &&
          (context.runtime.roleId !== "leader" ||
            Boolean(priorSessionId) ||
            Boolean(context.runtime.priorWorkdir?.trim()) ||
            resumePolicy === "resume_first" ||
            resumePolicy === "rehydrate_only");
        const runtimeContextBundle = shouldMaterializeRuntimeContext
          ? await buildRuntimeContextDocument({
              task: context.task,
              runtime: context.runtime,
            })
          : null;
        const runtimeContextJsonPath = join(artifactsRootDir, "runtime-context.json");
        const runtimeContextMarkdownPath = join(artifactsRootDir, "runtime-context.md");
        const runtimeContextArtifactId = `artifact_${createId()}`;
        let primaryRuntimeContractPath: string | null = null;
        let fallbackRuntimeContractPath: string | null = null;

        if (runtimeContextBundle) {
          await writeFile(runtimeContextJsonPath, runtimeContextBundle.json, "utf8");
          await writeFile(runtimeContextMarkdownPath, runtimeContextBundle.markdown, "utf8");
          await context.dependencies.artifactRepository.create({
            id: runtimeContextArtifactId,
            taskId: context.task.id,
            roleRuntimeId: context.runtime.id,
            artifactType: "runtime_context",
            title: "Runtime context document",
            storageKind: "file",
            storageRef: runtimeContextJsonPath,
            summary: "Captured runtime context document for the coder run",
            createdAt: startedAt,
          } satisfies ArtifactInsert);

          const primaryRuntimeContract = await writeRuntimeContract({
            workspaceDir: resumeRequested ? resumeWorkspaceDir : workspaceDir,
            runId: context.runtime.id,
            taskId: context.task.id,
            roleId: context.runtime.roleId,
            runtimeContextJsonPath,
            runtimeContextMarkdownPath,
            runtimeContext: runtimeContextBundle.document,
            managerDecisionSummary: runtimeContextBundle.summary,
          });
          primaryRuntimeContractPath = primaryRuntimeContract.filePath;
          fallbackRuntimeContractPath = primaryRuntimeContract.filePath;

          if (resumeRequested && resumeWorkspaceDir !== workspaceDir) {
            const fallbackRuntimeContract = await writeRuntimeContract({
              workspaceDir,
              runId: context.runtime.id,
              taskId: context.task.id,
              roleId: context.runtime.roleId,
              runtimeContextJsonPath,
              runtimeContextMarkdownPath,
              runtimeContext: runtimeContextBundle.document,
              managerDecisionSummary: runtimeContextBundle.summary,
            });
            fallbackRuntimeContractPath = fallbackRuntimeContract.filePath;
          }
        }

        let prompt = buildCodexPrompt({
          context,
          runtimeWorkspaceDir: resumeRequested ? resumeWorkspaceDir : workspaceDir,
          runtimeContractPath: resumeRequested
            ? primaryRuntimeContractPath
            : fallbackRuntimeContractPath,
          currentWallClock: startedAt,
        });
        const outputPath = join(artifactsRootDir, "last-message.md");
        const runtimeTmpDir = join(artifactsRootDir, "tmp");
        await mkdir(runtimeTmpDir, { recursive: true });
        const codexRuntimeEnv = buildRuntimeEnv({
          baseEnv: process.env,
          userEnv: {
            CODEX_HOME: codexHomeDir,
            CI: process.env.CI || "1",
          },
          runtimeSource: "codex",
          runtimeHomeDir: codexHomeDir,
          runtimeTmpDir,
        });
        const runtimeWorkspaceStrategy = managedWorkspaceLease?.strategy ?? "workspace_root";
        const initialInvocationMode: CodexInvocationMode = resumeRequested ? "resume" : "fresh";
        const runtimeWorkspaceBaseDir = managedWorkspaceLease?.baseWorkspaceDir ?? process.cwd();
        const initialInvocation = {
          ...buildCodexInvocation({
            mode: initialInvocationMode,
            configuredModel,
            workspaceDir: resumeRequested ? resumeWorkspaceDir : workspaceDir,
            outputPath,
            prompt,
            codexCommand,
            sandboxMode,
            timeoutMs,
            killGraceMs,
            priorSessionId,
          }),
          env: codexRuntimeEnv.env,
        };
        const prepareCodexExecutionSandbox = async (invocation: CodexCommandInvocation) => {
          // Codex runs its own inner bwrap via `--sandbox workspace-write`.
          // Wrapping it in Magister's outer bwrap nests sandboxes — the
          // inner mount() fails because the outer dropped privileges.
          // Force mode=off; same contract as cli-agent-spawn-service.ts.
          const executionSandbox = await assessExecutionSandbox({
            runtimeSource: "codex",
            runtimeWorkspaceDir: invocation.cwd,
            baseWorkspaceDir: runtimeWorkspaceBaseDir,
            runtimeHomeDir: codexHomeDir,
            runtimeTmpDir,
            homeIsolated: codexRuntimeEnv.env.HOME === codexHomeDir,
            config: { mode: "off" },
          });
          return prepareExecutionSandboxCommand({
            command: invocation.command,
            args: invocation.args,
            cwd: invocation.cwd,
            env: invocation.env ?? codexRuntimeEnv.env,
            executionSandbox,
            baseWorkspaceDir: runtimeWorkspaceBaseDir,
            runtimeWorkspaceDir: invocation.cwd,
            runtimeHomeDir: codexHomeDir,
            runtimeTmpDir,
          });
        };
        const initialSandboxPlan = await prepareCodexExecutionSandbox(initialInvocation);
        const initialRuntimeSecurity = buildCodexRuntimeSecurity({
          commandPath: initialInvocation.command,
          args: initialInvocation.args,
          sandboxMode,
          envPermissionHints: codexRuntimeEnv.permissionHints,
          runtimeWorkspaceStrategy,
          executionSandbox: initialSandboxPlan.executionSandbox,
        });
        const initialFormattedCommand = formatCommand(
          initialInvocation.command,
          initialInvocation.args,
        );
        const initialSessionId = resumeRequested && priorSessionId ? priorSessionId : generatedSessionId;

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "RUNNING",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: initialSessionId,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? startedAt,
          updatedAt: startedAt,
          completedAt: null,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "IN_PROGRESS",
          updatedAt: startedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createEvent(context, {
            id: `event_${createId()}`,
            type: "executor_session.started",
            taskId: context.task.id,
            roleRuntimeId: context.runtime.id,
            executorSessionId: initialSessionId,
            workspaceId: context.task.workspaceId,
            severity: "info",
            occurredAt: startedAt,
            payloadJson: JSON.stringify({
              message: resumeRequested
                ? `Codex started the ${context.runtime.roleId} run with resume-first policy`
                : `Codex started the ${context.runtime.roleId} run`,
              source: context.slot.adapterId,
              authMode: context.slot.authMode ?? "chatgpt",
              configuredModel,
              command: initialFormattedCommand,
              artifactsRootDir,
              codexHomeDir,
              sandboxMode,
              timeoutMs,
              invocationMode: initialInvocationMode,
              runtimeSecurity: initialRuntimeSecurity,
              resumePolicy,
              resumeAttempted: resumeRequested,
              resumeSourceSessionId: priorSessionId,
              runtimeWorkspaceStrategy,
              runtimeWorkspaceDir: initialInvocation.cwd,
              runtimeWorkspaceBaseDir,
            }),
          }),
        );

        const runInvocation = async (
          invocation: CodexCommandInvocation,
          preparedSandboxPlan = initialInvocation === invocation
            ? initialSandboxPlan
            : undefined,
        ) => {
          const sandboxPlan = preparedSandboxPlan ?? await prepareCodexExecutionSandbox(invocation);
          let commandResult: CodexCommandResult;
          if (sandboxPlan.type === "failed") {
            commandResult = {
              exitCode: 1,
              stdout: "",
              stderr: sandboxPlan.failureReason,
              lastMessage: "",
              durationMs: 0,
              invocationError: sandboxPlan.failureReason,
            };
          } else {
            const executableInvocation = sandboxPlan.type === "wrapped"
              ? {
                  ...invocation,
                  command: sandboxPlan.command,
                  args: sandboxPlan.args,
                  cwd: sandboxPlan.cwd,
                  env: sandboxPlan.env,
                }
              : invocation;
            try {
              commandResult = await runCodex(executableInvocation);
            } catch (error) {
              commandResult = {
                exitCode: 1,
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                lastMessage: "",
                durationMs: 0,
                invocationError: error instanceof Error ? error.message : String(error),
              };
            }
          }

          const normalizedCommandResult = normalizeCommandResult(commandResult);
          return {
            commandResult,
            normalizedCommandResult,
            formattedCommand: formatCommand(invocation.command, invocation.args),
            detectedSessionId: extractCodexSessionId(commandResult.stdout),
            executionSandbox: sandboxPlan.executionSandbox,
          };
        };

        const recordManagerLoopToolEvent = async (input: {
          type: "tool.call" | "tool.result" | "tool.error";
          toolName: string;
          arguments: Record<string, unknown>;
          observation?:
            | {
                ok: boolean;
                result?: unknown;
                summary: string;
                error?: string;
              }
            | undefined;
          sessionId: string;
        }) => {
          const occurredAt = now();
          const summary =
            input.type === "tool.call"
              ? `Manager tool call: ${input.toolName}`
              : input.type === "tool.result"
                ? `Manager tool result: ${input.toolName}`
                : `Manager tool error: ${input.toolName}`;

          await context.dependencies.observabilityAdapter.recordEvent(
            createEvent(context, {
              id: `event_${createId()}`,
              type: input.type,
              taskId: context.task.id,
              roleRuntimeId: context.runtime.id,
              executorSessionId: input.sessionId,
              workspaceId: context.task.workspaceId,
              severity: input.type === "tool.error" ? "warning" : "info",
              occurredAt,
              payloadJson: JSON.stringify({
                source: context.slot.adapterId,
                message: summary,
                toolName: input.toolName,
                arguments: input.arguments,
                ...(input.type !== "tool.call"
                  ? input.observation?.ok
                    ? {
                        result: input.observation.result,
                        resultSummary: input.observation.summary,
                      }
                    : {
                        errorMessage:
                          input.observation?.error ?? input.observation?.summary ?? summary,
                      }
                  : {}),
              }),
            }),
          );

          await queueFeishuRuntimeTraceIfEnabled({
            source: context.task.source ?? "web",
            rootChannelBindingId: context.task.rootChannelBindingId,
            workspaceId: context.task.workspaceId,
            taskId: context.task.id,
            sourceEventId: `${input.type}:${context.runtime.id}:${input.toolName}:${occurredAt.toISOString()}`,
            eventType: input.type,
            summary:
              input.type === "tool.call"
                ? `Tool call: ${input.toolName}`
                : input.type === "tool.result"
                  ? `Tool result: ${input.toolName}`
                  : `Tool error: ${input.toolName}`,
            details: {
              toolName: input.toolName,
              arguments: input.arguments,
              ...(input.type !== "tool.call"
                ? input.observation?.ok
                  ? {
                      result: input.observation.result,
                      resultSummary: input.observation.summary,
                    }
                  : {
                      errorMessage:
                        input.observation?.error ?? input.observation?.summary ?? summary,
                    }
                : {}),
            },
            roleId: context.runtime.roleId,
            executorId: context.slot.adapterId,
            sessionId: input.sessionId,
            attemptCount: context.runtime.attemptCount + 1,
          });
        };

        const invocationHistory: Array<{
          mode: CodexInvocationMode;
          command: string;
          cwd: string;
          exitCode: number;
          timedOut: boolean;
        }> = [];
        let finalInvocationMode: CodexInvocationMode = initialInvocationMode;
        let finalInvocation = initialInvocation;
        let finalFormattedCommand = initialFormattedCommand;
        let finalExecutionSandbox = initialSandboxPlan.executionSandbox;
        let resumeFallbackToFresh = false;
        let resumeFailureReason: string | null = null;

        let commandResult: CodexCommandResult;
        let normalizedCommandResult: NormalizedCodexCommandResult;
        let detectedSessionId: string | null = null;

        if (context.runtime.roleId === "leader") {
          const stdoutSegments: string[] = [];
          const stderrSegments: string[] = [];
          let latestCommandResult: CodexCommandResult | null = null;
          let latestNormalizedCommandResult: NormalizedCodexCommandResult | null = null;
          let latestDetectedSessionId: string | null = null;
          let latestSessionId = initialSessionId;
          let dispatchCount = 0;
          const groundingRequirement = getManagerGroundingRequirement({
            title: context.task.title ?? context.task.id,
            description: context.task.description ?? null,
          });

          const dispatchManagerPrompt = async (managerPrompt: string) => {
            let invocationMode: CodexInvocationMode =
              dispatchCount === 0 ? initialInvocationMode : "fresh";
            let invocationWorkspaceDir =
              dispatchCount === 0 && resumeRequested ? resumeWorkspaceDir : workspaceDir;
            let invocationPriorSessionId =
              dispatchCount === 0 && invocationMode === "resume" ? priorSessionId : null;
            let invocation = {
              ...buildCodexInvocation({
                mode: invocationMode,
                configuredModel,
                workspaceDir: invocationWorkspaceDir,
                outputPath,
                prompt: managerPrompt,
                codexCommand,
                sandboxMode,
                timeoutMs,
                killGraceMs,
                priorSessionId: invocationPriorSessionId,
              }),
              env: codexRuntimeEnv.env,
            };
            let execution = await runInvocation(invocation);

            if (
              dispatchCount === 0 &&
              resumeRequested &&
              (execution.normalizedCommandResult.exitCode !== 0 ||
                execution.normalizedCommandResult.structuredErrors.length > 0)
            ) {
              const classifiedResumeFailure = classifyResumeFailureReason(
                execution.normalizedCommandResult,
              );
              if (!execution.detectedSessionId && classifiedResumeFailure) {
                resumeFallbackToFresh = true;
                resumeFailureReason = classifiedResumeFailure;
                invocationMode = "fresh";
                invocationWorkspaceDir = workspaceDir;
                invocationPriorSessionId = null;
                invocation = {
                  ...buildCodexInvocation({
                    mode: "fresh",
                    configuredModel,
                    workspaceDir,
                    outputPath,
                    prompt: managerPrompt,
                    codexCommand,
                    sandboxMode,
                    timeoutMs,
                    killGraceMs,
                  }),
                  env: codexRuntimeEnv.env,
                };
                execution = await runInvocation(invocation);
              }
            }

            dispatchCount += 1;
            finalInvocationMode = invocationMode;
            finalInvocation = invocation;
            finalFormattedCommand = execution.formattedCommand;
            finalExecutionSandbox = execution.executionSandbox;
            invocationHistory.push({
              mode: invocationMode,
              command: execution.formattedCommand,
              cwd: invocation.cwd,
              exitCode: execution.normalizedCommandResult.exitCode,
              timedOut: execution.normalizedCommandResult.timedOut,
            });
            stdoutSegments.push(execution.commandResult.stdout);
            stderrSegments.push(execution.commandResult.stderr);
            latestCommandResult = execution.commandResult;
            latestNormalizedCommandResult = execution.normalizedCommandResult;
            latestDetectedSessionId = execution.detectedSessionId;
            latestSessionId =
              execution.detectedSessionId ??
              (invocationMode === "resume" && priorSessionId
                ? priorSessionId
                : latestSessionId);

            return {
              ok:
                execution.normalizedCommandResult.exitCode === 0 &&
                execution.normalizedCommandResult.structuredErrors.length === 0,
              status:
                execution.normalizedCommandResult.exitCode === 0 &&
                execution.normalizedCommandResult.structuredErrors.length === 0
                  ? 200
                  : 500,
              body: {
                message: execution.normalizedCommandResult.lastMessage,
              },
              message: execution.normalizedCommandResult.lastMessage,
            };
          };

          const loopResult = await runManagerLoop({
            basePrompt: prompt,
            workspaceDir,
            dispatchModel: dispatchManagerPrompt,
            now,
            validateTerminalResponse: ({ observations, action, managerDecision }) => {
              if (!groundingRequirement || observations.length > 0) {
                return null;
              }
              if (managerDecision?.decision === "direct_answer" || action?.kind === "respond") {
                return groundingRequirement;
              }
              return null;
            },
            onToolEvent: async (event) => {
              await recordManagerLoopToolEvent({
                type: event.type,
                toolName: event.toolName,
                arguments: event.arguments,
                ...(event.type !== "tool.call" ? { observation: event.observation } : {}),
                sessionId: latestSessionId,
              });
            },
          });

          if (!loopResult) {
            const fallbackExecution = await dispatchManagerPrompt(prompt);
            latestCommandResult = latestCommandResult ?? {
              exitCode: fallbackExecution.ok ? 0 : 1,
              stdout: stdoutSegments.join("\n"),
              stderr: stderrSegments.join("\n"),
              lastMessage: fallbackExecution.message ?? "",
            };
            latestNormalizedCommandResult =
              latestNormalizedCommandResult ?? normalizeCommandResult(latestCommandResult);
          } else {
            const extractedLoopDecision = extractManagerDecisionOutput(loopResult.finalMessage);
            const groundedReply =
              extractedLoopDecision.parsedDecision?.decision === "direct_answer"
                ? coerceGroundedManagerReply({
                    task: {
                      title: context.task.title ?? context.task.id,
                      description: context.task.description ?? null,
                    },
                    observations: loopResult.observations,
                    reply: extractedLoopDecision.parsedDecision.reply ?? null,
                  })
                : null;
            const finalLoopMessage =
              groundedReply && extractedLoopDecision.parsedDecision
                ? JSON.stringify({
                    ...extractedLoopDecision.parsedDecision,
                    reply: groundedReply,
                  })
                : loopResult.finalMessage;
            const latestResult =
              latestCommandResult ??
              ({
                exitCode: loopResult.response.ok ? 0 : 1,
                stdout: "",
                stderr: "",
                lastMessage: finalLoopMessage,
              } satisfies CodexCommandResult);
            latestCommandResult = {
              ...latestResult,
              stdout: stdoutSegments.join("\n"),
              stderr: stderrSegments.join("\n"),
              lastMessage: finalLoopMessage,
            };
            latestNormalizedCommandResult = normalizeCommandResult(latestCommandResult);
          }

          commandResult = latestCommandResult;
          normalizedCommandResult = latestNormalizedCommandResult;
          detectedSessionId = latestDetectedSessionId;
        } else {
          const initialExecution = await runInvocation(initialInvocation);
          commandResult = initialExecution.commandResult;
          normalizedCommandResult = initialExecution.normalizedCommandResult;
          detectedSessionId = initialExecution.detectedSessionId;
          finalFormattedCommand = initialExecution.formattedCommand;
          finalExecutionSandbox = initialExecution.executionSandbox;
          invocationHistory.push({
            mode: initialInvocationMode,
            command: initialExecution.formattedCommand,
            cwd: initialInvocation.cwd,
            exitCode: normalizedCommandResult.exitCode,
            timedOut: normalizedCommandResult.timedOut,
          });

          if (
            resumeRequested &&
            (normalizedCommandResult.exitCode !== 0 ||
              normalizedCommandResult.structuredErrors.length > 0)
          ) {
            const classifiedResumeFailure = classifyResumeFailureReason(normalizedCommandResult);
            if (!detectedSessionId && classifiedResumeFailure) {
              resumeFallbackToFresh = true;
              resumeFailureReason = classifiedResumeFailure;
              finalInvocationMode = "fresh";
              prompt = buildCodexPrompt({
                context,
                runtimeWorkspaceDir: workspaceDir,
                runtimeContractPath: fallbackRuntimeContractPath,
                forceRehydration: true,
                currentWallClock: startedAt,
              });
              finalInvocation = {
                ...buildCodexInvocation({
                  mode: "fresh",
                  configuredModel,
                  workspaceDir,
                  outputPath,
                  prompt,
                  codexCommand,
                  sandboxMode,
                  timeoutMs,
                  killGraceMs,
                }),
                env: codexRuntimeEnv.env,
              };
              const fallbackExecution = await runInvocation(finalInvocation);
              commandResult = fallbackExecution.commandResult;
              normalizedCommandResult = fallbackExecution.normalizedCommandResult;
              detectedSessionId = fallbackExecution.detectedSessionId;
              finalFormattedCommand = fallbackExecution.formattedCommand;
              finalExecutionSandbox = fallbackExecution.executionSandbox;
              invocationHistory.push({
                mode: "fresh",
                command: fallbackExecution.formattedCommand,
                cwd: finalInvocation.cwd,
                exitCode: normalizedCommandResult.exitCode,
                timedOut: normalizedCommandResult.timedOut,
              });
            }
          }
        }

        const sessionId =
          detectedSessionId ??
          (finalInvocationMode === "resume" && priorSessionId
            ? priorSessionId
            : generatedSessionId);
        const parsedToolEvents =
          context.runtime.roleId === "leader"
            ? []
            : extractExplicitToolEventsFromJsonLines(commandResult.stdout);

        const completedAt = now();
        const stdoutPath = join(artifactsRootDir, "stdout.jsonl");
        const stderrPath = join(artifactsRootDir, "stderr.log");
        const notePath = outputPath;
        const metadataPath = join(artifactsRootDir, "session.json");

        await materializeArtifact(context, {
          artifactId: stdoutArtifactId,
          artifactType: "execution_log",
          title: "Codex stdout log",
          summary: `Captured Codex stdout for the ${context.runtime.roleId} run`,
          filePath: stdoutPath,
          contents: commandResult.stdout,
          createdAt: completedAt,
        });

        await materializeArtifact(context, {
          artifactId: stderrArtifactId,
          artifactType: "execution_log",
          title: "Codex stderr log",
          summary: `Captured Codex stderr for the ${context.runtime.roleId} run`,
          filePath: stderrPath,
          contents: commandResult.stderr,
          createdAt: completedAt,
        });

        const artifactDescriptor = getArtifactDescriptor(context.runtime.roleId);
        const rawLastMessage = normalizedCommandResult.lastMessage.trim();
        const preferredLastMessage =
          rawLastMessage && !looksLikeCodexDiagnosticsLog(rawLastMessage)
            ? rawLastMessage
            : "";
        const diagnosticSegments = [
          rawLastMessage,
          normalizedCommandResult.stderr,
          normalizedCommandResult.stdout,
          normalizedCommandResult.invocationError ?? "",
        ]
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0)
          .filter((segment, index, segments) => segments.indexOf(segment) === index);
        const condensedDiagnostics = condenseCodexDiagnostics(
          diagnosticSegments.join("\n"),
        );
        const noteSummarySource =
          preferredLastMessage ||
          condensedDiagnostics?.message ||
          normalizedCommandResult.stderr.trim() ||
          normalizedCommandResult.stdout.trim() ||
          `Codex completed the ${context.runtime.roleId} run`;

        await materializeArtifact(context, {
          artifactId: noteArtifactId,
          artifactType: artifactDescriptor.artifactType,
          title: artifactDescriptor.title,
          summary: summarizeText(noteSummarySource),
          filePath: notePath,
          contents: noteSummarySource,
          createdAt: completedAt,
        });

        const finalRuntimeSecurity = buildCodexRuntimeSecurity({
          commandPath: finalInvocation.command,
          args: finalInvocation.args,
          sandboxMode,
          envPermissionHints: codexRuntimeEnv.permissionHints,
          runtimeWorkspaceStrategy,
          executionSandbox: finalExecutionSandbox,
        });

        await materializeArtifact(context, {
          artifactId: metadataArtifactId,
          artifactType: "execution_metadata",
          title: "Codex session metadata",
          summary: `Captured Codex session metadata for the ${context.runtime.roleId} run`,
          filePath: metadataPath,
          contents: JSON.stringify(
            {
              adapterId: context.slot.adapterId,
              authMode: context.slot.authMode ?? "chatgpt",
              configuredModel,
              roleId: context.runtime.roleId,
              runId: context.runtime.id,
              taskId: context.task.id,
              workspaceId: context.task.workspaceId,
              workspaceDir,
              artifactsRootDir,
              codexHomeDir,
              sessionId,
              command: finalFormattedCommand,
              runtimeSecurity: finalRuntimeSecurity,
              sandboxMode,
              timeoutMs,
              invocationMode: finalInvocationMode,
              invocationHistory,
              resumePolicy,
              resumeAttempted: resumeRequested,
              resumeSourceSessionId: priorSessionId,
              resumeFallbackToFresh,
              resumeFailureReason,
              durationMs: normalizedCommandResult.durationMs,
              exitCode: normalizedCommandResult.exitCode,
              structuredErrors: normalizedCommandResult.structuredErrors,
              timedOut: normalizedCommandResult.timedOut,
              signal: normalizedCommandResult.signal,
              stdoutPath,
              stderrPath,
              notePath,
              outputPath,
              runtimeWorkspaceStrategy,
              runtimeWorkspaceBaseDir,
              runtimeWorkspaceManaged: Boolean(managedWorkspaceLease),
              runtimeWorkspaceMetadataPath: managedWorkspaceLease?.metadataPath ?? null,
              promptPreview: summarizeText(prompt, 400),
              startedAt: startedAt.toISOString(),
              completedAt: completedAt.toISOString(),
            },
            null,
            2,
          ),
          createdAt: completedAt,
        });

        await recordParsedToolEvents(context, parsedToolEvents, completedAt);

        const observedSideEffectEventTypes = parsedToolEvents.map((event) => event.type);
        const mcpToolRisk = await buildMcpToolRisk(parsedToolEvents);
        const diffArtifact = await collectRuntimeDiff({
          workspaceDir: finalInvocation.cwd,
          artifactsDir: artifactsRootDir,
          artifactId: `artifact_${createId()}`,
          ...(managedWorkspaceLease?.baseRevision !== undefined
            ? { baseRevision: managedWorkspaceLease.baseRevision }
            : {}),
        });
        const sastAdvisory = await runSastAdvisory({
          workspaceDir: finalInvocation.cwd,
          diffArtifact,
        });
        const gate = await classifyStaticGate({
          runtimeSecurity: finalRuntimeSecurity,
          diffArtifact,
          verification: [],
          observedSideEffectEventTypes,
          mcpToolRisk,
          sastAdvisory,
        });
        const reviewDraft = await createChangeReviewDraft({
          taskId: context.task.id,
          roleRuntimeId: context.runtime.id,
          workspaceId: context.task.workspaceId,
          runtimeSecurity: finalRuntimeSecurity,
          diffArtifact,
          gate,
          mcpToolRisk,
          sastAdvisory,
          sideEffectWarning: diffArtifact.isEmpty && observedSideEffectEventTypes.length > 0
            ? {
                code: "no_code_diff_runtime_side_effects_not_audited",
                message: "No code diff was produced; runtime side effects are not audited in Phase 1.",
                observedEventTypes: observedSideEffectEventTypes,
              }
            : null,
          verification: [],
          artifactsDir: artifactsRootDir,
          createId,
          now: () => completedAt,
          artifactRepository: context.dependencies.artifactRepository,
          executionEventRepository: {
            async create(event) {
              return context.dependencies.observabilityAdapter.recordEvent(
                createEvent(context, event),
              );
            },
          },
        });
        await materializeChangeReviewFromDraftBestEffort({
          reviewDraftArtifactId: reviewDraft.artifactIds.reviewDraftArtifactId,
          diffArtifactId: reviewDraft.artifactIds.diffArtifactId,
          gateArtifactId: reviewDraft.artifactIds.gateArtifactId,
          now: () => completedAt,
          artifactRepository: context.dependencies.artifactRepository,
          executionEventRepository: {
            async create(event) {
              return context.dependencies.observabilityAdapter.recordEvent(
                createEvent(context, event),
              );
            },
          },
        });

        if (
          normalizedCommandResult.exitCode === 0 &&
          normalizedCommandResult.structuredErrors.length === 0
        ) {
          await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
            state: "COMPLETED",
            currentSessionId: sessionId,
            ...(resumeRequested
              ? {
                  resumeAttemptedAt: context.runtime.resumeAttemptedAt ?? startedAt,
                  resumeFailureReason,
                }
              : {}),
            updatedAt: completedAt,
            completedAt,
          });

          await context.dependencies.observabilityAdapter.recordEvent(
            createEvent(context, {
              id: `event_${createId()}`,
              type: "executor_session.completed",
              taskId: context.task.id,
              roleRuntimeId: context.runtime.id,
              executorSessionId: sessionId,
              artifactId: noteArtifactId,
              workspaceId: context.task.workspaceId,
              severity: "info",
              occurredAt: completedAt,
              payloadJson: JSON.stringify({
                message: summarizeText(noteSummarySource),
                lastMessage: preferredLastMessage || noteSummarySource,
                readableMessage: noteSummarySource,
                source: context.slot.adapterId,
                configuredModel,
                command: finalFormattedCommand,
                invocationMode: finalInvocationMode,
                invocationHistory,
                resumePolicy,
                resumeAttempted: resumeRequested,
                resumeSourceSessionId: priorSessionId,
                resumeFallbackToFresh,
                resumeFailureReason,
                durationMs: normalizedCommandResult.durationMs,
                metadataArtifactId,
                stdoutPreview: summarizeText(normalizedCommandResult.stdout, 280),
                stderrPreview: summarizeText(normalizedCommandResult.stderr, 280),
                lastMessagePreview: summarizeText(preferredLastMessage || noteSummarySource, 280),
              }),
            }),
          );

          runtimeWorkspaceStatus = "completed";
          return {
            ok: true,
            runId: context.runtime.id,
            adapterId: context.slot.adapterId,
            state: "COMPLETED",
            sessionId,
            artifactId: noteArtifactId,
          };
        }

        const failure = classifyCodexFailure(context, normalizedCommandResult);

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          currentSessionId: sessionId,
          ...(resumeRequested
            ? {
                resumeAttemptedAt: context.runtime.resumeAttemptedAt ?? startedAt,
                resumeFailureReason:
                  resumeFailureReason ?? classifyResumeFailureReason(normalizedCommandResult),
              }
            : {}),
          updatedAt: completedAt,
          completedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: completedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createEvent(context, {
            id: `event_${createId()}`,
            type: "executor_session.failed",
            taskId: context.task.id,
            roleRuntimeId: context.runtime.id,
            executorSessionId: sessionId,
            artifactId: noteArtifactId,
            workspaceId: context.task.workspaceId,
            severity: "error",
            occurredAt: completedAt,
            payloadJson: JSON.stringify({
              message: failure.message,
              lastMessage: preferredLastMessage || noteSummarySource,
              readableMessage: noteSummarySource,
              error:
                normalizedCommandResult.structuredErrors.join("\n").trim() ||
                condensedDiagnostics?.message ||
                summarizeText(normalizedCommandResult.stderr, 600) ||
                normalizedCommandResult.invocationError ||
                failure.message,
              reason: failure.code,
              failureCode: failure.code,
              errorCategory: failure.category,
              source: context.slot.adapterId,
              configuredModel,
              command: finalFormattedCommand,
              invocationMode: finalInvocationMode,
              invocationHistory,
              resumePolicy,
              resumeAttempted: resumeRequested,
              resumeSourceSessionId: priorSessionId,
              resumeFallbackToFresh,
              resumeFailureReason:
                resumeFailureReason ?? classifyResumeFailureReason(normalizedCommandResult),
              exitCode: normalizedCommandResult.exitCode,
              durationMs: normalizedCommandResult.durationMs,
              timedOut: normalizedCommandResult.timedOut,
              signal: normalizedCommandResult.signal,
              stdoutPreview: summarizeText(normalizedCommandResult.stdout, 280),
              stderrPreview: summarizeText(normalizedCommandResult.stderr, 280),
              lastMessagePreview: summarizeText(preferredLastMessage || noteSummarySource, 280),
              pluginManifestWarningCount: condensedDiagnostics?.pluginWarningCount ?? 0,
              shellSnapshotWarningCount: condensedDiagnostics?.shellSnapshotWarningCount ?? 0,
              structuredErrors: normalizedCommandResult.structuredErrors,
              metadataArtifactId,
              suggestion: failure.suggestion,
            }),
          }),
        );

        runtimeWorkspaceStatus = "failed";
        return buildInvocationFailure(context, failure);
      } finally {
        if (managedWorkspaceLease?.metadataPath) {
          await finalizeRuntimeWorkspace({
            metadataPath: managedWorkspaceLease.metadataPath,
            status: runtimeWorkspaceStatus,
          });
        }
      }
    },
  };
}

type NormalizedCodexCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  lastMessage: string;
  structuredErrors: string[];
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  invocationError?: string;
};
