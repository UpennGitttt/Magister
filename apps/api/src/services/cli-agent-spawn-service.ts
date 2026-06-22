import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { LeaderLoopEvent } from "./manager-automation/autonomous-loop/autonomous-types";
import { buildCliResumeArgv, type CliResumableRuntime } from "./cli-session-tracker";
import {
  getParserForRuntime,
  irToLeaderEvent,
  type CliEventParser,
} from "./cli-streaming";
import type { AgentRuntimeType } from "./agent-profile-service";
import { resolveCliExecutable } from "./cli-bridge/cli-executable-resolver";
import type { CliRuntime } from "./cli-bridge/types";
import { buildRuntimeEnv } from "./safe-apply/runtime-env-service";
import {
  assessExecutionSandbox,
  prepareExecutionSandboxCommand,
} from "./safe-apply/execution-sandbox-service";
import {
  derivePermissionMode,
  extractPermissionRelevantArgvFlags,
} from "./safe-apply/permission-mode-service";
import type {
  CliArgvBuildResult,
  CliArgvMetadata,
  RuntimeSecurityMetadata,
  RuntimeSource,
  RuntimeWorkspaceStrategy,
} from "./safe-apply/safe-apply-types";

/**
 * The CLI versions `buildCliArgs` was written and verified against.
 *
 * If a future CLI upgrade changes flag names, ordering rules, or
 * subcommand structure, this baseline gives maintainers a known-good
 * reference point: re-run the E2E in this commit's docs/state-of-cli
 * notes against these exact versions before debugging new versions.
 *
 * Format: substring match of the CLI's own `--version` output. The
 * match is fuzzy (substring) so patch-level bumps don't trigger
 * spurious warnings; only minor/major drift is flagged.
 *
 * Verified:
 *   codex     `-i <file> --sandbox workspace-write <prompt>` reads images
 *   opencode  `run <prompt> -f <file>` (prompt FIRST)    reads files
 *   claude    `--permission-mode auto -p <prompt-with-file-paths>` uses Read tool
 */
export const CLI_ARGS_BASELINE_VERSIONS: Record<"codex" | "claude-code" | "opencode", string> = {
  "codex": "codex-cli 0.128",
  "claude-code": "2.1.",
  "opencode": "1.14",
};

export type CliSpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  runtimeSecurity: RuntimeSecurityMetadata;
  /**
   * codex round-4 [C1] fix. When the
   * streaming parser produced a clean `final_result` IR event (i.e.
   * the run completed and we extracted the assistant's final text),
   * this is that text. Callers prefer it over `stdout` for the
   * leader's tool_result so the leader doesn't get a wall of raw
   * JSONL events. Falls back to `stdout` (legacy black-box) when
   * streaming was off, parsing failed, or the parser saw no final
   * result.
   */
  streamingFinalText: string | null;
  /**
   * Codex round-5 [M1] — true iff this spawn ran with streaming
   * enabled (parser was active, stdout is raw JSONL).
   */
  streamingMode: boolean;
  /**
   * Codex round-5 follow-up — true iff the parser was active AND
   * actually parsed at least one valid line before the run ended.
   * Distinguishes "parser worked, just didn't produce final_result"
   * (stdout is raw JSONL — placeholder is correct) from "parser
   * never made sense of any line, hit failure threshold" (stdout
   * is probably clean human-readable text from a CLI that ignored
   * the --json flag — show stdout instead). Without this, tests
   * that use a fake CLI passing `runtimeType: "codex"` would have
   * stdout hidden behind the placeholder.
   */
  streamingProducedAnyEvents: boolean;
};

/**
 * If `workspaceDir` is a git worktree (its `.git` is a file pointing
 * elsewhere instead of a real directory), return the host paths the
 * sandboxed CLI needs read+write access to in order to run `git
 * commit` / `git fetch` / etc. without ENOENT.
 *
 * Background: `git worktree add /opt/acme/foo` creates a workspace
 * where `.git` is just a text file:
 *
 *     gitdir: /opt/acme/MAIN/.git/worktrees/foo
 *
 * Git operations from the worktree write to that path (HEAD, index,
 * logs, ORIG_HEAD), and also read+sometimes write the main repo's
 * `.git/` referenced by `commondir` (objects, refs, hooks). Both
 * paths are OUTSIDE the workspace tree, so `codex --sandbox
 * workspace-write` blocks them by default — model emits `git commit`
 * and bwrap refuses every fs operation.
 *
 * This helper returns the two paths so the codex builder can push
 * `--add-dir <p>` for each. Returns [] for regular checkouts (where
 * `.git` IS a directory) and on any parse failure (fail-safe — fewer
 * permissions, not more).
 *
 * Fixes "coder teammate BLOCKED before investigation" when
 * spawn_teammate runs codex against an ephemeral worktree.
 */
function resolveWorktreeExtraDirs(workspaceDir: string): string[] {
  const gitFilePath = join(workspaceDir, ".git");
  let stat;
  try {
    stat = statSync(gitFilePath);
  } catch {
    return [];
  }
  // Regular checkout (.git is a dir) — no extra paths needed; the
  // existing workspace-write bind covers it.
  if (!stat.isFile()) return [];
  let content: string;
  try {
    content = readFileSync(gitFilePath, "utf8");
  } catch {
    return [];
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match || !match[1]) return [];
  const gitdir = match[1].trim();
  const extras: string[] = [gitdir];
  try {
    const commondir = readFileSync(join(gitdir, "commondir"), "utf8").trim();
    if (commondir) {
      const resolved = isAbsolute(commondir) ? commondir : resolve(gitdir, commondir);
      extras.push(resolved);
    }
  } catch {
    // commondir file optional; if missing the worktree is self-contained
    // (rare but possible) and gitdir alone is enough.
  }
  return extras;
}

function mapCodexReasoningEffort(
  effort: string | undefined,
): "low" | "medium" | "high" | undefined {
  const normalized = effort?.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  if (normalized === "xhigh") {
    return "high";
  }
  return undefined;
}

export function buildCliArgs(
  command: string,
  model: string | undefined,
  prompt: string,
  reasoningEffort: string | undefined,
  instructions: string | undefined,
  imagePaths: string[] | undefined,
  /**
   * when true, append the per-CLI streaming
   * JSON flags so the spawn-service can line-buffer stdout and route
   * through the CliEventParser pipeline. Caller is responsible for
   * deciding whether streaming is wanted (typically: always, gated
   * only by parser availability and CLI version).
   */
  streamJsonMode = false,
  /**
   * When provided AND the workspace is a git worktree, codex gets
   * `--add-dir` for the worktree's gitdir + commondir so model-emitted
   * `git commit` / `git fetch` succeed inside the sandbox. No-op for
   * regular checkouts and for non-codex CLIs (which don't have this
   * flag).
   */
  workspaceDir?: string,
): CliArgvBuildResult {
  const commandName = basename(command).toLowerCase();
  const runtimeSource = runtimeSourceFromCommandName(commandName);
  const images = imagePaths && imagePaths.length > 0 ? imagePaths : [];

  // If instructions are set, prepend to prompt for CLIs that don't support a dedicated flag
  const effectivePrompt = instructions
    ? `${instructions}\n\n---\n\nTask:\n${prompt}`
    : prompt;

  if (commandName === "codex") {
    const args: string[] = ["exec"];
    // `--json` produces JSONL events on stdout (verified against
    // codex 0.129.0). Order: flags before positional prompt.
    if (streamJsonMode) args.push("--json");
    if (model) {
      args.push("--model", model);
    }
    const codexReasoningEffort = mapCodexReasoningEffort(reasoningEffort);
    if (codexReasoningEffort) {
      args.push("--config", `model_reasoning_effort="${codexReasoningEffort}"`);
    }
    // codex exec supports `-i, --image <FILE>...` for native image
    // attachment on the initial prompt. Repeat the flag once per file.
    for (const path of images) args.push("-i", path);
    // codex 0.130:
    //   - `--full-auto` is deprecated; `--sandbox workspace-write` is the
    //     replacement and prints a noisy warning if you use the old flag.
    //   - The `exec` subcommand does not accept `--ask-for-approval`; the
    //     equivalent has to be passed as a TOML config override via `-c`,
    //     otherwise codex may decide to wait on stdin for permission
    //     decisions even with `stdio: "ignore"` ("Reading additional
    //     input from stdin..." in the prior failure summary).
    //   - `--skip-git-repo-check` lets non-git workspaces run; a no-op for
    //     Magister's git-backed worktrees but cheaper than gating on git state.
    // If the workspace is a git worktree, codex's workspace-write
    // sandbox would block git operations that touch the worktree
    // metadata + main .git/objects (both live outside the workspace
    // tree). `--add-dir` extends the sandbox to allow them.
    if (workspaceDir) {
      for (const dir of resolveWorktreeExtraDirs(workspaceDir)) {
        args.push("--add-dir", dir);
      }
    }
    args.push(
      "--sandbox", "workspace-write",
      "-c", `approval_policy="never"`,
      "--skip-git-repo-check",
      effectivePrompt,
    );
    return buildCliArgvResult(args, runtimeSource);
  }

  if (commandName === "claude") {
    const args: string[] = [];
    if (model) {
      args.push("--model", model);
    }
    if (instructions) {
      args.push("--append-system-prompt", instructions);
    }
    // claude -p has no native image flag, but Claude Code's Read tool
    // is multimodal and reads images directly. Append a file-list
    // section to the prompt so the agent knows the absolute paths to
    // Read. Format mirrors what the leader would write itself.
    const claudePrompt = images.length > 0
      ? `${prompt}\n\nFiles attached for this turn (read with the Read tool, which is multimodal and supports images natively):\n${images.map((p) => `- ${p}`).join("\n")}`
      : prompt;
    if (streamJsonMode) {
      // claude requires --verbose with --output-format stream-json
      // (verified against 2.1.137: "When using --print,
      // --output-format=stream-json requires --verbose").
      // --include-partial-messages enables incremental text deltas.
      args.push(
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
      );
    }
    // `auto` is more lenient than `acceptEdits` — it auto-approves
    // bash commands including compound operations, /tmp writes, and
    // patterns that `acceptEdits` hard-blocks (zsh syntax checks,
    // multi-operation splitting). The stdin control_request responder
    // (below) still auto-approves any remaining permission prompts.
    args.push("--permission-mode", "auto", "-p", claudePrompt);
    return buildCliArgvResult(args, runtimeSource);
  }

  if (commandName === "opencode") {
    const args: string[] = ["run"];
    if (model) {
      args.push("--model", model);
    }
    // CRITICAL ORDER: prompt FIRST, then `-f` flags. opencode's
    // yargs config declares `--file` as `[array]` which greedily
    // consumes subsequent positional args until the next flag —
    // putting the prompt AFTER `-f path` results in opencode
    // interpreting the prompt itself as another file path and
    // erroring with "File not found: <prompt text>". Verified by
    // E2E: `opencode run -f f.png "msg"` fails, `opencode run
    // "msg" -f f.png` works. Tests in this repo previously only
    // checked argv membership, not order, so this slipped through.
    // OpenCode has no system prompt flag — instructions are
    // prepended to the prompt itself by the caller.
    args.push(effectivePrompt);
    for (const path of images) args.push("-f", path);
    if (streamJsonMode) {
      // `--format json` emits raw JSON events on stdout (verified
      // against opencode 1.14.39).
      args.push("--format", "json");
    }
    return buildCliArgvResult(args, runtimeSource);
  }

  return buildCliArgvResult([prompt], runtimeSource);
}

type SpawnCliOptions = {
  command: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
  prompt: string;
  workspaceDir: string;
  env?: Record<string, string>;
  args?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  resumeSessionId?: string;
  resumeRuntime?: CliResumableRuntime;
  imagePaths?: string[];
  runtimeType?: AgentRuntimeType;
  cliVersion?: string | null;
  runtimeWorkspaceStrategy?: RuntimeWorkspaceStrategy;
  sandboxMode?: RuntimeSecurityMetadata["sandboxMode"];
  runtimeHomeDir?: string;
  runtimeTmpDir?: string;
  isolateHome?: boolean;
  onEvent?: (event: LeaderLoopEvent) => Promise<void> | void;
  /**
   * Side-channel for token usage extracted from the CLI's terminal
   * event (claude-code "result", codex "turn.completed", opencode
   * "step_finish"). Routed separately from `onEvent` because the
   * shape doesn't fit LeaderLoopEvent — caller forwards to
   * `recordUsage()` with the task/run context the spawn service
   * itself doesn't carry. Best-effort; emit failures don't tear
   * down the run. */
  onUsage?: (usage: CliUsageReport) => Promise<void> | void;
};

export type CliUsageReport = {
  runtime: "claude-code" | "codex" | "opencode";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  nonCachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  rawUsage?: unknown;
};

function runtimeSourceFromCommandName(commandName: string): RuntimeSource {
  if (commandName === "codex") return "codex";
  if (commandName === "claude") return "claude-code";
  if (commandName === "opencode") return "opencode";
  return "unknown";
}

function isCliRuntime(value: AgentRuntimeType | undefined): value is CliRuntime {
  return value === "codex" || value === "opencode" || value === "claude-code";
}

function runtimeSourceFromRuntimeType(runtimeType: AgentRuntimeType | CliResumableRuntime | undefined): RuntimeSource {
  if (runtimeType === "ucm" || runtimeType === "codex" || runtimeType === "opencode" || runtimeType === "claude-code") {
    return runtimeType;
  }
  return "unknown";
}

function buildCliArgvResult(
  argv: string[],
  runtimeSource: RuntimeSource,
  sandboxMode: RuntimeSecurityMetadata["sandboxMode"] = null,
  envPermissionHints: string[] = [],
): CliArgvBuildResult {
  const argvFlags = extractPermissionRelevantArgvFlags(argv);
  const permission = derivePermissionMode({
    runtimeSource,
    argv,
    sandboxMode,
    envPermissionHints,
    hasInteractiveApprovalChannel: false,
  });
  return {
    argv,
    argvMetadata: {
      runtimeSource,
      argvFlags,
      permissionMode: permission.permissionMode,
      permissionSignals: permission.permissionSignals,
    },
  };
}

function buildRuntimeSecurityMetadata(input: {
  argv: string[];
  argvMetadata: CliArgvMetadata;
  commandPath: string;
  runtimeSource: RuntimeSource;
  sandboxMode: RuntimeSecurityMetadata["sandboxMode"];
  envPermissionHints: string[];
  runtimeWorkspaceStrategy: RuntimeWorkspaceStrategy;
  executionSandbox: RuntimeSecurityMetadata["executionSandbox"];
}): RuntimeSecurityMetadata {
  const permission = derivePermissionMode({
    runtimeSource: input.runtimeSource,
    argv: input.argv,
    sandboxMode: input.sandboxMode,
    envPermissionHints: input.envPermissionHints,
    hasInteractiveApprovalChannel: false,
  });
  return {
    runtimeSource: input.runtimeSource,
    commandPath: input.commandPath,
    argvFlags: input.argvMetadata.argvFlags,
    sandboxMode: input.sandboxMode,
    permissionMode: permission.permissionMode,
    permissionSignals: permission.permissionSignals,
    envPermissionHints: input.envPermissionHints,
    runtimeWorkspaceStrategy: input.runtimeWorkspaceStrategy,
    executionSandbox: input.executionSandbox ?? null,
  };
}

async function copyFileIfMissing(sourcePath: string, targetPath: string) {
  try {
    await access(targetPath);
    return;
  } catch {
    // Target does not exist yet.
  }

  try {
    await copyFile(sourcePath, targetPath);
  } catch {
    // Best effort: a fresh Codex home can still work when auth is provided elsewhere.
  }
}

async function seedCodexHome(codexHomeDir: string) {
  await mkdir(codexHomeDir, { recursive: true });

  const sourceCodexHome =
    process.env.MAGISTER_CODEX_HOME_SEED?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(homedir(), ".codex");

  if (!sourceCodexHome || sourceCodexHome === codexHomeDir) {
    return;
  }

  await copyFileIfMissing(join(sourceCodexHome, "auth.json"), join(codexHomeDir, "auth.json"));
  await copyFileIfMissing(join(sourceCodexHome, "config.toml"), join(codexHomeDir, "config.toml"));
}

/**
 * Codex round-5 [M2] — detect "unknown option" / "unrecognized
 * argument" stderr patterns. When streaming flags (`--json`,
 * `--output-format stream-json`, `--format json`) are rejected by an
 * older CLI version, we want to retry once in black-box mode rather
 * than fail the spawn outright. Pattern matches the most common shapes
 * across codex / claude / opencode CLI argparse libraries (clap, yargs,
 * node:util.parseArgs).
 */
function looksLikeUnknownFlagError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return /unknown (?:option|argument|flag)|unrecognized (?:option|argument)|invalid (?:option|argument|flag)|unexpected argument/.test(s);
}

export async function spawnCliAgent(opts: SpawnCliOptions): Promise<CliSpawnResult> {
  const result = await spawnCliAgentInner(opts);
  // Codex round-5 [M2] — retry without streaming if the CLI rejected
  // a streaming-mode flag. We only retry once, only when streaming
  // was on, and only when the failure looks like a flag-syntax error
  // (not a teammate work failure that happens to exit non-zero).
  if (
    result.streamingMode
    && result.exitCode !== 0
    && looksLikeUnknownFlagError(result.stderr)
  ) {
    console.warn(
      `[cli-streaming] CLI rejected streaming flag (exit=${result.exitCode}). Retrying once in black-box mode. stderr: ${result.stderr.slice(0, 200)}`,
    );
    // Retry without onEvent → streamingParser becomes null inside the
    // inner spawn → buildCliArgs(streamJsonMode=false) → no streaming
    // flags. The retry inherits everything else (timeout, signal,
    // images, resume, prompt).
    const retryOpts = { ...opts };
    delete retryOpts.onEvent;
    return spawnCliAgentInner(retryOpts);
  }
  return result;
}

async function spawnCliAgentInner(opts: SpawnCliOptions): Promise<CliSpawnResult> {
  const startedAt = Date.now();
  const resolvedCommand = isCliRuntime(opts.runtimeType)
    ? (await resolveCliExecutable(opts.runtimeType, opts.command)).command
    : opts.command;
  // pick a parser BEFORE building argv. If
  // a parser is available, we add the `--json`/`stream-json`/`--format
  // json` flag to the CLI invocation; otherwise we keep the legacy
  // human-readable mode. The check happens once here (not per line)
  // because spawning the CLI in streaming mode without a parser would
  // be wasted overhead.
  const streamingParser: CliEventParser | null = opts.onEvent && opts.runtimeType
    ? getParserForRuntime(opts.runtimeType, opts.cliVersion ?? null)
    : null;
  const streamJsonMode = streamingParser !== null;

  const built = opts.resumeSessionId && opts.resumeRuntime
    ? (() => {
        const resumed = buildCliResumeArgv(opts.resumeRuntime, opts.resumeSessionId, opts.prompt, {
          ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
          ...(opts.instructions?.trim() ? { instructions: opts.instructions.trim() } : {}),
          ...(opts.reasoningEffort?.trim() ? { reasoningEffort: opts.reasoningEffort.trim() } : {}),
        });
        return buildCliArgvResult(
          resumed.args,
          runtimeSourceFromRuntimeType(opts.resumeRuntime),
          opts.sandboxMode ?? null,
        );
      })()
    : buildCliArgs(
        resolvedCommand,
        opts.model?.trim() || undefined,
        opts.prompt,
        opts.reasoningEffort,
        opts.instructions?.trim() || undefined,
        opts.imagePaths,
        streamJsonMode,
        opts.workspaceDir,
      );
  const argv = [...built.argv, ...(opts.args ?? [])];
  const argvMetadata = buildCliArgvResult(
    argv,
    opts.runtimeType ? runtimeSourceFromRuntimeType(opts.runtimeType) : built.argvMetadata.runtimeSource,
    opts.sandboxMode ?? null,
  ).argvMetadata;

  const commandName = basename(resolvedCommand).toLowerCase();
  const runtimeSource = opts.runtimeType
    ? runtimeSourceFromRuntimeType(opts.runtimeType)
    : argvMetadata.runtimeSource;
  // CLI agent HOME / TMP live under Magister's own data dir, scoped
  // per workspace via a path-safe slug. This avoids polluting user
  // projects with session history / credential files. Tests / callers
  // can still pass `runtimeHomeDir` / `runtimeTmpDir` to override.
  const ucmDataDir = process.env.MAGISTER_DATA_DIR ?? join(process.cwd(), ".magister");
  const workspaceSlug = "-" + opts.workspaceDir
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9]/g, "-");
  const runtimeHomeDir = opts.runtimeHomeDir
    ?? join(ucmDataDir, "cli-home", workspaceSlug, runtimeSource);
  const runtimeTmpDir = opts.runtimeTmpDir
    ?? join(ucmDataDir, "cli-tmp", workspaceSlug, runtimeSource);
  await mkdir(runtimeHomeDir, { recursive: true });
  await mkdir(runtimeTmpDir, { recursive: true });
  const runtimeEnv = buildRuntimeEnv({
    baseEnv: process.env,
    userEnv: {
      ...(opts.env ?? {}),
    },
    runtimeSource,
    runtimeHomeDir,
    runtimeTmpDir,
    ...(opts.isolateHome !== undefined ? { isolateHome: opts.isolateHome } : {}),
  });
  if (runtimeSource === "codex" && runtimeEnv.env.CODEX_HOME) {
    await seedCodexHome(runtimeEnv.env.CODEX_HOME);
  }
  // CLI agents run their own inner bwrap. Wrapping them in Magister's
  // outer bwrap creates a nested sandbox that fails (inner bwrap needs
  // mount() the outer drops). Skip outer bwrap here; the CLI's own
  // sandbox is the source of truth. Leader's own `bash` tool calls
  // still use the global execution sandbox config.
  const executionSandbox = await assessExecutionSandbox({
    runtimeSource,
    runtimeWorkspaceDir: opts.workspaceDir,
    baseWorkspaceDir: process.cwd(),
    runtimeHomeDir,
    runtimeTmpDir,
    homeIsolated: runtimeEnv.env.HOME === runtimeHomeDir,
    config: { mode: "off" },
  });
  const sandboxPlan = prepareExecutionSandboxCommand({
    command: resolvedCommand,
    args: argv,
    cwd: opts.workspaceDir,
    env: runtimeEnv.env,
    executionSandbox,
    baseWorkspaceDir: process.cwd(),
    runtimeWorkspaceDir: opts.workspaceDir,
    runtimeHomeDir,
    runtimeTmpDir,
  });
  const runtimeSecurity = buildRuntimeSecurityMetadata({
    argv,
    argvMetadata,
    commandPath: resolvedCommand,
    runtimeSource,
    sandboxMode: opts.sandboxMode ?? null,
    envPermissionHints: runtimeEnv.permissionHints,
    runtimeWorkspaceStrategy: opts.runtimeWorkspaceStrategy ?? "unknown",
    executionSandbox: sandboxPlan.executionSandbox,
  });
  if (sandboxPlan.type === "failed") {
    return {
      exitCode: -1,
      stdout: "",
      stderr: sandboxPlan.failureReason,
      durationMs: Date.now() - startedAt,
      runtimeSecurity,
      streamingFinalText: null,
      streamingMode: false,
      streamingProducedAnyEvents: false,
    };
  }

  // open stdin pipe ONLY for claude
  // streaming. Claude emits `control_request` permission events that
  // require a `control_response` written back on stdin; without the
  // pipe the CLI hangs.
  //
  // Only claude's spawn gets stdin=pipe (for control_response writes).
  // codex/opencode block reading stdin until EOF when piped, causing
  // indefinite hangs.
  const stdinMode: "ignore" | "pipe" = (streamingParser && commandName === "claude")
    ? "pipe"
    : "ignore";

  return await new Promise<CliSpawnResult>((resolve) => {
    const child = spawn(sandboxPlan.command, sandboxPlan.args, {
      cwd: sandboxPlan.cwd,
      env: sandboxPlan.env,
      stdio: [stdinMode, "pipe", "pipe"],
      // Own process group (like the bash tool) so abort/timeout can kill
      // the whole tree — a CLI teammate that shelled out to git/build/test
      // or an MCP child otherwise leaves those grandchildren orphaned.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    // line buffer for streaming parsers.
    // Stdout chunks split mid-line (`{"type":"item.start` ... rest in
    // next chunk), so we hold the trailing partial in `stdoutTail`
    // and only feed complete lines to the parser. On exit any
    // remainder gets fed (some CLIs don't terminate the last line
    // with \n) and `parser.finalize()` is called.
    let stdoutTail = "";
    // Codex round-4 [M] — disable streaming after THRESHOLD failures
    // rather than first failure. ANSI noise / a single stderr-leaked
    // line shouldn't permanently downgrade the run.
    const PARSER_FAILURE_THRESHOLD = 5;
    let parserFailureCount = 0;
    let parserDisabled = false;
    // Codex round-4 [C1] — captured from a `final_result` IR event.
    // Returned in CliSpawnResult.streamingFinalText so the leader's
    // tool_result is the parsed clean text, not the raw JSONL stdout.
    let streamingFinalText: string | null = null;
    let streamingProducedAnyEvents = false;
    // Codex round-4 [M] — track inflight onEvent promises so
    // flushTailAndFinalize can wait for them before resolving the
    // spawn promise. Otherwise mid-stream events can settle AFTER
    // the spawn promise resolves.
    const inflightEmits: Set<Promise<void>> = new Set();
    // Codex round-4 [M] — guard against double-fire when both `error`
    // and `close` events trigger flushTailAndFinalize.
    let flushed = false;
    let flushPromise: Promise<void> | null = null;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let forceKillHandle: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const emitParsedEvents = async (events: ReturnType<CliEventParser["feedLine"]>): Promise<void> => {
      // Gate on parser success + at least one downstream sink. Usage
      // IRs need only onUsage; leader-event IRs need onEvent. Allow
      // through if either is wired.
      if (!events.ok) return;
      if (!opts.onEvent && !opts.onUsage) return;
      if (events.events.length > 0) streamingProducedAnyEvents = true;
      for (const ir of events.events) {
        // Codex round-4 [C1] — capture the clean final text so
        // CliSpawnResult.streamingFinalText replaces raw stdout
        // for the leader's tool_result.
        if (ir.kind === "final_result") {
          streamingFinalText = ir.text;
        }
        // auto-approve claude
        // permission prompts. Magister is already running with
        // `--dangerously-skip-permissions + IS_SANDBOX=1`; without
        // this responder a permission_request would hang the run.
        // Writing the response on the same tick we see the request
        // is safe because parsers expose the request_id directly.
        if (ir.kind === "control_request" && stdinMode === "pipe") {
          const response = JSON.stringify({
            type: "control_response",
            request_id: ir.requestId,
            response: { decision: "approve" },
          }) + "\n";
          try {
            child.stdin?.write(response);
          } catch (err) {
            console.warn(
              `[cli-streaming] failed to write control_response: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // Intercept usage IRs into the side-channel callback before
        // hitting irToLeaderEvent (which intentionally returns null
        // for "usage" — they don't fit the leader-event shape).
        if (ir.kind === "usage") {
          if (opts.onUsage) {
            try {
              await opts.onUsage({
                runtime: ir.runtime,
                model: ir.model,
                inputTokens: ir.inputTokens,
                outputTokens: ir.outputTokens,
                ...(ir.nonCachedInputTokens !== undefined
                  ? { nonCachedInputTokens: ir.nonCachedInputTokens }
                  : {}),
                ...(ir.cacheReadTokens !== undefined ? { cacheReadTokens: ir.cacheReadTokens } : {}),
                ...(ir.cacheWriteTokens !== undefined ? { cacheWriteTokens: ir.cacheWriteTokens } : {}),
                ...(ir.reasoningTokens !== undefined ? { reasoningTokens: ir.reasoningTokens } : {}),
                ...(ir.totalTokens !== undefined ? { totalTokens: ir.totalTokens } : {}),
                ...(ir.rawUsage !== undefined ? { rawUsage: ir.rawUsage } : {}),
              });
            } catch (err) {
              console.warn(
                `[cli-streaming] onUsage failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          continue;
        }
        if (!opts.onEvent) continue;
        try {
          const evt = irToLeaderEvent(ir);
          if (evt) await opts.onEvent(evt);
        } catch (err) {
          // Don't let one downstream emit failure tear down the whole
          // run. Log and keep going — the parser stays live.
          console.warn(
            `[cli-streaming] onEvent failed (${ir.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    const trackEmit = (p: Promise<void>): void => {
      // Codex round-4 [M] — register the emit promise so
      // flushTailAndFinalize can wait for it. Ignore errors here;
      // emitParsedEvents already logs them internally.
      inflightEmits.add(p);
      p.finally(() => inflightEmits.delete(p));
    };

    const feedLineToParser = (line: string): void => {
      if (!streamingParser || parserDisabled || !opts.onEvent) return;
      const result = streamingParser.feedLine(line);
      if (!result.ok) {
        // Codex round-4 [M] — accumulate failures and disable only
        // after THRESHOLD; prevents one ANSI noise / stderr-leaked
        // line from silently downgrading the entire run.
        parserFailureCount += 1;
        console.warn(
          `[cli-streaming] parse error (${parserFailureCount}/${PARSER_FAILURE_THRESHOLD}): ${result.reason}`,
        );
        if (parserFailureCount >= PARSER_FAILURE_THRESHOLD) {
          console.warn(
            `[cli-streaming] parser disabled after ${PARSER_FAILURE_THRESHOLD} failures. Falling back to black-box.`,
          );
          parserDisabled = true;
        }
        return;
      }
      trackEmit(emitParsedEvents(result));
    };

    // Kill the whole process group (negative pid) since the child was
    // spawned `detached` — this reaps grandchildren (git/build/test/MCP)
    // that a direct `child.kill` would orphan. Falls back to the direct
    // child if the group signal isn't deliverable.
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (typeof child.pid === "number") {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // group already gone or not a leader — fall through
      }
      try {
        child.kill(signal);
      } catch {
        // best-effort
      }
    };

    const terminateChild = () => {
      killTree("SIGTERM");

      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }

      forceKillHandle = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        killTree("SIGKILL");
      }, 5_000);
      forceKillHandle.unref?.();
    };

    const finalize = (result: Omit<CliSpawnResult, "durationMs">) => {
      if (settled) {
        return;
      }
      settled = true;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (forceKillHandle) {
        clearTimeout(forceKillHandle);
      }

      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener("abort", abortHandler);
      }

      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      // split on \n, hold the trailing
      // partial in stdoutTail until the next chunk arrives. The
      // legacy `stdout` accumulation above keeps running for callers
      // that don't pass `onEvent` and as a fallback for parser
      // failures (parserDisabled flag).
      if (streamingParser && opts.onEvent) {
        const combined = stdoutTail + text;
        const lines = combined.split("\n");
        // Last element is the trailing partial (or empty if the chunk
        // ended on \n). Everything before it is a complete line.
        stdoutTail = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length === 0) continue;
          feedLineToParser(line);
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const flushTailAndFinalize = (exitCode: number): Promise<void> => {
      // drain any pending tail (CLIs that
      // don't end the last line with \n) and call parser.finalize().
      // Codex round-4 [M] — guarded by `flushed` flag so error+close
      // sequence doesn't double-fire system events.
      if (flushPromise) return flushPromise;
      flushPromise = (async () => {
        if (flushed) return;
        flushed = true;
        if (streamingParser && !parserDisabled && opts.onEvent) {
          if (stdoutTail.length > 0) {
            feedLineToParser(stdoutTail);
            stdoutTail = "";
          }
          try {
            const final = streamingParser.finalize(exitCode);
            await emitParsedEvents(final);
          } catch (err) {
            console.warn(
              `[cli-streaming] parser.finalize threw: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        // Codex round-4 [M] — wait for any inflight mid-stream emits to
        // settle before resolving the spawn promise. Otherwise async
        // onEvent calls fired during the run can complete AFTER the
        // caller has already moved on.
        if (inflightEmits.size > 0) {
          await Promise.allSettled([...inflightEmits]);
        }
      })();
      return flushPromise;
    };

    child.on("error", (error) => {
      void flushTailAndFinalize(-1).finally(() => {
        finalize({
          exitCode: -1,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
          runtimeSecurity,
          streamingFinalText,
          streamingMode: streamingParser !== null,
          streamingProducedAnyEvents,
        });
      });
    });

    child.on("close", (code) => {
      void flushTailAndFinalize(code ?? 0).finally(() => {
        finalize({
          exitCode: code ?? 0,
          stdout,
          stderr,
          runtimeSecurity,
          streamingFinalText,
          streamingMode: streamingParser !== null,
          streamingProducedAnyEvents,
        });
      });
    });

    if (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        terminateChild();

        void flushTailAndFinalize(-1).finally(() => {
          finalize({
            exitCode: -1,
            stdout,
            stderr: `Process timed out after ${opts.timeoutMs}ms`,
            runtimeSecurity,
            streamingFinalText,
            streamingMode: streamingParser !== null,
            streamingProducedAnyEvents,
          });
        });
      }, opts.timeoutMs);
    }

    if (opts.signal) {
      abortHandler = () => {
        terminateChild();

        void flushTailAndFinalize(-1).finally(() => {
          finalize({
            exitCode: -1,
            stdout,
            stderr: "Process aborted",
            runtimeSecurity,
            streamingFinalText,
            streamingMode: streamingParser !== null,
            streamingProducedAnyEvents,
          });
        });
      };

      if (opts.signal.aborted) {
        abortHandler();
      } else {
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
  });
}
