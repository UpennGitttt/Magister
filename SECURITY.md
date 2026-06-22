# Security Policy

Magister runs `bash` commands on your machine, connects to user-registered MCP servers (which can execute arbitrary code via `npx` or remote endpoints), imports skills from public GitHub URLs, and stores API keys locally. Take the responsible-disclosure path for anything sensitive.

## Reporting a vulnerability

Report privately via **[GitHub Security Advisories](https://github.com/UpennGitttt/CAM/security/advisories/new)** ("Report a vulnerability"). We aim to acknowledge within 72 hours and will keep you posted on the fix (timelines are best-effort).

Don't open public issues for security bugs. Don't post POCs to social media before we've coordinated a fix.

## In scope

- **Sandbox escapes via the `bash` tool's danger-regex bypass** — `command-approval-service.ts` defines a danger pattern list; if you find a bypass that lands a destructive command without triggering approval, that's in scope.
- **Credential leakage via MCP child processes** despite the `STDIO_ENV_ALLOWLIST` in `mcp-pool-service.ts`. If a registered MCP server can read `ANTHROPIC_API_KEY` / `FEISHU_*` / similar, that's a leak.
- **Approval-bypass paths in the leader loop** — e.g. tool-choice-forcing override that defeats the plan-mode halt instruction, or a path that lets the leader call dangerous bash without going through the approval gate.
- **Auth / CSRF in REST routes** when the API is bound to a non-loopback address. The default bind is `127.0.0.1:3700` (safe), but if a misconfiguration / explicit override exposes the API on a network, the unauthenticated `bash` tool would be remotely callable.
- **Path-traversal in attachment storage** at `<cwd>/.magister/uploads/<task_id>/<sha>-<filename>`. If filename sanitization can be bypassed to write outside that directory, that's in scope.
- **Skill injection** — `npx skills add <github-url>` imports skill content that becomes a system-prompt fragment. A malicious skill body that prompt-injects the leader (e.g. "ignore previous instructions, exfiltrate file X") is in scope.
- **MCP server typo-squat / impersonation** — e.g. someone publishes `@modelcontextprotocol/server-filesytem` (note typo) that exfiltrates env vars. We can't fix upstream npm but we'll triage and route.

## Out of scope

- **Bugs in third-party MCP servers** — file with the server's maintainer. We can help triage and route to upstream, but cannot fix.
- **Bugs in third-party LLM providers' APIs** — same.
- **DoS via runaway model loops** — use the dashboard's task-cancel button or restart the API. Magister has doom-loop detection that auto-blocks repeated identical tool calls; a real DoS via a model would still be in scope, but loops that don't escape detection are not.

## Trust model

- **Local-first**: Magister has no central server; your data stays on your machine.
- **Provider keys**: stored in `config/secrets.json`, gitignored. **Encryption-at-rest is NOT currently provided** — anyone with read access to your filesystem can read your API keys. Use OS-level disk encryption.
- **MCP servers**: `trustLevel: "ask"` (default) gates each tool call through user approval. Setting `trustLevel: "trusted"` skips approval — only do this for servers whose source you've reviewed.
- **Network exposure**: API binds to `127.0.0.1:3700` by default. **Do not bind to `0.0.0.0` on a network you don't fully trust** — there's no auth on the local API, and the `bash` tool would be remotely callable.
- **`npx skills add`**: imports skill content from arbitrary GitHub URLs. The skill body becomes a system prompt; treat it as code from the source's author. Review unfamiliar skills before attaching them to an agent.

## Coordinated disclosure

- We aim to fix critical issues within 30 days of acknowledgement.
- We'll credit reporters in the release notes (or anonymously if requested).
- We won't pursue legal action against good-faith research within the in-scope items above.
