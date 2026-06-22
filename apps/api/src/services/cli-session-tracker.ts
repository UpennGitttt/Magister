import { type Dirent } from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI runtimes whose session-resume is wired up.
 */
export type CliResumableRuntime = "codex" | "claude-code" | "opencode";

/**
 * Detect the freshly-created session ID after a CLI agent spawn so
 * we can later issue `<cli> resume <id>` to continue that exact
 * conversation.
 *
 * Strategy: each CLI persists its session in a known directory with
 * a UUID-bearing filename. After the spawn finishes we walk that
 * directory for `.jsonl` files whose mtime is at least as recent as
 * the spawn-start timestamp, take the newest, and parse the UUID
 * from the filename.
 *
 *   codex    → `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *   claude   → `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
 *   opencode → `~/.local/share/opencode/storage/session/<projectHash>/ses_<id>.json`
 *              (`projectHash` is opencode-internal — we walk the tree
 *              and match by mtime + filename pattern rather than
 *              computing it ourselves; the algorithm differs from
 *              sha1(cwd) so reverse-engineering would add brittleness).
 *
 * The `spawnStartMs` window is widened by 200ms to account for clock
 * skew between Node's `Date.now()` and the kernel's mtime. Both CLIs
 * create the session file at process start (not at exit), so mtime
 * should be very close to spawnStartMs — too generous a margin
 * widens the window for misattributing a concurrent teammate's file.
 *
 * Returns `null` when no matching file is found — caller handles by
 * recording "no session id" and rejecting future resume.
 */
/**
 * Resolve the user home directory. Bun's `os.homedir()` caches at
 * startup so a test that overrides `process.env.HOME` won't be
 * reflected — read from env first and fall back to the OS call.
 */
function resolveHome(): string {
  return process.env.HOME ?? homedir();
}

export async function detectCliSessionId(opts: {
  runtime: CliResumableRuntime;
  workspaceDir: string;
  /** Per-runtime codex home (set when isolating). Falls back to
   *  $CODEX_HOME / ~/.codex. */
  codexHome?: string;
  /** Override for the claude projects dir root (mainly for tests).
   *  Defaults to `<HOME>/.claude/projects`. */
  claudeProjectsRoot?: string;
  /** Override for the opencode session storage root (tests / non-XDG
   *  installs). Defaults to `$XDG_DATA_HOME/opencode/storage/session`
   *  or `<HOME>/.local/share/opencode/storage/session`. */
  opencodeSessionRoot?: string;
  /** Date.now() captured just BEFORE the CLI spawn started. */
  spawnStartMs: number;
}): Promise<string | null> {
  if (opts.runtime === "codex") {
    const home = opts.codexHome
      || process.env.CODEX_HOME
      || join(resolveHome(), ".codex");
    const sessionsDir = join(home, "sessions");
    return findNewestSessionUuid(sessionsDir, opts.spawnStartMs, "codex");
  }
  if (opts.runtime === "claude-code") {
    // Claude encodes the cwd by replacing EVERY non-alphanumeric char
    // with `-` and prefixing with `-`.
    const encoded = "-" + opts.workspaceDir.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]/g, "-");
    const projectsRoot = opts.claudeProjectsRoot ?? join(resolveHome(), ".claude", "projects");
    const projectDir = join(projectsRoot, encoded);
    return findNewestSessionUuid(projectDir, opts.spawnStartMs, "claude");
  }
  if (opts.runtime === "opencode") {
    // Opencode session files live at:
    //   $XDG_DATA_HOME/opencode/storage/session/<projectHash>/ses_*.json
    // The projectHash is opencode-internal so we walk the whole
    // `session/` root by mtime. To disambiguate, each session JSON
    // carries a `directory` field; we only accept matches.
    const sessionRoot = opts.opencodeSessionRoot
      ?? join(
        process.env.XDG_DATA_HOME ?? join(resolveHome(), ".local", "share"),
        "opencode",
        "storage",
        "session",
      );
    return findNewestSessionUuid(
      sessionRoot,
      opts.spawnStartMs,
      "opencode",
      { expectedDirectory: opts.workspaceDir },
    );
  }
  return null;
}

/** UUID regex (8-4-4-4-12 hex). */
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Opencode session id regex — `ses_` prefix + base-36-ish suffix.
 *  Tolerance on length allows for future format drift. */
const OPENCODE_ID_RE = /^(ses_[A-Za-z0-9]{20,})\.json$/;

async function findNewestSessionUuid(
  rootDir: string,
  spawnStartMs: number,
  runtime: "codex" | "claude" | "opencode",
  extra: { expectedDirectory?: string } = {},
): Promise<string | null> {
  // Tightened from 1s → 200ms after kimi review: codex and claude
  // both create the session file at process start, so mtime tracks
  // spawnStartMs closely. A wider window risks picking up a
  // concurrent teammate's file written shortly before our spawn
  // (rare but real with shared CODEX_HOME and `wait: false`).
  const earliestAcceptableMs = spawnStartMs - 200;
  // Match the file extension per runtime — codex/claude persist
  // `.jsonl`, opencode persists `.json` (single object per session,
  // not a streaming log).
  const wantedExt = runtime === "opencode" ? ".json" : ".jsonl";
  // Collect ALL candidates (not just the single newest) for opencode
  // so the post-filter on session-JSON `directory` can fall through
  // to the next-newest match in our cwd if the absolute newest
  // belongs to a different project (concurrent opencode runs).
  // For codex/claude the candidates list collapses naturally — they
  // scope by path so cross-project bleed isn't possible.
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist — first spawn / wrong path
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(wantedExt)) {
        let s;
        try {
          s = await fsp.stat(full);
        } catch {
          continue;
        }
        if (s.mtimeMs >= earliestAcceptableMs) {
          candidates.push({ path: full, mtimeMs: s.mtimeMs });
        }
      }
    }
  }

  await walk(rootDir);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  // Opencode-only filter: read the session JSON's `directory` field
  // and skip any whose directory doesn't match our workspace. Walks
  // candidates from newest to oldest until one matches; bails after
  // the first mismatch's distance from spawnStartMs grows wide.
  // Sample shape:
  //   { "id": "ses_...", "directory": "/home/user/my-project", ... }
  let newest: { path: string; mtimeMs: number } | null = null;
  if (runtime === "opencode" && extra.expectedDirectory) {
    for (const c of candidates) {
      try {
        const raw = await fsp.readFile(c.path, "utf-8");
        const parsed = JSON.parse(raw) as { directory?: unknown };
        if (typeof parsed.directory === "string" && parsed.directory === extra.expectedDirectory) {
          newest = c;
          break;
        }
      } catch {
        // Unparseable or unreadable — skip; the next candidate
        // might be ours.
      }
    }
    if (!newest) {
      // Found candidates but none matched the workspace. Usually
      // means our spawn's session file hasn't materialized yet OR
      // opencode wrote it under a directory string that differs
      // from our workspaceDir (path normalization mismatch). Don't
      // fall back to "newest regardless" — that'd swap us into a
      // different project's session.
      return null;
    }
  } else {
    newest = candidates[0] ?? null;
    if (!newest) return null;
  }

  // We search the BASENAME only to avoid matching path components
  // (e.g. /var/tmp/abc-de-...).
  const basename = (newest as { path: string; mtimeMs: number }).path
    .split("/")
    .pop() ?? "";
  if (runtime === "codex") {
    // codex: filename has multiple hex groups in the timestamp; UUID
    // is always last. Use a tail-anchored regex.
    const m = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if (!m) {
      // Visible warning when the codex filename pattern changes
      // (e.g. CLI update adds a suffix). Without this, resume_id
      // silently breaks until a user reports it. 
      console.warn(
        `[cli-session-tracker] codex session file matched mtime window but UUID regex didn't match basename: ${basename}`,
      );
      return null;
    }
    return m[1]!;
  }
  if (runtime === "opencode") {
    // opencode: filename IS `<ses-id>.json` (e.g. `ses_40c0170fbffe….json`).
    const m = basename.match(OPENCODE_ID_RE);
    if (!m) {
      console.warn(
        `[cli-session-tracker] opencode session file matched mtime window but basename isn't a ses_* id: ${basename}`,
      );
      return null;
    }
    return m[1]!;
  }
  // claude: filename IS the UUID + .jsonl
  const m = basename.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  if (!m) {
    console.warn(
      `[cli-session-tracker] claude session file matched mtime window but basename isn't a UUID: ${basename}`,
    );
    return null;
  }
  return m[1]!;
}

/**
 * Build the CLI argv for resuming a specific session id. The fresh-
 * spawn argv is built by `cli-agent-spawn-service.ts`'s `buildCliArgs`
 * — this lives separately because resume changes the subcommand
 * structure (codex `exec resume <id>` vs fresh `exec <prompt>`).
 */
export function buildCliResumeArgv(
  runtime: CliResumableRuntime,
  sessionId: string,
  prompt: string,
  opts: { model?: string; instructions?: string; reasoningEffort?: string } = {},
): { command: "codex" | "claude" | "opencode"; args: string[] } {
  if (runtime === "codex") {
    // codex exec resume [-m x] [-c k=v ...] --skip-git-repo-check <UUID> <prompt>
    //
    // `codex exec resume` does NOT accept the `--sandbox` flag —
    // sandbox at resume goes through `-c sandbox_mode="workspace-write"`.
    const args: string[] = ["exec", "resume"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    // Propagate reasoning effort on resume too — fresh-spawn argv
    // builder honors it; resume needs the same hand-off so the
    // continued conversation runs with the same effort level (kimi
    // review).
    const effort = opts.reasoningEffort?.trim().toLowerCase();
    if (effort === "low" || effort === "medium" || effort === "high") {
      args.push("-c", `model_reasoning_effort="${effort}"`);
    } else if (effort === "xhigh") {
      args.push("-c", `model_reasoning_effort="high"`);
    }
    // Keep resume aligned with fresh-spawn codex 0.130 behavior. Without
    // explicit non-interactive approval config, resume can hang waiting
    // for stdin even though Magister passes the follow-up prompt positionally.
    // Sandbox + approval policy via config-override form (resume rejects
    // the `--sandbox` flag itself).
    args.push(
      "-c", `sandbox_mode="workspace-write"`,
      "-c", `approval_policy="never"`,
      "--skip-git-repo-check",
    );
    args.push(sessionId);
    const promptText = opts.instructions
      ? `${opts.instructions}\n\n---\n\nFollow-up:\n${prompt}`
      : prompt;
    args.push(promptText);
    return { command: "codex", args };
  }
  if (runtime === "claude-code") {
    // claude --resume <UUID> --permission-mode auto -p <prompt>
    const args: string[] = [];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.instructions) {
      args.push("--append-system-prompt", opts.instructions);
    }
    args.push("--resume", sessionId, "--permission-mode", "auto", "-p", prompt);
    return { command: "claude", args };
  }
  if (runtime === "opencode") {
    // opencode run [--model x] --session <ses-id> <prompt>
    // `-s/--session <id>` continues an existing session.
    // Opencode doesn't accept a system-prompt flag, so
    // instructions are prepended to the prompt (same convention as
    // the fresh-spawn path).
    // We intentionally OMIT `--format json` to match codex/claude
    // resume behavior — resume runs in black-box mode (no inline
    // streaming on the resumed turn). Inline streaming on the
    // *original* spawn still surfaced the teammate's tool calls
    // through the CLI parser path; resume just continues the
    // conversation without re-instrumenting.
    const args: string[] = ["run"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    args.push("--session", sessionId);
    const promptText = opts.instructions
      ? `${opts.instructions}\n\n---\n\nFollow-up:\n${prompt}`
      : prompt;
    args.push(promptText);
    return { command: "opencode", args };
  }
  // Unreachable for our type — exhaustive switch on CliResumableRuntime
  throw new Error(`unsupported resumable runtime: ${runtime as string}`);
}

const _testingRefs = { findNewestSessionUuid, UUID_RE };
export const __testing = _testingRefs;
