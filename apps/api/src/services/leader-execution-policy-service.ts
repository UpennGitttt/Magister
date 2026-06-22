import { isReadOnlyBashCommand } from "./manager-automation/autonomous-loop/plan-mode-bash-classifier";
import { listAvailableRoles } from "./agent-resolution-service";

export type ExecutionPolicyMode =
  | "direct_answer" | "direct_simple" | "ops_direct" | "delegated_coding"
  | "architect_required" | "review_only" | "landing_required" | "direct_override";

export type ExecutionPolicySource =
  | "intake_rules" | "user_override" | "runtime_escalation" | "resume_recovered";

export type ExecutionPolicy = {
  mode: ExecutionPolicyMode;
  source: ExecutionPolicySource;
  reason: string;
  constraints: {
    allowReadTools: boolean;
    allowSpawnTools: boolean;
    allowCodeWriteTools: boolean | "single_file_tiny_patch";
    allowOpsBash: boolean;
    allowGitCommit: boolean;
    mustDelegate: boolean;            // HARD: leader cannot complete directly
    suggestedRoleHint?: string;       // ADVISORY ONLY — never enforced
    requireReviewBeforeDone?: boolean;
    maxDiscoveryToolCallsBeforeWrite?: number;
    maxWriteFiles?: number;           // per-turn cap (direct_simple = 2)
    maxChangedLines?: number;         // per single edit (direct_simple = 30)
  };
  counters: {
    discoveryToolCalls: number;
    writeToolCalls: number;
    writtenPaths: string[];
    codeMutatingBashCalls: number;
    testFailures: number;
    teammateSpawned: boolean;
  };
};

const HIGH_RISK_PATTERNS: RegExp[] = [
  /apps\/api\/src\/services\/manager-automation\/autonomous-loop\//,
  /apps\/api\/src\/services\/manager-automation\/teammate-system-prompts\.ts$/,
  /apps\/api\/src\/services\/manager-automation\/tool-profiles\.ts$/,
  /(permission|sandbox|approval|command-approval|risk-classifier)/i,
  /(runtime-recovery|leader-session-resume|teammate-registry)/i,
  /packages\/db\/src\/(schema|migrations)/,
  /(drizzle|migrations)\//,
  /(auth|secrets|providers|executors|api[_-]?key)/i,
  /config\/(executors|secrets)\.json$/,
  /scripts\/(restart|restart-profile|deploy)/,
];

export function isHighRiskPath(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  return HIGH_RISK_PATTERNS.some((re) => re.test(p));
}

function emptyCounters(): ExecutionPolicy["counters"] {
  return { discoveryToolCalls: 0, writeToolCalls: 0, writtenPaths: [], codeMutatingBashCalls: 0, testFailures: 0, teammateSpawned: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OVERRIDE_RE = /(don'?t delegate|no subagent|do it yourself|leader\s*直接(改|做|处理)|你自己(做|改|来)|不要\s*(用)?\s*subagent|不用委派|别委派)/i;
// ASCII terms need word-boundary anchors; CJK terms do not (no \b in Unicode CJK).
const LANDING_RE = /\b(release|deploy|rollout|rollback|ship it|push (the )?pr|create (a )?pr|open (a )?pr)\b|(发布|上线|部署|发版|合并发布)/i;
const REVIEW_RE = /(review[\s-]?only|audit[\s-]?only|do not modify|don'?t modify|read[\s-]?only|只(读|审|看)|不要(修改|改动)|审查|审核|\breview\b|\baudit\b)/i;
const INVESTIGATE_RE = /(deep[\s-]?dive|investigate (the )?subsystem|architecture|架构|系统调研|深入(分析|调研)|find possible issues|可能(的)?问题|并行扫)/i;
const OPS_RE = /\b(git\s+(status|diff|add|commit|fetch|merge)|restart(\.sh)?|restart-profile|health\s?check|重启|提交|commit)\b/i;
// ASCII alternatives require \b word-boundary anchors; CJK characters are not
// \w so \b never matches adjacent to them — they must be split into separate
// alternation groups without \b. See LANDING_RE above for the same pattern.
const TINY_EDIT_RE =
  // ASCII form: change/update/... <short description> constant/value/...
  // CJK form: trigger and target may appear in either order (e.g. "把超时常量改成 5000"
  //   has target 常量 before trigger 改). Match a 40-char window containing BOTH
  //   a CJK trigger (改|修改|换|设置) AND a CJK target (常量|配置|字符串|文案|这一行|单行).
  //   Implemented as two alternatives (trigger-first and target-first) so the regex
  //   remains anchored without look-aheads (for compatibility and clarity).
  /(change|update|fix|set|rename|tweak)\b.{0,40}\b(constant|value|string|typo|config|one line)\b|(改|修改|换|设置).{0,40}(常量|配置|字符串|文案|这一行|单行)|(常量|配置|字符串|文案|这一行|单行).{0,40}(改|修改|换|设置)/i;
// ASCII code-change verbs (word-bounded) OR CJK code-change verbs (no \b needed)
const CODE_CHANGE_RE = /\b(fix|implement|add|refactor|build|create|wire|migrate)\b|(修复|实现|新增|重构|改造|修改|改一下|实现一下)/i;
// Generic delegation phrases + explicit role tokens. Role NAMES here are only a SEED;
// the authoritative role set is the dynamic `availableRoles` passed in.
const GENERIC_DELEGATE_RE = /\b(subagent|teammate)\b|让\s*([a-z_]+)|叫\s*([a-z_]+)|架构师|并行扫/i;
const SEED_ROLE_RE = /\b(coder|reviewer|architect|lander|evaluator)\b/i;

type ManagerHints = {
  taskType?: "conversation" | "coding" | "mixed" | undefined;
  goal?: string | undefined;
  needsHuman?: boolean | undefined;
  stopCondition?: "reply_sent" | "implementation_ready" | "review_ready" | "landing_ready" | undefined;
  coordinationAction?: "direct_answer" | "tool_answer" | "clarify" | "assign" | "handoff" | "send_message" | undefined;
  childRuns?: Array<{ roleId: string; dependsOn?: string[] | undefined; goal?: string | undefined }> | undefined;
  [key: string]: unknown;
};

/**
 * Apply hints from planner/taskManager hints to tighten the execution policy.
 * INVARIANT: hints may only make the policy STRICTER (raise mustDelegate, lower
 * allowCodeWriteTools). They can NEVER relax a stricter policy, and they have NO
 * effect on direct_override (user override always wins).
 *
 * Modes from strictest (hardest constraint) to most permissive:
 *   landing_required > review_only > architect_required > delegated_coding
 *   > direct_simple > ops_direct > direct_answer > direct_override (immune)
 *
 * Tightening rules (applied after base classification):
 *  - taskType === "coding" + base is direct_answer → bump to delegated_coding
 *  - taskType === "coding" + base is direct_simple → LEAVE IT (tiny edits stay allowed)
 *  - needsHuman === true → ensure mustDelegate: true + allowCodeWriteTools: false
 *  - stopCondition "review_ready" → ensure mustDelegate: true + allowCodeWriteTools: false
 *  - stopCondition "landing_ready" → same (already covered by landing_required, but be safe)
 *  - coordinationAction "assign" or "handoff" → tighten to at least delegated_coding
 */
function applyHintsTightenOnly(
  base: ExecutionPolicy,
  plannerHints: ManagerHints | undefined,
  taskManagerHints: ManagerHints | undefined,
): ExecutionPolicy {
  // direct_override is immune — user explicitly authorized direct work
  if (base.mode === "direct_override") return base;

  const ph = plannerHints;
  const tmh = taskManagerHints;

  const taskType = ph?.taskType ?? tmh?.taskType;
  const needsHuman = ph?.needsHuman ?? tmh?.needsHuman;
  const stopCondition = ph?.stopCondition ?? tmh?.stopCondition;
  const coordinationAction = ph?.coordinationAction ?? tmh?.coordinationAction;

  let policy = base;

  // Rule 1: taskType === "coding" + base is direct_answer → bump to delegated_coding
  // direct_simple intentionally stays (tiny edits are allowed even for coding tasks)
  if (taskType === "coding" && base.mode === "direct_answer") {
    policy = {
      ...policy,
      mode: "delegated_coding",
      source: "intake_rules",
      reason: `${policy.reason} [hint: taskType=coding tightened direct_answer → delegated_coding]`,
      constraints: {
        ...policy.constraints,
        allowCodeWriteTools: false,
        mustDelegate: true,
      },
    };
  }

  // Rule 2: needsHuman === true → tighten to at least review-like (mustDelegate + no code writes)
  if (needsHuman === true && !policy.constraints.mustDelegate) {
    policy = {
      ...policy,
      reason: `${policy.reason} [hint: needsHuman=true tightened to mustDelegate]`,
      constraints: {
        ...policy.constraints,
        allowCodeWriteTools: false,
        mustDelegate: true,
      },
    };
  }

  // Rule 3: stopCondition "review_ready" or "landing_ready" → tighten similarly
  if (
    (stopCondition === "review_ready" || stopCondition === "landing_ready") &&
    !policy.constraints.mustDelegate
  ) {
    policy = {
      ...policy,
      reason: `${policy.reason} [hint: stopCondition=${stopCondition} tightened to mustDelegate]`,
      constraints: {
        ...policy.constraints,
        allowCodeWriteTools: false,
        mustDelegate: true,
      },
    };
  }

  // Rule 4: coordinationAction "assign" or "handoff" → tighten to at least delegated_coding
  if (
    (coordinationAction === "assign" || coordinationAction === "handoff") &&
    !policy.constraints.mustDelegate
  ) {
    policy = {
      ...policy,
      mode: policy.mode === "direct_answer" || policy.mode === "direct_simple" ? "delegated_coding" : policy.mode,
      reason: `${policy.reason} [hint: coordinationAction=${coordinationAction} tightened to mustDelegate]`,
      constraints: {
        ...policy.constraints,
        allowCodeWriteTools: false,
        mustDelegate: true,
      },
    };
  }

  return policy;
}

export function classifyExecutionPolicy(input: {
  prompt: string;
  promptMessages?: unknown[];
  plannerHints?: ManagerHints | undefined;
  taskManagerHints?: ManagerHints | undefined;
  source: string;
  availableRoles: string[];
}): ExecutionPolicy {
  const text = input.prompt ?? "";
  const mk = (mode: ExecutionPolicyMode, source: ExecutionPolicySource, reason: string,
    c: Partial<ExecutionPolicy["constraints"]>): ExecutionPolicy => ({
    mode, source, reason,
    constraints: {
      allowReadTools: true, allowSpawnTools: true, allowCodeWriteTools: false,
      allowOpsBash: false, allowGitCommit: false, mustDelegate: false, ...c,
    },
    counters: emptyCounters(),
  });

  // Detect an explicit role/delegation mention against the DYNAMIC available-role list first,
  // then generic phrases, then seed names. suggestedRoleHint is advisory only.
  const lower = text.toLowerCase();
  // Match role names on WORD BOUNDARIES, not substring containment — otherwise
  // "encoder"/"decoder" would falsely match the role "coder" and over-route the
  // turn to delegated_coding. (\b is ASCII-only; CJK-named custom roles simply
  // won't match here and fall through to the generic/seed delegation phrases.)
  const namedAvailable = input.availableRoles.find(
    (r) => r && new RegExp(`\\b${escapeRegExp(r.toLowerCase())}\\b`).test(lower),
  );
  const genericMatch = text.match(GENERIC_DELEGATE_RE);
  const seedMatch = text.match(SEED_ROLE_RE);
  const roleHint = namedAvailable
    ?? (genericMatch ? (genericMatch[2] || genericMatch[3] || undefined) : undefined)
    ?? (seedMatch ? seedMatch[1]?.toLowerCase() : undefined);
  const hasDelegationMention = Boolean(namedAvailable || genericMatch || seedMatch);

  // 1. explicit override — immune to hint tightening (user override wins)
  if (OVERRIDE_RE.test(text)) {
    return mk("direct_override", "user_override", "User explicitly requested direct leader work.",
      { allowCodeWriteTools: true, allowOpsBash: true, allowGitCommit: true, mustDelegate: false });
  }

  // All other branches go through applyHintsTightenOnly at the end.
  let basePolicy: ExecutionPolicy;
  // 2. review/audit/no-modify
  if (REVIEW_RE.test(text) && !CODE_CHANGE_RE.test(text)) {
    basePolicy = mk("review_only", "intake_rules", "Review/audit/no-modify request.",
      { allowCodeWriteTools: false, mustDelegate: true, requireReviewBeforeDone: true });
  }
  // 3. release/landing work → must route to lander teammate
  else if (LANDING_RE.test(text)) {
    basePolicy = mk("landing_required", "intake_rules",
      "Release/deploy/PR work must be routed to a landing teammate (role is the leader's choice).",
      { allowCodeWriteTools: false, allowOpsBash: false, allowGitCommit: false, mustDelegate: true });
  }
  // 4. explicit role/teammate mention → delegated, hint only
  else if (hasDelegationMention) {
    basePolicy = mk("delegated_coding", "intake_rules", "User named a role/teammate; leader must delegate (role is the leader's choice).",
      { allowCodeWriteTools: false, mustDelegate: true, ...(roleHint ? { suggestedRoleHint: roleHint } : {}) });
  }
  // 5. explicit ops command
  else if (OPS_RE.test(text) && !CODE_CHANGE_RE.test(text)) {
    basePolicy = mk("ops_direct", "intake_rules", "Explicit mechanical operator command.",
      { allowOpsBash: true, allowGitCommit: true, mustDelegate: false });
  }
  // 6. architecture/system investigation
  else if (INVESTIGATE_RE.test(text)) {
    basePolicy = mk("architect_required", "intake_rules", "Architecture/subsystem investigation.",
      { allowCodeWriteTools: false, mustDelegate: true });
  }
  // 7. tiny targeted edit → direct_simple
  else if (TINY_EDIT_RE.test(text)) {
    basePolicy = mk("direct_simple", "intake_rules", "Small, well-targeted edit.",
      { allowCodeWriteTools: "single_file_tiny_patch", maxChangedLines: 30, maxWriteFiles: 2,
        maxDiscoveryToolCallsBeforeWrite: 3, mustDelegate: false });
  }
  // 8. any other code-changing request → delegated_coding
  else if (CODE_CHANGE_RE.test(text)) {
    basePolicy = mk("delegated_coding", "intake_rules", "Code-changing request without an exact tiny target.",
      { allowCodeWriteTools: false, mustDelegate: true });
  }
  // 9. otherwise → direct answer
  else {
    basePolicy = mk("direct_answer", "intake_rules", "Conversational / read-only.",
      { allowCodeWriteTools: false, mustDelegate: false });
  }

  return applyHintsTightenOnly(basePolicy, input.plannerHints, input.taskManagerHints);
}

export function buildSystemPromptWithPolicy(base: string, policy: ExecutionPolicy, availableRoles: string[]): string {
  return `${base}\n\n${buildExecutionPolicyPrompt(policy, availableRoles)}`;
}

export function buildExecutionPolicyPrompt(policy: ExecutionPolicy, availableRoles: string[]): string {
  const lines: string[] = ["## Execution policy for this turn", "", `Mode: ${policy.mode}`, `Reason: ${policy.reason}`, ""];
  if (policy.mode === "review_only") {
    lines.push("This task is READ-ONLY. Do not mutate files or perform/delegate implementation work.");
    lines.push("You MAY use read/grep/list tools, synthesize the review yourself, and spawn investigation/review teammates (you choose the role) if deeper analysis is needed.");
  } else if (policy.constraints.mustDelegate) {
    lines.push("This task must be DELEGATED — do not implement, review, or investigate it directly.");
    lines.push("Choose the best-fit teammate yourself from the roles available to you" +
      (availableRoles.length ? ` (${availableRoles.join(", ")})` : "") + " and spawn it with a bounded capsule.");
    if (policy.constraints.suggestedRoleHint) {
      lines.push(`(Hint only — a role like "${policy.constraints.suggestedRoleHint}" may fit, but you decide.)`);
    }
  } else if (policy.mode === "direct_simple") {
    lines.push("You may do this directly, bounded by:");
    lines.push(`- at most ${policy.constraints.maxChangedLines ?? 30} changed lines per edit`);
    lines.push(`- at most ${policy.constraints.maxWriteFiles ?? 2} files this turn`);
    lines.push("- no high-risk paths (agent loop, migrations, secrets, restart scripts)");
    lines.push("Escalate by delegating if scope grows, tests fail, or a high-risk path is involved.");
  } else if (policy.mode === "ops_direct") {
    lines.push("You may run the explicit mechanical operation directly (commit/restart/status). Release/PR/push/deploy must be delegated.");
  } else if (policy.mode === "direct_override") {
    lines.push("User explicitly authorized direct work. Destructive/secret/critical-path protections still apply.");
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement level (env-flag parsed)
// ─────────────────────────────────────────────────────────────────────────────

export type EnforcementLevel = "off" | "observe" | "review_only" | "delegated_coding" | "strict";

export function getEnforcementLevel(env: Record<string, string | undefined>): EnforcementLevel {
  const v = (env.MAGISTER_LEADER_EXECUTION_POLICY_ENFORCEMENT ?? "").trim();
  return (["off", "observe", "review_only", "delegated_coding", "strict"] as const).includes(v as EnforcementLevel)
    ? (v as EnforcementLevel)
    : "observe";
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff measurement
// ─────────────────────────────────────────────────────────────────────────────

// Tools whose changed-line count we can measure from the tool input.
const MEASURABLE_WRITE_TOOLS = new Set(["edit_file", "write_file"]);
const DISCOVERY_TOOLS = new Set(["read_file", "grep", "list_dir", "repo_structure"]);

export function countChangedLines(toolName: string, input: Record<string, unknown>): number {
  const nonEmpty = (s: unknown) =>
    typeof s === "string" ? s.split("\n").filter((l) => l.trim().length > 0).length : 0;
  if (toolName === "write_file") return nonEmpty(input.content);
  if (toolName === "edit_file") return Math.max(nonEmpty(input.oldString), nonEmpty(input.newString));
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bash mutation classifier
// ─────────────────────────────────────────────────────────────────────────────

const CODE_MUTATING_BASH_PATTERNS: RegExp[] = [
  />>?\s*[^|&;]*\.(ts|tsx|js|json|sh|py|sql)/,
  /\bsed\s+-i\b/,
  /\b(python3?|node|bun)\s+-e\b/,
  /\bgit\s+apply\b/,
  /\bpatch\s+</,
  /--write\b/,
  /\bgit\s+(add|commit|merge)\b/,
  // Generalized heredoc delimiter (not just literal EOF): <<[-~]? optionally quoted delimiter word.
  // Catches: <<'PY', <<"JS", <<-MYEOF, << EOF, etc.  The literal-EOF-only pattern above is replaced
  // by this broader form.
  /<<[-~]?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/,
  // Interpreter stdin mode: `python -`, `node -`, `bun -`, etc. — reads and executes from stdin.
  // Use (\s|$) not \b after `-` because `-` is not a \w char so \b won't match
  // when the next char is a space, `<`, or end-of-string.
  /\b(python3?|node|bun|ruby|perl|deno)\s+-(\s|$)/,
];

export function isCodeMutatingBash(command: string): boolean {
  // NOTE: we intentionally do NOT short-circuit on isReadOnlyBashCommand here.
  // The caller (evaluateToolCallAgainstExecutionPolicy) must check isCodeMutatingBash
  // BEFORE isReadOnlyBashCommand so that interpreter-heredoc/stdin patterns
  // (which are falsely classified "read-only" by isReadOnlyBashCommand because
  // python/node/bun are allowlisted first-words) cannot bypass this check.
  return CODE_MUTATING_BASH_PATTERNS.some((re) => re.test(command));
}

// Verification / safe-ops bash that must pass even in restricted modes.
const VERIFY_OPS_BASH_PATTERNS: RegExp[] = [
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build)\b/,
  /\btsc\b/,
  /\bgit\s+(status|diff|log|fetch)\b/,
  /scripts\/restart(-profile)?\.sh/,
  /\bcurl\b.*\b(health|status)\b/,
];

function isVerifyOrOpsBash(command: string): boolean {
  return VERIFY_OPS_BASH_PATTERNS.some((re) => re.test(command));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call evaluator
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateToolCallAgainstExecutionPolicy(input: {
  policy: ExecutionPolicy;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolIsReadOnly: boolean;
  enforcement: EnforcementLevel;
}): { allow: true } | { allow: false; reason: string; nextAction: string } {
  const { policy, toolName, toolInput, toolIsReadOnly } = input;
  const c = policy.constraints;

  const deny = (reason: string) => ({
    allow: false as const,
    reason,
    nextAction:
      "Spawn the best-fit teammate for this work (choose from your available roles) with a bounded capsule, or use a measurable edit_file/write_file for a tiny change.",
  });

  const unrestricted = policy.mode === "ops_direct" || policy.mode === "direct_override";

  // git_commit: gated by allowGitCommit constraint
  if (toolName === "git_commit") {
    return c.allowGitCommit ? { allow: true } : deny(`git_commit not allowed in mode ${policy.mode}.`);
  }

  // bash: classify by command, not by isReadOnly flag (bash.isReadOnly is always false)
  if (toolName === "bash") {
    const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
    // IMPORTANT: isCodeMutatingBash must be checked BEFORE isReadOnlyBashCommand/isVerifyOrOpsBash.
    // Some interpreters (python, node, bun) are allowlisted as first-word "read-only" commands by
    // isReadOnlyBashCommand, but `python - <<'PY'` and `node - <<'JS'` write files via stdin/heredoc.
    // isCodeMutatingBash wins over the read-only allowlist so these bypass vectors are closed.
    if (!isCodeMutatingBash(cmd) && (isReadOnlyBashCommand(cmd) || isVerifyOrOpsBash(cmd))) return { allow: true };
    if (unrestricted) return { allow: true };
    if (isCodeMutatingBash(cmd)) {
      if (policy.mode === "direct_simple") {
        return deny("direct_simple cannot measure bash diffs — use edit_file/write_file for a tiny change, or delegate.");
      }
      return deny(`Code-mutating bash blocked in mode ${policy.mode}; delegate the implementation.`);
    }
    // Unclassified bash: strict enforcement → deny in restricted modes (allowlist default-deny); otherwise allow.
    if (input.enforcement === "strict") {
      return deny(`Unclassified bash blocked under strict mode ${policy.mode}.`);
    }
    return { allow: true };
  }

  // spawn_teammate / spawn_teammates
  if (toolName === "spawn_teammate" || toolName === "spawn_teammates") {
    return c.allowSpawnTools ? { allow: true } : deny("Spawn not allowed in this mode.");
  }

  // Capability gate for all other tools: read-only → allow unconditionally.
  if (toolIsReadOnly) return { allow: true };

  // Mutating non-bash tool (edit_file, write_file, apply_change_review, …)
  if (c.allowCodeWriteTools === false) {
    return deny(`Direct code write blocked in mode ${policy.mode}; this task must be delegated.`);
  }

  const path = typeof toolInput.path === "string" ? toolInput.path : "";
  if (path && isHighRiskPath(path)) {
    return deny(`High-risk path (${path}) must be delegated even for tiny edits.`);
  }

  if (c.allowCodeWriteTools === "single_file_tiny_patch") {
    if (!MEASURABLE_WRITE_TOOLS.has(toolName)) {
      return deny(`direct_simple allows only measurable edits (edit_file/write_file); delegate ${toolName}.`);
    }
    const lines = countChangedLines(toolName, toolInput);
    if (c.maxChangedLines && lines > c.maxChangedLines) {
      return deny(`Edit is ${lines} lines > direct_simple limit ${c.maxChangedLines}; delegate.`);
    }
    // KNOWN LIMITATION (v1, MEDIUM): counters are updated post-turn (after all tool results drain),
    // not at gate time. Multiple edit_file/write_file calls emitted in a SINGLE assistant turn all
    // see the same pre-turn `writtenPaths` set here, so the ≤2-file budget is not enforced
    // within-turn — a second or third write in the same turn sees the stale counter and passes.
    // Escalation fires on the NEXT turn once counters have been committed.
    // Follow-up: gate-time counter reservation (atomic "claim slot before proceeding") to close this.
    const distinct = new Set([...policy.counters.writtenPaths, ...(path ? [path] : [])]);
    if (c.maxWriteFiles && distinct.size > c.maxWriteFiles) {
      return deny(`Would touch ${distinct.size} files this turn > limit ${c.maxWriteFiles}; delegate.`);
    }
  }

  return { allow: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Counter update after tool execution
// ─────────────────────────────────────────────────────────────────────────────

export function updateExecutionPolicyAfterTool(input: {
  policy: ExecutionPolicy;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolIsReadOnly: boolean;
  toolOutput: unknown;
  isError: boolean;
}): ExecutionPolicy {
  const { policy, toolName, toolInput, toolIsReadOnly, isError } = input;
  const counters = { ...policy.counters, writtenPaths: [...policy.counters.writtenPaths] };

  // Discovery tool tracking
  if (DISCOVERY_TOOLS.has(toolName)) {
    counters.discoveryToolCalls += 1;
  }

  // Mutating non-bash, non-spawn, non-git_commit tool
  const isMutatingNonBash =
    !toolIsReadOnly &&
    toolName !== "bash" &&
    toolName !== "spawn_teammate" &&
    toolName !== "spawn_teammates" &&
    toolName !== "git_commit";
  if (isMutatingNonBash) {
    counters.writeToolCalls += 1;
    const path = typeof toolInput.path === "string" ? toolInput.path : undefined;
    if (path && !counters.writtenPaths.includes(path)) {
      counters.writtenPaths.push(path);
    }
  }

  // Code-mutating bash tracking
  if (toolName === "bash" && typeof toolInput.command === "string" && isCodeMutatingBash(toolInput.command)) {
    counters.codeMutatingBashCalls += 1;
  }

  // Spawn tracking
  if (toolName === "spawn_teammate" || toolName === "spawn_teammates") {
    counters.teammateSpawned = true;
  }

  // Test failure tracking
  if (isError && toolName === "bash" && /\b(test|tsc|typecheck|build)\b/i.test(String(toolInput.command ?? ""))) {
    counters.testFailures += 1;
  }

  return { ...policy, counters };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime escalation helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a new policy escalated from `direct_simple` to `delegated_coding`.
 * Counters are preserved as-is so the gate can see the accumulated writes.
 * The returned policy has `mustDelegate: true` and `allowCodeWriteTools: false`
 * so any subsequent gate evaluation will block further direct writes.
 */
export function escalateToDelegated(policy: ExecutionPolicy, reason: string): ExecutionPolicy {
  return {
    ...policy,
    mode: "delegated_coding",
    source: "runtime_escalation",
    reason,
    constraints: {
      ...policy.constraints,
      mustDelegate: true,
      allowCodeWriteTools: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollout enforcement predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when a deny produced for `mode` should actually BLOCK at the
 * current `enforcement` rollout level.
 *
 * - "off" / "observe" → never block (all modes are observe-only).
 * - "review_only"      → only block review_only + direct_simple violations.
 * - "delegated_coding" → also block delegated_coding + architect_required +
 *                        landing_required violations.
 * - "strict"           → block everything (all modes).
 */
export function modeIsEnforcedAtLevel(mode: ExecutionPolicyMode, enforcement: EnforcementLevel): boolean {
  if (enforcement === "off" || enforcement === "observe") return false;
  if (enforcement === "strict") return true;
  if (enforcement === "review_only") return mode === "review_only" || mode === "direct_simple";
  // enforcement === "delegated_coding"
  return (
    mode === "review_only" ||
    mode === "direct_simple" ||
    mode === "delegated_coding" ||
    mode === "architect_required" ||
    mode === "landing_required"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic role discovery (I/O thin wrapper — the ONE impure function here)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the available role IDs for this installation by delegating to
 * `listAvailableRoles()` in agent-resolution-service.
 *
 * Degrades to `[]` on any error so callers can always safely spread the result
 * into `classifyExecutionPolicy({ availableRoles: ... })`.
 * Errors are swallowed here (listAvailableRoles already logs internally).
 */
export async function resolveAvailableRoles(): Promise<string[]> {
  try {
    return await listAvailableRoles();
  } catch (err) {
    console.warn("[execution-policy] resolveAvailableRoles: unexpected error, degrading to []:", err);
    return [];
  }
}
