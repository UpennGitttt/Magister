---
name: magister-verifying-teammates
description: Use when a teammate, CLI subagent, or any delegated agent reports DONE / success / "tests pass" / "all green", and the leader is about to accept it, integrate it, mark the work complete, or report it to the user — especially under time pressure or an explicit "just ship it" instruction, or when tempted to skip re-running a delegated result to save time or tokens. Don't use when you performed the work yourself.
---

# magister-verifying-teammates — A teammate's report is a claim, not evidence

## Core principle
The leader owns correctness. A teammate — Magister role, CLI subagent (codex/claude-code/opencode), or any delegate — saying "done / passed / all green" is a **hypothesis to test, not a fact to relay**. Their words are never the evidence; the **diff and the command output are**. Never accept, integrate, mark complete, or report a delegated result you did not verify yourself.

**Violating the letter of this rule is violating the spirit of it.**

## The rule — verify in YOUR workspace before accepting
1. **It exists.** `git diff` the owned paths. Confirm the claimed change is actually present — not in an invisible worktree, not confabulated. A report of a fix that doesn't appear in your tree is a fabrication, however confident.
2. **It runs.** Run the EXACT test/command the teammate claimed, yourself. A self-reported PASS is not a PASS.
3. **It's safe.** If the change has blast radius — middleware/route order, shared types, config, migrations, lockfiles, dependency bumps — run the broader suite too. A passing *named* test ≠ no regression.
4. **It's in scope.** No out-of-scope files were touched.

If you **cannot** verify it (work in a worktree you can't see, artifacts absent, no command output), the status is **NOT done — it's unverified/blocked**. Report exactly what you verified and what you couldn't. Never relay an unverified "done."

## Don't rationalize your way out
| Excuse | Reality |
|---|---|
| "This teammate's been reliable all session" | Reliability isn't evidence. One confabulated report ends the streak. Verify anyway. |
| "The user said 'just ship it' / 'be fast'" | "Ship if the test passes" means ship if it ACTUALLY passes, not if it's CLAIMED to. The acceptance bar isn't met until you've *seen* it met. |
| "Re-running wastes time/tokens" | The targeted check (diff + the one named test) costs seconds. Shipping a false "done" costs the user's trust — that is the expensive thing. |
| "They pasted a passing test / the diff looks right" | A pasted PASS and a plausible diff are still claims. Run it; check blast radius. |
| "It's a tiny 1-line change" | 1-line changes — ordering, a config value, a flag — cause the biggest regressions. Size ≠ safety. |
| "I'm low on context/turns" | Then report "unverified," don't report "done." Honesty about state beats a confident lie. |

## Red flags — STOP, you're about to relay an unverified claim
- "I'll report DONE based on their message."
- "No time to re-run it."
- "They said it passed."
- "The user's in a hurry — just ship."
- You're about to tell the user "done" / commit / hand off, and you have run **nothing yourself this turn**.

**All of these mean: verify in your own workspace first. The teammate's claim is the START of your check, not the end of it.**

## The mechanics live elsewhere — this skill is the discipline to actually do them under pressure
- **REQUIRED ROUTING:** `magister-delegating` → Status Contract Routing (a DONE without evidence is *unverified*).
- **REQUIRED CHECKLIST:** `magister-cli-subagents` → CLI Verification Checklist (diff the owned paths, rerun the exact command, broaden if shared contracts changed).
