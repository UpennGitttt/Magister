-- 2026-05-28 — per-task leader model override.
-- NULL = use the agent profile default; otherwise a modelName key
-- from config/executors.json.models. Set/cleared by the /model slash
-- command. Provider is re-derived at runtime spawn from
-- models[modelName].providerRefs.api.
ALTER TABLE tasks ADD COLUMN model_override TEXT;
