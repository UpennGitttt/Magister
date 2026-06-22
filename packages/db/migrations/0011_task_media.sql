-- GREENFIELD-ONLY. Runtime bootstrap in packages/db/src/client.ts keeps
-- existing installs up to date.

CREATE TABLE IF NOT EXISTS task_media (
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_id TEXT,
  role_runtime_id TEXT,
  source_tool_call_id TEXT,
  source_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  caption TEXT,
  display TEXT NOT NULL DEFAULT 'inline',
  status TEXT NOT NULL DEFAULT 'ready',
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  retained_until INTEGER,
  PRIMARY KEY (task_id, id)
);

CREATE INDEX IF NOT EXISTS idx_task_media_task_created
  ON task_media(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_media_status
  ON task_media(status);
