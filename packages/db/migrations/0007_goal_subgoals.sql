-- v3 §P0-2 — user-controlled subgoals (mid-flight criteria refinement).
-- Lets the user add tightening conditions to a running goal without
-- pausing the loop. JSON array of strings; NULL/empty = none.
-- See packages/db/src/schema.ts `tasks.goalSubgoals` for usage.
ALTER TABLE tasks ADD COLUMN goal_subgoals TEXT;
