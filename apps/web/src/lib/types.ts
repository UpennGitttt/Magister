export type WorkspaceSummary = {
  activeTaskCount: number;
  blockedTaskCount: number;
  failedRunCount: number;
  pendingApprovalCount: number;
  degradedAdapterCount: number;
  taskQueue?: Array<{
    taskId: string;
    title: string;
    state: string;
    source: string;
    workspaceId: string;
    updatedAt: string;
    latestAnswer?: string | null;
    nextWorkItemSummary?: string | null;
    nextWorkItemWhyThisWorkItem?: string | null;
    executionMode?: string | null;
    nextCapability?: string | null;
    waitReason?: string | null;
    nextWakeupAt?: string | null;
    blockedNarrative?: TaskBlockedNarrative;
    latestBlocker?: string;
    approvalState?: string;
    leaderConfidence?: string | null;
    leaderWarnings?: string[];
    managerConfidence?: string | null;
    managerWarnings?: string[];
    plannerConfidence?: string | null;
    needsHuman?: boolean | null;
  }>;
  attentionItems?: Array<{
    id: string;
    type: "approval_pending" | "task_blocked" | "manager_attention" | "planner_attention" | "executor_degraded";
    severity: "info" | "warn" | "error";
    occurredAt: string;
    title: string;
    summary: string;
    taskId?: string | null;
    runId?: string | null;
    roleId?: string | null;
    adapterId?: string | null;
  }>;
  recentImportantEvents: Array<{
    id: string;
    type: string;
    severity?: string | null;
    occurredAt: string;
    taskId?: string | null;
    taskTitle?: string | null;
    summary?: string | null;
    roleId?: string | null;
    executorId?: string | null;
  }>;
};

export type WorkspaceInsights = {
  recentFailures: Array<{
    id: string;
    taskId?: string | null;
    runId?: string | null;
    roleId?: string | null;
    executorId?: string | null;
    summary: string;
    occurredAt: string;
  }>;
  recentPullRequests: Array<{
    id: string;
    taskId: string;
    runId?: string | null;
    title: string;
    url: string;
    summary?: string;
    occurredAt: string;
  }>;
  recentMemoryCandidates: Array<{
    id: string;
    taskId?: string | null;
    runId?: string | null;
    title: string;
    summary: string;
    scope: string;
    status: string;
    occurredAt: string;
  }>;
  executorSlots: Array<{
    adapterId: string;
    displayName: string;
    roleTargets: string[];
    configKey: string;
    executionMode: string;
    status: "configured" | "unconfigured";
    configuredModel?: string;
    configSource: "file" | "env" | "default";
    notes: string;
  }>;
};

export type SystemStatus = {
  workers: {
    artifactRetention: {
      enabled: boolean;
      inFlight: boolean;
      intervalMs: number;
      graceMs: number;
      lastTickAt: string | null;
      lastWindowStart: string | null;
      lastScannedTaskCount: number;
      lastEligibleTaskCount: number;
      lastCleanedTaskIds: string[];
      lastDeletedArtifactIds: string[];
      lastFailedTaskIds: string[];
      lastFailureAt: string | null;
      lastFailureTaskId: string | null;
      lastFailureMessage: string | null;
    };
    runtimeRecovery: {
      enabled: boolean;
      inFlight: boolean;
      intervalMs: number;
      staleRunningThresholdMs: number;
      stuckTaskThresholdMs: number;
      maxAttempts: number;
      lastTickAt: string | null;
      lastScannedRunningCount: number;
      lastScannedTaskCount: number;
      lastRecoveredRunIds: string[];
      lastResumedTaskIds: string[];
      lastBlockedRunIds: string[];
    };
    taskWorker: {
      concurrency: number;
      activeCount: number;
      queuedCount: number;
      activeIds: string[];
      queuedIds: string[];
    };
  };
  integrations: {
    feishuGateway: {
      mode: string;
      disabled?: boolean;
      configured: boolean;
      running: boolean;
      connectionState: "idle" | "starting" | "running" | "stopped" | "error";
      startedAt?: string;
      stoppedAt?: string;
      lastError?: string;
      messageEvents: number;
      cardActionEvents: number;
      reconnectInfo?: {
        lastConnectTime?: number;
        nextConnectTime?: number;
      };
      lastInboundError?: string;
      lastInboundEventType?: string;
    };
  };
};

export type ProviderConfig = {
  id: string;
  label?: string | null;
  vendor?: string | null;
  transport: string;
  apiDialect?: string;
  baseUrl?: string | null;
  auth?: {
    kind?: string;
    secretRef?: string | null;
    headerName?: string | null;
    prefix?: string | null;
  } | null;
  headers?: Array<{
    name: string;
    value?: string | null;
    secretRef?: string | null;
    envRef?: string | null;
  }>;
  readiness?: { ready: boolean; missing: string[] };
};

export type AgentProfile = {
  roleId: string;
  label: string;
  description?: string | null;
  systemPromptOverride?: string | null;
  modelName?: string | null;
  modelOverride?: string | null;
  providerId?: string | null;
  reasoningMode?: string | null;
  reasoningEffort?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  fallbackModelName?: string | null;
  fallbackProviderId?: string | null;
  status?: string | null;
  mcpConfig?: string | null;
  maxConcurrentTasks?: number | null;
  runtimeType?: "ucm" | "codex" | "opencode" | "claude-code" | "kiro" | null;
  provider?: string | null;
  commandPath?: string | null;
  customEnv?: string | null;
  customArgs?: string | null;
  maxTurns?: number | null;
  toolProfile?: "full" | "coding" | "research" | "minimal" | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  isBuiltin?: number | null;
};

export type DiscoveredModel = {
  id: string;
  provider: string;
  label: string;
  isDefault?: boolean;
};

export type ProviderList = {
  items: ProviderConfig[];
};

export type ModelProfile = {
  id: string;
  label?: string | null;
  vendor?: string | null;
  modelName: string;
  fallbacks?: string[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  providerRefs?: {
    cli?: string | null;
    api?: string | null;
  } | null;
  defaultReasoning?: {
    mode?: "off" | "auto" | "on";
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    budgetTokens?: number | null;
    visibility?: string;
  } | null;
  /** Free-form bag of capability flags used to gate model selection at
   *  the Magister layer (not the provider's own capability advertisement).
   *  Conventional keys: `vision: boolean`. Other consumers may add
   *  more without backend schema changes. */
  capabilityHints?: Record<string, unknown> | null;
  requestOverrides?: Record<string, unknown> | null;
  readiness?: { ready: boolean; missing: string[]; thinkingReady?: boolean };
};

export type ModelList = {
  items: ModelProfile[];
};

export type ExecutorBinding = {
  adapterId: string;
  executionMode: "cli" | "api";
  modelRef: string;
  providerRef?: string | null;
  timeoutMs?: number | null;
  commandPath?: string | null;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | string | null;
  readiness?: { ready: boolean; missing: string[] };
};

export type BindingList = {
  items: ExecutorBinding[];
};

export type ProviderPreset = {
  id: string;
  label: string;
  vendor: string;
  transport: "cli" | "api";
  apiDialect: string;
  baseUrl: string;
  auth: {
    kind: string;
    secretRef?: string;
    headerName?: string;
    prefix?: string;
  };
};

export type ProviderPresetList = {
  items: ProviderPreset[];
};

export type SecretItem = {
  secretRef: string;
  status?: "present" | "missing" | "unknown" | string;
  updatedAt?: string | null;
  usedBy?: string[];
  notes?: string | null;
};

export type SecretList = {
  items: SecretItem[];
};

export type RoleRoutingList = {
  items: Array<{
    roleId: string;
    adapterId: string;
    strategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
    fallbackAdapterId?: string;
    source: "default" | "file";
    allowedAdapterIds: string[];
  }>;
};

export type CreateTaskResult = {
  taskId: string;
  runId: string;
  /**
   * Per-prompt scope identifier (PR 1 of the chat data-flow refactor).
   * Threaded through every event stamped by the leader-event-projector
   * so the frontend's chatStore can route deltas to the right Exchange.
   */
  requestId: string;
  action: "new_session" | "resumed_session";
  reason: string;
  status?: "queued" | "completed";
  finalAnswer?: string;
};

export type GoalStatus = "active" | "paused" | "complete" | "cancelled";

export type ChangeReviewDecisionState =
  | "pending"
  | "not_required"
  | "approved"
  | "rejected"
  | "superseded"
  | "revision_requested";

export type ChangeReviewApplyState =
  | "not_applied"
  | "applying"            // Leader has claimed the slot
  | "applied"
  | "apply_failed"
  | "partially_applied";  // catastrophic — apply succeeded, rollback failed

export type ChangeReviewChangedFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isExecutable: boolean;
};

export type ChangeReviewSummary = {
  id: string;
  taskId: string;
  roleRuntimeId: string | null;
  runtimeSource: string;
  permissionMode: string;
  runtimeWorkspaceStrategy: string;
  risk: "AUTO_OK" | "HUMAN_REQUIRED" | string;
  decisionState: ChangeReviewDecisionState;
  applyState: ChangeReviewApplyState;
  diffHash: string;
  baseRevision: string | null;
  changedFiles: ChangeReviewChangedFile[];
  addedLines: number;
  removedLines: number;
  reasonCodes: string[];
  sideEffectWarningCode: string | null;
  // assignee = 'user' (operator queue) | 'leader' (Leader's inbox).
  // leaderApplyCommitSha is set when Leader auto-applied this patch
  // so the operator can render a `git revert <sha>` link.
  assignee: "user" | "leader";
  assigneeSetBy: "router" | "leader" | "manual" | null;
  leaderApplyCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChangeReviewExecutionSandbox = {
  mode: "off" | "optional" | "required" | string;
  provider: "none" | "bubblewrap" | string;
  status: "disabled" | "unavailable" | "available" | "active" | string;
  commandPath: string | null;
  reason: string | null;
  network: "host" | "disabled" | "unknown" | string;
  filesystem: {
    mainWorkspace: string;
    runtimeWorkspace: string;
    home: string;
    tmp: string;
  };
};

export type ChangeReviewDetail = ChangeReviewSummary & {
  artifactIds: {
    reviewDraftArtifactId: string;
    diffArtifactId: string;
    gateArtifactId: string | null;
  };
  runtimeSecurity: {
    runtimeSource: string;
    commandPath: string | null;
    argvFlags: string[];
    sandboxMode: string | null;
    permissionMode: string;
    permissionSignals: string[];
    envPermissionHints: string[];
    runtimeWorkspaceStrategy: string;
    executionSandbox: ChangeReviewExecutionSandbox | null;
  };
  diffAlgorithm: Record<string, unknown>;
  riskReasons: Array<{
    code?: string;
    message?: string;
    [key: string]: unknown;
  }>;
  verification: unknown[];
  sastAdvisory: {
    status: "skipped" | "passed" | "findings" | "error" | "timed_out" | string;
    scanner: "semgrep" | "unknown" | "none" | string;
    reason: string | null;
    findings: Array<{
      scanner: string;
      ruleId: string;
      severity: string;
      path: string;
      line: number | null;
      message: string;
      metadata: Record<string, unknown>;
    }>;
    command: string[] | null;
    durationMs: number | null;
    startedAt: string;
    finishedAt: string;
  } | null;
  reviewerVerdicts: unknown[];
  sideEffectWarning: Record<string, unknown> | null;
  // Server-precomputed Apply-time guard. Present when the API was
  // able to run the lightweight probe (workspace lookup + git rev-parse
  // HEAD); absent when the probe itself errored (in which case treat
  // as "unknown" and don't block UI). When applicable is false, the
  // Apply button should be disabled and the patch flagged "Stale" so
  // the operator knows their approve
  // click won't actually land.
  applicability?:
    | { applicable: true }
    | {
        applicable: false;
        code:
          | "workspace_missing"
          | "base_revision_missing"
          | "base_revision_unreadable"
          | "base_revision_mismatch"
          | "workspace_status_unreadable"
          | "workspace_dirty"
          | "patch_unreadable"
          | "patch_hash_mismatch"
          | "patch_check_failed";
        reason: string;
        currentHead?: string;
        baseRevision?: string | null;
      };
};

export type ChangeReviewDiffPreview = {
  reviewId: string;
  diffArtifactId: string;
  diffHash: string;
  byteLength: number;
  maxBytes: number;
  truncated: boolean;
  patch: string;
};

export type TaskSummary = {
  id: string;
  title: string;
  state: string;
  source?: string;
  workspaceId: string;
  rootChannelBindingId?: string | null;
  latestRunId?: string;
  /** Goal mode (Ralph loop) — null `goalObjective` means an
   *  ordinary chat task. When present, the task auto-continues
   *  after each leader turn until the model calls
   *  `mark_goal_complete`, the user pauses/cancels, or
   *  `goalMaxWallSeconds` elapses. */
  goalObjective?: string | null;
  goalStatus?: GoalStatus | null;
  goalStartedAt?: number | null;
  /** Frozen-at terminal timestamp. When set, GoalPill stops the
   *  elapsed-time counter here instead of using Date.now(). */
  goalCompletedAt?: number | null;
  /** Goal v2 fields. */
  goalId?: string | null;
  goalTokenBudget?: number | null;
  goalPlanPath?: string | null;
  goalMaxWallSeconds?: number | null;
  goalIterations?: number | null;
  goalTokensUsed?: number | null;
  /** Goal v2 verifier fields surfaced by the backend
   *  materialize-task-summary-service. UI doesn't render them yet but
   *  the type was missing them — adding for type safety so any future
   *  verifier-result panel compiles cleanly. */
  goalLastVerifierVerdict?: string | null;
  goalLastVerifierAt?: number | null;
  goalLastVerifierBlocker?: string | null;
  /** User-added subgoals (mid-flight criteria). */
  goalSubgoals?: string[] | null;
  /** Set when user just edited the objective. */
  goalObjectiveEditedAt?: number | null;
  /** Consecutive evaluator parse failures. */
  goalEvaluatorParseFailures?: number | null;
  currentLeaderSessionId?: string;
  latestBlocker?: string;
  approvalState?: string;
  latestArtifactSummary?: string;
  latestAnswer?: string | null;
  nextWorkItemSummary?: string | null;
  nextWorkItemWhyThisWorkItem?: string | null;
  executionMode?: string | null;
  nextCapability?: string | null;
  waitReason?: string | null;
  nextWakeupAt?: string | null;
  recoveryNotice?: {
    status: "recovered" | "blocked";
    occurredAt: string;
    reason: string;
    previousState: string | null;
    nextState: string | null;
    requiresUserAction: boolean;
    runId: string | null;
  };
  blockedNarrative?: TaskBlockedNarrative;
  needsHuman?: boolean | null;
  leaderConfidence?: string | null;
  leaderWarnings?: string[];
  managerConfidence?: string | null;
  managerWarnings?: string[];
  plannerConfidence?: string | null;
  plannerWarnings?: string[];
  prUrl?: string;
  updatedAt: string;
  /** Board Attention dismissal. Set when the user clicks "Dismiss"
   *  on a failed/blocked task. UI-only signal: `state` stays unchanged;
   *  Board's `mapTaskToColumn` reads this to bucket the task as
   *  "completed" instead of "attention". Epoch-ms. */
  attentionDismissedAt?: number | null;
};

export type TaskBlockedNarrative = {
  reason:
    | "awaiting_approval"
    | "awaiting_plan_approval"
    | "paused_by_user"
    | "cancel_requested"
    | "runtime_recovery_in_progress"
    | "blocked_by_recovery"
    | "executor_unavailable"
    | "rate_limited"
    | "model_unavailable"
    | "max_turns_reached";
  status: "waiting" | "recovering" | "blocked" | "failed";
  severity: "info" | "warn" | "error";
  message: string;
  nextAction: string | null;
  occurredAt: string | null;
  source: string;
};

export type TaskStats = {
  totalTasks: number;
  activeTasks: number;
  completedToday: number;
  failedToday: number;
  avgCompletionMs: number | null;
  completionSampleSize: number;
  recentTeammateSpawns: Array<{
    roleId: string;
    count: number;
    lastSpawnedAt: string;
  }>;
};

export type RunSummary = {
  id: string;
  taskId: string;
  roleId: string;
  state: string;
  executorId?: string | null;
  sessionId?: string | null;
  parentRunId?: string | null;
  lastError?: string;
  latestArtifactSummary?: string;
  leaderDecision?: ManagerDecisionSummary | null;
  managerDecision?: ManagerDecisionSummary | null;
  updatedAt: string;
};

export type ManagerDecisionSummary = {
  parsedDecision?: Record<string, unknown> | null;
  rawOutput?: string | null;
  fallbackReason?: string | null;
  sourceKind?: string;
  sourceDegraded?: boolean;
  sourceUnavailableReason?: string | null;
  sourceArtifactId?: string;
  sourceArtifactType?: string;
  sourceArtifactTitle?: string;
  sourceArtifactSummary?: string | null;
};

export type DecisionProvenance = {
  source: "structured_decision" | "heuristic_fallback";
  runId: string;
  roleId: string;
  fallbackReason: string | null;
};

export type RunContextEvent = {
  id: string;
  type: string;
  severity?: string | null;
  occurredAt: string;
  message?: string;
  source?: string;
  command?: string;
  payloadJson?: string | null;
};

export type RunContext = {
  run: RunSummary;
  metadata: {
    attemptCount: number;
    semanticRole?: "manager_agent" | "delegated_subagent";
    leaderSemanticRole?: "leader_agent" | "delegated_subagent";
    delegationMode?: string | null;
    sessionId?: string | null;
    priorSessionId?: string | null;
    priorWorkdir?: string | null;
    resumePolicy?: string | null;
    resumeAttemptedAt?: string | null;
    resumeFailureReason?: string | null;
    continuityDecision?: Record<string, unknown> | null;
    leaderDecision?: ManagerDecisionSummary | null;
    leaderDecisionProvenance?: DecisionProvenance | null;
    managerDecision?: ManagerDecisionSummary | null;
    managerDecisionProvenance?: DecisionProvenance | null;
    startedAt?: string | null;
    completedAt?: string | null;
  };
  recentEvents: RunContextEvent[];
  artifacts: Artifact[];
  nextAction: {
    kind: "retry" | "inspect" | "continue";
    message: string;
  };
};

export type Approval = {
  id: string;
  taskId: string;
  roleRuntimeId?: string | null;
  approvalType: string;
  state: string;
  requestedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
};

export type Artifact = {
  id: string;
  taskId: string;
  roleRuntimeId?: string | null;
  artifactType: string;
  title: string;
  storageKind: string;
  storageRef: string;
  summary?: string | null;
  createdAt: string;
};

export type AdapterHealth = {
  adapterId: string;
  displayName: string;
  healthState: "idle" | "active" | "degraded";
  activeSessionCount: number;
  lastError?: string;
};

export type MemoryLink = {
  slot: string;
  summary: string;
  sourceType: "task" | "artifact" | "event";
  sourceId: string;
};

export type MemoryCandidate = {
  id: string;
  title: string;
  summary: string;
  scope: string;
  status: string;
  sourceRunId?: string | null;
};

export type TaskMemoryView = {
  linkedMemories: {
    project: MemoryLink[];
    repo: MemoryLink[];
    task: MemoryLink[];
  };
  candidates: MemoryCandidate[];
};

export type TaskContextPlan = {
  decisionMode?: "direct_answer" | "tool_answer" | "clarify" | "heuristic" | "explicit_hints";
  coordinationAction?:
    | "direct_answer"
    | "tool_answer"
    | "clarify"
    | "assign"
    | "handoff"
    | "send_message";
  planningMode?: "conversational_shortcut" | "information_shortcut" | "heuristic" | "explicit_hints";
  executionMode?: "immediate" | "bounded_execution" | "long_running";
  taskType: "conversation" | "coding" | "mixed";
  goal?: string;
  needsHuman?: boolean;
  confidence?: "high" | "medium" | "low";
  stopCondition?: string;
  source?: string;
  warnings?: string[];
  detectedSignals?: string[];
  childRuns: Array<{
    roleId: string;
    state: "CREATED" | "QUEUED";
    dependsOn: string[];
    goal?: string;
    whyThisWorkItem?: string;
    completionSignal?: string;
    handoffNotes?: string;
    primaryAdapterId?: string;
    routingStrategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
    fallbackAdapterId?: string;
    executorClass?: "coding_agent" | "model" | string;
  }>;
} | null;

export type TaskContextToolEvent = {
  type: "tool.call" | "tool.result" | "tool.error";
  toolName: string;
  summary: string;
  occurredAt: string;
  step?: number;
  status?: "in_progress" | "succeeded" | "failed";
  source?: string;
  toolCallId?: string;
  startedAt?: string;
  latencyMs?: number;
  arguments?: Record<string, unknown>;
  result?: unknown;
  resultSummary?: string;
  errorMessage?: string;
};

export type TaskContext = {
  taskGraph: {
    nodes: Array<{
      id: string;
      kind: "task" | "run";
      label: string;
      state: string;
      roleId?: string;
    }>;
    edges: Array<{
      source: string;
      target: string;
      kind: "owns" | "depends_on";
    }>;
  };
  roleLanes: Array<{
    roleId: string;
    semanticRole?: "manager_agent" | "delegated_subagent";
    leaderSemanticRole?: "leader_agent" | "delegated_subagent";
    state: string;
    runId?: string;
    executorId?: string | null;
    parentRunId?: string | null;
    attemptCount: number;
    updatedAt: string;
    lastError?: string;
    latestArtifactSummary?: string;
    approvalState?: string;
    dependsOn?: string[];
    plannedState?: "CREATED" | "QUEUED";
    primaryAdapterId?: string;
    routingStrategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
    fallbackAdapterId?: string;
    executorClass?: "coding_agent" | "model" | string;
  }>;
  leaderSemanticOwner?: "leader_agent";
  semanticOwner?: "manager_agent";
  currentExecutionRole?: string;
  currentResponsibleRole: string;
  leaderPlan?: TaskContextPlan;
  managerPlan?: TaskContextPlan;
  workItems?: Array<{
    roleId: string;
    state: "CREATED" | "QUEUED";
    dependsOn: string[];
    goal?: string;
    whyThisWorkItem?: string;
    completionSignal?: string;
    handoffNotes?: string;
    runtimeState: string;
    executionStatus: "ready" | "waiting_on_dependencies" | "running" | "completed" | "blocked";
    primaryAdapterId?: string;
    routingStrategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
    fallbackAdapterId?: string;
    executorClass?: "coding_agent" | "model" | string;
    runId?: string;
    executorId?: string | null;
    summary?: string;
  }>;
  leaderToolEvents?: TaskContextToolEvent[];
  managerToolEvents?: TaskContextToolEvent[];
};

export type TaskOrchestrationHistory = {
  taskId: string;
  items: Array<{
    id: string;
    sourceEventType: string;
    type:
      | "task.manager.plan_created"
      | "task.work_items.updated"
      | "task.orchestration.transition"
      | "task.orchestration.waiting"
      | "task.orchestration.stopped";
    occurredAt: string;
    summary: string;
    latestAnswer?: string;
    nextCapability?: string;
    roleRuntimeId?: string;
    roleId?: string;
    taskState?: string;
    transition?: string;
    action?: string;
    stopReason?: string;
    waitReason?: string;
    nextWakeupAt?: string;
    nextRoleId?: string;
    createdRoleIds?: string[];
    managerPlan?: TaskContext["managerPlan"];
    workItems?: TaskContext["workItems"];
  }>;
};

export type TaskStreamSnapshot = {
  task: TaskSummary;
  events: Array<{
    id: string;
    type: string;
    severity?: string | null;
    occurredAt: string;
    payloadJson?: string | null;
  }>;
  /** Per-task attachments grouped by upload `requestId`. The
   *  frontend uses this to re-render user-bubble file chips after
   *  a page reload — without it, chips only live in the chatStore
   *  optimistic state and disappear on refresh. Storage path is
   *  intentionally NOT included (irrelevant to the UI, small
   *  info-disclosure). */
  attachments?: Array<{
    requestId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
};

export type TaskTreeNodeArtifact = {
  id: string;
  path: string;
  summary: string | null;
  createdAt: string;
};

export type TaskTreeNodeEvent = {
  id: string;
  eventType: string;
  summary: string;
  createdAt: string;
};

export type TaskTreeNode = {
  id: string;
  type: "task" | "user_message" | "leader_response" | "tool_call" | "tool_result" | "teammate";
  label: string;
  state: "running" | "completed" | "failed" | "pending";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  children: TaskTreeNode[];
  metadata?: Record<string, unknown>;
  artifacts?: TaskTreeNodeArtifact[];
  recentEvents?: TaskTreeNodeEvent[];
};

export type TaskTreeStats = {
  totalNodes: number;
  userMessages: number;
  toolCalls: number;
  teammates: number;
};

export type TaskTreeResponse = {
  root: TaskTreeNode;
  stats: TaskTreeStats;
};

/** Wire shape of `GET /status`. Mirrors `StatusReport` in
 *  `apps/api/src/services/status-service.ts`. Token usage + rate
 *  limits are intentionally absent here (they live on the dashboard,
 *  not the status panel). */
/** Path A — per-machine workspace registry view. Wire shape of
 *  `GET /workspaces` items + the create/update payloads. */
export type WorkspaceView = {
  id: string;
  label: string;
  basePath: string;
  isDefault: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type CreateWorkspaceRequest = {
  id: string;
  label: string;
  basePath: string;
  isDefault?: boolean;
};

export type UpdateWorkspaceRequest = {
  label?: string;
  basePath?: string;
};

export type StatusReport = {
  workspace: {
    cwd: string;
    agentsFile: { found: boolean; path: string | null };
    git: { branch: string | null; isClean: boolean | null };
  };
  /** Path A — which workspace this snapshot reflects. */
  activeWorkspace: { id: string; label: string } | null;
  agents: Array<{
    roleId: string;
    label: string;
    runtimeType: string;
    modelName: string | null;
    providerLabel: string | null;
    skillsCount: number;
    mcpServersCount: number;
  }>;
  mcp: Array<{
    id: string;
    name: string;
    enabled: boolean;
    status: string;
    toolCount: number | null;
    lastError: string | null;
  }>;
  skills: {
    total: number;
    bySource: { github: number; manual: number };
  };
  /** Multi-task — changed the wire from a single
   *  nullable record to an array (cap 5) so parallel executions
   *  aren't silently flattened. */
  activeTasks: Array<{
    id: string;
    title: string | null;
    state: string;
    startedAt: string;
    updatedAt: string;
  }>;
  /** Per-session block — populated only when /status was called
   *  with `?taskId=...`. Surfaces the chat-thread-level details
   *  (state, agent, model, token usage) the workspace-level
   *  snapshot otherwise hides. */
  currentSession: {
    taskId: string;
    title: string | null;
    state: string;
    workspaceId: string;
    agent: {
      roleId: string;
      label: string;
      runtimeType: string;
      modelName: string | null;
      providerLabel: string | null;
    } | null;
    startedAt: string;
    updatedAt: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      turnCount: number;
      models: string[];
      /** False when the in-process token store has no records for
       *  this task — likely means the server was restarted since
       *  the task ran. UI annotates with "(no usage tracked since
       *  restart)" rather than misleading bare zeros. */
      tracked: boolean;
    };
  } | null;
};

export type TurnTimingSummary = {
  startedAtMs: number;
  completedAtMs: number;
  wallMs: number;
  pausedMs: number;
  elapsedMs: number;
};

export type TurnUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type TurnToolSummary = {
  readCount: number;
  writeCount: number;
  approvalCount: number;
  delegationCount: number;
  failedCount: number;
  totalCount: number;
};

export type TurnSummary = {
  requestId: string;
  status: "running" | "completed" | "failed";
  timing?: TurnTimingSummary;
  usage: TurnUsageSummary | null;
  toolSummary: TurnToolSummary;
};
