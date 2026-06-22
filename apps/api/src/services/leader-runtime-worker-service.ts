import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { getMagisterEnv } from "../lib/env";
import type {
  LeaderLoopEvent,
  LeaderMessage,
  LeaderModelCallParams,
  LeaderModelOutputEvent,
  LeaderTool,
  LeaderToolUseContext,
  MessageUpdate,
  ToolUseBlock,
} from "./manager-automation/autonomous-loop/autonomous-types";
import type { ExecutionPolicy } from "./leader-execution-policy-service";
import type { DoomLoopSnapshot } from "./manager-automation/autonomous-loop/doom-loop-detector";
import { createEventProjector } from "./leader-event-projector";
import { LeaderSessionStore } from "./leader-session-store";
import type {
  LeaderRuntimeApiConfig,
  LeaderRuntimeConfig,
  LeaderRuntimeCheckpoint,
  LeaderRuntimeModelConfig,
  LeaderRuntimeResult,
} from "./manager-automation/autonomous-loop/manager-autonomous-runtime";
import { callStreamingApi, type StreamingApiCallerConfig } from "./manager-automation/autonomous-loop/streaming-api-caller";
import { runToolUse } from "./manager-automation/autonomous-loop/tool-execution";
import { findToolByName } from "./manager-automation/autonomous-loop/tool-registry";
import {
  assessExecutionSandbox,
  prepareExecutionSandboxCommand,
  resolveExecutionSandboxConfig,
} from "./safe-apply/execution-sandbox-service";
import type {
  LeaderWorkerProcessStatus,
  LeaderWorkerSandboxStatus,
} from "./leader-hardening-status-service";

export type LeaderWorkerMode = "off" | "optional" | "required";

export type SerializableLeaderRuntimeConfig = Omit<
  LeaderRuntimeConfig,
  | "abortController"
  | "observeEvent"
  | "requestApproval"
  | "recordEvent"
  | "writeCheckpoint"
  | "apiConfig"
  | "modelRuntime"
  | "callModel"
  | "tools"
  | "maxTurns"
  | "tavilyConfig"
> & {
  modelRuntime: LeaderRuntimeModelConfig;
  toolDescriptors?: SerializableLeaderToolDescriptor[];
  maxTurns?: number;
};

export type SerializableLeaderToolDescriptor = {
  name: string;
  aliases?: string[];
  description?: string;
  inputJsonSchemaOverride?: Record<string, unknown>;
  concurrencySafe?: boolean;
  readOnly?: boolean;
  planSafe?: boolean;
};

export type SerializableLeaderModelCallParams = {
  messages: LeaderModelCallParams["messages"];
  systemPrompt: string;
  model?: string;
  maxOutputTokens?: number;
  tools: SerializableLeaderToolDescriptor[];
};

export type SerializableExecuteToolParams = {
  toolUse: ToolUseBlock;
  context: {
    messages: LeaderMessage[];
    inPlanMode?: boolean;
    alreadyAwaitingApproval?: boolean;
    planApprovedThisRun?: boolean;
    turnIndex?: number;
    currentToolUseId?: string;
    /** Execution policy threaded from the worker's toolUseContext so the parent-side
     *  tool-proxy gate also enforces the policy when executing proxied tools. */
    executionPolicy?: ExecutionPolicy;
  };
};

export type SerializableExecuteToolResult = {
  updates: MessageUpdate[];
  events: LeaderLoopEvent[];
};

type LeaderWorkerOutputMessage =
  | {
      type: "rpc.request";
      id: string;
      method: "record_event" | "checkpoint" | string;
      params: unknown;
    }
  | { type: "result"; result: LeaderRuntimeResult }
  | { type: "error"; message: string };

type ParentRpcResponse =
  | { type: "rpc.response"; id: string; ok: true; result?: unknown }
  | { type: "rpc.response"; id: string; ok: false; error: { message: string; code?: string } };

type RunLeaderRuntimeInWorkerInput = {
  config: SerializableLeaderRuntimeConfig;
  apiConfig?: LeaderRuntimeApiConfig;
  callModel?: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>;
  tools?: readonly LeaderTool[];
  requestApproval?: LeaderRuntimeConfig["requestApproval"];
  observeEvent?: (event: LeaderLoopEvent) => void | Promise<void>;
  signal?: AbortSignal;
  workerCommand?: string;
  workerArgs?: string[];
  env?: NodeJS.ProcessEnv;
  observeWorkerProcessState?: (state: LeaderWorkerProcessStatus) => void | Promise<void>;
  observeWorkerSandboxState?: (state: LeaderWorkerSandboxStatus) => void | Promise<void>;
  maxStdoutLineBytes?: number;
  maxInFlightRpcRequests?: number;
};

const DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_WORKER_RPCS = 64;
const MAX_WORKER_RPC_ID_LENGTH = 128;
const WORKER_RPC_ID_PATTERN = /^[a-zA-Z0-9_:-]+$/;

const LEADER_WORKER_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "MAGISTER_WORKSPACE_PATH_MAP",
  "MAGISTER_AGENTS_HOME",
  "MAGISTER_BUILTIN_SKILLS_DIR",
  "MAGISTER_CODEX_HOME_SEED",
  "MAGISTER_CODEX_BIN",
  "MAGISTER_OPENCODE_BIN",
  "MAGISTER_TOOL_DENYLIST",
  "MAGISTER_LEADER_AUTOCOMPACT_THRESHOLD",
  "MAGISTER_LEADER_AUTOCOMPACT_RATIO",
  "MAGISTER_LEADER_PRESERVE_TAIL_TOKENS",
  // Worker calls initMemoryRuntime() at startup using these two anchors.
  // Worker cwd is the task workspace dir (not the install dir), so
  // MAGISTER_INSTALL_DIR is the only way the worker can find Magister's
  // own .magister/memory path. Without these the worker falls back to
  // its own cwd, writing project memory into the task's workspace.
  "MAGISTER_INSTALL_DIR",
  "MAGISTER_MEMORY_USER_DIR",
  // Execution-policy enforcement level: the worker's tool-execution gate reads
  // getEnforcementLevel(process.env) at each tool call. Without this var the
  // worker always defaults to "observe" and never blocks — a silent downgrade
  // that defeats enforcement in review_only / delegated_coding / strict modes.
  "MAGISTER_LEADER_EXECUTION_POLICY_ENFORCEMENT",
] as const;

const VALID_LEADER_WORKER_MODES = new Set<LeaderWorkerMode>(["off", "optional", "required"]);

export function resolveLeaderWorkerMode(env: NodeJS.ProcessEnv = process.env): LeaderWorkerMode {
  const normalized = getMagisterEnv("MAGISTER_LEADER_WORKER_MODE", env)?.trim().toLowerCase();
  return normalized && VALID_LEADER_WORKER_MODES.has(normalized as LeaderWorkerMode)
    ? normalized as LeaderWorkerMode
    : "off";
}

export function buildLeaderWorkerEnv(input: {
  homeDir: string;
  tmpDir: string;
  baseEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of LEADER_WORKER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.HOME = input.homeDir;
  env.TMPDIR = input.tmpDir;
  env.TMP = input.tmpDir;
  env.TEMP = input.tmpDir;
  env.MAGISTER_LEADER_WORKER_CHILD = "1";

  // Keep the worker's HOME isolated while preserving non-secret path
  // configuration that the leader runtime depends on for skills and
  // Codex CLI home seeding. Raw secret values still stay out of env.
  if (!env.MAGISTER_AGENTS_HOME) {
    env.MAGISTER_AGENTS_HOME = join(homedir(), ".agents");
  }
  if (!env.MAGISTER_CODEX_HOME_SEED) {
    const codexSeed =
      source.MAGISTER_CODEX_HOME_SEED?.trim()
      || source.CODEX_HOME?.trim()
      || source.MAGISTER_CODEX_HOME?.trim()
      || join(homedir(), ".codex");
    if (codexSeed) {
      env.MAGISTER_CODEX_HOME_SEED = codexSeed;
    }
  }
  return env;
}

export function serializeLeaderToolDescriptor(tool: LeaderTool): SerializableLeaderToolDescriptor {
  return {
    name: tool.name,
    ...(tool.aliases ? { aliases: tool.aliases } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputJsonSchemaOverride: serializeToolInputSchema(tool),
    concurrencySafe: readStaticToolBoolean(() => tool.isConcurrencySafe({})),
    readOnly: readStaticToolBoolean(() => tool.isReadOnly({})),
    ...(tool.isPlanSafe
      ? { planSafe: readStaticToolBoolean(() => tool.isPlanSafe?.({}) ?? false) }
      : {}),
  };
}

function serializeToolInputSchema(tool: LeaderTool): Record<string, unknown> {
  if (tool.inputJsonSchemaOverride) {
    return tool.inputJsonSchemaOverride;
  }
  try {
    const jsonSchema = z.toJSONSchema(tool.inputSchema);
    const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
    return rest;
  } catch {
    return { type: "object", properties: {} };
  }
}

function readStaticToolBoolean(fn: () => boolean): boolean {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
}

function leaderWorkerFailure(message: string): LeaderRuntimeResult {
  return {
    reason: "model_error",
    turnCount: 0,
    messages: [
      {
        type: "assistant",
        content: [{ type: "text", text: `Leader worker failed: ${message}` }],
      },
    ],
  };
}

async function cleanupLeaderWorkerRuntimeDirs(
  runtimeHomeDir: string,
  runtimeTmpDir: string,
): Promise<void> {
  await Promise.allSettled([
    rm(runtimeHomeDir, { recursive: true, force: true }),
    rm(runtimeTmpDir, { recursive: true, force: true }),
  ]);
}

async function observeWorkerSandboxState(
  input: RunLeaderRuntimeInWorkerInput,
  state: LeaderWorkerSandboxStatus,
): Promise<void> {
  if (!input.observeWorkerSandboxState) return;
  try {
    await input.observeWorkerSandboxState(state);
  } catch (err) {
    console.warn(
      "[leader-worker] observeWorkerSandboxState failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function observeWorkerProcessState(
  input: RunLeaderRuntimeInWorkerInput,
  state: LeaderWorkerProcessStatus,
): Promise<void> {
  if (!input.observeWorkerProcessState) return;
  try {
    await input.observeWorkerProcessState(state);
  } catch (err) {
    console.warn(
      "[leader-worker] observeWorkerProcessState failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runLeaderRuntimeInWorker(
  input: RunLeaderRuntimeInWorkerInput,
): Promise<LeaderRuntimeResult> {
  const runtimeHomeDir = await mkdtemp(join(tmpdir(), "magister-leader-worker-home-"));
  const runtimeTmpDir = await mkdtemp(join(tmpdir(), "magister-leader-worker-tmp-"));
  const rpcResponseDir = join(runtimeTmpDir, "rpc-responses");
  await mkdir(rpcResponseDir, { recursive: true });
  const inputPath = join(runtimeTmpDir, "leader-runtime-input.json");
  const parentTools = input.tools ? [...input.tools] : [];
  const toolDescriptors = parentTools.length > 0
    ? parentTools.map(serializeLeaderToolDescriptor)
    : input.config.toolDescriptors;
  const workerConfig: SerializableLeaderRuntimeConfig = {
    ...input.config,
    ...(toolDescriptors ? { toolDescriptors } : {}),
  };
  await writeFile(inputPath, JSON.stringify(workerConfig), "utf8");
  const command = input.workerCommand ?? process.execPath;
  const args = [
    ...(input.workerArgs ?? [fileURLToPath(new URL("../workers/leader-runtime-worker.ts", import.meta.url))]),
    inputPath,
  ];
  const env = buildLeaderWorkerEnv({
    homeDir: runtimeHomeDir,
    tmpDir: runtimeTmpDir,
    ...(input.env ? { baseEnv: input.env } : {}),
  });
  let spawnCommand = command;
  let spawnArgs = args;
  let spawnCwd = workerConfig.workspaceDir;
  let spawnEnv = env;
  const sandboxConfig = resolveExecutionSandboxConfig(input.env ?? process.env);
  if (sandboxConfig.mode === "off") {
    await observeWorkerSandboxState(input, {
      status: "not_requested",
      provider: "none",
      network: sandboxConfig.network === "disabled" ? "disabled" : "host",
    });
  } else {
    if (!workerConfig.baseWorkspaceDir) {
      const state: LeaderWorkerSandboxStatus = {
        status: sandboxConfig.mode === "required" ? "failed" : "fallback",
        provider: sandboxConfig.provider === "bubblewrap" || sandboxConfig.provider === "auto"
          ? "bubblewrap"
          : "none",
        network: sandboxConfig.network === "disabled" ? "disabled" : "host",
        failureReason: "base_workspace_unavailable",
      };
      await observeWorkerSandboxState(input, state);
      if (sandboxConfig.mode === "required") {
        await observeWorkerProcessState(input, {
          status: "failed",
          failureReason: "base_workspace_unavailable",
        });
        await cleanupLeaderWorkerRuntimeDirs(runtimeHomeDir, runtimeTmpDir);
        return leaderWorkerFailure("Execution sandbox required but not active: base_workspace_unavailable");
      }
    } else {
      const executionSandbox = await assessExecutionSandbox({
        runtimeSource: "ucm",
        runtimeWorkspaceDir: workerConfig.workspaceDir,
        baseWorkspaceDir: workerConfig.baseWorkspaceDir,
        runtimeHomeDir,
        runtimeTmpDir,
        homeIsolated: true,
        config: {
          ...sandboxConfig,
          ...(input.env ? { env: input.env } : {}),
        },
      });
      const sandboxPlan = prepareExecutionSandboxCommand({
        command,
        args,
        cwd: workerConfig.workspaceDir,
        env,
        executionSandbox,
        baseWorkspaceDir: workerConfig.baseWorkspaceDir,
        runtimeWorkspaceDir: workerConfig.workspaceDir,
        runtimeHomeDir,
        runtimeTmpDir,
      });
      if (sandboxPlan.type === "failed") {
        await observeWorkerSandboxState(input, {
          status: "failed",
          provider: sandboxPlan.executionSandbox?.provider === "bubblewrap" ? "bubblewrap" : "unknown",
          network: sandboxPlan.executionSandbox?.network === "disabled" ? "disabled" : "host",
          failureReason: sandboxPlan.failureReason,
        });
        await observeWorkerProcessState(input, {
          status: "failed",
          failureReason: sandboxPlan.failureReason,
        });
        await cleanupLeaderWorkerRuntimeDirs(runtimeHomeDir, runtimeTmpDir);
        return leaderWorkerFailure(sandboxPlan.failureReason);
      }
      await observeWorkerSandboxState(input, {
        status: sandboxPlan.type === "wrapped" ? "active" : "fallback",
        provider: sandboxPlan.executionSandbox?.provider === "bubblewrap" ? "bubblewrap" : "unknown",
        network: sandboxPlan.executionSandbox?.network === "disabled" ? "disabled" : "host",
        ...(sandboxPlan.type === "unwrapped" && sandboxPlan.executionSandbox?.reason
          ? { failureReason: sandboxPlan.executionSandbox.reason }
          : {}),
      });
      spawnCommand = sandboxPlan.command;
      spawnArgs = sandboxPlan.args;
      spawnCwd = sandboxPlan.cwd;
      spawnEnv = sandboxPlan.env;
    }
  }
  const maxStdoutLineBytes = input.maxStdoutLineBytes ?? DEFAULT_MAX_WORKER_STDOUT_LINE_BYTES;
  const maxInFlightRpcRequests = input.maxInFlightRpcRequests ?? DEFAULT_MAX_IN_FLIGHT_WORKER_RPCS;
  const projectEvent = createEventProjector({
    taskId: workerConfig.taskId,
    runId: workerConfig.runId,
    requestId: workerConfig.requestId,
    ...(workerConfig.channelBindingId !== undefined
      ? { channelBindingId: workerConfig.channelBindingId }
      : {}),
    agentRole: "leader",
    agentName: "Leader",
    agentDepth: 0,
  });
  const sessionStore = new LeaderSessionStore();
  const parentAbortSignal = input.signal ?? new AbortController().signal;

  return await new Promise<LeaderRuntimeResult>((resolve) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: spawnCwd,
      env: spawnEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    void observeWorkerProcessState(input, { status: "active" });

    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let abortTermTimer: ReturnType<typeof setTimeout> | null = null;
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
    let finishKillTimer: ReturnType<typeof setTimeout> | null = null;
    const eventObserverPromises: Promise<void>[] = [];
    const inFlightRpcIds = new Set<string>();

    const cleanup = async () => {
      input.signal?.removeEventListener("abort", onAbort);
      if (abortTermTimer) clearTimeout(abortTermTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      await Promise.allSettled([
        rm(runtimeHomeDir, { recursive: true, force: true }),
        rm(runtimeTmpDir, { recursive: true, force: true }),
      ]);
    };

    const finish = (result: LeaderRuntimeResult) => {
      if (settled) return;
      settled = true;
      requestWorkerShutdownAfterFinish();
      void cleanup();
      resolve(result);
    };

    const finishError = (message: string) => {
      void finishAfterEvents({
        reason: "model_error",
        turnCount: 0,
        messages: [
          {
            type: "assistant",
            content: [{ type: "text", text: `Leader worker failed: ${message}` }],
          },
        ],
      });
    };

    function killGroup(sig: NodeJS.Signals): void {
      const pid = child.pid;
      if (typeof pid !== "number") return;
      try {
        process.kill(-pid, sig);
      } catch {
        // Best effort; the worker may have exited between the timer and signal.
      }
    }

    function clearFinishKillTimer(): void {
      if (!finishKillTimer) return;
      clearTimeout(finishKillTimer);
      finishKillTimer = null;
    }

    function requestWorkerShutdownAfterFinish(): void {
      const pid = child.pid;
      if (typeof pid !== "number") return;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The worker may already have exited after emitting its result.
        }
      }

      finishKillTimer = setTimeout(() => {
        finishKillTimer = null;
        killGroup("SIGKILL");
      }, 500);
      finishKillTimer.unref?.();
    }

    function onAbort(): void {
      if (settled) return;
      const pid = child.pid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Close/error handlers will resolve if the worker already exited.
        }
      }
      abortTermTimer = setTimeout(() => {
        killGroup("SIGTERM");
      }, 1500);
      abortKillTimer = setTimeout(() => {
        killGroup("SIGKILL");
      }, 3000);
    }

    function failProtocol(message: string): void {
      void observeWorkerProcessState(input, {
        status: "failed",
        failureReason: message,
      });
      killGroup("SIGKILL");
      finishError(message);
    }

    async function writeWorkerRpcResponse(response: ParentRpcResponse): Promise<void> {
      if (!isValidWorkerRpcId(response.id)) {
        failProtocol(`invalid worker rpc id: ${response.id}`);
        return;
      }
      await writeFile(
        join(rpcResponseDir, `${response.id}.json`),
        JSON.stringify(response),
        "utf8",
      );
    }

    async function writeWorkerRpcStreamEvent(
      id: string,
      index: number,
      event: LeaderModelOutputEvent,
    ): Promise<void> {
      if (!isValidWorkerRpcId(id)) {
        failProtocol(`invalid worker rpc id: ${id}`);
        return;
      }
      const streamDir = join(rpcResponseDir, `${id}.events`);
      await mkdir(streamDir, { recursive: true });
      await writeFile(
        join(streamDir, `${index}.json`),
        JSON.stringify({ type: "rpc.stream_event", id, index, event }),
        "utf8",
      );
    }

    async function safeWriteWorkerRpcResponse(response: ParentRpcResponse): Promise<void> {
      try {
        await writeWorkerRpcResponse(response);
      } catch (error) {
        failProtocol(
          `failed to write worker rpc response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    async function recordWorkerEvent(event: LeaderLoopEvent): Promise<void> {
      observeWorkerEvent(event);
      await projectEvent(event);
    }

    async function writeWorkerCheckpoint(data: LeaderRuntimeCheckpoint): Promise<void> {
      await sessionStore.writeCheckpoint({
        sessionId: data.sessionId,
        taskId: input.config.taskId,
        runId: input.config.runId,
        requestId: input.config.requestId,
        turnCount: data.turnCount,
        messages: data.messages,
        ...(data.executionPolicy !== undefined ? { executionPolicy: data.executionPolicy } : {}),
        ...(data.doomState !== undefined ? { doomState: data.doomState } : {}),
        ...(data.terminal ? { terminal: true } : {}),
      });
    }

    function parseRecordEventParams(params: unknown): LeaderLoopEvent {
      if (!params || typeof params !== "object" || !("event" in params)) {
        throw new Error("record_event params must include event");
      }
      return (params as { event: LeaderLoopEvent }).event;
    }

    function parseCheckpointParams(params: unknown): LeaderRuntimeCheckpoint {
      if (!params || typeof params !== "object") {
        throw new Error("checkpoint params must be an object");
      }
      const candidate = params as Partial<LeaderRuntimeCheckpoint>;
      if (
        typeof candidate.sessionId !== "string"
        || typeof candidate.turnCount !== "number"
        || !Array.isArray(candidate.messages)
      ) {
        throw new Error("checkpoint params must include sessionId, turnCount, and messages");
      }
      return {
        sessionId: candidate.sessionId,
        turnCount: candidate.turnCount,
        messages: candidate.messages as LeaderMessage[],
        ...(candidate.executionPolicy !== undefined
          ? { executionPolicy: candidate.executionPolicy as ExecutionPolicy }
          : {}),
        ...(candidate.doomState !== undefined
          ? { doomState: candidate.doomState as DoomLoopSnapshot }
          : {}),
        ...(candidate.terminal ? { terminal: true } : {}),
      };
    }

    function parseCallModelParams(params: unknown): SerializableLeaderModelCallParams {
      if (!params || typeof params !== "object") {
        throw new Error("call_model params must be an object");
      }
      const candidate = params as Partial<SerializableLeaderModelCallParams>;
      if (typeof candidate.systemPrompt !== "string" || !Array.isArray(candidate.messages)) {
        throw new Error("call_model params must include messages and systemPrompt");
      }
      return {
        messages: candidate.messages as LeaderModelCallParams["messages"],
        systemPrompt: candidate.systemPrompt,
        ...(typeof candidate.model === "string" && candidate.model.length > 0
          ? { model: candidate.model }
          : {}),
        ...(typeof candidate.maxOutputTokens === "number"
          ? { maxOutputTokens: candidate.maxOutputTokens }
          : {}),
        tools: Array.isArray(candidate.tools) ? candidate.tools : [],
      };
    }

    function parseExecuteToolParams(params: unknown): SerializableExecuteToolParams {
      if (!params || typeof params !== "object") {
        throw new Error("execute_tool params must be an object");
      }
      const candidate = params as Partial<SerializableExecuteToolParams>;
      if (
        !candidate.toolUse
        || typeof candidate.toolUse.id !== "string"
        || typeof candidate.toolUse.name !== "string"
        || !candidate.context
        || !Array.isArray(candidate.context.messages)
      ) {
        throw new Error("execute_tool params must include toolUse and context.messages");
      }
      return {
        toolUse: {
          id: candidate.toolUse.id,
          name: candidate.toolUse.name,
          input: candidate.toolUse.input && typeof candidate.toolUse.input === "object"
            ? candidate.toolUse.input as Record<string, unknown>
            : {},
        },
        context: {
          messages: candidate.context.messages as LeaderMessage[],
          ...(candidate.context.inPlanMode !== undefined
            ? { inPlanMode: Boolean(candidate.context.inPlanMode) }
            : {}),
          ...(candidate.context.alreadyAwaitingApproval !== undefined
            ? { alreadyAwaitingApproval: Boolean(candidate.context.alreadyAwaitingApproval) }
            : {}),
          ...(candidate.context.planApprovedThisRun !== undefined
            ? { planApprovedThisRun: Boolean(candidate.context.planApprovedThisRun) }
            : {}),
          ...(typeof candidate.context.turnIndex === "number"
            ? { turnIndex: candidate.context.turnIndex }
            : {}),
          ...(typeof candidate.context.currentToolUseId === "string"
            ? { currentToolUseId: candidate.context.currentToolUseId }
            : {}),
          ...(candidate.context.executionPolicy !== undefined
            ? { executionPolicy: candidate.context.executionPolicy as ExecutionPolicy }
            : {}),
        },
      };
    }

    function materializeToolDescriptors(
      descriptors: readonly SerializableLeaderToolDescriptor[],
    ): LeaderTool[] {
      return descriptors.map((descriptor) => ({
        name: descriptor.name,
        ...(descriptor.aliases ? { aliases: descriptor.aliases } : {}),
        ...(descriptor.description ? { description: descriptor.description } : {}),
        inputSchema: z.record(z.string(), z.unknown()),
        ...(descriptor.inputJsonSchemaOverride
          ? { inputJsonSchemaOverride: descriptor.inputJsonSchemaOverride }
          : {}),
        call: async () => {
          throw new Error(`tool ${descriptor.name} cannot execute during model conversion`);
        },
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      }));
    }

    async function* callParentModel(
      params: SerializableLeaderModelCallParams,
    ): AsyncGenerator<LeaderModelOutputEvent> {
      const callParams: LeaderModelCallParams = {
        messages: params.messages,
        systemPrompt: params.systemPrompt,
        model: params.model ?? input.config.modelRuntime.modelName,
        tools: materializeToolDescriptors(params.tools),
        signal: parentAbortSignal,
        ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
      };
      if (input.callModel) {
        yield* input.callModel(callParams);
        return;
      }
      if (!input.apiConfig) {
        throw new Error("call_model requires parent apiConfig or callModel override");
      }
      const apiCallerConfig: StreamingApiCallerConfig = {
        provider: input.apiConfig.provider,
        model: input.apiConfig.model,
        binding: input.apiConfig.binding,
        ...(input.apiConfig.fallbackProvider ? { fallbackProvider: input.apiConfig.fallbackProvider } : {}),
        ...(input.apiConfig.fallbackModelProfile ? { fallbackModelProfile: input.apiConfig.fallbackModelProfile } : {}),
      };
      yield* callStreamingApi(
        {
          messages: callParams.messages,
          systemPrompt: callParams.systemPrompt,
          model: callParams.model ?? input.config.modelRuntime.modelName,
          signal: parentAbortSignal,
          tools: callParams.tools,
          ...(callParams.maxOutputTokens ? { maxOutputTokens: callParams.maxOutputTokens } : {}),
        },
        apiCallerConfig,
      );
    }

    async function handleCallModelRpc(
      id: string,
      params: SerializableLeaderModelCallParams,
    ): Promise<{ eventCount: number }> {
      let eventCount = 0;
      for await (const event of callParentModel(params)) {
        await writeWorkerRpcStreamEvent(id, eventCount, event);
        eventCount++;
      }
      return { eventCount };
    }

    async function executeParentTool(
      params: SerializableExecuteToolParams,
    ): Promise<SerializableExecuteToolResult> {
      if (!findToolByName(parentTools, params.toolUse.name)) {
        throw new Error(`tool not allowed: ${params.toolUse.name}`);
      }
      const events: LeaderLoopEvent[] = [];
      const updates: MessageUpdate[] = [];
      const parentToolAbortController = new AbortController();
      const onParentAbort = () => {
        parentToolAbortController.abort(parentAbortSignal.reason ?? "parent_cancel");
      };
      if (parentAbortSignal.aborted) {
        onParentAbort();
      } else {
        parentAbortSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      let inProgressToolUseIDs = new Set<string>();
      const parentToolContext: LeaderToolUseContext = {
        taskId: workerConfig.taskId,
        runId: workerConfig.runId,
        requestId: workerConfig.requestId,
        workspaceDir: workerConfig.workspaceDir,
        abortController: parentToolAbortController,
        messages: params.context.messages,
        tools: parentTools,
        getInProgressToolUseIDs: () => inProgressToolUseIDs,
        setInProgressToolUseIDs: (fn) => {
          inProgressToolUseIDs = fn(inProgressToolUseIDs);
        },
        recordEvent: async (event) => {
          events.push(event);
        },
        callModel: async function* (callParams) {
          yield* callParentModel({
            messages: callParams.messages,
            systemPrompt: callParams.systemPrompt,
            ...(callParams.model ? { model: callParams.model } : {}),
            ...(callParams.maxOutputTokens ? { maxOutputTokens: callParams.maxOutputTokens } : {}),
            tools: callParams.tools.map(serializeLeaderToolDescriptor),
          });
        },
        ...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
        ...(params.context.inPlanMode !== undefined ? { inPlanMode: params.context.inPlanMode } : {}),
        ...(params.context.alreadyAwaitingApproval !== undefined
          ? { alreadyAwaitingApproval: params.context.alreadyAwaitingApproval }
          : {}),
        ...(params.context.planApprovedThisRun !== undefined
          ? { planApprovedThisRun: params.context.planApprovedThisRun }
          : {}),
        ...(params.context.turnIndex !== undefined ? { turnIndex: params.context.turnIndex } : {}),
        ...(params.context.currentToolUseId !== undefined
          ? { currentToolUseId: params.context.currentToolUseId }
          : {}),
        // Thread executionPolicy so the parent-side tool-proxy gate enforces the policy
        // for tools that the worker delegates back to the parent via RPC. Without this,
        // the parent builds a parentToolContext with no policy and the gate no-ops.
        ...(params.context.executionPolicy !== undefined
          ? { executionPolicy: params.context.executionPolicy }
          : {}),
      };

      try {
        for await (const update of runToolUse(params.toolUse, parentTools, parentToolContext)) {
          if (update.message) {
            updates.push({ message: update.message });
          }
        }
      } finally {
        parentAbortSignal.removeEventListener("abort", onParentAbort);
      }
      return { updates, events };
    }

    function handleRpcRequest(message: Extract<LeaderWorkerOutputMessage, { type: "rpc.request" }>): void {
      if (typeof message.id !== "string" || message.id.length === 0) {
        failProtocol("worker rpc request missing id");
        return;
      }
      if (!isValidWorkerRpcId(message.id)) {
        failProtocol(`invalid worker rpc id: ${message.id}`);
        return;
      }
      if (inFlightRpcIds.has(message.id)) {
        void safeWriteWorkerRpcResponse({
          type: "rpc.response",
          id: message.id,
          ok: false,
          error: { code: "duplicate_rpc_id", message: `duplicate rpc id: ${message.id}` },
        });
        return;
      }
      if (inFlightRpcIds.size >= maxInFlightRpcRequests) {
        void safeWriteWorkerRpcResponse({
          type: "rpc.response",
          id: message.id,
          ok: false,
          error: {
            code: "too_many_in_flight",
            message: `too many in-flight worker RPC requests: ${inFlightRpcIds.size}`,
          },
        });
        return;
      }
      inFlightRpcIds.add(message.id);
      void (async () => {
        try {
          if (message.method === "record_event") {
            await recordWorkerEvent(parseRecordEventParams(message.params));
          } else if (message.method === "checkpoint") {
            await writeWorkerCheckpoint(parseCheckpointParams(message.params));
          } else if (message.method === "call_model") {
            const result = await handleCallModelRpc(
              message.id,
              parseCallModelParams(message.params),
            );
            await safeWriteWorkerRpcResponse({
              type: "rpc.response",
              id: message.id,
              ok: true,
              result,
            });
            return;
          } else if (message.method === "execute_tool") {
            const result = await executeParentTool(parseExecuteToolParams(message.params));
            await safeWriteWorkerRpcResponse({
              type: "rpc.response",
              id: message.id,
              ok: true,
              result,
            });
            return;
          } else {
            throw new Error(`unknown worker rpc method: ${message.method}`);
          }
          await safeWriteWorkerRpcResponse({ type: "rpc.response", id: message.id, ok: true });
        } catch (error) {
          await safeWriteWorkerRpcResponse({
            type: "rpc.response",
            id: message.id,
            ok: false,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          inFlightRpcIds.delete(message.id);
        }
      })();
    }

    function processStdoutBuffer(): void {
      while (!settled) {
        const newlineMatch = stdoutBuffer.match(/\r?\n/);
        if (!newlineMatch || newlineMatch.index === undefined) break;
        const line = stdoutBuffer.slice(0, newlineMatch.index);
        stdoutBuffer = stdoutBuffer.slice(newlineMatch.index + newlineMatch[0].length);
        if (Buffer.byteLength(line, "utf8") > maxStdoutLineBytes) {
          failProtocol(`worker stdout line exceeded ${maxStdoutLineBytes} bytes`);
          return;
        }
        if (line.trim().length === 0) continue;
        void handleWorkerLine(line);
      }
      if (!settled && Buffer.byteLength(stdoutBuffer, "utf8") > maxStdoutLineBytes) {
        failProtocol(`worker stdout line exceeded ${maxStdoutLineBytes} bytes`);
      }
    }

    function isValidWorkerRpcId(id: string): boolean {
      return id.length <= MAX_WORKER_RPC_ID_LENGTH && WORKER_RPC_ID_PATTERN.test(id);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      processStdoutBuffer();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) {
        stderr = stderr.slice(-1024 * 1024);
      }
    });

    child.on("error", (error) => {
      void observeWorkerProcessState(input, {
        status: "failed",
        failureReason: error.message,
      });
      finishError(error.message);
    });

    child.on("exit", () => {
      clearFinishKillTimer();
    });

    child.on("close", (code) => {
      clearFinishKillTimer();
      if (!settled) {
        const message = stderr.trimEnd()
          || `worker exited before result${typeof code === "number" ? ` (code ${code})` : ""}`;
        void observeWorkerProcessState(input, {
          status: "failed",
          failureReason: message,
        });
        finishError(message);
      }
    });

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    async function finishAfterEvents(result: LeaderRuntimeResult): Promise<void> {
      if (eventObserverPromises.length > 0) {
        await Promise.allSettled(eventObserverPromises);
      }
      finish(result);
    }

    function observeWorkerEvent(event: LeaderLoopEvent): void {
      if (!input.observeEvent) return;
      const eventPromise = (async () => {
        await input.observeEvent?.(event);
      })().catch((error) => {
        stderr += `[worker event observer failed] ${error instanceof Error ? error.message : String(error)}\n`;
      });
      eventObserverPromises.push(eventPromise);
    }

    async function handleWorkerLine(line: string): Promise<void> {
      let message: LeaderWorkerOutputMessage;
      try {
        message = JSON.parse(line) as LeaderWorkerOutputMessage;
      } catch {
        stderr += `${line}\n`;
        return;
      }
      if (message.type === "rpc.request") {
        handleRpcRequest(message);
        return;
      }
      if (message.type === "result") {
        await finishAfterEvents(message.result);
        return;
      }
      if (message.type === "error") {
        finishError(message.message);
      }
    }
  });
}
