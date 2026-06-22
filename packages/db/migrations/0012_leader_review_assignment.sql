-- 2026-05-24 — Phase 1 of the Leader-driven review autonomy RFC
-- (docs/plans/2026-05-24-leader-review-autonomy.md §5.1).
--
-- GREENFIELD-ONLY. Runtime bootstrap in packages/db/src/client.ts
-- keeps existing installs up to date via idempotent ALTER TABLE
-- ADD COLUMN. The CREATE TABLE blocks in client.ts already include
-- these columns; this file exists for migration tooling /
-- documentation parity.

-- workspaces.review_policy_json — per-workspace policy doc.
-- Default keeps existing behaviour (HITL). Flipping to
-- '{"version":1,"mode":"leader-driven"}' enables Leader inbox.
ALTER TABLE workspaces
  ADD COLUMN review_policy_json TEXT NOT NULL
  DEFAULT '{"version":1,"mode":"hitl"}';

-- change_reviews columns for Leader-driven review:
--   assignee                       'user' (default, today's behaviour) | 'leader'
--   assignee_set_by                'router' | 'leader' | 'manual' (audit)
--   reviewer_verdict_artifact_id   typed reviewer verdict artifact (RFC §5.3)
--   leader_apply_commit_sha        SHA of Leader's auto-commit so the
--                                  operator's `git revert <sha>` is a real recourse
ALTER TABLE change_reviews ADD COLUMN assignee TEXT NOT NULL DEFAULT 'user';
ALTER TABLE change_reviews ADD COLUMN assignee_set_by TEXT;
ALTER TABLE change_reviews ADD COLUMN reviewer_verdict_artifact_id TEXT;
ALTER TABLE change_reviews ADD COLUMN leader_apply_commit_sha TEXT;

-- Compound index for the future Leader-inbox sweep
-- (`WHERE assignee = 'leader' AND decision_state = 'pending'`) and
-- the operator's "show me only mine" filter.
CREATE INDEX IF NOT EXISTS idx_change_reviews_assignee_state
  ON change_reviews(assignee, decision_state);
