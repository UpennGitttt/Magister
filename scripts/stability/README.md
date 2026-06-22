# Orchestration Reliability Harness

This harness creates many tasks, monitors terminal states, applies recovery actions (`retry` / `continue`), and prints a JSON metrics summary.

## Run

```bash
bun scripts/stability/orchestration-reliability-harness.ts --tasks 100 --concurrency 8
```

## Key Options

- `--api http://127.0.0.1:3700`
- `--workspace workspace_main`
- `--source web|cli`
- `--task-kind coding|conversation`
- `--tasks 100`
- `--concurrency 8`
- `--poll-ms 2000`
- `--task-timeout-ms 1200000`
- `--request-timeout-ms 30000`
- `--max-recovery-attempts 2`
- `--chaos-rate 0.15`
- `--seed 12345` (optional, makes chaos assignment deterministic)
- `--prompt-prefix "Reliability harness task"`

## Quick Smoke Run

For a fast local sanity check without waiting on long coding lanes:

```bash
bun scripts/stability/orchestration-reliability-harness.ts --task-kind conversation --tasks 5 --concurrency 2
```

## Output

The script prints one JSON object with:

- Result rates: `completionRate`, `blockedRate`, `timeoutRate`
- Error isolation: `errors`, `errorRate`
- Recovery metrics: `totalRecoveryAttempts`, `recoveredAfterBlockRate`
- Latency: `meanMs`, `p95Ms`
- Duplicate stop signal estimate: `duplicateStopReasonCount`, `duplicateStopReasonRate`

## Suggested Acceptance Gates

- `completionRate >= 0.95`
- `timeoutRate <= 0.02`
- `recoveredAfterBlockRate >= 0.70` (when faults are present)
- `duplicateStopReasonRate <= 0.01`
- `p95Ms` stays within your SLO budget for operator response
