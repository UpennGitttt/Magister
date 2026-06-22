-- v3 §P1-5 — mid-flight objective edit.
-- When the user edits the goal's objective via
-- PATCH /tasks/:id/goal/objective, this timestamp is set so the next
-- continuation render uses objective_updated.md instead of
-- continuation.md, then clears the timestamp so the special template
-- only fires for one iteration.
ALTER TABLE tasks ADD COLUMN goal_objective_edited_at INTEGER;

-- v3 §P1-8 — evaluator parse-failure backstop.
-- Counter for consecutive evaluator returns that failed to parse
-- into READY/BLOCKED. Resets to 0 on any successful parse. At 3+
-- the goal auto-pauses with a "switch evaluator model" hint.
ALTER TABLE tasks ADD COLUMN goal_evaluator_parse_failures INTEGER DEFAULT 0;
