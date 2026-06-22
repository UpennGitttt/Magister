---
name: magister-adjudicating
description: Use when teammates or reviewers return verdicts that conflict with each other, or when a reviewer/evaluator challenges the plan or the user's stated direction, and the leader must decide what to do — apply a fix, pick between options, or escalate to the human. Also use when receiving critical review feedback and deciding whether to act on it. Don't use for a single unambiguous result.
---

# magister-adjudicating — Decide vs. escalate when specialists disagree

## Core principle
When teammates/reviewers conflict — or a reviewer argues the plan or the user's stated direction is wrong — the leader adjudicates the **analysis**, but never silently overrides the user's **judgment**. Classify the conflict first; the class decides whether you act or escalate.

**A reviewer's finding is a CLAIM, not a fact** — verify it before acting on it (see `magister-verifying-teammates`). Don't blindly accept critique because it sounds authoritative, and don't blindly reject it because it's inconvenient.

## The three classes
| Class | What it is | Leader action |
|---|---|---|
| **Mechanical** | One objectively-correct answer (a real bug, a failing test, a security hole you verified) | Decide silently. Apply the correct fix. No need to ask. |
| **Taste** | Reasonable disagreement, no clear winner (naming, structure, which valid approach) | Decide with a brief recommendation; note the alternative. Don't block the user on it. |
| **User-challenge** | The specialists argue the USER's stated direction/decision should change | **NEVER auto-decide. Escalate to the human.** Default stays the user's original direction unless they choose to change it. |

The escalation trigger is sharpest when **two independent reviewers (or models) agree against the user**. That agreement is exactly when to escalate — not when to auto-apply. Independent agreement raises confidence in the *analysis*, but the *decision* is still the user's.

## Escalation template (User-challenge only)
```
The reviewers push back on your direction. Your call:
- You asked for: <the user's stated direction>
- Both <reviewer A> and <reviewer B> recommend: <change> — because <reason>
- Context they might be missing: <what you know that they don't>
- If we proceed as you asked anyway, the cost is: <concrete downside>
Default: I keep your original direction unless you say otherwise.
```

## Auto-deciding replaces the user's judgment, never the analysis
- Every verdict must be examined at full depth before you decide. "No issues" is only valid after you state *what you checked*.
- Verify a finding before acting on it. A reviewer that says "this is broken" earns a `git diff` + a rerun, same as any teammate claim.

## Don't rationalize your way out
| Excuse | Reality |
|---|---|
| "Both reviewers agree, so I'll just apply it" | If they agree AGAINST the user's stated direction, that's the escalate signal — not the auto-apply signal. |
| "The reviewer is senior/confident, it's probably right" | Confidence isn't evidence. Verify the finding (`magister-verifying-teammates`) before you act on it. |
| "Escalating wastes the user's time" | Silently reversing the user's intent wastes their trust. A 5-line escalation is cheaper than an unwanted rewrite. |
| "The reviewer is wrong and annoying, I'll ignore it" | Reject only after verifying it's wrong, and say why. Blind rejection is as bad as blind acceptance. |
| "I'll just pick one and move on" | Fine for taste/mechanical. For a user-challenge, picking silently is overriding the user. |

## Red flags — STOP
- About to change the user's stated approach because a teammate/reviewer said so, without asking.
- About to act on a review finding you have not verified yourself.
- Two specialists disagree and you're picking the "louder" one instead of classifying the conflict.

**All of these mean: classify first (mechanical / taste / user-challenge); verify the finding; escalate user-challenges instead of auto-resolving them.**

## Cross-references
- **REQUIRED:** `magister-verifying-teammates` — a verdict (DONE, "this is broken") is a claim to verify, not a fact to act on.
- `magister-delegating` — Status Contract Routing for how verdicts arrive.
