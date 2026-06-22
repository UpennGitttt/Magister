import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  state: text("state").notNull(),
  priority: text("priority"),
  rootChannelBindingId: text("root_channel_binding_id"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  // Goal mode (Ralph loop). NULL goalObjective = ordinary task.
  // When set, after each leader-loop turn the worker auto-injects a
  // "continue toward goal" mailbox row instead of marking the task
  // DONE — until the model calls `mark_goal_complete`, the user
  // cancels/pauses, or wall-time runs out.
  //
  // No token budget: keeping `goalTokensUsed` for telemetry only,
  // no enforcement column. `goalMaxWallSeconds` is the only hard
  // safety; NULL = unlimited.
  goalObjective: text("goal_objective"),
  goalStatus: text("goal_status"), // active | paused | complete | cancelled
  goalStartedAt: integer("goal_started_at"),
  goalMaxWallSeconds: integer("goal_max_wall_seconds"),
  goalIterations: integer("goal_iterations").default(0),
  goalTokensUsed: integer("goal_tokens_used").default(0),
  // frozen-at terminal timestamp. Set when goal transitions
  // to complete / paused / cancelled. Frontend computes elapsed as
  // `(goalCompletedAt ?? Date.now()) - goalStartedAt`, so the counter
  // stops at terminal transition instead of ticking forever as the
  // chat task accepts follow-up turns. Cleared by goal/resume.
  goalCompletedAt: integer("goal_completed_at"),
  // goal-mode v2 overhaul (codex /goal + Ralph patterns).
  //   goalId          : UUID per goal-version. Mutations carry
  //                     `expected_goal_id`; mismatches return an
  //                     explicit refusal (race protection on /goal
  //                     re-issue).
  //   goalTokenBudget : soft cap. When `goalTokensUsed >=
  //                     goalTokenBudget`, continuation injects a
  //                     "wrap up" steering message — model is asked
  //                     to mark complete or stop in the next 1-2
  //                     turns. NULL = unlimited (current behavior).
  //   goalPlanPath    : relative path to the goal's plan.md artifact,
  //                     typically `.magister/goals/<task_id>/plan.md`.
  //                     Source of truth for "what needs to be done"
  //                     across iterations; survives compaction.
  //   See docs/plans/2026-05-12-goal-mode-overhaul.md for design.
  goalId: text("goal_id"),
  goalTokenBudget: integer("goal_token_budget"),
  goalPlanPath: text("goal_plan_path"),
  // 2026-05-12 goal v2 — Phase 4 (external verifier).
  //   goalLastVerifierVerdict:  "READY" | "BLOCKED" | NULL.
  //     Set by spawn_teammate when an evaluator finishes, read by
  //     mark_goal_complete to gate completion. Cleared (set NULL)
  //     when the goal returns to "active" so a stale READY can't
  //     trigger a later mark_goal_complete after the model resumed
  //     additional work.
  //   goalLastVerifierAt:       epoch-ms of the verdict.
  //   goalLastVerifierBlocker:  the BLOCKED reason text (verbatim
  //     from evaluator), surfaced in the next continuation prompt.
  goalLastVerifierVerdict: text("goal_last_verifier_verdict"),
  goalLastVerifierAt: integer("goal_last_verifier_at"),
  goalLastVerifierBlocker: text("goal_last_verifier_blocker"),
  // 2026-05-21 v3 §P0-2 — user-controlled subgoals (mid-flight
  // criteria refinement). JSON-serialized array of strings appended
  // by the user via POST /tasks/:id/goal/subgoals while the loop
  // is running. The continuation template injects them as
  // "Additional criteria added by user mid-flight" and the evaluator
  // is told to verify each one alongside the main acceptance
  // criteria. NULL / "[]" = none.
  goalSubgoals: text("goal_subgoals"),
  // 2026-05-21 v3 §P1-5 — mid-flight objective edit timestamp. Set
  // when the user PATCHes the objective; the next continuation uses
  // objective_updated.md (with <untrusted_objective> wrapping +
  // "avoid continuing work that only served the previous objective")
  // for ONE iteration, then this is cleared and normal continuation
  // resumes. Also clears `goalLastVerifier*` since a verdict for the
  // old objective doesn't apply to the new one.
  goalObjectiveEditedAt: integer("goal_objective_edited_at"),
  // 2026-05-21 v3 §P1-8 — consecutive evaluator parse failures.
  // The evaluator must end its assistant reply with
  // "Overall verdict: READY" or "Overall verdict: BLOCKED — <reason>";
  // weak models sometimes return prose instead and we end up in a
  // spin where no verdict is ever recorded. Counter increments on
  // each UNCLEAR parse and resets to 0 on any successful READY/BLOCKED.
  // At threshold (3) the goal auto-pauses with a "switch evaluator
  // model" hint surfaced in plan.md + the UI banner.
  goalEvaluatorParseFailures: integer("goal_evaluator_parse_failures").default(0),
  // 2026-05-07 P1 — Goose-style rolling totals updated on every
  // recordUsage call, keyed off this task. Lets /tasks/:id/usage
  // answer in O(1) without scanning token_usage_records.
  accumulatedInputTokens: integer("accumulated_input_tokens").notNull().default(0),
  accumulatedOutputTokens: integer("accumulated_output_tokens").notNull().default(0),
  accumulatedCostUsd: real("accumulated_cost_usd").notNull().default(0),
  // Spec §5 — root-level trace identifier. For a root task
  // this equals `id`; for a task derived from another (future:
  // related-task chains, scheduled spawns), this carries the root's id
  // forward. Single source of truth; events table denormalizes for
  // query speed. NULL on pre-migration rows; query helpers use
  // COALESCE(trace_id, task_id) for backward compat.
  traceId: text("trace_id"),
  // Board "Attention" column dismissal. UI-only signal:
  // task.state stays unchanged (FAILED / BLOCKED / etc.), but a
  // non-NULL `attention_dismissed_at` removes the card from the
  // Attention column so the user can clear acknowledged failures
  // without rewriting state. Read in `mapTaskToColumn` (web), undo
  // via DELETE on the dismiss endpoint within the 5s toast window.
  attentionDismissedAt: integer("attention_dismissed_at", { mode: "timestamp_ms" }),
  // 2026-05-28 — per-task leader model override. NULL = use the agent
  // profile default (resolved via `resolveAgentForRole("leader")`).
  // When set, holds a modelName that must exist as a key in
  // `config/executors.json` -> models. The active provider is
  // re-derived from `models[modelName].providerRefs.api` at each
  // runtime spawn — we do NOT cache the providerId here, so edits to
  // executors.json (moving a model between providers) don't strand
  // tasks on stale provider references. Cleared by `/model` picker's
  // "Reset to agent default" action.
  modelOverride: text("model_override"),
});

export const roleRuntimes = sqliteTable("role_runtimes", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  subtaskId: text("subtask_id"),
  roleAssignmentId: text("role_assignment_id"),
  roleId: text("role_id").notNull(),
  state: text("state").notNull(),
  delegationMode: text("delegation_mode"),
  activeExecutorId: text("active_executor_id"),
  currentSessionId: text("current_session_id"),
  priorSessionId: text("prior_session_id"),
  priorWorkdir: text("prior_workdir"),
  resumePolicy: text("resume_policy"),
  workspaceStrategyOverride: text("workspace_strategy_override"),
  resumeAttemptedAt: integer("resume_attempted_at", { mode: "timestamp_ms" }),
  resumeFailureReason: text("resume_failure_reason"),
  parentRunId: text("parent_run_id"),
  attemptCount: integer("attempt_count").notNull().default(0),
  // True when this teammate was spawned with wait: false (async mode).
  // Used to detect active background teammates when deciding whether to
  // transition the parent task to AWAITING_TEAMMATES.
  spawnedAsync: integer("spawned_async", { mode: "boolean" }).default(false),
  // Links teammates spawned together by the `spawn_teammates` batch
  // tool. NULL for single `spawn_teammate` spawns. Lets the runtime
  // treat "how many teammates should this cohort have" as a structural
  // fact (the batch's task count) rather than parsing leader prose.
  parallelGroupId: text("parallel_group_id"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const runtimeWorkspaces = sqliteTable("runtime_workspaces", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  taskId: text("task_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  roleId: text("role_id").notNull(),
  requestedStrategy: text("requested_strategy"),
  strategy: text("strategy").notNull(),
  decisionReason: text("decision_reason"),
  fallbackReason: text("fallback_reason"),
  status: text("status").notNull(),
  baseWorkspaceDir: text("base_workspace_dir").notNull(),
  workspaceDir: text("workspace_dir").notNull(),
  baseRevision: text("base_revision"),
  metadataPath: text("metadata_path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  roleRuntimeId: text("role_runtime_id"),
  approvalType: text("approval_type").notNull(),
  state: text("state").notNull(),
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  resolvedBy: text("resolved_by"),
  payloadJson: text("payload_json"),
});

export const conversationBindings = sqliteTable("conversation_bindings", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  accountId: text("account_id").notNull(),
  chatId: text("chat_id").notNull(),
  threadId: text("thread_id"),
  workspaceId: text("workspace_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  lastInboundAt: integer("last_inbound_at", { mode: "timestamp_ms" }).notNull(),
  lastEventId: text("last_event_id"),
  lastPlatformMessageId: text("last_platform_message_id"),
  lastSenderUserId: text("last_sender_user_id"),
  lastSenderDisplayName: text("last_sender_display_name"),
});

export const channelSessions = sqliteTable("channel_sessions", {
  id: text("id").primaryKey(),
  bindingId: text("binding_id").notNull(),
  channel: text("channel").notNull(),
  workspaceId: text("workspace_id").notNull(),
  continuityMode: text("continuity_mode").notNull(),
  verboseLevel: text("verbose_level").notNull().default("off"),
  currentTaskId: text("current_task_id"),
  latestInboundMessageId: text("latest_inbound_message_id"),
  latestDeliveredMessageId: text("latest_delivered_message_id"),
  latestAnswerSummary: text("latest_answer_summary"),
  currentLeaderSessionId: text("current_leader_session_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const channelInboundEventKeys = sqliteTable(
  "channel_inbound_event_keys",
  {
    bindingId: text("binding_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.bindingId, table.dedupeKey],
    }),
  }),
);

export const channelOutboundDeliveryLocks = sqliteTable("channel_outbound_delivery_locks", {
  outboundEventId: text("outbound_event_id").primaryKey(),
  state: text("state").notNull(),
  claimToken: text("claim_token"),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  roleRuntimeId: text("role_runtime_id"),
  artifactType: text("artifact_type").notNull(),
  title: text("title").notNull(),
  storageKind: text("storage_kind").notNull(),
  storageRef: text("storage_ref").notNull(),
  summary: text("summary"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const executionEvents = sqliteTable("execution_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  requestId: text("request_id"),
  taskId: text("task_id"),
  subtaskId: text("subtask_id"),
  roleRuntimeId: text("role_runtime_id"),
  executorSessionId: text("executor_session_id"),
  approvalId: text("approval_id"),
  artifactId: text("artifact_id"),
  conversationBindingId: text("conversation_binding_id"),
  workspaceId: text("workspace_id"),
  severity: text("severity"),
  payloadJson: text("payload_json"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  seq: integer("seq"),
  // full agentMeta envelope as JSON.
  // Populated by leader-event-projector. NULL on pre-migration rows.
  agentJson: text("agent_json"),
  // denormalized indexed column for the
  // teammate-transcript lazy-load endpoint. NULL for non-teammate
  // events and pre-migration rows.
  parentToolUseId: text("parent_tool_use_id"),
  // Spec §5 — denormalized mirror of `tasks.trace_id`,
  // populated by the event projector at insert time. Lets the trace
  // view fetch an entire root-rooted tree in a single indexed SELECT
  // without joining tasks. NULL on pre-migration rows; query helpers
  // use COALESCE(trace_id, task_id) for backward compat.
  traceId: text("trace_id"),
});

export type TaskInsert = typeof tasks.$inferInsert;
export type TaskSelect = typeof tasks.$inferSelect;

export type RoleRuntimeInsert = typeof roleRuntimes.$inferInsert;
export type RoleRuntimeSelect = typeof roleRuntimes.$inferSelect;

export type RuntimeWorkspaceInsert = typeof runtimeWorkspaces.$inferInsert;
export type RuntimeWorkspaceSelect = typeof runtimeWorkspaces.$inferSelect;

export type ApprovalInsert = typeof approvals.$inferInsert;
export type ApprovalSelect = typeof approvals.$inferSelect;

export type ConversationBindingInsert = typeof conversationBindings.$inferInsert;
export type ConversationBindingSelect = typeof conversationBindings.$inferSelect;

export type ChannelSessionInsert = typeof channelSessions.$inferInsert;
export type ChannelSessionSelect = typeof channelSessions.$inferSelect;

export type ChannelInboundEventKeyInsert = typeof channelInboundEventKeys.$inferInsert;
export type ChannelInboundEventKeySelect = typeof channelInboundEventKeys.$inferSelect;

export type ChannelOutboundDeliveryLockInsert = typeof channelOutboundDeliveryLocks.$inferInsert;
export type ChannelOutboundDeliveryLockSelect = typeof channelOutboundDeliveryLocks.$inferSelect;

export type ArtifactInsert = typeof artifacts.$inferInsert;
export type ArtifactSelect = typeof artifacts.$inferSelect;

export type ExecutionEventInsert = typeof executionEvents.$inferInsert;
export type ExecutionEventSelect = typeof executionEvents.$inferSelect;

export const taskMailbox = sqliteTable("task_mailbox", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  content: text("content").notNull(),
  sender: text("sender").notNull().default("user"),
  // Per-message requestId. Set when the user uploaded attachments with
  // this follow-up — the loop reads it to look up the right
  // task_attachments rows. NULL on legacy rows / text-only follow-ups.
  requestId: text("request_id"),
  // Structured metadata for system-injected messages (e.g. teammate
  // completion notifications). JSON blob; NULL on legacy rows and plain
  // user messages. Shape: { type, teammateRunId, role, status, ... }
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
});

export type TaskMailboxInsert = typeof taskMailbox.$inferInsert;
export type TaskMailboxSelect = typeof taskMailbox.$inferSelect;

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  content: text("content").notNull(),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const agentSkills = sqliteTable("agent_skills", {
  agentRole: text("agent_role").notNull(),
  skillId: text("skill_id").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentRole, table.skillId] }),
}));

// Per-instance overrides for Magister-bundled skills. The bundled SKILL.md
// files in `packages/builtin-skills/` are repo-managed defaults; a row
// in this table lets a specific role swap the body / description for
// just this instance without touching the repo. Resolution at runtime:
//   readSkillContent("magister-planning", role="leader") →
//     1. look up (role, name) in this table; if a `content_override`
//        is set, return that with the override description merged
//        into frontmatter
//     2. otherwise, fall back to the bundled file body.
//
// `description_override` and `content_override` are independent —
// users often want to tweak the description (firing condition) while
// keeping the body, or vice-versa.
//
// Multi-tenant prep: `role_id` is the only tenant key today. When
// per-user instances land, add a `user_id` column with the same
// primary-key pattern (`pk(user_id, role_id, skill_name)`).
export const skillOverrides = sqliteTable("skill_overrides", {
  roleId: text("role_id").notNull(),
  skillName: text("skill_name").notNull(),
  descriptionOverride: text("description_override"),
  contentOverride: text("content_override"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.roleId, table.skillName] }),
}));

// Per-agent MCP server attachment. Many-to-many: each row binds
// one (roleId, serverId) pair. Resolution at runtime tool-merge:
// a tool from server X is included in agent A's tool list only if
// (A.roleId, X.id) row exists. Same opt-in pattern as agentSkills.
//
// Migration semantics: at table-creation time we bootstrap every
// (existing agent profile × existing MCP server) combination so
// Phase 1 + 2 behavior is preserved — nothing silently disappears
// when this lands. After Phase 3 lands, NEW servers default to
// attached-to-leader-only (smaller blast radius); user opts into
// other roles via Settings → Agents.
export const agentMcpAttachments = sqliteTable("agent_mcp_attachments", {
  roleId: text("role_id").notNull(),
  serverId: text("server_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.roleId, table.serverId] }),
}));

export type AgentMcpAttachmentInsert = typeof agentMcpAttachments.$inferInsert;
export type AgentMcpAttachmentSelect = typeof agentMcpAttachments.$inferSelect;

export const agentProfiles = sqliteTable("agent_profiles", {
  roleId: text("role_id").primaryKey(),
  label: text("label").notNull().default(""),
  displayName: text("display_name").notNull(),
  description: text("description"),
  avatarEmoji: text("avatar_emoji").default("\u{1F916}"),
  runtimeType: text("runtime_type").default("ucm"),
  modelName: text("model_name"),
  provider: text("provider"),
  providerId: text("provider_id"),
  reasoningMode: text("reasoning_mode").default("auto"),
  reasoningEffort: text("reasoning_effort").default("medium"),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens"),
  fallbackModelName: text("fallback_model_name"),
  fallbackProviderId: text("fallback_provider_id"),
  commandPath: text("command_path"),
  customEnv: text("custom_env"),
  customArgs: text("custom_args"),
  modelOverride: text("model_override"),
  status: text("status"),
  lastHeartbeatAt: integer("last_heartbeat_at"),
  mcpConfig: text("mcp_config"),
  maxConcurrentTasks: integer("max_concurrent_tasks"),
  maxTurns: integer("max_turns").default(60),
  systemPromptOverride: text("system_prompt_override"),
  toolProfile: text("tool_profile"),
  /** JSON-encoded string[]; null = no allowlist. Empty array
   *  normalizes to null at the service layer (avoids the
   *  "block-everything" footgun). Tool names validated against the
   *  canonical registry. */
  allowedTools: text("allowed_tools"),
  /** JSON-encoded string[]; null = no denylist. Subtracted last. */
  disallowedTools: text("disallowed_tools"),
  /** When 1, `appendAgentSkills` is a no-op for this role — base
   *  system prompt is used as-is, no `# Available skills` section
   *  appended. Use for read-only/Explore-style roles whose system
   *  prompt already implies the toolset (evaluator, reviewer when
   *  it's purely a verification pass) — saves the per-turn skill
   *  metadata bytes (~500 chars × N skills). Default 0
   *  preserves the behavior every role has had until now. */
  omitSkills: integer("omit_skills").default(0),
  isBuiltin: integer("is_builtin").default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type SkillInsert = typeof skills.$inferInsert;
export type SkillSelect = typeof skills.$inferSelect;

export type AgentSkillInsert = typeof agentSkills.$inferInsert;
export type AgentSkillSelect = typeof agentSkills.$inferSelect;

export type SkillOverrideInsert = typeof skillOverrides.$inferInsert;
export type SkillOverrideSelect = typeof skillOverrides.$inferSelect;

export type AgentProfileInsert = typeof agentProfiles.$inferInsert;
export type AgentProfileSelect = typeof agentProfiles.$inferSelect;

// Per-task user attachments (images for now; PDF/DOCX/XLSX
// will reuse this table in a later phase). Files live on disk
// at `<repo>/.magister/uploads/<task_id>/<sha256>-<filename>`;
// `storage_path` records the absolute path so retention sweeps
// can unlink without recomputing it. `request_id` ties an
// attachment to a specific user prompt within a multi-turn
// task, so the leader knows which images go on which turn's
// user message.
export const taskAttachments = sqliteTable("task_attachments", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  requestId: text("request_id"),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
});

export type TaskAttachmentInsert = typeof taskAttachments.$inferInsert;
export type TaskAttachmentSelect = typeof taskAttachments.$inferSelect;

// Outbound media sent by the leader into the chat. This is distinct
// from task_attachments: task_attachments are user uploads that the
// model reads, while task_media is assistant-originated media that the
// UI renders by GET /tasks/:taskId/media/:mediaId. The endpoint is
// served behind the same single-operator trust boundary as the rest
// of /tasks/* — no per-row auth, ownership is enforced by requiring
// the (task_id, id) pair (random 8-hex suffix per id) to match.
export const taskMedia = sqliteTable("task_media", {
  id: text("id").notNull(),
  taskId: text("task_id").notNull(),
  requestId: text("request_id"),
  roleRuntimeId: text("role_runtime_id"),
  sourceToolCallId: text("source_tool_call_id"),
  sourceType: text("source_type").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  kind: text("kind").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentHash: text("content_hash").notNull(),
  storagePath: text("storage_path").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  caption: text("caption"),
  display: text("display").notNull().default("inline"),
  status: text("status").notNull().default("ready"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  retainedUntil: integer("retained_until", { mode: "timestamp_ms" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.taskId, table.id] }),
}));

export type TaskMediaInsert = typeof taskMedia.$inferInsert;
export type TaskMediaSelect = typeof taskMedia.$inferSelect;

// MCP (Model Context Protocol) server registrations. `transport`
// is "stdio" (subprocess), "http" (StreamableHTTP), or "sse"
// (SSE-based HTTP). `config_json` carries transport-specific
// fields:
//   stdio: { command: string[], env?: Record<string,string>, cwd?: string }
//   http / sse: { url: string, headers?: Record<string,string> }
// Per-server timeout in `timeout_ms` (defaults to 30 s if null).
// Enabled servers connect at leader runtime startup; disabled ones
// are kept on file but skipped.
//
// `trust_level` gates whether MCP tool calls require user
// approval. MCP = arbitrary remote code execution by definition
// (a github MCP can `delete_repo`, postgres MCP can `DROP TABLE`).
// Default is "ask" — every tool call goes through the approval
// flow. Users can mark servers they fully trust as "trusted" in
// the Settings UI to skip approval (e.g. read-only filesystem MCP
// scoped to a sandbox dir).
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  configJson: text("config_json").notNull(),
  timeoutMs: integer("timeout_ms"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  trustLevel: text("trust_level").notNull().default("ask"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type McpServerInsert = typeof mcpServers.$inferInsert;
export type McpServerSelect = typeof mcpServers.$inferSelect;

/**
 * Per-tool MCP safety policy. `mcp_servers.trust_level` is still kept
 * as a server-level default, but Phase 5 safety decisions are made at
 * the tool level: unknown/mutating tools require approval, and only an
 * explicitly read-only tool can bypass approval on a trusted server.
 *
 * `tool_name` is the MCP wire name, not Magister's namespaced
 * `mcp__server__tool` presentation name. Server-name changes therefore
 * do not orphan policy rows.
 */
export const mcpToolPolicies = sqliteTable("mcp_tool_policies", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  toolName: text("tool_name").notNull(),
  policy: text("policy").notNull().default("unknown"),
  source: text("source").notNull().default("discovered"),
  rationale: text("rationale"),
  description: text("description"),
  inputSchemaJson: text("input_schema_json"),
  lastDiscoveredAt: integer("last_discovered_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type McpToolPolicyInsert = typeof mcpToolPolicies.$inferInsert;
export type McpToolPolicySelect = typeof mcpToolPolicies.$inferSelect;

/**
 * Per-machine workspace registry — the user's set of "projects" Magister
 * can operate on. Replaces the previous hardcoded
 * `workspaceId = "workspace_main"` default that pinned every task
 * to `process.cwd()`. Foundation was already in place
 * (tasks.workspaceId column, resolveWorkspaceBaseDir, runtime_workspaces
 * table); this table provides the registry of legal workspaceIds and
 * their path mappings.
 *
 * `id` is a slug (e.g. `default`, `myapp`). `base_path` is the
 * directory the agent operates in. Exactly one row has
 * `is_default=true` at any time (enforced application-side via
 * setDefault transaction; SQLite doesn't have partial UNIQUE
 * indexes the way Postgres does). First-boot ensures a `default`
 * workspace at `process.cwd()` so the upgrade path is zero-downtime.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  basePath: text("base_path").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // Per-workspace review policy JSON. Phase 1 of the
  // Leader-driven review RFC (docs/plans/2026-05-24-leader-review-autonomy.md
  // §5.1). Default is `{"version":1,"mode":"hitl"}` so existing
  // workspaces behave exactly like today's HITL queue. The mode flips
  // to "leader-driven" once the operator opts a workspace in via SQL
  // (Phase 1) or UI (Phase 3). `version` guards against an older
  // build mis-interpreting a newer policy doc — RFC §9.Q11.
  reviewPolicyJson: text("review_policy_json").notNull().default('{"version":1,"mode":"hitl"}'),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type WorkspaceInsert = typeof workspaces.$inferInsert;
export type WorkspaceSelect = typeof workspaces.$inferSelect;

/**
 * Per-call LLM token usage record. Replaces the previous in-memory
 * `usageRecords[]` array in token-usage-service.ts — that store was
 * process-local and got wiped on every restart, so dashboards lied
 * about historical cost. Kept the same row shape (taskId / runId /
 * model / provider / per-call token counts) and added cache hit/miss
 * columns the original record type already declared but never wrote.
 *
 * Cost is intentionally no longer computed. `cost_usd` is kept only
 * for legacy rows/compatibility and new records write NULL.
 *
 * Retention: 30 days OR 50K rows, whichever fires first. Swept by
 * task-retention-service alongside task / artifact cleanup.
 */
export const tokenUsageRecords = sqliteTable("token_usage_records", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  runId: text("run_id").notNull(),
  /** Per-prompt scope — present once requestId is wired through the
   *  recordUsage call site. Null on legacy rows from upgrade path. */
  requestId: text("request_id"),
  /** Role that emitted the model call (leader / coder / reviewer / ...).
   *  Null until the loop layer threads it; planning Phase 2 work. */
  roleId: text("role_id"),
  turnNumber: integer("turn_number").notNull(),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  nonCachedInputTokens: integer("non_cached_input_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  totalTokens: integer("total_tokens"),
  usageSource: text("usage_source"),
  rawUsageJson: text("raw_usage_json"),
  // char-based estimate of actual prompt tokens, used as
  // the authoritative context-window number when provider's
  // `prompt_tokens` is non-real (Volcengine Ark `/api/coding/v3`
  // reports billable units, ~1000× discounted from actual size).
  estimatedPromptTokens: integer("estimated_prompt_tokens"),
  costUsd: real("cost_usd"),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
});

export type TokenUsageRecordInsert = typeof tokenUsageRecords.$inferInsert;
export type TokenUsageRecordSelect = typeof tokenUsageRecords.$inferSelect;

/**
 * Per-task project spec + orchestration state. Replaces the
 * in-memory `Map<string, ProjectSpec>` in project-spec-service.ts
 * — that store was process-local and got wiped on every restart.
 * The `spec_json` column stores the full spec; `orchestration_json`
 * stores runtime state (spawned runs, baseline tests, review
 * findings, verification evidence).
 */
export const projectSpecs = sqliteTable("project_specs", {
  taskId: text("task_id").primaryKey(),
  specJson: text("spec_json").notNull(),
  orchestrationJson: text("orchestration_json"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ProjectSpecInsert = typeof projectSpecs.$inferInsert;
export type ProjectSpecSelect = typeof projectSpecs.$inferSelect;

/**
 * Durable Safe Apply review state. Phase 1 writes raw patch bytes to
 * `runtime_diff` file artifacts; this table stores only metadata and
 * decision state so API list/detail calls never inline a patch.
 */
export const changeReviews = sqliteTable("change_reviews", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  roleRuntimeId: text("role_runtime_id"),
  workspaceId: text("workspace_id").notNull(),
  sourceEventId: text("source_event_id"),
  reviewDraftArtifactId: text("review_draft_artifact_id").notNull(),
  diffArtifactId: text("diff_artifact_id").notNull(),
  gateArtifactId: text("gate_artifact_id"),

  runtimeSource: text("runtime_source").notNull(),
  permissionMode: text("permission_mode").notNull(),
  executorCommand: text("executor_command"),
  sandboxMode: text("sandbox_mode"),
  argvFlagsJson: text("argv_flags_json").notNull(),
  permissionSignalsJson: text("permission_signals_json").notNull(),
  envPermissionHintsJson: text("env_permission_hints_json").notNull(),
  runtimeWorkspaceStrategy: text("runtime_workspace_strategy").notNull(),

  mcpToolRiskJson: text("mcp_tool_risk_json"),
  sastAdvisoryJson: text("sast_advisory_json"),
  executionSandboxJson: text("execution_sandbox_json"),
  sideEffectWarningJson: text("side_effect_warning_json"),

  baseRevision: text("base_revision"),
  diffHash: text("diff_hash").notNull(),
  diffAlgorithmJson: text("diff_algorithm_json").notNull(),
  changedFilesJson: text("changed_files_json").notNull(),
  addedLines: integer("added_lines").notNull(),
  removedLines: integer("removed_lines").notNull(),
  isEmpty: integer("is_empty", { mode: "boolean" }).notNull().default(false),

  risk: text("risk").notNull(),
  riskReasonsJson: text("risk_reasons_json").notNull(),
  verificationJson: text("verification_json").notNull(),
  reviewerVerdictsJson: text("reviewer_verdicts_json").notNull().default("[]"),

  decisionState: text("decision_state").notNull(),
  decisionReason: text("decision_reason"),
  decidedBy: text("decided_by"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),

  applyState: text("apply_state").notNull().default("not_applied"),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }),

  // 2026-05-15: `audit_chain_head` removed alongside the HMAC audit
  // chain (see migration in packages/db/src/client.ts). The column
  // is dropped on existing installs; new installs never see it.

  // Leader-driven review autonomy (Phase 1 spec §5.1):
  //   assignee                   = who is responsible for this review.
  //                                Default 'user' = today's HITL behaviour.
  //                                'leader' = Leader's inbox (only when the
  //                                workspace policy is leader-driven AND
  //                                the assignment router doesn't escalate).
  //   assigneeSetBy              = audit: 'router' | 'leader' | 'manual'.
  //   reviewerVerdictArtifactId  = typed verdict artifact (RFC §5.3) the
  //                                reviewer teammate submitted. Null until
  //                                a reviewer runs.
  //   leaderApplyCommitSha       = SHA of the auto-commit Leader created
  //                                during apply, so the operator's
  //                                `git revert <sha>` is a recorded
  //                                recourse, not folklore (RFC §5.5
  //                                BLOCKER-2 fix).
  assignee: text("assignee").notNull().default("user"),
  assigneeSetBy: text("assignee_set_by"),
  reviewerVerdictArtifactId: text("reviewer_verdict_artifact_id"),
  leaderApplyCommitSha: text("leader_apply_commit_sha"),

  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type ChangeReviewInsert = typeof changeReviews.$inferInsert;
export type ChangeReviewSelect = typeof changeReviews.$inferSelect;

// M5 P2-#6 (2026-05-15): provenance mirror for memory entries. The
// canonical store is the filesystem (apps/api/src/services/memory/);
// this table records "who wrote it, when, from which task/request"
// so the UI / audit / replay paths don't have to scrape execution
// events to reconstruct who touched a given memory file.
//
// Lifecycle:
//   - upsertMemory inserts/updates the row (path PK; last_* fields refresh)
//   - deleteMemory drops the row (if the entry comes back, it's a fresh row)
//   - The on-disk file is authoritative; this row goes stale silently if
//     the file is edited out-of-band. The aging sweeper does NOT touch
//     this table (it would double the write cost per sweep tick).
export const memoryEntries = sqliteTable("memory_entries", {
  path: text("path").primaryKey(),
  scope: text("scope").notNull(),
  type: text("type").notNull(),
  firstWriteAuthority: text("first_write_authority").notNull(),
  firstWriteTaskId: text("first_write_task_id"),
  firstWriteRequestId: text("first_write_request_id"),
  firstWrittenAt: integer("first_written_at", { mode: "timestamp_ms" }).notNull(),
  lastWriteAuthority: text("last_write_authority").notNull(),
  lastWriteTaskId: text("last_write_task_id"),
  lastWriteRequestId: text("last_write_request_id"),
  lastWrittenAt: integer("last_written_at", { mode: "timestamp_ms" }).notNull(),
});

export type MemoryEntryProvenanceInsert = typeof memoryEntries.$inferInsert;
export type MemoryEntryProvenanceSelect = typeof memoryEntries.$inferSelect;

// Spec §1: persistent approval-rule store for the
// sandbox escalation protocol. When the model requests bash with
// `sandbox_permissions: "require_escalated"` + `prefix_rule:
// [...]`, and the user clicks "Approve + save rule", we persist
// the prefix here so future matching commands auto-pass without
// asking. Banned overly-broad prefixes (single-token, shell-eval
// constructs) are rejected server-side before insert.
export const commandApprovalRules = sqliteTable("command_approval_rules", {
  id: text("id").primaryKey(),
  tool: text("tool").notNull(),                  // 'bash' for V1; 'write_file' etc. for V2
  patternKind: text("pattern_kind").notNull(),   // 'argv_prefix' | 'path_glob' | 'literal'
  patternJson: text("pattern_json").notNull(),   // shape per kind
  scope: text("scope").notNull(),                // 'global' | 'project' | 'session'
  projectPath: text("project_path"),             // canonicalized; NOT NULL when scope='project'
  approvedBy: text("approved_by").notNull(),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),  // optional TTL
  enabled: integer("enabled").notNull().default(1),
  hitCount: integer("hit_count").notNull().default(0),
  lastHitAt: integer("last_hit_at", { mode: "timestamp_ms" }),
  justificationTemplate: text("justification_template"),
  // Sandbox-elevation v4.3 §4.9 — optional saved AdditionalPermissionProfile
  // alongside the prefix rule. JSON-serialized; 8 KiB CHECK enforced
  // both at DB and at app layer.
  additionalPermissionsJson: text("additional_permissions_json"),
});

export type CommandApprovalRuleInsert = typeof commandApprovalRules.$inferInsert;
export type CommandApprovalRuleSelect = typeof commandApprovalRules.$inferSelect;
