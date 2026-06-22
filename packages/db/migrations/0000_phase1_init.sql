CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  priority TEXT,
  root_channel_binding_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS role_runtimes (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  role_assignment_id TEXT,
  role_id TEXT NOT NULL,
  state TEXT NOT NULL,
  delegation_mode TEXT,
  active_executor_id TEXT,
  current_session_id TEXT,
  prior_session_id TEXT,
  prior_workdir TEXT,
  resume_policy TEXT,
  workspace_strategy_override TEXT,
  resume_attempted_at INTEGER,
  resume_failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  role_runtime_id TEXT,
  approval_type TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS conversation_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inbound_at INTEGER NOT NULL,
  last_event_id TEXT,
  last_platform_message_id TEXT,
  last_sender_user_id TEXT,
  last_sender_display_name TEXT
);

CREATE TABLE IF NOT EXISTS channel_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  binding_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  continuity_mode TEXT NOT NULL,
  verbose_level TEXT NOT NULL DEFAULT 'off',
  current_task_id TEXT,
  latest_inbound_message_id TEXT,
  latest_delivered_message_id TEXT,
  latest_answer_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_inbound_event_keys (
  binding_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS channel_outbound_delivery_locks (
  outbound_event_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  claim_token TEXT,
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  role_runtime_id TEXT,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  storage_kind TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  request_id TEXT,
  task_id TEXT,
  subtask_id TEXT,
  role_runtime_id TEXT,
  executor_session_id TEXT,
  approval_id TEXT,
  artifact_id TEXT,
  conversation_binding_id TEXT,
  workspace_id TEXT,
  severity TEXT,
  payload_json TEXT,
  occurred_at INTEGER NOT NULL
);
