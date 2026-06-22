---
name: magister-tdd-and-review
description: Use when the leader is orchestrating a build phase or a review phase. Covers TDD discipline (red-green-refactor), Two-Stage Review (Spec Compliance + Code Quality), Receive Code Review (ACCEPT/PUSHBACK/ASK), Bidirectional Confidence Scoring (1-10). Don't use for non-software tasks.
---

# magister-tdd-and-review — TDD & Two-Stage Review

## Objective
Use this skill during build and review phases to keep implementation evidence-driven: failing test first when applicable, minimal fix, green verification, then independent review. It also defines how reviewers and implementers exchange findings with confidence scores so the leader can route fixes without guesswork. Do not use this skill for non-software tasks, pure planning, or bug triage before a reproducible failure exists.

## Decision Tree
| Condition | Action | Route |
|-----------|--------|-------|
| Implementing a feature or bugfix with test harness | Use TDD | Red -> green -> refactor |
| No test harness exists | BLOCKED unless exemption applies | Ask leader/human for strategy |
| Change is pure styling, copy, generated snapshot, or dependency bump | Exemption may apply | State exemption inline and run relevant verification |
| Build phase completed | Start Stage A review | Spec compliance first |
| Stage A finds missing/extra/misinterpreted behavior | Return to implementer | Do not run Stage B yet |
| Stage A clean | Start Stage B review | Code quality checklist |
| Reviewer and coder disagree | Use conflict arbitration | Evidence beats preference |
| Review passes and verification is green | Hand off to shipping | Preserve evidence |

### TDD Discipline
1. Write a failing test naming the acceptance criterion.
2. Run the test and capture red output.
3. Write the minimal implementation.
4. Run the test and capture green output.
5. Refactor only if it reduces real complexity; rerun green verification.

### TDD Exemption Matrix
| Change Type | Can Skip Red Test? | Required Replacement Evidence |
|-------------|--------------------|-------------------------------|
| Pure copy/text change | Yes | Snapshot/render/unit test if available, otherwise file diff |
| Pure CSS/styling | Usually | Visual/screenshot or component smoke test |
| Dependency bump | Yes | Lockfile diff + affected test suite |
| Generated file only | Yes | Generator command and diff review |
| Test harness absent | No automatic skip | BLOCKED or create minimal harness with approval |
| Bugfix with repro | No | Regression test first |
| Shared contract/API/schema | No | Contract/integration test first |

### Confidence Anchors
| Score | Meaning |
|-------|---------|
| 1 | Guess; no file or command evidence |
| 2 | Weak suspicion; incomplete read |
| 3 | Plausible issue but unverified |
| 4 | Some evidence, material uncertainty remains |
| 5 | Balanced uncertainty; needs another check |
| 6 | More likely than not; evidence is partial |
| 7 | Solid evidence, minor unknowns |
| 8 | Strong evidence with file:line or command output |
| 9 | Very strong evidence; alternative explanations unlikely |
| 10 | Directly proven by test, invariant, or spec quote |

### Bidirectional Confidence Routing
| Condition | Leader Action |
|-----------|---------------|
| All findings ACCEPT with fix-plan confidence >= 8 | AUTO-FIX: re-spawn implementer with fix_plan |
| Any finding ACCEPT with fix-plan confidence < 8 | `request_human_input` |
| Any PUSHBACK | `request_human_input` (present finding + rebuttal) |
| Any ASK | `request_human_input` |
| Reviewer finding confidence < 5 | Re-spawn reviewer for evidence first |

## Templates
### Build Report Template
```markdown
BUILD_REPORT
Scope: <files changed>
Acceptance: <criteria>
TDD:
- Red: <command + key failing output or exemption>
- Green: <command + key passing output>
Refactor: <none or summary + rerun command>
Changed files: <paths>
Risks: <remaining risk or none>
```

### Stage A Review Template
```markdown
STAGE_A_SPEC_COMPLIANCE
Result: <PASS|FAIL>
Spec checked: <plan/spec reference>
Findings:
- <severity> <file:line> <missing|extra|misinterpreted behavior> Confidence: <1-10>
Decision: <proceed to Stage B | return to implementer>
```

### Stage B Code Quality Checklist
```markdown
STAGE_B_CODE_QUALITY
- [ ] File ownership matches delegated scope.
- [ ] Existing local patterns are followed.
- [ ] Names describe domain behavior.
- [ ] No dead code, TODO/FIXME placeholders, or debug logging.
- [ ] Error paths and edge cases match surrounding code.
- [ ] Tests assert behavior rather than implementation details.
- [ ] No unrelated formatting or metadata churn.
- [ ] No secrets, temp files, generated junk, or broad `git add -A` risk.
Result: <PASS|FAIL>
Findings: <file:line evidence with confidence>
```

### Review Response Template
```markdown
REVIEW_RESPONSE
Finding: <id or summary>
Response: <ACCEPT|PUSHBACK|ASK>
Confidence: <1-10>
Evidence: <file:line / invariant / spec quote / command>
Fix plan: <only for ACCEPT>
Question: <only for ASK>
```

### Conflict Arbitration Template
```markdown
CONFLICT
Reviewer claim: <finding + confidence + evidence>
Coder response: <ACCEPT|PUSHBACK|ASK + confidence + evidence>
Leader ruling: <accept finding | accept pushback | ask human | request third check>
Reason: <spec quote, test output, invariant, or missing evidence>
Next action: <fix | no-op | debug | re-plan>
```

## Examples
### Build Report Example
```markdown
BUILD_REPORT
Scope: apps/api/src/routes/tasks.ts, apps/api/test/routes/task-graph.test.ts
Acceptance: Blocked task responses include `blockedReason`.
TDD:
- Red: `bun test apps/api/test/routes/task-graph.test.ts` failed because `blockedReason` was undefined.
- Green: `bun test apps/api/test/routes/task-graph.test.ts` passed 12 tests.
Refactor: none.
Changed files: apps/api/src/routes/tasks.ts, apps/api/test/routes/task-graph.test.ts
Risks: none beyond existing route coverage.
```

### Stage A Example
```markdown
STAGE_A_SPEC_COMPLIANCE
Result: FAIL
Spec checked: Approved plan "blocked task reason"
Findings:
- High apps/web/src/components/settings/StatusPanel.tsx:88 Missing UI rendering for `blockedReason`; API work is present but user-visible acceptance is incomplete. Confidence: 9
Decision: return to implementer
```

### Stage B Example
```markdown
STAGE_B_CODE_QUALITY
- [x] File ownership matches delegated scope.
- [x] Existing local patterns are followed.
- [x] Names describe domain behavior.
- [ ] No dead code, TODO/FIXME placeholders, or debug logging.
- [x] Error paths and edge cases match surrounding code.
- [x] Tests assert behavior rather than implementation details.
- [x] No unrelated formatting or metadata churn.
- [x] No secrets, temp files, generated junk, or broad `git add -A` risk.
Result: FAIL
Findings: Medium apps/api/src/routes/tasks.ts:142 debug `console.log` left in route handler. Confidence: 10
```

### Conflict Example
```markdown
CONFLICT
Reviewer claim: StatusPanel should handle empty `blockedReason` as absent. Confidence 8, file:line evidence.
Coder response: PUSHBACK, backend always sends non-empty string. Confidence 6, no schema evidence.
Leader ruling: accept finding.
Reason: API type allows `blockedReason?: string`, so UI must handle absent/empty values.
Next action: coder fixes UI guard and adds test.
```

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Implementing before red test for behavior change | No proof the test catches regression | Write and run failing test first |
| Claiming "no test harness" and proceeding | Unverifiable change | BLOCKED or ask to create minimal harness |
| Running code quality review before spec compliance | Polishes wrong behavior | Stage A must pass first |
| Treating confidence as vibes | Bad routing decisions | Anchor confidence to evidence |
| Accepting every reviewer finding automatically | Churn and wrong fixes | Require ACCEPT/PUSHBACK/ASK with evidence |
| Pushing back without file:line/spec/command | Opinion conflict | Ask for evidence or accept finding |
| Skipping rerun after refactor | Regression risk | Rerun the green command |

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| Review passes and verification evidence is green | `magister-shipping` | Build report, review result, command outputs |
| Test fails, behavior is unexplained, or regression appears | `magister-debugging` | Failing command, logs, suspected files |
| Review fails with clear implementation work | `magister-delegating` | Findings and narrowed coder goal |
| Review reveals plan/spec mismatch | `magister-planning` | Mismatch and proposed plan amendment |
| Need CLI verification of a bounded patch | `magister-cli-subagents` | Compact verification goal and files |
