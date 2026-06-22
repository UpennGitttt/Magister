import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

type OpenCodeCommandInvocation = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  killGraceMs: number;
  env?: Record<string, string>;
};

type OpenCodeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  timedOut?: boolean;
  signal?: NodeJS.Signals | null;
  invocationError?: string;
};

type OpenCodeExecutorOptions = {
  workspaceDir?: string;
  artifactsRootDir?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  runCommand?: (invocation: OpenCodeCommandInvocation) => Promise<OpenCodeCommandResult>;
};

type ParsedOpenCodeOutput = {
  sessionId: string | null;
  assistantMessage: string | null;
};

type OpenCodeFailureDetails = {
  code: ExecutorDispatchFailure["code"];
  category: ExecutorErrorCategory;
  message: string;
  suggestion: string;
};

const DEFAULT_OPENCODE_TIMEOUT_MS = 7_200_000;

function buildOpenCodeRuntimeSecurity(input: {
  commandPath: string;
  args: string[];
  sandboxMode: ExecutorSlotSnapshot["sandboxMode"];
  envPermissionHints: string[];
  runtimeWorkspaceStrategy: RuntimeWorkspaceStrategy;
  executionSandbox: RuntimeSecurityMetadata["executionSandbox"];
}): RuntimeSecurityMetadata {
  const sandboxMode = input.sandboxMode ?? "workspace-write";
  const permission = derivePermissionMode({
    runtimeSource: "opencode",
    argv: input.args,
    sandboxMode,
    envPermissionHints: input.envPermissionHints,
    hasInteractiveApprovalChannel: false,
  });
  return {
    runtimeSource: "opencode",
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
  return {
    artifactType: "execution_note",
    title: `${roleId[0]?.toUpperCase() ?? ""}${roleId.slice(1)} execution note`,
  };
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
        ...(toolEvent.errorMessage
          ? {
              errorMessage: toolEvent.errorMessage,
            }
          : {}),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNestedAssistantContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (isPlainObject(item)) {
          if (typeof item.text === "string" && item.text.trim().length > 0) {
            return item.text.trim();
          }
          if (typeof item.content === "string" && item.content.trim().length > 0) {
            return item.content.trim();
          }
        }
        return "";
      })
      .filter((item) => item.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (isPlainObject(value)) {
    if (typeof value.content === "string" && value.content.trim().length > 0) {
      return value.content.trim();
    }
    if (typeof value.text === "string" && value.text.trim().length > 0) {
      return value.text.trim();
    }
    if ("content" in value) {
      return readNestedAssistantContent(value.content);
    }
  }

  return null;
}

function parseOpenCodeOutput(stdout: string): ParsedOpenCodeOutput {
  const sessionKeys = ["session_id", "sessionId", "id"] as const;
  let sessionId: string | null = null;
  let assistantMessage: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }

      for (const key of sessionKeys) {
        const value = parsed[key];
        if (!sessionId && typeof value === "string" && value.trim().length > 0) {
          sessionId = value.trim();
        }
      }

      const messageCandidate =
        readNestedAssistantContent(parsed.message) ??
        readNestedAssistantContent(parsed.content) ??
        readNestedAssistantContent(parsed.text);
      if (messageCandidate) {
        assistantMessage = messageCandidate;
      }
    } catch {
      continue;
    }
  }

  return {
    sessionId,
    assistantMessage,
  };
}

function quoteArg(value: string) {
  return value.length === 0 || /[\s"'\\]/.test(value)
    ? JSON.stringify(value)
    : value;
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].map((segment) => quoteArg(segment)).join(" ");
}

function buildOpenCodePrompt(input: {
  context: ExecutorDispatchContext;
  runtimeWorkspaceDir: string;
  runtimeContractPath?: string | null;
}) {
  const delegationInstructions =
    input.context.runtime.delegationMode === "delegate_with_context"
      ? [
          "Delegation Mode: handoff",
          "You are continuing a task-manager handoff. Rehydrate task truth from the runtime contract before acting.",
        ]
      : [
          "Delegation Mode: assign",
          "You are handling a fresh assignment. Solve the requested work item independently.",
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
    : ["- Rehydrate task truth from the runtime context artifacts before making changes."];

  return [
    "You are OpenCode running inside Magister.",
    "You are a delegated execution subagent inside Magister.",
    `Role: ${input.context.runtime.roleId}`,
    `Task ID: ${input.context.task.id}`,
    `Workspace ID: ${input.context.task.workspaceId}`,
    `Task Title: ${input.context.task.title ?? input.context.task.id}`,
    `Task Description: ${input.context.task.description?.trim() || input.context.task.title || input.context.task.id}`,
    `Current Task State: ${input.context.task.state}`,
    ...delegationInstructions,
    "",
    "Instructions:",
    "- Work only inside the provided workspace directory.",
    "- Do not ask interactive questions.",
    "- Prefer deterministic edits and concise execution notes.",
    ...runtimeContractInstructions,
    "- Native resume is not available on this path. Do not assume prior session memory is available.",
    "- Do not treat bootstrap, environment checks, or session setup as task completion.",
    "- After satisfying workspace bootstrap requirements, continue with the actual task request.",
    "- If you fail, explain the blocker and the most useful next action.",
    "",
    "Return sections exactly:",
    "Objective",
    "Actions",
    "Outcome",
  ].join("\n");
}

async function runOpenCodeCommand(
  invocation: OpenCodeCommandInvocation,
): Promise<OpenCodeCommandResult> {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(invocation.command, invocation.args, {
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

    const finalize = (input: {
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

      resolve({
        exitCode: input.exitCode ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        signal: input.signal ?? signal,
        ...(input.invocationError ? { invocationError: input.invocationError } : {}),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      finalize({
        exitCode: 1,
        invocationError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode, closeSignal) => {
      signal = closeSignal;
      finalize({
        exitCode,
        signal: closeSignal,
      });
    });

    if (invocation.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `OpenCode timed out after ${invocation.timeoutMs}ms\n`;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, invocation.killGraceMs);
      }, invocation.timeoutMs);
    }
  });
}

function buildOpenCodeInvocation(input: {
  workspaceDir: string;
  prompt: string;
  configuredModel: string;
  commandPath: string;
  timeoutMs: number;
  killGraceMs: number;
}): OpenCodeCommandInvocation {
  return {
    command: input.commandPath,
    cwd: input.workspaceDir,
    timeoutMs: input.timeoutMs,
    killGraceMs: input.killGraceMs,
    args: [
      "run",
      "--format",
      "json",
      "--pure",
      "--dir",
      input.workspaceDir,
      "--model",
      input.configuredModel,
      input.prompt,
    ],
  };
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

function classifyOpenCodeFailure(
  context: ExecutorDispatchContext,
  result: OpenCodeCommandResult,
): OpenCodeFailureDetails {
  const roleLabel = context.runtime.roleId;
  const haystack = [result.stderr, result.stdout, result.invocationError]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (result.timedOut || haystack.includes("timed out") || haystack.includes("timeout")) {
    return {
      code: "executor_timeout",
      category: "timeout",
      message: `OpenCode timed out while dispatching the ${roleLabel} run`,
      suggestion: "Reduce the task scope or increase the OpenCode timeout before retrying this run.",
    };
  }

  if (
    haystack.includes("authentication failed") ||
    haystack.includes("unauthorized") ||
    haystack.includes("forbidden") ||
    haystack.includes("invalid api key") ||
    haystack.includes("login required")
  ) {
    return {
      code: "executor_auth_failed",
      category: "auth_error",
      message: `OpenCode authentication failed while dispatching the ${roleLabel} run`,
      suggestion: "Refresh the OpenCode provider credentials, then retry the run.",
    };
  }

  if (
    haystack.includes("enoent") ||
    haystack.includes("command not found") ||
    haystack.includes("spawn opencode")
  ) {
    return {
      code: "executor_unavailable",
      category: "runtime_unavailable",
      message: `OpenCode CLI is unavailable while dispatching the ${roleLabel} run`,
      suggestion: "Verify the OpenCode binary is installed and available on PATH before retrying this run.",
    };
  }

  return {
    code: "executor_invocation_failed",
    category: "execution_error",
    message: `OpenCode exited with code ${result.exitCode} while dispatching the ${roleLabel} run`,
    suggestion: "Inspect OpenCode stdout/stderr artifacts and retry the run after fixing the CLI/runtime error.",
  };
}

export function createOpenCodeExecutorAdapter(
  slot: ExecutorSlotSnapshot,
  options: OpenCodeExecutorOptions = {},
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
      const startedAt = now();
      const stdoutArtifactId = `artifact_${createId()}`;
      const stderrArtifactId = `artifact_${createId()}`;
      const noteArtifactId = `artifact_${createId()}`;
      const metadataArtifactId = `artifact_${createId()}`;
      const managedWorkspaceLease: RuntimeWorkspaceLease | null =
        options.workspaceDir && options.artifactsRootDir
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
      const artifactsRootDir =
        options.artifactsRootDir ??
        join(
          managedWorkspaceLease?.artifactsBaseDir ??
            join(process.cwd(), ".magister", "executor-artifacts", context.runtime.id),
          `session_${context.runtime.id}`,
        );
      const commandPath =
        context.slot.commandPath?.trim() ||
        process.env.MAGISTER_OPENCODE_BIN?.trim() ||
        "opencode";
      const timeoutMs = context.slot.timeoutMs ?? options.timeoutMs ?? DEFAULT_OPENCODE_TIMEOUT_MS;
      const killGraceMs = options.killGraceMs ?? 2_000;
      const runOpenCode = options.runCommand ?? runOpenCodeCommand;

      try {
        await mkdir(artifactsRootDir, { recursive: true });

        const runtimeContextBundle = await buildRuntimeContextDocument({
          task: context.task,
          runtime: context.runtime,
        });
        const runtimeContextJsonPath = join(artifactsRootDir, "runtime-context.json");
        const runtimeContextMarkdownPath = join(artifactsRootDir, "runtime-context.md");
        const runtimeContextArtifactId = `artifact_${createId()}`;
        let runtimeContractPath: string | null = null;

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
            summary: `Captured runtime context document for the ${context.runtime.roleId} run`,
            createdAt: startedAt,
          } satisfies ArtifactInsert);

          const runtimeContract = await writeRuntimeContract({
            workspaceDir,
            runId: context.runtime.id,
            taskId: context.task.id,
            roleId: context.runtime.roleId,
            runtimeContextJsonPath,
            runtimeContextMarkdownPath,
            runtimeContext: runtimeContextBundle.document,
            managerDecisionSummary: runtimeContextBundle.summary,
          });
          runtimeContractPath = runtimeContract.filePath;
        }

        const prompt = buildOpenCodePrompt({
          context,
          runtimeWorkspaceDir: workspaceDir,
          runtimeContractPath,
        });
        const runtimeTmpDir = join(artifactsRootDir, "tmp");
        const runtimeHomeDir = join(artifactsRootDir, "opencode-home");
        await mkdir(runtimeTmpDir, { recursive: true });
        const openCodeRuntimeEnv = buildRuntimeEnv({
          baseEnv: process.env,
          userEnv: {
            CI: process.env.CI || "1",
          },
          runtimeSource: "opencode",
          runtimeHomeDir,
          runtimeTmpDir,
        });
        const invocation = {
          ...buildOpenCodeInvocation({
            workspaceDir,
            prompt,
            configuredModel,
            commandPath,
            timeoutMs,
            killGraceMs,
          }),
          env: openCodeRuntimeEnv.env,
        };
        const formattedCommand = formatCommand(invocation.command, invocation.args);
        const runtimeWorkspaceStrategy = managedWorkspaceLease?.strategy ?? "workspace_root";
        const runtimeWorkspaceBaseDir = managedWorkspaceLease?.baseWorkspaceDir ?? process.cwd();
        const sandboxPlan = prepareExecutionSandboxCommand({
          command: invocation.command,
          args: invocation.args,
          cwd: invocation.cwd,
          env: invocation.env ?? openCodeRuntimeEnv.env,
          // opencode runs its own permission-prompted sandbox internally.
          // Wrapping it in Magister's outer bwrap nests sandboxes and
          // the inner one can't acquire mount() — same failure mode as
          // codex. Force mode=off; mirrors cli-agent-spawn-service.ts.
          executionSandbox: await assessExecutionSandbox({
            runtimeSource: "opencode",
            runtimeWorkspaceDir: workspaceDir,
            baseWorkspaceDir: runtimeWorkspaceBaseDir,
            runtimeHomeDir,
            runtimeTmpDir,
            homeIsolated: openCodeRuntimeEnv.env.HOME === runtimeHomeDir,
            config: { mode: "off" },
          }),
          baseWorkspaceDir: runtimeWorkspaceBaseDir,
          runtimeWorkspaceDir: workspaceDir,
          runtimeHomeDir,
          runtimeTmpDir,
        });
        const runtimeSecurity = buildOpenCodeRuntimeSecurity({
          commandPath: invocation.command,
          args: invocation.args,
          sandboxMode: context.slot.sandboxMode,
          envPermissionHints: openCodeRuntimeEnv.permissionHints,
          runtimeWorkspaceStrategy,
          executionSandbox: sandboxPlan.executionSandbox,
        });

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "RUNNING",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: context.runtime.currentSessionId ?? null,
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
            workspaceId: context.task.workspaceId,
            severity: "info",
            occurredAt: startedAt,
            payloadJson: JSON.stringify({
              message: `OpenCode started the ${context.runtime.roleId} run`,
              source: context.slot.adapterId,
              configuredModel,
              command: formattedCommand,
              runtimeSecurity,
              artifactsRootDir,
              timeoutMs,
              runtimeWorkspaceStrategy,
              runtimeWorkspaceDir: workspaceDir,
              runtimeWorkspaceBaseDir,
              resumePolicy: context.runtime.resumePolicy ?? null,
              priorSessionId: context.runtime.priorSessionId ?? null,
              priorWorkdir: context.runtime.priorWorkdir ?? null,
              nativeResumeAttempted: false,
            }),
          }),
        );

        let commandResult: OpenCodeCommandResult;
        if (sandboxPlan.type === "failed") {
          commandResult = {
            exitCode: 1,
            stdout: "",
            stderr: sandboxPlan.failureReason,
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
            commandResult = await runOpenCode(executableInvocation);
          } catch (error) {
            commandResult = {
              exitCode: 1,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
              durationMs: 0,
              invocationError: error instanceof Error ? error.message : String(error),
            };
          }
        }

        const parsedOutput = parseOpenCodeOutput(commandResult.stdout);
        const parsedToolEvents = extractExplicitToolEventsFromJsonLines(commandResult.stdout);
        const sessionId = parsedOutput.sessionId ?? `session_${context.runtime.id}`;
        const completedAt = now();
        const stdoutArtifactAt = completedAt;
        const stderrArtifactAt = new Date(completedAt.getTime() + 1);
        const metadataArtifactAt = new Date(completedAt.getTime() + 2);
        const noteArtifactAt = new Date(completedAt.getTime() + 3);
        const stdoutPath = join(artifactsRootDir, "stdout.jsonl");
        const stderrPath = join(artifactsRootDir, "stderr.log");
        const notePath = join(artifactsRootDir, "last-message.md");
        const metadataPath = join(artifactsRootDir, "session.json");

        await materializeArtifact(context, {
          artifactId: stdoutArtifactId,
          artifactType: "execution_log",
          title: "OpenCode stdout log",
          summary: `Captured OpenCode stdout for the ${context.runtime.roleId} run`,
          filePath: stdoutPath,
          contents: commandResult.stdout,
          createdAt: stdoutArtifactAt,
        });

        await materializeArtifact(context, {
          artifactId: stderrArtifactId,
          artifactType: "execution_log",
          title: "OpenCode stderr log",
          summary: `Captured OpenCode stderr for the ${context.runtime.roleId} run`,
          filePath: stderrPath,
          contents: commandResult.stderr,
          createdAt: stderrArtifactAt,
        });

        const artifactDescriptor = getArtifactDescriptor(context.runtime.roleId);
        const noteSummarySource =
          parsedOutput.assistantMessage ||
          commandResult.stderr.trim() ||
          commandResult.stdout.trim() ||
          `OpenCode completed the ${context.runtime.roleId} run.`;

        await materializeArtifact(context, {
          artifactId: noteArtifactId,
          artifactType: artifactDescriptor.artifactType,
          title: artifactDescriptor.title,
          summary: summarizeText(noteSummarySource),
          filePath: notePath,
          contents: noteSummarySource,
          createdAt: noteArtifactAt,
        });

        await materializeArtifact(context, {
          artifactId: metadataArtifactId,
          artifactType: "execution_metadata",
          title: "OpenCode session metadata",
          summary: `Captured OpenCode session metadata for the ${context.runtime.roleId} run`,
          filePath: metadataPath,
          contents: JSON.stringify(
            {
              adapterId: context.slot.adapterId,
              configuredModel,
              roleId: context.runtime.roleId,
              runId: context.runtime.id,
              taskId: context.task.id,
              workspaceId: context.task.workspaceId,
              workspaceDir,
              artifactsRootDir,
              sessionId,
              command: formattedCommand,
              runtimeSecurity,
              timeoutMs,
              durationMs: commandResult.durationMs ?? 0,
              exitCode: commandResult.exitCode,
              timedOut: commandResult.timedOut ?? false,
              signal: commandResult.signal ?? null,
              priorSessionId: context.runtime.priorSessionId ?? null,
              priorWorkdir: context.runtime.priorWorkdir ?? null,
              resumePolicy: context.runtime.resumePolicy ?? null,
              nativeResumeAttempted: false,
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
          createdAt: metadataArtifactAt,
        });

        await recordParsedToolEvents(context, parsedToolEvents, completedAt);

        const observedSideEffectEventTypes = parsedToolEvents.map((event) => event.type);
        const mcpToolRisk = await buildMcpToolRisk(parsedToolEvents);
        const diffArtifact = await collectRuntimeDiff({
          workspaceDir,
          artifactsDir: artifactsRootDir,
          artifactId: `artifact_${createId()}`,
          ...(managedWorkspaceLease?.baseRevision !== undefined
            ? { baseRevision: managedWorkspaceLease.baseRevision }
            : {}),
        });
        const sastAdvisory = await runSastAdvisory({
          workspaceDir,
          diffArtifact,
        });
        const gate = await classifyStaticGate({
          runtimeSecurity,
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
          runtimeSecurity,
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

        if (commandResult.exitCode === 0) {
          await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
            state: "COMPLETED",
            currentSessionId: sessionId,
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
                lastMessage: noteSummarySource,
                readableMessage: noteSummarySource,
                source: context.slot.adapterId,
                configuredModel,
                command: formattedCommand,
                durationMs: commandResult.durationMs ?? 0,
                metadataArtifactId,
                stdoutPreview: summarizeText(commandResult.stdout, 280),
                stderrPreview: summarizeText(commandResult.stderr, 280),
                nativeResumeAttempted: false,
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

        const failure = classifyOpenCodeFailure(context, commandResult);

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          currentSessionId: sessionId,
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
              error:
                summarizeText(commandResult.stderr, 600) ||
                commandResult.invocationError ||
                failure.message,
              reason: failure.code,
              failureCode: failure.code,
              errorCategory: failure.category,
              source: context.slot.adapterId,
              configuredModel,
              command: formattedCommand,
              durationMs: commandResult.durationMs ?? 0,
              metadataArtifactId,
              suggestion: failure.suggestion,
              nativeResumeAttempted: false,
            }),
          }),
        );

        return {
          ok: false,
          runId: context.runtime.id,
          adapterId: context.slot.adapterId,
          state: "FAILED",
          code: failure.code,
          message: failure.message,
        };
      } finally {
        if (managedWorkspaceLease) {
          await finalizeRuntimeWorkspace({
            metadataPath: managedWorkspaceLease.metadataPath,
            status: runtimeWorkspaceStatus,
          });
        }
      }
    },
  };
}
