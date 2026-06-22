<div align="center">

<img src="apps/web/public/icon.svg" alt="Magister" width="120" height="120" />

# Magister

**The most capable coding agents, in your hands.**

An open-source control plane for autonomous AI coding agents: delegate a task, let a leader agent plan and coordinate specialist teammates, and watch the whole run ship from your browser or phone.

[English](README.md) · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-orange.svg)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-blue.svg)](https://www.typescriptlang.org)

</div>

---

## What is Magister?

Magister orchestrates multiple AI coding agents as one managed team. You describe a goal; a **leader agent** splits it into subtasks, spawns specialist teammates (coder, reviewer, architect, evaluator, lander) in **isolated git worktrees**, and streams the whole delegation tree to a web console you can reach from anywhere — desktop, phone, or Feishu.

## Why Magister?

- **Run coding agents like infrastructure** — tasks survive a closed browser, dropped SSH, or an API restart instead of dying with a terminal session.
- **See the whole delegation tree** — leader decisions, teammate spawns, tool calls, approvals, diffs, and answers all stream into one console.
- **Right model per role** — keep the always-on leader on a cheap API model; reserve premium models or external CLIs for reviewer / architect / high-risk work.
- **Drive from anywhere** — browser, mobile PWA, Feishu, and CLI all act on the same task state.
- **Self-hosted** — SQLite, local files, local worktrees, your keys, your approval rules.

## Quick Start

```bash
git clone https://github.com/UpennGitttt/CAM.git
cd CAM
bun install
cp .env.example .env       # optional runtime tweaks — API keys are NOT set here
cp config/executors.example.json config/executors.json   # then pick your provider/model
bun run migrate             # initialize the SQLite database (creates all tables)
bun run dev:all             # API (:3700) + web console (:3701) together — Ctrl+C stops both
```

> Prefer separate terminals? Run `bun run dev` (API :3700) and `bun run dev:web` (web :3701) instead — both must stay up. The web console proxies to the API, so a wall of `ECONNREFUSED 127.0.0.1:3700` just means the API isn't running; a stray `EPIPE` / ws-proxy line on startup is harmless (a browser tab reconnecting).

Open [http://localhost:3701](http://localhost:3701), go to **Settings → Providers**, and paste a provider API key (e.g. `ANTHROPIC_API_KEY`). Keys are stored via the UI in `config/secrets.json` (gitignored) — **not** in `.env`. Agents, skills, MCP servers, and approval rules are all managed under Settings too.

> On a fresh install, before you add a provider, the API log prints `Role "leader" has no provider configured yet` — that's **expected, not an error** (the API is running fine). It clears once you add one in Settings.

For a long-running setup that survives terminal close: `bash scripts/restart-profile.sh prod`.

### Recommended setup

Every task resolves as **Role → Agent → Provider**, so the practical question is *which model for which role*. A sane default:

- **Leader** (always-on; plans and delegates) — a **cheap, capable** model. The loop runs every turn, so this is where cost lives; a budget API model (e.g. DeepSeek, Qwen, or Claude Haiku) is plenty.
- **Coder / reviewer / architect** (the heavy lifting, on demand) — a **stronger** model, or an external CLI (Codex / Claude Code / OpenCode). Reviewing with a *different* model than the one that implemented catches more.
- **Start simple** — point every role at one provider to get going, then split per-role under **Settings → Agents** once it runs.

<details>
<summary><strong>Running on stock Node.js (Bun-optional)</strong></summary>

The API and web console also run on **Node.js ≥ 20.11** via [`tsx`](https://github.com/privatenumber/tsx), backed by `better-sqlite3` instead of `bun:sqlite` (selected automatically — no code changes):

```bash
bun install                 # still the installer; also builds better-sqlite3
bun run start:node          # API on Node
bun run smoke:node:db       # check the Node DB path (driver + FTS5 + migrations)
bun run smoke:node:boot     # boot the API on Node and assert /health
```

CI runs both a Bun job and a Node job. The only Bun-only piece is the optional leader worker mode (off by default).
</details>

## Core Capabilities

### Multi-Agent Orchestration

The leader is a **conductor over heterogeneous coding agents**, not a single monolithic agent. It can run Codex, Claude Code, and OpenCode as specialist teammates on one task — each in an isolated worktree, each on the right model for its role — and integrate the results.

- Teammates can be Magister-native agents or external CLIs (Codex, Claude Code, OpenCode); pick a different model/CLI per role
- Each teammate runs in its own git worktree; independent subtasks run in parallel
- Spawn events, tool calls, and return values stream live in the web UI
- Define custom roles with their own models, system prompts, and tool restrictions

### Autonomous Loop

The leader runs a continuous **model → tool → observe** loop with built-in safety:

- **Crash recovery** — checkpoints every turn; resumes from the last one on restart
- **Doom-loop detection** — fingerprints tool calls and blocks after 3 identical repeats
- **Context compaction** — summarizes older turns as conversations grow, keeping key decisions
- **Goal mode** — run a prompt as an autonomous objective until it completes or you cancel

### Context cache & cost

Always-on orchestration only stays affordable if context is **cached and reused** rather than re-sent every turn. In one real run, `98.9%` of the leader's input tokens were cache hits (`15.9M` cached vs `172K` uncached) — the difference between practical and expensive. Token usage is tracked per task, role, and model, and reconciles with the provider's own dashboard.

### Execution Safety

A layered model so agents don't break your system:

- **4-tier risk classifier** — LOW auto-pass, MEDIUM one-click, HIGH escalation, CRITICAL hard-block
- **Bubblewrap sandbox (Linux only)** — optional `bwrap` isolation with scoped filesystem binds and network unshare; on macOS/Windows commands run unsandboxed
- **Persistent approval rules** — whitelist trusted command patterns so routine work doesn't prompt
- **Change review gate** — teammate diffs get a visual review before merging

> **Threat model:** safety is tuned for a **single trusted operator running their own agents** — a best-effort net, not a boundary for untrusted code. The only non-overridable layer is the CRITICAL hard-block on catastrophic, irreversible patterns (`rm -rf /`, `mkfs`, `dd of=/dev/*`).

### Skills & MCP

- **Skills** load on demand — only names and descriptions sit in the prompt; bodies load via `load_skill` when relevant. One shared `~/.agents/skills/` pool serves Magister, Claude Code, Codex, and OpenCode, so you install once and manage from a single tab. Ships with a leader-discipline set: verify teammate claims before relaying them, verify before declaring done, adjudicate conflicting reviews.
- **MCP** — Tools, Resources, and Prompts, managed from a GUI, attachable per-agent, hot-reloaded without a restart. Type `/` in chat to invoke an MCP prompt.

### Web Console + Mobile

A real-time dashboard for the delegation tree:

- Streaming chat — leader thinking, tool calls, and results render live
- Responsive PWA, usable on phones
- Kanban board (Queued / In Progress / Attention / Done) and session search
- Drag/paste images in; agents can send back screenshots, diagrams, or short video
- Feishu integration — drive the same tasks from chat

**Reaching it from your phone.** The console is self-hosted, so to use it on the go, put your phone and the host on the same [Tailscale](https://tailscale.com) tailnet — an encrypted WireGuard mesh, nothing exposed to the public internet, and it roams across networks (Wi-Fi ↔ cellular without dropping).

<details>
<summary><strong>Phone access via Tailscale — step by step</strong></summary>

1. **On the host** (the machine running Magister), install Tailscale, bring it up, and note its address:
   ```bash
   # macOS: brew install tailscale    ·    Linux: curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   tailscale ip -4        # → 100.x.y.z   (or use the MagicDNS name: <machine>.<tailnet>.ts.net)
   ```
2. **On your phone**, install the Tailscale app (iOS / Android) and sign into the **same account** — both devices now share one private tailnet.
3. **Expose the web console to your tailnet.** By default Magister listens on `127.0.0.1` only. In `.env`, set `WEB_HOST` to your Tailscale IP to listen only on that interface, or use `WEB_HOST=0.0.0.0` to listen on every interface:
   ```bash
   WEB_HOST=100.x.y.z
   # or: WEB_HOST=0.0.0.0
   ```
4. **Add a login** so the console isn't wide open to your tailnet — set in `.env`, then restart:
   ```bash
   MAGISTER_WEB_AUTH_USER=admin
   MAGISTER_WEB_AUTH_PASS=<a-strong-password>
   ```
5. **Open it on your phone:** `http://100.x.y.z:3701` (Tailscale IP) or `http://<machine>.<tailnet>.ts.net:3701` (MagicDNS), and log in.
6. **Add to Home Screen** from the browser's share menu — it now launches full-screen like a native app (PWA: your sessions, live streaming, media).

No port forwarding, no public exposure — your phone talks to your own machine over an encrypted mesh, even on cellular. *(A same-Wi-Fi LAN IP works too; a Cloudflare/ngrok tunnel works for genuinely public access — Tailscale is the cleanest: private, encrypted, and roams.)*

> **Security — recommended.** For local-only use, the default `127.0.0.1` listener is not reachable from other devices. Once you set `WEB_HOST` to a Tailscale/LAN address or `0.0.0.0`, set `MAGISTER_WEB_AUTH_PASS` too; without it, anyone who can reach that interface has full control of your agents. Also enable **2FA on your Tailscale account** — it's the trust root for the whole private network.

</details>

### Providers & Memory

- **Any provider** — Anthropic (Claude) and any OpenAI-compatible endpoint (Qwen, Kimi, GLM, DeepSeek, Moonshot, Volcano, …). Configuring an agent auto-discovers the models a runtime supports, so you pick from a dropdown instead of hand-typing model IDs. New providers are a small dialect adapter plus auth config.
- **Cross-session memory** — typed entries (user / project / feedback / reference), scoped **global / project / session** so context never leaks between unrelated projects, retrieved via FTS5 search, written and aged out automatically.

## Requirements & Platform Support

Runtime: [Bun](https://bun.sh) ≥ 1.3.12 (default), or stock Node.js ≥ 20.11.

| Platform | Status | Sandbox |
|---|---|---|
| Linux | Full support | `bwrap` (optional) |
| macOS | Runs (Unix-native) | none — `bwrap` is Linux-only |
| Windows | WSL2 only | via WSL2 |

Native Windows isn't supported — the agent's `bash` tool, the sandbox, and the ops scripts assume a Unix shell. Use WSL2.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Web Console (React + Vite)          Mobile / Feishu    │
│     SSE streaming    WebSocket fan-out                  │
├─────────────────────────────────────────────────────────┤
│  API Server (Bun + Fastify)                             │
│  ┌─────────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Leader Loop  │  │ MCP Pool │  │ CLI Agent Bridge  │  │
│  │ (autonomous) │  │ (stdio/  │  │ (Codex, Claude,   │  │
│  │              │  │  http)   │  │  OpenCode)        │  │
│  └──────┬───────┘  └────┬─────┘  └────────┬──────────┘  │
│         │               │                 │             │
│  ┌──────┴───────────────┴─────────────────┴──────────┐  │
│  │           Tool Registry + Sandbox                 │  │
│  │  bash · read/write/edit · grep · web_search       │  │
│  │  spawn_teammate · git_commit · send_media · MCP   │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  SQLite (tasks, events, approvals, memory, artifacts)   │
│  File System (checkpoints, uploads, media, skills)      │
└─────────────────────────────────────────────────────────┘
```

Resolution chain: **Role → Agent → Provider**. Each role (coder, reviewer, architect, …) maps to an agent profile (model, instructions, tool restrictions), which maps to a provider (endpoint + auth). All configurable from Settings.

## Contributing

The most valuable contributions aren't boilerplate — they're the things that make Magister a better **conductor of coding agents**:

- **More coding-agent CLIs as teammates** — wire additional runtimes into the CLI bridge (Cursor, Kiro, Qoder, OpenClaw, Hermes, …) so the leader can delegate to them the way it already does with Codex / Claude Code / OpenCode.
- **Deeper multi-agent orchestration** — smarter delegation, parallel and adversarial review, planning, and recovery strategies.
- **New providers & model dialects** — adapters for endpoints and APIs Magister doesn't speak yet.
- **Tools, skills, and channels** — extend what teammates can do, and where tasks come from.

Each of these is meant to be a small, well-scoped change rather than a fork — the codebase is readable and the seams are deliberate. Issues, PRs, and questions are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## Security

Magister executes shell commands and connects to MCP servers that can run arbitrary code; the default `trustLevel: "ask"` gates every MCP tool call through approval. On Linux an optional bubblewrap sandbox adds best-effort isolation. Provider keys are stored locally — use disk encryption. The safety model targets a single trusted operator running their own agents, not untrusted or adversarial code. See [`SECURITY.md`](SECURITY.md) for responsible disclosure.

## License

[MIT](LICENSE)
