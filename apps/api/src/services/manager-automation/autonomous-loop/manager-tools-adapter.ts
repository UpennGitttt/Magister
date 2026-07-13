import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LeaderLoopEvent, LeaderTool, LeaderToolUseContext } from "./autonomous-types";
import { isReadOnlyBashCommand } from "./plan-mode-bash-classifier";
import { executeBashTool } from "../../manager-tools/bash-tool";
import { executeReadFileTool } from "../../manager-tools/read-file-tool";
import { resolveInsideWorkspace, safeReadFile, safeWriteFile } from "../../manager-tools/workspace-path";
import { executeListDirTool } from "../../manager-tools/list-dir-tool";
import { executeGrepRepoTool } from "../../manager-tools/grep-repo-tool";
import { executeWebSearchTool } from "../../manager-tools/web-search-tool";
import { executeWebFetchTool } from "../../manager-tools/web-fetch-tool";
import { executeTimeNowTool } from "../../manager-tools/time-now-tool";
import {
  executeRepoStructureTool,
  formatRepoStructureResult,
} from "../../manager-tools/repo-structure-tool";
import {
  createApproval,
  getDangerReason,
  isDangerousCommand,
  sanitizeCommandPreview,
  waitForApproval,
} from "../../command-approval-service";
import { TaskRepository } from "../../../repositories/task-repository";
import { ConversationBindingRepository } from "../../../repositories/conversation-binding-repository";
import { parseFeishuConfigFromEnv } from "../../../integrations/feishu/feishu-config";
import { createFeishuClient } from "../../../integrations/feishu/feishu-client";
import { RoleRuntimeRepository } from "../../../repositories/role-runtime-repository";
import type { ProviderConfig, ModelProfile, ExecutorBinding } from "../../../providers/types";
import {
  agentConfigModelProfileFields,
  resolveAgentForRole,
  type ResolvedAgentConfig,
} from "../../../services/agent-resolution-service";
import {
  appendAgentSkills,
  getBuiltinSystemPromptWithSkills,
  getTeammateTools,
  TEAMMATE_EXCLUDED_TOOLS,
} from "../teammate-system-prompts";
import { filterToolsByProfile, isValidToolProfileId, PLAN_MODE_TOOLS, type ToolProfileId } from "../tool-profiles";
import { leaderLoop } from "./autonomous-loop-service";
import { createEventProjector } from "../../leader-event-projector";
import { getAgentProfile, isBuiltinAgentRoleId, listAgentProfiles, type AgentProfile } from "../../agent-profile-service";
import { acquireAgentStatus, releaseAgentStatus } from "../../agent-heartbeat-service";
import { spawnCliAgent } from "../../cli-agent-spawn-service";
import { createMemoryLeaderTools } from "../../memory/memory-leader-tools";
import { createWorktree, removeWorktree } from "../../worktree-service";
import { callStreamingApi } from "./streaming-api-caller";
import {
  registerActiveAsyncTeammate,
  unregisterActiveAsyncTeammate,
} from "../async-teammate-registry";
import {
  isSafeApplySideEffectEvidenceCandidate,
} from "../../safe-apply/side-effect-evidence-service";
import {
  buildUcmRuntimeSecurity,
  createRuntimeSafeApplyReviewDraft,
} from "../../safe-apply/runtime-review-draft-service";
import { waitForReviewDecision, recordChangeReviewDecision } from "../../safe-apply/change-review-state-service";
import { ChangeReviewRepository } from "../../../repositories/change-review-repository";
import { applyChangeReview } from "../../safe-apply/apply-gate-service";
import {
  assessExecutionSandbox,
  prepareExecutionSandboxCommand,
  type ExecutionSandboxConfig,
} from "../../safe-apply/execution-sandbox-service";
import { listSensitiveInternalPathMatches } from "../../safe-apply/sensitive-internal-paths";
import type { ExecutionSandboxMetadata } from "../../safe-apply/safe-apply-types";
import {
  createProjectSpec,
  getProjectSpec,
  formatSpecForPrompt,
  parseProjectSpec,
  updateFeatureStatus,
  updateProjectSpec,
} from "../../project-spec-service";

// A synchronous CLI teammate must not be able to freeze the leader turn
// forever. spawnCliAgent supports timeoutMs; wire it with a generous
// default so legitimate long runs survive but a hung child is reaped.
const CLI_TEAMMATE_TIMEOUT_MS = Number(
  process.env.MAGISTER_CLI_TEAMMATE_TIMEOUT_MS ?? 1_800_000,
);

// Sandbox-elevation v4.3 §4.1 — three-tier sandbox_permissions.
//   "default" (deprecated alias for "use_default" kept for one release)
//   "use_default"                 — current default-sandboxed bash
//   "with_additional_permissions" — same sandbox + extra binds from additional_permissions
//   "require_escalated"           — fully bypass sandbox (model needs system-wide access)
const BashInputSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .optional()
    .describe(
      "Override the default 5-minute bash timeout, in milliseconds. Use for legitimate long operations (full test suites, large builds). Capped at 30 minutes — anything longer should be split into multiple bash calls. Omit to inherit the 5-minute default.",
    ),
  sandbox_permissions: z
    .enum(["default", "use_default", "with_additional_permissions", "require_escalated"])
    .default("use_default")
    .describe(
      "Sandbox escalation. `use_default` (the common case): runs inside the bubblewrap sandbox bounded to the current workspace. `with_additional_permissions`: stays sandboxed but widens the bind list with paths in `additional_permissions` — preferred when you need SPECIFIC paths outside the workspace (e.g. uv cache, gitconfig). `require_escalated`: fully bypass the sandbox for system-level ops; needs `justification`. The runtime consults persistent approval rules first; on miss it asks the user. CRITICAL patterns (rm -rf /, fork bomb, mkfs, dd of=/dev/...) are hard-blocked regardless of this field. (`default` is a deprecated alias for `use_default`.)",
    ),
  additional_permissions: z
    .object({
      network: z.object({ enabled: z.boolean().optional() }).strict().optional(),
      file_system: z
        .object({
          read: z.array(z.string().min(1)).max(16).optional(),
          write: z.array(z.string().min(1)).max(16).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      "Required when `sandbox_permissions: \"with_additional_permissions\"`. Specifies the extra bind list as `{ file_system: { read: [\"<abs path>\"], write: [\"<abs path>\"] }, network: { enabled: true } }`. Paths must be absolute, exact (no glob), and the read+write total cannot exceed 16 per request. Examples: `{ file_system: { read: [\"/home/user/.gitconfig\"], write: [\"/home/user/.cache/uv\"] } }`. Paths on the critical deny-list (e.g. /etc/shadow, ~/.ssh/authorized_keys) are refused at validation.",
    ),
  justification: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Short reason (what + why) when `sandbox_permissions` is `with_additional_permissions` or `require_escalated`. Required for those modes; shown verbatim to the user in the approval prompt (sanitized — see spec §4.6) and stored on the persistent rule for audit. Cap 500 chars; keep to one line.",
    ),
  prefix_rule: z
    .array(z.string())
    .optional()
    .describe(
      "Optional argv-prefix tokens. When present alongside `require_escalated` or `with_additional_permissions`, the user can elect to persist this prefix so future matching commands auto-approve. Must have ≥2 tokens and categorize the command, not BE the command. Banned: single-token interpreters (python, bash, sh, node, sudo), single-token destructive verbs (rm, curl, chmod), and shell-eval forms (python -c, bash -c). Good: [\"npm\",\"install\"], [\"git\",\"push\",\"origin\"], [\"docker\",\"build\"]. Commands containing shell metacharacters (|, &&, ;, $(, `, redirects) never match a prefix rule even if the leading tokens align — the user must approve those per-call.",
    ),
});

// Sandbox-elevation v4.3 §4.2 — `request_permissions` standalone tool.
// Lets the model batch a multi-step permission request at the start of
// a task. Granted entries apply to LATER bash calls in the chosen scope
// (turn / task / session) — model doesn't need to re-declare on every
// bash. Returns `{ permissions, scope, strict_auto_review, partial }`
// mirroring codex `request_permissions.rs:56-64`.
const RequestPermissionsInputSchema = z.object({
  permissions: z.object({
    network: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    file_system: z
      .object({
        read: z.array(z.string().min(1)).max(32).optional(),
        write: z.array(z.string().min(1)).max(32).optional(),
      })
      .strict()
      .optional(),
  }).strict(),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Why you need these permissions for the upcoming task. Shown to the user verbatim (sanitized) in the approval card. Keep to one line.",
    ),
});

type LeaderBashSandboxOptions = {
  baseWorkspaceDir: string | null;
  commandResolver?: ExecutionSandboxConfig["commandResolver"];
  env?: NodeJS.ProcessEnv;
  /** Spec §1 V1.1 — opt-in same-workspace sandbox. See
   *  `execution-sandbox-service.ts:ExecutionSandboxCommandInput.allowSameWorkspace`. */
  allowSameWorkspace?: boolean;
};

const LEADER_BASH_SANDBOX_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const ReadFileInputSchema = z.object({
  path: z.string().describe("The file path to read"),
  startLine: z.number().optional().describe("Start line number"),
  endLine: z.number().optional().describe("End line number"),
});

const ListDirInputSchema = z.object({
  path: z.string().optional().describe("The directory path to list"),
});

const GrepRepoInputSchema = z.object({
  query: z.string().describe("The query string to search for"),
  path: z.string().optional().describe("The path to search in"),
});

const WebSearchInputSchema = z.object({
  query: z.string().describe("The search query"),
  maxResults: z.number().optional().describe("Maximum number of results"),
});

const WebFetchInputSchema = z.object({
  url: z.string().describe("The URL to fetch"),
});

const SpawnTeammateInputSchema = z.object({
  role: z
    .string()
    .min(1)
    .describe("Agent role ID — use a builtin (coder/reviewer/architect/lander/evaluator) or a custom agent profile"),
  goal: z
    .string()
    .describe(
      "Natural language task description for the teammate. Images attached to this task " +
        "are AUTOMATICALLY forwarded to the teammate runtime (codex via `-i`, opencode " +
        "via `-f`, claude-code reads them via its Read tool, magister-runtime inherits " +
        "the attachment context) — do NOT describe screenshot contents in this goal; " +
        "reference them by what you want done with them (e.g. \"fix the overflow shown " +
        "in the attached screenshot\").",
    ),
  wait: z.boolean().optional().describe("If false, returns immediately with teammateRunId. Default: true"),
  isolate: z.boolean().optional().describe("If true, create an isolated git worktree for this teammate"),
  resume_id: z
    .string()
    .optional()
    .describe(
      "Optional teammateRunId to RESUME a previous teammate's session — continues with its prior messages, tool history, and design decisions. PREFER resume when revising the SAME teammate's output (bug fix, evaluator FAIL, reviewer must-fix, interrupted run). PREFER fresh spawn for orthogonal work or a different perspective. The `role` must match the original spawn. Mutually exclusive with `isolate: true` (the original worktree is cleaned up after completion). The previous teammate must be in COMPLETED, FAILED, or CANCELLED state. Supported runtimes: Magister (event-checkpointed), codex (`codex exec resume <session>`), claude-code (`claude --resume <session>`), opencode (`opencode run --session <session>`).",
    ),
  expected_output: z
    .string()
    .max(2048, "expected_output capped at 2048 chars — describe the SHAPE of the answer, not its content")
    .optional()
    .describe(
      "Optional one-liner specifying the SHAPE of the answer you want back — e.g. \"a markdown table of files changed with one-sentence rationale per file\", \"PASS/FAIL per acceptance criterion + evidence\", \"5 bullet points, no code blocks\". When set, gets injected into the teammate's seed prompt as a return-format constraint. Anthropic multi-agent research lesson #1: vague briefs cause subagent drift; specifying the output shape is the single highest-leverage anti-drift signal. Skip when the role's system prompt already pins the format (evaluator does this). Hard cap 2048 chars — this is meta-instruction, not content.",
    ),
});

const SpawnTeammatesInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        role: z
          .string()
          .min(1)
          .describe(
            "Agent role ID (coder/reviewer/architect/lander/evaluator or a custom profile)",
          ),
        goal: z
          .string()
          .min(1)
          .describe(
            "Self-contained brief for this teammate — see spawn_teammate goal guidance",
          ),
        isolate: z
          .boolean()
          .optional()
          .describe(
            "Run in an isolated git worktree. Defaults to TRUE for batch spawns so parallel writes never race. Set false only for read-only roles (reviewer/architect/evaluator) sharing the parent workspace.",
          ),
        expected_output: z
          .string()
          .max(2048)
          .optional()
          .describe(
            "Optional SHAPE-of-answer constraint, same semantics as spawn_teammate.expected_output",
          ),
      }),
    )
    .min(1, "tasks must contain at least one task")
    .max(8, "cap of 8 teammates per batch — beyond that, sequence batches across turns"),
});

const SPAWN_TEAMMATES_DESCRIPTION = `Fan out MULTIPLE teammates in ONE deterministic call. PREFER this over emitting several \`spawn_teammate\` blocks when you have 2+ independent subtasks — the runtime creates every teammate, isolates each in its own git worktree by default, and runs them concurrently. You do NOT have to remember to set \`isolate\` per task or to emit parallel tool_use blocks; the backend guarantees the fan-out.

Each task: { role, goal, isolate?, expected_output? }. All tasks run in the background — this call returns immediately with a \`parallel_group_id\` and one \`teammateRunId\` per task. Each teammate's completion is injected as a system message on a later turn (no polling). Wall-clock cost is max(t1..tN), not the sum.

When to use: independent multi-module exploration, parallel review (architect + reviewer over the same change), or any 2–8 orthogonal subtasks. When NOT to use: chained work where teammate B needs teammate A's output — spawn A, see its result, then spawn B (use \`spawn_teammate\` for that). For a single subtask, use \`spawn_teammate\`.

Defaults: \`isolate\` defaults to TRUE per task (override to false only for read-only roles). Briefs follow the same rules as \`spawn_teammate.goal\` — the teammate has zero context; explain what and why, include file paths.`;

const SPAWN_TEAMMATE_DESCRIPTION_PREFIX = `Delegate implementation work to a teammate. The teammate runs in a fresh context window with its own role-specific system prompt, then returns a final answer to you. Use this to:

- Keep your own context clean for orchestration / decision-making
- Apply role-specific expertise to subproblems
- Run independent verification or review

If the \`magister-delegating\` skill is attached and you need role-picking nuance, you may load it; do not delay an obvious \`spawn_teammate\` call just to load a skill.

Builtin roles (use these as the \`role\` argument). Each entry follows the same shape: what it does → when to spawn it → what to pass it → what it returns.

- \`coder\`: Implements code changes end-to-end — writes/edits files, runs tests, iterates until tests pass. **Spawn when**: a change touches 2+ files, exceeds ~50 lines, or spans both frontend+backend (new features, refactors, multi-file bug fixes). **Pass**: the user's original ask verbatim, any files/dirs you've already located, and constraints (test framework, conventions to follow, paths to avoid). **Returns**: a summary of what was changed + test status. After it returns, run one \`git diff\` or \`read_file\` to confirm — the summary describes intent, not necessarily what landed.
- \`reviewer\`: Reviews completed code for bugs, design issues, edge cases, and security. Read-only — does NOT modify code. **Spawn when**: a change is done and BEFORE handing back to the user, AND any of: ≥50 lines, 2+ files, or auth/security/payments-touching (regardless of size — a 20-line auth tweak still warrants review). **Pass**: the user's original goal, the files changed, and the approach taken (whether by you directly or by a coder). **Returns**: ranked findings (must-fix vs nice-to-have). Apply fixes yourself with \`edit_file\` for one-liners, or spawn another \`coder\` for the must-fixes.
- \`architect\`: Designs implementation approach OR investigates root cause across the codebase — surveys existing patterns, lists trade-offs, identifies critical files. Read-only, no code changes. **Spawn when**: (a) forward design — the user's request is ambiguous, touches 3+ subsystems, or introduces a new module, OR (b) backward investigation — you need a structured root-cause sweep across multiple files (e.g. "why does X crash"), beyond what one or two direct \`read_file\`/\`grep\` calls would settle. **Pass**: the user's goal or the symptom to investigate, what you've already learned, and the specific questions to answer. **Returns**: a step-by-step plan or root-cause analysis with file paths and trade-offs. Feed forward-design output into a \`coder\` spawn next.
- \`lander\`: Creates the commit / branch / PR for completed work. **Spawn when**: the change is verified and ready to ship — never for WIP, landing partial work pollutes git history. (For non-trivial changes this typically follows reviewer; for trivial leader-only edits, you can spawn directly.) **Pass**: the branch name (or "create one"), the commit message scope, and any PR fields (title, summary bullets, test plan). **Returns**: commit SHA / branch name / PR URL.
- \`evaluator\`: Independently verifies completed work against acceptance criteria — strict, adversarial, runs the actual feature rather than reading code. **Spawn when**: a feature is claimed done and you need a final pass/fail before reporting to user, especially for user-facing flows or anything claimed "fixed". **Pass**: the user's original acceptance criteria verbatim, the list of files changed, and any reproduction steps the user gave. **Returns**: per-criterion PASS/FAIL with evidence (commands run + output). Treat FAIL as authoritative — fix and re-run, do not rationalize.
- \`deepresearcher\`: Conducts multi-step web research and produces structured analytical reports with cited evidence. **Spawn when**: you need to understand an external domain, evaluate a technology, compare alternatives, or gather context before making a design decision — anything that requires more than one web search. **Pass**: the research question, what you already know, which aspects matter most for the decision at hand, and any preferred source types (official docs, academic papers, community discussions). **Returns**: a structured report with findings, sources table, and confidence assessment.`;

const SPAWN_TEAMMATE_PICKING_GUIDANCE = `Picking the right role:
- "implement X" / "add feature" / "fix bug" → coder
- "review what was done" / "is this safe" → reviewer
- "how should I structure this" / "design a..." → architect
- "commit and push" / "open a PR" → lander
- "verify the feature works" / "did we hit the acceptance criteria" → evaluator

Delegate **implementation work** (multi-file code changes, refactors, new features, test suites) to teammates. Keep **operational work** (restart services, check status, run queries, clean data) and **quick investigation** (read a few files, check logs, run diagnostics) local — spawning for those is overhead, not value.`;

const SPAWN_TEAMMATE_USAGE_NOTES = `Usage notes:

- **Parallelism — prefer \`spawn_teammates\` for fan-out.** When you have 2+ independent subtasks, call \`spawn_teammates({ tasks: [...] })\` once: the backend creates every teammate, isolates each in its own git worktree by default, and runs them concurrently in the background — you don't have to emit parallel tool_use blocks or remember \`isolate\` per task. (Manual fallback still works: emitting multiple \`spawn_teammate\` blocks in ONE assistant message with \`isolate: true\` on each also fans out — but \`spawn_teammates\` is deterministic and the recommended path.)

  Common mistake: "spawn_teammate is blocking, so I'll spawn one, wait for the result, then spawn the next." That's serial — you've doubled the wall clock. If the subtasks are independent, spawn ALL of them in the current turn before yielding back to the user.

  Worked example — user asks for parallel architect + reviewer review:
  \`\`\`
  // Single assistant message. Two tool_use blocks. Runtime fans out concurrently.
  spawn_teammate({ role: "architect", goal: "...", isolate: true })
  spawn_teammate({ role: "reviewer", goal: "...", isolate: true })
  \`\`\`
  Anti-pattern (DO NOT do this):
  \`\`\`
  Turn 1: spawn_teammate(architect)  // blocks
  ...wait for result...
  Turn 2: spawn_teammate(reviewer)   // blocks again — serial, not parallel
  \`\`\`
- **Sequential when chained**: when one teammate's output informs the next (e.g. coder → reviewer of that coder's change), spawn the second in the FOLLOWING turn after you've seen the first result, not in the same turn.
- **Background**: pass \`wait: false\` to return immediately with a \`teammateRunId\`. **PREFER \`wait: false\` for independent parallel work.** When you have 2-3 tasks that don't depend on each other, issue \`spawn_teammate(wait: false)\` for each in the SAME turn. Each returns a \`teammateRunId\` immediately; their completion will be automatically injected as a system message of the form \`Background teammate {role} ({runId}) completed.\\n\\n<summary>\`, which you'll see as a user message on a later turn — no polling needed, just react when the result arrives. For "spawn → use the result" sequential flows, leave \`wait\` at its default (true).
- **Trust but verify**: a teammate's summary describes what it INTENDED to do, not necessarily what it actually did. When the teammate writes or edits code, check the actual changes (read the file, run \`git diff\`) before reporting the work as done to the user.
- **Don't peek**: do not read the teammate's intermediate tool output. You'll get a final summary; reading transcript mid-flight pulls all the teammate's tool noise into your context, which defeats the point of delegating.
- **Resume an earlier teammate**: pass \`resume_id: <teammateRunId>\` to continue a previous teammate's session — keeps its prior messages, tool history, and design decisions. The cost is forward-carried tool noise (every previous \`read_file\` / \`grep\` / \`bash\` lives in the resumed agent's context window), so don't reach for resume by default. The right rule of thumb:

  **Prefer RESUME when:**
  - The same teammate's prior output needs revision — bug fix, reviewer must-fix, evaluator FAIL, or "you did X, please also do Y to it"
  - The follow-up depends on subtle decisions only that teammate saw (which library it chose, how files were laid out, why it skipped some path)
  - A prior run was interrupted (cancelled or exited mid-task) and you want it to pick up where it left off
  - Re-explaining the prior teammate's mental model in a fresh-spawn goal would be longer/lossier than just carrying forward its session

  **Prefer FRESH spawn when:**
  - The work is orthogonal to the prior teammate's work (different module, different concern)
  - The prior run was very long (>30 turns) — resuming bloats the CLI agent's context window further
  - You explicitly want a different perspective (e.g. spawn a fresh \`reviewer\` over a \`coder\`'s output — NEVER resume the coder as a reviewer; the role must match anyway)
  - You're not sure the prior context is useful — fresh is the safe default

  Constraints: the \`role\` must match the original spawn; only COMPLETED, FAILED, or CANCELLED runs can be resumed; \`isolate: true\` is incompatible (the worktree was cleaned up after the prior run finished). Supported for **Magister, codex, claude-code, and opencode** runtimes.`;

const SPAWN_TEAMMATE_PROMPT_GUIDE = `Writing the goal (the \`goal\` argument):

The teammate starts with zero context — it hasn't seen this conversation, doesn't know what you've tried or why it matters. Brief it like a smart colleague who just walked in: state the objective, why it matters, and the few key facts it needs.
- Say what to accomplish AND why; note what you've already learned or ruled out so it doesn't redo your work.
- For lookups: hand over the exact command. For investigations: hand over the question (prescribed steps become dead weight if your premise is wrong).
- If you need a short response, say so ("report in under 200 words").

**Right-size the goal — match its length to the task's real complexity, no more.** A focused goal (objective + the few load-bearing facts + concrete pointers: file:line, ids, paths) is BOTH more reliable to emit AND produces sharper work. Do NOT:
- paste large verbatim context, logs, or whole files — point to them (path / file:line / id) and let the teammate read what it needs itself;
- replay your entire investigation or re-explain things the teammate can discover on its own;
- pad with restatement.
Terse *command-style* goals ("fix the bug") are too thin and produce shallow work; bloated copy-everything goals are unreliable and waste tokens. Aim for the middle: clear and complete, no filler. Most goals need only a normal paragraph or two.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" — that pushes synthesis onto the teammate instead of doing it yourself. Prove you understood: name the file:line and exactly what to do.

**Keep the call bounded.** Put the important content in \`goal\` (the required field); keep \`expected_output\` to a concise one-liner. An over-long call can hit the output token limit mid-emission and get TRUNCATED — which fails the whole call. When in doubt: shorter + pointers beats longer + verbatim.`;

type SpawnDescriptionProfile = Pick<AgentProfile, "roleId" | "description" | "isBuiltin">;
type ToolRestrictionProfile = {
  allowedTools?: string[] | string | null;
  disallowedTools?: string[] | string | null;
};

/**
 * cap synchronous spawn_teammate's
 * final text to 16KB before it lands as the leader's tool_result.
 * Beyond that the leader is told (in the trailer) which tool to call
 * for the full transcript. Without this cap a long teammate run can
 * blow the leader's context window with a single tool_result.
 */
const LEADER_TEAMMATE_TEXT_CAP = 16_000;

function capLeaderTeammateText(
  finalText: string,
  parentToolUseId: string | undefined,
  roleId: string,
  taskId: string,
): string {
  if (!finalText) return "";
  if (finalText.length <= LEADER_TEAMMATE_TEXT_CAP) return finalText;
  const head = finalText.slice(0, LEADER_TEAMMATE_TEXT_CAP);
  const original = finalText.length;
  const recoveryHint = parentToolUseId
    ? ` Call read_teammate_transcript(taskId="${taskId}", parentToolUseId="${parentToolUseId}") for the full text.`
    : "";
  return `${head}\n\n[truncated: ${roleId}'s response was ${original} chars; showing first ${LEADER_TEAMMATE_TEXT_CAP}.${recoveryHint}]`;
}

function buildLeaderBashSandboxEnv(input: {
  homeDir: string;
  tmpDir: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.env ?? process.env;
  const env: Record<string, string> = {};
  for (const key of LEADER_BASH_SANDBOX_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.HOME = input.homeDir;
  env.TMPDIR = input.tmpDir;
  env.TMP = input.tmpDir;
  env.TEMP = input.tmpDir;
  return env;
}

function executionSandboxResult(input: {
  exitCode: number;
  stdout?: string;
  stderr: string;
  executionSandbox: ExecutionSandboxMetadata | null;
}) {
  return {
    exitCode: input.exitCode,
    stdout: input.stdout ?? "",
    stderr: input.stderr,
    ...(input.executionSandbox ? { executionSandbox: input.executionSandbox } : {}),
  };
}

async function executeLeaderBashTool(input: {
  workspaceDir: string;
  command: string;
  signal?: AbortSignal;
  sandbox?: LeaderBashSandboxOptions;
  // Sandbox-elevation v4.3 §4.4 — model-requested or trust-granted
  // additional binds. Passed through to the sandbox builder for
  // bind-time canonicalize + classify defense in depth.
  extraBinds?: ReadonlyArray<{ path: string; access: "read" | "write" }>;
  allowNetwork?: boolean;
  classifyOptions?: import("../../safe-apply/path-sensitivity").ClassifyPathOptions;
  approvedInternalPathRead?: boolean;
}) {
  const baseWorkspaceDir = input.sandbox?.baseWorkspaceDir ?? null;
  if (!baseWorkspaceDir) {
    return await executeBashTool({
      workspaceDir: input.workspaceDir,
      command: input.command,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.approvedInternalPathRead ? { approvedInternalPathRead: true } : {}),
    });
  }

  const runtimeHomeDir = await mkdtemp(join(tmpdir(), "magister-leader-bash-home-"));
  const runtimeTmpDir = await mkdtemp(join(tmpdir(), "magister-leader-bash-tmp-"));
  try {
    const executionSandbox = await assessExecutionSandbox({
      runtimeSource: "ucm",
      runtimeWorkspaceDir: input.workspaceDir,
      baseWorkspaceDir,
      runtimeHomeDir,
      runtimeTmpDir,
      homeIsolated: true,
      config: {
        ...(input.sandbox?.env ? { env: input.sandbox.env } : {}),
        ...(input.sandbox?.commandResolver
          ? { commandResolver: input.sandbox.commandResolver }
          : {}),
      },
    });

    if (executionSandbox.mode === "off") {
      return await executeBashTool({
        workspaceDir: input.workspaceDir,
        command: input.command,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.approvedInternalPathRead ? { approvedInternalPathRead: true } : {}),
      });
    }

    const env = buildLeaderBashSandboxEnv({
      homeDir: runtimeHomeDir,
      tmpDir: runtimeTmpDir,
      ...(input.sandbox?.env ? { env: input.sandbox.env } : {}),
    });
    const sandboxPlan = prepareExecutionSandboxCommand({
      command: "/bin/bash",
      args: ["-c", input.command],
      cwd: input.workspaceDir,
      env,
      executionSandbox,
      baseWorkspaceDir,
      runtimeWorkspaceDir: input.workspaceDir,
      runtimeHomeDir,
      runtimeTmpDir,
      ...(input.sandbox?.allowSameWorkspace ? { allowSameWorkspace: true } : {}),
      ...(input.extraBinds && input.extraBinds.length > 0 ? { extraBinds: input.extraBinds } : {}),
      ...(input.allowNetwork ? { allowNetwork: true } : {}),
      ...(input.classifyOptions ? { classifyOptions: input.classifyOptions } : {}),
    });

    if (sandboxPlan.type === "failed") {
      return executionSandboxResult({
        exitCode: 1,
        stderr: sandboxPlan.failureReason,
        executionSandbox: sandboxPlan.executionSandbox,
      });
    }

    if (sandboxPlan.type === "wrapped") {
      return await executeBashTool({
        workspaceDir: input.workspaceDir,
        command: input.command,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.approvedInternalPathRead ? { approvedInternalPathRead: true } : {}),
        spawnOverride: {
          command: sandboxPlan.command,
          args: sandboxPlan.args,
          cwd: sandboxPlan.cwd,
          env: sandboxPlan.env,
          executionSandbox: sandboxPlan.executionSandbox,
        },
      });
    }

    const result = await executeBashTool({
      workspaceDir: input.workspaceDir,
      command: input.command,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.approvedInternalPathRead ? { approvedInternalPathRead: true } : {}),
    });
    return sandboxPlan.executionSandbox
      ? { ...result, executionSandbox: sandboxPlan.executionSandbox }
      : result;
  } finally {
    await Promise.allSettled([
      rm(runtimeHomeDir, { recursive: true, force: true }),
      rm(runtimeTmpDir, { recursive: true, force: true }),
    ]);
  }
}

function parseToolRestrictionList(value: string[] | string | null | undefined): Set<string> | null {
  if (Array.isArray(value)) {
    const items = value.map((item) => item.trim()).filter((item) => item.length > 0);
    return items.length > 0 ? new Set(items) : null;
  }

  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const items = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return items.length > 0 ? new Set(items) : null;
  } catch {
    return null;
  }
}

export function composeSpawnTeammateDescription(profiles: readonly SpawnDescriptionProfile[]): string {
  const customProfiles = profiles.filter((profile) => {
    if ((profile.isBuiltin ?? 0) === 1) {
      return false;
    }
    return !isBuiltinAgentRoleId(profile.roleId);
  });
  const customSection = customProfiles.length > 0
    ? `\n\nCustom roles (configured in this workspace):\n${customProfiles
      .map((profile) => {
        const description = profile.description?.trim() || "(no description provided)";
        return `- \`${profile.roleId}\`: ${description}`;
      })
      .join("\n")}`
    : "";

  return [
    `${SPAWN_TEAMMATE_DESCRIPTION_PREFIX}${customSection}`,
    SPAWN_TEAMMATE_PICKING_GUIDANCE,
    SPAWN_TEAMMATE_USAGE_NOTES,
    SPAWN_TEAMMATE_PROMPT_GUIDE,
  ].join("\n\n");
}

const SPAWN_TEAMMATE_DESCRIPTION = composeSpawnTeammateDescription([]);

export function applyPerAgentToolRestrictions(
  tools: readonly LeaderTool[],
  profile: ToolRestrictionProfile | null,
  opts?: { enforceTeammateInvariants?: boolean },
): LeaderTool[] {
  let result = [...tools];
  if (profile) {
    const allowed = parseToolRestrictionList(profile.allowedTools);
    const denied = parseToolRestrictionList(profile.disallowedTools);

    if (allowed && allowed.size > 0) {
      result = result.filter((tool) => allowed.has(tool.name));
    }
    if (denied && denied.size > 0) {
      result = result.filter((tool) => !denied.has(tool.name));
    }
  }

  if (opts?.enforceTeammateInvariants === true) {
    const excluded = new Set([...TEAMMATE_EXCLUDED_TOOLS, ...PLAN_MODE_TOOLS]);
    result = result.filter((tool) => !excluded.has(tool.name));
  }

  return result;
}

const RequestHumanInputInputSchema = z.object({
  question: z.string().describe("The question to ask the human"),
  context: z.string().optional().describe("Additional context for the question"),
  timeoutSeconds: z.number().optional().describe("Timeout in seconds for response"),
});

const TodoStatusEnum = z.enum(["pending", "in_progress", "completed", "cancelled"]);
const TodoPriorityEnum = z.enum(["high", "medium", "low"]);

const TodoItemSchema = z.object({
  content: z.string().min(1).describe("Imperative description of the task, e.g. 'Run tests'"),
  activeForm: z.string().min(1).describe("Present-continuous form shown while in_progress, e.g. 'Running tests'. Required so the UI can render the active item with its gerund label."),
  status: TodoStatusEnum.describe("pending | in_progress | completed | cancelled"),
  priority: TodoPriorityEnum.optional().describe("Optional priority hint: high | medium | low"),
});

const UpdatePlanInputSchema = z.object({
  todos: z.array(TodoItemSchema).describe("The COMPLETE updated todo list — pass the whole list every call, not a delta. The runtime replaces the previous snapshot atomically."),
});

const UPDATE_PLAN_DESCRIPTION = `Maintain a structured todo list for this session so the user sees concrete progress and you don't lose track across many tool calls. The list renders inline in chat as a checkable list (□ pending, ▶ in_progress, ✔ completed, ⊘ cancelled) and updates every time you call this tool.

## When to use

ONLY for genuinely multi-step work — the bar is **3+ distinct steps** OR a task explicitly composed of multiple deliverables. Examples that warrant it:
- "Add a dark mode toggle" → component + state + styles + tests + build
- "Rename getCwd to getCurrentWorkingDirectory across the project" → one item per file after grep
- "Implement these features: registration, catalog, cart, checkout" → one item per feature
- Any spawn_teammate fan-out with 2+ teammates → one item per teammate

## When NOT to use

Skip the tool entirely for:
- Single-step requests ("read this file", "run npm install", "what does git status do")
- Trivial fixes that fit in one or two tool calls (typo fix, single-line edit, one-off lookup)
- Pure conversation / Q&A
- Tasks already covered by a teammate spawn (don't duplicate the teammate's internal todos at the leader level)

If you're not sure, default to **not using it**. A pointless 2-item todo list is noise; a real 5-item one is the user's progress dashboard.

## Hard rules (the runtime enforces #1 and #2)

1. **Exactly ONE item in_progress at any time.** Mark in_progress BEFORE starting work, mark completed IMMEDIATELY after finishing — never batch completions.
2. **\`activeForm\` is required for any in_progress item.** Use the gerund form ("Running tests", not "Run tests").
3. Pass the COMPLETE list every call. The runtime replaces the previous snapshot — there is no merge.
4. Feel free to revise (add/remove/reorder/cancel) items as you learn more. A stale plan is worse than a rewritten one. Use \`cancelled\` (not deletion) when an item becomes irrelevant — preserves the audit trail.
5. Never mark an item completed if its work is partial, blocked, or its tests are failing. Keep it in_progress and add a follow-up item describing the blocker.

When in doubt about whether an item is done: it isn't. Verify, then mark.`;

const CreateProjectSpecInputSchema = z.object({
  spec: z.string(),
});

const UpdateProjectSpecInputSchema = z.object({
  featureId: z.string(),
  status: z.enum(["pending", "in_progress", "implemented", "verified", "failed"]),
  result: z.string().optional(),
});

const GitCommitInputSchema = z.object({
  message: z.string().describe("Commit message"),
  files: z.array(z.string()).optional().describe("Specific files to stage, or omit to stage all changes"),
});

const GitCreateBranchInputSchema = z.object({
  branchName: z.string().describe("Branch name to create"),
  fromBranch: z.string().optional().describe("Base branch (default: current)"),
});

const WriteFileInputSchema = z.object({
  path: z.string().describe("The file path to write"),
  content: z.string().describe("The content to write to the file"),
  createDirs: z.boolean().optional().describe("Create parent directories if they don't exist"),
});

const EditFileInputSchema = z.object({
  path: z.string().describe("The file path to edit"),
  oldString: z.string().describe("The string to replace"),
  newString: z.string().describe("The replacement string"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences"),
});

/** 2026-05-12 phase 7 — structured evaluator verdict tool.
 *
 *  Replaces the text-protocol parse ("Overall verdict: READY|BLOCKED")
 *  with a typed tool call. Evaluator (any teammate role, but
 *  realistically only "evaluator" is going to be told to call it)
 *  invokes this once at the end of its run. We atomically write to
 *  `tasks.goal_last_verifier_*` + an execution_events row so the
 *  leader's `mark_goal_complete` sees a fresh structured verdict.
 *
 *  Why a tool, not a side-effect of finishing text:
 *    - Schema validation catches malformed verdicts at the call site
 *      (vs. silent text-regex misses that read like "BLOCKED" but
 *      never matched our pattern).
 *    - The evaluator's intent ("I am done verifying, here is my
 *      verdict") is explicit, not inferred.
 *    - Confidence + per-criterion breakdown is forced into a
 *      structured shape we can render in the dashboard.
 *
 *  The text-protocol parse remains as a fallback (see
 *  maybeRecordEvaluatorVerdict below) so an older evaluator system
 *  prompt or a model that "forgets" to call the tool still gets
 *  classified instead of silently dropping the verdict.
 *
 *  This is a kimi-K2.6-endorsed minimal change to Magister goal mode —
 *  decoupling text fragility from verdict authority. The broader
 *  retrieval-tools / mandatory-state-header debate is parked
 *  pending real-run drift observation. */
function buildSubmitGoalVerdictTool(): LeaderTool {
  return {
    name: "submit_goal_verdict",
    description:
      "Submit the structured result of evaluating a goal's acceptance criteria. "
      + "Call this ONCE at the end of an evaluator run on a goal-mode task — it "
      + "atomically records the verdict on the parent task so the leader's "
      + "`mark_goal_complete` can gate on it. `verdict: \"ready\"` means all "
      + "criteria PASS and the goal can terminate. `verdict: \"blocked\"` means "
      + "at least one criterion failed; provide a 1-line `blocker` so the next "
      + "iteration's continuation can surface it. `checked_criteria` is your "
      + "per-criterion PASS/FAIL list (kept for audit + dashboard). "
      + "`confidence` reflects how sure you are — \"low\" tells the leader to "
      + "treat the verdict as advisory rather than authoritative.",
    inputSchema: z.object({
      verdict: z.enum(["ready", "blocked"]),
      blocker: z.string().nullable().optional(),
      checked_criteria: z
        .array(
          z.object({
            criterion: z.string(),
            status: z.enum(["pass", "fail"]),
            evidence: z.string(),
          }),
        )
        .optional(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isPlanSafe: () => true,
    call: async (args, context) => {
      const { TaskRepository } = await import("../../../repositories/task-repository");
      const task = await new TaskRepository().getById(context.taskId);
      if (!task?.goalObjective) {
        return { data: "No active goal on this task; submit_goal_verdict is a no-op." };
      }
      // verdict="blocked" without a blocker reason is suspicious —
      // reject so the model has to actually say why.
      if (args.verdict === "blocked" && (!args.blocker || args.blocker.trim().length === 0)) {
        return {
          data:
            "Refused: verdict=\"blocked\" requires a non-empty `blocker` field "
            + "explaining which criterion failed and why. Retry with a 1-line summary.",
        };
      }
      const { recordVerdict } = await import("../../goal-mode/evaluator-verifier-service");
      const verdictForStore = args.verdict === "ready"
        ? { verdict: "READY" as const, blockerReason: null }
        : {
            verdict: "BLOCKED" as const,
            blockerReason: args.blocker?.trim() || "Evaluator marked BLOCKED without a reason.",
          };
      await recordVerdict(context.taskId, verdictForStore);
      // Also drop a structured event for dashboard + audit.
      try {
        await context.recordEvent({
          type: "goal.evaluator_verdict_submitted",
          timestamp: new Date().toISOString(),
          data: {
            verdict: args.verdict,
            blocker: args.blocker ?? null,
            confidence: args.confidence ?? null,
            checkedCriteria: args.checked_criteria ?? [],
          },
        });
      } catch {
        // Best-effort.
      }
      return {
        data:
          args.verdict === "ready"
            ? "Verdict recorded: READY. The leader may now call mark_goal_complete."
            : `Verdict recorded: BLOCKED — ${verdictForStore.blockerReason}. The leader's next continuation will surface this blocker.`,
      };
    },
  };
}

/** 2026-05-24 Phase 1b-2 — reviewer-only tool. Reviewer teammate
 *  emits a typed verdict via this tool; Leader reads it via the
 *  typed artifact rather than parsing markdown. See
 *  reviewer-verdict-service.ts for the schema + forgery guard. */
function buildSubmitReviewVerdictTool(): LeaderTool {
  return {
    name: "submit_review_verdict",
    description:
      "Submit a typed verdict on a specific change_review. Call this EXACTLY ONCE near "
      + "the end of your review run. The verdict goes to Leader (or the operator if "
      + "the review has been escalated). Required fields:\n"
      + "  - verdict: APPROVE | REQUEST_CHANGES | REJECT\n"
      + "  - confidence: high | medium | low — low means Leader will escalate to a human\n"
      + "  - reviewedReviewId: the change_review id you were spawned to review\n"
      + "  - reviewerRoleRuntimeId: YOUR role_runtime_id (the server validates this matches the caller)\n"
      + "  - blockingFindings / nonBlockingFindings: structured findings with file:line\n"
      + "  - evidence: command / test / read evidence you gathered\n"
      + "  - narrative: a concise prose summary (≤4000 chars).\n\n"
      + "Markdown VERDICT lines in your final response are deprecated — they parse as "
      + "low-confidence and will always escalate to operator. Use this tool for any "
      + "verdict you want Leader to consider autonomously.",
    inputSchema: z.object({
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT"]),
      confidence: z.enum(["high", "medium", "low"]),
      reviewedReviewId: z.string().min(1),
      reviewerRoleRuntimeId: z.string().min(1),
      blockingFindings: z
        .array(
          z.object({
            file: z.string(),
            line: z.number().int().positive().optional(),
            issue: z.string().max(2_000),
          }),
        )
        .max(50)
        .default([]),
      nonBlockingFindings: z
        .array(
          z.object({
            file: z.string(),
            line: z.number().int().positive().optional(),
            issue: z.string().max(2_000),
          }),
        )
        .max(100)
        .default([]),
      evidence: z
        .array(
          z.object({
            kind: z.enum(["command", "test", "read"]),
            label: z.string().max(200),
            summary: z.string().max(2_000),
          }),
        )
        .max(50)
        .default([]),
      narrative: z.string().max(4_000).default(""),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isPlanSafe: () => true,
    call: async (args, context) => {
      const { persistReviewerVerdict, ReviewerVerdictForgedError, ReviewerVerdictTargetMissingError } =
        await import("../../safe-apply/reviewer-verdict-service");
      try {
        const callerRoleRuntimeId = context.runId ?? "unknown";
        const { artifactId } = await persistReviewerVerdict({
          callerRoleRuntimeId,
          verdict: {
            ...args,
            reviewerRoleRuntimeId: callerRoleRuntimeId,
          },
        });
        return {
          data: `Verdict recorded as artifact ${artifactId} (verdict=${args.verdict}, confidence=${args.confidence}). Leader will read this on its next turn.`,
        };
      } catch (error) {
        if (error instanceof ReviewerVerdictForgedError) {
          return { data: `Refused: ${error.message}`, isError: true };
        }
        if (error instanceof ReviewerVerdictTargetMissingError) {
          return { data: `Refused: ${error.message}`, isError: true };
        }
        throw error;
      }
    },
  };
}

/** 2026-05-24 Phase 1b-2 — Leader inbox tool: read a change_review
 *  assigned to leader. Pure read; never changes state. */
function buildReadChangeReviewTool(): LeaderTool {
  return {
    name: "read_change_review",
    description:
      "Read a change_review currently assigned to you (assignee='leader'). Returns the "
      + "review metadata, the diff body (truncated at 200KB), any reviewer verdict that "
      + "was submitted, and an applicability probe (whether the workspace HEAD still "
      + "matches the review's base revision). Use this BEFORE deciding whether to "
      + "reject_change_review or escalate_change_review_to_user. The apply path (Leader-"
      + "applied changes) is NOT yet available in Phase 1; if you want a change applied, "
      + "either escalate to the operator or wait for Phase 1b-3.",
    inputSchema: z.object({
      reviewId: z.string().min(1),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isPlanSafe: () => true,
    call: async (args) => {
      const { readChangeReviewForLeader, LeaderReviewToolFailure } = await import(
        "../../safe-apply/leader-review-tools-service"
      );
      try {
        const result = await readChangeReviewForLeader({ reviewId: args.reviewId });
        return {
          data: JSON.stringify(
            {
              review: {
                id: result.review.id,
                taskId: result.review.taskId,
                workspaceId: result.review.workspaceId,
                assignee: result.review.assignee,
                decisionState: result.review.decisionState,
                risk: result.review.risk,
                runtimeSource: result.review.runtimeSource,
                permissionMode: result.review.permissionMode,
                addedLines: result.review.addedLines,
                removedLines: result.review.removedLines,
                changedFiles: JSON.parse(result.review.changedFilesJson ?? "[]"),
                baseRevision: result.review.baseRevision,
              },
              diff: result.diff,
              diffTruncated: result.diffTruncated,
              reviewerVerdict: result.reviewerVerdict,
              applicability: result.applicability,
            },
            null,
            2,
          ),
        };
      } catch (error) {
        if (error instanceof LeaderReviewToolFailure) {
          return { data: `Refused: ${error.detail.code}: ${error.detail.message}`, isError: true };
        }
        throw error;
      }
    },
  };
}

/** 2026-05-24 Phase 1b-2 — Leader inbox tool: reject a leader-assigned
 *  change_review with an atomic conditional UPDATE that honours
 *  operator mid-flight overrides. */
function buildRejectChangeReviewTool(): LeaderTool {
  return {
    name: "reject_change_review",
    description:
      "Reject a change_review currently assigned to you (assignee='leader'). The "
      + "patch will not be applied. Use this when the reviewer verdict is REJECT, or "
      + "when you've inspected the diff and decided it's not the right approach. "
      + "Provide a short user-visible `reason` plus your full `reasoning` (the "
      + "reasoning lands in the audit log). If you'd like the operator to weigh in "
      + "instead of unilaterally rejecting, use escalate_change_review_to_user.",
    inputSchema: z.object({
      reviewId: z.string().min(1),
      reason: z.string().min(1).max(500),
      reasoning: z.string().min(1).max(4_000),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { rejectChangeReviewAsLeader, LeaderReviewToolFailure } = await import(
        "../../safe-apply/leader-review-tools-service"
      );
      try {
        const result = await rejectChangeReviewAsLeader({
          reviewId: args.reviewId,
          reason: args.reason,
          reasoning: args.reasoning,
          decidedBy: `leader:${context.runId ?? "unknown"}`,
        });
        return {
          data: `Rejected change_review ${result.review.id}. The patch will not be applied.`,
        };
      } catch (error) {
        if (error instanceof LeaderReviewToolFailure) {
          return { data: `Refused: ${error.detail.code}: ${error.detail.message}`, isError: true };
        }
        throw error;
      }
    },
  };
}

/** 2026-05-24 Phase 1b-2 — Leader inbox tool: hand a review to the
 *  operator when Leader is uncertain or the change touches anything
 *  the operator should weigh in on. */
function buildEscalateChangeReviewTool(): LeaderTool {
  return {
    name: "escalate_change_review_to_user",
    description:
      "Flip a leader-assigned change_review back to the operator's queue. Use this "
      + "when:\n"
      + "  - the reviewer verdict has confidence=low OR is missing entirely\n"
      + "  - the diff touches anything that warrants a human eye (architectural "
      + "shifts, public API changes, anything in a directory the workspace policy "
      + "lists as always_escalate, or anything you genuinely don't have a strong "
      + "opinion on)\n"
      + "  - you'd rather the operator see this than have you reject it outright.\n\n"
      + "Provide a short user-visible `reason` so the operator opens the panel "
      + "knowing why Leader handed off.",
    inputSchema: z.object({
      reviewId: z.string().min(1),
      reason: z.string().min(1).max(1_000),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { escalateChangeReviewToUser, LeaderReviewToolFailure } = await import(
        "../../safe-apply/leader-review-tools-service"
      );
      try {
        const result = await escalateChangeReviewToUser({
          reviewId: args.reviewId,
          reason: args.reason,
          decidedBy: `leader:${context.runId ?? "unknown"}`,
        });
        return {
          data: `Escalated change_review ${result.review.id} back to the operator's queue.`,
        };
      } catch (error) {
        if (error instanceof LeaderReviewToolFailure) {
          return { data: `Refused: ${error.detail.code}: ${error.detail.message}`, isError: true };
        }
        throw error;
      }
    },
  };
}

/** 2026-05-24 Phase 1b-3 — Leader privileged apply. Calls into
 *  leader-apply-service.applyChangeReviewAsLeader which handles:
 *    - verdict gate (high+APPROVE required)
 *    - atomic claim of the applying slot
 *    - bounded apply-lock retry
 *    - HEAD + base-revision + workspace-clean verification
 *    - git apply --check, git apply, with reverse-on-failure
 *    - git add + git commit (no --no-verify, runs through runGit)
 *    - reverse-on-commit-failure
 *    - final atomic DB write (applied + commit_sha)
 *    - explicit partially_applied state for catastrophic cases
 *  Spec: docs/plans/2026-05-24-leader-review-autonomy-v3.md */
function buildApplyChangeReviewTool(): LeaderTool {
  return {
    name: "apply_change_review",
    description:
      "Apply a reviewed patch to the workspace and commit it on behalf of the user. "
      + "REQUIRES the change_review to be (a) assignee='leader', (b) decisionState='pending', "
      + "(c) applyState='not_applied', AND a reviewer verdict artifact attached with "
      + "verdict=APPROVE + confidence=high. Any weaker verdict → escalate_change_review_to_user instead.\n\n"
      + "The patch is applied via `git apply`, then committed with a stable message format "
      + "(`leader-applied change_review <id>`) the operator can `git revert <sha>` if they later "
      + "disagree. Pre-commit hooks run normally; if a hook fails the apply is rolled back and "
      + "the call returns commit_failed. On catastrophic failures (apply succeeded but reverse "
      + "rollback also failed) the row is marked partially_applied and the operator must "
      + "intervene manually.\n\n"
      + "Failure codes you should know how to react to:\n"
      + "  - verdict_required / verdict_insufficient → call escalate_change_review_to_user.\n"
      + "  - lock_busy → another apply on the same workspace is in flight; try the next review in your inbox; this one is still available next turn.\n"
      + "  - head_drift → the workspace HEAD moved since your read; re-read and retry.\n"
      + "  - base_revision_mismatch / workspace_dirty / patch_check_failed → the patch is no longer applicable cleanly; reject_change_review and let the agent re-spawn against the current HEAD.\n"
      + "  - apply_failed → git apply itself errored; treat as patch_check_failed.\n"
      + "  - commit_failed → a pre-commit hook rejected the change; reject_change_review.\n"
      + "  - partially_applied → CATASTROPHIC. Do NOT retry. escalate_change_review_to_user with a clear message that the workspace needs manual recovery.",
    inputSchema: z.object({
      reviewId: z.string().min(1),
      reasoning: z.string().min(1).max(4_000),
      expectedDiffHash: z.string().min(1),
      expectedWorkspaceHead: z.string().optional(),
    }),
    defaultTimeoutMs: 120_000, // generous: lock retry up to ~50s + hook latency
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { applyChangeReviewAsLeader } = await import(
        "../../safe-apply/leader-apply-service"
      );
      const decidedBy = `leader:${context.runId ?? "unknown"}`;
      const result = await applyChangeReviewAsLeader({
        reviewId: args.reviewId,
        reasoning: args.reasoning,
        expectedDiffHash: args.expectedDiffHash,
        ...(args.expectedWorkspaceHead ? { expectedWorkspaceHead: args.expectedWorkspaceHead } : {}),
        decidedBy,
      });
      if (result.ok) {
        const warningsLine = result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : "";
        return {
          data: `Applied change_review ${args.reviewId}. Commit: ${result.commitSha}.${warningsLine}`,
        };
      }
      return {
        data: `apply_change_review refused: ${result.code} — ${result.message}`,
        isError: result.code === "partially_applied" || result.code === "db_drift",
      };
    },
  };
}

/** 2026-05-12 phase 4 — hook called after every teammate spawn
 *  completes. When the just-finished teammate was an evaluator AND
 *  the parent task is in goal mode, parse the evaluator's final
 *  text for "Overall verdict: READY|BLOCKED" and persist it on the
 *  task row. mark_goal_complete reads this gate before flipping
 *  goalStatus to "complete".
 *
 *  Failure is silent — recording the verdict is best-effort
 *  observability, NEVER blocks the spawn return path. */
async function maybeRecordEvaluatorVerdict(
  roleId: string,
  taskId: string,
  finalText: string,
): Promise<void> {
  if (roleId !== "evaluator") return;
  try {
    const { TaskRepository } = await import("../../../repositories/task-repository");
    const task = await new TaskRepository().getById(taskId);
    if (!task?.goalObjective) return;
    const { parseEvaluatorVerdict, recordVerdict } = await import(
      "../../goal-mode/evaluator-verifier-service"
    );
    const verdict = parseEvaluatorVerdict(finalText);
    await recordVerdict(taskId, verdict);
  } catch {
    // Best-effort.
  }
}

/** Budget summary appended to a successful `mark_goal_complete` return.
 *  Adopted from codex `goals.rs:106 completion_budget_report` — the
 *  point is to give the model the final budget numbers in the tool
 *  result so its closing turn to the user can include them. Without
 *  this, the model has to guess or omit budget info from its final
 *  message. v3 spec §P0-7. */
function formatCompletionBudgetReport(input: {
  tokensUsed: number;
  tokenBudget: number | null;
  startedAtMs: number | null;
  completedAtMs: number;
}): string {
  const parts: string[] = [];
  if (input.tokenBudget != null && input.tokenBudget > 0) {
    parts.push(`tokens used: ${input.tokensUsed} of ${input.tokenBudget}`);
  } else if (input.tokensUsed > 0) {
    parts.push(`tokens used: ${input.tokensUsed}`);
  }
  if (input.startedAtMs != null) {
    const elapsedSec = Math.max(0, Math.floor((input.completedAtMs - input.startedAtMs) / 1000));
    if (elapsedSec > 0) {
      parts.push(`elapsed: ${elapsedSec}s`);
    }
  }
  if (parts.length === 0) return "";
  return ` Final budget — ${parts.join("; ")}. Report this to the user in your closing message.`;
}

/** mark_goal_complete tool — pulled out into its own builder so the
 *  type checker can infer LeaderTool from a single declaration site
 *  even when the caller conditionally spreads it ("leader-only").
 *  See call-site at the leader-only `...(callerRoleId === "leader"
 *  ? [buildMarkGoalCompleteTool()] : [])` spread. */
function buildMarkGoalCompleteTool(): LeaderTool {
  return {
    name: "mark_goal_complete",
    description:
      "Mark the current goal as complete and exit goal mode. Two paths:\n\n"
      + "**Standard path** (default): for goals with real acceptance criteria — "
      + "before calling this tool, verify EVERY requirement in the objective "
      + "with authoritative evidence (test output, file content, command result). "
      + "Do not rely on intent or partial progress — treat completion as unproven "
      + "until each requirement has concrete proof. For each explicit requirement, "
      + "identify the authoritative evidence. Do not call this tool the first time "
      + "you think you're done — run the verification commands one more time to "
      + "confirm.\n\n"
      + "**Trivial path** (`trivial: true`): for goals that don't warrant a "
      + "full audit — casual greetings, single-question Q&A, conversational "
      + "exchanges, status checks. Use when the objective is fully satisfied "
      + "by your in-conversation reply alone (no files changed, no tests to "
      + "run, no acceptance criteria to verify). Skips the audit requirement "
      + "(there's nothing to verify). "
      + "Be honest about which path applies: if the user said 'build feature "
      + "X' and you haven't built it, `trivial: true` would be wrong.\n\n"
      + "Required arg: 1-paragraph summary (standard) or 1-sentence summary "
      + "(trivial). Optional: evidence list (standard path). Has no effect on "
      + "tasks not in goal mode.",
    inputSchema: z.object({
      summary: z.string().min(1),
      evidence: z.array(z.string()).optional(),
      /** Skip the evaluator-READY gate. Use ONLY when the goal is
       *  satisfied by conversation alone (greeting, Q&A, no work
       *  done). Don't use to dodge the gate on real work. */
      trivial: z.boolean().optional(),
      /** GOAL-1 escape hatch: override the evaluator BLOCKED gate when
       *  the model has already addressed the blockers and the evaluator
       *  hasn't re-run yet. Requires an explicit justification in
       *  `summary`. Use sparingly — prefer re-running the evaluator. */
      force: z.boolean().optional(),
      /** Phase 6 race guard: pass the goal_id from the latest
       *  continuation if you have it. When set, the tool silently
       *  no-ops if it doesn't match the task's current goal_id —
       *  protects against a re-issued goal (pause+resume + replace)
       *  having the old loop's mark_goal_complete fire late. */
      expected_goal_id: z.string().optional(),
    }),
    defaultTimeoutMs: 15_000,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { TaskRepository } = await import("../../../repositories/task-repository");
      const taskRepo = new TaskRepository();
      const task = await taskRepo.getById(context.taskId);
      if (!task?.goalObjective) {
        return { data: "No active goal on this task; mark_goal_complete is a no-op." };
      }
      if (args.expected_goal_id && task.goalId && args.expected_goal_id !== task.goalId) {
        return {
          data: `Refused: expected_goal_id (${args.expected_goal_id}) does not match the current goal_id (${task.goalId}). The goal may have been re-issued. Re-read the current goal state before retrying.`,
        };
      }
      if (task.goalStatus !== "active") {
        return { data: `Goal is already in status "${task.goalStatus}"; nothing to do.` };
      }
      // GOAL-1: enforce the evaluator BLOCKED gate UNCONDITIONALLY (incl.
      // the trivial path) — otherwise `trivial: true` is a trivial bypass:
      // a goal that has a BLOCKED verdict could be marked complete by
      // self-classifying the call as trivial. The only override is an
      // explicit `force: true`. (Normally a BLOCKED verdict implies an
      // evaluator ran, so this rarely collides with a genuine iteration-0
      // trivial call — but we must not leave the dodge open.)
      if (task.goalLastVerifierVerdict === "BLOCKED" && !args.force) {
        const blockerReason = task.goalLastVerifierBlocker
          ?? "Evaluator returned BLOCKED with no reason — re-run the evaluator.";
        return {
          data:
            `Refused: the latest evaluator verdict is BLOCKED. `
            + `Blocker: ${blockerReason} `
            + `Address the blocker, re-run the evaluator (spawn_teammate role="evaluator"), `
            + `and call mark_goal_complete once the evaluator returns READY. `
            + `If you have already resolved the blocker and want to proceed without waiting `
            + `for a fresh evaluator run, pass \`force: true\` and explain why in \`summary\`.`,
        };
      }
      // trivial-completion path. Goals like "你好" /
      // single-question Q&A / conversational acks don't warrant
      // spawning an evaluator. The leader self-classifies (`trivial:
      // true`) and we skip the verifier gate. Caveat: model is
      // capable of using this to dodge real verification — the
      // description spells out the contract, and plan.md's iteration
      // log records which path was taken so an operator can spot
      // abuse.
      //
      // Server-side guard (codex review I5 #2): refuse trivial after
      // iteration 0. If the Ralph loop already iterated, by
      // construction the leader thought there was real work to do —
      // claiming "actually it was trivial all along" is retroactive
      // evaluator-dodging. Iteration 0 is the canonical "user
      // toggled goal mode by accident, said 你好, nothing to do".
      if (args.trivial) {
        if ((task.goalIterations ?? 0) >= 1) {
          return {
            data:
              `Refused: trivial path is only valid on iteration 0 (current: ${task.goalIterations}). `
              + "Once the Ralph loop has iterated, real work was implied — "
              + "use the standard self-audit path: verify every requirement with "
              + "authoritative evidence, then mark_goal_complete without trivial.",
          };
        }
        const now = new Date();
        const finalIterations = (task.goalIterations ?? 0) + 1;
        await taskRepo.update(context.taskId, {
          goalStatus: "complete",
          goalIterations: finalIterations,
          goalCompletedAt: now.getTime(),
          updatedAt: now,
        });
        if (task.workspaceId) {
          try {
            const { appendIterationLog } = await import("../../goal-mode/plan-file-service");
            await appendIterationLog(context.taskId, task.workspaceId, {
              iteration: finalIterations,
              verdict: "complete-claimed",
              summary: `Goal complete (trivial path, no evaluator). ${args.summary}`,
            });
          } catch {
            // Best-effort.
          }
        }
        const trivialBudget = formatCompletionBudgetReport({
          tokensUsed: task.goalTokensUsed ?? 0,
          tokenBudget: task.goalTokenBudget ?? null,
          startedAtMs: task.goalStartedAt ?? null,
          completedAtMs: now.getTime(),
        });
        return {
          data: `Goal marked complete (trivial path — no evaluator needed). ${args.summary}${trivialBudget}`,
        };
      }
      // Self-audit path — no external evaluator gate.
      // The leader is responsible for verifying completion evidence
      // before calling this tool. The continuation templates enforce
      // the audit protocol via prompt. Here we proceed directly to
      // the terminal transition.
      // record the terminal timestamp + bump the
      // iteration counter one last time. The auto-continuation path
      // (process-task-intent-service.ts) only bumps when the
      // model DIDN'T call mark_goal_complete, so this counter would
      // otherwise stay at 0 for goals that completed on the first
      // try. Freezing `goal_completed_at` lets the frontend stop the
      // elapsed-time counter at the moment of completion instead of
      // ticking forever as the chat task accepts follow-up turns.
      const now = new Date();
      const finalIterations = (task.goalIterations ?? 0) + 1;
      await taskRepo.update(context.taskId, {
        goalStatus: "complete",
        goalIterations: finalIterations,
        goalCompletedAt: now.getTime(),
        updatedAt: now,
      });
      // Append a success block to plan.md for audit trail.
      if (task.workspaceId) {
        try {
          const { appendIterationLog } = await import("../../goal-mode/plan-file-service");
          await appendIterationLog(context.taskId, task.workspaceId, {
            iteration: finalIterations,
            verdict: "complete-claimed",
            summary: `Goal complete (self-audit). ${args.summary}`,
          });
        } catch {
          // Best-effort.
        }
      }
      const evidenceLine = args.evidence && args.evidence.length > 0
        ? ` Evidence: ${args.evidence.join("; ")}.`
        : "";
      const standardBudget = formatCompletionBudgetReport({
        tokensUsed: task.goalTokensUsed ?? 0,
        tokenBudget: task.goalTokenBudget ?? null,
        startedAtMs: task.goalStartedAt ?? null,
        completedAtMs: now.getTime(),
      });
      return {
        data: `Goal marked complete after ${finalIterations} iteration(s) (self-audit). ${args.summary}${evidenceLine}${standardBudget}`,
      };
    },
  };
}

/** update_goal_plan tool (phase 3) — leader-only.
 *
 *  Writes the entire plan.md body. The model uses this to refine
 *  acceptance criteria, tick completed items, or append iteration
 *  notes. Full-content replacement avoids merge-conflict logic on
 *  our side; the model already has the current content (it was
 *  embedded in the previous continuation) so a full rewrite is
 *  cheap from a token standpoint.
 *
 *  Rejects when the task has no goal_id (i.e. legacy goal or
 *  non-goal task) so callers see an explicit reason rather than
 *  a silently no-op'd write. */
function buildUpdateGoalPlanTool(): LeaderTool {
  return {
    name: "update_goal_plan",
    description:
      "Rewrite the goal's plan.md (single source of truth for the current goal). "
      + "Pass the FULL new content — this is a wholesale replacement, not a patch. "
      + "Keep the headers `## Objective`, `## Acceptance criteria`, `## Iteration log` "
      + "intact so the human + evaluator can navigate. Tick completed criteria with "
      + "`- [x]` and add `(evidence: file:line / cmd output / commit sha)` on the "
      + "same line. Cap: ~64 KiB. Only available on tasks in goal mode.",
    inputSchema: z.object({
      content: z.string().min(1),
      /** Phase 6 race guard — see mark_goal_complete. */
      expected_goal_id: z.string().optional(),
    }),
    defaultTimeoutMs: 30_000,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { TaskRepository } = await import("../../../repositories/task-repository");
      const taskRepo = new TaskRepository();
      const task = await taskRepo.getById(context.taskId);
      if (!task?.goalObjective) {
        return { data: "No active goal on this task; update_goal_plan is a no-op." };
      }
      if (args.expected_goal_id && task.goalId && args.expected_goal_id !== task.goalId) {
        return {
          data: `Refused: expected_goal_id mismatch. The goal may have been re-issued.`,
        };
      }
      if (!task.workspaceId) {
        return { data: "Task has no workspace; cannot resolve plan.md path." };
      }
      const { writePlan } = await import("../../goal-mode/plan-file-service");
      try {
        const { bytesWritten } = await writePlan(
          context.taskId,
          task.workspaceId,
          args.content,
        );
        return {
          data: `plan.md updated (${bytesWritten} bytes). The new contents will appear in the next iteration's continuation.`,
        };
      } catch (err) {
        return {
          data: `Failed to write plan.md: ${(err as Error).message}`,
        };
      }
    },
  };
}

/** add_acceptance_criterion tool (phase 3) — leader-only.
 *
 *  Append-only convenience over `update_goal_plan`. Spawns a single
 *  unchecked checklist item under `## Acceptance criteria`. The
 *  full-rewrite tool is still available when the model wants to
 *  reorganize. */
function buildAddAcceptanceCriterionTool(): LeaderTool {
  return {
    name: "add_acceptance_criterion",
    description:
      "Append a single acceptance criterion to the goal's plan.md under "
      + "`## Acceptance criteria`. Use for incremental additions; for bulk "
      + "rewrites use `update_goal_plan` instead. Only available on tasks "
      + "in goal mode.",
    inputSchema: z.object({
      text: z.string().min(3),
      /** Phase 6 race guard — see mark_goal_complete. */
      expected_goal_id: z.string().optional(),
    }),
    defaultTimeoutMs: 30_000,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    call: async (args, context) => {
      const { TaskRepository } = await import("../../../repositories/task-repository");
      const taskRepo = new TaskRepository();
      const task = await taskRepo.getById(context.taskId);
      if (!task?.goalObjective) {
        return { data: "No active goal on this task; add_acceptance_criterion is a no-op." };
      }
      if (args.expected_goal_id && task.goalId && args.expected_goal_id !== task.goalId) {
        return {
          data: `Refused: expected_goal_id mismatch. The goal may have been re-issued.`,
        };
      }
      if (!task.workspaceId) {
        return { data: "Task has no workspace; cannot resolve plan.md path." };
      }
      const { readPlan, writePlan } = await import("../../goal-mode/plan-file-service");
      const existing = (await readPlan(context.taskId, task.workspaceId)) ?? "";
      const inject = `- [ ] ${args.text.trim()}`;
      let next: string;
      const marker = "## Acceptance criteria";
      const idx = existing.indexOf(marker);
      if (idx === -1) {
        // No criteria section yet — append one at EOF.
        next = `${existing}\n\n${marker}\n\n${inject}\n`;
      } else {
        // Find end of the criteria section (next `## ` or EOF) and
        // splice our item before it.
        const after = existing.indexOf("\n## ", idx + marker.length);
        if (after === -1) {
          next = `${existing.trimEnd()}\n${inject}\n`;
        } else {
          next = `${existing.slice(0, after).trimEnd()}\n${inject}\n${existing.slice(after)}`;
        }
      }
      try {
        await writePlan(context.taskId, task.workspaceId, next);
        return { data: `Added criterion to plan.md.` };
      } catch (err) {
        return {
          data: `Failed to write plan.md: ${(err as Error).message}`,
        };
      }
    },
  };
}

function buildCustomAgentFallbackPrompt(
  roleId: string,
  profile: { label: string; description: string | null } | null,
): string {
  const label = profile?.label?.trim() || roleId;
  const description = profile?.description?.trim();
  if (description) {
    return `You are the ${label} agent. ${description}
Complete the delegated goal in the workspace and report concise results when finished.`;
  }

  return `You are the ${label} agent.
Complete the delegated goal in the workspace and report concise results when finished.`;
}

type AgentRuntimeType = "ucm" | "codex" | "opencode" | "claude-code" | "kiro";

function normalizeRuntimeType(value: string | null | undefined): AgentRuntimeType | "unknown" {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "ucm";
  }

  const trimmed = value.trim();
  if (trimmed === "ucm" || trimmed === "codex" || trimmed === "opencode" || trimmed === "claude-code" || trimmed === "kiro") {
    return trimmed;
  }

  return "unknown";
}

function getDefaultCliCommand(runtimeType: Exclude<AgentRuntimeType, "ucm">): string {
  if (runtimeType === "codex") {
    return "codex";
  }
  if (runtimeType === "opencode") {
    return "opencode";
  }
  if (runtimeType === "kiro") {
    return "kiro-cli";
  }
  return "claude";
}

function parseCustomEnv(raw: string | null | undefined): Record<string, string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function parseCustomArgs(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function normalizeReasoningMode(
  mode: string | undefined,
): "off" | "auto" | "on" | undefined {
  if (mode === "off" || mode === "auto" || mode === "on") {
    return mode;
  }
  return undefined;
}

function normalizeReasoningEffort(
  effort: string | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  return undefined;
}

function buildApiConfigFromResolvedAgent(
  roleId: string,
  agentConfig: ResolvedAgentConfig,
): {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  const providerRecord = agentConfig.provider!;
  const provider = {
    id: providerRecord.id,
    ...(providerRecord.label ? { label: providerRecord.label } : {}),
    vendor: providerRecord.vendor ?? "unknown",
    transport: providerRecord.transport,
    apiDialect: providerRecord.apiDialect as ProviderConfig["apiDialect"],
    ...(providerRecord.baseUrl ? { baseUrl: providerRecord.baseUrl } : {}),
    auth: providerRecord.auth ?? { kind: "none" as const },
    ...(providerRecord.headers ? { headers: providerRecord.headers } : {}),
    ...(providerRecord.requestOverrides ? { requestOverrides: providerRecord.requestOverrides } : {}),
    ...(providerRecord.quirks ? { quirks: providerRecord.quirks } : {}),
  } as ProviderConfig;

  const reasoningMode = normalizeReasoningMode(agentConfig.reasoning?.mode);
  const reasoningEffort = normalizeReasoningEffort(agentConfig.reasoning?.effort);
  const model: ModelProfile = {
    id: `${roleId}_agent_binding`,
    modelName: agentConfig.modelName,
    providerRefs: { api: provider.id },
    // S4 — context/output + capabilityHints (vision) via the shared projection.
    ...agentConfigModelProfileFields(agentConfig),
    ...(reasoningMode
      ? {
          defaultReasoning: {
            mode: reasoningMode,
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          },
        }
      : {}),
  };

  const binding: ExecutorBinding = {
    adapterId: roleId,
    executionMode: "api",
    modelRef: model.id,
    providerRef: provider.id,
  };

  return {
    provider,
    model,
    binding,
    ...(typeof agentConfig.contextWindow === "number" ? { contextWindow: agentConfig.contextWindow } : {}),
    ...(typeof agentConfig.maxOutputTokens === "number"
      ? { maxOutputTokens: agentConfig.maxOutputTokens }
      : {}),
  };
}

function escapeFeishuLarkMd(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/@/g, "\\@")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resolveApprovalDetailUrl(): string {
  const configuredBaseUrl =
    process.env.MAGISTER_WEB_BASE_URL?.trim() ??
    process.env.MAGISTER_WEB_PUBLIC_BASE_URL?.trim() ??
    "";

  if (!configuredBaseUrl) {
    return "/";
  }

  try {
    const normalized = configuredBaseUrl.replace(/\/+$/, "");
    const url = new URL(`${normalized}/`);
    return url.toString();
  } catch {
    return "/";
  }
}

async function sendDangerousCommandApprovalFeishuNotificationBestEffort(input: {
  taskId: string;
  commandPreview: string;
  reason: string;
}) {
  try {
    const taskRepository = new TaskRepository();
    const task = await taskRepository.getById(input.taskId);
    if (!task?.rootChannelBindingId) {
      return;
    }

    const bindingRepository = new ConversationBindingRepository();
    const binding = await bindingRepository.getById(task.rootChannelBindingId);
    if (!binding || binding.channel !== "feishu") {
      return;
    }

    const feishuConfig = parseFeishuConfigFromEnv();
    if (!feishuConfig.appId || !feishuConfig.appSecret) {
      return;
    }

    const client = createFeishuClient({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });

    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "⚠️ 危险操作待确认" },
        template: "red",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              "命令预览: " + escapeFeishuLarkMd(input.commandPreview),
              "原因: " + escapeFeishuLarkMd(input.reason),
            ].join("\n"),
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看详情 →" },
              type: "primary",
              url: resolveApprovalDetailUrl(),
            },
          ],
        },
      ],
    };

    await client.sendCardMessage({
      chatId: binding.chatId,
      card,
    });
  } catch {
    // Best-effort notification only.
  }
}

const REVIEW_GATE_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000;

function getReviewGateTimeoutMs(): number {
  const env = process.env.MAGISTER_REVIEW_GATE_TIMEOUT_MS;
  if (env !== undefined && /^\d+$/.test(env)) return Number(env);
  return REVIEW_GATE_TIMEOUT_MS_DEFAULT;
}

async function blockOnPendingReview(
  teammateRunId: string,
  context: { taskId: string; abortController?: AbortController; recordEvent: (event: any) => Promise<void> },
): Promise<string | null> {
  const reviewGateTimeoutMs = getReviewGateTimeoutMs();
  if (reviewGateTimeoutMs <= 0) return null;

  const reviewRepo = new ChangeReviewRepository();
  const reviews = await reviewRepo.listByRoleRuntimeId(teammateRunId);
  const pendingReview = reviews.find((r) => r.decisionState === "pending");
  if (!pendingReview) return null;

  console.log(`[review-gate] blocking on review ${pendingReview.id} for teammate ${teammateRunId}`);

  await context.recordEvent({
    type: "leader.review_gate_waiting",
    timestamp: new Date().toISOString(),
    data: { reviewId: pendingReview.id, teammateRunId },
  });

  const decision = await waitForReviewDecision(pendingReview.id, {
    timeoutMs: reviewGateTimeoutMs,
    ...(context.abortController ? { signal: context.abortController.signal } : {}),
  });

  if (decision.decision === "aborted") {
    return null;
  }

  if (decision.decision === "approved" || decision.decision === "timeout") {
    if (decision.decision === "timeout") {
      console.log(`[review-gate] review ${pendingReview.id} timed out — auto-approving`);
      try {
        await recordChangeReviewDecision({
          reviewId: pendingReview.id,
          decision: "approve",
          reason: "Auto-approved: review gate timeout (5 min)",
          expectedDiffHash: pendingReview.diffHash,
        });
      } catch (err) {
        console.warn(`[review-gate] auto-approve failed for ${pendingReview.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    try {
      const applyResult = await applyChangeReview({
        reviewId: pendingReview.id,
        expectedDiffHash: pendingReview.diffHash,
      });
      await context.recordEvent({
        type: "leader.review_gate_applied",
        timestamp: new Date().toISOString(),
        data: { reviewId: pendingReview.id, commitSha: applyResult.appliedPatchHash },
      });
      return `\n\nChanges applied successfully. Commit: ${applyResult.appliedPatchHash}`;
    } catch (err) {
      const code = (err as any)?.code;
      if (code === "already_applied") {
        return `\n\nChanges already applied (applied by another caller).`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `\n\nApproved but apply failed: ${msg}`;
    }
  }

  const label = decision.decision === "rejected" ? "Rejected" : "Revision requested";
  return `\n\n${label} by user: ${decision.reason || "(no reason given)"}. Adjust approach and retry.`;
}

type SpawnTeammateToolOpts = {
  // `| undefined` is explicit because `exactOptionalPropertyTypes` is on and
  // callers pass `opts?.spawnTeammateDescription` (which may be `undefined`).
  spawnTeammateDescription?: string | undefined;
  // Threaded from `createLeaderTools` — the spawn `call` body re-invokes
  // `createLeaderTools`/`getTeammateTools` for the teammate and must pass
  // the same Tavily config it was built with. (Only enclosing-scope value
  // the moved body referenced; everything else uses `args`/`context`.)
  tavilyConfig?:
    | {
        enabled: boolean;
        apiKey?: string;
        baseUrl: string;
        timeoutSeconds: number;
      }
    | undefined;
};

function buildSpawnTeammateTool(opts?: SpawnTeammateToolOpts): LeaderTool {
  const tavilyConfig = opts?.tavilyConfig;
  return {
      name: "spawn_teammate",
      description: opts?.spawnTeammateDescription ?? SPAWN_TEAMMATE_DESCRIPTION,
      inputSchema: SpawnTeammateInputSchema,
      // Two teammates can run concurrently ONLY when each gets its own
      // isolated git worktree (`isolate: true`). Without isolation they
      // share the leader's workspace and would race on file writes.
      isConcurrencySafe: (args) => args?.isolate === true,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      async call(
        args: {
          role: string;
          goal: string;
          wait?: boolean;
          isolate?: boolean;
          resume_id?: string;
          expected_output?: string;
          // Internal-only: the batch tool (`spawn_teammates`) invokes
          // `single.call(...)` DIRECTLY, bypassing Zod, so it can pass the
          // cohort's parallel-group id to be stamped at row-CREATION time
          // (before the background promise can complete). The public
          // SpawnTeammateInputSchema does NOT expose this field.
          parallelGroupId?: string;
        },
        context: LeaderToolUseContext,
      ) {
        const roleId = args.role.trim();
        if (!roleId) {
          return { data: "Error: role is required" };
        }

        // P1.6 (multi-agent polish A-lite) — when the leader supplies
        // an `expected_output` shape, append it as a compact return-
        // format constraint at the END of the goal. Anthropic
        // multi-agent research lesson #1: drift comes from vague
        // briefs, and specifying output shape is the highest-leverage
        // anti-drift signal. We do this once here so both Magister and
        // CLI teammate paths see the augmented goal without
        // duplicating the logic.
        const expectedOutput = args.expected_output?.trim();
        const goalForTeammate = expectedOutput
          ? `${args.goal}\n\n## Return format\n\n${expectedOutput}`
          : args.goal;

        let profile = null;
        try {
          profile = await getAgentProfile(roleId);
        } catch {
          // Agent profile lookup is best-effort so builtin teammates keep working.
        }

        const isBuiltinRole = isBuiltinAgentRoleId(roleId);
        if (!profile && !isBuiltinRole) {
          // Live query so a mid-session profile creation is visible
          // immediately (the tool description is a startup snapshot).
          let customIds: string[] = [];
          try {
            const allProfiles = await listAgentProfiles();
            customIds = allProfiles
              .filter((p) => (p.isBuiltin ?? 0) === 0 && !isBuiltinAgentRoleId(p.roleId))
              .map((p) => p.roleId)
              .sort();
          } catch {
            // Best-effort: if listing fails, still return the builtin set
            // plus a note so the leader isn't blocked.
          }
          const MAX_SHOWN = 20;
          const customList =
            customIds.length === 0
              ? `No custom roles configured.`
              : customIds.length <= MAX_SHOWN
                ? `Custom roles in this workspace: ${customIds.join(", ")}.`
                : `Custom roles in this workspace: ${customIds.slice(0, MAX_SHOWN).join(", ")} ...and ${customIds.length - MAX_SHOWN} more.`;
          return {
            data: [
              `Unknown agent: "${roleId}".`,
              `Builtin roles: coder, reviewer, architect, lander, evaluator.`,
              customList,
              `Fallback mapping: design/UX→architect, implementation→coder, review/security→reviewer, verification/QA/perf→evaluator, landing/release→lander.`,
            ].join(" "),
          };
        }

        const runtimeRepo = new RoleRuntimeRepository();
        const resumeId = args.resume_id?.trim() || undefined;
        let resumedMessages: unknown[] | undefined;

        // Resume validation: load + verify the prior runtime, then plan
        // to seed the loop with its checkpointed messages.
        // Spec: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md §6
        // (originally deferred — now landing).
        if (resumeId) {
          if (args.isolate === true) {
            return {
              data: "Error: cannot combine resume_id with isolate:true — the original worktree is cleaned up on completion. Resume runs in the parent workspace.",
            };
          }
          const prior = await runtimeRepo.getById(resumeId);
          if (!prior) {
            return { data: `Error: no teammate run found with id ${resumeId}` };
          }
          if (prior.taskId !== context.taskId) {
            return {
              data: `Error: teammate ${resumeId} belongs to a different task (cross-task resume is not allowed).`,
            };
          }
          if (prior.roleId !== roleId) {
            return {
              data: `Error: teammate ${resumeId} was role "${prior.roleId}", not "${roleId}". Role must match the original spawn.`,
            };
          }
          if (prior.state !== "COMPLETED" && prior.state !== "FAILED" && prior.state !== "CANCELLED") {
            return {
              data: `Error: teammate ${resumeId} is in state ${prior.state} — can only resume COMPLETED, FAILED, or CANCELLED runs (poll an in-flight teammate via check_teammate_status / wait_for_teammate instead).`,
            };
          }
          // Reject resumes for cancelled parent tasks. Otherwise we'd
          // start a new loop that's about to be torn down by the parent's
          // abort signal anyway, wasting tokens and confusing event logs.
          try {
            const { TaskRepository } = await import("../../../repositories/task-repository");
            const parentTask = await new TaskRepository().getById(context.taskId);
            if (parentTask && parentTask.state === "CANCELLED") {
              return {
                data: `Error: parent task is cancelled — cannot resume teammate ${resumeId}.`,
              };
            }
          } catch {
            // Best-effort task-state read; if the lookup fails the loop's
            // own AbortController will catch a real cancellation.
          }
          const { LeaderSessionStore: LSS } = await import("../../leader-session-store");
          const cp = await new LSS().getLatestCheckpoint(resumeId);
          if (!cp || !Array.isArray(cp.messages) || cp.messages.length === 0) {
            return {
              data: `Error: teammate ${resumeId} has no checkpoint to resume from — the prior session never persisted state.`,
            };
          }
          resumedMessages = cp.messages as unknown[];
        }

        const teammateRunId = resumeId
          ?? `rt_${roleId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date();

        if (resumeId) {
          // Resume: atomically flip the prior record back to RUNNING.
          // Conditional WHERE state ∈ {COMPLETED, FAILED} so a concurrent
          // double-resume race resolves with one winner — the loser
          // sees 0 rows changed and bails out cleanly .
          // Also bumps attemptCount and updates parentRunId to the
          // current leader run so the lineage reflects this resume.
          const prior = await runtimeRepo.getById(teammateRunId);
          const updated = await runtimeRepo.updateIfStateIn(
            teammateRunId,
            ["COMPLETED", "FAILED", "CANCELLED"],
            {
              state: "RUNNING",
              completedAt: null,
              parentRunId: context.runId,
              attemptCount: (prior?.attemptCount ?? 0) + 1,
              updatedAt: now,
            },
          );
          if (updated === 0) {
            return {
              data: `Error: teammate ${teammateRunId} is no longer in COMPLETED/FAILED/CANCELLED state — another resume probably won the race.`,
            };
          }
        } else {
          await runtimeRepo.create({
            id: teammateRunId,
            taskId: context.taskId,
            roleId,
            state: "RUNNING",
            parentRunId: context.runId,
            attemptCount: 0,
            // Stamp the parallel-group id (if any) at CREATION time so the
            // row carries it before the background teammate promise can
            // complete. This closes the null-stamp race where a fast
            // teammate's completion callback read `parallelGroupId` as null
            // because the old post-hoc batch `update` had not landed yet.
            parallelGroupId: args.parallelGroupId ?? null,
            // Mark async spawns so the parent task can transition to
            // AWAITING_TEAMMATES at turn end and be woken when they finish.
            spawnedAsync: args.wait === false,
            startedAt: now,
            updatedAt: now,
          });
        }

        // reference-counted per-runId status. The leader
        // can spawn multiple teammates of the same role in parallel
        // (e.g. two reviewers); the previous global per-role
        // `updateAgentStatus("reviewer", "idle")` at one teammate's
        // exit would clobber a peer's still-working status. Acquire
        // here pins (role, teammateRunId); release on terminal status.
        const acquireTeammateStatusBestEffort = async (): Promise<void> => {
          try {
            await acquireAgentStatus(roleId, teammateRunId, "working");
          } catch {}
        };
        const releaseTeammateStatusBestEffort = async (
          status: "idle" | "error",
        ): Promise<void> => {
          try {
            await releaseAgentStatus(roleId, teammateRunId, status);
          } catch {}
        };

        await acquireTeammateStatusBestEffort();

        // Step 0a. Capture the spawn_teammate
        // tool_use_id from the call-site context (set by
        // tool-execution.ts via spread; never undefined for normal
        // execution paths, but guarded for direct unit-test
        // invocations that bypass tool-execution).
        const parentToolUseId = context.currentToolUseId;

        const observedTeammateEvents: LeaderLoopEvent[] = [];
        const projectTeammateEvent = createEventProjector({
          taskId: context.taskId,
          runId: teammateRunId,
          requestId: context.requestId,
          agentRole: roleId,
          agentName: profile?.label?.trim() || roleId.charAt(0).toUpperCase() + roleId.slice(1),
          agentDepth: 1,
          parentAgentId: context.runId,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        });
        const teammateRecordEvent = async (event: LeaderLoopEvent) => {
          if (isSafeApplySideEffectEvidenceCandidate(event)) {
            observedTeammateEvents.push(event);
          }
          await projectTeammateEvent(event);
        };

        const runtimeType = normalizeRuntimeType(profile?.runtimeType);
        const modelOverride = profile?.modelName?.trim() || profile?.modelOverride?.trim() || undefined;

        await context.recordEvent({
          type: "leader.teammate_spawned",
          timestamp: now.toISOString(),
          data: {
            teammateName: roleId,
            role: roleId,
            goal: args.goal,
            teammateRunId,
            async: args.wait === false,
            ...(runtimeType !== "unknown"
              ? { runtimeType }
              : profile?.runtimeType
                ? { runtimeType: profile.runtimeType }
                : {}),
            ...(modelOverride ? { modelName: modelOverride } : {}),
            // frontend uses this to pair the
            // spawn_teammate ToolPart with the teammate runtime
            // without maintaining a cross-event Map in store state.
            ...(parentToolUseId ? { parentToolUseId } : {}),
            ...(resumeId ? { resumed: true, priorMessageCount: resumedMessages?.length ?? 0 } : {}),
          },
        });

        if (runtimeType === "unknown") {
          await runtimeRepo.update(teammateRunId, {
            state: "FAILED",
            completedAt: new Date(),
            updatedAt: new Date(),
          });
          await releaseTeammateStatusBestEffort("error");
          return { data: `Unknown runtimeType: ${profile?.runtimeType}` };
        }

        let teammateWorkspaceDir = context.workspaceDir;
        let isolatedWorktreeCreated = false;
        if (args.isolate) {
          try {
            const worktree = createWorktree(
              context.workspaceDir,
              teammateRunId,
              `feat/${roleId}-${teammateRunId.slice(-6)}`,
            );
            teammateWorkspaceDir = worktree.path;
            isolatedWorktreeCreated = true;
          } catch {}
        }

        const cleanupTeammateWorktreeBestEffort = () => {
          if (!isolatedWorktreeCreated) {
            return;
          }
          try {
            removeWorktree(context.workspaceDir, teammateRunId);
          } catch {}
        };

        const { readGitHeadRevision } = await import("../../safe-apply/runtime-diff-service");
        const teammateBaseRevision = await readGitHeadRevision(context.workspaceDir).catch(() => null);

        if (runtimeType !== "ucm") {
          // Resume support per CLI runtime:
          //   codex / claude-code → file-based session discovery
          //                         (cli-session-tracker.ts walks
          //                         <CODEX_HOME>/sessions/.../<uuid>.jsonl
          //                         and ~/.claude/projects/<cwd>/<uuid>.jsonl)
          //   opencode             → not yet wired. opencode stores
          //                         session state in its own SQLite
          //                         (~/.local/share/opencode/storage/...
          //                         or via `opencode session list`);
          //                         resume would need a query against
          //                         that store + `opencode run -s <id>`
          //                         argv. ~half a day's work; not yet
          //                         a user requirement.
          // For unsupported runtimes the resume_id path still rejects.
          let cliResumeSessionId: string | null = null;
          if (resumeId) {
            const isResumable =
              runtimeType === "codex"
              || runtimeType === "claude-code"
              || runtimeType === "opencode";
            if (!isResumable) {
              await runtimeRepo.update(teammateRunId, {
                state: "FAILED",
                completedAt: new Date(),
                updatedAt: new Date(),
              });
              return {
                data: `Error: resume_id is not yet supported for runtime "${runtimeType}". Supported CLI runtimes: codex, claude-code, opencode. Magister is supported as well.`,
              };
            }
            // Look up the recorded session id from the original spawn's
            // `leader.cli_session_recorded` event. Stored under THIS
            // teammateRunId since resume re-uses the same id.
            const { ExecutionEventRepository } = await import("../../../repositories/execution-event-repository");
            const events = await new ExecutionEventRepository().listByTaskIdAndType(
              context.taskId,
              "leader.cli_session_recorded",
            );
            for (const ev of events) {
              try {
                const payload = JSON.parse(ev.payloadJson ?? "{}");
                if (payload.teammateRunId === teammateRunId && typeof payload.cliSessionId === "string") {
                  cliResumeSessionId = payload.cliSessionId;
                  break;
                }
              } catch {}
            }
            if (!cliResumeSessionId) {
              await runtimeRepo.update(teammateRunId, {
                state: "FAILED",
                completedAt: new Date(),
                updatedAt: new Date(),
              });
              return {
                data: `Error: no recorded ${runtimeType} session for teammate ${teammateRunId} — the original spawn may have failed before its session file was created. Spawn fresh without resume_id.`,
              };
            }
          }
          const commandPath = profile?.commandPath?.trim()
            || getDefaultCliCommand(runtimeType);
          const cliEnv = parseCustomEnv(profile?.customEnv);
          const cliArgs = parseCustomArgs(profile?.customArgs);
          const cliReasoningEffort = profile?.reasoningEffort?.trim() || undefined;

          const runCliTeammate = async () => {
            let finalReason = "completed";
            let finalText = "";
            const spawnStartMs = Date.now();
            // Captured by `spawnCliAgent.onUsage` and re-stamped onto
            // the eventual `leader.teammate_completed.data.usage` so
            // the chat UI's spawn_teammate chip can surface tokens
            // inline without a separate /tasks/:id/usage fetch.
            // Hoisted to function scope so the emit (in the outer
            // try{}) can read what onUsage set inside the inner try.
            let capturedUsage: {
              inputTokens: number;
              outputTokens: number;
              nonCachedInputTokens?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
              reasoningTokens?: number;
              totalTokens?: number;
              rawUsage?: unknown;
            } | null = null;

            try {
              try {
                // CLI teammates also get linked skills appended — earlier
                // draft only passed `systemPromptOverride` directly, which
                // dropped skills configured for codex / claude-code / opencode
                // runtimes. Empty/no override still goes through the helper
                // so it returns null cleanly when there's nothing to attach.
                const cliBaseInstructions = profile?.systemPromptOverride?.trim();
                const cliInstructionsWithSkills = cliBaseInstructions
                  ? await appendAgentSkills(roleId, cliBaseInstructions)
                  : undefined;
                // Cross-CLI coordination (decisions doc §253-263):
                // memory rides through the CLI's native instructions
                // channel (codex `--user-instructions`-prepended,
                // claude-code `--append-system-prompt`, opencode
                // prompt-prepend) so external CLI agents see the
                // same accumulated memory the leader does. If the
                // teammate has no base instructions at all we still
                // inject the block standalone so the CLI agent sees
                // memory — the prepend / system-prompt-append flag
                // happily takes a memory-only string.
                const { appendMemoryBlockForTeammate } = await import(
                  "../teammate-system-prompts"
                );
                const cliInstructions = await appendMemoryBlockForTeammate(
                  cliInstructionsWithSkills ?? "",
                  context.taskId,
                );
                const isResumableRuntime =
                  runtimeType === "codex"
                  || runtimeType === "claude-code"
                  || runtimeType === "opencode";
                // Inherit the parent's current-turn attachments. Two
                // channels because CLIs only take a single string
                // prompt — there's no multi-block message API like
                // the Magister teammate uses:
                //   1. Images → native flag (codex `-i`, opencode
                //      `-f`, claude prompt-list fallback). Stays on
                //      disk; CLI vision pipeline reads the bytes.
                //   2. Text-shaped attachments (md / plain / future
                //      doc extractions) → inline into the goal as
                //      a fenced "## Attached files" addendum. The
                //      loader already returns these as text blocks
                //      with a "# Attached file: <name>" header; we
                //      stitch them onto the goal string verbatim.
                //
                // Both skipped on resume — the CLI's resumed session
                // already has its own history; re-injecting would
                // duplicate.
                let cliImagePaths: string[] | undefined;
                let goalWithAttachments = goalForTeammate;
                if (!cliResumeSessionId) {
                  try {
                    // Task-wide attachment scope, not per-request.
                    // The leader can spawn a teammate on turn 5 about
                    // a file the user uploaded on turn 1 — the
                    // attachment is bound to its upload turn's
                    // requestId, but the teammate spawn happens under
                    // a later turn's requestId, so a per-turn lookup
                    // would miss it. The leader has the file in its
                    // own context regardless (conversation history),
                    // and a teammate is downstream of the leader's
                    // intent — it should see whatever the user's
                    // session contains.
                    const { TaskAttachmentRepository } = await import(
                      "../../../repositories/task-attachment-repository"
                    );
                    const attRepo = new TaskAttachmentRepository();
                    const rows = await attRepo.listByTaskId(context.taskId);
                    // Dedupe images by sha256 — if user uploaded the
                    // same image across turns, only forward once.
                    const imagePathsSet = new Set<string>();
                    for (const r of rows) {
                      if (r.mimeType.startsWith("image/")) imagePathsSet.add(r.storagePath);
                    }
                    if (imagePathsSet.size > 0) cliImagePaths = [...imagePathsSet];

                    // Text-shaped attachments — task-wide scope so a
                    // teammate spawned on turn N sees files uploaded
                    // on any earlier turn. The loader dedupes by
                    // sha256 internally.
                    const { loadAttachmentBlocksForTask } = await import(
                      "../../attachment-service"
                    );
                    const blocks = await loadAttachmentBlocksForTask(context.taskId);
                    // Linux MAX_ARG_STRLEN is exactly 131072 bytes
                    // (128 KiB) per argv element — verified empirically
                    // via `posix_spawn` E2BIG at 131072. codex/opencode
                    // pass the prompt as a single positional argv slot,
                    // so the joined `goalWithAttachments` MUST fit
                    // under that or every spawn fails before the CLI
                    // even runs.
                    //
                    // Per-block cap keeps any single file from eating
                    // all the budget. Total cap is the actual safety
                    // net — applied after the join, regardless of
                    // whether we appended attachments at all (so a
                    // leader passing a huge `args.goal` alone is also
                    // safe). 96 KiB total leaves headroom for the
                    // original goal text + the "## Attached files"
                    // header without bumping into 128 KiB.
                    const PER_BLOCK_INLINE_CAP = 32 * 1024;
                    const TOTAL_PROMPT_CAP = 96 * 1024;
                    const TRUNC_NOTE = "\n\n... [truncated to fit CLI argv limit; the leader has the full file]";
                    const textBlocks = blocks
                      .filter((b): b is { type: "text"; text: string } => b.type === "text")
                      .map((b) =>
                        b.text.length > PER_BLOCK_INLINE_CAP
                          ? b.text.slice(0, PER_BLOCK_INLINE_CAP) + TRUNC_NOTE
                          : b.text,
                      );
                    if (textBlocks.length > 0) {
                      goalWithAttachments = `${goalForTeammate}\n\n## Attached files\n\n${textBlocks.join("\n\n")}`;
                    }
                    if (goalWithAttachments.length > TOTAL_PROMPT_CAP) {
                      goalWithAttachments = goalWithAttachments.slice(0, TOTAL_PROMPT_CAP) + TRUNC_NOTE;
                    }
                  } catch {
                    // Best-effort — missing attachments never block a spawn.
                  }
                }
                // pass `onEvent +
                // runtimeType + cliVersion` to opt the spawn into
                // streaming mode. The spawn-service routes JSONL/
                // stream-json output through the matching CliEventParser
                // and forwards each parsed leader event via
                // `teammateRecordEvent` (depth=1 + parentToolUseId
                // stamped — same path as Magister teammates), so the
                // teammate's tool calls / text deltas land in the
                // W1 inline transcript folding live. cliVersion comes
                // from the cached probe (`.magister/cli-versions.json`);
                // null falls back to black-box mode gracefully.
                const { getCachedCliVersion } = await import("../../cli-bridge/cli-version-probe");
                const cliVersion = await getCachedCliVersion(runtimeType as "codex" | "claude-code" | "opencode")
                  .catch(() => null);

                const cliResult = await spawnCliAgent({
                  command: commandPath,
                  prompt: goalWithAttachments,
                  workspaceDir: teammateWorkspaceDir,
                  env: cliEnv,
                  args: cliArgs,
                  // Propagate parent task cancellation to the CLI child
                  // process. Without this, cancelling the leader task
                  // would leave CLI teammates running indefinitely
                  // (especially relevant for wait:false spawns that
                  // outlive the leader's own turn).
                  ...(context.abortController ? { signal: context.abortController.signal } : {}),
                  // Bound wall-clock for CLI teammate (codex/claude-code/
                  // opencode/kiro). On timeout the child is terminated and
                  // reported as a failed teammate (exitCode:-1). Prevents
                  // a hung CLI process from blocking the leader turn forever.
                  ...(Number.isFinite(CLI_TEAMMATE_TIMEOUT_MS) && CLI_TEAMMATE_TIMEOUT_MS > 0
                    ? { timeoutMs: CLI_TEAMMATE_TIMEOUT_MS }
                    : {}),
                  ...(cliReasoningEffort ? { reasoningEffort: cliReasoningEffort } : {}),
                  ...(modelOverride ? { model: modelOverride } : {}),
                  ...(cliInstructions ? { instructions: cliInstructions } : {}),
                  ...(cliImagePaths ? { imagePaths: cliImagePaths } : {}),
                  // Resume path: pass session id + runtime so spawnCliAgent
                  // builds `<cli> exec resume <id>` argv instead of fresh.
                  ...(cliResumeSessionId && isResumableRuntime
                    ? { resumeSessionId: cliResumeSessionId, resumeRuntime: runtimeType as "codex" | "claude-code" | "opencode" }
                    : {}),
                  runtimeType,
                  cliVersion,
                  runtimeWorkspaceStrategy: isolatedWorktreeCreated ? "git_worktree" : "workspace_root",
                  onEvent: teammateRecordEvent,
                  // CLI agents (claude-code / codex /
                  // opencode) now report their final token usage via
                  // the side-channel `onUsage` callback. Forward into
                  // `recordUsage()` so Diagnostics > Usage-by-Model
                  // sees CLI runs alongside leader-loop API calls.
                  // Provider column gets the runtime-prefixed slug
                  // ("cli:claude-code" etc.) so they're distinguishable
                  // from API providers. Model id falls back to whatever
                  // the CLI's modelOverride was when the wire payload
                  // didn't surface one (codex doesn't include it on
                  // turn.completed).
                  onUsage: async (usage) => {
                    // Stash for the `leader.teammate_completed` payload
                    // (chat UI surfaces tokens inline on the
                    // spawn_teammate chip row). Last writer wins —
                    // CLIs emit usage exactly once at their terminal
                    // event in practice.
                    capturedUsage = {
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      ...(usage.nonCachedInputTokens !== undefined
                        ? { nonCachedInputTokens: usage.nonCachedInputTokens } : {}),
                      ...(usage.cacheReadTokens !== undefined
                        ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                      ...(usage.cacheWriteTokens !== undefined
                        ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
                      ...(usage.reasoningTokens !== undefined
                        ? { reasoningTokens: usage.reasoningTokens } : {}),
                      ...(usage.totalTokens !== undefined
                        ? { totalTokens: usage.totalTokens } : {}),
                      ...(usage.rawUsage !== undefined
                        ? { rawUsage: usage.rawUsage } : {}),
                    };
                    try {
                      const { recordUsage } = await import("../../token-usage-service");
                      const resolvedModel =
                        usage.model ?? modelOverride ?? `cli:${usage.runtime}`;
                      await recordUsage({
                        taskId: context.taskId,
                        runId: teammateRunId,
                        requestId: context.requestId,
                        roleId,
                        turnNumber: 1,
                        model: resolvedModel,
                        provider: `cli:${usage.runtime}`,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        usageSource: "provider",
                        ...(usage.nonCachedInputTokens !== undefined
                          ? { nonCachedInputTokens: usage.nonCachedInputTokens } : {}),
                        ...(usage.cacheReadTokens !== undefined
                          ? { cacheReadTokens: usage.cacheReadTokens } : {}),
                        ...(usage.cacheWriteTokens !== undefined
                          ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
                        ...(usage.reasoningTokens !== undefined
                          ? { reasoningTokens: usage.reasoningTokens } : {}),
                        ...(usage.totalTokens !== undefined
                          ? { totalTokens: usage.totalTokens } : {}),
                        ...(usage.rawUsage !== undefined
                          ? { rawUsage: usage.rawUsage } : {}),
                      });
                    } catch (err) {
                      console.warn(
                        `[cli-usage] recordUsage failed: ${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  },
                });

                finalReason = cliResult.exitCode === 0 ? "completed" : "error";
                // Plan v2.1 §3.6 + codex round-4 [C1] / round-5 [M1].
                //
                // Three modes for picking the leader-facing finalText:
                //
                // 1. Streaming + parsed cleanly: use streamingFinalText.
                //    The depth-1 events already populated the inline
                //    transcript; this is the canonical assistant text.
                //
                // 2. Streaming + no clean final_result (parser disabled
                //    mid-run, or final_result never emitted): stdout is
                //    raw JSONL noise — DO NOT show it to the leader.
                //    Use stderr (real failure messages) or a compact
                //    placeholder pointing at the transcript drawer.
                //
                // 3. Black-box (streamingMode=false): legacy path —
                //    stdout is human-readable text from the CLI.
                const cleanText = cliResult.streamingFinalText?.trim();
                const stderrTrimmed = cliResult.stderr.trim();
                const stdoutTrimmed = cliResult.stdout.trim();

                if (cliResult.streamingMode) {
                  // Streaming was active: differentiate by whether
                  // ANY events were ever parsed from this run.
                  if (cleanText) {
                    // Best case: parser produced final_result.
                    finalText = cleanText;
                  } else if (cliResult.streamingProducedAnyEvents) {
                    // Parser worked partially — stdout IS raw JSONL.
                    // Don't show it to the leader; suggest the drawer.
                    if (cliResult.exitCode === 0) {
                      finalText = `Teammate ${roleId} completed (no parseable final text — see transcript drawer for the full event log).`;
                    } else {
                      finalText = stderrTrimmed
                        || `Teammate ${roleId} failed with exit code ${cliResult.exitCode} (no parseable final text — see transcript drawer).`;
                    }
                  } else {
                    // Parser never made sense of any line — the CLI
                    // most likely ignored the streaming flag (silent
                    // version mismatch) and stdout is its normal
                    // human-readable output. Show stdout. Same path
                    // protects the unit-test fake-codex case.
                    finalText = cliResult.exitCode === 0
                      ? (stdoutTrimmed || stderrTrimmed || `Teammate ${roleId} completed.`)
                      : (stderrTrimmed || stdoutTrimmed || `Teammate ${roleId} failed with exit code ${cliResult.exitCode}.`);
                  }
                } else {
                  // Black-box mode: stdout is the legacy human-readable
                  // CLI output. On success prefer stdout, on failure
                  // prefer stderr (codex round-5 [C1] — surfacing
                  // stderr first reveals real CLI errors).
                  finalText = cliResult.exitCode === 0
                    ? (stdoutTrimmed || stderrTrimmed || `Teammate ${roleId} completed.`)
                    : (stderrTrimmed || stdoutTrimmed || `Teammate ${roleId} failed with exit code ${cliResult.exitCode}.`);
                }

                try {
                  await createRuntimeSafeApplyReviewDraft({
                    taskId: context.taskId,
                    roleRuntimeId: teammateRunId,
                    parentWorkspaceDir: context.workspaceDir,
                    runtimeWorkspaceDir: teammateWorkspaceDir,
                    baseRevision: teammateBaseRevision,
                    runtimeSecurity: cliResult.runtimeSecurity,
                    observedEvents: observedTeammateEvents,
                  });
                } catch (err) {
                  console.warn(
                    `[safe-apply] review draft failed for teammate ${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }

                const reviewGateResult = await blockOnPendingReview(teammateRunId, context);
                if (reviewGateResult) {
                  finalText += reviewGateResult;
                }

                // Record the CLI session id so a future resume_id can
                // continue this conversation. Skip on resume — the
                // session id is already on file. Skip on opencode
                // (not yet supported).
                //
                // Records on BOTH completed AND failed runs (kimi
                // review): a CLI may exit non-zero but still have
                // written a session file the user wants to resume,
                // and our resume validation explicitly allows
                // resuming FAILED runs. Skipping on failure created a
                // gap where `resume_id` errored with "no recorded
                // session" for legitimate FAILED-run resumes.
                //
                // Emitted BEFORE the runtime state update (kimi
                // review): if the api crashes between the event
                // emission and the runtime update, the runtime stays
                // RUNNING (will heartbeat-timeout and retry) but the
                // session id is preserved; emitting after would lose
                // the session id permanently if the api crashed
                // mid-write.
                if (!cliResumeSessionId && isResumableRuntime) {
                  try {
                    const { detectCliSessionId } = await import("../../cli-session-tracker");
                    const sessionId = await detectCliSessionId({
                      runtime: runtimeType as "codex" | "claude-code" | "opencode",
                      workspaceDir: teammateWorkspaceDir,
                      ...(runtimeType === "codex" && cliEnv?.MAGISTER_CODEX_HOME
                        ? { codexHome: cliEnv.MAGISTER_CODEX_HOME }
                        : {}),
                      ...(runtimeType === "codex" && process.env.MAGISTER_CODEX_HOME
                        ? { codexHome: process.env.MAGISTER_CODEX_HOME }
                        : {}),
                      spawnStartMs,
                    });
                    if (sessionId) {
                      await context.recordEvent({
                        type: "leader.cli_session_recorded",
                        timestamp: new Date().toISOString(),
                        data: {
                          teammateRunId,
                          runtime: runtimeType,
                          cliSessionId: sessionId,
                          finalReason,
                        },
                      });
                    }
                  } catch (err) {
                    console.warn(
                      `[spawn-teammate] CLI session discovery failed for ${runtimeType}/${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  }
                }
              } catch (error) {
                finalReason = "error";
                finalText = error instanceof Error ? error.message : String(error);
              }

              // updateIfStateIn(RUNNING|PENDING): if the cancel route or
              // recovery sweep already flipped this runtime to CANCELLED,
              // don't overwrite — preserving the cancellation audit trail.
              // No-op (0 rows changed) when the prior state was already
              // terminal; downstream completion/event recording still runs
              // because the data still matters for logs.
              await runtimeRepo.updateIfStateIn(teammateRunId, ["RUNNING", "PENDING"], {
                state: finalReason === "completed" ? "COMPLETED" : "FAILED",
                completedAt: new Date(),
                updatedAt: new Date(),
              });

              await context.recordEvent({
                type: "leader.teammate_completed",
                timestamp: new Date().toISOString(),
                // UI display path; not the
                // leader's tool_result. 50KB matches the projector's
                // MAX_SUMMARY_LENGTH so users see the full artifact.
                // 2026-05-19: include CLI usage stats so the chat's
                // spawn_teammate chip can render "→ Coder · 3.4K / 287"
                // inline without a separate /tasks/:id/usage fetch.
                data: {
                  teammateRunId,
                  reason: finalReason,
                  summary: finalText.slice(0, 50_000),
                  ...(capturedUsage ? { usage: capturedUsage } : {}),
                },
              });

              await releaseTeammateStatusBestEffort(finalReason === "completed" ? "idle" : "error");
              return { finalText, finalReason };
            } finally {
              cleanupTeammateWorktreeBestEffort();
            }
          };

          if (args.wait === false) {
            const asyncCliSpawnMs = Date.now();
            registerActiveAsyncTeammate(context.taskId, teammateRunId);
            const teammatePromise = runCliTeammate()
              .then(async ({ finalText: ft, finalReason: fr }) => {
                // Inject completion mailbox and wake the leader after the
                // async CLI teammate finishes, so the leader's next turn
                // can process the result without polling.
                try {
                  const { writeTeammateCompletionMailbox, reenqueueLeaderIfAwaiting } = await import(
                    "../teammate-completion-service"
                  );
                  const completedAtMs = Date.now();
                  // Re-read the runtime row to detect external cancellation
                  // (cancel route flipped state to CANCELLED while we were
                  // running). updateIfStateIn above wouldn't have downgraded
                  // back to COMPLETED, so the runtime row tells the truth.
                  const finalRuntime = await runtimeRepo.getById(teammateRunId);
                  const externallyCancelled = finalRuntime?.state === "CANCELLED";
                  // Aggregate token usage by querying recorded calls
                  // keyed on this teammate's runId. Same approach as the
                  // UCM async branch so observability stays consistent.
                  let usage: { inputTokens: number; outputTokens: number } | undefined;
                  try {
                    const { createDb, tokenUsageRecords } = await import("@magister/db");
                    const { eq, sql } = await import("@magister/db");
                    const db = createDb();
                    const [agg] = await db
                      .select({
                        input: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
                        output: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
                      })
                      .from(tokenUsageRecords)
                      .where(eq(tokenUsageRecords.runId, teammateRunId));
                    if (agg && (agg.input > 0 || agg.output > 0)) {
                      usage = { inputTokens: agg.input, outputTokens: agg.output };
                    }
                  } catch {
                    // ignore — usage is observability, not correctness
                  }
                  await writeTeammateCompletionMailbox({
                    parentTaskId: context.taskId,
                    teammateRunId,
                    role: roleId,
                    status: externallyCancelled
                      ? "CANCELLED"
                      : fr === "completed" ? "COMPLETED" : fr === "cancelled" ? "CANCELLED" : "FAILED",
                    summary: ft.slice(0, 50_000),
                    spawnedAtMs: asyncCliSpawnMs,
                    completedAtMs,
                    parallelGroupId: finalRuntime?.parallelGroupId ?? null,
                    ...(usage ? { usage } : {}),
                  });
                  await reenqueueLeaderIfAwaiting(context.taskId);
                } catch (err) {
                  console.warn(
                    `[spawn-teammate] Completion injection failed for ${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              })
              .finally(() => unregisterActiveAsyncTeammate(context.taskId, teammateRunId));
            teammatePromise.catch(() => {});
            return {
              data: JSON.stringify({
                teammateRunId,
                status: "spawned",
                role: roleId,
              }),
            };
          }

          const { finalText } = await runCliTeammate();
          // 2026-05-12 phase 4 — when an evaluator returns to a
          // goal-mode parent, parse + persist the verdict so
          // mark_goal_complete can gate on a fresh READY.
          await maybeRecordEvaluatorVerdict(roleId, context.taskId, finalText);
          // leader-context cap. The
          // sync spawn path injects `finalText` directly into the
          // leader's tool_result; previously unbounded → could blow
          // up context. 16KB ≈ 4k tokens; beyond that the leader
          // calls `read_teammate_transcript` for the full text.
          return {
            data: capLeaderTeammateText(finalText, parentToolUseId, roleId, context.taskId)
              || `Teammate ${roleId} completed.`,
          };
        }

        const maxTurns = typeof profile?.maxTurns === "number" ? profile.maxTurns : 60;
        const systemPromptOverride = profile?.systemPromptOverride?.trim();
        const toolProfile = profile?.toolProfile;
        // Skills must be appended in EVERY branch — earlier draft only
        // did it for the builtin path, which silently dropped skills
        // when the user had `systemPromptOverride` set OR when the
        // agent was custom (non-builtin) without provider configured.
        // `appendAgentSkills` is best-effort; degrades to base on
        // DB / lookup failure so spawn never breaks here.
        const defaultSystemPrompt = systemPromptOverride
          ? await appendAgentSkills(roleId, systemPromptOverride)
          : isBuiltinRole
            ? await getBuiltinSystemPromptWithSkills(roleId)
            : await appendAgentSkills(roleId, buildCustomAgentFallbackPrompt(roleId, profile));
        let systemPrompt = defaultSystemPrompt;
        let teammateCallModel = context.callModel;
        let teammateContextWindow: number | undefined;
        let teammateMaxOutputTokens: number | undefined;
        let teammateModelOverride = modelOverride;

        try {
          const agentConfig = await resolveAgentForRole(args.role);
          if (
            agentConfig &&
            agentConfig.runtimeType === "ucm" &&
            agentConfig.provider &&
            agentConfig.modelName.trim().length > 0
          ) {
            const teammateApiConfig = buildApiConfigFromResolvedAgent(roleId, agentConfig);
            teammateContextWindow = teammateApiConfig.contextWindow;
            teammateMaxOutputTokens = teammateApiConfig.maxOutputTokens;
            teammateModelOverride = undefined;
            teammateCallModel = async function* (callParams) {
              yield* callStreamingApi(
                {
                  messages: callParams.messages,
                  systemPrompt: callParams.systemPrompt,
                  model: callParams.model ?? teammateApiConfig.model.modelName,
                  signal: callParams.signal,
                  tools: callParams.tools,
                  ...(typeof callParams.maxOutputTokens === "number"
                    ? { maxOutputTokens: callParams.maxOutputTokens }
                    : {}),
                },
                teammateApiConfig,
              );
            };

            const agentInstructions = agentConfig.agent.systemPromptOverride;
            if (typeof agentInstructions === "string" && agentInstructions.trim().length > 0) {
              // User-configured override wins. Skills still need to be
              // appended so a custom prompt doesn't silently lose the
              // skill content the user wired up via Settings → Skills.
              systemPrompt = await appendAgentSkills(roleId, agentInstructions.trim());
            } else if (isBuiltinRole) {
              // Earlier path used the bare prompt here, which silently
              // dropped attached skills when the agent was Magister-runtime
              // configured. Use the with-skills variant in both paths.
              systemPrompt = await getBuiltinSystemPromptWithSkills(roleId);
            }
          }
        } catch (err) {
          console.warn(`[spawn-teammate] Failed to resolve agent for role "${args.role}", falling back:`, err instanceof Error ? err.message : String(err));
        }

        if (!teammateCallModel) {
          cleanupTeammateWorktreeBestEffort();
          await runtimeRepo.update(teammateRunId, {
            state: "FAILED",
            completedAt: new Date(),
            updatedAt: new Date(),
          });
          await releaseTeammateStatusBestEffort("error");
          return { data: "Error: no callModel available for teammate" };
        }

        const teammateRoleId = args.role?.trim() || "";
        const allTools = createLeaderTools(teammateWorkspaceDir, tavilyConfig, undefined, {
          ...(teammateRoleId ? { callerRoleId: teammateRoleId } : {}),
        });
        // Phase 3: teammates also see role-filtered MCP tools. Without
        // this, a coder agent that has a github MCP server attached via
        // Settings → Agents would receive zero MCP tools at spawn time —
        // per-agent attachment would be meaningless. The teammate's role
        // id drives the filter; if no role id is passed (some smoke
        // dispatches do this), MCP tools are skipped entirely.
        const { getMcpPool } = await import("../../mcp-pool-service");
        const mcpPool = getMcpPool();
        const allToolsWithMcp = teammateRoleId
          ? [...allTools, ...(await mcpPool.listToolsForRole(teammateRoleId))]
          : allTools;
        const baseTeammateTools = toolProfile && isValidToolProfileId(toolProfile)
          ? filterToolsByProfile(allToolsWithMcp, toolProfile)
          : await getTeammateTools(teammateWorkspaceDir, tavilyConfig, teammateRoleId || undefined);
        const teammateTools = applyPerAgentToolRestrictions(baseTeammateTools, profile, {
          enforceTeammateInvariants: true,
        });

        // ---------- helper: run the teammate loop to completion ----------
        const runTeammateLoop = async () => {
          let finalText = "";
          let finalReason = "completed";
          let finalTurnCount = 0;

          try {
            const { LeaderSessionStore } = await import("../../leader-session-store");
            const teammateSessionStore = new LeaderSessionStore();

            // Inherit ALL the parent task's attachments (task-wide,
            // not just the leader's current turn). Without task-wide
            // scope, a teammate spawned on turn N can't see a file
            // the user uploaded on turn 1 — the attachment is keyed
            // by the upload's requestId, but the spawn runs under a
            // later turn's requestId. The loader dedupes by sha256
            // so repeat uploads aren't duplicated. Failures (corrupt
            // upload, missing file) degrade silently to text-only
            // via the loader's own try/catch.
            const { loadAttachmentBlocksForTask } = await import("../../attachment-service");
            const parentBlocks = await loadAttachmentBlocksForTask(
              context.taskId,
            ).catch(() => []);
            const goalAsUserMessage =
              parentBlocks.length > 0
                ? {
                    type: "user" as const,
                    content: [
                      { type: "text" as const, text: goalForTeammate },
                      ...parentBlocks,
                    ],
                  }
                : { type: "user" as const, content: goalForTeammate };

            // Resume seeds the loop with the prior checkpoint's messages
            // (cast to the LeaderMessage union — checkpoints originate
            // from the same loop so the shape matches by construction)
            // followed by a fresh user message carrying the new goal.
            // Without resume, start with just the goal as a user message.
            const seedMessages = resumedMessages
              ? [...(resumedMessages as Parameters<typeof leaderLoop>[0]["messages"]), goalAsUserMessage]
              : [goalAsUserMessage];

            // Cross-CLI coordination (decisions doc §253-263): the
            // teammate inherits the leader's <memories> block so it
            // sees the same accumulated facts + the parent task's
            // scratchpad. Same task scope → same scratchpad. Cap-
            // aware: appendMemoryBlockForTeammate degrades silently
            // when the memory runtime isn't initialized.
            const { appendMemoryBlockForTeammate } = await import(
              "../teammate-system-prompts"
            );
            const teammateSystemPromptWithMemory = await appendMemoryBlockForTeammate(
              systemPrompt,
              context.taskId,
            );

            const gen = leaderLoop({
              messages: seedMessages,
              systemPrompt: teammateSystemPromptWithMemory,
              workspaceDir: teammateWorkspaceDir,
              taskId: context.taskId,
              runId: teammateRunId,
              roleId,
              requestId: context.requestId,
              tools: teammateTools,
              maxTurns,
              ...(teammateModelOverride ? { modelOverride: teammateModelOverride } : {}),
              ...(typeof teammateContextWindow === "number"
                ? { contextWindow: teammateContextWindow }
                : {}),
              ...(typeof teammateMaxOutputTokens === "number"
                ? { maxOutputTokens: teammateMaxOutputTokens }
                : {}),
              abortController: context.abortController,
              recordEvent: teammateRecordEvent,
              callModel: teammateCallModel,
              sessionId: teammateRunId,
              onCheckpoint: async (data) => {
                await teammateSessionStore.writeCheckpoint({
                  sessionId: data.sessionId,
                  taskId: context.taskId,
                  runId: teammateRunId,
                  // Teammate runs are scoped to the parent leader's current
                  // request — share the same requestId so events grouped on
                  // the client by requestId capture the full conversation.
                  requestId: context.requestId,
                  turnCount: data.turnCount,
                  messages: data.messages,
                });
              },
            });

            let result = await gen.next();
            while (!result.done) {
              const msg = result.value;
              if (msg.type === "assistant") {
                for (const block of (msg as any).content) {
                  if (block.type === "text") {
                    finalText = block.text;
                  }
                }
              }
              result = await gen.next();
            }

            finalReason = result.value?.reason ?? "completed";
            finalTurnCount = result.value?.turnCount ?? 0;

            // Extract final text from checkpoint if not captured from yields
            if (!finalText) {
              const { LeaderSessionStore: LSS } = await import("../../leader-session-store");
              const store = new LSS();
              const cp = await store.getLatestCheckpoint(teammateRunId);
              if (cp?.messages) {
                // Collect ALL assistant text (last one wins as primary answer)
                const allTexts: string[] = [];
                for (const m of cp.messages) {
                  if (m.type === "assistant") {
                    const blocks = (m as any).content;
                    if (Array.isArray(blocks)) {
                      for (const b of blocks) {
                        if (b.type === "text" && b.text) allTexts.push(b.text);
                      }
                    }
                  }
                }
                finalText = allTexts[allTexts.length - 1] ?? "";

                // If still empty (e.g., max_turns with only tool calls),
                // summarize what tools were called
                if (!finalText && finalReason === "max_turns") {
                  const toolCalls = cp.messages
                    .filter((m: any) => m.type === "assistant")
                    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
                    .filter((b: any) => b.type === "tool_use")
                    .map((b: any) => b.name);
                  finalText = `Teammate ${roleId} reached max turns (${finalTurnCount}). Tools used: ${[...new Set(toolCalls)].join(", ") || "none"}.`;
                }
              }
            }
          } catch (error) {
            finalReason = "error";
            finalText = error instanceof Error ? error.message : String(error);
          } finally {
            try {
              await createRuntimeSafeApplyReviewDraft({
                taskId: context.taskId,
                roleRuntimeId: teammateRunId,
                parentWorkspaceDir: context.workspaceDir,
                runtimeWorkspaceDir: teammateWorkspaceDir,
                baseRevision: teammateBaseRevision,
                runtimeSecurity: buildUcmRuntimeSecurity({
                  runtimeWorkspaceStrategy: isolatedWorktreeCreated ? "git_worktree" : "workspace_root",
                }),
                observedEvents: observedTeammateEvents,
              });
            } catch (err) {
              console.warn(
                `[safe-apply] review draft failed for teammate ${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }

            const reviewGateResult = await blockOnPendingReview(teammateRunId, context);
            if (reviewGateResult) {
              finalText += reviewGateResult;
            }

            cleanupTeammateWorktreeBestEffort();
          }

          // updateIfStateIn: don't overwrite CANCELLED with COMPLETED.
          // See CLI teammate path for full reasoning.
          await runtimeRepo.updateIfStateIn(teammateRunId, ["RUNNING", "PENDING"], {
            state: finalReason === "completed" ? "COMPLETED" : "FAILED",
            completedAt: new Date(),
            updatedAt: new Date(),
          });

          // surface Magister teammate's token usage on the
          // chat spawn_teammate chip. Sum `token_usage_records` rows
          // scoped to this teammate's `runId` (recordUsage in the
          // autonomous-loop already wrote each turn's row). Best-
          // effort; missing aggregate just hides the chip.
          let teammateUsage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          } | null = null;
          try {
            const { createDb } = await import("@magister/db");
            const { tokenUsageRecords } = await import("@magister/db");
            const { eq, sql } = await import("@magister/db");
            const db = createDb();
            const [agg] = await db
              .select({
                inputSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
                outputSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
                cacheReadSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.cacheReadTokens}), 0)`,
                cacheWriteSum: sql<number>`COALESCE(SUM(${tokenUsageRecords.cacheWriteTokens}), 0)`,
              })
              .from(tokenUsageRecords)
              .where(eq(tokenUsageRecords.runId, teammateRunId));
            if (agg && (agg.inputSum > 0 || agg.outputSum > 0)) {
              teammateUsage = {
                inputTokens: agg.inputSum,
                outputTokens: agg.outputSum,
                ...(agg.cacheReadSum > 0 ? { cacheReadTokens: agg.cacheReadSum } : {}),
                ...(agg.cacheWriteSum > 0 ? { cacheWriteTokens: agg.cacheWriteSum } : {}),
              };
            }
          } catch (err) {
            console.warn(
              `[teammate-usage] aggregate failed for ${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await context.recordEvent({
            type: "leader.teammate_completed",
            timestamp: new Date().toISOString(),
            // UI display cap (50KB).
            data: {
              teammateRunId,
              reason: finalReason,
              turnCount: finalTurnCount,
              summary: finalText.slice(0, 50_000),
              ...(teammateUsage ? { usage: teammateUsage } : {}),
            },
          });

          await releaseTeammateStatusBestEffort(finalReason === "completed" ? "idle" : "error");

          return { finalText, finalReason };
        };

        // ---------- async (non-blocking) spawn ----------
        if (args.wait === false) {
          const asyncUcmSpawnMs = Date.now();
          registerActiveAsyncTeammate(context.taskId, teammateRunId);
          const teammatePromise = runTeammateLoop()
            .then(async ({ finalText: ft, finalReason: fr }) => {
              // Inject completion mailbox and wake the leader after the
              // async Magister teammate finishes, so the leader's next
              // turn can process the result without polling.
              try {
                const { writeTeammateCompletionMailbox, reenqueueLeaderIfAwaiting } = await import(
                  "../teammate-completion-service"
                );
                const completedAtMs = Date.now();
                // Detect external cancellation (cancel route ran while we
                // were executing). updateIfStateIn at line 3879 preserves
                // CANCELLED — re-read to surface the real status in the
                // completion event.
                const finalRuntime = await runtimeRepo.getById(teammateRunId);
                const externallyCancelled = finalRuntime?.state === "CANCELLED";
                // Aggregate token usage for this teammate by querying the
                // per-call records keyed on its runId. Best-effort: if the
                // sum fails we just lose observability for this teammate.
                let usage: { inputTokens: number; outputTokens: number } | undefined;
                try {
                  const { createDb, tokenUsageRecords } = await import("@magister/db");
                  const { eq, sql } = await import("@magister/db");
                  const db = createDb();
                  const [agg] = await db
                    .select({
                      input: sql<number>`COALESCE(SUM(${tokenUsageRecords.inputTokens}), 0)`,
                      output: sql<number>`COALESCE(SUM(${tokenUsageRecords.outputTokens}), 0)`,
                    })
                    .from(tokenUsageRecords)
                    .where(eq(tokenUsageRecords.runId, teammateRunId));
                  if (agg && (agg.input > 0 || agg.output > 0)) {
                    usage = { inputTokens: agg.input, outputTokens: agg.output };
                  }
                } catch {
                  // ignore — usage is observability, not correctness
                }
                await writeTeammateCompletionMailbox({
                  parentTaskId: context.taskId,
                  teammateRunId,
                  role: roleId,
                  status: externallyCancelled
                    ? "CANCELLED"
                    : fr === "completed" ? "COMPLETED" : fr === "cancelled" ? "CANCELLED" : "FAILED",
                  summary: ft.slice(0, 50_000),
                  spawnedAtMs: asyncUcmSpawnMs,
                  completedAtMs,
                  parallelGroupId: finalRuntime?.parallelGroupId ?? null,
                  ...(usage ? { usage } : {}),
                });
                await reenqueueLeaderIfAwaiting(context.taskId);
              } catch (err) {
                console.warn(
                  `[spawn-teammate] Completion injection failed for ${teammateRunId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            })
            .finally(() => unregisterActiveAsyncTeammate(context.taskId, teammateRunId));
          // Swallow unhandled rejection — completion is persisted to
          // the runtime record; injector failures are logged above.
          teammatePromise.catch(() => {});

          return {
            data: JSON.stringify({
              teammateRunId,
              status: "spawned",
              role: roleId,
            }),
          };
        }

        // ---------- synchronous (blocking) spawn (default) ----------
        const { finalText, finalReason } = await runTeammateLoop();
        // 2026-05-12 phase 4 — same evaluator-verdict hook as the
        // CLI path: parse + record so mark_goal_complete can gate.
        await maybeRecordEvaluatorVerdict(roleId, context.taskId, finalText);
        // cap leader-facing tool_result.
        const capped = capLeaderTeammateText(finalText, parentToolUseId, roleId, context.taskId);
        return { data: capped || `Teammate ${roleId} completed with reason: ${finalReason}` };
      },
  };
}

function buildSpawnTeammatesBatchTool(opts?: SpawnTeammateToolOpts): LeaderTool {
  return {
    name: "spawn_teammates",
    description: SPAWN_TEAMMATES_DESCRIPTION,
    inputSchema: SpawnTeammatesInputSchema,
    // Concurrency-safe only when EVERY task runs isolated — a task with
    // isolate:false spawns a background teammate that writes the leader
    // workspace, which must not race a sibling tool in the same turn.
    isConcurrencySafe: (args) =>
      Array.isArray(args?.tasks) &&
      args.tasks.length > 0 &&
      args.tasks.every((t: { isolate?: boolean }) => (t?.isolate ?? true) === true),
    isReadOnly: () => false,
    isPlanSafe: () => false,
    async call(
      args: {
        tasks: Array<{
          role: string;
          goal: string;
          isolate?: boolean;
          expected_output?: string;
        }>;
      },
      context: LeaderToolUseContext,
    ) {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      if (tasks.length === 0) {
        return { data: "Error: spawn_teammates requires at least one task." };
      }

      // Deterministic group id — links the cohort. The trailing `_<N>`
      // encodes the EXPECTED member count (tasks.length) so the group
      // completion check can require the full cohort to exist before
      // firing, instead of firing on a partially-created group. The count
      // is a structural fact, NOT parsed from leader prose.
      const parallelGroupId = `pg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${tasks.length}`;
      // Forward the SAME opts (incl. tavilyConfig) so teammates spawned
      // via the batch tool keep web_search/tavily configuration.
      const single = buildSpawnTeammateTool(opts);

      const settled = await Promise.all(
        tasks.map(async (t) => {
          try {
            // Reuse the full single-spawn machinery. Force background
            // (wait:false) so we return fast and completions arrive via
            // the existing mailbox path; default isolate:true so parallel
            // writes never race. Pass `parallelGroupId` so it is stamped at
            // row-CREATION time (closes the null-stamp race) rather than
            // post-hoc after the background promise has launched.
            const res = await single.call(
              {
                role: t.role,
                goal: t.goal,
                wait: false,
                isolate: t.isolate ?? true,
                parallelGroupId,
                ...(t.expected_output ? { expected_output: t.expected_output } : {}),
              },
              context,
            );
            // Background spawns return { data: JSON.stringify({ teammateRunId, status, role }) }.
            const rawData = String(res.data ?? "");
            let teammateRunId: string | undefined;
            try {
              const parsed = JSON.parse(rawData) as { teammateRunId?: unknown };
              if (parsed && typeof parsed.teammateRunId === "string") {
                teammateRunId = parsed.teammateRunId;
              }
            } catch {
              // Non-JSON data => an error string from the single tool
              // (e.g. unknown role). Surface it as a failure for this task.
            }
            if (!teammateRunId) {
              return { role: t.role, ok: false as const, error: rawData };
            }
            return { role: t.role, ok: true as const, teammateRunId };
          } catch (err) {
            return {
              role: t.role,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      const spawned = settled
        .filter((s) => s.ok)
        .map((s) => ({ role: s.role, teammateRunId: (s as { teammateRunId: string }).teammateRunId }));
      const failed = settled
        .filter((s) => !s.ok)
        .map((s) => ({ role: s.role, error: (s as { error: string }).error }));

      await context.recordEvent({
        type: "leader.teammate_batch_spawned",
        timestamp: new Date().toISOString(),
        data: {
          parallelGroupId,
          expectedCount: tasks.length,
          spawnedCount: spawned.length,
          failedCount: failed.length,
          ...(context.currentToolUseId ? { parentToolUseId: context.currentToolUseId } : {}),
        },
      });

      return {
        data: JSON.stringify({
          parallel_group_id: parallelGroupId,
          expected_count: tasks.length,
          spawned,
          // No silent truncation: surface every task that failed to spawn.
          // Always present (empty when none) so callers can read failed.length.
          failed,
        }),
      };
    },
  };
}

export function createLeaderTools(
  _workspaceDir: string,
  tavilyConfig?: {
    enabled: boolean;
    apiKey?: string;
    baseUrl: string;
    timeoutSeconds: number;
  },
  profileId?: ToolProfileId,
  opts?: {
    spawnTeammateDescription?: string;
    /**
     * Optional leader-bash sandbox context. When set and execution
     * sandboxing is configured, the bash tool wraps `/bin/bash -c`
     * through the shared bubblewrap planner with the main workspace
     * read-only and the current runtime workspace writable.
     */
    bashSandbox?: LeaderBashSandboxOptions;
    /**
     * The role id of the agent these tools belong to. Used by
     * `load_skill` to scope skill resolution to that agent's
     * `agent_skills` bindings — otherwise any agent could load any
     * skill regardless of who the user attached it to. Defaults to
     * `"leader"` when unset, matching the runtime that built this
     * adapter for the leader loop. Teammate spawn paths set this
     * to the teammate's role id.
     */
    callerRoleId?: string;
  },
): LeaderTool[] {
  const callerRoleId = opts?.callerRoleId ?? "leader";
  const tools: LeaderTool[] = [
    {
      name: "bash",
      aliases: ["shell", "cmd"],
      description:
        "Run a bash command in the workspace directory. Default timeout 5 minutes — "
        + "for legitimate long operations (full test suites, large builds), pass an "
        + "explicit `timeout` in milliseconds (capped at 30 min). Anything longer "
        + "should be split.\n\n"
        + "**CRITICAL — backgrounding a long-running process:** if you want to start "
        + "something that survives this bash call (e.g. a dev server you'll curl in "
        + "a follow-up command), you MUST detach stdio explicitly or this tool will "
        + "hang. The shell waits for any child holding stdout/stderr open even after "
        + "`&`, so `nohup cmd > /tmp/log 2>&1 &` is NOT enough — the child inherits "
        + "the parent's pipes via the shell itself. Correct pattern:\n"
        + "    nohup setsid cmd > /tmp/log 2>&1 < /dev/null &\n"
        + "`setsid` puts the child in a new session (detaches from this shell's "
        + "process group), `< /dev/null` closes stdin, and explicit redirection of "
        + "stdout+stderr closes those fds. Verify with `disown` if needed.\n\n"
        + "If you forget this, the bash call will run to the full timeout and the "
        + "leader will see a `Tool 'bash' timed out` result — no work lost, but "
        + "wasted budget. Better: never use this tool to start a server you don't "
        + "intend to kill in the same call.",
      inputSchema: BashInputSchema,
      defaultTimeoutMs: 5 * 60 * 1000, // 5 min — accommodates build/test runs
      acceptsTimeoutOverride: true,

      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      // Bash in plan mode: dynamic classifier scans the command for
      // a read-only allowlist + write-pattern deny list. See
      // `plan-mode-bash-classifier.ts` and spec §8.2.
      isPlanSafe: (args) => isReadOnlyBashCommand(args.command),
      call: async (args, context) => {
        // Spec §1 — sandbox escalation decision pipeline.
        //   (1) score the command via the risk-classifier
        //   (2) CRITICAL → hard-block, never executes
        //   (3) HIGH (model requested escalation) → consult persistent
        //       rules; on miss request approval; on approve persist
        //       a rule if user opted in
        //   (4) MEDIUM (the common case) → existing isDangerousCommand
        //       path stays (regex-based safety gate for the
        //       MAGISTER_EXECUTION_SANDBOX_MODE=off scenario)
        const { scoreToolCall } = await import("../../safe-apply/risk-classifier");
        const scoreResult = scoreToolCall({ toolName: "bash", input: args });

        if (scoreResult.riskClass === "CRITICAL") {
          const commandPreview = sanitizeCommandPreview(args.command).slice(0, 200);
          await context.recordEvent({
            type: "leader.tool_blocked_critical",
            timestamp: new Date().toISOString(),
            data: {
              toolName: "bash",
              command: commandPreview,
              lethalLabel: scoreResult.lethalLabel ?? null,
              reason: scoreResult.reason,
            },
          });
          return {
            data: `<tool_use_error>refused: command matches the CRITICAL deny list (${scoreResult.lethalLabel ?? "lethal pattern"}). This shape of command is never executable from Magister. If you genuinely need this, run it manually in a terminal.</tool_use_error>`,
          };
        }

        // Sandbox-elevation v4.3 §4.1 — feature-flagged additional_permissions path.
        // When MAGISTER_PERMISSIONS_V4 is enabled and the model uses
        // `with_additional_permissions`, run the v4 validator (canonicalize +
        // deny-list + char whitelist + sum cap + access:none strip).
        // Validation errors return as tool_use_error; valid profile flows into
        // the existing HIGH approval path with the additional_permissions payload.
        let v4ValidationResult: Awaited<ReturnType<typeof import("../../safe-apply/additional-permissions").validateAndNormalize>> | null = null;
        const v4Enabled = process.env.MAGISTER_PERMISSIONS_V4 === "on";
        const v4ModeRequested = args.sandbox_permissions === "with_additional_permissions"
          || args.sandbox_permissions === "use_default"
          || args.sandbox_permissions === "default";
        if (v4Enabled && v4ModeRequested && args.additional_permissions) {
          try {
            const { validateAndNormalize } = await import("../../safe-apply/additional-permissions");
            // Map deprecated "default" → "use_default" before passing to validator.
            const normalizedMode = args.sandbox_permissions === "default"
              ? "use_default"
              : args.sandbox_permissions;
            v4ValidationResult = validateAndNormalize({
              raw: args.additional_permissions,
              mode: normalizedMode,
              // classifyOptions for Magister-secrets + workspace .env protection
              // — the bash tool dispatcher knows install dir + workspace
              classifyOptions: {
                ...(process.env.MAGISTER_INSTALL_DIR ? { magisterInstallDir: process.env.MAGISTER_INSTALL_DIR } : {}),
                workspaceRoot: context.workspaceDir,
              },
            });
          } catch (err) {
            const { PermissionValidationError } = await import("../../safe-apply/additional-permissions");
            if (err instanceof PermissionValidationError) {
              return { data: `<tool_use_error>${err.toolUseError}</tool_use_error>` };
            }
            throw err;
          }
        }

        // Hoisted so the extraBinds computation later (auto-inheritance,
        // codex Slice-3 review HIGH Q4a fix) can read the persisted
        // additionalPermissions from a matching rule even though `hit`
        // is only assigned inside the HIGH branch below.
        let hit: import("../../safe-apply/command-rule-matcher").MatchedRule | null = null;

        // v3 compat: existing escalation flow runs for both require_escalated
        // (always) and with_additional_permissions (when v4 flag is on AND
        // validation produced a non-empty profile).
        const v3EscalationRequested = args.sandbox_permissions === "require_escalated";
        const v4WithPermsRequested = v4Enabled
          && args.sandbox_permissions === "with_additional_permissions"
          && v4ValidationResult !== null
          && (v4ValidationResult.profile.file_system !== undefined
              || v4ValidationResult.profile.network !== undefined);
        const sensitiveReadRequested =
          scoreResult.riskClass === "HIGH"
          && scoreResult.reason === "sensitive internal path read requires approval";

        if (scoreResult.riskClass === "HIGH" && (v3EscalationRequested || v4WithPermsRequested || sensitiveReadRequested)) {
          // Validate justification + prefix_rule shape before approval round-trip.
          // v4.3 §4.6: sanitize at source — strips control chars, RTL
          // overrides, zero-width, combining marks, variation selectors,
          // tag chars. Server-side strip is defense at source so even
          // if the client misses a render-time guard the stored payload
          // is clean.
          const { sanitizeJustification } = await import("../../safe-apply/justification-sanitizer");
          const justification = sensitiveReadRequested
            ? "Read sensitive Magister-internal path referenced by this bash command."
            : sanitizeJustification(args.justification);
          if (!justification) {
            const reqMode = v3EscalationRequested ? "require_escalated" : "with_additional_permissions";
            return {
              data: `<tool_use_error>justification is required when sandbox_permissions=\"${reqMode}\". Re-issue the tool call with a one-line reason (what + why).</tool_use_error>`,
            };
          }
          let prefixRule: string[] | undefined;
          if (args.prefix_rule && !sensitiveReadRequested) {
            const { validatePrefixRule } = await import("../../safe-apply/command-rule-matcher");
            const prefixError = validatePrefixRule(args.prefix_rule);
            if (prefixError) {
              return {
                data: `<tool_use_error>invalid prefix_rule: ${prefixError}</tool_use_error>`,
              };
            }
            prefixRule = [...args.prefix_rule];
          }

          // Persistent rule lookup. On hit the command auto-passes —
          // the model can proceed without re-prompting the user.
          const { matchPersistentRule } = await import("../../safe-apply/command-rule-matcher");
          const projectPath = context.workspaceDir;
          hit = sensitiveReadRequested
            ? null
            : await matchPersistentRule("bash", args, projectPath);
          // Task-scoped trust check (codex Slice-3 review BLOCKER Q2 +
          // Q3c fix) — v4 vs v3 take DIFFERENT lookup paths:
          //
          //   v3 path (require_escalated):
          //     wildcard trust matches the broad "*" entry — any
          //     pattern-trusted bash inherits.
          //
          //   v4 path (with_additional_permissions):
          //     SUBSET-AWARE — only skips approval if the model's
          //     requested profile is FULLY COVERED by the union of
          //     active permission grants. A narrow path grant
          //     CANNOT suppress an unrelated require_escalated call.
          const { isTrustedForApproval, findCoveringPermissionGrant } = await import(
            "../../command-approval-service"
          );
          let taskTrusted = false;
          if (sensitiveReadRequested) {
            taskTrusted = false;
          } else if (v4WithPermsRequested && v4ValidationResult) {
            const covered = findCoveringPermissionGrant(
              context.taskId,
              v4ValidationResult.profile,
            );
            taskTrusted = covered !== null;
          } else {
            taskTrusted = isTrustedForApproval(context.taskId, "bash", "*");
          }
          if (!hit && !taskTrusted) {
            // No rule match → request user approval. Metadata carries
            // the proposed prefix_rule + scope so the dialog can offer
            // "Approve once" vs "Approve + save rule" choices.
            const commandPreview = sanitizeCommandPreview(args.command).slice(0, 200);
            const escalationMode = v4WithPermsRequested
              ? "with_additional_permissions"
              : v3EscalationRequested
                ? "require_escalated"
                : "sensitive_read";
            const sensitiveMatches = sensitiveReadRequested
              ? listSensitiveInternalPathMatches(args.command)
              : [];
            // Sandbox-elevation v4.3 §4.1 §4.6 — extend approval payload
            // with structured additional_permissions + deny-read-requested
            // metadata so the C.2-rendered approval card can show paths +
            // sensitivity coloring.
            const approval = await createApproval(
              context.taskId,
              "bash",
              {
                command: commandPreview,
                escalation: {
                  sandbox_permissions: escalationMode,
                  justification,
                  ...(prefixRule && !sensitiveReadRequested ? { proposed_prefix_rule: prefixRule } : {}),
                  proposed_scope: "project" as const,
                  project_path: projectPath,
                  ...(sensitiveReadRequested
                    ? {
                      request_kind: "sensitive_read" as const,
                      sensitive_read: {
                        access: "read" as const,
                        matches: sensitiveMatches,
                        one_time: true,
                      },
                    }
                    : {}),
                  ...(v4ValidationResult
                    && (v4ValidationResult.profile.file_system || v4ValidationResult.profile.network)
                    ? { additional_permissions: v4ValidationResult.profile }
                    : {}),
                  ...(v4ValidationResult && v4ValidationResult.denyReadRequestedButUnsupported.length > 0
                    ? { deny_read_requested_but_unsupported: v4ValidationResult.denyReadRequestedButUnsupported }
                    : {}),
                },
              },
              sensitiveReadRequested
                ? `Sensitive internal path read requested for bash: ${commandPreview}`
                : `Escalation requested for bash: ${commandPreview}\nReason: ${justification}`,
              context.requestId,
            );

            // `createApproval` + `resolveApproval`/`expireApprovalWithTimeout`
            // own the `leader.approval_requested` / `leader.approval_resolved`
            // emits centrally now (so the MCP gate also fires them); no
            // local recordEvent calls — they'd duplicate the WS broadcast
            // and double-decrement the projector's pause counter.
            void sendDangerousCommandApprovalFeishuNotificationBestEffort({
              taskId: context.taskId,
              commandPreview,
              reason: justification,
            });

            const decision = await waitForApproval(approval.id, undefined, context.abortController?.signal);
            if (decision !== "approved") {
              return {
                data: `<tool_use_error>escalation ${decision}: bash command not run. Reason was: ${justification}</tool_use_error>`,
              };
            }
            // V1.1: the approval-resolve route will persist the rule
            // when the user clicks "Approve + save rule". For now we
            // record the metadata on the approval row; rule persistence
            // is a follow-up slice (Settings UI + route + persist step).
          }
          // Either rule-match hit OR user approved → execute. V1.1
          // wires the actual sandbox-bypass for escalated calls;
          // currently the existing executeLeaderBashTool path runs
          // either way and the existing sandbox bind covers MEDIUM.
        } else if (isDangerousCommand(args.command) && !context.planApprovedThisRun) {
          // MEDIUM fallback — existing regex-based danger gate retained
          // so the protocol stays defensive when the model fails to
          // set sandbox_permissions: "require_escalated" for a
          // destructive op the user didn't ask for.
          // Same task-trust check as the escalation branch above —
          // skip the gate when the user has already trusted bash for
          // this task / 5min on a prior approval card.
          const { isTrustedForApproval: isBashTrustedDanger } = await import("../../command-approval-service");
          const dangerTrusted = isBashTrustedDanger(context.taskId, "bash", "*");
          if (!dangerTrusted) {
            const commandPreview = sanitizeCommandPreview(args.command).slice(0, 200);
            const reason = getDangerReason(args.command) ?? "Potentially dangerous operation";
            const approval = await createApproval(
              context.taskId,
              "bash",
              { command: commandPreview },
              `Dangerous bash command: ${commandPreview}\nReason: ${reason}`,
              context.requestId,
            );

            // See escalation branch above — request/resolve emits are
            // owned by command-approval-service for both bash + MCP gates.
            void sendDangerousCommandApprovalFeishuNotificationBestEffort({
              taskId: context.taskId,
              commandPreview,
              reason,
            });

            const decision = await waitForApproval(approval.id, undefined, context.abortController?.signal);
            if (decision !== "approved") {
              return {
                data: `⚠️ Command blocked (${decision}): ${reason}\nCommand: ${commandPreview}`,
              };
            }
          }
        }

        // Sandbox-elevation v4.3 §4.4 (codex Slice-3 review HIGH Q4a fix) —
        // AUTOMATIC INHERITANCE. The effective extraBinds set is the union of:
        //   (a) model's inline validated profile (if with_additional_permissions)
        //   (b) trust-ledger granted profile (from request_permissions)
        //   (c) persistent rule's saved additionalPermissions (if rule hit)
        // (a) gates on v4WithPermsRequested; (b) + (c) apply REGARDLESS of
        // the model's declared mode — that's what spec §4.2 calls
        // "subsequent bash calls automatically inherit those binds".
        // A plain `bash ls` with an active ledger grant still gets the binds.
        let extraBinds: ReadonlyArray<{ path: string; access: "read" | "write" }> | undefined;
        let allowNetwork: boolean | undefined;
        // v4.3 §4.2 (codex+Q1d) — track expired grants for
        // model-visible signal in bash result.
        const expiredGrantsNotice: Array<{ path: string; access: "read" | "write"; expiredAtMs: number }> = [];
        if (v4Enabled) {
          const { findGrantedAdditionalPermissions, consumeExpiredAdditionalPermissionsForTask } = await import(
            "../../command-approval-service"
          );
          // Pull expired grants FIRST (also removes them from ledger so we
          // don't notify twice). Surfaces in tool result below.
          const expired = consumeExpiredAdditionalPermissionsForTask(context.taskId);
          expiredGrantsNotice.push(...expired);
          const ledgerProfile = findGrantedAdditionalPermissions(context.taskId, "bash");
          const ledgerEntries = ledgerProfile?.file_system?.entries ?? [];
          // Inline grants only apply when model explicitly declared the v4 mode
          const inlineEntries = (v4WithPermsRequested && v4ValidationResult)
            ? v4ValidationResult.profile.file_system?.entries ?? []
            : [];
          // Rule-persisted grants apply when the persistent rule matched (hit)
          const ruleEntries = hit?.additionalPermissions?.file_system?.entries ?? [];
          // Union with write-covers-read
          const pathMap = new Map<string, "read" | "write">();
          for (const e of [...inlineEntries, ...ledgerEntries, ...ruleEntries]) {
            const existing = pathMap.get(e.path);
            if (existing === "write") continue;
            pathMap.set(e.path, e.access);
          }
          if (pathMap.size > 0) {
            extraBinds = Array.from(pathMap.entries()).map(([path, access]) => ({ path, access }));
          }
          allowNetwork = Boolean(
            (v4WithPermsRequested && v4ValidationResult?.profile.network?.enabled)
            || ledgerProfile?.network?.enabled
            || hit?.additionalPermissions?.network?.enabled,
          );

          // Sandbox-elevation v4.3 §4.2 (quick win #6) — operator-facing
          // telemetry event with binds-source breakdown so trace panel
          // can answer "why did this bash get these binds". Paths are
          // $HOME-redacted before serialization (spec acceptance #22).
          if (extraBinds || expiredGrantsNotice.length > 0 || allowNetwork !== undefined) {
            const { redactPathEntries } = await import("../../safe-apply/path-redactor");
            await context.recordEvent({
              type: "leader.bash_dispatch",
              timestamp: new Date().toISOString(),
              data: {
                toolName: "bash",
                fromInline: redactPathEntries(inlineEntries),
                fromLedger: redactPathEntries(ledgerEntries),
                fromRule: redactPathEntries(ruleEntries),
                expired: redactPathEntries(
                  expiredGrantsNotice.map((e) => ({ path: e.path, access: e.access })),
                ),
                allowNetwork: allowNetwork === true,
                effectiveBindCount: extraBinds?.length ?? 0,
              },
            });
          }
        }
        const classifyOptions: import("../../safe-apply/path-sensitivity").ClassifyPathOptions | undefined =
          v4Enabled
            ? {
              ...(process.env.MAGISTER_INSTALL_DIR ? { magisterInstallDir: process.env.MAGISTER_INSTALL_DIR } : {}),
              workspaceRoot: context.workspaceDir,
            }
            : undefined;

        const result = await executeLeaderBashTool({
          workspaceDir: context.workspaceDir,
          command: args.command,
          ...(context.abortController?.signal ? { signal: context.abortController.signal } : {}),
          ...(opts?.bashSandbox ? { sandbox: opts.bashSandbox } : {}),
          ...(extraBinds && extraBinds.length > 0 ? { extraBinds } : {}),
          ...(allowNetwork ? { allowNetwork: true } : {}),
          ...(classifyOptions ? { classifyOptions } : {}),
          ...(sensitiveReadRequested ? { approvedInternalPathRead: true } : {}),
        });

        // Sandbox-elevation v4.3 §4.2 (codex+kimi Slice-3 review HIGH Q1d) —
        // append permissionNotices to the bash result so the MODEL sees
        // which permission grants expired before this call. Spec promises
        // the model this signal; without it the system-prompt addendum
        // is making a promise the runtime never keeps. Appended as a
        // trailing structured block so it doesn't disrupt parsing of
        // typical bash output (most tooling ignores trailing JSON blocks).
        if (expiredGrantsNotice.length > 0) {
          const notice = {
            grantsExpired: expiredGrantsNotice,
            message:
              "One or more permission grants for this task expired before this bash call ran. "
              + "Affected paths are listed above. If you still need access, call request_permissions to re-establish them.",
          };
          const noticeBlock = `\n\n[PERMISSION NOTICES] ${JSON.stringify(notice)}\n`;
          return { data: (typeof result === "string" ? result : String(result)) + noticeBlock };
        }
        return { data: result };
      },
    },
    // Sandbox-elevation v4.3 §4.2 — `request_permissions` standalone tool.
    // Behind MAGISTER_PERMISSIONS_V4=on feature flag.
    {
      name: "request_permissions",
      aliases: [],
      description:
        "Request additional filesystem or network permissions from the user. "
        + "Granted permissions apply automatically to LATER bash calls in this "
        + "task — you do NOT need to re-declare `additional_permissions` on every "
        + "follow-up bash. Use this when a multi-step task will need elevation N "
        + "times: batching the request once is better UX than asking before each "
        + "command. The user can also grant for just this turn or for the rest of "
        + "the session. Returns `{ permissions, scope, strict_auto_review, partial }`.",
      inputSchema: RequestPermissionsInputSchema,
      defaultTimeoutMs: 5 * 60 * 1000,
      acceptsTimeoutOverride: false,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args, context) => {
        if (process.env.MAGISTER_PERMISSIONS_V4 !== "on") {
          return {
            data: `<tool_use_error>request_permissions is gated by MAGISTER_PERMISSIONS_V4=on; not available in this deployment</tool_use_error>`,
          };
        }
        // Validate + normalize the permission profile (same pipeline as
        // bash with_additional_permissions).
        const { validateAndNormalize, PermissionValidationError } = await import(
          "../../safe-apply/additional-permissions"
        );
        let normalized;
        try {
          normalized = validateAndNormalize({
            raw: args.permissions,
            mode: "with_additional_permissions",
            classifyOptions: {
              ...(process.env.MAGISTER_INSTALL_DIR ? { magisterInstallDir: process.env.MAGISTER_INSTALL_DIR } : {}),
              workspaceRoot: context.workspaceDir,
            },
          });
        } catch (err) {
          if (err instanceof PermissionValidationError) {
            return { data: `<tool_use_error>${err.toolUseError}</tool_use_error>` };
          }
          throw err;
        }

        // Sanitize the reason (same XSS / prompt-injection defenses as
        // bash justification).
        const { sanitizeJustification } = await import("../../safe-apply/justification-sanitizer");
        const reason = sanitizeJustification(args.reason);
        if (!reason) {
          return {
            data: `<tool_use_error>reason is required for request_permissions — provide a one-line description of WHY you need these permissions</tool_use_error>`,
          };
        }

        // Build approval payload + create approval.
        const commandPreview = `request_permissions: ${reason}`;
        const approval = await createApproval(
          context.taskId,
          "bash", // Reuse bash approval lane — same payload shape, same UI card.
          {
            command: commandPreview,
            escalation: {
              sandbox_permissions: "with_additional_permissions" as const,
              justification: reason,
              ...(normalized.profile.file_system
                ? { additional_permissions: normalized.profile }
                : {}),
              ...(normalized.profile.network
                ? { additional_permissions: normalized.profile }
                : {}),
              ...(normalized.denyReadRequestedButUnsupported.length > 0
                ? { deny_read_requested_but_unsupported: normalized.denyReadRequestedButUnsupported }
                : {}),
              proposed_scope: "project" as const,
              project_path: context.workspaceDir,
              // Marker so the resolve route knows this is a batch grant
              // (not an inline bash gate) — UI shows scope picker.
              request_kind: "request_permissions" as const,
            },
          },
          `Permission grant requested: ${reason}`,
          context.requestId,
        );

        const decision = await waitForApproval(approval.id, undefined, context.abortController?.signal);
        if (decision !== "approved") {
          return {
            data: `<tool_use_error>request_permissions ${decision} — pick a different approach or proceed without elevation</tool_use_error>`,
          };
        }

        // Resolved approved — return the granted profile + ACTUAL scope
        // (codex+kimi Slice-3 review HIGH Q1a fix). Read the trust
        // ledger's covering entry expiry; map to a scope label:
        //   - expiry > Date.now() + 1h → "task" (user picked "Trust for task")
        //   - expiry < Date.now() + 1h → "turn" (5-min trust)
        //   - null                      → "turn" (no trust written)
        const grantedProfile = normalized.profile;
        const { findCoveringPermissionGrantExpiry } = await import("../../command-approval-service");
        const expiry = findCoveringPermissionGrantExpiry(context.taskId, grantedProfile);
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const actualScope: "turn" | "task" | "session" =
          expiry !== null && expiry > Date.now() + ONE_HOUR_MS ? "task" : "turn";
        const result = {
          permissions: grantedProfile,
          scope: actualScope,
          strict_auto_review: false,
          partial: false,
        };
        return { data: JSON.stringify(result, null, 2) };
      },
    },
    {
      name: "read_file",
      aliases: ["read"],
      inputSchema: ReadFileInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args, context) => {
        const result = await executeReadFileTool({
          workspaceDir: context.workspaceDir,
          path: args.path,
          startLine: args.startLine,
          endLine: args.endLine,
        });
        return { data: result };
      },
    },
    {
      name: "list_dir",
      aliases: ["ls", "glob"],
      inputSchema: ListDirInputSchema,
      defaultTimeoutMs: 15_000,
      isConcurrencySafe: () => true,
      isPlanSafe: () => true,
      isReadOnly: () => true,
      call: async (args, context) => {
        const result = await executeListDirTool({
          workspaceDir: context.workspaceDir,
          path: args.path ?? ".",
        });
        return { data: result };
      },
    },
    {
      name: "grep",
      aliases: ["search"],
      inputSchema: GrepRepoInputSchema,
      defaultTimeoutMs: 60_000,
      isConcurrencySafe: () => true,
      isPlanSafe: () => true,
      isReadOnly: () => true,
      call: async (args, context) => {
        const result = await executeGrepRepoTool({
          workspaceDir: context.workspaceDir,
          query: args.query,
          path: args.path,
        });
        return { data: result };
      },
    },
    {
      name: "web_search",
      aliases: ["search_web", "search"],
      inputSchema: WebSearchInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args) => {
        // Use Tavily web search
        const envKey = process.env.MAGISTER_TAVILY_WEB_SEARCH_API_KEY ?? process.env.TAVILY_API_KEY;
        const resolvedConfig = tavilyConfig?.apiKey ? tavilyConfig : envKey ? {
          enabled: true,
          apiKey: envKey,
          baseUrl: "https://api.tavily.com/search",
          timeoutSeconds: 30,
        } : null;
        if (!resolvedConfig) {
          return { data: { results: [], answer: "Web search is not configured. Set MAGISTER_TAVILY_WEB_SEARCH_API_KEY." } };
        }
        const result = await executeWebSearchTool({
          query: args.query,
          maxResults: args.maxResults,
          tavilyConfig: resolvedConfig,
        });
        return { data: result };
      },
    },
    {
      name: "web_fetch",
      aliases: ["fetch", "curl"],
      inputSchema: WebFetchInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args) => {
        if (!tavilyConfig?.enabled || !tavilyConfig.apiKey) {
          return {
            data: {
              url: args.url,
              title: null,
              excerpt: "Web fetch requires Tavily API configuration.",
            },
          };
        }
        const result = await executeWebFetchTool({
          url: args.url,
          tavilyConfig,
        });
        return { data: result };
      },
    },
    {
      name: "time_now",
      aliases: ["time", "date"],
      inputSchema: z.object({}),
      defaultTimeoutMs: 5_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async () => {
        const result = await executeTimeNowTool();
        return { data: result };
      },
    },
    {
      name: "repo_structure",
      description:
        "Quick orientation for the current workspace: returns a truncated `git ls-files` header plus a depth-limited directory tree. Use this once at the START of a fresh task to learn where things live before reaching for `grep` or `read_file`. Read-only.",
      inputSchema: z.object({
        filesLimit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(
            "Cap on `git ls-files` lines returned (default 200, max 1000).",
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("Directory tree depth (default 2, max 4)."),
      }),
      defaultTimeoutMs: 15_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args, context) => {
        const result = await executeRepoStructureTool({
          workspaceDir: context.workspaceDir,
          ...(args.filesLimit !== undefined ? { filesLimit: args.filesLimit } : {}),
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
        });
        return { data: formatRepoStructureResult(result) };
      },
    },
    {
      name: "send_media",
      description:
        "Send a local image or video file into the user's chat as an inline media message. "
        + "Use after generating a screenshot, visual result, or short demo video that the user should see directly. "
        + "The path may be absolute or relative to the workspace. Supported output media: PNG, JPEG, WebP, GIF, MP4, WebM. "
        + "Do not use this for documents or text files.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Local image/video path, absolute or relative to the workspace."),
        caption: z.string().max(500).optional().describe("Optional short plain-text caption shown below the media."),
        display: z.enum(["inline", "attachment"]).optional().describe("inline renders in chat; attachment is reserved for download-style display."),
      }),
      defaultTimeoutMs: 30_000,
      // State-mutating: inserts a row + writes a file under
      // .magister/media/outbound/. Match the convention used by
      // git_commit / update_project_spec — not concurrency-safe.
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args: { path: string; caption?: string; display?: "inline" | "attachment" }, context: LeaderToolUseContext) => {
        const { createOutboundMediaFromPath, toMediaSentPayload } = await import("../../media-output-service");
        const media = await createOutboundMediaFromPath({
          taskId: context.taskId,
          requestId: context.requestId,
          roleRuntimeId: context.runId,
          sourceToolCallId: context.currentToolUseId ?? null,
          sourceType: "tool_path",
          workspaceDir: context.workspaceDir,
          path: args.path,
          display: args.display ?? "inline",
          ...(args.caption !== undefined ? { caption: args.caption } : {}),
        });
        const payload = toMediaSentPayload(media);
        await context.recordEvent({
          type: "leader.media_sent",
          timestamp: new Date().toISOString(),
          data: payload,
        });
        const label = payload.kind === "video" ? "video" : "image";
        return {
          data:
            `Sent ${label} ${payload.filename} (${payload.mimeType}, ${payload.sizeBytes} bytes) to chat as mediaId=${payload.mediaId}.`,
        };
      },
    },
    // Goal-mode terminator (Ralph loop). LEADER ONLY — teammates
    // don't get this tool. A spawned coder/reviewer/architect runs
    // with the parent's `taskId` in their tool context, which means
    // (without this gate) they could complete the parent's goal
    // mid-stream — way too easy a footgun. The leader is the only
    // role that should decide "the goal is done"; teammates report
    // findings and let the leader judge.
    ...(callerRoleId === "leader"
      ? [
          buildMarkGoalCompleteTool(),
          buildUpdateGoalPlanTool(),
          buildAddAcceptanceCriterionTool(),
        ]
      : []),
    // submit_goal_verdict is teammate-only — the evaluator calls
    // it after running through acceptance criteria. The leader
    // doesn't submit verdicts on itself (it reads them via DB
    // columns in mark_goal_complete). Self-gates with "no active
    // goal" if called from a non-goal context.
    ...(callerRoleId !== "leader" ? [buildSubmitGoalVerdictTool()] : []),
    // 2026-05-24 Phase 1b-2: reviewer's typed verdict submission +
    // Leader's read/reject/escalate inbox tools.
    //   - submit_review_verdict is reviewer-only (writes a verdict
    //     artifact that Leader reads). Leader self-rejecting via
    //     this tool is meaningless.
    //   - read/reject/escalate are leader-only by design; teammates
    //     don't own the review queue.
    // All four are dormant in production today because all
    // workspaces ship on `mode: "hitl"` (router never assigns to
    // leader). The tools exist so a workspace flipped to
    // `leader-driven` in 8.1c can use them.
    ...(callerRoleId === "reviewer" ? [buildSubmitReviewVerdictTool()] : []),
    ...(callerRoleId === "leader"
      ? [
          buildReadChangeReviewTool(),
          buildRejectChangeReviewTool(),
          buildEscalateChangeReviewTool(),
          buildApplyChangeReviewTool(),
        ]
      : []),
    // Memory tools are LEADER ONLY. Memory injection only happens
    // for the leader's system prompt; teammates run scoped to a
    // single delegated task and shouldn't be mutating the user-
    // wide memory store on their own initiative.
    ...(callerRoleId === "leader" ? createMemoryLeaderTools() : []),
    {
      name: "load_skill",
      // Progressive-disclosure loader for Anthropic-style agent skills.
      // The system prompt advertises `name: description` for each
      // skill attached to this agent (see `appendAgentSkills` in
      // teammate-system-prompts.ts). When the model decides one
      // applies, it calls this tool with the skill name and gets the
      // full body back as a tool result. The body stays in
      // conversation history for the rest of the turn so the model
      // doesn't reload the same skill twice.
      //
      // Skill resolution is scoped to `callerRoleId` so an agent can
      // only load skills the user has explicitly bound to it via
      // the Skills tab. Loading a skill the agent isn't bound to
      // returns an error so the model gets clear feedback rather
      // than silently failing.
      description:
        "Load the full content of an attached skill by name. Use this when one of the skills listed in your system prompt's `# Available skills` section matches the user's current request. Pass the exact `name` from that list. Returns the skill's full body as text.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe("Exact skill name as listed in the system prompt's available-skills section."),
      }),
      defaultTimeoutMs: 15_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      // Skills carry guidance, not code execution. Always safe in plan
      // mode — they help the model produce a better plan.
      isPlanSafe: () => true,
      call: async (args) => {
        const skillName = args.name?.trim();
        if (!skillName) {
          return { data: "Error: `name` is required (the exact skill name from the available-skills list)." };
        }
        try {
          // Resolve attachment via the unified service so `leader`
          // (DB) and CLI roles (filesystem symlinks) both work
          // through the same code path. Body always comes from the
          // central pool — keeps `npx skills update` reflected in
          // real time without re-attaching.
          const { listSkillsForAgent } = await import(
            "../../skill-management-service"
          );
          const { readSkillContent } = await import("../../skill-pool-service");
          const attached = await listSkillsForAgent(callerRoleId);
          if (attached.length === 0) {
            return {
              data: `Error: no skills are attached to agent "${callerRoleId}". Ask the user to attach the skill via the Skills tab in Settings.`,
            };
          }
          if (!attached.some((s) => s.name === skillName)) {
            return {
              data: `Error: skill "${skillName}" is not attached to agent "${callerRoleId}". Use one of the names listed in your system prompt's \`# Available skills\` section.`,
            };
          }
          // Pass the caller's roleId so per-instance overrides on
          // bundled skills (skill_overrides table) are applied for
          // this agent. Pool skills ignore the role arg.
          const content = await readSkillContent(skillName, callerRoleId);
          if (content == null) {
            return {
              data: `Error: skill "${skillName}" is attached but its SKILL.md is missing from the pool (~/.agents/skills/${skillName}/). The skill may have been removed externally — re-attach via the Skills tab.`,
            };
          }
          return { data: `# Skill: ${skillName}\n\n${content}` };
        } catch (err) {
          return {
            data: `Error loading skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
    {
      name: "create_project_spec",
      inputSchema: CreateProjectSpecInputSchema,
      defaultTimeoutMs: 30_000,
      // Writes a JSON file on disk — concurrent calls would race on the
      // same artifact path. Keep sequential.
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      // Project spec is itself a planning artifact — explicitly allowed
      // in plan mode even though the underlying call writes to disk.
      isPlanSafe: () => true,
      call: async (args, context) => {
        const parsed = parseProjectSpec(args.spec);
        if (!parsed) {
          return {
            data: "Error: invalid spec JSON. Expected { projectName: string, features: Feature[] }.",
          };
        }

        await createProjectSpec(context.taskId, parsed);
        return {
          data: formatSpecForPrompt(parsed),
        };
      },
    },
    {
      name: "update_project_spec",
      inputSchema: UpdateProjectSpecInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      // Project spec is itself a planning artifact — explicitly allowed
      // in plan mode even though the underlying call writes to disk.
      isPlanSafe: () => true,
      call: async (args, context) => {
        const spec = await getProjectSpec(context.taskId);
        if (!spec) {
          return { data: "No project spec found for this task" };
        }
        updateFeatureStatus(spec, args.featureId, args.status, args.result);
        await updateProjectSpec(context.taskId, spec);
        return {
          data: `Feature ${args.featureId} updated to ${args.status}.\n\n${formatSpecForPrompt(spec)}`,
        };
      },
    },
    {
      name: "update_plan",
      description: UPDATE_PLAN_DESCRIPTION,
      inputSchema: UpdatePlanInputSchema,
      defaultTimeoutMs: 15_000,
      // Single-resource (the session's plan); concurrent updates would
      // discard each other's snapshots.
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      // Plan tracking is the orchestration surface — explicitly allowed
      // in plan mode (a plan-mode session without progress visibility
      // would be strictly worse).
      isPlanSafe: () => true,
      call: async (args: z.infer<typeof UpdatePlanInputSchema>) => {
        const todos = args.todos;

        // Invariant 1: at most one in_progress.
        const inProgress = todos.filter((t) => t.status === "in_progress");
        if (inProgress.length > 1) {
          throw new Error(
            `update_plan rejected: ${inProgress.length} items are in_progress, but the rule is exactly ONE in_progress at any time. Mark the prior items completed (or back to pending) before starting another.`,
          );
        }

        // Invariant 2: in_progress items must have non-empty activeForm.
        const missingActiveForm = inProgress.find((t) => !t.activeForm.trim());
        if (missingActiveForm) {
          throw new Error(
            `update_plan rejected: in_progress item "${missingActiveForm.content}" is missing activeForm (the present-continuous form, e.g. "Running tests"). The UI shows activeForm while the item is in_progress.`,
          );
        }

        // Compact summary for the model so it knows the call landed.
        const counts = {
          pending: todos.filter((t) => t.status === "pending").length,
          in_progress: inProgress.length,
          completed: todos.filter((t) => t.status === "completed").length,
          cancelled: todos.filter((t) => t.status === "cancelled").length,
        };
        const summary =
          `Plan updated: ${todos.length} item(s) (` +
          `${counts.pending} pending, ${counts.in_progress} in_progress, ` +
          `${counts.completed} completed, ${counts.cancelled} cancelled). ` +
          `Continue execution; mark items completed AS SOON AS each finishes.`;

        return { data: summary };
      },
    },
    {
      name: "git_commit",
      inputSchema: GitCommitInputSchema,
      defaultTimeoutMs: 60_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args, context) => {
        const { execFileSync } = await import("child_process");
        const cwd = context.workspaceDir;
        try {
          if (args.files?.length) {
            for (const file of args.files) {
              // `--` so a filename beginning with `-` can't be parsed as a git option.
              execFileSync("git", ["add", "--", file], { cwd, timeout: 10000 });
            }
          } else {
            execFileSync("git", ["add", "-A"], { cwd, timeout: 10000 });
          }
          const status = execFileSync("git", ["diff", "--cached", "--stat"], { cwd, timeout: 10000 }).toString().trim();
          if (!status) {
            return { data: "No changes to commit" };
          }
          execFileSync("git", ["commit", "-m", args.message], { cwd, timeout: 30000 });
          const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 }).toString().trim();
          return {
            data: `Committed: ${hash} — ${args.message}\n\nFiles:\n${status}`,
          };
        } catch (error) {
          return {
            data: `Git commit failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: "git_create_branch",
      inputSchema: GitCreateBranchInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args, context) => {
        const { execFileSync } = await import("child_process");
        const cwd = context.workspaceDir;
        try {
          // Reject ref/branch names starting with `-` so they can't be
          // parsed as git options (checkout has no clean `--` slot for the
          // branch position). git disallows such branch names anyway.
          const badRef = [args.fromBranch, args.branchName].find(
            (v) => typeof v === "string" && v.startsWith("-"),
          );
          if (badRef) {
            return { data: `Failed: refusing branch/ref name starting with '-' (${badRef})` };
          }
          if (args.fromBranch) {
            execFileSync("git", ["checkout", args.fromBranch], { cwd, timeout: 10000 });
          }
          execFileSync("git", ["checkout", "-b", args.branchName], { cwd, timeout: 10000 });
          return { data: `Created and switched to branch: ${args.branchName}` };
        } catch (error) {
          return {
            data: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    buildSpawnTeammateTool({ spawnTeammateDescription: opts?.spawnTeammateDescription, tavilyConfig }),
    buildSpawnTeammatesBatchTool({
      spawnTeammateDescription: opts?.spawnTeammateDescription,
      tavilyConfig,
    }),
    {
      name: "check_teammate_status",
      inputSchema: z.object({
        teammateRunId: z.string().describe("The run ID of the teammate to check"),
      }),
      defaultTimeoutMs: 15_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      async call(args: { teammateRunId: string }) {
        const runtimeRepo = new RoleRuntimeRepository();
        const runtime = await runtimeRepo.getById(args.teammateRunId);
        if (!runtime) {
          return { data: JSON.stringify({ status: "not_found" }) };
        }

        const status = runtime.state;
        let result: string | undefined;

        // If completed or failed, try to get the final answer from checkpoint
        if (status === "COMPLETED" || status === "FAILED") {
          try {
            const { LeaderSessionStore } = await import("../../leader-session-store");
            const store = new LeaderSessionStore();
            const cp = await store.getLatestCheckpoint(args.teammateRunId);
            if (cp?.messages) {
              for (const m of cp.messages) {
                if (m.type === "assistant") {
                  const blocks = (m as any).content;
                  if (Array.isArray(blocks)) {
                    for (const b of blocks) {
                      if (b.type === "text" && b.text) result = b.text;
                    }
                  }
                }
              }
            }
          } catch {
            // checkpoint retrieval is best-effort
          }
        }

        return {
          data: JSON.stringify({
            teammateRunId: args.teammateRunId,
            role: runtime.roleId,
            status: status.toLowerCase(),
            // leader-context cap (8KB).
            // Lightweight poll; leader glances at this. 8KB covers
            // most quick-check cases without bloating context.
            ...(result ? { result: result.slice(0, 8_000) } : {}),
          }),
        };
      },
    },
    {
      name: "wait_for_teammate",
      inputSchema: z.object({
        teammateRunId: z.string().describe("The run ID of the teammate to wait for"),
        timeoutMs: z.number().optional().describe("Max wait time in milliseconds. Default: 300000 (5 min)"),
      }),
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      async call(args: { teammateRunId: string; timeoutMs?: number }, context: LeaderToolUseContext) {
        const runtimeRepo = new RoleRuntimeRepository();
        const timeout = args.timeoutMs ?? 300_000;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          if (context.abortController.signal.aborted) {
            return { data: JSON.stringify({ status: "cancelled" }) };
          }

          const runtime = await runtimeRepo.getById(args.teammateRunId);
          if (!runtime) {
            return { data: JSON.stringify({ status: "not_found" }) };
          }

          if (runtime.state === "COMPLETED" || runtime.state === "FAILED") {
            // Get result from checkpoint
            let result = "";
            try {
              const { LeaderSessionStore } = await import("../../leader-session-store");
              const store = new LeaderSessionStore();
              const cp = await store.getLatestCheckpoint(args.teammateRunId);
              if (cp?.messages) {
                for (const m of cp.messages) {
                  if (m.type === "assistant") {
                    const blocks = (m as any).content;
                    if (Array.isArray(blocks)) {
                      for (const b of blocks) {
                        if (b.type === "text" && b.text) result = b.text;
                      }
                    }
                  }
                }
              }
            } catch {
              // checkpoint retrieval is best-effort
            }

            // Codex round-3 [M] — when truncated, include the
            // recovery hint pointing at read_teammate_transcript.
            // parentToolUseId for this teammate isn't a direct
            // arg here (the leader only knows teammateRunId from
            // the original spawn), so look it up from any teammate
            // event stamped via Step 0a propagation. Best-effort —
            // pre-migration teammates have no stamp and the hint
            // is omitted gracefully.
            let resultBody = result;
            if (result.length > 16_000) {
              let parentToolUseId: string | null = null;
              try {
                const { ExecutionEventRepository } = await import(
                  "../../../repositories/execution-event-repository"
                );
                parentToolUseId = await new ExecutionEventRepository()
                  .findParentToolUseIdForRuntime(args.teammateRunId);
              } catch {
                // best-effort
              }
              const head = result.slice(0, 16_000);
              const recoveryHint = parentToolUseId
                ? ` Call read_teammate_transcript(parentToolUseId="${parentToolUseId}") for the full text.`
                : "";
              resultBody = `${head}\n\n[truncated: original was ${result.length} chars; showing first 16000.${recoveryHint}]`;
            }

            return {
              data: JSON.stringify({
                teammateRunId: args.teammateRunId,
                role: runtime.roleId,
                status: runtime.state.toLowerCase(),
                result: resultBody,
              }),
            };
          }

          // Poll every 2 seconds
          await new Promise((r) => setTimeout(r, 2000));
        }

        return {
          data: JSON.stringify({
            status: "timeout",
            teammateRunId: args.teammateRunId,
          }),
        };
      },
    },
    {
      name: "list_active_teammates",
      description:
        "List background teammates (spawned with wait: false) that are still running for the current task. " +
        "Returns each teammate's runId, role, and elapsed time in seconds. " +
        "Use this to check progress when you have not yet received a completion message for a background teammate. " +
        "Read-only; does not affect running teammates.",
      inputSchema: z.object({}),
      defaultTimeoutMs: 10_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      async call(_args: Record<string, never>, context: LeaderToolUseContext) {
        const runtimeRepo = new RoleRuntimeRepository();
        const active = await runtimeRepo.listActiveBackgroundTeammates(context.taskId);
        const now = Date.now();
        return {
          data: JSON.stringify({
            active: active.map((rt) => ({
              runId: rt.id,
              role: rt.roleId,
              state: rt.state,
              spawnedAtMs: rt.startedAt ? rt.startedAt.getTime() : rt.updatedAt.getTime(),
              elapsedSec: Math.floor((now - (rt.startedAt ?? rt.updatedAt).getTime()) / 1000),
            })),
          }),
        };
      },
    },
    {
      // leader recovery path when a
      // synchronous spawn_teammate's `data` was capped at 16KB. Leader
      // sees the trailer "[truncated: ... call read_teammate_transcript(
      // taskId, parentToolUseId)]" and can request the full text.
      // Backed by the same indexed query the lazy-load endpoint uses
      // (parent_tool_use_id column from Step 0b).
      name: "read_teammate_transcript",
      description:
        "Fetch a previously-spawned teammate's full transcript when its result " +
        "was truncated. Use this ONLY when a spawn_teammate tool_result ended " +
        "with `[truncated: ...]` AND you need details that aren't in the truncated " +
        "head. parentToolUseId comes from the trailer text. The reconstructed " +
        "text is rebuilt from the teammate's raw stream events (not from the " +
        "already-truncated summary), so the full output is recoverable up to a " +
        "50KB context-safety cap. Read-only.",
      inputSchema: z.object({
        taskId: z.string().optional().describe(
          "Task that owned the teammate run. Optional — defaults to the current task. Pass explicitly only if the trailer specified one.",
        ),
        parentToolUseId: z.string().describe("The spawn_teammate tool_use_id from the trailer."),
        sinceSeq: z.number().int().nonnegative().optional().describe(
          "Pagination cursor (exclusive); events with seq <= this are skipped. Use the lastSeq from a prior call to fetch the next page.",
        ),
      }),
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      async call(
        args: { taskId?: string; parentToolUseId: string; sinceSeq?: number },
        context: LeaderToolUseContext,
      ) {
        const { ExecutionEventRepository } = await import("../../../repositories/execution-event-repository");
        const eventRepo = new ExecutionEventRepository();
        // Codex round-3 [I] — default to context.taskId. Leader prompts
        // don't expose taskId, so requiring the model to fill it from
        // the trailer-only is fragile. Trailer still carries it
        // explicitly as a fallback.
        const taskId = args.taskId ?? context.taskId;
        const PAGE_LIMIT = 200;
        const sinceSeq = args.sinceSeq ?? 0;

        const events = await eventRepo.listTeammateTranscript(
          taskId,
          args.parentToolUseId,
          sinceSeq,
          PAGE_LIMIT,
        );
        if (events.length === 0) {
          return {
            data: JSON.stringify({
              status: "empty",
              taskId,
              parentToolUseId: args.parentToolUseId,
              hint: "No teammate events found for this parentToolUseId. Either the spawn predates the v2.1 migration (no parent_tool_use_id stamp), or the parentToolUseId is wrong.",
            }),
          };
        }

        // Codex round-3 [C1+C2] fix — reconstruct text from teammate
        // stream_delta events (depth=1, parent_tool_use_id stamped),
        // NOT from leader.teammate_completed.summary (which lives at
        // depth=0, has parent_tool_use_id=NULL → invisible to this
        // query, AND is already 50KB-truncated at storage time).
        // stream_delta payloads carry untruncated `text`, so we get
        // the full assistant output by concatenating them in seq
        // order. 50KB safety cap on the reconstructed result keeps
        // the leader's context bounded.
        let assistantText = "";
        const toolNames: string[] = [];
        for (const ev of events) {
          if (!ev.payloadJson) continue;
          try {
            const p = JSON.parse(ev.payloadJson) as Record<string, unknown>;
            if (ev.type === "leader.stream_delta") {
              const innerType = typeof p.type === "string" ? p.type : null;
              const text = typeof p.text === "string" ? p.text : "";
              if (innerType === "text_delta" && text) {
                assistantText += text;
                // Bail out of further accumulation once we hit cap;
                // pagination still continues for tool list / lastSeq.
                if (assistantText.length > 50_000 + 1024) {
                  assistantText = assistantText.slice(0, 50_000);
                }
              }
            } else if (ev.type === "leader.tool_call") {
              const toolName = typeof p.toolName === "string" ? p.toolName : null;
              if (toolName) toolNames.push(toolName);
            }
          } catch {
            // Malformed row — skip but don't fail the whole tool call.
          }
        }

        const lastSeq = events[events.length - 1]?.seq ?? sinceSeq;
        const more = events.length === PAGE_LIMIT;
        const cappedText = assistantText.slice(0, 50_000);
        const wasTextCapped = assistantText.length > 50_000;

        return {
          data: JSON.stringify({
            status: more ? "partial" : "complete",
            taskId,
            parentToolUseId: args.parentToolUseId,
            eventCount: events.length,
            toolsUsed: Array.from(new Set(toolNames)),
            ...(cappedText ? { reconstructedText: cappedText } : {}),
            ...(wasTextCapped ? { textCapped: true, textCappedAt: 50_000 } : {}),
            lastSeq,
            ...(more ? {
              hint: `Page reached PAGE_LIMIT=${PAGE_LIMIT}. Call again with sinceSeq=${lastSeq} to fetch the next page.`,
            } : {}),
          }),
        };
      },
    },
    {
      name: "request_human_input",
      aliases: ["ask_human", "human_input"],
      inputSchema: RequestHumanInputInputSchema,
      // Sequencing matters — humans can't sensibly answer two concurrent
      // prompts. Keep serial.
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args, context) => {
        if (context.requestApproval) {
          const result = await context.requestApproval({
            toolName: "request_human_input",
            toolInput: args,
            toolUseId: `${Date.now()}`,
            message: args.question,
          });
          return {
            data: {
              success: true,
              response: result.feedback ?? "No feedback provided",
              decision: result.decision,
            },
          };
        }
        return {
          data: {
            success: false,
            message: "Human input request requires approval mechanism",
            question: args.question,
            context: args.context,
          },
        };
      },
    },
    {
      name: "write_file",
      aliases: ["write", "create_file"],
      description:
        "Write content to a file. **The path MUST resolve inside the current workspace directory** — paths outside the workspace are rejected with \"path escapes workspace directory\". For paths outside the workspace (e.g. /tmp, /var, ~/something), use `bash` with redirection (e.g. `echo content > /tmp/file`) instead. `path` may be relative (resolved against the workspace) or an absolute path inside the workspace. **If `path` itself is a symlink, the write is refused** (TOCTOU defense) — to overwrite the symlink itself, `bash rm` then write_file; to write through the link, use `bash` redirection.",
      inputSchema: WriteFileInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args, context) => {
        const fs = await import("fs/promises");
        const path = await import("path");
        const resolved = await resolveInsideWorkspace(context.workspaceDir, args.path);
        if (!resolved.ok) {
          return { data: `Error: ${resolved.error}` };
        }
        const filePath = resolved.resolved;
        try {
          if (args.createDirs) {
            const dir = path.dirname(filePath);
            await fs.mkdir(dir, { recursive: true });
            // mkdir(recursive: true) follows intermediate symlinks. If
            // an attacker raced a directory→symlink swap between our
            // initial resolve and now, the dir tree may have been
            // created OUTSIDE the workspace. Re-validate that the
            // (now-existing) dir still resolves inside; abort if not.
            // 
            const reValidate = await resolveInsideWorkspace(context.workspaceDir, dir);
            if (!reValidate.ok) {
              return {
                data: {
                  success: false,
                  error: `mkdir validation failed: ${reValidate.error}. The directory chain was modified between path resolution and write.`,
                  path: args.path,
                },
              };
            }
          }
          await safeWriteFile(filePath, args.content);
          return {
            data: {
              success: true,
              path: args.path,
              bytesWritten: Buffer.byteLength(args.content, "utf-8"),
            },
          };
        } catch (error) {
          // O_NOFOLLOW returns ELOOP if the leaf was replaced with a
          // symlink between our resolveInsideWorkspace check and the
          // open call. Translate to a model-facing message that
          // doesn't leak the system error format.
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ELOOP") {
            return {
              data: {
                success: false,
                error:
                  "target path is a symlink — refused to write through it (TOCTOU defense). If you intend to follow the link, use bash with redirection.",
                path: args.path,
              },
            };
          }
          return {
            data: {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
              path: args.path,
            },
          };
        }
      },
    },
    {
      name: "edit_file",
      aliases: ["edit", "replace"],
      description:
        "Replace `oldString` with `newString` in a file. **The path MUST resolve inside the current workspace directory** — paths outside are rejected. For files outside the workspace, use `bash` (e.g. `sed -i` or a redirect). `oldString` must match exactly once unless `replaceAll: true`. **If `path` itself is a symlink, the edit is refused** (TOCTOU defense).",
      inputSchema: EditFileInputSchema,
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      isPlanSafe: () => false,
      call: async (args, context) => {
        const resolved = await resolveInsideWorkspace(context.workspaceDir, args.path);
        if (!resolved.ok) {
          return { data: `Error: ${resolved.error}` };
        }
        const filePath = resolved.resolved;
        try {
          // Both read and write go through O_NOFOLLOW — an attacker can
          // race between our resolve and either the read OR the write.
          const content = await safeReadFile(filePath);
          const occurrences = content.split(args.oldString).length - 1;
          if (occurrences === 0) {
            return {
              data: {
                success: false,
                error: "oldString not found in file",
                path: args.path,
              },
            };
          }
          if (occurrences > 1 && !args.replaceAll) {
            return {
              data: {
                success: false,
                error: `Found ${occurrences} occurrences. Use replaceAll: true or provide more context.`,
                path: args.path,
              },
            };
          }
          const newContent = args.replaceAll
            ? content.split(args.oldString).join(args.newString)
            : content.replace(args.oldString, args.newString);
          await safeWriteFile(filePath, newContent);
          return {
            data: {
              success: true,
              path: args.path,
              replacementsMade: args.replaceAll ? occurrences : 1,
            },
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ELOOP") {
            return {
              data: {
                success: false,
                error:
                  "target path is a symlink — refused to follow it (TOCTOU defense).",
                path: args.path,
              },
            };
          }
          return {
            data: {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
              path: args.path,
            },
          };
        }
      },
    },
    // ───────────────────────────────────────────────────────────────
    // Plan-mode tools (leader-only — excluded from teammate profiles)
    // ───────────────────────────────────────────────────────────────
    {
      name: "enter_plan_mode",
      inputSchema: z.object({}),
      defaultTimeoutMs: 15_000,
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (_args, context) => {
        // Defense per spec §5.1: a provider config that pins
        // tool_choice to required/any/etc. would break the halt
        // mechanism (model would be forced to call another tool
        // after `exit_plan_mode`'s halt-instruction tool_result).
        // Returned as a tool_result with `isError: true` so the
        // model treats it as a hard refusal, not soft success-data.
        const violation = await detectToolChoiceForcingOverride();
        if (violation) {
          // Throw so `tool-execution.ts` emits this as a `tool_result`
          // with `isError: true` — the model treats it as a hard
          // refusal rather than soft success-data it might ignore.
          throw new Error(
            `Plan mode requires tool_choice not be forced by provider config. ${violation}. Remove the override before using plan mode.`,
          );
        }
        // Spec §7.1: no-op (no event) when already in PLANNING or
        // AWAITING_APPROVAL — model may double-call. Return success
        // so the model can proceed without an error path.
        if (context.inPlanMode === true) {
          return { data: { success: true, state: "PLANNING" as const, alreadyInPlanMode: true } };
        }
        await context.recordEvent({
          type: "leader.plan_mode_entered",
          timestamp: new Date().toISOString(),
          data: {
            taskId: context.taskId,
            requestId: context.requestId,
            runId: context.runId,
            // Spec §9: attribute the entry to the turn that called us.
            // Defaults to 1 if the loop hasn't populated it (defensive
            // — current loop always sets `turnIndex`).
            turnIndex: context.turnIndex ?? 1,
          },
        });
        return { data: { success: true, state: "PLANNING" as const } };
      },
    },
    {
      name: "exit_plan_mode",
      inputSchema: z.object({
        plan: z.string().min(1).max(20000)
          .describe("The full markdown plan to present to the user for approval."),
      }),
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args, context) => {
        // Spec §7.2 IDLE guard: rejecting prevents a stray
        // `exit_plan_mode` call (without a matching enter) from
        // emitting a phantom `leader.plan_proposed` and silently
        // putting the leader in AWAITING_APPROVAL with no halt
        // semantics on the next user turn.
        if (context.inPlanMode !== true) {
          // Throw → tool-execution emits a `tool_result` with
          // `isError: true` so the model sees this as a hard refusal
          // and won't silently proceed.
          throw new Error(
            "exit_plan_mode requires plan mode to be active. Call enter_plan_mode first.",
          );
        }
        // Reject duplicates — once a plan is submitted (AWAITING_APPROVAL)
        // the loop is supposed to halt and the user must respond.
        // Smaller models sometimes ignore the halt-instruction
        // tool_result and keep calling exit_plan_mode in a loop,
        // creating multiple PlanCards. The plan-state machine has
        // already transitioned and `planAwareRecordEvent` is
        // tracking `currentPlanRequestId`; emitting another
        // `leader.plan_proposed` here would orphan the original.
        if (context.alreadyAwaitingApproval === true) {
          throw new Error(
            "A plan is already submitted and awaiting user approval. Stop calling tools — end your turn with a brief acknowledgement.",
          );
        }
        await context.recordEvent({
          type: "leader.plan_proposed",
          timestamp: new Date().toISOString(),
          data: {
            taskId: context.taskId,
            requestId: context.requestId,
            runId: context.runId,
            plan: args.plan,
          },
        });
        return {
          data: {
            success: true,
            state: "AWAITING_APPROVAL" as const,
            // Deterministic halt-instruction per spec §5 step 1. The
            // model receives this as the tool_result and must end
            // its turn rather than call more tools.
            instruction:
              "Plan submitted for user approval. STOP. Do not call any more tools this turn. End the turn with a brief acknowledgement (e.g. \"Plan submitted; awaiting your decision.\"). Do NOT re-call exit_plan_mode or other tools.",
          },
        };
      },
    },
    {
      name: "mcp_list_resources",
      description:
        "List resources published by registered MCP servers. Resources are read-only data the server exposes (files, schemas, issues, …). Pass `serverId` to filter to one server, or omit it to aggregate across all connected servers. Use this before `mcp_read_resource` to discover what's available.",
      inputSchema: z.object({
        serverId: z.string().optional().describe("Filter to a specific MCP server by id. Omit to list across all connected servers."),
      }),
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (args: { serverId?: string }) => {
        const { getMcpPool } = await import("../../mcp-pool-service");
        const pool = getMcpPool();
        if (args.serverId && !(await pool.isAttachedToRole(args.serverId, callerRoleId))) {
          return { data: `MCP server ${args.serverId} is not attached to role ${callerRoleId}. Use mcp_list_resources without serverId to see what's available.` };
        }
        const allServerIds = args.serverId
          ? [args.serverId]
          : await pool.listResourcesForRole(callerRoleId);
        // Parallel fetch — one hung server doesn't block the rest.
        const settled = await Promise.allSettled(
          allServerIds.map(async (serverId) => ({
            serverId,
            result: await pool.listResources(serverId),
          })),
        );
        const sections: string[] = [];
        for (let i = 0; i < settled.length; i++) {
          const s = settled[i]!;
          const serverId = allServerIds[i]!;
          if (s.status === "rejected") {
            sections.push(`## ${serverId}\n[error listing resources: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}]`);
            continue;
          }
          const { resources } = s.value.result;
          if (resources.length === 0) continue;
          sections.push(
            `## ${serverId} (${resources.length} resources)\n` +
              resources
                .map((r) => `- ${r.uri}${r.name && r.name !== r.uri ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}${r.description ? `\n    ${r.description}` : ""}`)
                .join("\n"),
          );
        }
        const data =
          sections.length > 0
            ? sections.join("\n\n")
            : "No MCP resources available. Either no MCP servers are connected, or none of them publish resources. Do not retry; resources are not available in this run.";
        return { data };
      },
    },
    {
      name: "mcp_read_resource",
      description:
        "Read a single MCP resource by URI. Use `mcp_list_resources` first to discover available URIs. Returns the resource's text content; binary blobs are reported as a placeholder (Phase 2 doesn't surface raw binary to the model).",
      inputSchema: z.object({
        serverId: z.string().describe("The MCP server id that publishes this resource."),
        uri: z.string().describe("The resource URI (from mcp_list_resources output)."),
      }),
      defaultTimeoutMs: 30_000,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      // Cap result size — a server publishing a 10MB log resource
      // would blow the model's context. 200k chars is roughly 50k
      // tokens, comfortably under any production model's window.
      maxResultSizeChars: 200_000,
      call: async (args: { serverId: string; uri: string }) => {
        const { getMcpPool } = await import("../../mcp-pool-service");
        const pool = getMcpPool();
        if (!(await pool.isAttachedToRole(args.serverId, callerRoleId))) {
          throw new Error(`MCP server ${args.serverId} is not attached to role ${callerRoleId}; cannot read its resources.`);
        }
        try {
          const { contents } = await pool.readResource(args.serverId, args.uri);
          const parts: string[] = [];
          for (const c of contents) {
            if (typeof c.text === "string") {
              parts.push(c.text);
            } else if (typeof c.blob === "string") {
              const bytes = Math.floor((c.blob.length * 3) / 4);
              parts.push(`[base64-blob ~${bytes} bytes uri=${c.uri} mime=${c.mimeType ?? "application/octet-stream"}]`);
            }
          }
          const data = parts.join("\n") || "[mcp resource returned empty content]";
          return { data };
        } catch (err) {
          // Throw → tool-execution.ts maps to tool_result.isError.
          throw new Error(`MCP read_resource error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];

  if (profileId) {
    return filterToolsByProfile(tools, profileId);
  }

  return tools;
}

/**
 * Reads the active executor config and returns a description string if
 * any provider OR model profile pins `tool_choice` to a value that would
 * force the model to call a tool. Plan mode's halt protocol relies on
 * the model being free to end its turn after `exit_plan_mode`'s
 * halt-instruction tool_result; a forced tool_choice breaks that.
 *
 * Returns `null` if no problematic override is found.
 */
async function detectToolChoiceForcingOverride(): Promise<string | null> {
  try {
    const { readExecutorConfigFile } = await import("../../executor-config-service");
    const { resolveAgentForRole } = await import("../../agent-resolution-service");
    const cfg = await readExecutorConfigFile();
    const FORCING_VALUES = new Set(["required", "any", "function", "tool"]);
    const checkOverrides = (
      label: string,
      overrides: Record<string, unknown> | undefined,
    ): string | null => {
      if (!overrides) return null;
      const tc = overrides.tool_choice;
      if (tc == null) return null;
      // tool_choice can be a string ("auto"/"required"/"none"/"any") or
      // an object ({type: "tool", name: "..."} for Anthropic / a similar
      // shape for OpenAI). Anything that names a specific tool counts
      // as forcing.
      if (typeof tc === "string" && FORCING_VALUES.has(tc.toLowerCase())) {
        return `${label} sets tool_choice="${tc}"`;
      }
      if (typeof tc === "object") {
        return `${label} sets tool_choice=${JSON.stringify(tc)}`;
      }
      return null;
    };

    // Resolve the active leader agent so we only inspect the provider
    // and model the leader is actually using. Earlier draft iterated
    // every provider/model in config — that meant an unrelated
    // provider with `tool_choice: required` (e.g. a Codex-only profile)
    // would spuriously block plan-mode entry. Spec §5.1 says "the
    // active provider config".
    const resolved = await resolveAgentForRole("leader");
    const activeProviderId = resolved?.provider?.id;
    const activeModelId = resolved?.modelName;

    if (activeProviderId) {
      const provider = cfg.providers?.[activeProviderId];
      const violation = checkOverrides(`provider "${activeProviderId}"`, provider?.requestOverrides);
      if (violation) return violation;
    }
    if (activeModelId) {
      const model = cfg.models?.[activeModelId];
      const violation = checkOverrides(
        `model "${activeModelId}"`,
        (model as { requestOverrides?: Record<string, unknown> } | undefined)?.requestOverrides,
      );
      if (violation) return violation;
    }
    return null;
  } catch {
    // If the config can't be read, don't block plan-mode entry — fail
    // open with a permissive default. The actual model call would
    // surface any real problem.
    return null;
  }
}

export const DEFAULT_LEADER_TOOLS = [
  "bash",
  "request_permissions",
  "read_file",
  "list_dir",
  "grep",
  "web_search",
  "web_fetch",
  "time_now",
  "repo_structure",
  "send_media",
  "mark_goal_complete",
  "update_goal_plan",
  "add_acceptance_criterion",
  "read_change_review",
  "reject_change_review",
  "escalate_change_review_to_user",
  "apply_change_review",
  // M5 memory tools — leader-only, already gated by callerRoleId
  // inside `createLeaderTools`. Listing them in the canonical tool
  // set so custom `allowedTools` profiles don't silently drop them.
  "upsert_memory",
  "delete_memory",
  "view_memory",
  "search_memory",
  "load_skill",
  "create_project_spec",
  "update_project_spec",
  "update_plan",
  "git_commit",
  "git_create_branch",
  "spawn_teammate",
  "spawn_teammates",
  "check_teammate_status",
  "wait_for_teammate",
  "list_active_teammates",
  "read_teammate_transcript",
  "request_human_input",
  "write_file",
  "edit_file",
  "mcp_list_resources",
  "mcp_read_resource",
  "enter_plan_mode",
  "exit_plan_mode",
] as const;

export function listConfigurableLeaderTools(projectPath = process.cwd()): LeaderTool[] {
  const planModeToolNames = new Set<string>(PLAN_MODE_TOOLS);
  return createLeaderTools(projectPath).filter((tool) => !planModeToolNames.has(tool.name));
}

export function listConfigurableLeaderToolNames(projectPath = process.cwd()): string[] {
  return listConfigurableLeaderTools(projectPath).map((tool) => tool.name);
}
