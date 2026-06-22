# Contributing to Magister

Thanks for considering a contribution! Use [GitHub Discussions](https://github.com/UpennGitttt/CAM/discussions) for general questions and proposals, and open issues for confirmed bugs (with repro steps). Reviews are best-effort and may take a little time, but every PR and issue gets read.

## Dev setup

```bash
git clone https://github.com/UpennGitttt/CAM.git
cd CAM
bun install
cp .env.example .env
cp config/executors.example.json config/executors.json
# Start the app, then add provider API keys in Settings -> Providers.
# Keys are stored in config/secrets.json (gitignored), not in .env.
# Adjust config/executors.json only if you want to hand-edit providers/models/routing.
bun run migrate
bun run dev          # API on :3700  (Terminal 1)
bun run dev:web      # Web on :3701  (Terminal 2)
```

See the [README quickstart](README.md#quick-start) for the user-facing version.

## Code conventions

- **Commit prefixes**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `ci:`. Example: `feat(mcp): per-agent attachment UI`.
- **TypeScript strict** — `bun run typecheck` must pass. `exactOptionalPropertyTypes` is on.
- **Tests** — `bun run test` for the full suite. Add a test for behavior changes; `bun:test` is the runner.
- **Architecture rules** — see [`CLAUDE.md`](CLAUDE.md) for the 3-layer Role/Agent/Provider model and where new code belongs (HTTP in `apps/api/src/routes`, services in `apps/api/src/services`, etc.).

## PR checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes (or matching subset for narrow PRs)
- [ ] If frontend: `bun run build:web` passes
- [ ] Commit messages follow the convention above
- [ ] Linked issue (if any) closed in the PR description

## Common contributions

Walkthroughs for each are pending. Until those land, here are the pointers:

### Adding a new LLM provider

Provider plugins live in `apps/api/src/providers/plugins/`. The dialect registry is in `apps/api/src/providers/plugin-registry.ts`. Reference impls: `anthropic-plugin.ts` (Anthropic Messages API) and `openai-compat-plugin.ts` (OpenAI / DashScope / Moonshot / etc.). A plugin's job is to translate Magister's vendor-neutral `LeaderMessage[]` and `LeaderTool[]` to the wire format the underlying API expects, and translate the streaming response back.

### Adding a new built-in tool

Tools are registered in `apps/api/src/services/manager-automation/autonomous-loop/manager-tools-adapter.ts:createLeaderTools`. Each tool implements the `LeaderTool` interface from `autonomous-types.ts` — name, description, Zod input schema, `call()`, and the `isReadOnly` / `isPlanSafe` / `isConcurrencySafe` classifiers that gate plan-mode behavior.

### Adding a new agent role

The built-in role IDs are `manager`, `coder`, `reviewer`, `architect`, `lander`, `evaluator`. To add a new role, you'll need: (a) a system prompt in `teammate-system-prompts.ts` (or a custom Magister agent profile via Settings → Agents), (b) a `roleMapping` entry in `config/executors.json`, (c) optionally a curated tool set if the role should bypass `createLeaderTools`'s default.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
