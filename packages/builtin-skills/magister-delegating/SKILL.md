---
name: magister-delegating
description: Use when the leader needs to decide which role to spawn, how to write a teammate goal, whether to use git worktree isolation, or how to handle subagent status. Covers role selection matrix, goal writing discipline, worktree pre-flight, status contract routing. Don't use when no delegation is needed.
---

# magister-delegating — Teammate Delegation & Isolation

## Objective
Use this skill when the leader has an approved plan and must decide whether to spawn a teammate, which role to use, whether to isolate work in a worktree, and how to route the result. It keeps delegation bounded: every teammate receives a small goal capsule with paths, acceptance criteria, output contract, forbidden tools, and budget. Do not use this skill when the leader can complete the task directly faster than specifying and verifying a teammate.

## Decision Tree
| Condition | Action | Notes |
|-----------|--------|-------|
| Work is operational (restart, status check, run query, clean data) | Do locally | Spawning for ops is overhead, not value |
| Work is a quick investigation (read files, check logs, diagnostics) | Do locally | A few reads/greps do not justify a spawn |
| Work is immediate blocker for the leader's next step | Do locally | Do not delegate the critical path |
| Work is bounded, parallelizable, and has clear file ownership | Spawn teammate | Use goal capsule |
| User requested a specific role | Try that role once | Fallback only after unknown-role |
| Requested role is unavailable | Use closest builtin role | Surface the substitution |
| Task is CLI-runtime specific | Load `magister-cli-subagents` | Keep goal <=50 lines |
| Task has failing baseline or bug report | Hand to `magister-debugging` | Do not spawn blind implementation loop |
| Same role + same goal hash already spawned | Mark BLOCKED | Require a delta-goal |
| More than one independent task with disjoint files | Spawn in parallel | Assign ownership to avoid collisions |
| Tasks share files or depend on sequence | Spawn serially | Verify each result before next spawn |

### Role Selection Matrix
| Capability | Built-in | Custom Examples | Use When |
|------------|----------|-----------------|----------|
| think/plan | architect | product_strategist, designer | Architecture, UX, API shape, tradeoff analysis |
| build | coder | frontend_dev, backend_dev | Implement scoped code and tests |
| review | reviewer | security_reviewer, dx_reviewer | Spec compliance, code quality, security lens |
| verify | evaluator | qa, perf | Run acceptance checks, smoke tests, performance checks |
| ship | lander | release_engineer | Commit, PR, merge, release mechanics |

### Role Discovery & Fallback
1. Read the role list in `spawn_teammate`'s description. It contains the builtin roles plus any custom roles configured in this workspace. Always check for a custom role that fits the task better than a builtin before defaulting.
2. The custom role list is a snapshot. If a role was created mid-session, try the exact role once; the failure response should reveal current availability.
3. Fallback only after unknown-role.

Check `spawn_teammate`'s description for custom roles first — a workspace-configured `frontend_dev` or `security_reviewer` is better than falling back to a generic builtin.

| Target | Builtin Fallback | Goal Lens |
|--------|------------------|-----------|
| ai_designer, product_strategist, UX | architect | "design the interface / produce a design spec" |
| qa, perf | evaluator | "verify acceptance criteria / run performance test" |
| frontend_dev, backend_dev | coder | "implement this bounded scope" |
| security_reviewer, dx_reviewer | reviewer | "[SECURITY LENS] review for OWASP Top 10 or DX risks" |
| release_engineer | lander | "create commit / branch / PR for this change" |

### Worktree Pre-flight
1. `git check-ignore -q .worktrees` → if not ignored, add `.gitignore` entry.
2. Run the full test suite and confirm baseline is green.
3. Record baseline test count to `project_spec`.
4. Inspect `git status` for dirty files in the target scope; do not overwrite user changes.

### Isolation Matrix
| Scope | Conflict Risk | `isolate` | Reason |
|-------|---------------|-----------|--------|
| Single file, leader will not edit same file | Low | `false` | Worktree overhead is unnecessary |
| Multiple files in one module, one teammate | Medium | `true` if repo is clean enough | Protects user work and enables review |
| Multiple teammates with disjoint files | Medium | `true` for each | Prevents overlapping edits and simplifies integration |
| Shared files, generated files, migrations, lockfiles | High | Prefer serial; `true` only with explicit ownership | Parallel edits are likely to collide |
| Read-only review/evaluation | None | `false` | No writes expected |
| Dirty working tree in target files | High | Ask or avoid spawn | Do not overwrite user changes |

### Status Contract Routing
| Subagent Status | Leader Action | Next Step |
|-----------------|---------------|-----------|
| DONE with changed files and verification | Inspect diff and evidence | `magister-tdd-and-review` review/verification |
| DONE without evidence | Treat as unverified | Read diff, run commands directly |
| BLOCKED with concrete missing info | Resolve blocker or ask human | Re-spawn only with delta-goal |
| BLOCKED after repeated same goal | Stop loop | Escalate to user with options |
| FAILED due to test failure or bug | Load `magister-debugging` | Preserve logs and repro |
| FAILED due to scope misunderstanding | Rewrite goal | Re-spawn with narrowed scope (same role or better-fit custom role) |
| TIMEOUT with partial changes | Inspect worktree | Keep useful patch or discard explicitly |

## Templates
### Universal Goal Capsule
```markdown
Role: <any role from spawn_teammate's description — builtin or custom>
Task: <one bounded objective>
Files owned: <absolute paths; read-only paths marked read-only>
Acceptance: <testable criteria>
Process: <TDD/review/debug/ship instruction>
Forbidden: <tools or edits not allowed>
Budget: <max turns/time>
Output: <DONE/BLOCKED/FAILED plus exact evidence format>
```

### Parallel Spawn Checklist
```markdown
- [ ] Approved plan exists.
- [ ] Each teammate owns disjoint write paths.
- [ ] Shared read-only files are marked read-only.
- [ ] Baseline verification is recorded if required.
- [ ] Each goal has a unique acceptance criterion.
- [ ] Integration order is defined before spawning.
```

### Status Response Template
```markdown
Teammate: <role/id>
Status: <DONE|BLOCKED|FAILED|TIMEOUT>
Changed files: <paths or none>
Evidence: <commands/output or reason absent>
Leader route: <verify|debug|ask human|discard|re-spawn with delta>
```

## Examples
### Coder Goal
```markdown
Role: coder
Task: Add `blockedReason` to task summaries.
Files owned: /opt/acme/magister/apps/api/src/routes/tasks.ts, /opt/acme/magister/apps/api/test/routes/task-graph.test.ts
Acceptance: The task route test proves blocked tasks include `blockedReason`.
Process: Use red-green-refactor from `magister-tdd-and-review`; write the failing test first.
Forbidden: Do not edit database schema or web files.
Budget: 2 turns.
Output: DONE/BLOCKED/FAILED; include changed files and exact test command output.
```

### Reviewer Goal
```markdown
Role: reviewer
Task: Review the blockedReason API/UI change.
Files owned: read-only /opt/acme/magister/apps/api/src/routes/tasks.ts, read-only /opt/acme/magister/apps/web/src/components/settings/StatusPanel.tsx
Acceptance: Findings identify spec compliance issues first, then code quality issues with file:line evidence.
Process: Use Stage A then Stage B from `magister-tdd-and-review`.
Forbidden: Do not modify files.
Budget: 1 turn.
Output: REVIEW with severity, file:line, confidence 1-10, and recommendation.
```

### Architect Goal
```markdown
Role: architect
Task: Decide where task blocked narratives should be generated.
Files owned: read-only /opt/acme/magister/apps/api/src/services, read-only /opt/acme/magister/docs/plans/2026-05-08-magister-agent-orchestration.md
Acceptance: Recommend one integration point and reject at least one alternative with reasons.
Process: Inspect existing service boundaries; do not implement.
Forbidden: No file edits.
Budget: 1 turn.
Output: DECISION with recommended files, tradeoffs, and migration risk.
```

### Lander Goal
```markdown
Role: lander
Task: Prepare the verified branch for landing.
Files owned: repository git metadata only
Acceptance: Produce a commit or PR plan that preserves user changes and excludes secrets/temp files.
Process: Use `magister-shipping`; inspect `git status` before staging.
Forbidden: No force push, no `git add -A`, no destructive cleanup.
Budget: 1 turn.
Output: LANDING_PLAN with staged files, commit message, and unresolved risks.
```

### Evaluator Goal
```markdown
Role: evaluator
Task: Verify the blockedReason change against acceptance criteria.
Files owned: read-only repository
Acceptance: Run targeted API/UI tests and `bun run typecheck`; report exact failures if any.
Process: Do not fix failures; capture evidence only.
Forbidden: No file edits.
Budget: 1 turn.
Output: VERIFIED or FAILED with command outputs and residual risk.
```

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Delegating before reading the relevant files | Vague goals and bad ownership | Inspect enough context first |
| Giving a teammate the whole plan plus all skills | Goal overload, argv failures, drift | Send a 10-15 line phase capsule |
| Parallel spawning on shared files | Merge conflicts and duplicated work | Use serial flow or strict ownership |
| Trusting DONE without diff/evidence | False completion | Leader verifies with diff/read/tests |
| Re-spawning the same failed goal | Doom loop | Change the goal or escalate |
| Using custom role fallback silently | User loses intent | State the fallback role and lens |
| Setting `isolate: true` without baseline awareness | Hard integration and hidden failures | Record baseline and inspect dirty state |

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| Coder/evaluator/reviewer spawned for build or review | `magister-tdd-and-review` | Goal capsule, acceptance criteria, evidence contract |
| Subagent reports test failure, bug, or unexplained behavior | `magister-debugging` | Status, logs, repro command, changed files |
| Delegation target is CLI runtime | `magister-cli-subagents` | CLI name, compact goal, trust boundary |
| Delegated implementation is verified | `magister-shipping` | Verification evidence, branch/worktree state |
| Delegation reveals plan ambiguity | `magister-planning` | Missing decision and proposed plan amendment |
