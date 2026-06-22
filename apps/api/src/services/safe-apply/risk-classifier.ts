/**
 * Spec §1 — risk classification for the sandbox
 * escalation protocol's decision pipeline.
 *
 *   LOW       read-only tools (read_file, list_dir, grep, time_now,
 *             web_search). Never sandboxed, never approval-gated.
 *
 *   MEDIUM    write tools bounded to writable_roots, bash with the
 *             default sandbox_permissions. Sandboxed (bwrap), no
 *             approval. The everyday execution path.
 *
 *   HIGH      bash with `sandbox_permissions: "require_escalated"`,
 *             write_file outside writable_roots, spawn_teammate,
 *             untrusted MCP tool calls. Routed through
 *             command_approval_rules → request_approval if no rule
 *             matches.
 *
 *   CRITICAL  bash matching lethal patterns (rm -rf /, mkfs,
 *             dd of=/dev/, fork bomb, chmod -R 777 /). HARD-BLOCKED
 *             — escalation cannot override. UI shows a large red
 *             warning telling the user to run manually in a terminal
 *             if they genuinely need it.
 *
 * V1 implements bash classification (the dominant case). write_file
 * path-glob risk + MCP risk integration land in V2 per spec §1.13.
 */
import { hasSensitiveInternalPath } from "./sensitive-internal-paths";

export type RiskClass = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const LOW_RISK_TOOLS = new Set<string>([
  "read_file",
  "list_dir",
  "grep",
  "time_now",
  "web_search",
  "web_fetch",       // read-only too: outbound HTTP only, no side effects
  "repo_structure",
  "mcp_list_resources",
  "mcp_read_resource",
]);

/**
 * Lethal pattern regex list. Curated for high-confidence catastrophic
 * commands — false positives here are MORE dangerous than false
 * negatives (a CRITICAL hard-block on a legitimate command can be
 * worked around by running manually, but a missed lethal command
 * crashes the host). Update via PR review only.
 */
// Argv-prefix shape for `rm -[rRf]+` plus any number of additional
// option tokens before the target. Catches `rm -rf /`,
// `rm -rf --no-preserve-root /`, `rm -rf -- /`, `rm -rf --some-flag /`.
const RM_RF_OPTS = String.raw`rm\s+(?:-[rRf]+\b|--no-preserve-root|--\b)(?:\s+(?:-[\w-]+|--[\w-]+))*\s+`;
// Block-device families. Linux: sd[a-z], nvme*, hd[a-z], vd[a-z]
// (virtio), mmcblk[0-9]+ (eMMC/SD), xvd[a-z] (Xen), loop*, dm-*,
// md[0-9]+. Token-anchored (after `/dev/`).
const BLOCK_DEV = String.raw`(?:sd[a-z]|nvme\w+|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d+|loop\d*|dm-\d+|md\d+|disk)`;

const LETHAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // rm -rf / (and similar attempts to nuke the filesystem root) —
  // broadened (codex review #1) to allow option tokens like
  // `--no-preserve-root`, `--`, or arbitrary additional flags
  // between `-rf` and the target.
  { pattern: new RegExp(String.raw`\b${RM_RF_OPTS}\/(\s|$)`), label: "rm -rf /" },
  { pattern: new RegExp(String.raw`\b${RM_RF_OPTS}\/\*(\s|$)`), label: "rm -rf /*" },
  { pattern: new RegExp(String.raw`\b${RM_RF_OPTS}~(\s|$)`), label: "rm -rf ~" },
  { pattern: new RegExp(String.raw`\b${RM_RF_OPTS}\$HOME(\s|$)`), label: "rm -rf $HOME" },
  // Root deletion the short-flag patterns above miss: long-form flags
  // (`rm --recursive --force /`) and slash/quote variants (`rm -rf //`,
  // `rm -rf /.`, `rm -rf "/"`). Requires a recursive flag (lookahead) then
  // a filesystem-root target. Won't match normal paths like `rm -rf /home/x`
  // (no space-delimited bare root) or `rm -rf ./` (starts with `.`).
  { pattern: /\brm\s+(?=[^\n]*(?:-[a-zA-Z]*r|--recursive))[^\n]*?\s(["']?)\/+\.?\1(\s|$)/, label: "rm -r /" },
  // Filesystem destruction — mkfs with flags allowed before the
  // device target. Covers `mkfs.ext4 -F /dev/sda1`, `mkfs -t ext4
  // -F /dev/vda`, etc.
  {
    pattern: new RegExp(String.raw`\bmkfs(?:\.\w+)?\s+(?:(?:-[\w-]+|--[\w-]+)(?:\s+\S+)?\s+)*\/dev\/${BLOCK_DEV}`),
    label: "mkfs on /dev device",
  },
  // dd targeting a block device — expanded device list per codex
  // review #1 (vda, mmcblk\d+, xvda, etc.).
  {
    pattern: new RegExp(String.raw`\bdd\s+(?:[^|]*\s)?of=\/dev\/${BLOCK_DEV}`),
    label: "dd to block device",
  },
  // Redirect-overwrite of a block device with no `dd` (`> /dev/sda`,
  // `>> /dev/nvme0n1`). The MEDIUM gate only covers /dev/sd[a-z].
  {
    pattern: new RegExp(String.raw`>{1,2}\s*\/dev\/${BLOCK_DEV}\b`),
    label: "redirect overwrite of block device",
  },
  // Fork bomb (classic + variants)
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
  // chmod any mode on / (recursive or not) — `chmod -R 000 /`,
  // `chmod 777 /`. `\/(\s|$)` requires root exactly, so `chmod 755 /path`
  // is unaffected.
  { pattern: /\bchmod\s+(?:-R\s+)?[0-7]{3,4}\s+\/(\s|$)/, label: "chmod <mode> /" },
  // Shutdown / reboot / halt the host — matched at command position (start,
  // after a `;`/`|`/`&` separator, or via sudo) so a bare `reboot` is caught
  // but `echo reboot` is not. Covers `shutdown -h now`, bare `reboot`,
  // `poweroff`, `halt`, and `init 0`/`init 6`.
  { pattern: /(?:^|[\n;|&]|\bsudo\s+)\s*(?:shutdown|reboot|poweroff|halt)\b/, label: "shutdown/reboot host" },
  { pattern: /(?:^|[\n;|&]|\bsudo\s+)\s*init\s+[06]\b/, label: "init 0/6 (halt/reboot)" },
  // Pipe-to-shell with sudo (curl | sudo sh, etc.)
  { pattern: /(?:curl|wget)\s+[^|]*\|\s*sudo\s+(?:bash|sh|zsh|fish)/, label: "remote script piped to sudo shell" },
];

export type ScoreToolCallInput = {
  toolName: string;
  /** Tool args as the model emitted them. */
  input: Record<string, unknown>;
};

export type ScoreToolCallResult = {
  riskClass: RiskClass;
  /** When CRITICAL: which lethal pattern matched. */
  lethalLabel?: string;
  /** Short reason for telemetry / audit. */
  reason: string;
};

export function scoreToolCall(input: ScoreToolCallInput): ScoreToolCallResult {
  const { toolName, input: args } = input;

  if (LOW_RISK_TOOLS.has(toolName)) {
    return { riskClass: "LOW", reason: "read-only tool" };
  }

  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";

    // CRITICAL — lethal pattern match. Hard-block regardless of
    // escalation request.
    for (const { pattern, label } of LETHAL_PATTERNS) {
      if (pattern.test(command)) {
        return { riskClass: "CRITICAL", lethalLabel: label, reason: `lethal pattern: ${label}` };
      }
    }

    // Sensitive Magister-internal reads (.env, config/secrets.json,
    // .magister, .local) need explicit human approval even when the
    // command is otherwise read-only. Put this before the pure-read
    // LOW shortcut so `cat .env` cannot bypass the approval surface.
    if (hasSensitiveInternalPath(command) && isPureReadOnlyBash(command)) {
      return { riskClass: "HIGH", reason: "sensitive internal path read requires approval" };
    }

    // Pure-read allow-list. A model that over-declares
    // `sandbox_permissions: "require_escalated"` for a benign
    // command like `ss -tlnp` or `git status` was the #1 source of
    // approval-card spam on mobile. We short-circuit to LOW for
    // commands that are demonstrably read-only — no writes, no
    // network egress, no compound shell features that could mask
    // a destructive subcommand. Checked AFTER the lethal pattern
    // filter so a sneaky composition like `ls; rm -rf /` cannot
    // slip through.
    if (isPureReadOnlyBash(command)) {
      return { riskClass: "LOW", reason: "read-only bash command" };
    }

    // HIGH — any escalation mode. Sandbox-elevation v4.3 §4.1: both
    // require_escalated AND with_additional_permissions must trigger
    // the HIGH approval path. Closes the silent-elevation gap where
    // a read-only-looking command (`cat README.md`) with
    // with_additional_permissions could widen the bind list without
    // user approval if classifier only flagged require_escalated.
    if (
      args.sandbox_permissions === "require_escalated"
      || args.sandbox_permissions === "with_additional_permissions"
    ) {
      return {
        riskClass: "HIGH",
        reason: args.sandbox_permissions === "require_escalated"
          ? "model requested escalation"
          : "model requested additional sandbox permissions",
      };
    }

    // MEDIUM — default bash, runs inside sandbox.
    return { riskClass: "MEDIUM", reason: "default sandboxed bash" };
  }

  if (toolName === "spawn_teammate") {
    return { riskClass: "HIGH", reason: "spawn_teammate creates a child runtime" };
  }

  // Conservative default for anything unclassified — write tools,
  // git_commit, git_create_branch, request_human_input, etc. land
  // here. V2 expands per-tool classification.
  return { riskClass: "MEDIUM", reason: "default classification" };
}

/** Exposed so tests + Settings UI can show the full lethal list. */
export function listLethalPatterns(): ReadonlyArray<{ pattern: string; label: string }> {
  return LETHAL_PATTERNS.map(({ pattern, label }) => ({ pattern: pattern.source, label }));
}

/**
 * Heuristic "this command is pure read, no writes, no
 * egress, no shell tricks that could hide a destructive subcommand."
 *
 * Used by scoreToolCall to short-circuit a `bash` call to LOW class
 * even when the model over-declared sandbox_permissions. The classic
 * pain point: a mobile operator getting a flood of approval cards
 * for `ss -tlnp`, `ps aux | grep foo`, `git status`, etc.
 *
 * Rules:
 *   1. Reject if the command contains any shell metacharacter that
 *      could compose untrusted parts: `;`, `&&`, `||`, `>`, `<`,
 *      backtick, `$(`, `${`, newlines. (Pipe `|` is allowed —
 *      see step 3.)
 *   2. Split by `|`. Each piped segment is checked independently.
 *   3. For each segment: strip leading whitespace, look at the FIRST
 *      token, and require it to be on the explicit allow-list. Some
 *      commands have stricter rules (e.g. `find` must not have
 *      `-delete` / `-exec`, `git` must be a read-only subcommand).
 *
 * False-positives (rejected when actually safe) are fine — those
 * just trigger the normal escalation path. False-negatives (passed
 * as LOW when actually destructive) are the danger. The rule set
 * here is deliberately conservative; when in doubt, fall through to
 * the regular gate.
 */
const READ_ONLY_FIRST_TOKENS = new Set([
  // file / disk inspection
  "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df",
  "tree",
  // process / network inspection
  "ps", "ss", "lsof", "netstat", "top", "uptime", "free",
  // user / system identity
  "whoami", "id", "hostname", "pwd", "uname", "date",
  // env
  "env", "printenv",
  // resolve / probe (no execute)
  "which", "type", "command",
  // simple output
  "echo", "printf",
  // search
  "grep", "egrep", "fgrep", "rg",
  // size-bounded download head — full curl is checked separately
  // because curl/wget can both upload and download.
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "remote", "ls-files",
  "blame", "rev-parse", "describe", "tag", "stash", // stash list/show/etc — but stash w/o subarg is also fine since it doesn't drop
  "config", // most config invocations are reads; writes require `--set`/`--add` flags — we check below
  "shortlog", "name-rev", "for-each-ref", "ls-tree",
]);

export function isPureReadOnlyBash(command: string): boolean {
  // Step 1 — quote-aware tokenization. We split by shell-significant
  // characters that are NOT inside single or double quotes, so the
  // grep pattern `':(3000|4173)'` doesn't get mis-split as multiple
  // pipe segments. We track quote state across the string and
  // collect significant characters / segments.
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const segments: string[] = [];
  let buf = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (escaped) {
      escaped = false;
      buf += c;
      continue;
    }
    if (c === "\\" && !inSingle) {
      escaped = true;
      buf += c;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += c;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += c;
      continue;
    }
    // Inside quotes, anything is allowed (the surrounding command
    // can't be affected by metacharacters inside literal strings).
    if (inSingle || inDouble) {
      buf += c;
      continue;
    }
    // Step 1a — forbidden compound constructs outside quotes.
    if (c === ";" || c === "<" || c === ">" || c === "`" || c === "\n") return false;
    if (c === "&" && next === "&") return false;
    if (c === "|" && next === "|") return false;
    if (c === "$" && (next === "(" || next === "{")) return false;
    // Step 1b — pipe is allowed, splits a segment.
    if (c === "|") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (inSingle || inDouble) {
    // Unclosed quotes — refuse to classify (could mask anything).
    return false;
  }
  segments.push(buf);

  const cleanSegments = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleanSegments.length === 0) return false;
  for (const segment of cleanSegments) {
    if (!isReadOnlySegment(segment)) return false;
  }
  return true;
}

function isReadOnlySegment(segment: string): boolean {
  // Tokenize cheaply on whitespace. A genuinely shell-aware
  // tokenizer would handle quotes; here we accept that "cat 'a b'"
  // tokenizes to ["cat", "'a", "b'"] — the first token is still
  // `cat`, which is what matters.
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const head = tokens[0]!;
  const rest = tokens.slice(1);

  // Special-case binaries with sub-rules.
  if (head === "find") {
    // `find` is read-only by default but can become destructive
    // via `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`.
    return !rest.some((t) =>
      t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir",
    );
  }
  if (head === "git") {
    const sub = rest[0];
    if (!sub) return true; // bare `git` just prints help
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    if (sub === "config") {
      // git config without `--set`/`--add`/`--unset`/`--replace-all` is a read.
      const writeFlags = ["--set", "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section"];
      if (rest.some((t) => writeFlags.includes(t))) return false;
    }
    if (sub === "stash") {
      // `git stash` (no subcommand) DROPS — that's a write. Require an explicit read subcommand.
      const subsub = rest[1];
      if (!subsub) return false;
      if (!["list", "show"].includes(subsub)) return false;
    }
    return true;
  }
  if (head === "curl" || head === "wget") {
    // Only allow HEAD-style probes. Anything else might GET large
    // payloads or POST — let it through the normal gate.
    const isHeadOnly = rest.some((t) => t === "-I" || t === "--head");
    return isHeadOnly;
  }

  return READ_ONLY_FIRST_TOKENS.has(head);
}
