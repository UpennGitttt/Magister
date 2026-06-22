-- Board "Attention" column dismissal flag.
-- See packages/db/src/schema.ts `tasks.attentionDismissedAt` for usage.
ALTER TABLE tasks ADD COLUMN attention_dismissed_at INTEGER;
