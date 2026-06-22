# API Workspace

This workspace hosts the Phase 1 local-first control-plane API.

## Commands

From the repository root:

```bash
bun install
bun run migrate
bun run dev
```

From `apps/api`:

```bash
bun run dev
bun run test
```

## Verification

Run the full workspace checks from the repository root:

```bash
bun run test
bun run typecheck
```

## Notes

- The API uses the SQLite database path from `MAGISTER_DB_PATH` when set.
- Without `MAGISTER_DB_PATH`, it defaults to `.local/control-plane.sqlite` under the repository root.
- If port `3700` is occupied locally, start the server with a different port:

```bash
PORT=3011 bun run dev
```
