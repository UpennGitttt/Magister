import type {
  AdapterHealth,
  AgentProfile,
  BindingList,
  ChangeReviewDetail,
  ChangeReviewDiffPreview,
  ChangeReviewSummary,
  DiscoveredModel,
  Approval,
  Artifact,
  CreateTaskResult,
  ModelList,
  ProviderList,
  ProviderPresetList,
  SecretList,
  RunContext,
  RoleRoutingList,
  TaskContext,
  RunSummary,
  TaskMemoryView,
  TaskOrchestrationHistory,
  TaskStreamSnapshot,
  TaskSummary,
  TaskStats,
  TaskTreeResponse,
  TurnSummary,
  SystemStatus,
  WorkspaceInsights,
  WorkspaceSummary,
  StatusReport,
  WorkspaceView as _WorkspaceView,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
} from "./types";

export type { WorkspaceView } from "./types";
type WorkspaceView = _WorkspaceView;
import { ApiError, request, requestList } from "./request";

type AgentStatusItem = {
  roleId: string;
  status: string;
  lastHeartbeatAt: number | null;
};

type AgentStatusList = {
  items: AgentStatusItem[];
};

type UsageRecord = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
};

type TodayUsage = {
  records: UsageRecord[];
};

export async function getWorkspaceSummary() {
  return request<WorkspaceSummary>("/workspace/summary");
}

export async function getWorkspaceInsights() {
  return request<WorkspaceInsights>("/workspace/insights");
}

export async function getSystemStatus() {
  return request<SystemStatus>("/system/status");
}

/** Supersede a patch review (approved + not_applied) that the backend
 *  apply preflight has marked not currently applicable. Route name is
 *  kept as /discard for compatibility. */
export async function discardChangeReview(reviewId: string, opts?: { reason?: string }) {
  return request<{ review: ChangeReviewSummary; idempotent: boolean }>(
    `/change-reviews/${encodeURIComponent(reviewId)}/discard`,
    {
      method: "POST",
      ...(opts?.reason ? { body: JSON.stringify({ reason: opts.reason }) } : { body: "{}" }),
      headers: { "content-type": "application/json" },
    },
  );
}

/** Restart the API server. Triggered from Settings → Diagnostics.
 *  Backend spawns a detached `restart-profile.sh` subprocess + responds
 *  before its own SIGTERM lands; the caller is then expected to poll
 *  `/system/status` (or `/health` via the proxy) every 1-2s until
 *  it's back. */
export type RestartResponse = {
  scheduled: boolean;
  profile: string;
  installDir: string;
  logPath: string;
  estimatedReadyInMs: number;
};
export async function restartSystem() {
  return request<RestartResponse>("/system/restart", { method: "POST" });
}

/** Path A — codex-extra skills the model sees beyond the Magister pool.
 *  Wire shape of `GET /skills/external`. Codex auto-loads its own
 *  bundled .system/ + any installed superpowers meta-pack on top
 *  of the Magister pool; this endpoint surfaces all of them so the
 *  Skills tab can show a complete picture.  */
export type ExternalSkillEntry = {
  name: string;
  description: string;
  filePath: string;
  source: "codex-bundled" | "magister-pool" | "codex-superpowers" | "unknown";
};

export type ExternalSkillsResponse = {
  codex: {
    skills: ExternalSkillEntry[];
    countsBySource: {
      "codex-bundled": number;
      "magister-pool": number;
      "codex-superpowers": number;
      unknown: number;
    };
    totalCount: number;
    method: "probe" | "scan";
    fallbackReason?: string;
    takenAt: string;
  };
};

export async function getExternalSkills(refresh = false) {
  return request<ExternalSkillsResponse>(`/skills/external${refresh ? "?refresh=1" : ""}`);
}

export type MemoryListEntry = {
  path: string;
  scope: "user-global" | "project";
  type:
    | "user"
    | "project"
    | "feedback"
    | "reference"
    | "cheatsheet"
    | "scratchpad";
  name: string;
  description: string;
  createdAt: string;
  lastAccessedAt: string;
  agingFlag?: "aging" | "stale";
  // Phase 3: workspace HEAD has moved since this entry was written;
  // sweeper flips this true when project/* entries' gitAnchor !== HEAD.
  codeChanged?: boolean;
  gitAnchor?: string;
  // Phase 3: leader has linked this entry to a successor; UI shows
  // a "superseded" badge with the successor's path on hover.
  supersededBy?: string;
};

export type MemoryListResponse = {
  "user-global": MemoryListEntry[];
  project: MemoryListEntry[];
};

export type MemoryEntryDetail = {
  path: string;
  frontmatter: {
    schemaVersion: number;
    name: string;
    description: string;
    type:
      | "user"
      | "project"
      | "feedback"
      | "reference"
      | "cheatsheet"
      | "scratchpad";
    createdAt: string;
    lastAccessedAt: string;
    supersedes?: string;
    supersededBy?: string;
    related?: string[];
    agingFlag?: "aging" | "stale";
    taskId?: string;
  };
  body: string;
};

export async function listMemory() {
  return request<MemoryListResponse>("/memory/list");
}

export async function viewMemory(path: string) {
  return request<MemoryEntryDetail>(`/memory/entry/${path}`);
}

export async function deleteMemory(path: string) {
  return request<{ path: string; deleted: boolean }>(
    `/memory/entry/${path}`,
    { method: "DELETE" },
  );
}

export async function upsertCheatsheet(
  scope: "user-global" | "project",
  payload: {
    description: string;
    body: string;
    // Optimistic-concurrency etag: the lastAccessedAt the editor saw
    // on load. Server compares against current value and 409s on
    // mismatch — UI catches the ApiError and offers reload.
    expectedLastAccessedAt?: string;
  },
) {
  return request<{ path: string; created: boolean }>(
    `/memory/cheatsheet/${scope}`,
    {
      method: "PUT",
      body: JSON.stringify(payload),
    },
  );
}

export async function getStatusReport(opts?: {
  workspaceId?: string | null;
  taskId?: string | null;
}) {
  const params = new URLSearchParams();
  if (opts?.workspaceId) params.set("workspaceId", opts.workspaceId);
  if (opts?.taskId) params.set("taskId", opts.taskId);
  const qs = params.toString();
  return request<StatusReport>(`/status${qs ? `?${qs}` : ""}`);
}

export type CompactionEntry = {
  seq: number;
  taskId: string | null;
  runId: string | null;
  recordedAt: string;
  triggerReason: "hard_cap" | "proactive" | "user_requested" | null;
  preCompactTokens: number | null;
  postCompactTokens: number | null;
  freedTokens: number | null;
  truncatedCount: number;
  snippedCount: number;
  droppedCount: number;
  llmCompacted: boolean;
  llmAttempted: boolean;
  llmFailedThisTurn: boolean;
  consecutiveLlmFailures: number;
  breakerOpen: boolean;
  summaryText: string | null;
  summaryPreview: string | null;
  preservedTailTokens: number | null;
  tailStartMessageIdx: number | null;
  summaryRetryCount: number | null;
};

export type CompactionStats = {
  total: number;
  hardCapTriggers: number;
  proactiveTriggers: number;
  llmSuccesses: number;
  llmFailures: number;
  meanFreedTokens: number;
  meanCompressionRatio: number;
};

export type CompactionHistoryResponse = {
  entries: CompactionEntry[];
  stats: CompactionStats;
  limit: number;
  taskId: string | null;
  truncated: boolean;
  totalMatching: number;
};

export async function getCompactionHistory(opts?: { taskId?: string | null; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.taskId) params.set("taskId", opts.taskId);
  if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<CompactionHistoryResponse>(`/diagnostics/compaction-history${qs ? `?${qs}` : ""}`);
}

export async function getCompactionSummary(seq: number) {
  return request<{ seq: number; taskId: string | null; summaryText: string | null }>(
    `/diagnostics/compaction-history/summary/${seq}`,
  );
}

export type UsageByModelEntry = {
  model: string;
  provider: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cacheReadRatio: number;
  latestRecordedAt: string | null;
};

export type UsageByModelResponse = {
  windowDays: number;
  sinceMs: number;
  entries: UsageByModelEntry[];
};

export async function getUsageByModel(days: number = 7) {
  const params = new URLSearchParams();
  params.set("days", String(days));
  return request<UsageByModelResponse>(`/diagnostics/usage-by-model?${params.toString()}`);
}

// sidechain teammate transcript
// drawer. Fetches the teammate's full event log (or a page when
// paginating) via the indexed parent_tool_use_id query.
export type TeammateTranscriptEntry = {
  id: string;
  type: string;
  requestId: string | null;
  seq: number;
  occurredAt?: string | null;
  payloadJson?: string | null;
  agentJson?: string | null;
};

export type TeammateTranscriptResponse = {
  events: TeammateTranscriptEntry[];
  lastSeq: number;
  hasMore: boolean;
};

export async function getTeammateTranscript(opts: {
  taskId: string;
  parentToolUseId: string;
  since?: number;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (typeof opts.since === "number") params.set("since", String(opts.since));
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<TeammateTranscriptResponse>(
    `/tasks/${encodeURIComponent(opts.taskId)}/teammate/${encodeURIComponent(opts.parentToolUseId)}/transcript${qs ? `?${qs}` : ""}`,
  );
}

export async function listWorkspaces() {
  const data = await request<{ items: WorkspaceView[] }>("/workspaces");
  return data.items;
}

export async function createWorkspace(input: CreateWorkspaceRequest) {
  return request<WorkspaceView>("/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(id: string, patch: UpdateWorkspaceRequest) {
  return request<WorkspaceView>(`/workspaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function setDefaultWorkspace(id: string) {
  return request<WorkspaceView>(`/workspaces/${encodeURIComponent(id)}/set-default`, {
    method: "POST",
  });
}

export async function deleteWorkspace(id: string) {
  return request<{ deleted: boolean }>(`/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Reveal a provider's stored API key (personal-use — to verify what's saved). */
export async function revealProviderSecret(providerId: string) {
  return request<{ secretRef: string | null; value: string; configured: boolean }>(
    `/settings/providers/${encodeURIComponent(providerId)}/secret`,
  );
}

/** Write a provider's API key by provider id (server resolves the real ref). */
export async function setProviderSecret(providerId: string, value: string) {
  return request<{ secretRef: string }>(`/settings/providers/${encodeURIComponent(providerId)}/secret`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export async function getProviders() {
  const items = await requestList<ProviderList["items"][number]>("/settings/providers");
  return { items };
}

export async function getProviderPresets() {
  try {
    const data = await request<ProviderPresetList>("/settings/provider-presets");
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function getVendorPresets() {
  return request<Record<string, unknown>>("/settings/vendor-presets");
}

export async function getSecrets() {
  try {
    const data = await request<SecretList>("/settings/secrets");
    return data.items ?? [];
  } catch {
    return [];
  }
}

export async function updateProvider(
  providerId: string,
  input: Record<string, unknown>,
) {
  return request<ProviderList["items"][number]>(`/settings/providers/${providerId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Create a new provider with the given id. Server 409s if id is
 *  already taken — UI should round-trip to listProviders before
 *  optimistic insert to give a clear error in that case. */
export async function createProvider(input: { id: string } & Record<string, unknown>) {
  return request<ProviderList["items"][number]>(`/settings/providers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type ProviderDeleteCascadeReport = {
  bindingsRemoved: string[];
  modelsCleared: string[];
  modelsRemoved: string[];
  agentsCleared: Array<{ roleId: string; fields: Array<"providerId" | "fallbackProviderId" | "provider"> }>;
};

export async function getModels() {
  const items = await requestList<ModelList["items"][number]>("/settings/models");
  return { items };
}

export type CatalogModelItem = {
  catalogModelId: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision: boolean;
  alreadyAdded: boolean;
};

/** Chat models models.dev knows for a provider's vendor, with mapped metadata. */
export async function getProviderCatalogModels(providerId: string) {
  return request<{ providerId: string; catalogProviderId: string | null; items: CatalogModelItem[] }>(
    `/settings/providers/${encodeURIComponent(providerId)}/catalog-models`,
  );
}

export type CatalogSearchHit = {
  catalogProviderId: string;
  catalogModelId: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision: boolean;
};

/** Fuzzy-search models.dev across all providers by id or name (for aggregators). */
export async function searchCatalogModels(q: string) {
  return request<{ items: CatalogSearchHit[] }>(`/settings/catalog/search?q=${encodeURIComponent(q)}`);
}

/** Add catalog models to a provider by explicit (catalogProviderId, catalogModelId)
 *  pairs — works regardless of the provider's own vendor (aggregator-friendly). */
export async function addCatalogModels(
  providerId: string,
  items: Array<{ catalogProviderId: string; catalogModelId: string }>,
) {
  return request<{ added: string[]; skipped: string[]; failed: string[] }>(`/settings/models/bulk`, {
    method: "POST",
    body: JSON.stringify({ providerId, items }),
  });
}

type ModelMutationInput = {
  label?: string | null;
  vendor?: string | null;
  modelName: string;
  fallbacks?: string[] | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  providerRefs?: {
    cli?: string | null;
    api?: string | null;
  } | null;
  defaultReasoning?: {
    mode: "off" | "auto" | "on";
    effort?: string | null;
    budgetTokens?: number | null;
    visibility?: string | null;
  } | null;
  /** Free-form capability hints. Convention: `vision: boolean` to
   *  mark the model as multimodal. The frontend reads this to gate
   *  the attachment picker; it's not enforced server-side. */
  capabilityHints?: Record<string, unknown> | null;
};

export async function updateModel(
  modelId: string,
  input: ModelMutationInput,
) {
  return request<ModelList["items"][number]>(`/settings/models/${modelId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Create a new model profile. Server 409s if id collides. */
export async function createModel(input: { id: string } & ModelMutationInput) {
  return request<ModelList["items"][number]>(`/settings/models`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type ModelDeleteCascadeReport = {
  bindingsRemoved: string[];
  agentsCleared: Array<{ roleId: string; fields: Array<"modelName" | "modelOverride"> }>;
};

/** Delete a model profile. Refuses with 409 + reference list if
 *  anything still points at it; pass `cascade: true` to clear those
 *  refs (binding rows removed, agent.modelName/modelOverride nulled). */
export async function deleteModel(
  modelId: string,
  options: { cascade?: boolean } = {},
) {
  const qs = options.cascade ? "?cascade=1" : "";
  return request<{ modelId: string; cascade?: ModelDeleteCascadeReport }>(
    `/settings/models/${encodeURIComponent(modelId)}${qs}`,
    { method: "DELETE" },
  );
}

export async function getBindings() {
  const items = await requestList<BindingList["items"][number]>("/settings/bindings");
  return { items };
}

export async function updateBinding(
  adapterId: string,
  input: {
    executionMode: "cli" | "api";
    modelRef: string;
    providerRef?: string | null;
    timeoutMs?: number | null;
    commandPath?: string | null;
    sandboxMode?: string | null;
  },
) {
  return request<BindingList["items"][number]>(`/settings/bindings/${adapterId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteProvider(
  providerId: string,
  options: { cascade?: boolean } = {},
) {
  const qs = options.cascade ? "?cascade=1" : "";
  return request<{ providerId: string; cascade?: ProviderDeleteCascadeReport }>(
    `/settings/providers/${encodeURIComponent(providerId)}${qs}`,
    { method: "DELETE" },
  );
}

export async function updateSecret(
  secretRef: string,
  input: {
    value: string;
  },
) {
  return request<{ secretRef: string; status?: string; updatedAt?: string | null }>(
    `/settings/secrets/${encodeURIComponent(secretRef)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function getRoleRouting() {
  return request<RoleRoutingList>("/settings/role-routing");
}

export async function updateRoleRouting(
  roleId: string,
  input: {
    adapterId: string | null;
    strategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only" | null;
    fallbackAdapterId?: string | null;
  },
) {
  return request<RoleRoutingList["items"][number]>(`/settings/role-routing/${roleId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createTask(input: {
  prompt: string;
  source: "web" | "cli" | "feishu";
  workspaceId: string;
  rootChannelBindingId?: string;
  taskManagerHints?: {
    taskType?: "conversation" | "coding" | "mixed";
    goal?: string;
    needsHuman?: boolean;
    stopCondition?: "reply_sent" | "implementation_ready" | "review_ready" | "landing_ready";
    coordinationAction?:
      | "direct_answer"
      | "tool_answer"
      | "clarify"
      | "assign"
      | "handoff"
      | "send_message";
    childRuns?: Array<{
      roleId: "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
      dependsOn?: Array<"architect" | "coder" | "reviewer" | "lander" | "deepresearcher">;
      goal?: string;
    }>;
  };
  plannerHints?: {
    taskType?: "conversation" | "coding" | "mixed";
    goal?: string;
    needsHuman?: boolean;
    stopCondition?: "reply_sent" | "implementation_ready" | "review_ready" | "landing_ready";
    coordinationAction?:
      | "direct_answer"
      | "tool_answer"
      | "clarify"
      | "assign"
      | "handoff"
      | "send_message";
    childRuns?: Array<{
      roleId: "architect" | "coder" | "reviewer" | "lander" | "deepresearcher";
      dependsOn?: Array<"architect" | "coder" | "reviewer" | "lander" | "deepresearcher">;
      goal?: string;
    }>;
  };
  /** When true the backend appends a plan-mode addendum to the system
   *  prompt for THIS turn — telling the model "user has requested
   *  plan mode; you MUST call enter_plan_mode first." (spec §3, §11) */
  planFirst?: boolean;
  /** Files attached to this prompt. Phase 1 = images only (mime
   *  whitelist: image/png, image/jpeg, image/gif, image/webp).
   *  Each entry is base64-encoded WITHOUT the `data:` URL prefix —
   *  matches the LeaderContentBlock convention; backend builder
   *  adds the prefix per vendor at wire-format time. */
  attachments?: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string;
  }>;
  /** MCP Phase 2: pre-rendered prompt messages from
   *  `/mcp/prompts/render`. Submitted alongside the typed `prompt`
   *  text for first-turn injection. The slash menu in ChatInput
   *  uses this. */
  promptMessages?: McpPromptMessage[];
  /** Goal mode (Ralph loop). Marks the new task as autonomous —
   *  after each leader turn, the worker auto-injects a continuation
   *  mailbox row and re-enqueues until the model calls
   *  `mark_goal_complete`, the user pauses/cancels, or
   *  `maxWallSeconds` elapses. */
  goal?: {
    objective: string;
    /** Hard wall-clock safety. Omit for unlimited. */
    maxWallSeconds?: number;
  };
}, opts?: { timeoutMs?: number }) {
  // Default to 5min for createTask — the default 30s POST timeout in
  // request.ts can clip legitimately long creates that include large
  // image attachments (10 × 10 MiB caps) on slow networks. Caller may
  // override with `timeoutMs` (e.g. tests pass a short value;
  // attachment-aware callers may bump higher per payload size).
  // codex GPT-5.5 review HIGH 2.
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000;
  return request<CreateTaskResult>("/tasks", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs,
  });
}

/** Browsers don't reliably report mime for `.md` files (Chrome/FF
 *  return `text/markdown`, Safari returns empty, some platforms
 *  send `application/octet-stream`). The backend mime whitelist
 *  doesn't accept the fallbacks, so without this canonicalization
 *  the file is staged in the UI, sent to /tasks, and silently
 *  rejected with `task.attachment_rejected` — the user sees a chip
 *  but the model gets no content.
 *
 *  Map common text-file extensions to their canonical mime when
 *  the browser's reported type is missing or unhelpful. Image
 *  types are left alone — those are reliably reported by every
 *  browser. */
function inferMimeType(file: File): string {
  const browserType = file.type?.trim();
  if (browserType && !browserType.startsWith("application/octet-stream")) {
    return browserType;
  }
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  // Document formats — backend extracts at load time via mammoth /
  // xlsx / unpdf. Browsers vary: Chrome reports the OOXML mime,
  // Safari sometimes drops to application/octet-stream, mobile
  // browsers occasionally send the friendly mime. Pin the
  // canonical value here so the backend whitelist matches.
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  return browserType || "application/octet-stream";
}

/** Read a File from the browser File API and return the base64
 *  payload (no `data:` URL prefix) plus its display name and
 *  detected mime type. Used by ChatInput to package attachments
 *  before calling `createTask`. */
export async function fileToAttachment(
  file: File,
): Promise<{ filename: string; mimeType: string; dataBase64: string }> {
  const buffer = await file.arrayBuffer();
  // base64-encode in chunks so a 10 MiB image doesn't blow the
  // call stack via String.fromCharCode(...spread). 32 KiB chunks
  // are well within Chrome / Safari / FF stack limits.
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 32 * 1024;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const dataBase64 = btoa(binary);
  return {
    filename: file.name,
    mimeType: inferMimeType(file),
    dataBase64,
  };
}

export async function getTasks(opts?: { workspaceId?: string | null }) {
  // Path A — pass through workspaceId filter when provided. Falls
  // back to the un-filtered view (all workspaces) when omitted —
  // useful for the global stats path. Frontend sessions list passes
  // the active workspace.
  const qs = opts?.workspaceId ? `?workspaceId=${encodeURIComponent(opts.workspaceId)}` : "";
  const data = await request<{ items: TaskSummary[] }>(`/tasks${qs}`);
  return data.items;
}

export async function getTaskStats() {
  return request<TaskStats>("/tasks/stats");
}

export async function getTask(taskId: string) {
  return request<TaskSummary>(`/tasks/${taskId}`);
}

export async function getTaskContext(taskId: string) {
  return request<TaskContext>(`/tasks/${taskId}/context`);
}

export async function getTaskOrchestrationHistory(taskId: string) {
  return request<TaskOrchestrationHistory>(`/tasks/${taskId}/orchestration-history`);
}

export async function getTaskTree(taskId: string) {
  return request<TaskTreeResponse>(`/tasks/${taskId}/tree`);
}

export async function getRun(runId: string) {
  return request<RunSummary>(`/runs/${runId}`);
}

export async function getRunContext(runId: string) {
  return request<RunContext>(`/runs/${runId}/context`);
}

export async function getApprovals() {
  const data = await request<{ items: Approval[] }>("/approvals");
  return data.items;
}

export async function getTaskArtifacts(taskId: string) {
  const data = await request<{ items: Artifact[] }>(`/tasks/${taskId}/artifacts`);
  return data.items;
}

export async function getTaskMemory(taskId: string) {
  return request<TaskMemoryView>(`/tasks/${taskId}/memory`);
}

export async function getAdapters() {
  const data = await request<{ items: AdapterHealth[] }>("/adapters/health");
  return data.items;
}

/**
 * Sandbox-elevation v4.3 §4.5 — resolveApproval response shape extended
 * to carry the dual-channel conflict signal. When `conflict === true`,
 * caller's resolution lost to a concurrent resolve from another channel
 * (Web vs Feishu race). UI shows a yellow toast instead of silently
 * hiding the card. v3 callers ignore the extra fields.
 */
export type ResolveApprovalResponse = Approval & {
  conflict?: boolean;
  storedOutcome?: "approved" | "rejected" | "expired" | "pending";
  trustApplied?: "task" | "minutes";
  ruleSave?: { status: "persisted" | "skipped" | "failed"; error?: string };
};

export async function resolveApproval(
  approvalId: string,
  resolution: "approve" | "reject",
  options?: { trustForTask?: boolean; trustForMinutes?: number },
): Promise<ResolveApprovalResponse> {
  // Bash command-gate approvals live in the in-memory
  // `pendingApprovals` Map (command-approval-service.ts), not the DB
  // `approvals` table. The /approve and /reject endpoints in
  // routes/approvals.ts only know about DB-stored approvals and 404
  // for in-memory ones. The /resolve endpoint reads/writes the
  // in-memory store, which is where chat-inline approvals actually
  // are. Route + body shape matches /approvals/:id/resolve in
  // routes/approvals.ts.
  const decision = resolution === "approve" ? "approved" : "rejected";
  const body: Record<string, unknown> = { decision };
  if (options?.trustForTask) {
    body.trust_for_task = true;
  } else if (typeof options?.trustForMinutes === "number" && options.trustForMinutes > 0) {
    body.trust_for_minutes = options.trustForMinutes;
  }
  return request<ResolveApprovalResponse>(`/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getTaskSnapshotLight(taskId: string) {
  return request<TaskStreamSnapshot>(`/tasks/${encodeURIComponent(taskId)}/snapshot?light=true`);
}

export async function cancelTask(taskId: string) {
  return request<{ taskId: string; state: string }>(`/tasks/${taskId}/cancel`, { method: "POST" });
}

export async function requestCompact(taskId: string, hint?: string) {
  return request<{ queued: boolean }>(`/tasks/${encodeURIComponent(taskId)}/compact`, {
    method: "POST",
    body: JSON.stringify(hint ? { hint } : {}),
  });
}

export async function deleteTask(taskId: string) {
  return request<{ taskId: string; deleted: true }>(
    `/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
}

/** Mark a failed/blocked task as acknowledged so the Board's
 *  "Attention" column hides it. Task `state` is NOT modified — this
 *  is a UI-only signal stored as a timestamp. Undo within the toast
 *  window via `undismissTaskAttention`. */
export async function dismissTaskAttention(taskId: string) {
  return request<{ taskId: string; attentionDismissedAt: number }>(
    `/tasks/${encodeURIComponent(taskId)}/attention-dismiss`,
    { method: "PUT" },
  );
}

export async function undismissTaskAttention(taskId: string) {
  return request<{ taskId: string; attentionDismissedAt: null }>(
    `/tasks/${encodeURIComponent(taskId)}/attention-dismiss`,
    { method: "DELETE" },
  );
}

// ── Goal mode (Ralph loop) controls ───────────────────────────

/** Start a goal on an existing non-terminal task (v3 §P0-1).
 *  Token + wall budget count from this moment, not from task creation.
 *  Pre-goal conversation tokens are NOT charged against the budget. */
export async function startGoalOnTask(
  taskId: string,
  body: {
    objective: string;
    tokenBudget?: number;
    maxWallSeconds?: number;
  },
) {
  return request<{
    taskId: string;
    goalId: string;
    goalStatus: "active";
    startedAt: number;
    tokenBudget: number | null;
    maxWallSeconds: number | null;
    planPath: string;
  }>(`/tasks/${encodeURIComponent(taskId)}/goal/start`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type OptimizeObjectiveResponse = {
  optimized: string;
  original: string;
  compressed: boolean;
  inputTokens: number;
  /**
   * Set when the per-task `/model` override couldn't be applied (model
   * removed from config, executors.json failed to read, etc). The
   * optimizer fell back to the agent default; UI should surface this
   * so the user doesn't silently get a result that ignored their
   * model pick.
   */
  overrideWarning?: string | null;
};

export async function optimizeGoalObjective(
  taskId: string,
  objective: string,
): Promise<OptimizeObjectiveResponse> {
  return request<OptimizeObjectiveResponse>(
    `/tasks/${encodeURIComponent(taskId)}/goal/optimize`,
    { method: "POST", body: JSON.stringify({ objective }) },
  );
}

// Per-task leader model override (/model slash command).
export type TaskModelState = {
  override: string | null;
  effective: {
    modelName: string;
    providerId: string;
    providerLabel: string;
    apiDialect: string;
    contextWindow: number | null;
  };
  defaultModel: { modelName: string; providerId: string };
};

export async function getTaskModel(taskId: string): Promise<TaskModelState> {
  return request<TaskModelState>(`/tasks/${encodeURIComponent(taskId)}/model`);
}

/**
 * Server-authoritative confirm gate: dialect-change POSTs without
 * `confirm: true` get a 409 `confirm_required` and DO NOT write.
 * The caller repeats with `{ confirm: true }` after the user accepts
 * in the Confirm/Cancel dialog.
 *
 * Returns a discriminated union so callers can branch without
 * try/catching on HTTP error semantics.
 */
export type SetTaskModelResult =
  | {
      ok: true;
      modelOverride: string | null;
      requiresWarning: boolean;
      fromDialect: string | null;
      toDialect: string | null;
    }
  | {
      ok: false;
      requiresConfirm: true;
      from: { modelName: string | null; apiDialect: string | null };
      to: { modelName: string | null; apiDialect: string | null };
    };

/**
 * `expectedOverride` carries the override value seen at GET time so
 * the server can CAS-detect another writer between fetch and commit
 * (e.g. two browser tabs both opening `/model` and picking different
 * models). On mismatch the server returns 409 stale_override and the
 * UI prompts the user to refresh and retry. Omit to skip the check
 * (inline `/model X` shortcut path).
 */
export async function setTaskModel(
  taskId: string,
  modelName: string | null,
  options: {
    confirm?: boolean;
    expectedOverride?: string | null;
  } = {},
): Promise<SetTaskModelResult> {
  const payload: Record<string, unknown> = {
    modelName,
    confirm: options.confirm === true,
  };
  // Only forward expectedOverride when caller actually passed it (any
  // value including null is meaningful and triggers CAS). Use `in`
  // check rather than ?? because `null` is a real expected value.
  if ("expectedOverride" in options) {
    payload.expectedOverride = options.expectedOverride ?? null;
  }
  try {
    const data = await request<{
      modelOverride: string | null;
      requiresWarning: boolean;
      fromDialect: string | null;
      toDialect: string | null;
    }>(
      `/tasks/${encodeURIComponent(taskId)}/model`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    return { ok: true, ...data };
  } catch (err) {
    if (err instanceof ApiError && err.code === "confirm_required") {
      const details = (err.details ?? {}) as {
        from?: { modelName: string | null; apiDialect: string | null };
        to?: { modelName: string | null; apiDialect: string | null };
      };
      return {
        ok: false,
        requiresConfirm: true,
        from: details.from ?? { modelName: null, apiDialect: null },
        to: details.to ?? { modelName: null, apiDialect: null },
      };
    }
    throw err;
  }
}

// Mid-flight objective edit.
export async function editGoalObjective(taskId: string, objective: string) {
  return request<{ taskId: string; objective: string; editedAt: number }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/objective`,
    { method: "PATCH", body: JSON.stringify({ objective }) },
  );
}

// Subgoal CRUD.
export async function listSubgoals(taskId: string) {
  return request<{ subgoals: string[] }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/subgoals`,
  );
}

export async function addSubgoal(taskId: string, subgoal: string) {
  return request<{ subgoals: string[] }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/subgoals`,
    { method: "POST", body: JSON.stringify({ subgoal }) },
  );
}

export async function removeSubgoal(taskId: string, index1Based: number) {
  return request<{ subgoals: string[] }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/subgoals/${index1Based}`,
    { method: "DELETE" },
  );
}

export async function clearSubgoals(taskId: string) {
  return request<{ subgoals: string[] }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/subgoals`,
    { method: "DELETE" },
  );
}

export async function pauseGoal(taskId: string) {
  return request<{ taskId: string; goalStatus: "paused" }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/pause`,
    { method: "POST" },
  );
}

export async function resumeGoal(taskId: string) {
  return request<{ taskId: string; goalStatus: "active" }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/resume`,
    { method: "POST" },
  );
}

export async function cancelGoal(taskId: string) {
  return request<{ taskId: string; goalStatus: "cancelled" | "complete" }>(
    `/tasks/${encodeURIComponent(taskId)}/goal/cancel`,
    { method: "POST" },
  );
}

export async function sendTaskMessage(
  taskId: string,
  content: string,
  attachments?: Array<{ filename: string; mimeType: string; dataBase64: string }>,
) {
  const body: Record<string, unknown> = { content };
  if (attachments && attachments.length > 0) body.attachments = attachments;
  return request<{
    id: string;
    taskId: string;
    requestId?: string;
    action?: "queued_mailbox" | "resumed_session";
  }>(`/tasks/${taskId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Skills API — pool model.
// `getSkills()` lists every entry in the central skill pool
// (`~/.agents/skills/`) enriched with which agents have it
// attached. `setAgentSkills()` replaces the full attachment set
// for a single agent role; the backend diffs current vs desired
// and applies symlink (CLI) or DB (leader) changes accordingly.
export type SkillSourceKind = "github" | "manual" | "builtin";
export type SkillAgentRole = "leader" | "codex" | "claude-code" | "opencode";

export type SkillView = {
  name: string;
  /** Filesystem directory name. For most skills `dirName === name`;
   *  meta-pack skills like `ckm:banner-design` have dirName `ckm-banner-design`. */
  dirName: string;
  description: string;
  sourceKind: SkillSourceKind;
  sourceUrl?: string;
  sourceCommit?: string;
  installedAt?: string;
  updatedAt?: string;
  skillFilePath: string;
  attachedAgents: SkillAgentRole[];
  /** Bundled-only: true when the leader has a per-instance
   *  override (description and/or content) on this skill. */
  hasOverride?: boolean;
};

export async function getSkills() {
  return request<{ items: SkillView[] }>("/skills");
}

export type SkillDetail = SkillView & { content: string };

/** Fetch a single skill including its full SKILL.md body (with the
 *  frontmatter stripped — the body only). Used by the Edit form
 *  on the Skills tab. */
export async function getSkillDetail(name: string) {
  return request<SkillDetail>(`/skills/${encodeURIComponent(name)}`);
}

export type SkillCliError = {
  code: string;
  message: string;
  stderr?: string;
  stdout?: string;
  exitCode?: number;
  timedOut?: boolean;
};

export type SkillImportResponse = {
  ok: boolean;
  source: string;
  cli: {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
  };
  skill?: SkillView;
};

/** Install a skill from a GitHub source. Synchronous — UI shows a
 *  spinner; finishes in ~5-30s on a warm npm cache. */
export async function importSkillFromGithub(source: string) {
  return request<SkillImportResponse>("/skills/import", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

/** Create a brand-new manually-authored skill. Errors surface as
 *  thrown exceptions; the request helper unwraps the envelope. */
export async function createManualSkill(input: { name: string; description: string; content: string }) {
  return request<SkillView>("/skills", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Edit an existing manual skill. GitHub-sourced skills will be
 *  rejected by the backend with a clear message. */
export async function updateManualSkill(name: string, patch: { description?: string; content?: string }) {
  return request<SkillView>(`/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Re-pull a GitHub-sourced skill from upstream. */
export async function refreshSkill(name: string) {
  return request<SkillImportResponse>(`/skills/${encodeURIComponent(name)}/refresh`, {
    method: "POST",
  });
}

/** Remove a skill from the pool, all CLI symlinks, leader DB
 *  attachment, and the skill-lock entry. Idempotent. */
export async function deleteSkillFromPool(name: string) {
  return request<{ name: string; detachedFromCli: string[]; detachedFromLeader: boolean }>(
    `/skills/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

/** Clear the per-instance override for a Magister-bundled skill,
 *  restoring the bundled default. No-op if no override exists. */
export async function resetBundledSkill(name: string) {
  return request<Record<string, never>>(
    `/skills/${encodeURIComponent(name)}/reset`,
    { method: "POST" },
  );
}

// Agent profiles API
export async function getAgentProfiles(): Promise<{ items: AgentProfile[] }> {
  const items = await requestList<AgentProfile>("/settings/agents");
  return { items };
}

export async function getAgentStatuses(): Promise<AgentStatusList> {
  const data = await request<{ items?: AgentStatusItem[] }>("/settings/agents/statuses");
  return { items: data.items ?? [] };
}

export type TaskUsageSummary = {
  taskId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  leaderInputTokens?: number;
  leaderOutputTokens?: number;
  teammateInputTokens?: number;
  teammateOutputTokens?: number;
  usageSplitKnown?: boolean;
  turnCount: number;
  models: string[];
  latestModel?: string | null;
  latestProvider?: string | null;
  leaderLatestModel?: string | null;
  leaderLatestProvider?: string | null;
  /** Latest single-call input tokens (current "context used"). */
  latestInputTokens?: number;
  /** Largest single-call input ever recorded for this task. */
  peakInputTokens?: number;
  leaderLatestInputTokens?: number;
  leaderPeakInputTokens?: number;
  /** Resolved context window for the latest model. Null when
   *  unknown — UI falls back to a default (or hides the bar). */
  contextWindow?: number | null;
  leaderContextWindow?: number | null;
  byRole?: Array<{
    roleId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
};

export async function getTaskUsage(taskId: string): Promise<TaskUsageSummary> {
  return request<TaskUsageSummary>(`/tasks/${taskId}/usage`);
}

export async function getTaskChangeReviews(taskId: string): Promise<ChangeReviewSummary[]> {
  const data = await request<{ reviews?: ChangeReviewSummary[] }>(
    `/tasks/${encodeURIComponent(taskId)}/change-reviews`,
  );
  return data.reviews ?? [];
}

export async function getChangeReview(reviewId: string): Promise<ChangeReviewDetail> {
  const data = await request<{ review: ChangeReviewDetail }>(
    `/change-reviews/${encodeURIComponent(reviewId)}`,
  );
  return data.review;
}

export async function getChangeReviewDiff(reviewId: string): Promise<ChangeReviewDiffPreview> {
  return request<ChangeReviewDiffPreview>(`/change-reviews/${encodeURIComponent(reviewId)}/diff`);
}

export async function decideChangeReview(
  reviewId: string,
  input: {
    decision: "approve" | "reject" | "request_revision";
    reason?: string;
    expectedDiffHash?: string;
  },
): Promise<{
  review: ChangeReviewSummary;
  idempotent: boolean;
}> {
  return request<{
    review: ChangeReviewSummary;
    idempotent: boolean;
  }>(`/change-reviews/${encodeURIComponent(reviewId)}/decision`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function applyChangeReview(
  reviewId: string,
  input: {
    expectedDiffHash: string;
  },
): Promise<{
  review: ChangeReviewSummary;
  idempotent: boolean;
  appliedPatchHash: string;
}> {
  return request<{
    review: ChangeReviewSummary;
    idempotent: boolean;
    appliedPatchHash: string;
  }>(`/change-reviews/${encodeURIComponent(reviewId)}/apply`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getTaskTurnSummaries(taskId: string): Promise<TurnSummary[]> {
  const data = await request<{ items: TurnSummary[] }>(`/tasks/${taskId}/turn-summaries`);
  return data.items;
}

export async function getTodayUsage(): Promise<TodayUsage> {
  const data = await request<{ records?: UsageRecord[] }>("/usage/today");
  return {
    records: data.records ?? [],
  };
}


export async function updateAgentProfile(
  roleId: string,
  data: Partial<AgentProfile>,
): Promise<AgentProfile> {
  const payload: Partial<AgentProfile> = {};

  if (data.label !== undefined) payload.label = data.label;
  if (data.description !== undefined) payload.description = data.description;
  if (data.systemPromptOverride !== undefined) payload.systemPromptOverride = data.systemPromptOverride;
  if (data.modelName !== undefined) payload.modelName = data.modelName;
  if (data.modelOverride !== undefined) payload.modelOverride = data.modelOverride;
  if (data.providerId !== undefined) payload.providerId = data.providerId;
  if (data.reasoningMode !== undefined) payload.reasoningMode = data.reasoningMode;
  if (data.reasoningEffort !== undefined) payload.reasoningEffort = data.reasoningEffort;
  if (data.contextWindow !== undefined) payload.contextWindow = data.contextWindow;
  if (data.maxOutputTokens !== undefined) payload.maxOutputTokens = data.maxOutputTokens;
  if (data.fallbackModelName !== undefined) payload.fallbackModelName = data.fallbackModelName;
  if (data.fallbackProviderId !== undefined) payload.fallbackProviderId = data.fallbackProviderId;
  if (data.status !== undefined) payload.status = data.status;
  if (data.mcpConfig !== undefined) payload.mcpConfig = data.mcpConfig;
  if (data.maxConcurrentTasks !== undefined) payload.maxConcurrentTasks = data.maxConcurrentTasks;
  if (data.runtimeType !== undefined) payload.runtimeType = data.runtimeType;
  if (data.provider !== undefined) payload.provider = data.provider;
  if (data.commandPath !== undefined) payload.commandPath = data.commandPath;
  if (data.customEnv !== undefined) payload.customEnv = data.customEnv;
  if (data.customArgs !== undefined) payload.customArgs = data.customArgs;
  if (data.maxTurns !== undefined) payload.maxTurns = data.maxTurns;
  if (data.toolProfile !== undefined) payload.toolProfile = data.toolProfile;
  if (data.allowedTools !== undefined) payload.allowedTools = data.allowedTools;
  if (data.disallowedTools !== undefined) payload.disallowedTools = data.disallowedTools;
  if (data.isBuiltin !== undefined) payload.isBuiltin = data.isBuiltin;

  return request<AgentProfile & { warning?: string }>(`/settings/agents/${encodeURIComponent(roleId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function getAgentModels(
  roleId: string,
  overrides?: { runtimeType?: string; commandPath?: string; providerId?: string; refresh?: boolean },
): Promise<{ models: DiscoveredModel[]; supported: boolean }> {
  const params = new URLSearchParams();
  if (overrides && overrides.runtimeType) params.set("runtimeType", overrides.runtimeType);
  if (overrides && overrides.commandPath) params.set("commandPath", overrides.commandPath);
  // `providerId` lets the caller request the model list for a draft
  // provider that hasn't been saved yet (user changed the dropdown
  // but hasn't clicked save). Backend treats it as override on top
  // of the saved profile's providerId.
  if (overrides && overrides.providerId !== undefined) params.set("providerId", overrides.providerId);
  if (overrides?.refresh) params.set("refresh", "1");
  const qs = params.toString();
  const data = await request<{ models: DiscoveredModel[]; supported: boolean }>(
    `/settings/agents/${encodeURIComponent(roleId)}/models${qs ? `?${qs}` : ""}`,
  );
  return {
    models: data.models ?? [],
    supported: data.supported !== false,
  };
}

export type LeaderToolEntry = { name: string; description: string };

/**
 * Canonical leader-tool registry shown in the agent settings UI for
 * the per-agent allow/deny multiselect. Excludes leader-only tools
 * (enter_plan_mode / exit_plan_mode) — those are never useful for
 * teammates and shouldn't tempt the user into selecting them.
 */
export async function getTools(): Promise<LeaderToolEntry[]> {
  const data = await request<{ items: LeaderToolEntry[] }>("/settings/tools");
  return data.items ?? [];
}

export async function deleteAgentProfile(roleId: string): Promise<void> {
  await request<{ deleted: boolean }>(`/settings/agents/${encodeURIComponent(roleId)}`, {
    method: "DELETE",
  });
}

export async function getAgentSkills(roleId: string) {
  return request<{ items: SkillView[] }>(`/agents/${roleId}/skills`);
}

export type SetAgentSkillsResult = {
  attached: string[];
  detached: string[];
  failed: Array<{ name: string; action: "attach" | "detach"; error: string }>;
};

// Body shape changed from `skillIds: string[]` to `skillNames:
// string[]` — names are stable across machines, IDs were just DB
// rowids that didn't survive a re-seed. The backend still accepts
// both forms during the transition.
export async function setAgentSkills(roleId: string, skillNames: string[]) {
  return request<SetAgentSkillsResult>(`/agents/${roleId}/skills`, {
    method: "PUT",
    body: JSON.stringify({ skillNames }),
  });
}

export async function getTaskMessages(
  taskId: string,
  options: { offset?: number; limit?: number; tail?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.tail) {
    params.set("tail", "true");
  } else {
    params.set("offset", String(options.offset ?? 0));
  }
  params.set("limit", String(options.limit ?? 50));
  return request<{ messages: unknown[]; total: number; offset: number; limit: number }>(
    `/tasks/${encodeURIComponent(taskId)}/messages?${params.toString()}`,
  );
}

// MCP server registration API. Phase 1: tools-only (no
// resources / prompts), no OAuth (stdio + simple HTTP/SSE only).
export type McpTransport = "stdio" | "http" | "sse";
export type McpTrustLevel = "trusted" | "ask";
export type McpStatus =
  | { kind: "connected"; toolCount: number }
  | { kind: "disabled" }
  | { kind: "disconnected" }
  | { kind: "failed"; error: string };

export type McpServerView = {
  id: string;
  name: string;
  transport: McpTransport;
  config: Record<string, unknown>;
  timeoutMs: number | null;
  enabled: boolean;
  trustLevel: McpTrustLevel;
  status: McpStatus;
  createdAt: string;
  updatedAt: string;
};

export async function getMcpServers() {
  return request<{ items: McpServerView[] }>("/mcp/servers");
}

export async function createMcpServer(input: {
  name: string;
  transport: McpTransport;
  config: Record<string, unknown>;
  timeoutMs?: number;
  enabled?: boolean;
  trustLevel?: McpTrustLevel;
}) {
  return request<{ id: string }>("/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(id: string, patch: Partial<{
  name: string;
  transport: McpTransport;
  config: Record<string, unknown>;
  timeoutMs: number;
  enabled: boolean;
  trustLevel: McpTrustLevel;
}>) {
  return request(`/mcp/servers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deleteMcpServer(id: string) {
  return request(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export type McpToolPolicy = "unknown" | "read_only" | "mutating";
export type McpToolPolicySource = "discovered" | "manual" | "imported" | "missing";
export type McpToolPolicyItem = {
  serverId: string;
  serverName: string;
  toolName: string;
  namespacedName: string;
  policy: McpToolPolicy;
  source: McpToolPolicySource;
  approvalBehavior: "auto_allowed" | "requires_approval";
  approvalReason: "server_ask" | "tool_unknown" | "tool_mutating" | "trusted_read_only";
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  lastDiscoveredAt: string | null;
  status: "discovered" | "saved_only";
};

export async function getMcpServerToolPolicies(serverId: string) {
  return request<{ items: McpToolPolicyItem[] }>(
    `/mcp/servers/${encodeURIComponent(serverId)}/tools`,
  );
}

export async function updateMcpToolPolicy(input: {
  serverId: string;
  toolName: string;
  policy: McpToolPolicy;
  rationale?: string | null;
}) {
  return request<{ item: McpToolPolicyItem | null }>(
    `/mcp/servers/${encodeURIComponent(input.serverId)}/tools/${encodeURIComponent(input.toolName)}/policy`,
    {
      method: "PUT",
      body: JSON.stringify({
        policy: input.policy,
        rationale: input.rationale ?? null,
      }),
    },
  );
}

// MCP Phase 2: prompts. The slash menu in ChatInput lists what's
// available across connected servers and renders one when the user
// picks it. The rendered messages get submitted as the first turn
// of a new task via POST /tasks { promptMessages }.
export type McpPromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

export type McpPromptDescriptor = {
  serverId: string;
  serverName: string;
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
};

export type McpPromptMessage = {
  role: "user" | "assistant";
  content:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
    | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
    | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };
};

export async function getMcpPrompts() {
  return request<{ items: McpPromptDescriptor[] }>("/mcp/prompts");
}

export async function renderMcpPrompt(input: {
  serverId: string;
  name: string;
  args: Record<string, string>;
}) {
  return request<{ messages: McpPromptMessage[]; description?: string }>("/mcp/prompts/render", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// MCP Phase 3: per-agent attachment management.
export async function getAgentMcpServers(roleId: string) {
  return request<{ items: string[] }>(`/agents/${encodeURIComponent(roleId)}/mcp-servers`);
}

export async function setAgentMcpServers(roleId: string, serverIds: string[]) {
  return request(`/agents/${encodeURIComponent(roleId)}/mcp-servers`, {
    method: "PUT",
    body: JSON.stringify({ serverIds }),
  });
}

// MCP Phase 4 — CLI bridge (visibility into skills + MCP across CLIs).
export type CliRuntime = "codex" | "claude-code" | "opencode";

export type SkillStatus =
  | { kind: "magister-pool" }
  | { kind: "magister-symlinked"; cli: CliRuntime; symlinkTarget: string }
  | { kind: "cli-private"; cli: CliRuntime; path: string }
  | { kind: "missing"; cli: CliRuntime; expectedPath: string };

export type SkillScanRow = {
  name: string;
  poolPath: string | null;
  description?: string;
  perCli: Partial<Record<CliRuntime, SkillStatus>>;
};

export type ExternalMcpServer = {
  name: string;
  cli: CliRuntime;
  source: "shell-out" | "config-file";
  scope?: string;
  type?: "stdio" | "http" | "sse" | "remote" | "local";
  command?: string[];
  url?: string;
  raw: Record<string, unknown>;
};

export type CliBridgeScan = {
  skills: { inPool: SkillScanRow[]; cliPrivate: SkillScanRow[] };
  mcpByCli: Record<CliRuntime, ExternalMcpServer[]>;
  errors: Array<{ cli: string; message: string }>;
};

export async function scanCliBridges() {
  return request<CliBridgeScan>("/cli-bridge/scan");
}

export async function promoteCliSkill(input: { name: string; sourceCli: CliRuntime }) {
  return request<{ ok: boolean; poolPath: string; symlinkedCli: CliRuntime[]; message?: string }>(
    "/cli-bridge/skills/promote",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function syncCliSkill(name: string) {
  return request<{
    ok: boolean;
    symlinksCreated: CliRuntime[];
    symlinksRemovedStale: CliRuntime[];
    warnings: string[];
  }>("/cli-bridge/skills/sync", { method: "POST", body: JSON.stringify({ name }) });
}

export async function importExternalMcp(input: { cli: CliRuntime; name: string }) {
  return request<{
    id: string;
    propagation: {
      pushed: CliRuntime[];
      removed: CliRuntime[];
      warnings: string[];
      errors: Array<{ cli: CliRuntime; phase: string; message: string }>;
    };
    warnings: string[];
  }>("/cli-bridge/mcp/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Stage 4: MCP drift detection types + API call.
export type DriftEntry = {
  kind: "removed-externally" | "added-externally" | "modified-externally";
  cli: CliRuntime;
  name: string;
};

export async function getMcpDrift() {
  return request<{ drift: DriftEntry[] }>("/cli-bridge/drift");
}

export type ActiveTeammate = {
  runId: string;
  role: string;
  state: string;
  spawnedAtMs: number;
  elapsedSec: number;
};

export async function getActiveTeammates(taskId: string): Promise<{ active: ActiveTeammate[] }> {
  return request<{ active: ActiveTeammate[] }>(`/tasks/${encodeURIComponent(taskId)}/active-teammates`);
}

// CLI agent onboarding status — install + login state for the three
// external coding-agent CLIs (codex / claude-code / opencode), shown
// in Settings → Setup. See backend cli-agent-status-service.ts.
export type CliAgentStatus = {
  cli: "codex" | "claude-code" | "opencode";
  label: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  installHint: string;
  loginHint: string;
};

export async function getCliAgentStatus(): Promise<{ items: CliAgentStatus[] }> {
  return request<{ items: CliAgentStatus[] }>("/cli-agents/status");
}

// ── Onboarding wizard (Settings → Setup) ──────────────────────────────
// Backend: onboarding-status-service / onboarding-provider-service / feishu.

export type OnboardingProviderPreset = {
  id: string;
  label: string;
  vendor: string;
  apiDialect: string;
  baseUrl: string;
  defaultModel: string;
  requiresBaseUrl: boolean;
};

export type FeishuFieldSnapshot = { present: boolean; redactedValue: string };

export type FeishuSetupState = {
  provider: "feishu";
  mode: "websocket" | "webhook";
  ready: boolean;
  valid: boolean;
  missingFields: string[];
  fields: {
    appId: FeishuFieldSnapshot;
    appSecret: FeishuFieldSnapshot;
    verificationToken: FeishuFieldSnapshot;
    encryptKey: FeishuFieldSnapshot;
  };
};

export type FeishuGatewayStatus = { connectionState?: string; lastError?: string | null } & Record<string, unknown>;

export type OnboardingStatus = {
  providers: { total: number; readyCount: number; configured: boolean };
  cliAgents: { items: CliAgentStatus[]; anyReady: boolean };
  feishu: { state: FeishuSetupState; channelsDisabled: boolean; gateway: FeishuGatewayStatus };
  complete: boolean;
};

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  return request<OnboardingStatus>("/onboarding/status");
}

export async function getOnboardingProviderPresets(): Promise<OnboardingProviderPreset[]> {
  const data = await request<{ items: OnboardingProviderPreset[] }>("/onboarding/provider-presets");
  return data.items ?? [];
}

export async function configureOnboardingProvider(input: {
  presetId: string;
  apiKey: string;
  modelName?: string;
  baseUrl?: string;
}): Promise<{ providerId: string; modelName: string }> {
  return request<{ providerId: string; modelName: string }>("/onboarding/provider", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function saveFeishuCredentials(input: {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
}): Promise<{ state: FeishuSetupState; gateway: FeishuGatewayStatus }> {
  return request<{ state: FeishuSetupState; gateway: FeishuGatewayStatus }>("/feishu/setup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
