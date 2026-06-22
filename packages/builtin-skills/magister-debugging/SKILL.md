---
name: magister-debugging
description: Use when a subagent reports a bug, a test fails, or the user reports unexpected behavior. Covers 5-phase systematic debugging, root cause investigation, pattern analysis, hypothesis testing. Don't use for implementation tasks or design tasks.
---

# magister-debugging — 5-Phase Systematic Debug

## Objective
Use this skill when a test fails, a subagent reports BLOCKED/FAILED due to unexpected behavior, or the user reports a bug. The goal is to reproduce, isolate root cause, compare against working patterns, test one hypothesis, fix with a regression test, and verify no regression. Do not use this for greenfield implementation, design brainstorming, or review findings that already have a straightforward fix plan.

## Decision Tree
| Condition | Action | Output |
|-----------|--------|--------|
| Failure is not reproducible | Reproduce first | Exact command/input or BLOCKED |
| Error points to recent diff | Inspect diff and surrounding code | Candidate cause |
| Similar working pattern exists | Compare broken vs working | Pattern delta |
| Multiple possible causes | Test one hypothesis at a time | Evidence for/against |
| Same fix attempt failed 3 times | Stop and escalate | Human-facing blocker report |
| Root cause is known and testable | Write regression test | Hand to TDD fix loop |
| Fix passes targeted test | Run broader verification | Handoff to review/shipping |

### 5-Phase Debug
| Phase | Required Action | Exit Criteria |
|-------|-----------------|---------------|
| 1. Root Cause Investigation | Read error, reproduce, inspect recent diff, add temporary logging only if needed | Repro command and suspect area |
| 2. Pattern Analysis | Find working analog in same codebase | Concrete delta between working and broken |
| 3. Hypothesis & Testing | State one theory and run the smallest check | Hypothesis confirmed or rejected |
| 4. Implementation | Apply TDD: regression test first, then fix | Targeted test green |
| 5. Verification | Run affected suite/full suite as risk requires | Regression confidence recorded |

### Debug Tool Guide
| Stack | First Tools | Deeper Tools | Notes |
|-------|-------------|--------------|-------|
| TypeScript/Bun | `bun test <file>`, `bun run typecheck`, targeted `console.error` | node inspector, source maps, `rg` for call sites | Remove temporary logs before done |
| React/Vite | component tests, Playwright trace/screenshot, browser console | React DevTools, network tab | Verify DOM state, not just implementation |
| API/HTTP | route tests, `curl`, server logs | request IDs, DB query logging | Capture status/body/headers |
| Database/Drizzle | migration tests, schema tests, SQL logs | transaction replay, fixture minimization | Avoid manual production data changes |
| CLI/process | exit code, stdout/stderr, cwd/env dump | strace-like tooling if available | Check argv length and absolute paths |
| Git/worktree | `git status --short`, `git diff`, `git worktree list` | `git reflog`, bisect | Never use destructive reset without approval |

### Common Bug Pattern Library
| Pattern | Signature | Quick Recognition |
|---------|-----------|-------------------|
| Off-by-one / pagination | Missing first/last item | Boundary tests fail at 0/1/page size |
| Async race | Flaky pass/fail or timeout | Add ordering logs; await missing promise |
| Stale cache | Old data after mutation | Bypass cache or inspect invalidation path |
| Null/undefined contract drift | Cannot read property / optional field absent | Compare type/schema/API response |
| Serialization mismatch | Dates/enums/BigInt fail over API | Inspect raw JSON and parser |
| Path/cwd error | File not found in subagent/CLI | Print cwd; switch to absolute path |
| Environment/config drift | Works locally, fails in test/CI | Compare env defaults and config loading |
| Transaction leak | Later tests fail unexpectedly | Run test alone vs suite |
| Timezone/time dependency | Date tests fail by locale/time | Freeze time or use UTC boundaries |
| Over-broad mock | Test passes but integration fails | Replace mock with real fixture/contract test |

## Templates
### Debug Report Template
```markdown
DEBUG_REPORT
Symptom: <what failed>
Repro: <exact command/input>
Recent changes: <relevant diff/files>
Working analog: <file:line or none found>
Hypothesis: <single theory>
Test performed: <command/check>
Result: <confirmed/rejected>
Fix: <summary or pending>
Verification: <commands/output>
Status: <FIXED|BLOCKED|ESCALATE>
```

### Project Spec Bug Entry Template
```markdown
project_spec.debug:
  symptom: <failure summary>
  repro: <command/input>
  root_cause: <confirmed cause or unknown>
  regression_test: <test path/name>
  fix_status: <in_progress|implemented|verified|failed>
  attempts:
    - <hypothesis + result>
```

### Escalation Template
```markdown
BLOCKED_DEBUG
Symptom: <failure>
Repro: <command>
Attempts:
- <attempt 1 result>
- <attempt 2 result>
- <attempt 3 result>
Known facts: <confirmed evidence>
Unknowns: <what blocks progress>
Options: <ask human | spawn architect | isolate worktree | revert partial>
```

## Examples
### Debug Report Example
```markdown
DEBUG_REPORT
Symptom: `task-graph.test.ts` expects a blocked reason but receives undefined.
Repro: `bun test apps/api/test/routes/task-graph.test.ts`
Recent changes: apps/api/src/routes/tasks.ts added blocked status mapping.
Working analog: apps/api/src/routes/run-context.ts includes optional narrative fields in the response mapper.
Hypothesis: The repository object contains `blockedReason`, but the route serializer drops it.
Test performed: Added assertion at route response level; unit repository fixture includes blockedReason.
Result: confirmed.
Fix: Include `blockedReason` in the route serializer when present.
Verification: targeted route test passes; typecheck passes.
Status: FIXED
```

### Project Spec Entry Example
```markdown
project_spec.debug:
  symptom: CLI subagent reports tests pass, but leader rerun fails in `spawn-teammate-dispatch.test.ts`.
  repro: bun test apps/api/test/services/spawn-teammate-dispatch.test.ts
  root_cause: Test depended on shared mutable fixture state.
  regression_test: apps/api/test/services/spawn-teammate-dispatch.test.ts "isolates role fallback fixtures"
  fix_status: verified
  attempts:
    - "Assumed route bug; rejected because route test passed alone."
    - "Compared fixture setup; confirmed shared mutation."
```

### Escalation Example
```markdown
BLOCKED_DEBUG
Symptom: Web e2e navigation test times out only in full suite.
Repro: `bun test:e2e apps/web/e2e/navigation.spec.ts` passes alone; full suite fails.
Attempts:
- Added wait for navigation event; rejected, timeout remains.
- Compared auth fixtures; no difference found.
- Disabled one neighboring test locally; failure moved, suggesting shared state.
Known facts: Failure is order-dependent and not tied to route rendering.
Unknowns: Which fixture leaks browser/storage state.
Options: spawn evaluator for suite bisection, or ask human whether to spend more budget.
```

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Fixing from the error message without repro | Wrong patch | Reproduce first |
| Testing several hypotheses at once | Cannot identify cause | One hypothesis, one check |
| Ignoring working analogs | Reinvents local patterns | Compare with known-good code |
| Leaving debug logs | Noisy production/test output | Remove before final verification |
| Retrying after 3 failed attempts | Wastes budget | Escalate with evidence |
| Skipping regression test after root cause | Bug can return | Add targeted regression test |
| Treating flaky pass as fixed | Hidden race remains | Run enough repetitions or broader suite |

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| Root cause known and fix required | `magister-tdd-and-review` | Regression test target, fix scope, repro |
| Debugging requires a separate bounded investigation | `magister-delegating` | Evaluator/architect/coder goal with evidence |
| Bug invalidates accepted design | `magister-planning` | New constraints and failed assumption |
| Debug work is complete and verified | `magister-shipping` | Debug report and verification output |
| Failure is from CLI runtime behavior | `magister-cli-subagents` | CLI stderr/stdout, argv/path/permission evidence |
