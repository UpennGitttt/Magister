# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                        # Install dependencies
cp .env.example .env              # Create local env file
bun run migrate                    # Run Drizzle migrations

bun run dev                        # API server on :3700 (Bun, watch)
bun run dev:web                    # Web console on :3701
bash scripts/restart-profile.sh prod # Long-running profiled stack
bash scripts/restart-profile.sh dev  # Dev profiled stack
bun run build:web                  # Build web app

bun run start:node                 # API on stock Node.js (node --import tsx); better-sqlite3 driver
bun run smoke:node:db              # Sanity-check the Node DB path (driver + FTS5 + migrations)

bun run typecheck                  # TypeScript check
bun run test                       # Full test suite
bun run test:stability:backend     # Backend stability regression suite
bun run test:web:e2e               # Playwright E2E
```

Pre-commit minimum gate:

```bash
bun run typecheck && bun run test
```

## Launching the stack

Magister has two intentionally separate launch paths — **don't conflate them**:

- **Dev mode** — `bun run dev` (API) + `bun run dev:web` (web). Both run with file watchers (`bun --watch` + vite HMR). Auto-reload on source change. Use this when actively coding. Foreground; logs to terminal.
- **Prod / long-running mode** — `bash scripts/restart.sh` or the profile wrapper `bash scripts/restart-profile.sh prod`. Builds the web bundle, runs migrations, starts API without `--watch`, serves the web console as a built bundle, writes PID files under `.magister/`, and verifies SSE proxy + auth status.

Why the split matters: `bun --watch` re-imports modules on every `.ts` mtime change, which means re-initializing the leader-loop runtime, DB connection pool, and Feishu/WS clients. That's a multi-second hit per recycle; if generated artifacts ever land under `apps/api/src/`, the watcher would recycle in a loop. `restart.sh` runs without watchers, behind PID file management and a port-owner safety guard.

## Architecture

### What this system does
Magister is a personal AI agent control plane: user requests enter a unified leader loop, the leader decides direct response vs tool execution vs teammate delegation, and all runtime behavior is projected into durable task/runtime/event records plus a real-time web dashboard.

### Data Model (3-layer resolution)
Role -> Agent -> Provider is the runtime resolution chain.

- Role: logical lane (`manager`, `coder`, `reviewer`, `architect`, `lander`, `evaluator`)
- Agent: `agent_profiles` row with runtime and execution config (`runtimeType`, `modelName`, `instructions`, `toolProfile`, optional CLI command/env/args)
- Provider: API transport/auth config from `config/executors.json` (`baseUrl`, `auth`, `apiDialect`, headers/overrides)
- Resolution entrypoint: `resolveAgentForRole()` in `apps/api/src/services/agent-resolution-service.ts`

Built-in role IDs: `coder`, `reviewer`, `architect`, `lander`, `evaluator`. `manager` is resolved through `config/executors.json` `roleMapping` (default maps `manager -> leader`).

Database schema source of truth: `packages/db/src/schema.ts`

Core tables: `tasks`, `role_runtimes`, `runtime_workspaces`, `execution_events`, `artifacts`, `approvals`, `conversation_bindings`, `channel_sessions`

Support tables: `channel_inbound_event_keys`, `channel_outbound_delivery_locks`, `task_mailbox`, `skills`, `agent_skills`, `agent_profiles`

### Runtime Architecture
- **Leader Loop**: `apps/api/src/services/manager-automation/autonomous-loop/autonomous-loop-service.ts` — runs `model -> tool_use -> observation -> next turn`, with compaction, doom-loop checks, checkpoints, and decision-trace events.
- **Runtime wrapper**: `manager-autonomous-runtime.ts` — builds tools, wires provider caller, stores checkpoints via `LeaderSessionStore`.
- **Provider Plugins**: `apps/api/src/providers/plugin-registry.ts` — dialect-based plugin dispatch (`anthropic-plugin.ts`, `openai-compat-plugin.ts`) for message/tool conversion and replay sanitization.
- **Streaming**: `streaming-api-caller.ts` — emits incremental deltas and terminal `message_complete`; supports model fallback chain.
- **CLI Agents**: `apps/api/src/services/cli-agent-spawn-service.ts` — supports Codex, Claude, OpenCode with optional model/reasoning/env/args.
- **Session checkpoint/restore**: `apps/api/src/services/leader-session-store.ts` — persists and restores checkpoints by `runId`.
- **Unified task intake**: `apps/api/src/services/process-task-intent-service.ts` — all Feishu/Web/CLI requests enter `processTaskIntent()`.

### Agent Tools
All tools defined in `apps/api/src/services/manager-automation/autonomous-loop/manager-tools-adapter.ts`:

`bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `web_search`, `web_fetch`, `time_now`, `spawn_teammate`, `check_teammate_status`, `wait_for_teammate`, `create_project_spec`, `update_project_spec`, `git_commit`, `git_create_branch`, `request_human_input`, `load_skill`, `send_media`

### Skills (progressive disclosure)

Magister uses the machine-wide skill pool at `~/.agents/skills/` (same pool as `npx skills add/find/update/check`). The Skills tab in Settings is a UI over this pool.

| Layer | Location |
|---|---|
| Pool content | `~/.agents/skills/<dir>/SKILL.md` (frontmatter + body) |
| Source registry | `~/.agents/.skill-lock.json` (GitHub URL + commit hash) |
| Per-CLI exposure | `~/.{codex,claude,config/opencode}/skills/<dir>` symlinks |
| Leader attachment | `agent_skills` rows in DB |

**Runtime injection**: `appendAgentSkills()` emits a `# Available skills` section listing only `name: description`. The body loads via `load_skill(name)` on demand, keeping context lean. Description and body are read from the pool (not DB cache), so `npx skills update` outside Magister is reflected immediately.

**Identity split**: most skills have `dirName === declaredName`. Meta-pack skills declare a different `name` in frontmatter (e.g. dir `ckm-banner-design` → name `ckm:banner-design`). `dirName` is filesystem identity; `name` is UI/runtime identity.

Service entrypoint: `skill-management-service.ts` (orchestrator); routes in `apps/api/src/routes/skills.ts`.

### Safety
- **Doom loop detection**: fingerprinted tool calls (MD5), 20-call window, repeat >= 3 triggers auto-block
- **4-tier risk classifier** (`apps/api/src/services/safe-apply/risk-classifier.ts`):
  - LOW: pure read — auto-pass
  - MEDIUM: dangerous bash patterns — single-shot approval
  - HIGH: write outside workspace, network, broad-glob delete — escalation request
  - CRITICAL: lethal patterns (rm -rf /, mkfs, dd of=/dev/*) — hard-block, no override
- **Persistent approval rules** (`command_approval_rules` table + `command-rule-matcher.ts`): argv-prefix patterns scoped global/project/session, validated against a banned-list
- **Bubblewrap sandbox** (`execution-sandbox-service.ts`): `MAGISTER_EXECUTION_SANDBOX_MODE` defaults to `"optional"`
- **Extra access roots** (`lib/extra-access-roots.ts`): `MAGISTER_EXTRA_ACCESS_ROOTS` is an opt-in, comma-separated allowlist of roots *outside* the workspace the leader may reach (read-only by default; `:rw` suffix grants writes). Opens both gates — `resolveInsideWorkspace` (read/write intent) and the bubblewrap bind list. Empty = strict workspace-only (default). Nothing hard-coded. See `docs/modules/safe-apply-leader-hardening.md`
- **Three-tier permissions (v4)**: feature-flagged via `MAGISTER_PERMISSIONS_V4=on` (default off). Adds `with_additional_permissions` for scoped network/filesystem grants
- **Crash recovery**: `recoverStaleTasks()` at startup + periodic `runtime-recovery-service.ts` loop

### Observability
- Token usage: per-call recording, task/day aggregations via `/usage/today` and `/tasks/:taskId/usage`
- Decision traces: `leader.decision_trace` events with context utilization, tool count, compaction/doom-loop flags
- Root trace IDs: `tasks.trace_id` + `execution_events.trace_id` enable cross-task correlation; Web "Full Trace" view filters by `trace_id`
- Event projection: `leader-event-projector.ts` writes `execution_events` and broadcasts WS updates

### Multimodal chat I/O

**Inbound images**: user uploads via ChatInput (file picker / drag-drop / paste), stored under `.magister/uploads/<task_id>/`, inlined as `LeaderContentBlock` image blocks in the first user message. PNG / JPEG / GIF / WebP, 10 MB per file, 10 files per turn. Entry: `attachment-service.ts`.

**Outbound media**: leader calls `send_media(path)` to push images or video (MP4/WebM up to 100 MB) into chat. Path must resolve inside the workspace; `.magister/`, credential-shaped names, and `critical`-classified paths are refused. Entry: `media-output-service.ts`.

### MCP (Model Context Protocol) integration

Three capabilities: **Tools** (namespaced as `mcp__<server>__<tool>`, approval-gated by default), **Resources** (read-only, no approval), **Prompts** (slash menu in ChatInput).

Key files:
- `mcp-pool-service.ts` — connection pool, tool/resource/prompt discovery, dispatch
- `mcp-tool-converter.ts` — MCP ToolDef → LeaderTool translation with namespacing
- `apps/api/src/routes/mcp.ts` — REST CRUD + prompt rendering
- `agent_mcp_attachments` table — per-agent server attachment (tools from server X visible to agent A only if attached)

**Adding a server**: Settings → MCP → Add. Stdio: paste launch command. Remote: paste URL (StreamableHTTP or SSE). Trust toggle controls per-call approval. New servers connect immediately (hot-reload via `addOrRefreshServer`) — no API restart needed; changes take effect on the next leader turn.

**Security**: `STDIO_ENV_ALLOWLIST` prevents leaking API keys into MCP child processes. `trustLevel` defaults to `"ask"`. Disconnected servers fail fast.

### Frontend
- React SPA in `apps/web` (Vite + zustand)
- Pages: Dashboard, Board (kanban), Chat, Settings (Providers / Agents / Roles / Skills / MCP tabs)
- Chat is chatStore-driven (`apps/web/src/stores/chatStore.ts`): backend stamps per-prompt `requestId` on events; pure projector reduces events into `Conversation`/`Exchange[]` state; SSE adapter streams events into the store
- Mobile (≤ 880px): drawer overlay for sessions, bottom sheet for trace panel, compact mobile bar
- App shell: `.app-shell { height: 100dvh; overflow: hidden }` anchors layout; chat scroll stays inside `.chat-messages`

### Key Files
1. `apps/api/src/services/process-task-intent-service.ts` — unified task/session entry
2. `apps/api/src/services/agent-resolution-service.ts` — Role → Agent → Provider resolution
3. `apps/api/src/services/manager-automation/autonomous-loop/autonomous-loop-service.ts` — core leader loop
4. `apps/api/src/services/manager-automation/autonomous-loop/manager-autonomous-runtime.ts` — loop runtime wiring + checkpoints
5. `apps/api/src/services/manager-automation/autonomous-loop/manager-tools-adapter.ts` — full tool registry
6. `apps/api/src/services/manager-automation/autonomous-loop/streaming-api-caller.ts` — provider streaming + fallback
7. `apps/api/src/providers/plugin-registry.ts` — dialect plugin dispatch
8. `apps/api/src/providers/plugins/anthropic-plugin.ts` — Anthropic dialect
9. `apps/api/src/providers/plugins/openai-compat-plugin.ts` — OpenAI-compatible dialect
10. `apps/api/src/services/cli-agent-spawn-service.ts` — CLI runtime spawning
11. `apps/api/src/services/leader-session-store.ts` — session checkpoints
12. `apps/api/src/services/command-approval-service.ts` — approval state machine
13. `apps/api/src/services/runtime-recovery-service.ts` — stale runtime recovery
14. `apps/api/src/server.ts` — API startup, lock, recovery workers
15. `apps/web/src/AppShell.tsx` — web routing shell + websocket

## Config

- `config/executors.json` — `providers` (API endpoints + auth), `roleMapping` (role → agent name)
- `config/secrets.json` — local secret store for provider keys; gitignored; never commit
- `.magister/` — local runtime data and artifacts; gitignored; never commit
- `.env.<profile>` — runtime profile overrides for `scripts/restart-profile.sh`; gitignored

## Conventions

- Commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- Architecture/behavior changes must update docs in `docs/modules/*` and `docs/status/master-tracker.md`
- Plans live in `docs/plans/*`; once superseded, mark them `OUTDATED` at file top
- Use explicit runtime log tags (examples: `[role-routing]`, `[streaming-api]`, `[token-budget]`)
- Never commit secrets/runtime local data: `.env`, `.env.*`, `config/secrets.json`, `.magister/`, `.tmp*`, `tmp/`
- Generated artifacts must never land under `apps/api/src/` (would trigger `bun --watch` recycle loop)
