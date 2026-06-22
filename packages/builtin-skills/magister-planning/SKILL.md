---
name: magister-planning
description: Use when the user wants to plan a multi-step software task, brainstorm a design, write a specification, or break down a feature into actionable tasks. Covers Socratic questioning, design chunking, spec writing, task decomposition, project spec state machine. Don't use for single-file edits or when a plan already exists.
---

# magister-planning — Design Gate & Plan Discipline

## Objective
Use this skill before multi-step, multi-file, ambiguous, or high-risk software work so the leader can turn intent into a bounded design and executable plan. It preserves the Design Gate: do not invoke implementation skills, write code, or take implementation action until a design has been presented and approved, except for explicitly pre-authorized single-file low-risk work. Do not use this skill for one-shot answers, existing approved plans, or simple single-file edits where a one-paragraph local spec is enough.

## Decision Tree
| Condition | Action | Output |
|-----------|--------|--------|
| User asks for brainstorming, design, spec, decomposition, or multi-step software work | Use this skill | Design + plan + human gate |
| Task touches 2+ files, 2+ phases, data/schema/API contracts, auth, persistence, agent loop behavior, git state, or user-visible workflow | Treat as multi-step | Full plan required |
| Task is one file, low-risk, reversible, and acceptance is obvious | Use lightweight spec | One paragraph plan; human gate may be skipped only if pre-authorized |
| User says "no plan" but the task is multi-step/high-risk | Push back briefly | Explain that the plan is the safety boundary, then produce the shortest useful plan |
| Acceptance criteria, files, rollback, or budget are unknown | Ask Socratic questions | Fill gaps before writing plan |
| Plan would exceed 5 tasks | Split into recursive sub-plan | Keep current plan at <=5 tasks |
| A plan already exists and is approved | Do not re-plan | Hand off to `magister-delegating` |

### Complexity Ladder
| Level | Signals | Planning Requirement |
|-------|---------|----------------------|
| 0: Answer-only | No code or repo action | No plan |
| 1: Single-file low-risk | One file, no public contract, easy revert, tests obvious | Lightweight spec |
| 2: Narrow multi-file | 2-4 files in one module, clear acceptance | Full plan, usually no architect |
| 3: Cross-cutting | Shared services, schema, tool contracts, UI+API, migrations | Full plan + likely delegation |
| 4: High-risk | auth, secrets, agent loop, data loss, deploy, destructive git | Full plan + explicit human gate |

### Socratic Questioning Cheat Sheet
**Read/Grep the relevant code BEFORE asking any question — never ask what the repo can answer.** Then ask only the genuinely-missing questions; do not interrogate the user when the code already answers them.

| Missing Signal | Primary Question | If User Cannot Answer |
|----------------|------------------|------------------------|
| Acceptance | "What observable behavior proves this is done?" | Offer 2-3 testable acceptance options inferred from the request |
| Files | "Which paths are in scope?" | Say you will inspect likely entry points and return a file list before planning |
| Rollback | "What rollback is acceptable?" | Default to "revert this commit/branch" unless data migration is involved |
| Budget | "How many turns or teammates should this spend?" | Default to smallest viable: one leader pass, no teammate unless risk justifies it |
| Priority | "Which constraint wins if scope conflicts: speed, safety, or completeness?" | Default to safety for agent-loop/data/git changes; speed for copy/styling |

## Templates
### Lightweight Spec Template
```markdown
Plan: <one-sentence implementation intent>
Scope: <exact file path(s)>
Acceptance: <testable behavior or command>
Rollback: <git revert / restore strategy>
Gate: <pre-authorized | request_human_input required>
```

### Full Plan Markdown Template
```markdown
## Design
Problem: <what user needs>
Current system: <relevant files/services and existing pattern>
Approach: <chosen approach and why it fits the repo>
Out of scope: <explicit non-goals>

## Acceptance Criteria
- <testable criterion 1>
- <testable criterion 2>

## Change Plan
Rules: no placeholders ("TODO", "FIXME", "implement later", "stub"); no banned words (robust, clean, scalable, best-practice, production-ready, elegant, generic, future-proof, performant, enterprise-grade).
1. <2-5 minute task with exact file paths and complete code outcome>
2. <2-5 minute task with exact file paths and complete code outcome>
3. <verification task with exact commands>

## Rollback
- <git ref, revert command, or data rollback>

## Budget
- Turns: <max>
- Teammates: <max and roles if any>

## Human Gate
Request approval before implementation: <yes/no with reason>
```

### Project Spec State Template
```markdown
create_project_spec:
  title: <task title>
  status: pending
  acceptance:
    - <criterion>
  plan:
    - <task>
  verification:
    baseline: <command/output if known>
    final: pending
```

Statuses move only in this order unless failure occurs: `pending` -> `in_progress` -> `implemented` -> `verified`; use `failed` when verification fails or the plan becomes invalid.

### Human Gate Prompt Template
```markdown
I have a bounded plan for <task>. Approve implementation?

Options:
- Approve: proceed with the plan as written.
- Revise: tell me what to change before implementation.
- Stop: do not implement.
```

## Examples
### Lightweight Spec Example
```markdown
Plan: Rename the chat input placeholder to match the new product wording.
Scope: apps/web/src/components/chat/ChatInput.tsx
Acceptance: Existing ChatInput tests pass and the placeholder renders as "Ask Magister".
Rollback: git restore apps/web/src/components/chat/ChatInput.tsx
Gate: pre-authorized because this is a single-file copy change.
```

### Full Plan Example
```markdown
## Design
Problem: The task list should show blocked runs with a human-readable reason.
Current system: apps/api/src/routes/tasks.ts exposes task data; apps/web/src/pages/ChatPage.tsx consumes the task summary.
Approach: Add the blocked reason to the API response using the existing task summary shape, then render it in the existing status panel.
Out of scope: Changing task state transitions or notification delivery.

## Acceptance Criteria
- A blocked task response includes `blockedReason`.
- The web status panel displays the reason when present.
- Existing task route and ChatPage tests pass.

## Change Plan
1. Update apps/api/src/routes/tasks.ts and related route test to include `blockedReason`.
2. Update apps/web/src/components/settings/StatusPanel.tsx and test rendering for blocked reason.
3. Run targeted route/UI tests, then `bun run typecheck`.

## Rollback
- Revert the branch commit; no migration or data cleanup required.

## Budget
- Turns: 2
- Teammates: 1 coder only if implementation exceeds the leader pass.

## Human Gate
Request approval before implementation: yes, because this crosses API and UI.
```

### Socratic Recovery Example
User: "Just make the agent safer; I don't know the exact acceptance criteria."

Leader response:
```markdown
I need one testable boundary before planning. Choose one:
1. Dangerous shell commands require approval.
2. Repeated identical tool calls stop after 3 attempts.
3. Crashed agent runs can be resumed.

If none of these is the target, describe the failure you want prevented.
```

## Anti-Patterns
| Anti-Pattern | Consequence | Correct Practice |
|--------------|-------------|------------------|
| Skipping the plan because the user says "just do it" on a multi-file task | Hidden scope, unsafe edits, no rollback | Produce the shortest full plan and ask for approval |
| Asking every Socratic question even when the repo answers it | Wastes user attention | Inspect first, ask only unresolved questions |
| Writing vague tasks like "make it robust" | Subagents cannot execute or verify | Name exact paths, behavior, and commands |
| Creating 8-12 task plans | Leader loses control of phase boundaries | Keep <=5 tasks; split into recursive sub-plan |
| Treating single-file low-risk work like a formal project | Slows trivial changes | Use lightweight spec and proceed if pre-authorized |
| Omitting rollback | Hard to recover from bad edits | Always name a git/data rollback path |
| Planning implementation before acceptance | Optimizes for activity, not done-ness | Acceptance criteria come before task steps |
| Handing a teammate a goal only you could execute | Teammate guesses, drifts, or fails | Before delegating, re-read the goal as if you had NO prior context — every path, acceptance, and term must be unambiguous to an unfamiliar implementer |

## Handoff Points
| Trigger | Next Skill | Handoff Payload |
|---------|------------|-----------------|
| User approves a multi-step plan | `magister-delegating` | Approved plan, file paths, acceptance criteria, budget |
| Approved plan enters build phase without delegation | `magister-tdd-and-review` | Test target, implementation scope, verification commands |
| Planning reveals unknown architecture or design tradeoff | `magister-delegating` | Spawn `architect` with design question and constraints |
| Planning reveals an existing bug or failing baseline | `magister-debugging` | Repro command, failure output, suspected scope |
| Plan is already implemented and only landing remains | `magister-shipping` | Verification evidence and git state |
