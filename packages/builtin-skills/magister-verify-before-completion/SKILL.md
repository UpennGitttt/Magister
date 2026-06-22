---
name: magister-verify-before-completion
description: Use when about to claim a task is done / fixed / passing / working — your OWN work or the integrated whole — before reporting completion to the user, marking a task complete, committing, or handing off. Use when tempted to assert success from "it should work" or "I'm confident" without having just run the check this turn. Don't use mid-work before a result is expected.
---

# magister-verify-before-completion — Evidence before you say "done"

## Core principle
Never claim done / fixed / passing / working without having just RUN the verifying check and SEEN it pass — this turn. "It should work," "I'm confident," "I made the change so it works" are guesses, not verification. **Evidence before assertion.**

This is the SELF side of `magister-verifying-teammates` (which covers a *teammate's* claims). Neither your own confidence nor a teammate's report is evidence — the command output is.

## The rule
Before you report completion / mark complete / commit / hand off:
1. **Run the EXACT acceptance check this turn** — the test, the build, `typecheck`, or the observable behavior the user asked for.
2. **Read the actual output** and confirm it passed.
3. If the change has blast radius (shared types, config, migrations, deps, agent-loop behavior), run the broader check too — a passing narrow test ≠ no regression.

If you did not run it, you do not know it works. Say "I believe X but haven't verified it" — never assert "done."

## Don't rationalize your way out
| Excuse | Reality |
|---|---|
| "I just made the change, it obviously works" | Obvious changes break — a typo, a wrong path, a missed case. Running it costs seconds. |
| "I'm confident / I've done this before" | Confidence isn't evidence. Run the check. |
| "typecheck/build passed, so it works" | Compiling ≠ behaving. Run the actual acceptance check, not just the type gate. |
| "The user is waiting" | A confident-but-wrong "done" costs more of their time than the 30-second check. |
| "I'll say done and fix it if they complain" | That makes the user your test suite. Verify first. |
| "The teammate said it passed" | That's `magister-verifying-teammates` — rerun it yourself. |

## Red flags — STOP
- About to write "done / fixed / passing / should work / that should do it" and you have run nothing this turn.
- About to commit or hand off without a fresh green check.
- Reporting success from reading the code instead of running it.

**All of these mean: run the acceptance check now, read the output, then report what you actually saw.**

## Cross-references
- `magister-verifying-teammates` — the same discipline for a teammate's claims.
- `magister-tdd-and-review` — the review/verification mechanics.
