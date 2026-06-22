-- 2026-05-22 — local body-bytes estimate of the actual prompt token
-- count. Used as the authoritative context-window number when the
-- provider reports a non-real `prompt_tokens` (Volcengine Ark
-- `/api/coding/v3` empirical: 12K chars → 12 reported tokens, a
-- ~1000× discount that reflects billable units, not actual size).
-- See estimateTokensFromBodyBytes in streaming-api-caller.ts.
ALTER TABLE token_usage_records ADD COLUMN estimated_prompt_tokens INTEGER;
