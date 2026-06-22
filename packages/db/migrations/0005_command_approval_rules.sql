-- ⚠️  GREENFIELD-ONLY — DO NOT RUN AGAINST AN EXISTING DATABASE.
--
-- The runtime migration path is `packages/db/src/client.ts` —
-- idempotent CREATE TABLE IF NOT EXISTS in `ensureSkillsAndAgentTables`
-- and adjacent helpers run on every `bun run migrate` and `restart.sh`
-- boot. This .sql file exists for greenfield installs that bootstrap
-- via raw `*.sql` files in `migrations/`.
--
-- Spec §1 (2026-05-17 — `docs/specs/2026-05-16-agent-loop-sota-upgrades-spec.md`)
-- — persistent approval-rule store for the sandbox escalation
-- protocol. When the model requests bash with
-- `sandbox_permissions: "require_escalated"` + `prefix_rule:
-- ["npm","install"]`, the user can approve once OR approve and
-- save the prefix as a durable rule. Persisted rows match future
-- commands so the model doesn't have to re-prompt for the same
-- command shape.

CREATE TABLE IF NOT EXISTS command_approval_rules (
  id TEXT PRIMARY KEY NOT NULL,
  tool TEXT NOT NULL,
  pattern_kind TEXT NOT NULL,         -- 'argv_prefix' | 'path_glob' | 'literal'
  pattern_json TEXT NOT NULL,         -- shape depends on pattern_kind
  scope TEXT NOT NULL,                -- 'global' | 'project' | 'session'
  project_path TEXT,                  -- canonicalized; NOT NULL when scope='project'
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  expires_at INTEGER,                 -- optional TTL; NULL = never expires
  enabled INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  justification_template TEXT
);

CREATE INDEX IF NOT EXISTS idx_command_approval_rules_lookup
  ON command_approval_rules(tool, enabled, scope, project_path)
  WHERE enabled = 1;
