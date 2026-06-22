# Database migrations — how schema is actually applied

**Source of truth: `../src/client.ts` → `ensureDatabaseInitialized()`. Not drizzle-kit.**

`bun run migrate` (and the API on first DB access) calls
`ensureDatabaseInitialized()`, which:

1. Applies **`0000_phase1_init.sql`** once to create the base schema.
2. Runs a series of **idempotent `ensure*()` bootstrap functions** in
   `client.ts` (`CREATE TABLE IF NOT EXISTS` / try-guarded `ALTER TABLE … ADD
   COLUMN`). These carry **every schema change since `0000`**.

This makes a fresh database self-initializing and re-running safe.

## What about the numbered files (`0001_*` … `0017_*`) and `drizzle.config.ts`?

They are **historical records only**. No drizzle-kit migrator is wired up
(there is no `meta/_journal.json`), so these files are **never executed** at
runtime — each one's change is already encoded as an `ensure*()` function in
`client.ts`.

## Adding new schema

Add (or extend) an `ensure*()` function in `client.ts` using
`CREATE TABLE IF NOT EXISTS` or a guarded `ALTER TABLE`. Do **not** add a new
numbered `.sql` file expecting it to run — it won't. Keep `schema.ts` (the
Drizzle table definitions used for typed queries) in sync with what the
bootstrap creates.
