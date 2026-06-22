# AGENTS.md

Collaboration conventions for humans and AI agents. Goal: fast onboarding, fewer pitfalls, reproducible results.

> Architecture details live in `CLAUDE.md`. This file focuses on collaboration rules and workflows.

## System overview

Magister is an AI agent control plane. Core flow:

```
User message → processTaskIntent() → leader loop → model call + tool execution → reply
                                          ↓ when help is needed
                                    spawn_teammate → coder/reviewer/evaluator
                                          ↓ Magister mode or CLI mode
                                  Magister: built-in loop + API    CLI: codex exec / claude -p / opencode run
```

### Data model (3-layer resolution)

```
Role → Agent (config entity) → Provider (API connection)

Role:     manager, coder, reviewer, architect, lander, evaluator
Agent:    DB row with runtimeType / modelName / instructions / toolProfile
Provider: API config from executors.json (baseUrl, auth, dialect)

Entrypoint: resolveAgentForRole() → apps/api/src/services/agent-resolution-service.ts
```

### Agent runtime modes

| Mode | Applies to | Execution |
|------|-----------|-----------|
| Magister (built-in) | manager (required), other roles (optional) | Magister leader loop calls the API, manages tools and context |
| CLI (external) | coder/reviewer etc. | Spawns codex/opencode/claude-code process with its own loop |

## Getting started

```bash
bun install
bun run migrate
bun run typecheck
bun run test                    # 2500+ tests should all pass
bash scripts/restart.sh         # Start API + Web
```

Verify:
- `http://localhost:3700/system/status` returns JSON
- `http://localhost:3701/` returns 401 (login required)

## Common commands

```bash
# Dev mode (with watchers, live reload)
bun run dev                     # API on :3700  (bun --watch)
bun run dev:web                 # Web on :3701  (vite HMR)

# Prod / long-running mode (no watchers, built bundle, detached + PID management)
bash scripts/restart.sh

# Profile-based long-running mode (recommended for prod/dev dual instances)
bash scripts/restart-profile.sh prod
bash scripts/restart-profile.sh dev

# Toolchain
bun run build:web               # Build frontend
bun run typecheck               # TypeScript check
bun run test                    # Full test suite
bun run test:stability:backend  # Regression baseline tests
```

**Do not mix the two modes**: the watcher restarts the process on every `.ts` mtime change, re-initializing the leader-loop runtime, DB connection pool, and Feishu/WS clients. If generated files land under `apps/api/src/` the watcher enters a reload loop. Use `scripts/restart.sh` for long-running sessions. See `CLAUDE.md` § "Launching the stack".

## Pre-commit gate

```bash
bun run typecheck && bun run test   # must pass
```

- Never commit `config/secrets.json`, `.magister/`, `.env`, `.env.*`, `.tmp*`, `tmp/`
- Do not blindly `git add -A` — review `git status` first
- Commit message format: `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`

## Read before changing

| Area | Read first |
|------|-----------|
| Task execution pipeline | `process-task-intent-service.ts` + `autonomous-loop-service.ts` |
| Agent configuration | `agent-resolution-service.ts` + `agent-profile-service.ts` |
| Tool system | `manager-tools-adapter.ts` (all tool definitions live here) |
| API calls | `streaming-api-caller.ts` + `plugin-registry.ts` |
| Skills system | `skill-management-service.ts` (orchestrator) + `skill-pool-service.ts` / `skill-symlink-service.ts` / `skill-cli-runner.ts` |
| Chat media I/O | `attachment-service.ts` + `media-output-service.ts` + `task-media-repository.ts` |
| Frontend | `AppShell.tsx` + the relevant page component |
| Database | `packages/db/src/schema.ts` |

## Safety notes

- **Dangerous command approval**: bash tool pauses for human confirmation on patterns like `rm -rf` / `git push --force` (5-minute timeout auto-approves to keep tasks flowing)
- **Doom loop**: identical tool calls repeated 3 times trigger auto-block
- **Secrets**: `config/secrets.json` contains plaintext API keys — never commit (gitignored)
- **CLI agent instructions**: instructions passed to codex/claude/opencode are sanitized by `sanitizeCommandPreview`
- **Chat media output**: `send_media` only serves files inside the workspace; `.magister/`, credential-shaped paths, and `critical`-classified paths are refused

## Do not

- Commit secrets or API keys
- Modify `config/executors.json` providers without verifying auth
- Bypass typecheck (`--no-verify` / `@ts-ignore`)
- Hardcode dialect logic in `streaming-api-caller.ts` (use plugins)
- Configure manager with a CLI runtime (manager must use the built-in Magister loop)
