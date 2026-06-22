-- ⚠️  GREENFIELD-ONLY — see 0005 for context on the migration policy.
--
-- Sandbox-elevation v4.3 §4.9 — extend command_approval_rules with an
-- optional JSON payload carrying the AdditionalPermissionProfile that
-- was approved alongside the prefix rule. When the user clicks
-- "Approve + save rule" on a v4 approval card with
-- `additional_permissions` set, the persisted row carries:
--   pattern_kind: 'argv_prefix'
--   pattern_json: ["npm","install"]
--   additional_permissions_json: '{"file_system":{"entries":[...]}}'
--
-- On future bash calls matching the prefix, the matcher returns the
-- rule PLUS the saved permission profile so the dispatcher can apply
-- the binds without re-prompting.
--
-- 8 KiB cap enforced at the DB layer via CHECK constraint AND at the
-- app layer (defense in depth). 8 KiB realistic for 32 absolute paths
-- + JSON overhead; codex GPT-5.5 review #11 (v4.0→v4.1) ratified.

ALTER TABLE command_approval_rules
  ADD COLUMN additional_permissions_json TEXT
    CHECK (additional_permissions_json IS NULL
        OR length(additional_permissions_json) <= 8192);
