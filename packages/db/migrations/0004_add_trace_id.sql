-- ⚠️  GREENFIELD-ONLY — DO NOT RUN AGAINST AN EXISTING DATABASE.
--
-- The runtime migration path is `packages/db/src/client.ts` —
-- idempotent `try { ALTER TABLE ... } catch {}` ADD COLUMN statements
-- run on every `bun run migrate` and `restart.sh` boot. The .sql file
-- here exists only for greenfield installs that bootstrap via raw
-- `*.sql` files in `migrations/`. The `ADD COLUMN` below is NOT
-- idempotent — SQLite has no `ADD COLUMN IF NOT EXISTS`.
--
-- Spec §5 (2026-05-17 — `docs/specs/2026-05-16-agent-loop-sota-upgrades-spec.md`)
-- — root-level trace identifier:
--
--   • `tasks.trace_id TEXT`              — source of truth; equals
--     `tasks.id` for root tasks; carries the root's id forward when
--     a task is derived from another (future use cases: related-task
--     chains, scheduled spawns).
--
--   • `execution_events.trace_id TEXT`   — denormalized mirror of
--     `tasks.trace_id`, populated by the event projector at insert
--     time. Lets the trace view fetch an entire root-rooted event
--     tree in a single indexed SELECT without joining tasks.
--
-- Backwards compat: pre-migration rows have `trace_id = NULL`. Query
-- helpers use `COALESCE(trace_id, task_id)` so historical events
-- still respond to single-task-as-trace lookups.

ALTER TABLE tasks ADD COLUMN trace_id TEXT;
ALTER TABLE execution_events ADD COLUMN trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_trace_id
  ON tasks(trace_id)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_events_trace_id
  ON execution_events(trace_id, occurred_at)
  WHERE trace_id IS NOT NULL;
