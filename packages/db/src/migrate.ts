// SCHEMA SOURCE OF TRUTH: `ensureDatabaseInitialized()` in ./client.ts.
// It applies migrations/0000_phase1_init.sql once, then runs a set of
// idempotent `ensure*()` bootstrap functions (CREATE TABLE IF NOT EXISTS /
// guarded ALTER) that carry every schema change since 0000. The numbered
// migrations/0001_*..0017_* files and drizzle.config.ts are NOT executed by
// this command (no drizzle-kit migrator is wired) — they are historical
// records only. Add new schema as an `ensure*()` function in client.ts, not
// as a numbered .sql file. See migrations/README.md.
import { createSqliteClient, ensureDatabaseInitialized, getDatabasePath } from "./client";

const sqlite = createSqliteClient();
ensureDatabaseInitialized(sqlite);

console.log(`Applied migration to: ${getDatabasePath()}`);
