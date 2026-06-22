# Changelog

All notable changes to Magister are tracked here. Format: Keep-a-Changelog,
ordered newest first. Date stamps use the project local convention
(see `docs/status/master-tracker.md` for context per release).

## [Unreleased] — Stability cluster (2026-05-07 → 2026-05-08)

Eight stability commits + one URL polish. The aim was to make Magister
trustworthy as a primary productivity tool — to address the
"I don't dare use this for real work" feedback. All changes
kimi-reviewed (3 review rounds, 13+ findings, all addressed).
Branch range: `4ff0109..a5922d4`. Plan:
`docs/plans/2026-05-07-stability-cluster.md`.

### Added

- **Settings → Diagnostics tab** (`6f1b9ce`) — surfaces compaction
  history (stats strip + clickable summary modal) and per-model cost
  breakdown over a configurable window (1d / 7d / 30d / 90d).
- **`GET /diagnostics/compaction-history`** — paged list of
  `leader.messages_compacted` events with SQL-aggregate stats, fed
  by `json_extract` over `payload_json` for constant memory.
- **`GET /diagnostics/compaction-history/summary/:seq`** —
  drilldown for the full LLM summaryText of a single event.
- **`GET /diagnostics/usage-by-model`** — cost / call breakdown
  grouped by `(model, provider)` over a sliding window.
- **`SessionSummaryBanner`** — sticky chat banner above the message
  stream, polling latest compaction's summaryText for the active
  task on a 30s cadence.
- **Anthropic prompt-cache support** (`bc86119`) — `cache_control:
  ephemeral` markers on system prompt, last tool definition, and
  the last block of the prior user turn (rolling cache); cost calc
  applies 0.1× discount on cache reads, 1.25× on cache writes.
- **API retry + backoff** (`5d7d921`) — 408/429/500-504/529 with
  full jitter (avoids thundering herd), Retry-After parsing
  including the `Retry-After: 0` immediate-retry case (RFC 7231
  §7.1.3).
- **Terminal reason banners** — `pickFinalAnswer` now emits a
  user-visible message per `LeaderTerminal.reason` (max-turns,
  aborted-streaming, model-error, prompt-too-long, image-error,
  blocking-limit, hook-stopped). Banner prepends to model text or
  replaces blank answer.
- **Orphan child reaper** — `runtime-recovery-service` walks
  RUNNING runtimes with `parentRunId`; reaps when parent is in
  `{COMPLETED, FAILED, CANCELLED}`, with race guard on stale
  snapshots and explicit BLOCKED-task preservation.

### Changed

- **Token usage moved to SQLite** (`460ce6e`). Was process-local
  `usageRecords[]` array, wiped on every `restart.sh`. Now backed
  by `token_usage_records` table + `tasks.accumulated_*` columns
  (Goose dual-column accumulator pattern); cost computed at write
  time (Traceloop pattern); 30-day TTL + 50K-row cap retention.
- **`DEFAULT_AUTOCOMPACT_RATIO` 0.7 → 0.6** — earlier proactive
  compaction = lower cumulative cost on long sessions. Tunable via
  `MAGISTER_LEADER_AUTOCOMPACT_RATIO` env.
- **Image attachment token estimate** — was charging the full
  base64 byte length (~325k tokens for a 1 MB PNG, instantly
  tripping compaction); now charges fixed
  `APPROX_TOKENS_PER_IMAGE = 1600`.
- **LLM-summary compaction now actually fires for organic chat
  growth** (`5d7d921`). Was 0/13 in production data because
  `stillNeedsCompaction` checked POST-mechanical tokens — when
  truncate alone was enough, LLM was skipped. New
  `wouldBenefitFromSummary` check on PRE-mechanical tokens.
- **`/settings?tab=...` URL is the source of truth** (`a5922d4`)
  for the active tab; tab clicks reflect back via
  `setSearchParams` for bookmarkable settings.

### Fixed

- **Retention sweep no longer holds the SQLite write lock for
  multi-second windows** (kimi P1.5 review M2). Chunked deletes in
  short transactions (BATCH_SIZE=1000) — concurrent recordUsage
  writers see brief lock acquisitions instead of waiting through
  a single big sweep.
- **PK-keyed cap deletion** (kimi P1.5 review M3). Was
  timestamp-based; burst inserts sharing a millisecond could not
  be evicted. Now uses `DELETE WHERE id IN (SELECT id ORDER BY
  recorded_at ASC, id ASC LIMIT chunk)`.
- **`getTaskAggregate` SQL aggregates** (kimi P1 review M4). Was
  full-row `findMany`; now uses SUM, COUNT(DISTINCT), DISTINCT
  model + LIMIT 1 for latest. O(1) instead of full scan.
- **Diagnostics stats now constant-memory** (kimi P1.5 review M).
  Was loading every matching event into JS for stats; now uses
  raw SQL with `json_extract` + AVG/SUM CASE.
- **Strict `seq` parsing for diagnostics summary endpoint** (kimi
  P1.5 review M). `parseInt("123abc")` was accepted as 123 and
  silently returned the wrong event; now `/^\d+$/` regex check.
- **Race guard on orphan reaper** (kimi P1.7-P5 review C). The
  reaper acted on a stale runtimes snapshot; if a child naturally
  transitioned terminal between read and write, it was clobbered
  back to FAILED. Now re-fetches and bails if state changed.
- **BLOCKED tasks excluded from forced FAILED** (kimi P1.7-P5
  review M) on parent-terminal reaping. Preserves manual
  intervention workflow.
- **Abort-vs-network-error distinction** in retry sleep (kimi
  P1.7-P5 review M). When user cancels mid-backoff, callers now
  see AbortError instead of the underlying fetch error.

### Removed

- **In-memory `usageRecords[]` LRU** (kimi P1 review C) — was
  source of silent-data-loss when DB outage and recovery
  interleaved. DB is now sole source of truth.

### Tests

1187/1187 backend tests pass; +14 new unit tests covering retry
paths, P3 banners, orphan reaping (with/without parent terminal),
retention TTL/cap edges, image-token estimation, and rolling-cache
marker placement (including tool_result-as-prior-turn case).

### E2E verification

Live in browser via Playwright (2026-05-08): all 5 Settings tabs
render, new chat full lifecycle (thinking → bash tool → final
answer) succeeds, token usage immediately queryable via
`/tasks/:id/usage`, SessionSummaryBanner correctly hidden when no
compaction. CI: 1187/1187 backend tests, typecheck clean.
