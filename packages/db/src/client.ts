import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Type-only import (erased at runtime — never triggers a bun:sqlite resolve
// on Node). Used as the canonical drizzle handle type for the cache; the
// better-sqlite3 adapter produces a query-compatible handle we cast to it.
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { createDrizzle, openSqlite, type RawSqlite } from "./platform/sqlite";
import * as schema from "./schema";

const DEFAULT_DB_PATH = join(process.cwd(), ".local", "control-plane.sqlite");
const initializedDatabases = new Set<string>();

export function getDatabasePath() {
  return process.env.MAGISTER_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Apply the WAL concurrency tuning to a raw handle. Best-effort: a pragma
 * failure (e.g. read-only fixture FS) leaves the DB usable.
 */
function applyPragmas(raw: RawSqlite) {
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.exec("PRAGMA synchronous = NORMAL");
  } catch {
    // Best-effort — matches prior behavior.
  }
}

export function createSqliteClient(): RawSqlite {
  const dbPath = getDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const { raw } = openSqlite(dbPath);
  // WAL concurrency tuning. The default `journal_mode=delete` takes an
  // exclusive whole-DB lock for every writer; with multiple workers
  // (leader loop, recovery scan, retention sweep, teammate runtimes)
  // hammering the DB in parallel, contention crashed the runtime with
  // `SQLITE_BUSY`. WAL lets readers keep going while a writer is active
  // and queues writers behind a 5s busy_timeout. NORMAL synchronous is
  // the WAL-mode best-practice (checkpoint events tolerate a power-loss
  // replay).
  applyPragmas(raw);
  return raw;
}

export function ensureDatabaseInitialized(sqlite: RawSqlite, dbPath = getDatabasePath()) {
  if (initializedDatabases.has(dbPath)) {
    return;
  }

  // `import.meta.dir` is a Bun-ism (undefined on Node). `import.meta.url`
  // is standard ESM on both runtimes; resolve the migration path relative
  // to this module.
  const migrationPath = fileURLToPath(new URL("../migrations/0000_phase1_init.sql", import.meta.url));
  const sql = readFileSync(migrationPath, "utf8");
  sqlite.exec(sql);
  ensureRoleRuntimeColumns(sqlite);
  ensureRuntimeWorkspaceTable(sqlite);
  ensureChannelEventStateTables(sqlite);
  ensureExecutionEventIndexes(sqlite);
  ensureTaskAttachmentsTable(sqlite);
  ensureTaskMediaTable(sqlite);
  ensureMcpServersTable(sqlite);
  ensureMcpToolPoliciesTable(sqlite);
  ensureAgentMcpAttachmentsTable(sqlite);
  ensureWorkspacesTable(sqlite);
  ensureTokenUsageRecordsTable(sqlite);
  ensureProjectSpecsTable(sqlite);
  ensureChangeReviewTables(sqlite);
  ensureSkillOverridesTable(sqlite);
  initializedDatabases.add(dbPath);
}

function ensureChangeReviewTables(sqlite: RawSqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS change_reviews (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      role_runtime_id TEXT,
      workspace_id TEXT NOT NULL,
      source_event_id TEXT,
      review_draft_artifact_id TEXT NOT NULL,
      diff_artifact_id TEXT NOT NULL,
      gate_artifact_id TEXT,

      runtime_source TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      executor_command TEXT,
      sandbox_mode TEXT,
      argv_flags_json TEXT NOT NULL,
      permission_signals_json TEXT NOT NULL,
      env_permission_hints_json TEXT NOT NULL,
      runtime_workspace_strategy TEXT NOT NULL,

      mcp_tool_risk_json TEXT,
      sast_advisory_json TEXT,
      execution_sandbox_json TEXT,
      side_effect_warning_json TEXT,

      base_revision TEXT,
      diff_hash TEXT NOT NULL,
      diff_algorithm_json TEXT NOT NULL,
      changed_files_json TEXT NOT NULL,
      added_lines INTEGER NOT NULL,
      removed_lines INTEGER NOT NULL,
      is_empty INTEGER NOT NULL DEFAULT 0,

      risk TEXT NOT NULL,
      risk_reasons_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      reviewer_verdicts_json TEXT NOT NULL DEFAULT '[]',

      decision_state TEXT NOT NULL,
      decision_reason TEXT,
      decided_by TEXT,
      decided_at INTEGER,

      apply_state TEXT NOT NULL DEFAULT 'not_applied',
      applied_at INTEGER,

      assignee TEXT NOT NULL DEFAULT 'user',
      assignee_set_by TEXT,
      reviewer_verdict_artifact_id TEXT,
      leader_apply_commit_sha TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_change_reviews_draft_unique
      ON change_reviews(review_draft_artifact_id);
    CREATE INDEX IF NOT EXISTS idx_change_reviews_task_created
      ON change_reviews(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_change_reviews_runtime
      ON change_reviews(role_runtime_id);
    CREATE INDEX IF NOT EXISTS idx_change_reviews_decision_state
      ON change_reviews(decision_state);
  `);
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN sast_advisory_json TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN execution_sandbox_json TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  // Leader-driven review autonomy (Phase 1 spec §5.1).
  // Four columns, each idempotently added. assignee defaults to 'user'
  // so every existing row continues to be operator-owned; new rows on
  // workspaces with mode:"hitl" also default to 'user'. The router
  // (Phase 1b-1) is the only writer that can set 'leader' at create
  // time. assignee_set_by / reviewer_verdict_artifact_id /
  // leader_apply_commit_sha are nullable and start null on existing
  // rows.
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN assignee TEXT NOT NULL DEFAULT 'user'");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN assignee_set_by TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN reviewer_verdict_artifact_id TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  try {
    sqlite.exec("ALTER TABLE change_reviews ADD COLUMN leader_apply_commit_sha TEXT");
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  // Index on (assignee, decision_state) so the future Leader-inbox
  // sweep query and the operator's "what's mine" filter both stay
  // O(log N) as the audit history grows.
  try {
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_change_reviews_assignee_state ON change_reviews(assignee, decision_state)");
  } catch (error) {
    // Index creation failures are non-fatal — query still works,
    // just slower. Log and continue.
    console.warn("[db] failed to create idx_change_reviews_assignee_state:", error);
  }
  // 2026-05-15: HMAC audit chain removed. Idempotent migration —
  // drop the audit events table and the audit_chain_head column from
  // existing installs. SQLite < 3.35 doesn't support `DROP COLUMN`,
  // but 3.35+ (which Bun ships) does; if the drop fails for any
  // other reason we leave the column in place (orphan, no longer
  // written by the application).
  //
  // Both catch blocks filter expected-benign errors and surface
  // anything else loudly. Notably: `SQLITE_BUSY` is NOT swallowed —
  // we want to know if startup raced with a foreign writer on the
  // file. (GLM-5.1 review 2026-05-15 P1-2.)
  try {
    sqlite.exec("DROP TABLE IF EXISTS change_review_audit_events");
  } catch (error) {
    // `DROP TABLE IF EXISTS` shouldn't throw on a missing table,
    // so any error here is unexpected (busy, corrupt, perms, etc.).
    // Re-throw — caller decides whether to retry or abort startup.
    console.error("[db] failed to drop change_review_audit_events:", error);
    throw error;
  }
  try {
    sqlite.exec("ALTER TABLE change_reviews DROP COLUMN audit_chain_head");
  } catch (error) {
    // Benign cases we swallow:
    //   - column already gone (fresh install or prior boot dropped it)
    //   - older SQLite without DROP COLUMN syntax support
    // Everything else (busy, corrupt) re-throws.
    const msg = error instanceof Error ? error.message : String(error);
    const isBenign =
      msg.includes("no such column") || msg.includes("near \"DROP\"");
    if (!isBenign) {
      console.error("[db] failed to drop change_reviews.audit_chain_head:", error);
      throw error;
    }
  }
}

function isDuplicateColumnError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("duplicate column");
}

/**
 * Use in `catch` blocks on ALTER TABLE ADD COLUMN statements.
 * SQLite doesn't have "ADD COLUMN IF NOT EXISTS", so "duplicate column name"
 * is expected on re-run and must be swallowed. Everything else (SQLITE_BUSY,
 * schema corruption, disk full, etc.) is re-thrown so startup fails loudly
 * instead of silently leaving columns un-added and marking the DB initialized.
 */
function rethrowUnlessDuplicateColumn(error: unknown): void {
  if (!isDuplicateColumnError(error)) throw error;
}

function ensureSkillOverridesTable(sqlite: RawSqlite) {
  // Per-instance overrides for Magister-bundled skills (see schema.ts
  // `skillOverrides` comment for rationale). A null override field
  // means "fall back to the bundled file"; the row can carry a
  // description-only override, content-only, or both.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS skill_overrides (
      role_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      description_override TEXT,
      content_override TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (role_id, skill_name)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_overrides_role
      ON skill_overrides(role_id);
  `);
}

function ensureTaskAttachmentsTable(sqlite: RawSqlite) {
  // Per-task user attachments (Phase 1 = images only; PDF/DOCX/XLSX
  // will reuse the same table later). Files live on disk under
  // `<cwd>/.magister/uploads/<task_id>/`; this table is the
  // metadata index. Indexed on task_id + (task_id, request_id)
  // so cleanup sweeps and per-turn lookups stay cheap as a task
  // accumulates uploads across multiple prompts.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      request_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_attachments_task
      ON task_attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_attachments_task_request
      ON task_attachments(task_id, request_id);
  `);
}

function ensureTaskMediaTable(sqlite: RawSqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_media (
      id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      request_id TEXT,
      role_runtime_id TEXT,
      source_tool_call_id TEXT,
      source_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      caption TEXT,
      display TEXT NOT NULL DEFAULT 'inline',
      status TEXT NOT NULL DEFAULT 'ready',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      retained_until INTEGER,
      PRIMARY KEY (task_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_media_task_created
      ON task_media(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_media_status
      ON task_media(status);
  `);
}

function ensureMcpServersTable(sqlite: RawSqlite) {
  // Per-machine MCP server registry. Indexed on (enabled) for
  // the runtime startup query that grabs only-enabled rows.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config_json TEXT NOT NULL,
      timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'ask',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
      ON mcp_servers(enabled);
  `);
}

function ensureMcpToolPoliciesTable(sqlite: RawSqlite) {
  // Per-MCP-tool safety policy. Additive table for Phase 5; old
  // databases upgrade on API startup through this bootstrap path.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_policies (
      id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'discovered',
      rationale TEXT,
      description TEXT,
      input_schema_json TEXT,
      last_discovered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tool_policies_server_tool
      ON mcp_tool_policies(server_id, tool_name);
    CREATE INDEX IF NOT EXISTS idx_mcp_tool_policies_server
      ON mcp_tool_policies(server_id);
  `);
}

function ensureTokenUsageRecordsTable(sqlite: RawSqlite) {
  // Per-call LLM token usage rows. Replaces the in-memory store
  // that lived in token-usage-service.ts (`usageRecords[]`) — that
  // array was process-local; every restart wiped the daily cost
  // dashboard and per-task token reports. Now writes survive,
  // dashboards are honest across restarts, and historical task
  // forensics are possible.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_records (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      request_id TEXT,
      role_id TEXT,
      turn_number INTEGER NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      non_cached_input_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_tokens INTEGER,
      usage_source TEXT,
      raw_usage_json TEXT,
      estimated_prompt_tokens INTEGER,
      cost_usd REAL,
      recorded_at INTEGER NOT NULL
    );
    -- Per-task lookup (most common query: chat detail page Tokens
    -- card, /status currentSession.tokenUsage). Index on
    -- (task_id, recorded_at) so latestModel/latestProvider lookups
    -- using ORDER BY recorded_at DESC LIMIT 1 are also fast.
    CREATE INDEX IF NOT EXISTS idx_token_usage_task_recorded
      ON token_usage_records(task_id, recorded_at DESC);
    -- Per-turn usage aggregation for chat workbench summaries.
    CREATE INDEX IF NOT EXISTS idx_token_usage_task_request
      ON token_usage_records(task_id, request_id);
    -- Daily-cost rollup (Dashboard "/usage/today"). Without this
    -- the global SUM scans the whole table.
    CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at
      ON token_usage_records(recorded_at);
  `);
  // Additive ALTERs for databases created before usage normalization.
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN estimated_prompt_tokens INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN non_cached_input_tokens INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN reasoning_tokens INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN total_tokens INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN usage_source TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE token_usage_records ADD COLUMN raw_usage_json TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
}

function ensureProjectSpecsTable(sqlite: RawSqlite) {
  // Per-task project spec + orchestration state. Replaces the
  // in-memory `activeSpecs` Map in project-spec-service.ts.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_specs (
      task_id TEXT PRIMARY KEY NOT NULL,
      spec_json TEXT NOT NULL,
      orchestration_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_specs_task
      ON project_specs(task_id);
  `);
}

function ensureWorkspacesTable(sqlite: RawSqlite) {
  // Per-machine workspace registry. Indexed on (is_default) for the
  // common "give me the default" lookup at task-create time. The
  // default-row invariant (exactly one row with is_default=true at a
  // time) is enforced application-side in WorkspaceRepository.setDefault
  // — SQLite can't express it as a partial UNIQUE the way Postgres can.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      base_path TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      review_policy_json TEXT NOT NULL DEFAULT '{"version":1,"mode":"hitl"}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_is_default
      ON workspaces(is_default);
  `);

  // Idempotent add for existing installs (Phase 1 of the
  // Leader-driven review RFC §5.1). Default value matches the CREATE
  // TABLE clause above; existing workspaces behave identically.
  try {
    sqlite.exec(`ALTER TABLE workspaces ADD COLUMN review_policy_json TEXT NOT NULL DEFAULT '{"version":1,"mode":"hitl"}'`);
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }

  // Bootstrap: ensure SOMETHING is the default workspace. Three
  // cases the system must survive:
  //   - empty table (first boot) → seed `workspace_main` with cwd
  //   - rows exist but none has is_default=true (someone deleted
  //     the default row by hand, or a migration left it dangling)
  //     → promote the oldest row to default
  //   - default exists → no-op
  // (Kimi review M6 — previous code only seeded on empty-table,
  // which left the system without a fallback when the default
  // row was missing for any other reason.)
  const haveDefault = sqlite
    .query("SELECT COUNT(*) AS n FROM workspaces WHERE is_default = 1")
    .get() as { n: number } | undefined;
  if (haveDefault && haveDefault.n === 0) {
    const now = Date.now();
    const oldest = sqlite
      .query("SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string } | undefined;
    if (oldest?.id) {
      // Rows exist, none default → promote the oldest. Preserves
      // existing path / label.
      sqlite.run(
        `UPDATE workspaces SET is_default = 1, updated_at = ? WHERE id = ?`,
        [now, oldest.id],
      );
    } else {
      // Empty table → seed `workspace_main` (matches the legacy
      // literal that pre-Path-A tasks were tagged with so existing
      // chat history stays visible). Label is "Default" for users.
      const cwd = process.cwd();
      sqlite.run(
        `INSERT INTO workspaces (id, label, base_path, is_default, created_at, updated_at)
         VALUES ('workspace_main', 'Default', ?, 1, ?, ?)
         ON CONFLICT(base_path) DO NOTHING`,
        [cwd, now, now],
      );
    }
  }
}

function ensureAgentMcpAttachmentsTable(sqlite: RawSqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_mcp_attachments (
      role_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (role_id, server_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_attachments_role
      ON agent_mcp_attachments(role_id);
    CREATE INDEX IF NOT EXISTS idx_agent_mcp_attachments_server
      ON agent_mcp_attachments(server_id);
  `);

  // One-shot migration: if the table is empty AND mcp_servers has
  // entries, bootstrap (every-existing-agent × every-existing-server).
  // This preserves Phase 1 + 2 behavior on first run after Phase 3
  // lands. The empty-check guards against re-running every startup.
  const haveAttachments = sqlite
    .query("SELECT COUNT(*) AS n FROM agent_mcp_attachments")
    .get() as { n: number } | undefined;
  if (haveAttachments && haveAttachments.n === 0) {
    const haveServers = sqlite
      .query("SELECT COUNT(*) AS n FROM mcp_servers")
      .get() as { n: number } | undefined;
    if (haveServers && haveServers.n > 0) {
      const now = Date.now();
      sqlite.exec(`
        INSERT INTO agent_mcp_attachments (role_id, server_id, created_at)
        SELECT a.role_id, s.id, ${now}
        FROM agent_profiles a
        CROSS JOIN mcp_servers s
        WHERE NOT EXISTS (
          SELECT 1 FROM agent_mcp_attachments ama
          WHERE ama.role_id = a.role_id AND ama.server_id = s.id
        );
      `);
    }
  }
}

function ensureExecutionEventIndexes(sqlite: RawSqlite) {
  // Without these indexes every `listByTaskId` becomes a full table
  // scan over `execution_events`. That table grows ~hundreds of rows
  // per turn (stream_delta dominates by ~100×), so dashboards that
  // call `listTaskSummaries` (51 tasks × full-scan) reach multi-second
  // latency once a few thousand events accumulate. Measured 3.3 s →
  // ~1 s on a 84k-row DB after adding `(task_id, seq)`.
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_exec_events_task_seq
      ON execution_events(task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_exec_events_task_type
      ON execution_events(task_id, type);
    CREATE INDEX IF NOT EXISTS idx_exec_events_task_type_occurred_seq
      ON execution_events(task_id, type, occurred_at DESC, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_exec_events_runtime_type
      ON execution_events(role_runtime_id, type);
    CREATE INDEX IF NOT EXISTS idx_exec_events_runtime_type_seq
      ON execution_events(role_runtime_id, type, seq);
    CREATE INDEX IF NOT EXISTS idx_exec_events_task_request_seq
      ON execution_events(task_id, request_id, seq);
    CREATE INDEX IF NOT EXISTS idx_exec_events_type_occurred
      ON execution_events(type, occurred_at);
  `);

  // agent envelope persistence + indexed
  // teammate-lookup column. Idempotent ALTER (try/catch — column
  // already-exists throws on re-run) matches the existing pattern in
  // ensureRoleRuntimeColumns. Index uses a partial-index predicate so
  // the (huge) majority of rows with parent_tool_use_id=NULL don't
  // bloat the index.
  try { sqlite.exec("ALTER TABLE execution_events ADD COLUMN agent_json TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE execution_events ADD COLUMN parent_tool_use_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_execution_events_parent_tool
      ON execution_events(task_id, parent_tool_use_id)
      WHERE parent_tool_use_id IS NOT NULL;
  `);
}

function ensureRoleRuntimeColumns(sqlite: RawSqlite) {
  const rows = sqlite.prepare("PRAGMA table_info(role_runtimes)").all() as Array<{
    name?: string;
  }>;
  const columnNames = new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const columnsToAdd = [
    "prior_session_id TEXT",
    "prior_workdir TEXT",
    "resume_policy TEXT",
    "workspace_strategy_override TEXT",
    "resume_attempted_at INTEGER",
    "resume_failure_reason TEXT",
  ];

  for (const columnDefinition of columnsToAdd) {
    const [columnName] = columnDefinition.split(" ");
    if (!columnName) {
      continue;
    }
    if (columnNames.has(columnName)) {
      continue;
    }

    sqlite.exec(`ALTER TABLE role_runtimes ADD COLUMN ${columnDefinition}`);
  }
}

function ensureRuntimeWorkspaceTable(sqlite: RawSqlite) {
  try {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runtime_workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      requested_strategy TEXT,
      strategy TEXT NOT NULL,
      decision_reason TEXT,
      fallback_reason TEXT,
      status TEXT NOT NULL,
      base_workspace_dir TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      base_revision TEXT,
      metadata_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `);
  const rows = sqlite.prepare("PRAGMA table_info(runtime_workspaces)").all() as Array<{
    name?: string;
  }>;
  const columnNames = new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const columnsToAdd = [
    "requested_strategy TEXT",
    "decision_reason TEXT",
    "fallback_reason TEXT",
    "base_revision TEXT",
  ];

  for (const columnDefinition of columnsToAdd) {
    const [columnName] = columnDefinition.split(" ");
    if (!columnName || columnNames.has(columnName)) {
      continue;
    }
    sqlite.exec(`ALTER TABLE runtime_workspaces ADD COLUMN ${columnDefinition}`);
  }
  } catch { /* runtime_workspaces is optional — some test DBs don't have the initial migration */ }
}

function ensureChannelEventStateTables(sqlite: RawSqlite) {
  sqlite.exec(`
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
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_inbound_event_keys (
      binding_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (binding_id, dedupe_key)
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS channel_outbound_delivery_locks (
      outbound_event_id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      claim_token TEXT,
      claimed_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);

  const rows = sqlite.prepare("PRAGMA table_info(channel_sessions)").all() as Array<{
    name?: string;
  }>;
  const columnNames = new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  if (!columnNames.has("verbose_level")) {
    sqlite.exec("ALTER TABLE channel_sessions ADD COLUMN verbose_level TEXT NOT NULL DEFAULT 'off'");
  }

  try {
    sqlite.exec("ALTER TABLE channel_sessions ADD COLUMN current_leader_session_id TEXT");
  } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try {
    sqlite.exec("ALTER TABLE role_runtimes ADD COLUMN parent_run_id TEXT");
  } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE execution_events ADD COLUMN request_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE execution_events ADD COLUMN seq INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec(`CREATE TABLE IF NOT EXISTS task_mailbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
)`); } catch {}
  // 2026-05-03 follow-up attachments: per-message requestId so the
  // loop can pair a mailbox row with the task_attachments rows the
  // user uploaded for that turn. Add via try/catch ALTER for DBs
  // that pre-date this column.
  try { sqlite.exec("ALTER TABLE task_mailbox ADD COLUMN request_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }

  // 2026-05-06 goal mode (Ralph loop). Goal is a property of a
  // task; null goal_objective = ordinary task. Try/catch ALTERs
  // so existing DBs upgrade without a migration script.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_objective TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_status TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_started_at INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_max_wall_seconds INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_iterations INTEGER DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_tokens_used INTEGER DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_completed_at INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-12 goal-mode v2 — see docs/plans/2026-05-12-goal-mode-overhaul.md
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_token_budget INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_plan_path TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // Phase 4 — external verifier verdict tracking.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_last_verifier_verdict TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_last_verifier_at INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_last_verifier_blocker TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-21 v3 §P0-2 — user-controlled subgoals.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_subgoals TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-21 v3 §P1-5 — mid-flight objective edit timestamp.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_objective_edited_at INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-21 v3 §P1-8 — evaluator parse-failure backstop counter.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN goal_evaluator_parse_failures INTEGER DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // Board Attention column dismissal flag (UI-only).
  // See `tasks.attentionDismissedAt` in schema.ts for usage. Stored
  // as epoch-ms via INTEGER (Drizzle `timestamp_ms` mode).
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN attention_dismissed_at INTEGER"); } catch (e) { rethrowUnlessDuplicateColumn(e); }

  // 2026-05-11 backfill: pre-ac5617c mark_goal_complete (and the
  // pause/cancel routes before they got the freeze fix) only flipped
  // goal_status without writing goal_completed_at or bumping
  // goal_iterations. Tasks that hit that buggy path are stuck with
  // goal_status terminal + goal_completed_at=NULL + goal_iterations=0,
  // which causes the frontend to display "9h 3m, iteration 0" (timer
  // never freezes because completed_at is the freeze anchor). This
  // one-shot UPDATE backfills sane values; idempotent because future
  // runs find no rows matching the NULL predicate.
  try {
    sqlite.exec(`
      UPDATE tasks
      SET goal_completed_at = updated_at
      WHERE goal_objective IS NOT NULL
        AND goal_status IN ('complete', 'cancelled', 'paused')
        AND goal_completed_at IS NULL
    `);
  } catch {}
  try {
    sqlite.exec(`
      UPDATE tasks
      SET goal_iterations = 1
      WHERE goal_objective IS NOT NULL
        AND goal_status = 'complete'
        AND (goal_iterations IS NULL OR goal_iterations = 0)
    `);
  } catch {}

  // 2026-05-07 P1 — accumulated token / cost columns on tasks for
  // O(1) per-task rollups (Goose pattern). recordUsage UPSERTs both
  // a row in token_usage_records AND deltas onto these columns in
  // the same transaction, so /tasks/:id/usage and the dashboard
  // stat panels can read the running total without a per-task
  // GROUP BY scan.
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN accumulated_input_tokens INTEGER NOT NULL DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN accumulated_output_tokens INTEGER NOT NULL DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN accumulated_cost_usd REAL NOT NULL DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }

  // Spec §5 — root-level trace identifier.
  // Source of truth on tasks; denormalized to execution_events for
  // single-query tree lookup. Both nullable for back-compat with
  // pre-migration rows; query helpers use COALESCE(trace_id, task_id).
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN trace_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE execution_events ADD COLUMN trace_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_trace_id
      ON tasks(trace_id)
      WHERE trace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_execution_events_trace_id
      ON execution_events(trace_id, occurred_at)
      WHERE trace_id IS NOT NULL;
  `);

  // 2026-05-28 async teammate completion — mailbox metadata column for
  // structured completion notifications and role_runtimes column to
  // track which teammates were spawned async.
  try { sqlite.exec("ALTER TABLE task_mailbox ADD COLUMN metadata_json TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  try { sqlite.exec("ALTER TABLE role_runtimes ADD COLUMN spawned_async INTEGER DEFAULT 0"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-29 — parallel_group_id links cohort members from spawn_teammates batch tool.
  try { sqlite.exec("ALTER TABLE role_runtimes ADD COLUMN parallel_group_id TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }
  // 2026-05-28 — per-task leader model override (/model slash command).
  try { sqlite.exec("ALTER TABLE tasks ADD COLUMN model_override TEXT"); } catch (e) { rethrowUnlessDuplicateColumn(e); }

  ensureSkillsAndAgentTables(sqlite);
  ensureMemoryProvenanceTable(sqlite);
  ensureCommandApprovalRulesTable(sqlite);
}

// Spec §1 — persistent rule store for the sandbox
// escalation protocol. See `apps/api/src/repositories/command-
// approval-rule-repository.ts` for callers and
// `apps/api/src/services/safe-apply/command-rule-matcher.ts` for
// argv-prefix matching.
function ensureCommandApprovalRulesTable(sqlite: RawSqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS command_approval_rules (
      id TEXT PRIMARY KEY NOT NULL,
      tool TEXT NOT NULL,
      pattern_kind TEXT NOT NULL,
      pattern_json TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_path TEXT,
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      expires_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at INTEGER,
      justification_template TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_command_approval_rules_lookup
      ON command_approval_rules(tool, enabled, scope, project_path)
      WHERE enabled = 1;
  `);
  // Sandbox-elevation v4.3 §4.9 — optional persistent additional_permissions
  // profile alongside the prefix rule. 8 KiB CHECK at the DB layer + app
  // validation. ALTER guarded by try/catch since SQLite doesn't have
  // "ADD COLUMN IF NOT EXISTS".
  //
  // Codex Slice-3 review MEDIUM Q6a — typed catch: only swallow the
  // expected "duplicate column" case; rethrow everything else (CHECK
  // syntax error, schema corruption, etc.) so startup fails loudly
  // instead of silently shipping without the constraint.
  try {
    sqlite.exec(
      `ALTER TABLE command_approval_rules ADD COLUMN additional_permissions_json TEXT
        CHECK (additional_permissions_json IS NULL
            OR length(additional_permissions_json) <= 8192)`,
    );
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("duplicate column name")) {
      throw err;
    }
    // Column already exists — safe to ignore.
  }
}

// M5 P2-#6 (2026-05-15): provenance mirror for memory entries.
// See `memoryEntries` in schema.ts for lifecycle semantics.
function ensureMemoryProvenanceTable(sqlite: RawSqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      path TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      first_write_authority TEXT NOT NULL,
      first_write_task_id TEXT,
      first_write_request_id TEXT,
      first_written_at INTEGER NOT NULL,
      last_write_authority TEXT NOT NULL,
      last_write_task_id TEXT,
      last_write_request_id TEXT,
      last_written_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_last_written
      ON memory_entries(last_written_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_type
      ON memory_entries(scope, type);
  `);

  // M5 P2-#7 (2026-05-15): FTS5 BM25 retrieval index for memory.
  // Without this the model has to "browse" by reading the entire
  // typed-entry index every turn — fine at 30 entries, prompt noise
  // at 300+. SQLite's FTS5 ships in bun:sqlite by default; bm25() is
  // its built-in scorer (smaller value = better match).
  //
  // The virtual table is keyed by canonical virtual path. `scope`
  // and `type` are kept UNINDEXED so they're returnable but don't
  // contribute to token matching. The description gets a 2× weight
  // (column 0 in the bm25 weights vector) because it's the
  // hand-authored summary; body is full text but lower weight.
  //
  // We mirror writes from `memory-fs-service.upsertMemory` /
  // `deleteMemory`. Best-effort: a DB hiccup is logged but doesn't
  // poison the on-disk write. The aging sweeper does NOT touch this
  // table — staleness flags don't change the searchable text.
  // FTS5 may be absent in a custom/system SQLite build. Degrade to
  // "no full-text memory search" with a clear warning instead of
  // bricking the entire control plane on boot. memory-search-service
  // tolerates the missing table (returns no FTS hits).
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
        path UNINDEXED,
        scope UNINDEXED,
        type UNINDEXED,
        description,
        body,
        tokenize = 'porter unicode61'
      );
    `);
  } catch (err) {
    console.warn(
      `[db] FTS5 unavailable — memory full-text search disabled. Your SQLite build lacks the fts5 module. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function ensureSkillsAndAgentTables(sqlite: RawSqlite) {
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  } catch {}

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_skills (
      agent_role TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      PRIMARY KEY (agent_role, skill_id)
    )`);
  } catch {}

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (
      role_id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      description TEXT,
      avatar_emoji TEXT DEFAULT '🤖',
      runtime_type TEXT DEFAULT 'ucm',
      provider TEXT,
      command_path TEXT,
      custom_env TEXT,
      custom_args TEXT,
      model_override TEXT,
      status TEXT,
      last_heartbeat_at INTEGER,
      mcp_config TEXT,
      max_concurrent_tasks INTEGER,
      max_turns INTEGER DEFAULT 60,
      system_prompt_override TEXT,
      tool_profile TEXT,
      is_builtin INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  } catch {}

  const profileRows = sqlite.prepare("PRAGMA table_info(agent_profiles)").all() as Array<{
    name?: string;
  }>;
  const profileColumnNames = new Set(
    profileRows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );

  const profileColumnsToAdd = [
    "label TEXT NOT NULL DEFAULT ''",
    "runtime_type TEXT DEFAULT 'ucm'",
    "model_name TEXT",
    "provider TEXT",
    "provider_id TEXT",
    "reasoning_mode TEXT DEFAULT 'auto'",
    "reasoning_effort TEXT DEFAULT 'medium'",
    "context_window INTEGER",
    "max_output_tokens INTEGER",
    "fallback_model_name TEXT",
    "fallback_provider_id TEXT",
    "command_path TEXT",
    "custom_env TEXT",
    "custom_args TEXT",
    "status TEXT",
    "last_heartbeat_at INTEGER",
    "mcp_config TEXT",
    "max_concurrent_tasks INTEGER",
    "max_turns INTEGER DEFAULT 60",
    "tool_profile TEXT",
    "allowed_tools TEXT",
    "disallowed_tools TEXT",
    "omit_skills INTEGER DEFAULT 0",
    "is_builtin INTEGER DEFAULT 0",
    "created_at INTEGER",
    "updated_at INTEGER",
  ];

  for (const columnDefinition of profileColumnsToAdd) {
    const [columnName] = columnDefinition.split(" ");
    if (!columnName || profileColumnNames.has(columnName)) {
      continue;
    }
    sqlite.exec(`ALTER TABLE agent_profiles ADD COLUMN ${columnDefinition}`);
  }

  sqlite.exec(`
    UPDATE agent_profiles
    SET label = COALESCE(NULLIF(label, ''), display_name, role_id)
    WHERE label IS NULL OR label = ''
  `);
  sqlite.exec("UPDATE agent_profiles SET runtime_type = COALESCE(runtime_type, 'ucm') WHERE runtime_type IS NULL OR runtime_type = ''");
  sqlite.exec("UPDATE agent_profiles SET is_builtin = COALESCE(is_builtin, 0) WHERE is_builtin IS NULL");
  sqlite.exec("UPDATE agent_profiles SET created_at = COALESCE(created_at, strftime('%s','now') * 1000) WHERE created_at IS NULL");
  sqlite.exec("UPDATE agent_profiles SET updated_at = COALESCE(updated_at, strftime('%s','now') * 1000) WHERE updated_at IS NULL");
}

// One drizzle handle per dbPath, reused across the process. Each
// `createDb()` call used to open a fresh `bun:sqlite` connection;
// dashboards that issue 5 queries per task × 51 tasks were paying
// 255 connection-opens per request, dominating `/tasks` latency.
// `bun:sqlite` is a thread-local handle and is safe to reuse across
// concurrent Promise.all calls in the same JS event loop.
//
// Cache validity: a cached handle stays good as long as the file
// at `dbPath` is the same one we opened. If a test fixture (or a
// rare ops action) deletes and recreates the DB file under us,
// the cached FD is still bound to the unlinked inode — every read
// then targets a phantom file. Guard with a per-call `existsSync`
// check; cheap (one stat) and closes that footgun.
// The cache holds the drizzle handle (typed against the canonical bun
// adapter) plus the portable raw view. On Bun, `raw` IS the native
// bun:sqlite handle; on Node it's the better-sqlite3 wrapper — both back
// the SAME underlying connection the drizzle handle uses, so raw queries
// and drizzle statements interleave on one connection.
const dbHandleCache = new Map<string, { handle: BunSQLiteDatabase<typeof schema>; raw: RawSqlite }>();

export function createDb() {
  const dbPath = getDatabasePath();
  const cached = dbHandleCache.get(dbPath);
  if (cached && existsSync(dbPath)) return cached.handle;
  if (cached) {
    // File was unlinked under us — drop the stale handle and
    // initializedDatabases marker so the new connection re-runs
    // the bootstrap migration on the freshly-created file.
    try {
      cached.raw.close();
    } catch {
      // best-effort cleanup
    }
    dbHandleCache.delete(dbPath);
    initializedDatabases.delete(dbPath);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  // One connection backs BOTH the drizzle handle (native) and getRawSqlite
  // (raw view). drizzle's adapter requires the native driver handle, not the
  // RawSqlite wrapper.
  const { native, raw } = openSqlite(dbPath);
  applyPragmas(raw);
  ensureDatabaseInitialized(raw, dbPath);
  const handle = createDrizzle(native, schema) as BunSQLiteDatabase<typeof schema>;
  dbHandleCache.set(dbPath, { handle, raw });
  return handle;
}

/**
 * Raw SQLite handle for cases drizzle can't model (FTS5 virtual tables,
 * JSON extensions, PRAGMA queries). Same connection as the drizzle handle
 * from `createDb()`; reuses the per-path cache. Callers must NOT close it —
 * the cache owns lifecycle. Returns the portable {@link RawSqlite} surface
 * (bun:sqlite handle on Bun, better-sqlite3 wrapper on Node).
 */
export function getRawSqlite(): RawSqlite {
  const dbPath = getDatabasePath();
  // Force-init via createDb so the cache + bootstrap migration run.
  createDb();
  const cached = dbHandleCache.get(dbPath);
  if (!cached) {
    throw new Error("getRawSqlite: cache miss after createDb()");
  }
  return cached.raw;
}
