---
name: magister-cli-subagents
description: Use when the leader decides to spawn a CLI subagent (codex, claude-code, or opencode) instead of a Magister teammate. Covers CLI-specific constraints (goal length, no recursion, limited observability), goal templates for CLI, trust boundaries. Don't use for Magister runtime teammates.
---

# magister-cli-subagents — CLI Subagent Guidelines

## Objective
Use this skill when a delegated role resolves to a CLI runtime such as `codex`, `claude-code`, or `opencode` instead of the Magister built-in loop. CLI subagents are useful for bounded coding execution with compact instructions, but they have limited observability, no recursive teammate spawning, and weaker tool-policy enforcement. Do not use this skill for Magister runtime teammates, multi-phase orchestration, or work that needs mid-process steering.

## Decision Tree
| Condition | Action | Reason |
|-----------|--------|--------|
| Task is pure coding, bounded, and has exact files | CLI is acceptable | Fast execution loop |
| Task requires recursive delegation or progressive skill loading | Use Magister teammate | CLI cannot orchestrate |
| Goal exceeds practical 50-line capsule | Shrink or use Magister runtime | Avoid argv/context failures |
| Need `disallowedTools` as a hard constraint | Use Magister runtime | CLI internal tools may not honor Magister policy |
| Need live progress or intervention | Use Magister runtime | CLI usually returns only final stdout |
| CLI returns DONE | Verify directly | Trust boundary remains with leader |
| CLI returns timeout/garbled output | Inspect filesystem and process result | Do not assume success or failure |

### CLI Comparison
| Runtime | Speed | Context Handling | Language/Repo Fit | Resume/Recovery | Best Use |
|---------|-------|------------------|-------------------|-----------------|----------|
| `codex` | Fast for code edits | Strong repo navigation; compact goal preferred | General TypeScript/Python/web/backend | Can usually resume through workspace state, not full Magister trace | Surgical implementation and test iteration |
| `claude-code` | Medium | Strong long-form reasoning; can over-explain if goal is loose | Complex refactors, debugging, docs-heavy repos | Session resume depends on CLI setup | Harder reasoning tasks with bounded files |
| `opencode` | Fast startup | Lightweight; keep instructions very explicit | Small edits and command-driven tasks | Resume not supported | Simple file edits or one-command verification |

### CLI Constraints
| Constraint | Impact | Mitigation |
|------------|--------|------------|
| Goal length ~96 KiB argv limit | Spawn can fail or truncate | Keep goals <=50 lines |
| No recursion | Cannot call `spawn_teammate` | Assign one phase only |
| Limited observability | Leader sees final stdout | Require evidence and verify locally |
| `disallowedTools` gap | CLI may have its own tool policy | Put constraints in goal and inspect diff |
| Different cwd/path parsing | CLI may edit wrong path | Use absolute paths |
| Process permissions | CLI may fail on sandbox/files | Route failure to leader, do not retry blindly |

## Templates
### CLI Goal Template
```markdown
Task: <spec summary>
Files: <absolute paths>
Acceptance: <testable criterion>
Process: Use `magister-tdd-and-review`; red -> green -> refactor where applicable.
Constraints: <banned edits/tools/patterns>
Budget: <max turns/time>
Output: DONE/BLOCKED/FAILED with changed files, diff summary, and exact test output.
```

### CLI Verification Checklist
```markdown
- [ ] Read CLI final status and changed file list.
- [ ] Run `git diff -- <owned paths>`.
- [ ] Confirm no out-of-scope files changed.
- [ ] Open the changed code around the relevant lines.
- [ ] Run the exact test command claimed by the CLI.
- [ ] Run broader verification if the change touched shared contracts.
- [ ] Record evidence in project_spec before handoff.
```

### Troubleshooting Template
```markdown
Symptom: <argv limit | path error | permission | timeout | no diff>
Evidence: <stderr/stdout/process status>
Likely cause: <one theory>
Leader action: <shrink goal | correct path | run locally | switch to Magister teammate | ask human>
```

## Examples
### Codex Goal Example
```markdown
Task: Add a regression test for duplicate tool-call loop detection and make it pass.
Files: /opt/acme/magister/apps/api/src/services/manager-automation/autonomous-loop/autonomous-loop-service.ts, /opt/acme/magister/apps/api/test/services/spawn-teammate-dispatch.test.ts
Acceptance: The targeted test fails before the implementation and passes after it.
Process: Use `magister-tdd-and-review`; keep the patch minimal.
Constraints: Do not edit schema, docs, or web files.
Budget: 2 turns.
Output: DONE/BLOCKED/FAILED with changed files and exact test output.
```

### Verification Example
```markdown
CLI claimed: "DONE, bun test apps/api/test/services/spawn-teammate-dispatch.test.ts passed."
Leader verifies:
1. `git diff -- apps/api/src/services/manager-automation/autonomous-loop/autonomous-loop-service.ts apps/api/test/services/spawn-teammate-dispatch.test.ts`
2. `bun test apps/api/test/services/spawn-teammate-dispatch.test.ts`
3. `bun run typecheck` if shared types changed.
Route: if commands pass, hand off to `magister-tdd-and-review` Stage B or `magister-shipping`.
```

### Troubleshooting Examples
| Symptom | Evidence | Correct Response |
|---------|----------|------------------|
| argv too long | CLI exits before model call or shell reports argument list too long | Replace full plan with compact capsule and skill reference |
| Path parsing error | CLI creates files under wrong relative directory | Re-run only after switching to absolute paths; inspect and remove stray files explicitly |
| Permission issue | stderr mentions denied write/command | Do not escalate permissions blindly; move work to allowed path or ask human |
| Timeout | Process exits without final status | Inspect partial diff; route useful failures to `magister-debugging` |
| "Tests pass" but no command output | Self-report only | Run tests directly before accepting |

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Sending the whole project spec to CLI | argv overflow and attention drift | Send only current phase capsule |
| Assuming CLI honors Magister `disallowedTools` | Unsafe edits may slip through | Verify diff and state forbidden edits in goal |
| Trusting final stdout as evidence | False positives | Leader reruns commands directly |
| Using CLI for open-ended design | Poor steering and hidden assumptions | Use `architect` under Magister runtime |
| Re-running timeout with same oversized goal | Repeated failure | Shrink goal or switch runtime |
| Letting CLI choose files | Out-of-scope edits | Provide absolute owned paths |

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| CLI returns changed code | `magister-tdd-and-review` | Diff, changed paths, claimed test output, acceptance criteria |
| CLI exposes a failing test or runtime bug | `magister-debugging` | Repro command, stdout/stderr, partial diff |
| CLI completes and leader verification passes | `magister-shipping` | Verified commands, branch/worktree state |
| CLI goal is too broad for safe execution | `magister-delegating` | Runtime limitation and revised role choice |
| CLI result invalidates plan assumptions | `magister-planning` | New constraint and plan amendment needed |
