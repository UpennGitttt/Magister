/**
 * Bash read-only classifier for plan mode.
 *
 * Plan mode requires a stricter "definitely no side effects" filter
 * than `command-approval-service.ts` (which targets *dangerous*
 * commands — a different threshold). This module is independent so
 * the two policy layers can evolve separately.
 *
 * Spec: `docs/specs/2026-04-26-plan-mode-spec.md` §8.2.
 *
 * Algorithm:
 *   1. If the command matches any deny pattern, REJECT.
 *   2. If the command matches the allowlist, APPROVE.
 *   3. Default: REJECT (must be on the allowlist explicitly).
 *
 * The default-deny posture is intentional — better to occasionally
 * tell the agent "use exit_plan_mode for that" than to silently let
 * a side-effect through.
 */

// ──────────────────────────────────────────────────────────────────────
// Deny patterns
// ──────────────────────────────────────────────────────────────────────

/**
 * Patterns that immediately fail the classifier. Order matters only
 * for short-circuit; any single match is sufficient.
 *
 * NOTE on the redirect regex: `\b>\b` was rejected in v3.1 review
 * because `>` is non-word and the spaces around it are non-word —
 * `\b` finds no boundary. Use the negative lookahead alone.
 */
const DENY_PATTERNS: RegExp[] = [
  // Write redirects (excluding /dev/null, /dev/stderr, /dev/stdout)
  />(?!\s*\/dev\/(null|stderr|stdout))(?!&)/,
  />>(?!\s*\/dev\/(null|stderr|stdout))/,
  /\|\s*tee\b/,
  // process substitution to a file
  />\(/,

  // File ops
  /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|truncate|install)\b/,

  // In-place edits
  /\bsed\s+(-[a-z]*i|--in-place)\b/,
  /\bawk\s+(-[a-z]*i|--in-place)\b/,
  /\bperl\s+(-[a-z]*i|--in-place)\b/,
  /\bpython\b.*\bin[_-]?place/i,

  // System package managers (these aren't allowlisted, but the regex
  // is the explicit denial in case someone whitelists them locally).
  // The package managers we DO allow as version-checks (npm/bun/pnpm/
  // yarn/pip/cargo) are handled by the tokenizer subcommand check.
  /\b(apt|apt-get|brew|yum|dnf|pacman|zypper|apk|snap|port)\s+(install|remove|update|upgrade|purge)/,
  /\bmake\b/,

  // Arbitrary code execution via interpreter -e/-c — the agent could
  // smuggle a write through `node -e "fs.writeFile(...)"`.
  /\bnode\s+(-e|--eval|-p|--print)\b/,
  /\bdeno\s+(eval|run)\b/,
  /\bpython\d?\s+-c\b/,
  /\bpython\d?\s+-m\s+(?!pip\s+show|pip\s+list|pip\s+freeze)/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,
  /\bbash\s+-c\b/,
  /\bsh\s+-c\b/,
  /\bzsh\s+-c\b/,
  /\beval\b/,
  /\bexec\b/,
  // Backtick command substitution — full subshell, can hide writes.
  // $(...) is harder to filter cleanly and shows up in safe idioms,
  // so we lean on outer-command classification for that.
  /`[^`]+`/,

  // git mutations: handled by the tokenizer subcommand check below
  // (which also catches `git -C path commit` and other global-option
  // bypasses the simple regex form misses).

  // Containers / VMs
  /\bdocker\s+(run|exec|build|push|pull|rm|rmi|stop|start|kill|restart|cp|create|commit|tag|login|logout|save|load)\b/,
  /\bvagrant\b/,
  /\bkubectl\s+(apply|delete|create|edit|patch|exec|run|cp|drain|cordon|uncordon|taint|label|annotate|scale|rollout)\b/,

  // sudo always denied
  /\bsudo\b/,

  // Process kill / signal
  /\b(kill|pkill|killall|skill)\b/,

  // Network mutating curl/wget — flags that download/upload
  /\bcurl\b[^\n]*\s(-o|-O|--output|--upload-file|--data|-X\s+(POST|PUT|DELETE|PATCH))\b/,
  /\bwget\b[^\n]*\s(-O|--output-document|--post-data|--post-file)\b/,

  // Heredoc-to-file is already covered by the redirect deny above
  // (`<<EOF >file` contains `>file`), but flag inline so debugging is
  // easier when this rule fires.
  /<<-?\s*['"]?\w+['"]?\s+>/,

  // Env-var assignment with side-effecting command on the right
  // (e.g. `OUT=$(rm -rf /)`) — this is hard to fully classify; we
  // catch the most obvious pattern of a leading $(...) containing
  // a deny keyword. Conservative.
  /\$\((rm|mv|cp|mkdir|chmod|chown|git\s+commit|npm\s+install)/,
];

// ──────────────────────────────────────────────────────────────────────
// Allowlist
// ──────────────────────────────────────────────────────────────────────

/**
 * Canonical read commands. The allowlist matches the FIRST WORD of
 * the command (or each first-word in a pipe segment). Subsequent
 * args are not inspected by the allowlist — but the deny patterns
 * above scan the full command, so a deny match still wins.
 */
const ALLOW_FIRST_WORDS = new Set<string>([
  // listing / metadata
  "ls", "ll", "la",
  "find", "fd",
  "tree",
  "stat", "file",
  "wc",
  "du", "df",
  "pwd",
  "basename", "dirname",
  "which", "whereis", "type", "command",

  // reading content
  "cat", "head", "tail", "less", "more", "tac", "rev",

  // searching
  "grep", "egrep", "fgrep", "rg", "ag",

  // text processing (read-only forms — `-i` variants are denied above)
  "sed", "awk", "sort", "uniq", "cut", "tr", "paste", "join", "comm",
  "expand", "unexpand", "fold", "fmt", "nl", "od", "xxd", "hexdump",
  "jq", "yq",

  // shell utilities (no side effects)
  "echo", "printf", "true", "false", ":", "test", "[",
  "env", "printenv",
  "date",
  "uname", "hostname",
  "id", "whoami", "groups",
  "uptime",
  "yes",            // benign, only side effect is producing output

  // version / help (read-only)
  "node", "bun", "npm", "pnpm", "yarn", "pip", "pip3", "python",
  "python3", "ruby", "go", "rustc", "cargo", "gcc", "clang",
  "java", "javac", "mvn", "gradle", "rake", "deno",

  // git read commands — controlled by deny patterns above (which
  // reject mutating git subcommands), so we can allow `git` itself
  // here.
  "git",

  // docker read — version, info, ps, etc. The mutating subcommands
  // are denied by the deny pattern above.
  "docker",

  // misc
  "sleep",          // pure no-op for the time
  "dirname", "realpath", "readlink",
]);

// ──────────────────────────────────────────────────────────────────────
// Classifier entry point
// ──────────────────────────────────────────────────────────────────────

/**
 * Strips inline shell adornments (variable assignments, `env` prefix)
 * and returns the leading command word for allowlist comparison.
 *
 * Examples:
 *   "FOO=bar ls /tmp"   → "ls"
 *   "env -i ls"         → "ls"
 *   "ls /tmp"           → "ls"
 */
function leadingCommand(segment: string): string {
  const trimmed = segment.trim();
  // Strip leading `VAR=value VAR2=value2` assignments
  const stripped = trimmed.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
  // Strip leading `env [-i|-u VAR|VAR=val]+` invocations to expose the
  // real command underneath. Conservative — env with no args is also
  // allowed via the allowlist.
  const noEnv = stripped.replace(/^env(\s+(-[iu]|[A-Z_][A-Z0-9_]*=\S+))*\s+/, "");
  // First whitespace-separated token, drop any leading `\` line-continuation
  const first = noEnv.split(/\s+/)[0]?.replace(/^\\/, "") ?? "";
  return first;
}

/**
 * Splits the command on top-level pipe / `&&` / `||` / `;` separators
 * so each segment can be classified independently. This is a coarse
 * split (doesn't handle quotes / parens fully) — it's "good enough"
 * for separating compound commands like `git status && cat foo`. The
 * deny patterns continue to scan the full command anyway, so anything
 * the splitter misses still gets caught by them.
 */
function splitSegments(command: string): string[] {
  return command.split(/\s*(?:\|\||&&|;|\|)\s*/).filter((s) => s.length > 0);
}

// ──────────────────────────────────────────────────────────────────────
// Per-tool subcommand inspection
//
// Several allowlisted tools (`git`, `npm`, `bun`, `pip`, etc.) have
// destructive subcommands. The original implementation tried to catch
// these with regex like `\bgit\s+commit\b`, but that anchored on the
// tool name *immediately* preceded by the subcommand — and missed
// global-option-prefixed forms like `git -C path commit`,
// `npm --prefix pkg install`. Same hole for `find -delete` and
// `sort -o outfile`.
//
// The fix is a per-segment tokenizer that:
//   1. Skips global options (single `-`/`--` flags, with values when
//      the flag is known to take one).
//   2. Identifies the first non-flag token as the subcommand.
//   3. Checks subcommand / flag set against a per-tool deny list.
// ──────────────────────────────────────────────────────────────────────

/** Light-touch tokenizer — splits on whitespace, respects single/
 *  double quotes so `--grep="commit message"` is one token. Doesn't
 *  handle escapes / heredocs / nested subshells; deny-pattern scanning
 *  still runs over the full command for those. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Flags that DO take a value as the next token. Used so the
 *  subcommand-extractor knows to skip both the flag AND its value
 *  when scanning past global options. */
const GIT_VALUE_FLAGS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
]);
const NPM_VALUE_FLAGS = new Set([
  "--prefix", "-w", "--workspace", "--workspaces-update", "--registry", "--userconfig", "--globalconfig",
  // bun / yarn flavors
  "--cwd",
]);
const PIP_VALUE_FLAGS = new Set([
  "--prefix", "--target", "-r", "--requirement", "--cache-dir", "--log",
]);

/** Return the first non-flag token after the tool name, skipping
 *  global options. `valueFlags` enumerates flags that consume the
 *  next token as their value. */
function extractSubcommand(tokens: string[], start: number, valueFlags: Set<string>): string | null {
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) return t;
    // -X=val / --key=val are self-contained
    if (t.includes("=")) { i++; continue; }
    // Known value-taking flag → skip the value too
    if (valueFlags.has(t)) { i += 2; continue; }
    // Bare flag, single or grouped (e.g. `-q`)
    i++;
  }
  return null;
}

/** Always-mutating git subcommands. */
const GIT_HARD_MUTATING = new Set([
  "commit", "push", "pull", "merge", "checkout", "switch", "reset", "rebase",
  "add", "cherry-pick", "revert", "clean", "am", "apply",
  "init", "clone", "submodule", "worktree",
  "gc", "prune", "repack", "filter-branch", "replace", "notes",
  "update-ref", "update-index", "rerere", "bisect",
]);

/**
 * Conditional git subcommands — bare form is read-only, but specific
 * subactions / flags make them mutating. Returns true if THIS specific
 * invocation is mutating.
 */
function isMutatingGitConditional(subcmd: string, tail: string[]): boolean {
  const subactions = (verbs: string[]) => tail.some((t) => verbs.includes(t));
  switch (subcmd) {
    case "fetch":
      // Allow --dry-run; everything else writes refs.
      return !tail.includes("--dry-run");
    case "stash": {
      // Bare `git stash` defaults to `git stash push` — mutating.
      // Read-only forms: list, show, help.
      const first = tail.find((t) => !t.startsWith("-"));
      if (!first) return true;
      return !["list", "show", "help"].includes(first);
    }
    case "remote":
      // `git remote`, `git remote -v`, `git remote show`, `git remote get-url`
      // are read-only. Mutating: add/remove/rm/set-url/rename/prune/update.
      if (tail.length === 0) return false;
      const action = tail.find((t) => !t.startsWith("-"));
      if (!action) return false;  // `git remote -v`
      return ["add", "remove", "rm", "set-url", "rename", "prune", "update"].includes(action);
    case "tag":
      // Mutating flags only — bare `git tag` is a list.
      return tail.some((t) => /^-(d|D|a|s|m|f)$/.test(t)) || tail.includes("--delete") || tail.includes("--force");
    case "branch":
      // Mutating: -d/-D/-m/-c/--move/--copy/--delete/--force.
      return tail.some((t) => /^-(d|D|m|c|f)$/.test(t)) || tail.some((t) => ["--delete", "--move", "--copy", "--force"].includes(t));
    case "config":
      // Reads: --get / --list / --get-all / --get-regexp. Anything
      // else (set/unset/add) writes config.
      const reads = ["--get", "--list", "-l", "--get-all", "--get-regexp", "--show-origin", "--show-scope"];
      if (tail.some((t) => reads.includes(t))) return false;
      // Bare `git config foo.bar value` is mutating; bare `git config foo.bar` is a read.
      const nonFlag = tail.filter((t) => !t.startsWith("-"));
      return nonFlag.length >= 2;
    default:
      return false;
  }
}

const NPM_MUTATING_SUBCOMMANDS = new Set([
  "install", "i", "add", "ci", "update", "upgrade", "remove", "uninstall",
  "rm", "un", "publish", "exec", "x", "run", "run-script", "start", "test",
  "init", "set", "unset", "config",
]);

/** Tools whose subcommand/arg set we inspect explicitly. The git
 *  entry has `null` mutating because git uses a conditional check
 *  (see `isMutatingGitConditional`). */
const SUBCOMMAND_AWARE_TOOLS: Record<string, { valueFlags: Set<string>; mutating: Set<string> | null }> = {
  git:  { valueFlags: GIT_VALUE_FLAGS, mutating: null },
  npm:  { valueFlags: NPM_VALUE_FLAGS, mutating: NPM_MUTATING_SUBCOMMANDS },
  bun:  { valueFlags: NPM_VALUE_FLAGS, mutating: NPM_MUTATING_SUBCOMMANDS },
  pnpm: { valueFlags: NPM_VALUE_FLAGS, mutating: NPM_MUTATING_SUBCOMMANDS },
  yarn: { valueFlags: NPM_VALUE_FLAGS, mutating: NPM_MUTATING_SUBCOMMANDS },
  pip:  { valueFlags: PIP_VALUE_FLAGS, mutating: new Set(["install", "uninstall", "wheel", "download"]) },
  pip3: { valueFlags: PIP_VALUE_FLAGS, mutating: new Set(["install", "uninstall", "wheel", "download"]) },
  cargo:{ valueFlags: new Set(["--manifest-path", "--target-dir"]), mutating: new Set(["install", "uninstall", "publish", "build", "run", "fetch", "update", "clean", "fix", "package"]) },
};

/** Allowlisted tools that are read-only by default but have specific
 *  flags that turn them destructive. Caught by walking tokens. */
const FLAG_DENY_FOR_TOOL: Record<string, Array<RegExp | string>> = {
  // -delete / -exec / -execdir / -ok / -okdir all run side-effecting actions.
  find: ["-delete", /^-execdir?$/, /^-ok(dir)?$/, /^-fprint/],
  // -o outfile / --output=outfile / --output outfile writes the
  // sorted result somewhere.
  sort: ["-o", /^--output(=.*)?$/],
  // -i / --in-place handled in deny patterns above; -e/-f reads expressions
  // but sed/awk are tricky — keep the existing in-place deny pattern as truth.
};

/** Inspect a single segment against the per-tool subcommand rules.
 *  Returns true iff the segment is rejected. */
function segmentHasMutatingSubcommand(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;

  // Skip leading VAR=val assignments and `env` prefix in the token
  // stream — `leadingCommand` already does this string-form, but we
  // need the corresponding token index here.
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=\S+$/.test(tokens[i]!)) i++;
  if (i < tokens.length && tokens[i] === "env") {
    i++;
    while (i < tokens.length && (tokens[i] === "-i" || tokens[i] === "-u" || /^[A-Z_][A-Z0-9_]*=\S+$/.test(tokens[i]!))) {
      // -u takes a name argument
      if (tokens[i] === "-u" && i + 1 < tokens.length) i += 2;
      else i++;
    }
  }
  const cmd = tokens[i];
  if (!cmd) return false;

  // Subcommand-aware tools (git, npm, pip, cargo, ...)
  const rule = SUBCOMMAND_AWARE_TOOLS[cmd];
  if (rule) {
    const sub = extractSubcommand(tokens, i + 1, rule.valueFlags);
    if (!sub) return false;          // bare `git`, `npm` (version-y)
    const subIdx = tokens.indexOf(sub, i + 1);
    const tail = subIdx >= 0 ? tokens.slice(subIdx + 1) : [];
    if (cmd === "git") {
      if (GIT_HARD_MUTATING.has(sub)) return true;
      return isMutatingGitConditional(sub, tail);
    }
    if (rule.mutating && rule.mutating.has(sub)) return true;
    return false;
  }

  // Flag-deny tools (find, sort, ...)
  const flagDeny = FLAG_DENY_FOR_TOOL[cmd];
  if (flagDeny) {
    const tail = tokens.slice(i + 1);
    for (const tok of tail) {
      for (const rule of flagDeny) {
        if (typeof rule === "string" ? tok === rule : rule.test(tok)) return true;
      }
    }
  }
  return false;
}

export function isReadOnlyBashCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;

  // Step 1: deny patterns scan the full command.
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(normalized)) return false;
  }

  // Step 2: each pipe / && / || / ; segment must have its leading
  // command word in the allowlist AND must not invoke a mutating
  // subcommand / flag of a subcommand-aware tool.
  const segments = splitSegments(normalized);
  for (const seg of segments) {
    const head = leadingCommand(seg);
    if (!ALLOW_FIRST_WORDS.has(head)) return false;
    if (segmentHasMutatingSubcommand(seg)) return false;
  }
  return true;
}
