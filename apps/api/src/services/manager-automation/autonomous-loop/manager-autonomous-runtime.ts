import type {
  EmptyResponseDiagnostic,
  LeaderContentBlock,
  LeaderLoopEvent,
  LeaderMessage,
  LeaderModelCallParams,
  LeaderModelOutputEvent,
  LeaderLoopParams,
  LeaderTool,
} from "./autonomous-types";
import type { ExecutionPolicy } from "../../leader-execution-policy-service";
import type { DoomLoopSnapshot } from "./doom-loop-detector";
import type { ProviderConfig, ModelProfile, ExecutorBinding } from "../../../providers/types";
import {
  defaultOnBeforeCompact,
  leaderLoop,
} from "./autonomous-loop-service";
import { composePreCompactHooks } from "../../memory/memory-pre-compact-hook";
import { createEventProjector } from "../../leader-event-projector";
import { LeaderSessionStore } from "../../leader-session-store";
import { callStreamingApi, type StreamingApiCallerConfig } from "./streaming-api-caller";

export type LeaderRuntimeApiConfig = {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  // When the agent's fallback model lives on a different
  // provider (e.g. leader=DeepSeek anthropic, fallback=kimi-k2.6-ark
  // on volcengine-ark), this is the provider streaming-api-caller
  // should switch to when retrying with the fallback model. See
  // streaming-api-caller's StreamingApiCallerConfig.fallbackProvider
  // for why this matters.
  fallbackProvider?: ProviderConfig;
  // The fallback model's OWN ModelProfile (vision capability / output limit),
  // resolved from config so a fallback attempt doesn't inherit the primary's
  // capability assumptions. See StreamingApiCallerConfig.fallbackModelProfile
  // (PR2). When omitted, the streaming caller synthesizes one from the primary.
  fallbackModelProfile?: ModelProfile;
};

export type LeaderRuntimeModelConfig = {
  modelName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type LeaderRuntimeConfig = {
  taskId: string;
  runId: string;
  requestId: string;
  workspaceDir: string;
  systemPrompt: string;
  initialPrompt: string;
  /**
   * User attachments for the FIRST turn of this run (Phase 1:
   * images only). When present, the runtime builds the initial
   * user message as a `LeaderContentBlock[]` mixing the prompt
   * text with `{type:"image"}` blocks rather than a plain string.
   * The plugin layer (anthropic / openai-compat) translates each
   * image block to the right vendor wire format.
   */
  initialAttachmentBlocks?: LeaderContentBlock[];
  apiConfig?: LeaderRuntimeApiConfig;
  modelRuntime?: LeaderRuntimeModelConfig;
  tavilyConfig?: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  };
  baseWorkspaceDir?: string | null;
  restoredMessages?: LeaderMessage[];
  channelBindingId?: string;
  /** Resume hint — see LeaderLoopParams.initialPlanRequestId. */
  initialPlanRequestId?: string;
  /** User toggle from this turn — see LeaderLoopParams.planFirst. */
  planFirst?: boolean;
  /** Execution policy classified at intake — threaded to LeaderLoopParams so
   *  the loop emits a `leader.execution_policy_set` telemetry event and the
   *  gate (next phase) can read it. TELEMETRY-ONLY; no enforcement here. */
  executionPolicy?: ExecutionPolicy;
  /**
   * Resume: start turnCount at this value instead of 1.
   * Passed through to LeaderLoopParams.startTurnCount so the loop
   * continues counting from where the previous run left off.
   */
  startTurnCount?: number;
  /**
   * Resume: pre-hydrate the doom-loop detector from a prior run's snapshot.
   * Passed through to LeaderLoopParams.restoredDoomState.
   */
  restoredDoomState?: DoomLoopSnapshot;
  abortController: AbortController;
  requestApproval?: (request: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    message: string;
  }) => Promise<{ decision: "approve" | "reject"; feedback?: string }>;
  observeEvent?: (event: LeaderLoopEvent) => void | Promise<void>;
  recordEvent?: (event: LeaderLoopEvent) => Promise<void>;
  writeCheckpoint?: (data: LeaderRuntimeCheckpoint) => Promise<void>;
  callModel?: (params: LeaderModelCallParams) => AsyncGenerator<LeaderModelOutputEvent>;
  tools?: readonly LeaderTool[];
  maxTurns?: number;
};

export type LeaderRuntimeCheckpoint = {
  sessionId: string;
  turnCount: number;
  messages: LeaderMessage[];
  executionPolicy?: ExecutionPolicy;
  doomState?: DoomLoopSnapshot;
  terminal?: boolean;
};

export type LeaderRuntimeResult = {
  reason: string;
  turnCount: number;
  messages: LeaderMessage[];
  /** Set when the loop terminated on a turn that emitted no text and
   *  no tool_use. Surfaced so the task-intent layer can pick a
   *  diagnostic fallback message instead of the previous opaque
   *  Chinese sentence. */
  emptyResponse?: EmptyResponseDiagnostic;
};

export function buildLeaderRuntimeModelConfig(apiConfig: LeaderRuntimeApiConfig): LeaderRuntimeModelConfig {
  return {
    modelName: apiConfig.model.modelName,
    ...(apiConfig.model.contextWindow ? { contextWindow: apiConfig.model.contextWindow } : {}),
    ...(apiConfig.model.maxOutputTokens ? { maxOutputTokens: apiConfig.model.maxOutputTokens } : {}),
  };
}

function resolveLeaderRuntimeModelConfig(config: LeaderRuntimeConfig): LeaderRuntimeModelConfig {
  if (config.modelRuntime) {
    return config.modelRuntime;
  }
  if (config.apiConfig) {
    return buildLeaderRuntimeModelConfig(config.apiConfig);
  }
  throw new Error("leader runtime requires modelRuntime or apiConfig");
}

function requireLeaderRuntimeApiConfig(config: LeaderRuntimeConfig): LeaderRuntimeApiConfig {
  if (!config.apiConfig) {
    throw new Error("leader runtime model call requires parent apiConfig or callModel override");
  }
  return config.apiConfig;
}

export async function resolveLeaderRuntimeTools(input: {
  workspaceDir: string;
  tavilyConfig?: LeaderRuntimeConfig["tavilyConfig"];
  baseWorkspaceDir?: string | null;
}): Promise<{ tools: LeaderTool[]; maxTurns: number }> {
  const { listAgentProfiles } = await import("../../agent-profile-service");
  const {
    applyPerAgentToolRestrictions,
    composeSpawnTeammateDescription,
    createLeaderTools,
  } = await import("./manager-tools-adapter");
  const profiles = await listAgentProfiles();
  const leaderProfile = profiles.find((profile) => profile.roleId === "leader") ?? null;
  const spawnTeammateDescription = composeSpawnTeammateDescription(profiles);
  // Spec §1 V1.1 (2026-05-17) — leader bash always opts into the
  // sandbox. With a separate base workspace (V4B worktree mode),
  // base binds RO and runtime binds RW. Without one (leader running
  // in the user's cwd), we use the workspace itself as the writable
  // root via `allowSameWorkspace: true` so the sandbox engages
  // anyway (CRITICAL hard-block + env allowlist + /tmp isolation).
  const leaderTools = createLeaderTools(input.workspaceDir, input.tavilyConfig, undefined, {
    spawnTeammateDescription,
    callerRoleId: "leader",
    bashSandbox: input.baseWorkspaceDir
      ? { baseWorkspaceDir: input.baseWorkspaceDir }
      : { baseWorkspaceDir: input.workspaceDir, allowSameWorkspace: true },
  });
  // Merge in any registered MCP server tools. The pool is a
  // process-wide singleton; first call connects all enabled
  // servers, later calls are no-ops (already-connected clients
  // are reused). Failures are isolated per-server, so a bad
  // server doesn't block runtime startup — its `failed` status
  // surfaces via /mcp/servers for the dashboard.
  //
  // Approval flows through `pool.dispatch`: the converter
  // forwards `LeaderToolUseContext.taskId` + `abortController.signal`,
  // and the pool consults `requiresApproval(serverId)` +
  // `requestApprovalForTool` before calling the underlying MCP
  // client. No new wiring needed at this level.
  const { getMcpPool } = await import("../../mcp-pool-service");
  const mcpPool = getMcpPool();
  if (Object.keys(mcpPool.statusByServer()).length === 0) {
    await mcpPool.connectAllEnabled();
  }
  // Phase 3: filter MCP tools by per-agent attachment.
  const mcpTools = await mcpPool.listToolsForRole(leaderProfile?.roleId ?? "leader");
  const allLeaderTools = [...leaderTools, ...mcpTools];
  return {
    tools: applyPerAgentToolRestrictions(allLeaderTools, leaderProfile),
    maxTurns: typeof leaderProfile?.maxTurns === "number" ? leaderProfile.maxTurns : 60,
  };
}

export async function runLeaderRuntime(config: LeaderRuntimeConfig): Promise<LeaderRuntimeResult> {
  const modelRuntime = resolveLeaderRuntimeModelConfig(config);
  // Spec §4 — per-turn tool reload uses the same resolution path
  // that built the initial tool list, so the closure shares all
  // upstream defaults (workspaceDir / tavilyConfig / baseWorkspaceDir).
  // When the caller pinned an explicit `config.tools` array, the
  // reload callback is intentionally omitted — the loop stays on the
  // static set the caller provided (matches the legacy behavior for
  // worker-mode / synthetic test runtimes).
  const reloadToolsCallback: (() => Promise<readonly LeaderTool[]>) | undefined = config.tools
    ? undefined
    : async () => {
        const next = await resolveLeaderRuntimeTools({
          workspaceDir: config.workspaceDir,
          ...(config.tavilyConfig ? { tavilyConfig: config.tavilyConfig } : {}),
          ...(config.baseWorkspaceDir !== undefined
            ? { baseWorkspaceDir: config.baseWorkspaceDir }
            : {}),
        });
        return next.tools;
      };
  const toolSetup = config.tools
    ? { tools: [...config.tools], maxTurns: config.maxTurns ?? 60 }
    : await resolveLeaderRuntimeTools({
        workspaceDir: config.workspaceDir,
        ...(config.tavilyConfig ? { tavilyConfig: config.tavilyConfig } : {}),
        ...(config.baseWorkspaceDir !== undefined ? { baseWorkspaceDir: config.baseWorkspaceDir } : {}),
      });
  const tools = toolSetup.tools;
  const maxTurns = toolSetup.maxTurns;
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sessionStore = new LeaderSessionStore();

  const projectEvent = createEventProjector({
    taskId: config.taskId,
    runId: config.runId,
    requestId: config.requestId,
    ...(config.channelBindingId !== undefined ? { channelBindingId: config.channelBindingId } : {}),
    agentRole: "leader",
    agentName: "Leader",
    agentDepth: 0,
  });
  const recordEventFn = async (event: LeaderLoopEvent) => {
    if (config.recordEvent) {
      await config.recordEvent(event);
      return;
    }
    if (config.observeEvent) {
      try {
        await config.observeEvent(event);
      } catch (err) {
        console.warn("[leader-runtime] observeEvent failed:", err instanceof Error ? err.message : String(err));
      }
    }
    await projectEvent(event);
  };

  // First user message of THIS run. When the user uploaded
  // attachments alongside their prompt, switch from plain-string
  // content to a content-block array mixing the text + image
  // blocks. Plugin layer renders each block in the vendor's wire
  // format (Anthropic image source, OpenAI-compat image_url).
  //
  // AGENTS.md content is folded into `systemPrompt` by the caller
  // (process-task-intent-service.ts). Keeping the user message clean
  // so the chat surface doesn't render the repo-collaboration guide
  // verbatim in the user bubble.
  const initialUserText = config.initialPrompt;
  const initialUserContent =
    config.initialAttachmentBlocks && config.initialAttachmentBlocks.length > 0
      ? ([
          { type: "text", text: initialUserText },
          ...config.initialAttachmentBlocks,
        ] as LeaderContentBlock[])
      : initialUserText;
  const initialMessages: LeaderMessage[] = [
    ...(config.restoredMessages ?? []),
    {
      type: "user",
      content: initialUserContent,
      // Stamp the run's requestId so GET /tasks/:id/messages can return
      // this prompt with the requestId that triggered the run. Frontend
      // uses this to bind the prompt to the matching exchange by id
      // instead of by tail position (which slides off-by-N when one run
      // absorbs multiple mailbox prompts).
      requestId: config.requestId,
    },
  ];

  const collectedMessages: LeaderMessage[] = [];

  const callModelFn = async function* (
    callParams: LeaderModelCallParams
  ): AsyncGenerator<LeaderModelOutputEvent> {
    const model = callParams.model ?? modelRuntime.modelName;
    const maxOutputTokens = callParams.maxOutputTokens ?? modelRuntime.maxOutputTokens;
    if (config.callModel) {
      yield* config.callModel({
        ...callParams,
        model,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });
      return;
    }
    const apiConfig = requireLeaderRuntimeApiConfig(config);
    const apiCallerConfig: StreamingApiCallerConfig = {
      provider: apiConfig.provider,
      model: apiConfig.model,
      binding: apiConfig.binding,
      ...(apiConfig.fallbackProvider ? { fallbackProvider: apiConfig.fallbackProvider } : {}),
      ...(apiConfig.fallbackModelProfile ? { fallbackModelProfile: apiConfig.fallbackModelProfile } : {}),
    };
    yield* callStreamingApi(
      {
        messages: callParams.messages,
        systemPrompt: callParams.systemPrompt,
        model,
        signal: config.abortController.signal,
        tools: callParams.tools,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      },
      apiCallerConfig
    );
  };

  try {
    const params: LeaderLoopParams = {
      messages: initialMessages,
      systemPrompt: config.systemPrompt,
      workspaceDir: config.workspaceDir,
      taskId: config.taskId,
      runId: config.runId,
      requestId: config.requestId,
      tools,
      maxTurns,
      abortController: config.abortController,
      recordEvent: recordEventFn,
      callModel: callModelFn,
      sessionId,
      ...(config.requestApproval ? { requestApproval: config.requestApproval } : {}),
      // M5 Phase 3 — pre-compact memory extraction. Wrap the loop's
      // default hook so the extractor fires fire-and-forget over the
      // about-to-be-compacted message tail; the inner hook still
      // contributes its read-files ledger to the summary prompt. The
      // wrapper is leader-only (this runtime); teammates run their
      // own compaction without memory hooks (Phase 3 cross-CLI is a
      // separate piece of work per decisions doc).
      onBeforeCompact: composePreCompactHooks(defaultOnBeforeCompact),
      ...(config.initialPlanRequestId ? { initialPlanRequestId: config.initialPlanRequestId } : {}),
      ...(config.planFirst === true ? { planFirst: true } : {}),
      ...(config.executionPolicy !== undefined ? { executionPolicy: config.executionPolicy } : {}),
      ...(config.startTurnCount !== undefined ? { startTurnCount: config.startTurnCount } : {}),
      ...(config.restoredDoomState !== undefined ? { restoredDoomState: config.restoredDoomState } : {}),
      ...(modelRuntime.contextWindow ? { contextWindow: modelRuntime.contextWindow } : {}),
      ...(modelRuntime.maxOutputTokens ? { maxOutputTokens: modelRuntime.maxOutputTokens } : {}),
      ...(reloadToolsCallback ? { reloadTools: reloadToolsCallback } : {}),
      onCheckpoint: async (data) => {
        if (config.writeCheckpoint) {
          await config.writeCheckpoint({
            sessionId: data.sessionId,
            turnCount: data.turnCount,
            messages: data.messages,
            ...(data.executionPolicy !== undefined ? { executionPolicy: data.executionPolicy } : {}),
            ...(data.doomState !== undefined ? { doomState: data.doomState } : {}),
            ...(data.terminal ? { terminal: true } : {}),
          });
          return;
        }
        await sessionStore.writeCheckpoint({
          sessionId: data.sessionId,
          taskId: config.taskId,
          runId: config.runId,
          requestId: config.requestId,
          turnCount: data.turnCount,
          messages: data.messages,
          ...(data.executionPolicy !== undefined ? { executionPolicy: data.executionPolicy } : {}),
          ...(data.doomState !== undefined ? { doomState: data.doomState } : {}),
          ...(data.terminal ? { terminal: true } : {}),
        });
      },
    };

    const generator = leaderLoop(params);
    let result = await generator.next();

    while (!result.done) {
      if (result.value) {
        collectedMessages.push(result.value);
      }
      result = await generator.next();
    }

    const terminal = result.value;
    return {
      reason: terminal?.reason ?? "completed",
      turnCount: terminal?.turnCount ?? 0,
      messages: collectedMessages,
      ...(terminal?.emptyResponse ? { emptyResponse: terminal.emptyResponse } : {}),
    };
  } catch (error) {
    return {
      reason: "model_error",
      turnCount: 0,
      messages: collectedMessages,
    };
  }
}
