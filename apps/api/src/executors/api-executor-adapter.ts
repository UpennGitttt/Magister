import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactInsert, ExecutionEventInsert } from "@magister/db";

import {
  prepareAnthropicMessagesHttpRequest,
  prepareOpenAIChatCompletionsHttpRequest,
  type ExecutorBinding,
  type ModelProfile,
  type ProviderApiDialect,
  type ProviderAuthConfig,
  type ProviderConfig,
  type ProviderHeaderRule,
  type ProviderReasoningPolicy,
} from "../providers";

import type {
  ExecutorAdapter,
  ExecutorDispatchContext,
  ExecutorDispatchFailure,
  ExecutorDispatchResult,
  ExecutorSlotSnapshot,
} from "./executor-adapter";
import {
  collectSecretRefsFromHeaderRules,
  getProviderAuthSecretRefs,
  getSecretStatus,
} from "../services/local-secret-store-service";
import { buildRuntimeContextDocument } from "../services/build-runtime-context-document-service";
import { writeRuntimeContract } from "../services/runtime-contract-service";
import {
  finalizeRuntimeWorkspace,
  resolveWorkspaceBaseDir,
  type RuntimeWorkspaceLease,
} from "../services/runtime-workspace-service";
import { extractManagerDecisionOutput } from "../services/manager-decision-service";
import { getManagerCapabilityPromptLines } from "../services/manager-capability-registry-service";
import { runManagerLoop } from "../services/manager-loop-service";
import {
  coerceGroundedManagerReply,
  getManagerGroundingRequirement,
} from "../services/conversation-shortcut-service";
import { parseTavilyWebSearchConfigFromEnv } from "../services/tavily-web-search-service";
import { queueFeishuRuntimeTraceIfEnabled } from "../services/queue-feishu-runtime-trace-service";

type ApiExecutorExecutionMode = "api";

export type ApiProviderHeaderRule = {
  name: string;
  value?: string | undefined;
  secretRef?: string | undefined;
  envRef?: string | undefined;
  whenDialect?: readonly string[] | undefined;
  whenModelPattern?: readonly string[] | undefined;
};

export type ApiProviderConfig = {
  providerRef: string;
  label?: string;
  vendor?: string | undefined;
  transport: "fake" | "http";
  apiDialect?: ProviderApiDialect;
  baseUrl?: string | undefined;
  authMode?: "chatgpt" | "api_key" | "oauth_token" | "none" | undefined;
  secretRef?: string | undefined;
  auth?: ProviderAuthConfig | undefined;
  headers?: ApiProviderHeaderRule[] | Record<string, string> | undefined;
  requestOverrides?: Record<string, unknown> | undefined;
  quirks?: {
    preserveReasoningContent?: boolean;
    supportsThinkingBudget?: boolean;
    supportsThinkingClear?: boolean;
  } | undefined;
};

export type ApiModelConfig = {
  modelRef: string;
  modelName: string;
  providerRefs?: {
    api?: string;
    cli?: string;
  };
  requestOverrides?: Record<string, unknown>;
  thinking?: ProviderReasoningPolicy;
  capabilityHints?: Record<string, unknown>;
  // §5.9 — carry model limits so the dispatch transport gets the same
  // compaction budget / output cap as the in-process leader path.
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type ApiExecutorRequest = {
  providerRef: string;
  modelRef: string;
  modelName: string;
  executionMode: ApiExecutorExecutionMode;
  roleId: string;
  taskId: string;
  workspaceId: string;
  runId: string;
  prompt: string;
  metadata: Record<string, unknown>;
};

export type ApiExecutorTransportRequest = {
  provider: ApiProviderConfig;
  model: ApiModelConfig;
  request: ApiExecutorRequest;
};

export type ApiExecutorTransportResponse = {
  ok: boolean;
  status: number;
  body?: unknown;
  requestId?: string;
  message?: string;
};

export type ApiExecutorTransport = {
  execute(input: ApiExecutorTransportRequest): Promise<ApiExecutorTransportResponse>;
};

type ApiFetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ApiExecutorOptions = {
  providers?: Record<string, ApiProviderConfig>;
  models?: Record<string, ApiModelConfig>;
  transport?: ApiExecutorTransport;
  fetchImpl?: ApiFetchImpl;
  env?: NodeJS.ProcessEnv;
  artifactsRootDir?: string;
  buildRequest?: (
    context: ExecutorDispatchContext,
    provider: ApiProviderConfig,
    model: ApiModelConfig,
    options?: ApiPromptOptions,
  ) => ApiExecutorRequest;
};

export type FakeApiTransport = ApiExecutorTransport & {
  requests: ApiExecutorTransportRequest[];
};

type ApiExecutorSlotSnapshot = ExecutorSlotSnapshot & {
  providerRef?: string;
  modelRef?: string;
};

function getArtifactDescriptor(roleId: string) {
  switch (roleId) {
    case "reviewer":
      return {
        artifactType: "review",
        title: "Reviewer execution note",
      };
    case "leader":
      return {
        artifactType: "plan",
        title: "Manager execution note",
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

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summarizeText(input: string, maxLength = 160) {
  const normalized = collapseWhitespace(input);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

type StructuredReviewerResponse = {
  reviewSummary?: string;
  blockingIssues: string[];
  suggestedFixes: string[];
  verdict?: string;
};

function parseStructuredReviewerResponse(input: string): StructuredReviewerResponse {
  const sections: Record<string, string[]> = {};
  let currentSection = "";

  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const normalizedHeading = trimmed.toLowerCase();
    if (
      normalizedHeading === "review summary" ||
      normalizedHeading === "blocking issues" ||
      normalizedHeading === "suggested fixes" ||
      normalizedHeading === "verdict"
    ) {
      currentSection = normalizedHeading;
      sections[currentSection] = sections[currentSection] ?? [];
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const sectionLines = (sections[currentSection] ??= []);
    sectionLines.push(trimmed.replace(/^[-*]\s*/, ""));
  }

  return {
    ...(sections["review summary"]?.length
      ? { reviewSummary: sections["review summary"].join(" ").trim() }
      : {}),
    blockingIssues: sections["blocking issues"] ?? [],
    suggestedFixes: sections["suggested fixes"] ?? [],
    ...(sections.verdict?.length ? { verdict: sections.verdict.join(" ").trim() } : {}),
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
  await mkdir(dirname(input.filePath), { recursive: true });
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

type ApiPromptOptions = {
  runtimeContractRelativePath?: string | null;
  runtimeContextArtifactId?: string | null;
  continuityRequiresRehydration?: boolean;
  currentWallClock?: Date;
};

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
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC${sign}${offsetHours}:${offsetRemainderMinutes} (${timezone})`;
}

function buildManagerRepairPrompt(input: {
  basePrompt: string;
  invalidOutput: string;
}) {
  return [
    input.basePrompt,
    "",
    "The previous JSON output was invalid for the ManagerDecision contract.",
    "Return a corrected JSON object only.",
    "",
    "Previous invalid output:",
    input.invalidOutput,
    "",
    "Repair rules:",
    '- If you need delegated work, set decision to "spawn_work_items" and executionMode to "bounded_execution" or "long_running".',
    '- If you answer directly or ask the user a question, set executionMode to "immediate" and do not include childWorkItems.',
    '- Do not use `use_skill` in repaired output. Choose only from direct_answer, ask_user, spawn_work_items, or sleep_until.',
    "- Do not use legacy childWorkItem fields like delegateAgent, taskDescription, description, action, details, or expectedOutput.",
    "- Current workspace context is already available. Do not tell the user that you need to read runtime contracts, control-plane configuration, or project path information before answering.",
    ...getManagerCapabilityPromptLines(),
    "",
    "Return only one valid ManagerDecision JSON object.",
  ].join("\n");
}

function buildApiPrompt(
  context: ExecutorDispatchContext,
  options: ApiPromptOptions = {},
) {
  const delegationInstructions =
    context.runtime.delegationMode === "delegate_with_context"
      ? [
          "Delegation Mode: handoff",
          "You are continuing a task-manager handoff. Reuse the existing task context and carry the work forward from the prior lane.",
        ]
      : [
          "Delegation Mode: assign",
          "You are handling a fresh assignment. Solve the requested work item independently without assuming hidden upstream context.",
        ];
  const runtimeContractInstructions =
    context.runtime.roleId !== "leader" &&
    typeof options.runtimeContractRelativePath === "string" &&
    options.runtimeContractRelativePath.trim().length > 0
      ? [
          `Before acting, read the run contract at \`${options.runtimeContractRelativePath.trim()}\`.`,
          "Treat the run contract and its referenced runtime context artifacts as the control-plane source of truth.",
          ...(options.continuityRequiresRehydration
            ? [
                "Resume continuity is unavailable for this attempt. Rehydrate context from the runtime contract and runtime context artifacts before making changes.",
              ]
            : []),
        ]
      : [];

  if (context.runtime.roleId === "leader") {
    return [
      "You are the leader agent for Magister.",
      `Role: ${context.runtime.roleId}`,
      `Task ID: ${context.task.id}`,
      `Workspace ID: ${context.task.workspaceId}`,
      `Task Title: ${context.task.title ?? context.task.id}`,
      `Task Description: ${context.task.description?.trim() || context.task.title || context.task.id}`,
      `Current Task State: ${context.task.state}`,
      ...(options.currentWallClock ? [`Current Wall Clock: ${formatWallClockContext(options.currentWallClock)}`] : []),
      context.runtime.delegationMode === "delegate_with_context"
        ? "Delegation Mode: handoff"
        : "Delegation Mode: assign",
      context.runtime.delegationMode === "delegate_with_context"
        ? "You are continuing a task-manager handoff. Reuse the existing task context and carry the work forward from prior delegated execution."
        : "You are handling a fresh assignment. Interpret the request, decide the next system action, and avoid unnecessary delegation.",
      ...runtimeContractInstructions,
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
      "",
      "Return only a single valid JSON object with these top-level fields:",
      "taskType, executionMode, decision, reply, confidence, childWorkItems, waitingFor, nextWakeupAt, warnings",
    ].join("\n");
  }

  if (context.runtime.roleId === "reviewer") {
    return [
      "You are an API-backed reviewer running inside Magister.",
      `Role: ${context.runtime.roleId}`,
      `Task ID: ${context.task.id}`,
      `Workspace ID: ${context.task.workspaceId}`,
      `Task Title: ${context.task.title ?? context.task.id}`,
      `Task Description: ${context.task.description?.trim() || context.task.title || context.task.id}`,
      `Current Task State: ${context.task.state}`,
      ...delegationInstructions,
      ...runtimeContractInstructions,
      "",
      "Review the available task context and produce a structured reviewer verdict.",
      "Do not claim completion from setup or bootstrap activity alone.",
      "",
      "Return sections exactly:",
      "Review Summary",
      "Blocking Issues",
      "Suggested Fixes",
      "Verdict",
      "",
      "Verdict must be one of:",
      "- approved",
      "- needs_changes",
    ].join("\n");
  }

  return [
    "You are an API-backed executor running inside Magister.",
    `Role: ${context.runtime.roleId}`,
    `Task ID: ${context.task.id}`,
    `Workspace ID: ${context.task.workspaceId}`,
    `Task Title: ${context.task.title ?? context.task.id}`,
    `Task Description: ${context.task.description?.trim() || context.task.title || context.task.id}`,
    `Current Task State: ${context.task.state}`,
    ...delegationInstructions,
    ...runtimeContractInstructions,
    "",
    "Instructions:",
    "- Work only inside the current workspace.",
    "- Keep the response concise and execution-focused.",
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

function buildDefaultApiRequest(
  context: ExecutorDispatchContext,
  provider: ApiProviderConfig,
  model: ApiModelConfig,
  options: ApiPromptOptions = {},
): ApiExecutorRequest {
  return {
    providerRef: provider.providerRef,
    modelRef: model.modelRef,
    modelName: model.modelName,
    executionMode: "api",
    roleId: context.runtime.roleId,
    taskId: context.task.id,
    workspaceId: context.task.workspaceId,
    runId: context.runtime.id,
    prompt: buildApiPrompt(context, options),
    metadata: {
      adapterId: context.slot.adapterId,
      displayName: context.slot.displayName,
      configuredModel: context.slot.configuredModel?.trim() ?? model.modelName,
      providerTransport: provider.transport,
      providerLabel: provider.label,
      runtimeContractPath: options.runtimeContractRelativePath ?? null,
      runtimeContextArtifactId: options.runtimeContextArtifactId ?? null,
      requestOverrides: model.requestOverrides ?? {},
      thinking: model.thinking ?? null,
    },
  };
}

function collectHttpProviderReadiness(
  provider: ApiProviderConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const missing: string[] = [];

  if (!provider.baseUrl?.trim()) {
    missing.push("baseUrl");
  }

  const auth = provider.auth;
  if (!auth || auth.kind === "none") {
    missing.push("auth");
  } else {
    const authReady = getProviderAuthSecretRefs(auth).every((ref) => getSecretStatus(ref, env).ready);
    if (!authReady) {
      missing.push("auth.secretRef");
    }
  }

  if (Array.isArray(provider.headers)) {
    const headerRefs = collectSecretRefsFromHeaderRules(provider.headers);
    if (headerRefs.some((ref) => !getSecretStatus(ref, env).ready)) {
      missing.push("headers.secretRef");
    }
  }

  return [...new Set(missing)];
}

function buildProviderReadinessMessage(
  displayName: string,
  roleId: string,
  missing: string[],
) {
  const missingList = missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
  return `Configure an API provider for ${displayName} before dispatching the ${roleId} run.${missingList}`;
}

function isProviderApiDialect(value: unknown): value is ProviderApiDialect {
  return value === "openai_chat_completions" || value === "anthropic_messages";
}

function toProviderConfig(provider: ApiProviderConfig): ProviderConfig | undefined {
  if (provider.transport !== "http") {
    return undefined;
  }

  if (!provider.baseUrl) {
    return undefined;
  }

  const auth: ProviderAuthConfig | undefined =
    provider.auth ??
    (provider.authMode === "chatgpt"
      ? { kind: "chatgpt_session" }
      : provider.authMode === "api_key" && provider.secretRef
        ? { kind: "api_key", secretRef: provider.secretRef }
        : provider.authMode === "oauth_token" && provider.secretRef
          ? { kind: "oauth_token", secretRef: provider.secretRef }
          : provider.authMode === "none"
            ? { kind: "none" }
            : undefined);

  if (!auth) {
    return undefined;
  }

  const providerDialect = provider.apiDialect ?? "openai_chat_completions";
  const headerRules: ProviderHeaderRule[] = [];
  if (Array.isArray(provider.headers)) {
    for (const rule of provider.headers as ApiProviderHeaderRule[]) {
      if (!rule || typeof rule.name !== "string" || !rule.name.trim()) {
        continue;
      }

      const dialectMatches =
        !rule.whenDialect?.length ||
        rule.whenDialect.includes(providerDialect);
      if (!dialectMatches) {
        continue;
      }

      const headerRule: ProviderHeaderRule = {
        name: rule.name.trim(),
      };

      if (typeof rule.value === "string" && rule.value.trim()) {
        headerRule.value = rule.value.trim();
      }
      if (typeof rule.secretRef === "string" && rule.secretRef.trim()) {
        headerRule.secretRef = rule.secretRef.trim();
      }
      if (typeof rule.envRef === "string" && rule.envRef.trim()) {
        headerRule.envRef = rule.envRef.trim();
      }
      if (rule.whenDialect?.length) {
        const normalizedDialects = rule.whenDialect.filter((dialect) => isProviderApiDialect(dialect));
        if (normalizedDialects.length > 0) {
          headerRule.whenDialect = normalizedDialects;
        }
      }
      if (rule.whenModelPattern?.length) {
        headerRule.whenModelPattern = rule.whenModelPattern
          .map((pattern) => (typeof pattern === "string" ? pattern.trim() : ""))
          .filter((pattern) => pattern.length > 0);
      }

      headerRules.push(headerRule);
    }
  } else if (provider.headers && typeof provider.headers === "object") {
    for (const [name, value] of Object.entries(provider.headers)) {
      if (typeof value === "string" && value.trim()) {
        headerRules.push({
          name,
          value,
        });
      }
    }
  }

  return {
    id: provider.providerRef,
    ...(provider.label ? { label: provider.label } : {}),
    vendor: provider.vendor ?? provider.providerRef,
    transport: "api",
    apiDialect: providerDialect,
    baseUrl: provider.baseUrl,
    auth,
    ...(headerRules.length > 0 ? { headers: headerRules } : {}),
    ...(provider.requestOverrides ? { requestOverrides: provider.requestOverrides } : {}),
    ...(provider.quirks ? { quirks: provider.quirks } : {}),
  };
}

function toModelProfile(model: ApiModelConfig): ModelProfile {
  return {
    id: model.modelRef,
    modelName: model.modelName,
    ...(model.providerRefs ? { providerRefs: model.providerRefs } : {}),
    ...(model.requestOverrides ? { requestOverrides: model.requestOverrides } : {}),
    ...(model.thinking ? { defaultReasoning: model.thinking } : {}),
    ...(model.capabilityHints ? { capabilityHints: model.capabilityHints } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxOutputTokens === "number" ? { maxOutputTokens: model.maxOutputTokens } : {}),
  };
}

function extractOpenAIChoiceText(body: unknown): string | undefined {
  if (!isPlainObject(body) || !Array.isArray(body.choices) || body.choices.length === 0) {
    return undefined;
  }

  const firstChoice = body.choices[0];
  if (!isPlainObject(firstChoice) || !isPlainObject(firstChoice.message)) {
    return undefined;
  }

  const content = firstChoice.message.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const segments = content
    .map((part) => {
      if (typeof part === "string") {
        return part.trim();
      }
      if (isPlainObject(part) && typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter((part): part is string => part.length > 0);

  return segments.length > 0 ? segments.join("\n") : undefined;
}

function extractAnthropicContentText(body: unknown): string | undefined {
  if (!isPlainObject(body) || !Array.isArray(body.content) || body.content.length === 0) {
    return undefined;
  }

  const segments = body.content
    .map((part) => {
      if (typeof part === "string") {
        return part.trim();
      }
      if (!isPlainObject(part)) {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text.trim();
      }
      if (typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter((part): part is string => part.length > 0);

  return segments.length > 0 ? segments.join("\n") : undefined;
}

function extractAssistantMessageText(body: unknown): string | undefined {
  return (
    extractAnthropicContentText(body) ||
    extractOpenAIChoiceText(body)
  );
}

async function executeRealApiTransport(input: {
  adapterId: string;
  fetchImpl: ApiFetchImpl;
  env: NodeJS.ProcessEnv;
  provider: ApiProviderConfig;
  model: ApiModelConfig;
  request: ApiExecutorRequest;
}) {
  const providerConfig = toProviderConfig(input.provider);
  if (!providerConfig) {
    throw new Error(`Provider ${input.provider.providerRef} is missing HTTP transport configuration`);
  }

  const modelProfile = toModelProfile(input.model);
  const binding: ExecutorBinding = {
    adapterId: input.adapterId,
    executionMode: "api",
    modelRef: input.request.modelRef,
    providerRef: input.provider.providerRef,
  };
  const prepared =
    providerConfig.apiDialect === "anthropic_messages"
      ? prepareAnthropicMessagesHttpRequest({
          provider: providerConfig,
          model: modelProfile,
          binding,
          prompt: input.request.prompt,
          env: input.env,
        })
      : input.model.thinking
        ? prepareOpenAIChatCompletionsHttpRequest({
            provider: providerConfig,
            model: modelProfile,
            binding,
            prompt: input.request.prompt,
            reasoningPolicy: input.model.thinking,
            env: input.env,
          })
        : prepareOpenAIChatCompletionsHttpRequest({
            provider: providerConfig,
            model: modelProfile,
            binding,
            prompt: input.request.prompt,
            env: input.env,
          });
  const response = await input.fetchImpl(prepared.url, prepared.init);
  const responseText = await response.text().catch(() => "");
  let body: unknown = responseText;

  if (responseText.trim().length > 0) {
    try {
      body = JSON.parse(responseText);
    } catch {
      body = responseText;
    }
  }

  const requestId =
    response.headers.get("anthropic-request-id") ||
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    (isPlainObject(body) && typeof body.id === "string" ? body.id : undefined);
  const message =
    (isPlainObject(body) && typeof body.error === "object" && body.error !== null && "message" in body.error
      ? String((body.error as { message?: unknown }).message ?? "")
      : undefined) ||
    (isPlainObject(body) && typeof body.message === "string" ? body.message : undefined) ||
    extractAssistantMessageText(body) ||
    (typeof body === "string" && body.trim() ? body.trim() : undefined);

  return {
    ok: response.ok,
    status: response.status,
    body,
    ...(requestId ? { requestId } : {}),
    ...(message ? { message } : {}),
  };
}

function buildFailure(
  context: ExecutorDispatchContext,
  input: {
    code: ExecutorDispatchFailure["code"];
    message: string;
  },
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

function createFailureEvent(
  context: ExecutorDispatchContext,
  input: {
    sessionId: string;
    message: string;
    code: ExecutorDispatchFailure["code"];
    suggestion?: string;
    providerRef?: string;
    modelRef?: string;
    request?: ApiExecutorRequest;
    response?: ApiExecutorTransportResponse;
    noteArtifactId?: string;
    metadataArtifactId?: string;
  },
  occurredAt: Date,
): ExecutionEventInsert {
  return createEvent(context, {
    id: `event_${context.createId?.() ?? crypto.randomUUID()}`,
    type: "executor_session.failed",
    taskId: context.task.id,
    roleRuntimeId: context.runtime.id,
    executorSessionId: input.sessionId,
    workspaceId: context.task.workspaceId,
    severity: "error",
    occurredAt,
    payloadJson: JSON.stringify({
      message: input.message,
      error: input.message,
      reason: input.code,
      source: context.slot.adapterId,
      providerRef: input.providerRef,
      modelRef: input.modelRef,
      suggestion: input.suggestion,
      requestPreview: input.request ? summarizeText(input.request.prompt, 280) : undefined,
      responseStatus: input.response?.status,
      responseMessage: input.response?.message,
      noteArtifactId: input.noteArtifactId,
      metadataArtifactId: input.metadataArtifactId,
    }),
  });
}

function classifyTransportFailure(
  context: ExecutorDispatchContext,
  response: ApiExecutorTransportResponse,
): Pick<ExecutorDispatchFailure, "code" | "message"> & { suggestion: string } {
  const haystack = [
    response.message,
    typeof response.body === "string" ? response.body : undefined,
    JSON.stringify(response.body ?? {}),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (response.status === 401 || response.status === 403 || haystack.includes("unauthorized")) {
    return {
      code: "executor_auth_failed",
      message: `API authentication failed while dispatching the ${context.runtime.roleId} run`,
      suggestion: "Refresh the provider credentials or secret, then retry the run once readiness is healthy.",
    };
  }

  if (response.status === 503 || response.status === 502 || haystack.includes("unavailable")) {
    return {
      code: "executor_unavailable",
      message: `API transport is unavailable while dispatching the ${context.runtime.roleId} run`,
      suggestion: "Check provider health or retry later once the upstream transport is available.",
    };
  }

  return {
    code: "executor_invocation_failed",
    message: `API transport failed while dispatching the ${context.runtime.roleId} run`,
    suggestion: "Inspect the request and response metadata, then retry once the failure cause is understood.",
  };
}

export function createFakeApiTransport(options: {
  response?: ApiExecutorTransportResponse;
} = {}): FakeApiTransport {
  const requests: ApiExecutorTransportRequest[] = [];

  return {
    requests,
    async execute(input: ApiExecutorTransportRequest): Promise<ApiExecutorTransportResponse> {
      requests.push(input);
      return (
        options.response ?? {
          ok: true,
          status: 200,
          requestId: `fake-${requests.length}`,
          body: {
            message: "Fake API transport completed the run.",
          },
        }
      );
    },
  };
}

export function createApiExecutorAdapter(
  slot: ExecutorSlotSnapshot,
  options: ApiExecutorOptions = {},
): ExecutorAdapter {
  return {
    slot,
    async execute(context: ExecutorDispatchContext): Promise<ExecutorDispatchResult> {
      const apiSlot = context.slot as ApiExecutorSlotSnapshot;
      const configuredModel = apiSlot.configuredModel?.trim();
      const createId = context.createId ?? (() => crypto.randomUUID());
      const now = context.now ?? (() => new Date());
      const sessionId = `session_${createId()}`;
      const startedAt = now();
      const managedWorkspaceLease: RuntimeWorkspaceLease | null = context.runtimeWorkspace ?? null;
      let runtimeWorkspaceStatus: "completed" | "failed" = "failed";
      const workspaceBaseDir =
        managedWorkspaceLease?.baseWorkspaceDir ??
        await resolveWorkspaceBaseDir(context.task.workspaceId);
      const workspaceDir = managedWorkspaceLease?.workspaceDir ?? workspaceBaseDir;
      const artifactsRootDir =
        options.artifactsRootDir ??
        join(
          managedWorkspaceLease?.artifactsBaseDir ??
            join(workspaceBaseDir, ".magister", "executor-artifacts", context.runtime.id),
          sessionId,
        );

      try {
      if (!configuredModel) {
        const message = `Configure an API provider and model for ${apiSlot.displayName} before dispatching the ${context.runtime.roleId} run`;
        const failedAt = now();

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_unconfigured",
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_unconfigured",
          message,
        });
      }

      const modelRef = apiSlot.modelRef?.trim();
      if (!modelRef) {
        const failedAt = now();
        const message = `Configure an API model for ${apiSlot.displayName} before dispatching the ${context.runtime.roleId} run`;

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_model_missing",
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_model_missing",
          message,
        });
      }

      const providerRef = apiSlot.providerRef?.trim();
      const model = options.models?.[modelRef];
      if (!model) {
        const failedAt = now();
        const message = `Configure an API model for ${apiSlot.displayName} before dispatching the ${context.runtime.roleId} run`;

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_model_missing",
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_model_missing",
          message,
        });
      }

      const resolvedProviderRef = providerRef || model.providerRefs?.api;
      if (!resolvedProviderRef) {
        const failedAt = now();
        const message = `Configure an API provider for ${apiSlot.displayName} before dispatching the ${context.runtime.roleId} run`;

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_provider_missing",
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_provider_missing",
          message,
        });
      }

      const provider = options.providers?.[resolvedProviderRef];
      if (!provider) {
        const failedAt = now();
        const message = `Configure an API provider for ${apiSlot.displayName} before dispatching the ${context.runtime.roleId} run`;

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_provider_missing",
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_provider_missing",
          message,
        });
      }

      const httpProviderReadiness =
        provider.transport === "http"
          ? collectHttpProviderReadiness(provider, options.env ?? process.env)
          : [];
      if (httpProviderReadiness.length > 0) {
        const failedAt = now();
        const message = buildProviderReadinessMessage(
          apiSlot.displayName,
          context.runtime.roleId,
          httpProviderReadiness,
        );

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "FAILED",
          activeExecutorId: context.slot.adapterId,
          currentSessionId: null,
          delegationMode: context.runtime.delegationMode ?? "delegate_fresh",
          attemptCount: context.runtime.attemptCount + 1,
          startedAt: context.runtime.startedAt ?? failedAt,
          updatedAt: failedAt,
          completedAt: failedAt,
        });

        await context.dependencies.taskRepository.update(context.task.id, {
          state: "BLOCKED",
          updatedAt: failedAt,
        });

        await context.dependencies.observabilityAdapter.recordEvent(
          createFailureEvent(
            context,
            {
              sessionId,
              message,
              code: "executor_provider_missing",
              providerRef: provider.providerRef,
              modelRef,
            },
            failedAt,
          ),
        );

        return buildFailure(context, {
          code: "executor_provider_missing",
          message,
        });
      }

      const requestBuilder = options.buildRequest ?? buildDefaultApiRequest;
      let runtimeContractRelativePath: string | null = null;
      const shouldMaterializeRuntimeContext =
        Boolean(context.runtime.priorSessionId?.trim()) ||
        Boolean(context.runtime.priorWorkdir?.trim()) ||
        context.runtime.resumePolicy === "resume_first" ||
        context.runtime.resumePolicy === "rehydrate_only";
      let runtimeContextArtifactId: string | null = null;

      if (shouldMaterializeRuntimeContext) {
        const runtimeContextBundle = await buildRuntimeContextDocument({
          task: {
            id: context.task.id,
            workspaceId: context.task.workspaceId,
            state: context.task.state,
            ...(context.task.title ? { title: context.task.title } : {}),
            ...(context.task.description !== undefined
              ? { description: context.task.description }
              : {}),
          },
          runtime: {
            id: context.runtime.id,
            roleId: context.runtime.roleId,
            state: context.runtime.state,
            attemptCount: context.runtime.attemptCount,
            ...(context.runtime.priorSessionId !== undefined
              ? { priorSessionId: context.runtime.priorSessionId }
              : {}),
            ...(context.runtime.priorWorkdir !== undefined
              ? { priorWorkdir: context.runtime.priorWorkdir }
              : {}),
            ...(context.runtime.resumePolicy !== undefined
              ? { resumePolicy: context.runtime.resumePolicy }
              : {}),
            ...(context.runtime.delegationMode !== undefined
              ? { delegationMode: context.runtime.delegationMode }
              : {}),
          },
        });

        if (runtimeContextBundle) {
          runtimeContextArtifactId = `artifact_${createId()}`;
          const runtimeContextJsonPath = join(artifactsRootDir, "runtime-context.json");
          const runtimeContextMarkdownPath = join(artifactsRootDir, "runtime-context.md");
          await mkdir(artifactsRootDir, { recursive: true });
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
          await writeRuntimeContract({
            workspaceDir,
            runId: context.runtime.id,
            taskId: context.task.id,
            roleId: context.runtime.roleId,
            runtimeContextJsonPath,
            runtimeContextMarkdownPath,
            runtimeContext: runtimeContextBundle.document,
            managerDecisionSummary: runtimeContextBundle.summary,
          });
          runtimeContractRelativePath = `.magister/runtime-contracts/${context.runtime.id}/AGENTS.md`;
        }
      }

      const request = requestBuilder(context, provider, model, {
        runtimeContractRelativePath,
        runtimeContextArtifactId,
        currentWallClock: startedAt,
        continuityRequiresRehydration:
          context.runtime.resumePolicy === "resume_first" ||
          context.runtime.resumePolicy === "rehydrate_only",
      });
      const startedPayload = {
        message: `API executor started the ${context.runtime.roleId} run`,
        source: context.slot.adapterId,
        providerRef: provider.providerRef,
        modelRef,
        modelName: model.modelName,
        configuredModel,
        workspaceBaseDir,
        workspaceDir,
        runtimeWorkspaceRequestedStrategy: managedWorkspaceLease?.requestedStrategy ?? null,
        runtimeWorkspaceStrategy: managedWorkspaceLease?.strategy ?? null,
        runtimeWorkspaceDecisionReason: managedWorkspaceLease?.decisionReason ?? null,
        runtimeWorkspaceFallbackReason: managedWorkspaceLease?.fallbackReason ?? null,
        runtimeWorkspaceManaged: Boolean(managedWorkspaceLease),
        requestPreview: summarizeText(request.prompt, 280),
      };

      await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
        state: "RUNNING",
        activeExecutorId: context.slot.adapterId,
        currentSessionId: sessionId,
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
          executorSessionId: sessionId,
          workspaceId: context.task.workspaceId,
          severity: "info",
          occurredAt: startedAt,
          payloadJson: JSON.stringify(startedPayload),
        }),
      );

      const dispatchApiRequest = async (requestToSend: ApiExecutorRequest) => {
        if (options.transport) {
          return options.transport.execute({
            provider,
            model,
            request: requestToSend,
          });
        }

        if (provider.transport === "http") {
          return executeRealApiTransport({
            adapterId: context.slot.adapterId,
            fetchImpl: options.fetchImpl ?? fetch,
            env: options.env ?? process.env,
            provider,
            model,
            request: requestToSend,
          });
        }

        return createFakeApiTransport().execute({
          provider,
          model,
          request: requestToSend,
        });
      };

      let response: ApiExecutorTransportResponse;
      try {
        response = await dispatchApiRequest(request);
      } catch (error) {
        response = {
          ok: false,
          status: 0,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const completedAt = now();
      if (
        context.runtime.roleId === "leader" &&
        response.ok &&
        response.status >= 200 &&
        response.status < 300
      ) {
        const groundingRequirement = getManagerGroundingRequirement({
          title: context.task.title ?? context.task.id,
          description: context.task.description ?? null,
        });
        const loopResult = await runManagerLoop({
          basePrompt: request.prompt,
          workspaceDir,
          initialResponse: response,
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
            const occurredAt = now();
            const basePayload = {
              source: context.slot.adapterId,
              toolName: event.toolName,
              arguments: event.arguments,
            };
            const summary =
              event.type === "tool.call"
                ? `Manager tool call: ${event.toolName}`
                : event.type === "tool.result"
                  ? `Manager tool result: ${event.toolName}`
                  : `Manager tool error: ${event.toolName}`;

            await context.dependencies.observabilityAdapter.recordEvent(
              createEvent(context, {
                id: `event_${createId()}`,
                type: event.type,
                taskId: context.task.id,
                roleRuntimeId: context.runtime.id,
                executorSessionId: sessionId,
                workspaceId: context.task.workspaceId,
                severity: event.type === "tool.error" ? "warning" : "info",
                occurredAt,
                payloadJson: JSON.stringify({
                  ...basePayload,
                  message: summary,
                  ...(event.type !== "tool.call"
                    ? event.observation.ok
                      ? {
                          result: event.observation.result,
                          resultSummary: event.observation.summary,
                        }
                      : {
                          errorMessage: event.observation.error ?? event.observation.summary,
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
              sourceEventId: `${event.type}:${context.runtime.id}:${event.toolName}:${occurredAt.toISOString()}`,
              eventType: event.type,
              summary:
                event.type === "tool.call"
                  ? `Tool call: ${event.toolName}`
                  : event.type === "tool.result"
                    ? `Tool result: ${event.toolName}`
                    : `Tool error: ${event.toolName}`,
              details: {
                toolName: event.toolName,
                arguments: event.arguments,
                ...(event.type !== "tool.call"
                  ? event.observation.ok
                    ? {
                        result: event.observation.result,
                        resultSummary: event.observation.summary,
                      }
                    : {
                        errorMessage: event.observation.error ?? event.observation.summary,
                      }
                  : {}),
              },
              roleId: context.runtime.roleId,
              executorId: context.slot.adapterId,
              sessionId,
              attemptCount: context.runtime.attemptCount + 1,
            });
          },
          dispatchModel: async (prompt) =>
            dispatchApiRequest({
              ...request,
              prompt,
            }),
          tavilyConfig: parseTavilyWebSearchConfigFromEnv(options.env ?? process.env),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          now,
        });
        if (loopResult) {
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
          response = {
            ...loopResult.response,
            body: {
              message: finalLoopMessage,
            },
          };
        }

        const loopResponseMessage =
          typeof response.body === "object" && response.body && "message" in response.body
            ? String((response.body as { message?: unknown }).message ?? "")
            : response.message ?? "";
        const effectiveExtraction = extractManagerDecisionOutput(loopResponseMessage);
        if (!effectiveExtraction.parsedDecision && effectiveExtraction.fallbackReason === "invalid_decision") {
          const repairRequest: ApiExecutorRequest = {
            ...request,
            prompt: buildManagerRepairPrompt({
              basePrompt: request.prompt,
              invalidOutput: loopResponseMessage,
            }),
          };
          const repairedResponse = await dispatchApiRequest(repairRequest);
          const repairedMessage =
            typeof repairedResponse.body === "object" &&
            repairedResponse.body &&
            "message" in repairedResponse.body
              ? String((repairedResponse.body as { message?: unknown }).message ?? "")
              : repairedResponse.message ?? "";
          const repairedExtraction = extractManagerDecisionOutput(repairedMessage);
          if (repairedResponse.ok && repairedResponse.status >= 200 && repairedResponse.status < 300) {
            if (repairedExtraction.parsedDecision) {
              const groundedReply =
                repairedExtraction.parsedDecision.decision === "direct_answer"
                  ? coerceGroundedManagerReply({
                      task: {
                        title: context.task.title ?? context.task.id,
                        description: context.task.description ?? null,
                      },
                      observations: loopResult?.observations ?? [],
                      reply: repairedExtraction.parsedDecision.reply ?? null,
                    })
                  : null;
              response =
                groundedReply && repairedExtraction.parsedDecision
                  ? {
                      ...repairedResponse,
                      body: {
                        message: JSON.stringify({
                          ...repairedExtraction.parsedDecision,
                          reply: groundedReply,
                        }),
                      },
                    }
                  : repairedResponse;
            }
          }
        }
      }
      const finalResponseMessage =
        typeof response.body === "object" && response.body && "message" in response.body
          ? String((response.body as { message?: unknown }).message ?? "")
          : response.message ?? "";
      const lastMessage = finalResponseMessage.trim();
      const structuredReview =
        context.runtime.roleId === "reviewer"
          ? parseStructuredReviewerResponse(finalResponseMessage)
          : null;
      const noteSummary =
        structuredReview?.verdict
          ? `Verdict: ${structuredReview.verdict}`
          : structuredReview?.reviewSummary
            ? summarizeText(structuredReview.reviewSummary)
            :
        summarizeText(finalResponseMessage) ||
        `API executor completed the ${context.runtime.roleId} run`;
      const artifactDescriptor = getArtifactDescriptor(context.runtime.roleId);
      const artifactId = `artifact_${createId()}`;

      if (response.ok && response.status >= 200 && response.status < 300) {
        if (context.runtime.roleId === "reviewer") {
          const reviewPath = join(artifactsRootDir, "review.md");
          await materializeArtifact(context, {
            artifactId,
            artifactType: artifactDescriptor.artifactType,
            title: artifactDescriptor.title,
            summary: noteSummary,
            filePath: reviewPath,
            contents: finalResponseMessage,
            createdAt: completedAt,
          });
        } else {
          const notePath = join(artifactsRootDir, "last-message.md");
          await materializeArtifact(context, {
            artifactId,
            artifactType: artifactDescriptor.artifactType,
            title: artifactDescriptor.title,
            summary: noteSummary,
            filePath: notePath,
            contents: finalResponseMessage,
            createdAt: completedAt,
          });
        }

        await context.dependencies.roleRuntimeRepository.update(context.runtime.id, {
          state: "COMPLETED",
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
            artifactId,
            workspaceId: context.task.workspaceId,
            severity: "info",
            occurredAt: completedAt,
            payloadJson: JSON.stringify({
              message: noteSummary,
              lastMessage: lastMessage || noteSummary,
              source: context.slot.adapterId,
              providerRef: provider.providerRef,
              modelRef,
              modelName: model.modelName,
              requestId: response.requestId,
              responseStatus: response.status,
              responsePreview: summarizeText(finalResponseMessage, 280),
              ...(structuredReview?.verdict ? { reviewVerdict: structuredReview.verdict } : {}),
              ...(structuredReview
                ? { blockingIssueCount: structuredReview.blockingIssues.length }
                : {}),
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
          artifactId,
        };
      }

      const failure = classifyTransportFailure(context, response);
      const metadataArtifactId = `artifact_${createId()}`;
      const noteArtifactId = `artifact_${createId()}`;
      const metadataPath = join(artifactsRootDir, "session.json");
      const notePath = join(artifactsRootDir, "failure-note.md");
      const metadataCreatedAt = new Date(completedAt.getTime() - 1);

      await materializeArtifact(context, {
        artifactId: metadataArtifactId,
        artifactType: "execution_metadata",
        title: "API session metadata",
        summary: `Captured API session metadata for the ${context.runtime.roleId} run`,
        filePath: metadataPath,
        contents: JSON.stringify(
          {
            adapterId: context.slot.adapterId,
            providerRef: provider.providerRef,
            modelRef,
            modelName: model.modelName,
            configuredModel,
            workspaceBaseDir,
            workspaceDir,
            runtimeWorkspaceRequestedStrategy: managedWorkspaceLease?.requestedStrategy ?? null,
            runtimeWorkspaceStrategy: managedWorkspaceLease?.strategy ?? null,
            runtimeWorkspaceDecisionReason: managedWorkspaceLease?.decisionReason ?? null,
            runtimeWorkspaceFallbackReason: managedWorkspaceLease?.fallbackReason ?? null,
            runtimeWorkspaceManaged: Boolean(managedWorkspaceLease),
            runtimeWorkspaceMetadataPath: managedWorkspaceLease?.metadataPath ?? null,
            failureCode: failure.code,
            requestId: response.requestId ?? null,
            responseStatus: response.status,
            responseMessage: finalResponseMessage,
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            request,
            response: response.body ?? response.message ?? null,
          },
          null,
          2,
        ),
        createdAt: metadataCreatedAt,
      });

      await materializeArtifact(context, {
        artifactId: noteArtifactId,
        artifactType: artifactDescriptor.artifactType,
        title: artifactDescriptor.title,
        summary: failure.message,
        filePath: notePath,
        contents: [failure.message, "", `Provider: ${provider.providerRef}`, `Model: ${model.modelName}`, "", `Suggestion: ${failure.suggestion}`, ...(finalResponseMessage ? ["", `Response: ${finalResponseMessage}`] : [])].join("\n"),
        createdAt: completedAt,
      });

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
        createFailureEvent(
          context,
          {
            sessionId,
            message: failure.message,
            code: failure.code,
            suggestion: failure.suggestion,
            providerRef: provider.providerRef,
            modelRef,
            request,
            response,
            noteArtifactId,
            metadataArtifactId,
          },
          completedAt,
        ),
      );

      return buildFailure(context, failure);
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
