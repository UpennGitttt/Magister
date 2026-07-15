# Trusted Progress Engine (MVP)

Proactive team-progress layer: a sentinel worker patrols for risk signals,
a daily digest aggregates them into a Slack/Feishu report with action
buttons, and button clicks record the acted-on trust metric.

Spec: `docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md`

## Data flow

```
sentinel loop (5 min)                    digest loop (10 min check, fires 1x/day)
  ├─ stalled role_runtimes                 ├─ window = since last digest.sent (or 24h)
  ├─ overdue approvals                     ├─ aggregate: sentinel.signal events
  ├─ risk events (doom loop, budget)       │             + COMPLETED/BLOCKED tasks
  └─ external MCP checks (env JSON)        ├─ generate: one-shot leader-model call
        │                                  │   (JSON items; falls back to plain text)
        ▼                                  ├─ deliver: Slack Block Kit w/ buttons,
  execution_events                         │   else Feishu plain text, else none
  type=sentinel.signal ────────────────────┤
  (fingerprint-deduped per day)            └─ execution_events type=digest.sent

Slack button click (digest_act / digest_dismiss)
  └─ slack-router handleDigestAction
       ├─ digest_act: processTaskIntent(actionText) → new task + in-thread ack
       └─ execution_events type=digest.action_taken / digest.action_dismissed
```

## Files

| File | Role |
|---|---|
| `apps/api/src/services/sentinel-service.ts` | patrol tick + loop |
| `apps/api/src/services/digest-service.ts` | digest tick + loop, block builder |
| `apps/api/src/services/slack/slack-router.ts` | `handleDigestAction` button branch |
| `apps/api/src/repositories/execution-event-repository.ts` | `listByTypesSince` |

## Event types

`sentinel.signal`, `digest.sent`, `digest.action_taken`,
`digest.action_dismissed`. None may enter `NOISE_EVENT_TYPES`
(task-retention-service.ts) — the digest window and acted-on metric read
them back.

## Env vars (all off by default)

| Var | Default | Meaning |
|---|---|---|
| `MAGISTER_SENTINEL_ENABLED` | `false` | enable patrol loop |
| `MAGISTER_SENTINEL_INTERVAL_MS` | `300000` | patrol interval |
| `MAGISTER_SENTINEL_STALL_MS` | `1800000` | RUNNING runtime idle threshold |
| `MAGISTER_SENTINEL_APPROVAL_OVERDUE_MS` | `1800000` | pending approval age threshold |
| `MAGISTER_SENTINEL_MCP_CHECKS` | — | JSON `[{serverId,toolName,args?,label?}]` read-only checks |
| `MAGISTER_DIGEST_ENABLED` | `false` | enable digest loop |
| `MAGISTER_DIGEST_HOUR` | `9` | earliest local hour to send |
| `MAGISTER_DIGEST_SLACK_CHANNEL` | — | Slack channel id (preferred) |
| `MAGISTER_DIGEST_FEISHU_CHAT_ID` | — | Feishu chat id (plain-text fallback) |
| `MAGISTER_DIGEST_OPERATOR_IDS` | — | comma-separated Slack user ids allowed to click digest buttons; unset = any channel member (post to a private channel) |

## Known ceilings (v1)

- Digest generation calls `callStreamingApi` directly (memory-extractor
  precedent) — token usage is not recorded in the usage tables.
- No immediate alerting: signals surface in the next daily digest only.
- Acted-on metric has no query endpoint; events are in `execution_events`
  and SQL-queryable.
- Feishu path has no buttons (Slack-only interactivity by design).
- Times are server-local: the once-per-day gate and `MAGISTER_DIGEST_HOUR`
  follow the server TZ, not the operator's.
- `listByTypesSince` caps at 500 rows — with >500 signals/day the sentinel
  dedup set and the digest window silently truncate. Paginate if a fleet
  ever gets that noisy.
- The four event types have no `taskId`, so task retention never prunes
  them; a long-running instance accumulates them until a TTL path exists.
