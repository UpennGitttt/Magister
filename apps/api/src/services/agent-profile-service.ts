import { createHash } from "node:crypto";

import { createDb, agentProfiles, type AgentProfileSelect } from "@magister/db";
import { eq } from "@magister/db";

import {
  LEADER_SYSTEM_PROMPT,
  EVALUATOR_SYSTEM_PROMPT as TEAMMATE_EVALUATOR_PROMPT,
} from "./manager-automation/teammate-system-prompts";

// All builtin agent roles. `memory-extractor` is NOT spawnable via
// `spawn_teammate` — Magister infrastructure invokes it on the
// pre-compact / failure / link-pass hot paths. Registered here so the
// row exists, has a Settings panel, and participates in hash-upgrade.
export const BUILTIN_AGENT_ROLE_IDS = [
  "leader",
  "coder",
  "reviewer",
  "architect",
  "lander",
  "evaluator",
  "memory-extractor",
  "deepresearcher",
] as const;
export type BuiltinAgentRoleId = (typeof BUILTIN_AGENT_ROLE_IDS)[number];
export type AgentToolProfile = "full" | "coding" | "research" | "minimal";
export type AgentRuntimeType = "ucm" | "codex" | "opencode" | "claude-code" | "kiro";

export type AgentProfile = Omit<
  AgentProfileSelect,
  "allowedTools" | "disallowedTools" | "omitSkills"
> & {
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  /** Coerced from the integer column (0/1) for ergonomic consumption.
   *  When true, `appendAgentSkills` skips the skill-metadata appendix
   *  for this role. Defaults to false. */
  omitSkills: boolean;
};

export type UpsertAgentProfileInput = {
  roleId: string;
  label?: string | null;
  description?: string | null;
  systemPromptOverride?: string | null;
  modelName?: string | null;
  modelOverride?: string | null;
  providerId?: string | null;
  status?: string | null;
  mcpConfig?: string | null;
  reasoningMode?: "off" | "auto" | "on" | string | null;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  fallbackModelName?: string | null;
  fallbackProviderId?: string | null;
  maxConcurrentTasks?: number | null;
  maxTurns?: number | null;
  toolProfile?: AgentToolProfile | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  runtimeType?: AgentRuntimeType | null;
  provider?: string | null;
  commandPath?: string | null;
  customEnv?: string | null;
  customArgs?: string | null;
  isBuiltin?: 0 | 1 | null;
  /** When true, this role's system prompt does NOT get the
   *  `# Available skills` appendix from `appendAgentSkills`.
   *  See schema doc on `agent_profiles.omit_skills`. */
  omitSkills?: boolean | null;
};

const BUILTIN_AGENT_LABELS: Record<BuiltinAgentRoleId, string> = {
  leader: "Leader",
  coder: "Coder",
  reviewer: "Reviewer",
  architect: "Architect",
  lander: "Lander",
  evaluator: "Evaluator",
  "memory-extractor": "Memory Extractor",
  deepresearcher: "Deep Researcher",
};

const LEGACY_LEADER_LABELS = new Set(["Task Manager"]);

const BUILTIN_AGENT_DESCRIPTIONS: Record<BuiltinAgentRoleId, string> = {
  leader: "Orchestrates tasks and delegates to specialized teammates",
  coder: "Implements code changes, runs tests",
  reviewer: "Reviews code for bugs and quality",
  architect: "Analyzes codebase, proposes designs",
  lander: "Creates commits, branches, and PRs",
  evaluator: "Independently verifies completed work against acceptance criteria",
  "memory-extractor":
    "Small auxiliary that extracts durable facts on pre-compact / failure / link-pass paths (M5 Phase 3, not spawnable directly)",
  deepresearcher:
    "Conducts multi-step web research, cross-references sources, and produces structured analytical reports with cited evidence",
};

// TEAMMATE_EVALUATOR_PROMPT is not re-exported eagerly because of a
// circular import: agent-profile-service ↔ teammate-system-prompts.
// Inlining the reference in the caller below defers the read past
// module init.

// ──────────────────────────────────────────────────────────────────
// Builtin prompt hash-upgrade machinery
//
// Builtin system prompts are CODE-MANAGED defaults — when we ship a
// new version in the source files, existing DB rows should auto-
// upgrade WITHOUT clobbering user-customized rows.
//
// Mechanism:
//  - `currentHash` = sha256 of the source-of-truth prompt (computed
//    fresh on every boot).
//  - `KNOWN_OBSOLETE_PROMPT_HASHES` lists every PREVIOUSLY-SHIPPED
//    builtin prompt hash. When we change a builtin prompt, we
//    append the OLD hash to this list and the source-of-truth
//    naturally produces a new currentHash.
//  - For a DB row whose current `system_prompt_override` hashes to:
//      - matches `currentHash` → no-op (already up to date)
//      - matches an entry in KNOWN_OBSOLETE_PROMPT_HASHES → one-shot
//        replace with the source-of-truth value
//      - matches neither → user has customized this prompt; preserve
//        it. (The UI can offer a "Reset to default" button.)
// ──────────────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Past versions of each builtin role's system prompt. Adding entries
 * here is how we trigger an auto-upgrade for users who never edited
 * the row. Format: 16-char prefix of the sha256 (full 64-char hash
 * truncated to keep the list readable; collision risk at 2^-64 is
 * astronomical for this small set).
 *
 * When updating a builtin prompt:
 *   1. Compute the OLD hash:
 *      `node -e "console.log(require('crypto').createHash('sha256')
 *        .update(OLD_TEXT).digest('hex').slice(0,16))"`
 *   2. Append it here under the role.
 *   3. Update the source-of-truth string. The new value's hash is
 *      computed at runtime and treated as currentHash automatically.
 */
const KNOWN_OBSOLETE_PROMPT_HASHES: Record<BuiltinAgentRoleId, readonly string[]> = {
  // Hashes of previously-shipped builtin prompts. Each was a seed-time
  // prompt from an earlier iteration — auto-upgraded on next boot.
  leader: ["1dc5902700554842"],
  coder: ["2414a9daf76cdd29"],
  reviewer: ["e2660816abedd8c5"],
  architect: ["6fd4cb629a764797"],
  lander: ["cf2e8364f629eb03"],
  evaluator: ["c32f3c3697073902"],
  "memory-extractor": [],
  deepresearcher: [],
};

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

function shouldUpgradeBuiltinPrompt(
  roleId: BuiltinAgentRoleId,
  existingPrompt: string | null,
): { upgrade: boolean; reason: "missing" | "obsolete" | "current" | "customized" } {
  if (existingPrompt == null || existingPrompt.trim().length === 0) {
    return { upgrade: true, reason: "missing" };
  }
  // Compute current source hash dynamically; the source string is the
  // only place to look. Note: getBuiltinSystemPrompt is async because
  // of dynamic imports — callers handle that. Here we only need the
  // synchronous comparison of existing vs known-obsolete; the actual
  // upgrade fetch happens once we decide to write.
  const existingHash = shortHash(existingPrompt);
  if (KNOWN_OBSOLETE_PROMPT_HASHES[roleId].includes(existingHash)) {
    return { upgrade: true, reason: "obsolete" };
  }
  // currentHash check happens in the upgrade path where we have the
  // string. Returning false here means "matches neither known obsolete
  // nor missing — preserve as customization."
  return { upgrade: false, reason: "customized" };
}

/**
 * Hard constraint: reviewer and evaluator MUST NOT modify files.
 * This is the second layer of defense (first layer is
 * TEAMMATE_EXCLUDED_TOOLS in teammate-system-prompts.ts which removes
 * these tools from the tool list entirely). The disallowedTools
 * column acts as a runtime guard — if a tool leaks through the
 * exclusion list for any reason, the tool restriction logic in
 * manager-tools-adapter.ts will filter it out.
 */
const READONLY_DISALLOWED_TOOLS = ["write_file", "edit_file", "git_commit", "git_create_branch"];

function normalizeRoleId(roleId: string): string {
  return roleId.trim();
}

function toNullableTrimmedString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLegacyLeaderLabel(roleId: BuiltinAgentRoleId, value: string | null | undefined): boolean {
  return roleId === "leader" && LEGACY_LEADER_LABELS.has(value?.trim() ?? "");
}

function parseToolNameList(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const items = parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function encodeToolNameList(value: string[] | null | undefined): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = value.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

async function validateToolNameLists(input: Pick<UpsertAgentProfileInput, "allowedTools" | "disallowedTools">) {
  const allowedTools = input.allowedTools?.map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
  const disallowedTools = input.disallowedTools?.map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
  const { listConfigurableLeaderToolNames } = await import("./manager-automation/autonomous-loop/manager-tools-adapter");
  const knownTools = new Set<string>(listConfigurableLeaderToolNames());

  for (const toolName of allowedTools) {
    if (!knownTools.has(toolName)) {
      throw new Error(`Unknown tool name in allowedTools: ${toolName}`);
    }
  }

  for (const toolName of disallowedTools) {
    if (!knownTools.has(toolName)) {
      throw new Error(`Unknown tool name in disallowedTools: ${toolName}`);
    }
  }

  const disallowed = new Set(disallowedTools);
  const overlap = allowedTools.filter((toolName) => disallowed.has(toolName));
  if (overlap.length > 0) {
    throw new Error(`Tools cannot appear in both allowedTools and disallowedTools: ${overlap.join(", ")}`);
  }
}

function normalizeProfile(profile: AgentProfileSelect): AgentProfile {
  const fallbackLabel = profile.displayName?.trim() || profile.roleId;
  const normalizedLabel = profile.label.trim().length > 0 ? profile.label : fallbackLabel;
  const normalizedRuntimeType =
    typeof profile.runtimeType === "string" && profile.runtimeType.trim().length > 0
      ? profile.runtimeType.trim()
      : "ucm";
  return {
    ...profile,
    label: normalizedLabel,
    runtimeType: normalizedRuntimeType,
    allowedTools: parseToolNameList(profile.allowedTools),
    disallowedTools: parseToolNameList(profile.disallowedTools),
    // SQLite stores boolean as 0/1; expose as a real boolean for
    // ergonomic consumption. Defaults to false when null/undefined.
    omitSkills: profile.omitSkills === 1,
  };
}

function normalizeRuntimeType(value: string | null | undefined): AgentRuntimeType | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "ucm" || trimmed === "codex" || trimmed === "opencode" || trimmed === "claude-code" || trimmed === "kiro") {
    return trimmed;
  }

  return null;
}

export function isBuiltinAgentRoleId(roleId: string): roleId is BuiltinAgentRoleId {
  return BUILTIN_AGENT_ROLE_IDS.includes(roleId as BuiltinAgentRoleId);
}

/**
 * Leader roles must run a runtime that can drive the continuous
 * autonomous loop: the native API loop ("ucm") or Claude Code via the
 * Agent SDK ("claude-code"). One-shot CLI bridges coerce back to ucm.
 * Mirrors isLeaderCapableRuntime in agent-resolution-service.ts.
 */
function isLeaderRole(roleId: string): boolean {
  return roleId === "leader" || roleId === "manager";
}

function isLeaderCapableRuntime(runtimeType: AgentRuntimeType): boolean {
  return runtimeType === "ucm" || runtimeType === "claude-code";
}

function coerceLeaderRuntimeType(roleId: string, runtimeType: AgentRuntimeType): AgentRuntimeType {
  if (!isLeaderRole(roleId)) {
    return runtimeType;
  }
  return isLeaderCapableRuntime(runtimeType) ? runtimeType : "ucm";
}

async function getBuiltinSystemPrompt(roleId: BuiltinAgentRoleId): Promise<string> {
  if (roleId === "leader") {
    return LEADER_SYSTEM_PROMPT;
  }
  if (roleId === "evaluator") {
    return TEAMMATE_EVALUATOR_PROMPT;
  }
  if (roleId === "memory-extractor") {
    const { MEMORY_EXTRACTOR_SYSTEM_PROMPT } = await import(
      "./memory/memory-extractor-prompt"
    );
    return MEMORY_EXTRACTOR_SYSTEM_PROMPT;
  }
  const { getTeammateSystemPrompt } = await import("./manager-automation/teammate-system-prompts");
  return getTeammateSystemPrompt(roleId);
}

export async function ensureDefaultAgentProfiles(): Promise<void> {
  const db = createDb();
  const now = new Date();

  for (const roleId of BUILTIN_AGENT_ROLE_IDS) {
    const existing = await db.query.agentProfiles.findFirst({
      where: eq(agentProfiles.roleId, roleId),
    });

    if (!existing) {
      const isReadonlyRole = roleId === "reviewer" || roleId === "evaluator";
      // Defaults must be set BEFORE the role-specific spread so role
      // overrides (e.g. memory-extractor's toolProfile: "minimal") win.
      await db.insert(agentProfiles).values({
        roleId,
        label: BUILTIN_AGENT_LABELS[roleId],
        displayName: BUILTIN_AGENT_LABELS[roleId],
        description: BUILTIN_AGENT_DESCRIPTIONS[roleId],
        runtimeType: "ucm",
        systemPromptOverride: await getBuiltinSystemPrompt(roleId),
        toolProfile: "coding",
        isBuiltin: 1,
        createdAt: now,
        updatedAt: now,
        ...(isReadonlyRole
          ? {
              disallowedTools: JSON.stringify(READONLY_DISALLOWED_TOOLS),
            }
          : {}),
        ...(roleId === "evaluator"
          ? {
              // No hard-coded model: the evaluator inherits the leader's
              // default binding at resolution time (see resolveAgentConfig),
              // so it works on whatever provider the operator configured.
              // It's purely a verification pass — its system prompt fully
              // implies the toolset (acceptance criteria → PASS/FAIL with
              // evidence) — so we skip the skill appendix to save the
              // metadata bytes per turn. Operators can pin a dedicated
              // model from Settings → Agents.
              omitSkills: 1,
            }
          : {}),
        ...(roleId === "memory-extractor"
          ? {
              // No hard-coded model: inherits the leader's default binding
              // at resolution time. The workload is classifier-style
              // (bounded input, JSON-shaped output, no tool use), so a
              // cheap model is ideal — operators can pin one from
              // Settings → Agents per project; user overrides survive boot
              // via the customization check.
              omitSkills: 1,
              // memory-extractor never runs the leader loop — it's a
              // one-shot prompt → JSON parse. Capping at 1 just
              // ensures any code path that DOES try to spawn it
              // through the loop fails fast instead of looping.
              maxTurns: 1,
              toolProfile: "minimal",
            }
          : {}),
        ...(roleId === "deepresearcher"
          ? {
              // Deep researcher is a read-only research specialist —
              // its prompt fully implies the toolset (web_search,
              // web_fetch, read_file). Skipping the skill appendix
              // saves metadata bytes per turn, similar to evaluator.
              omitSkills: 1,
              toolProfile: "research",
            }
          : {}),
      }).onConflictDoNothing();
      continue;
    }

    const patch: Partial<AgentProfileSelect> = {};
    if ((existing.isBuiltin ?? 0) !== 1) {
      patch.isBuiltin = 1;
    }
    const existingRuntime = normalizeRuntimeType(existing.runtimeType);
    if (!existingRuntime) {
      patch.runtimeType = "ucm";
    } else if (coerceLeaderRuntimeType(roleId, existingRuntime) !== existingRuntime) {
      patch.runtimeType = "ucm";
    }

    const existingLabel = existing.label?.trim() ?? "";
    const existingDisplayName = existing.displayName?.trim() ?? "";
    if (!existingLabel) {
      patch.label = existingDisplayName && !isLegacyLeaderLabel(roleId, existingDisplayName)
        ? existingDisplayName
        : BUILTIN_AGENT_LABELS[roleId];
    } else if (isLegacyLeaderLabel(roleId, existingLabel)) {
      patch.label = BUILTIN_AGENT_LABELS[roleId];
    }

    if (!existingDisplayName) {
      patch.displayName = existingLabel && !isLegacyLeaderLabel(roleId, existingLabel)
        ? existingLabel
        : BUILTIN_AGENT_LABELS[roleId];
    } else if (isLegacyLeaderLabel(roleId, existingDisplayName)) {
      patch.displayName = BUILTIN_AGENT_LABELS[roleId];
    }

    // Backfill: evaluator should have omitSkills=1 (ALTER TABLE defaults
    // to 0). Only force when at default 0; user overrides stick.
    if (roleId === "evaluator" && (existing.omitSkills ?? 0) === 0) {
      patch.omitSkills = 1;
    }

    // Backfill: reviewer and evaluator must never modify files. Only
    // force when column is null/empty; user overrides stick.
    const isReadonlyRole = roleId === "reviewer" || roleId === "evaluator";
    if (isReadonlyRole && !existing.disallowedTools) {
      patch.disallowedTools = JSON.stringify(READONLY_DISALLOWED_TOOLS);
    }

    // Hash-based auto-upgrade of system_prompt_override. Replaces
    // missing or known-obsolete versions with source-of-truth value.
    // Customized rows (hash matches neither) are preserved.
    const promptDecision = shouldUpgradeBuiltinPrompt(roleId, existing.systemPromptOverride);
    if (promptDecision.upgrade) {
      const sourceOfTruth = await getBuiltinSystemPrompt(roleId);
      // Defensive: if the source-of-truth somehow has the same hash
      // as one of the obsolete entries (someone forgot to update the
      // OBSOLETE list before changing the source), no-op rather than
      // looping write-after-write across boots.
      if (shortHash(sourceOfTruth) !== shortHash(existing.systemPromptOverride ?? "")) {
        patch.systemPromptOverride = sourceOfTruth;
        console.log(`[agent-profiles] auto-upgraded ${roleId} system prompt (${promptDecision.reason})`);
      }
    }

    if (Object.keys(patch).length > 0) {
      await db.update(agentProfiles).set({
        ...patch,
        updatedAt: now,
      }).where(eq(agentProfiles.roleId, roleId));
    }
  }

  const { seedAgentsFromConfig } = await import("./migrate-config-to-agents");
  await seedAgentsFromConfig();
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  await ensureDefaultAgentProfiles();
  const db = createDb();
  const items = await db.query.agentProfiles.findMany();
  return items.map(normalizeProfile);
}

export async function getAgentProfile(roleId: string): Promise<AgentProfile | null> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) {
    return null;
  }

  await ensureDefaultAgentProfiles();
  const db = createDb();
  const item = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, normalizedRoleId),
  });

  return item ? normalizeProfile(item) : null;
}

export async function getAgentRuntimeType(
  roleId: string,
): Promise<AgentRuntimeType | null> {
  const profile = await getAgentProfile(roleId);
  if (!profile) {
    return null;
  }

  const runtimeType = normalizeRuntimeType(profile.runtimeType);
  return runtimeType ?? "ucm";
}

export async function upsertAgentProfile(input: UpsertAgentProfileInput): Promise<AgentProfile> {
  const roleId = normalizeRoleId(input.roleId);
  if (!roleId) {
    throw new Error("roleId is required");
  }

  await ensureDefaultAgentProfiles();

  const db = createDb();
  const now = new Date();
  const normalizedRuntimeType = coerceLeaderRuntimeType(
    roleId,
    normalizeRuntimeType(input.runtimeType) ?? "ucm",
  );
  await validateToolNameLists(input);
  const encodedAllowedTools = encodeToolNameList(input.allowedTools);
  const encodedDisallowedTools = encodeToolNameList(input.disallowedTools);

  // Atomic insert-or-ignore for new profiles
  const normalizedLabel = toNullableTrimmedString(input.label) ?? roleId;
  await db.insert(agentProfiles).values({
    roleId,
    label: normalizedLabel,
    displayName: normalizedLabel,
    description: toNullableTrimmedString(input.description),
    systemPromptOverride: toNullableTrimmedString(input.systemPromptOverride),
    modelName: toNullableTrimmedString(input.modelName),
    modelOverride: toNullableTrimmedString(input.modelOverride),
    runtimeType: normalizedRuntimeType,
    provider: toNullableTrimmedString(input.provider),
    providerId: toNullableTrimmedString(input.providerId),
    reasoningMode: toNullableTrimmedString(input.reasoningMode),
    reasoningEffort: toNullableTrimmedString(input.reasoningEffort),
    contextWindow:
      typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
        ? Math.floor(input.contextWindow)
        : null,
    maxOutputTokens:
      typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
        ? Math.floor(input.maxOutputTokens)
        : null,
    fallbackModelName: toNullableTrimmedString(input.fallbackModelName),
    fallbackProviderId: toNullableTrimmedString(input.fallbackProviderId),
    commandPath: toNullableTrimmedString(input.commandPath),
    customEnv: toNullableTrimmedString(input.customEnv),
    customArgs: toNullableTrimmedString(input.customArgs),
    status: toNullableTrimmedString(input.status),
    mcpConfig: toNullableTrimmedString(input.mcpConfig),
    maxConcurrentTasks: typeof input.maxConcurrentTasks === "number"
      ? Math.max(1, Math.floor(input.maxConcurrentTasks))
      : null,
    maxTurns: typeof input.maxTurns === "number" ? input.maxTurns : 60,
    toolProfile: input.toolProfile ?? "coding",
    allowedTools: encodedAllowedTools,
    disallowedTools: encodedDisallowedTools,
    isBuiltin: typeof input.isBuiltin === "number" ? input.isBuiltin : 0,
    omitSkills: input.omitSkills === true ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  // Always apply updates (handles both new inserts and existing profiles)
  const existing = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, roleId),
  });

  if (existing) {
    const patch: Partial<AgentProfileSelect> = { updatedAt: now };

    if (Object.prototype.hasOwnProperty.call(input, "label")) {
      const patchLabel = toNullableTrimmedString(input.label) ?? existing.label?.trim() ?? existing.displayName?.trim() ?? roleId;
      patch.label = patchLabel;
      patch.displayName = patchLabel;
    }
    if (Object.prototype.hasOwnProperty.call(input, "description")) {
      patch.description = toNullableTrimmedString(input.description);
    }
    if (Object.prototype.hasOwnProperty.call(input, "systemPromptOverride")) {
      patch.systemPromptOverride = toNullableTrimmedString(input.systemPromptOverride);
    }
    if (Object.prototype.hasOwnProperty.call(input, "modelName")) {
      patch.modelName = toNullableTrimmedString(input.modelName);
    }
    if (Object.prototype.hasOwnProperty.call(input, "modelOverride")) {
      patch.modelOverride = toNullableTrimmedString(input.modelOverride);
    }
    if (Object.prototype.hasOwnProperty.call(input, "runtimeType")) {
      patch.runtimeType = coerceLeaderRuntimeType(
        roleId,
        normalizeRuntimeType(input.runtimeType) ?? "ucm",
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, "provider")) {
      patch.provider = toNullableTrimmedString(input.provider);
    }
    if (Object.prototype.hasOwnProperty.call(input, "providerId")) {
      patch.providerId = toNullableTrimmedString(input.providerId);
    }
    if (Object.prototype.hasOwnProperty.call(input, "reasoningMode")) {
      patch.reasoningMode = toNullableTrimmedString(input.reasoningMode);
    }
    if (Object.prototype.hasOwnProperty.call(input, "reasoningEffort")) {
      patch.reasoningEffort = toNullableTrimmedString(input.reasoningEffort);
    }
    if (Object.prototype.hasOwnProperty.call(input, "contextWindow")) {
      patch.contextWindow =
        typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
          ? Math.floor(input.contextWindow)
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "maxOutputTokens")) {
      patch.maxOutputTokens =
        typeof input.maxOutputTokens === "number" && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
          ? Math.floor(input.maxOutputTokens)
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "fallbackModelName")) {
      patch.fallbackModelName = toNullableTrimmedString(input.fallbackModelName);
    }
    if (Object.prototype.hasOwnProperty.call(input, "fallbackProviderId")) {
      patch.fallbackProviderId = toNullableTrimmedString(input.fallbackProviderId);
    }
    if (Object.prototype.hasOwnProperty.call(input, "commandPath")) {
      patch.commandPath = toNullableTrimmedString(input.commandPath);
    }
    if (Object.prototype.hasOwnProperty.call(input, "customEnv")) {
      patch.customEnv = toNullableTrimmedString(input.customEnv);
    }
    if (Object.prototype.hasOwnProperty.call(input, "customArgs")) {
      patch.customArgs = toNullableTrimmedString(input.customArgs);
    }
    if (Object.prototype.hasOwnProperty.call(input, "status")) {
      patch.status = toNullableTrimmedString(input.status);
    }
    if (Object.prototype.hasOwnProperty.call(input, "mcpConfig")) {
      patch.mcpConfig = toNullableTrimmedString(input.mcpConfig);
    }
    if (Object.prototype.hasOwnProperty.call(input, "maxConcurrentTasks")) {
      patch.maxConcurrentTasks =
        typeof input.maxConcurrentTasks === "number"
          ? Math.max(1, Math.floor(input.maxConcurrentTasks))
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "maxTurns")) {
      patch.maxTurns = input.maxTurns ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "toolProfile")) {
      patch.toolProfile = input.toolProfile ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "allowedTools")) {
      patch.allowedTools = encodedAllowedTools;
    }
    if (Object.prototype.hasOwnProperty.call(input, "disallowedTools")) {
      patch.disallowedTools = encodedDisallowedTools;
    }
    if (Object.prototype.hasOwnProperty.call(input, "isBuiltin") && typeof input.isBuiltin === "number") {
      patch.isBuiltin = input.isBuiltin;
    }
    if (Object.prototype.hasOwnProperty.call(input, "omitSkills")) {
      patch.omitSkills = input.omitSkills === true ? 1 : 0;
    }

    await db.update(agentProfiles).set(patch).where(eq(agentProfiles.roleId, roleId));
  }

  const updated = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, roleId),
  });

  if (!updated) {
    throw new Error(`Failed to upsert agent profile: ${roleId}`);
  }

  return normalizeProfile(updated);
}

export async function deleteAgentProfile(roleId: string): Promise<boolean> {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId || isBuiltinAgentRoleId(normalizedRoleId)) {
    return false;
  }

  await ensureDefaultAgentProfiles();

  const db = createDb();
  const existing = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, normalizedRoleId),
  });

  if (!existing || (existing.isBuiltin ?? 0) === 1) {
    return false;
  }

  await db.delete(agentProfiles).where(eq(agentProfiles.roleId, normalizedRoleId));

  const afterDelete = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, normalizedRoleId),
  });

  return !afterDelete;
}
