---
name: magister-memory
description: Use when deciding whether to save something to long-term memory (upsert_memory), judging what is worth remembering versus not, or when about to act on a memory that was recalled or injected into your context — especially a memory that names a specific file, function, flag, command, or behavior that may have changed since it was written. Don't use for transient task state.
---

# magister-memory — What to remember, and how far to trust recall

## Overview
Magister's memory system does the plumbing automatically: it extracts memory before compaction, injects relevant memory into your (and teammates') prompts, searches it via FTS5, and ages out stale entries. Your tools: `upsert_memory`, `search_memory`, `view_memory`, `delete_memory`. This skill is the JUDGMENT layer — what is worth a memory, and how far to trust one.

## What to remember (write it)
- Durable USER preferences and guidance on how you should work.
- Non-obvious PROJECT constraints or decisions NOT derivable from the code or git history.
- Hard-won OPERATIONAL gotchas that save real time next session — a quirk, a footgun, a topology fact.
- Pointers to external resources (dashboards, tickets, URLs).

Convert relative dates to absolute. Link related memories.

## What NOT to remember (don't pollute the store)
- Transient task state — that is what task/event records are for.
- Anything recoverable by reading the code, the schema, or git history.
- One-conversation-only facts.
- Secrets, tokens, credentials.

## Recalled memory is a CLAIM, not a fact — verify before you rely on it
A recalled or injected memory reflects what was true **when it was written**; the codebase moves. Before acting on a memory that names a specific file, function, flag, command, or behavior, **confirm it still holds** (read the code / run the check). Never recommend a stale memory as current fact.

This is `magister-verifying-teammates` applied to your own past self: a confident memory from three weeks ago is still just a claim.

## Don't rationalize
| Excuse | Reality |
|---|---|
| "A memory says file X does Y, so I'll act on it" | Memories go stale as code changes. Open X and confirm before relying on it. |
| "This quirk is obvious, no need to record it" | If it cost you 10 minutes to find, it costs future-you the same. Record it. |
| "I'll remember the whole task in case it's useful" | Memory is for durable, reusable facts — not a task log. Skip the transient. |

## Red flags — STOP
- About to recommend or act on an injected/recalled memory that names a file/flag/behavior, without checking it is still true.
- About to `upsert_memory` something derivable from the code, or a one-off detail with no future value.

## Cross-reference
- `magister-verifying-teammates` — a recalled memory, like a teammate report, is a claim to verify before acting on it.
