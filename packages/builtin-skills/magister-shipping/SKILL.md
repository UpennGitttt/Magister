---
name: magister-shipping
description: Use when implementation is complete, tests pass, and the leader needs to decide how to land the work. Covers 4-Option Gate (Merge/PR/Keep/Discard), git hygiene, worktree cleanup, project_spec final state. Don't use before implementation is verified.
---

# magister-shipping — Finishing Gate

## Objective
Use this skill only after implementation is complete and the leader has directly verified the relevant tests. It guides the final decision: merge, open PR, keep the branch/worktree, or discard changes with explicit confirmation. Do not use this skill before verification is green, while review findings remain unresolved, or when the working tree contains unrelated changes that have not been separated.

## Decision Tree
| Condition | Action | Route |
|-----------|--------|-------|
| Verification not run by leader | Run verification first | Stay in this skill |
| Verification fails | Mark `failed` or keep `implemented` | Hand to `magister-debugging` |
| Review findings unresolved | Do not ship | Hand to `magister-tdd-and-review` |
| User wants immediate integration to base branch | Offer Merge | Require clean staging plan |
| User wants review or remote collaboration | Offer PR | Include summary/tests |
| User wants to pause | Offer Keep | Preserve branch/worktree |
| User wants removal | Offer Discard | Require typed confirmation |
| Worktree was isolated | Clean only after chosen option is complete | Do not delete evidence early |

### Branch Strategy
| Option | Choose When | Avoid When |
|--------|-------------|------------|
| Merge | Personal repo, low collaboration overhead, verified branch ready, user wants local integration | Base branch changed heavily or review is desired |
| PR | Remote review, CI gate, multi-commit feature, shared repo, user wants audit trail | No remote configured or change is throwaway |
| Keep | User may continue later, verification partial but useful, unclear landing decision | User explicitly wants cleanup |
| Discard | Experiment failed, user rejects change, patch is unsafe | Any valuable uncommitted work is not backed up |

### Verification Requirements
| Scope | Minimum Commands |
|-------|------------------|
| API/backend | targeted `bun test ...` + `bun run typecheck` |
| Web/component | targeted component/e2e test + `bun run typecheck` |
| Shared/schema/agent loop | targeted tests + `bun run typecheck` + broader relevant suite |
| Docs/skill text only | line/schema checks and description preservation; typecheck not required unless loader changed |

## Templates
### Verification Record Template
```markdown
SHIPPING_VERIFICATION
Status: <verified|failed>
Commands:
- <command>: <key output>
Review: <passed|not applicable>
Changed files: <paths>
Unrelated dirty files: <paths or none>
project_spec status: <verified|failed|implemented>
```

### 4-Option Gate Prompt Template
```markdown
Implementation is verified. How should I land it?

Present to the user via `request_human_input` with these options:
- Merge: merge this branch into the target branch now.
- PR: prepare/open a pull request for review.
- Keep: leave the branch/worktree in place for later.
- Discard: remove this work; requires a typed `discard` confirmation before destructive cleanup.
```

### Commit/PR Summary Template
```markdown
Summary:
- <behavior changed>
- <tests/verification>

Files:
- <path>: <purpose>

Verification:
- <command>: <key output>

Risks:
- <remaining risk or none>
```

### Discard Confirmation Template
```markdown
Discard will remove the current task changes from <branch/worktree>. Type `discard` to confirm.
Before discarding I will record:
- current branch
- `git status --short`
- recoverable ref or patch location if available
```

## Examples
### Verification Record Example
```markdown
SHIPPING_VERIFICATION
Status: verified
Commands:
- `bun test apps/api/test/routes/task-graph.test.ts`: 12 pass
- `bun run typecheck`: completed without errors
Review: Stage A and Stage B passed
Changed files: apps/api/src/routes/tasks.ts, apps/api/test/routes/task-graph.test.ts
Unrelated dirty files: apps/web/src/pages/ChatPage.tsx (pre-existing, not touched)
project_spec status: verified
```

### 4-Option Gate Example
```markdown
Implementation is verified. How should I land it?

Options:
- Merge: merge `feature/blocked-reason` into `main` locally.
- PR: create a PR with the verification summary.
- Keep: leave `feature/blocked-reason` and its worktree for later.
- Discard: remove this task's changes after typed `discard` confirmation.
```

### PR Summary Example
```markdown
Summary:
- Add blocked task reasons to the task route response.
- Cover the response shape with a route regression test.

Files:
- apps/api/src/routes/tasks.ts: include optional `blockedReason` in serializer.
- apps/api/test/routes/task-graph.test.ts: assert blocked reason response.

Verification:
- `bun test apps/api/test/routes/task-graph.test.ts`: 12 pass
- `bun run typecheck`: no errors

Risks:
- None identified.
```

### Rollback/Recovery Example
```markdown
If Merge was chosen and needs undo:
1. Use `git log --oneline` to identify the merge/commit.
2. Use `git revert <commit>` for a committed change.
3. Use `git reflog` to find the prior HEAD if branch movement must be recovered.
4. Do not use `git reset --hard` unless the user explicitly approves destructive history movement.
```

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Shipping based on subagent's test claim | False green | Leader reruns verification directly |
| Using `git add -A` in dirty repo | Stages unrelated user work | Stage explicit files only |
| Deleting isolated worktree before landing decision | Loses evidence or patch | Clean after Merge/PR/Keep/Discard choice |
| Offering Discard without confirmation | Data loss | Require typed `discard` |
| Merging with unresolved review findings | Lands known defects | Return to `magister-tdd-and-review` |
| Ignoring version/docs/changelog needs | Incomplete release | Run pre-release checklist for user-facing changes |
| Using reset for rollback by default | Destroys recoverable history | Prefer `git revert` and `git reflog` recovery |

### Pre-Release Checklist
Use only items relevant to the change.

```markdown
- [ ] Version number updated if package/release behavior changed.
- [ ] CHANGELOG or release notes updated if user-facing behavior changed.
- [ ] Docs/specs updated if public workflow or API changed.
- [ ] Migration/rollback notes written if schema/data changed.
- [ ] Secrets/temp files excluded.
- [ ] `git status --short` reviewed before staging.
```

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| Verification fails during shipping | `magister-debugging` | Failing command, output, changed files |
| Review gap appears before landing | `magister-tdd-and-review` | Finding, diff, verification state |
| User chooses PR/Merge requiring lander teammate | `magister-delegating` | Landing goal, branch state, staged file list |
| User chooses Keep for later continuation | `magister-planning` | Current status, remaining decision, branch/worktree |
| Ship completes | `magister-planning` | Only if user starts a new task; otherwise end session |
