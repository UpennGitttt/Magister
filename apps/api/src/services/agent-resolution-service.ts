import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentProfiles, createDb, type AgentProfileSelect } from "@magister/db";
import { eq } from "@magister/db";

import {
  readExecutorConfigFile,
  type ProviderConfigRecord,
} from "./executor-config-service";

type AgentRuntimeType = "ucm" | "codex" | "opencode" | "claude-code" | "kiro";

export type ProviderConfig = { id: string } & ProviderConfigRecord;

export type ResolvedAgentConfig = {
  agent: AgentProfileSelect;
  runtimeType: AgentRuntimeType;
  modelName: string;
  provider?: ProviderConfig;
  reasoning?: { mode: string; effort?: string };
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Primary model capability hints (e.g. { vision: true }). Carried so the
   *  streaming caller's image-stripping gate sees the right value on the
   *  agent-profile leader + teammate paths (was previously dropped). */
  capabilityHints?: Record<string, unknown>;
  commandPath?: string;
  customEnv?: Record<string, string>;
  customArgs?: string[];
  fallback?: {
    modelName: string;
    provider?: ProviderConfig;
    // Resolved from the fallback's own model record (config.models[name]),
    // NOT inherited from the primary — so the streaming caller can apply the
    // fallback model's true vision capability / output limit / context window
    // on a fallback attempt (PR2 wiring).
    capabilityHints?: Record<string, unknown>;
    maxOutputTokens?: number;
    contextWindow?: number;
  };
};

function normalizeRuntimeType(value: string | null | undefined): AgentRuntimeType {
  if (value === "ucm" || value === "codex" || value === "opencode" || value === "claude-code" || value === "kiro") {
    return value;
  }
  return "ucm";
}

/**
 * The leader runs a continuous model→tool_use→observation loop, so its
 * runtime must either be the native API loop ("ucm") or a runtime that
 * can drive that loop itself with Magister tools injected — today only
 * "claude-code" (via the Agent SDK; see claude-code-leader-runtime.ts).
 * One-shot CLI bridges (codex/opencode/kiro) can't lead and coerce to ucm.
 */
function isLeaderCapableRuntime(runtimeType: AgentRuntimeType): boolean {
  return runtimeType === "ucm" || runtimeType === "claude-code";
}

function coerceLeaderRuntimeType(roleId: string, runtimeType: AgentRuntimeType): AgentRuntimeType {
  if (roleId !== "leader" && roleId !== "manager") {
    return runtimeType;
  }
  return isLeaderCapableRuntime(runtimeType) ? runtimeType : "ucm";
}

function toNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toProviderConfig(id: string, record: ProviderConfigRecord): ProviderConfig {
  return { id, ...record };
}

function executorConfigPath() {
  return process.env.MAGISTER_EXECUTOR_CONFIG_PATH?.trim() || join(process.cwd(), "config", "executors.json");
}

async function readRoleMapping(): Promise<Record<string, string>> {
  const configPath = executorConfigPath();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { roleMapping?: unknown } | null;
    const roleMapping = parsed && typeof parsed === "object" ? parsed.roleMapping : undefined;
    if (!roleMapping || typeof roleMapping !== "object" || Array.isArray(roleMapping)) {
      return {};
    }

    const entries = Object.entries(roleMapping).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].trim().length > 0,
    );

    return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value.trim()]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[agent-resolution] Failed to read roleMapping from executor config:", error);
    }
    return {};
  }
}

function parseJsonObject(input: string | null | undefined): Record<string, string> | undefined {
  const trimmed = toNonEmpty(input);
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const normalizedEntries = Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string",
    );
    return Object.fromEntries(normalizedEntries);
  } catch (error) {
    console.warn("[agent-resolution] Failed to parse customEnv JSON:", error);
    return undefined;
  }
}

function parseJsonArray(input: string | null | undefined): string[] | undefined {
  const trimmed = toNonEmpty(input);
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch (error) {
    console.warn("[agent-resolution] Failed to parse customArgs JSON:", error);
    return undefined;
  }
}

export async function resolveAgentConfig(agentId: string): Promise<ResolvedAgentConfig | null> {
  const normalizedAgentId = toNonEmpty(agentId);
  if (!normalizedAgentId) {
    return null;
  }

  const db = createDb();
  const agent = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, normalizedAgentId),
  });
  if (!agent) {
    return null;
  }

  const runtimeType = coerceLeaderRuntimeType(agent.roleId, normalizeRuntimeType(agent.runtimeType));
  let modelName = toNonEmpty(agent.modelName) ?? toNonEmpty(agent.modelOverride) ?? "";

  if (runtimeType !== "ucm") {
    const commandPath = toNonEmpty(agent.commandPath);
    const customEnv = parseJsonObject(agent.customEnv);
    const customArgs = parseJsonArray(agent.customArgs);
    return {
      agent,
      runtimeType,
      modelName,
      ...(commandPath ? { commandPath } : {}),
      ...(customEnv ? { customEnv } : {}),
      ...(customArgs ? { customArgs } : {}),
    };
  }

  const config = await readExecutorConfigFile();

  // Built-in classifier roles (evaluator, memory-extractor) are seeded with
  // NO model on purpose — they inherit the leader's default binding here, so
  // they resolve on whatever provider the operator configured instead of
  // pointing at a hard-coded one. Without this, those roles return null and
  // silently never run. Scoped to exactly these two roles so that custom
  // model-less agents keep their existing behavior (resolve to null → the
  // caller can supply its own model caller).
  if (!modelName && (agent.roleId === "evaluator" || agent.roleId === "memory-extractor")) {
    const leaderRoute = config.roleRouting.leader ?? config.roleRouting.manager;
    const defaultBinding = leaderRoute ? config.bindings[leaderRoute.adapterId] : undefined;
    const inherited = toNonEmpty(defaultBinding?.modelRef);
    if (inherited) {
      modelName = inherited;
    }
  }

  // Provider precedence:
  //   1. agent.providerId          (preferred — explicit on the profile)
  //   2. agent.provider             (legacy column, same intent)
  //   3. model.providerRefs.api/cli (derived — every model already
  //      knows which provider serves it; no reason to require the
  //      agent to repeat that info)
  //
  // The third tier exists because a freshly-seeded agent_profile may
  // carry only the model name without yet writing back the provider
  // (e.g. import paths, migration, or the user just typing a model
  // name in the Agents form). Without this fallback the leader hangs
  // forever waiting on a null provider.
  const modelRecord = modelName ? config.models[modelName] : undefined;
  let providerId = toNonEmpty(agent.providerId) ?? toNonEmpty(agent.provider);
  if (!providerId && modelRecord) {
    providerId =
      toNonEmpty(modelRecord.providerRefs?.api)
      ?? toNonEmpty(modelRecord.providerRefs?.cli);
  }

  if (!providerId) {
    console.warn(
      `[agent-resolution] Role "${agent.roleId}" has no provider configured yet — ` +
        `this is expected on a fresh install and the API is running fine. Open the web ` +
        `console → Settings → Providers to add a provider + API key (or edit config/executors.json).`,
    );
    return null;
  }

  const providerRecord = config.providers[providerId];
  if (!providerRecord) {
    console.warn(`[agent-resolution] Provider "${providerId}" not found for agent "${agent.roleId}"`);
    return null;
  }

  const reasoningMode = toNonEmpty(agent.reasoningMode);
  const reasoningEffort = toNonEmpty(agent.reasoningEffort);
  const reasoning =
    reasoningMode || reasoningEffort
      ? {
          mode: reasoningMode ?? "auto",
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        }
      : undefined;

  const fallbackModelName = toNonEmpty(agent.fallbackModelName);
  const fallbackProviderId = toNonEmpty(agent.fallbackProviderId) ?? providerId;
  const fallbackProviderRecord = fallbackProviderId
    ? config.providers[fallbackProviderId]
    : undefined;
  // Resolve the fallback's OWN model record (mirrors the primary lookup at
  // `config.models[modelName]` above) so we carry its real capability/limits
  // instead of inheriting the primary's.
  const fallbackModelRecord = fallbackModelName ? config.models[fallbackModelName] : undefined;
  const fallback = fallbackModelName
    ? {
        modelName: fallbackModelName,
        ...(fallbackProviderRecord
          ? { provider: toProviderConfig(fallbackProviderId, fallbackProviderRecord) }
          : {}),
        ...(fallbackModelRecord?.capabilityHints
          ? { capabilityHints: fallbackModelRecord.capabilityHints }
          : {}),
        ...(typeof fallbackModelRecord?.maxOutputTokens === "number"
          ? { maxOutputTokens: fallbackModelRecord.maxOutputTokens }
          : {}),
        ...(typeof fallbackModelRecord?.contextWindow === "number"
          ? { contextWindow: fallbackModelRecord.contextWindow }
          : {}),
      }
    : undefined;

  return {
    agent,
    runtimeType,
    modelName,
    provider: toProviderConfig(providerId, providerRecord),
    ...(reasoning ? { reasoning } : {}),
    ...(typeof agent.contextWindow === "number"
      ? { contextWindow: agent.contextWindow }
      : modelRecord?.contextWindow ? { contextWindow: modelRecord.contextWindow } : {}),
    ...(typeof agent.maxOutputTokens === "number"
      ? { maxOutputTokens: agent.maxOutputTokens }
      : modelRecord?.maxOutputTokens ? { maxOutputTokens: modelRecord.maxOutputTokens } : {}),
    // S4 — carry the primary model's capability hints so the vision gate works
    // on the agent-profile leader + teammate paths (mirrors the fallback branch).
    ...(modelRecord?.capabilityHints ? { capabilityHints: modelRecord.capabilityHints } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * Project the optional model fields (context window, output limit, capability
 * hints) from a resolved agent config into a ModelProfile fragment. Shared by
 * the ModelProfile build sites so a field is never silently dropped by one
 * callsite (the historical cause of the vision-strip bug). Omits absent fields
 * so no `undefined` keys leak under exactOptionalPropertyTypes.
 */
export function agentConfigModelProfileFields(c: {
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  capabilityHints?: Record<string, unknown> | undefined;
}): { contextWindow?: number; maxOutputTokens?: number; capabilityHints?: Record<string, unknown> } {
  return {
    ...(typeof c.contextWindow === "number" ? { contextWindow: c.contextWindow } : {}),
    ...(typeof c.maxOutputTokens === "number" ? { maxOutputTokens: c.maxOutputTokens } : {}),
    ...(c.capabilityHints ? { capabilityHints: c.capabilityHints } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic role discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in role floor used as a degradation fallback when both config and DB
 * reads fail. Keeps the classifier functional even in a fresh or broken install.
 */
const BUILTIN_ROLE_FLOOR = ["coder", "reviewer", "architect", "lander", "evaluator"] as const;

/**
 * Pure helper: merges two lists of role-id candidates into a deduplicated,
 * non-blank array. Exported so unit tests can cover the merge logic without
 * touching the filesystem or DB.
 */
export function mergeRoleCandidates(mappingKeys: string[], dbRoleIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of [...mappingKeys, ...dbRoleIds]) {
    const trimmed = r?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Returns the deduplicated set of role IDs available in this installation,
 * gathered from both `config/executors.json` roleMapping keys AND distinct
 * `roleId` values in `agent_profiles`.
 *
 * Degrades gracefully on any error:
 *  - Config read failure → falls back to [] for that source (ENOENT is silent;
 *    other errors emit a [agent-resolution] warning).
 *  - DB read failure → falls back to [] for that source with a warning.
 *  - If both fail, returns the built-in floor roles so the policy classifier
 *    always has a sensible seed to work with.
 */
export async function listAvailableRoles(): Promise<string[]> {
  // Source 1: roleMapping keys from config/executors.json
  let mappingKeys: string[] = [];
  try {
    const mapping = await readRoleMapping();
    mappingKeys = Object.keys(mapping);
  } catch (err) {
    console.warn("[agent-resolution] listAvailableRoles: failed to read roleMapping:", err);
  }

  // Source 2: distinct roleId values from agent_profiles table
  let dbRoleIds: string[] = [];
  try {
    const db = createDb();
    const rows = await db.query.agentProfiles.findMany({ columns: { roleId: true } });
    dbRoleIds = rows.map((r) => r.roleId).filter((id): id is string => Boolean(id?.trim()));
  } catch (err) {
    console.warn("[agent-resolution] listAvailableRoles: failed to query agent_profiles:", err);
  }

  const merged = mergeRoleCandidates(mappingKeys, dbRoleIds);

  // Fallback: if both sources yielded nothing, return the built-in floor so
  // the classifier always has a sensible role seed to work with.
  if (merged.length === 0) {
    console.warn("[agent-resolution] listAvailableRoles: no roles from config or DB — returning built-in floor");
    return [...BUILTIN_ROLE_FLOOR];
  }

  return merged;
}

export async function resolveAgentForRole(roleId: string): Promise<ResolvedAgentConfig | null> {
  const normalizedRoleId = toNonEmpty(roleId);
  if (!normalizedRoleId) {
    return null;
  }

  const roleMapping = await readRoleMapping();
  // `leader` is canonical. Old installs may still use `manager` in
  // roleMapping or agent_profiles rows. Try canonical first, fall back
  // to legacy so existing data keeps resolving.
  const candidateRoleIds = normalizedRoleId === "leader" || normalizedRoleId === "manager"
    ? ["leader", "manager"]
    : [normalizedRoleId];
  const enforceLeaderRuntime = normalizedRoleId === "leader" || normalizedRoleId === "manager";
  for (const candidate of candidateRoleIds) {
    const mappedAgentId = toNonEmpty(roleMapping[candidate]);
    if (mappedAgentId) {
      const resolved = await resolveAgentConfig(mappedAgentId);
      if (resolved && enforceLeaderRuntime && !isLeaderCapableRuntime(resolved.runtimeType)) {
        console.warn(
          `[agent-resolution] Ignoring leader-incapable runtime "${resolved.runtimeType}" for leader role mapping "${candidate}" -> "${mappedAgentId}"`,
        );
        continue;
      }
      if (resolved) return resolved;
    }
  }
  for (const candidate of candidateRoleIds) {
    const resolved = await resolveAgentConfig(candidate);
    if (resolved) return resolved;
  }
  return null;
}
