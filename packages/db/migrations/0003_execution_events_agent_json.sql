-- ⚠️  GREENFIELD-ONLY — DO NOT RUN AGAINST AN EXISTING DATABASE.
--
-- The runtime migration path is `packages/db/src/client.ts ::
-- ensureExecutionEventIndexes()` which uses idempotent
-- `try { ALTER TABLE ... } catch {}` ADD COLUMN statements. That's the
-- code path that runs on every `bun run migrate` and on every
-- `restart.sh` boot.
--
-- This .sql file exists only for greenfield installs that bootstrap
-- via raw `*.sql` files in `migrations/` (drizzle-kit migrate, manual
-- sqlite import, etc.). The `ADD COLUMN` statements below are NOT
-- idempotent — SQLite has no `ADD COLUMN IF NOT EXISTS`. Running this
-- file on a database where `client.ts` already added the columns will
-- throw "duplicate column name".
--
-- If a future migration runner sweeps `migrations/*.sql` against a
-- live database, gate this file behind a check like
-- `SELECT 1 FROM pragma_table_info('execution_events') WHERE name = 'agent_json'`
-- before applying.
--
-- Plan v2.1 §Δ.1 + §Δ.5 / Step 0b — persist `agent` envelope on every
-- execution event so snapshot replay emits WireEvents bit-identical to
-- the live SSE path (no more `roleRuntimeId !== leaderRunId` heuristic).
--
-- Two new columns on `execution_events`:
--   • `agent_json TEXT`           — full agentMeta as JSON (id/role/name/depth/parentId/parentToolUseId)
--   • `parent_tool_use_id TEXT`   — denormalized hot-path field for the
--                                   teammate-transcript lazy-load endpoint
--                                   (`/tasks/:id/teammate/:toolUseId/transcript`).
--                                   Indexed for O(log n) teammate-event filtering;
--                                   `json_extract(agent_json, '$.parentToolUseId')`
--                                   would force a full table scan.
--
-- Backwards compat: pre-migration rows have `agent_json = NULL` and
-- `parent_tool_use_id = NULL`. The frontend snapshot path falls back
-- to the legacy `roleRuntimeId` heuristic for those rows (§Δ.4).

ALTER TABLE execution_events ADD COLUMN agent_json TEXT;
ALTER TABLE execution_events ADD COLUMN parent_tool_use_id TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_events_parent_tool
  ON execution_events(task_id, parent_tool_use_id)
  WHERE parent_tool_use_id IS NOT NULL;
