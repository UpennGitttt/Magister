import { createDb, agentProfiles } from "@magister/db";
import { eq } from "@magister/db";

import {
  readExecutorConfigFile,
  type ExecutorBindingRecord,
  type ExecutorConfigFile,
  type ModelProfileRecord,
} from "./executor-config-service";
import { getTeammateSystemPrompt } from "./manager-automation/teammate-system-prompts";

type RoleToAdapterMap = Record<string, string[]>;

const ROLE_PRIORITY = ["leader", "coder", "reviewer", "architect", "lander"] as const;
const ROLE_PRIORITY_INDEX = new Map<string, number>(
  ROLE_PRIORITY.map((role, index) => [role, index] as const),
);

type SeedAgentInput = {
  agentId: string;
  label: string;
  description: string;
  modelName: string | null;
  providerId: string | null;
  reasoningMode: string | null;
  reasoningEffort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  instructions: string | null;
  toolProfile: "full" | "coding" | "research" | "minimal";
};

type DerivedBindingContext = {
  modelName: string | null;
  providerId: string | null;
  reasoningMode: string | null;
  reasoningEffort: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
};

const DEFAULT_MANAGER_PROMPT = `You are a professional task orchestration manager.
Coordinate task execution, pick the right role, and keep progress moving.
Prefer direct answers for simple requests and delegate implementation/review work when needed.
Always ensure outputs are actionable, technically correct, and aligned with user intent.`;

function toNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function sanitizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferModelFamily(modelName: string, fallbackSeed: string): string {
  const normalizedName = sanitizeToken(modelName);
  const family = normalizedName.split("-")[0];
  if (family && family.length > 0) {
    return family;
  }

  const seed = sanitizeToken(fallbackSeed);
  return seed || "agent";
}

function pickPrimaryRole(roles: string[]): string | null {
  for (const preferred of ROLE_PRIORITY) {
    if (roles.includes(preferred)) {
      return preferred;
    }
  }

  const sorted = [...roles].sort((left, right) => left.localeCompare(right));
  return sorted[0] ?? null;
}

function buildRoleToAdapterMap(roleRouting: Record<string, { adapterId: string }>): RoleToAdapterMap {
  const next: RoleToAdapterMap = {};

  for (const [roleId, route] of Object.entries(roleRouting)) {
    const adapterId = route.adapterId?.trim();
    if (!adapterId) {
      continue;
    }

    const bucket = next[adapterId] ?? [];
    bucket.push(roleId);
    next[adapterId] = bucket;
  }

  return next;
}

function deriveProviderRef(binding: ExecutorBindingRecord, model: ModelProfileRecord): string | null {
  return (
    binding.providerRef?.trim() ||
    (binding.executionMode === "api" ? model.providerRefs?.api?.trim() : model.providerRefs?.cli?.trim()) ||
    null
  );
}

function deriveBindingContext(config: ExecutorConfigFile, roleId: string): DerivedBindingContext {
  const route = config.roleRouting[roleId];
  const adapterId = toNonEmpty(route?.adapterId);
  if (!adapterId) {
    return {
      modelName: null,
      providerId: null,
      reasoningMode: null,
      reasoningEffort: null,
      contextWindow: null,
      maxOutputTokens: null,
    };
  }

  const binding = config.bindings[adapterId];
  const model = binding ? config.models[binding.modelRef] : undefined;
  const modelName = toNonEmpty(model?.modelName);
  const providerId =
    (binding && model ? deriveProviderRef(binding, model) : null) ??
    toNonEmpty(model?.providerRefs?.api) ??
    toNonEmpty(model?.providerRefs?.cli) ??
    null;

  return {
    modelName,
    providerId,
    reasoningMode: toNonEmpty(model?.defaultReasoning?.mode),
    reasoningEffort: toNonEmpty(model?.defaultReasoning?.effort),
    contextWindow: toPositiveInteger(model?.contextWindow),
    maxOutputTokens: toPositiveInteger(model?.maxOutputTokens),
  };
}

function choosePreferredRole(currentRole: string | undefined, nextRole: string): string {
  if (!currentRole) {
    return nextRole;
  }

  const currentIndex = ROLE_PRIORITY_INDEX.get(currentRole) ?? Number.POSITIVE_INFINITY;
  const nextIndex = ROLE_PRIORITY_INDEX.get(nextRole) ?? Number.POSITIVE_INFINITY;
  return nextIndex < currentIndex ? nextRole : currentRole;
}

function buildGenericSeed(agentId: string, roleId: string, context: DerivedBindingContext): SeedAgentInput {
  const rolePrompt =
    roleId === "reviewer"
      ? getTeammateSystemPrompt("reviewer")
      : roleId === "coder"
      ? getTeammateSystemPrompt("coder")
      : roleId === "architect"
      ? getTeammateSystemPrompt("architect")
      : roleId === "lander"
      ? getTeammateSystemPrompt("lander")
      : DEFAULT_MANAGER_PROMPT;

  return {
    agentId,
    label: agentId,
    description: `Seeded from roleMapping for role "${roleId}"`,
    modelName: context.modelName,
    providerId: context.providerId,
    reasoningMode: context.reasoningMode ?? "auto",
    reasoningEffort: context.reasoningEffort ?? "medium",
    contextWindow: context.contextWindow,
    maxOutputTokens: context.maxOutputTokens,
    instructions: rolePrompt,
    toolProfile: roleId === "leader" ? "full" : "coding",
  };
}

async function seedAgentIfMissing(seed: SeedAgentInput): Promise<void> {
  const db = createDb();
  const existingById = await db.query.agentProfiles.findFirst({
    where: eq(agentProfiles.roleId, seed.agentId),
  });
  if (existingById) {
    return;
  }

  const now = new Date();
  await db.insert(agentProfiles).values({
    roleId: seed.agentId,
    label: seed.label,
    displayName: seed.label,
    description: seed.description,
    runtimeType: "ucm",
    modelName: seed.modelName,
    modelOverride: seed.modelName,
    providerId: seed.providerId,
    provider: seed.providerId,
    reasoningMode: seed.reasoningMode,
    reasoningEffort: seed.reasoningEffort,
    contextWindow: seed.contextWindow,
    maxOutputTokens: seed.maxOutputTokens,
    systemPromptOverride: seed.instructions,
    toolProfile: seed.toolProfile,
    maxTurns: 60,
    isBuiltin: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

export async function seedAgentsFromConfig(): Promise<void> {
  const config = await readExecutorConfigFile();
  const roleMapping = config.roleMapping ?? {};
  const preferredRoleByAgentId = new Map<string, string>();

  for (const [rawRoleId, rawAgentId] of Object.entries(roleMapping)) {
    const roleId = toNonEmpty(rawRoleId);
    const agentId = toNonEmpty(rawAgentId);
    if (!roleId || !agentId) {
      continue;
    }

    const current = preferredRoleByAgentId.get(agentId);
    preferredRoleByAgentId.set(agentId, choosePreferredRole(current, roleId));
  }

  const seeds = new Map<string, SeedAgentInput>();
  for (const [agentId, roleId] of preferredRoleByAgentId.entries()) {
    const context = deriveBindingContext(config, roleId);
    seeds.set(agentId, buildGenericSeed(agentId, roleId, context));
  }

  // Only seed if no agents exist for these IDs (don't create duplicates)
  for (const seed of seeds.values()) {
    await seedAgentIfMissing(seed);
  }
}

function deriveFallbackProviderRef(
  fallbackModelName: string | null,
  fallbackModelByName: Map<string, ModelProfileRecord>,
): string | null {
  if (!fallbackModelName) {
    return null;
  }

  const fallbackModel = fallbackModelByName.get(fallbackModelName);
  return fallbackModel?.providerRefs?.api?.trim() || fallbackModel?.providerRefs?.cli?.trim() || null;
}

function ensureUniqueAgentId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let suffix = 2;
  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  const nextId = `${baseId}-${suffix}`;
  usedIds.add(nextId);
  return nextId;
}

export async function migrateConfigToAgents(): Promise<void> {
  const { upsertAgentProfile } = await import("./agent-profile-service");
  const config = await readExecutorConfigFile();
  const roleToAdapter = buildRoleToAdapterMap(config.roleRouting);
  const fallbackModelByName = new Map<string, ModelProfileRecord>(
    Object.values(config.models)
      .filter((model): model is ModelProfileRecord => Boolean(model?.modelName))
      .map((model) => [model.modelName, model]),
  );
  const usedAgentIds = new Set<string>();

  for (const [bindingId, binding] of Object.entries(config.bindings)) {
    const model = config.models[binding.modelRef];
    if (!model?.modelName) {
      continue;
    }

    const roles = roleToAdapter[bindingId] ?? [];
    const primaryRole = pickPrimaryRole(roles);
    const family = inferModelFamily(model.modelName, bindingId);
    const roleOrBinding = primaryRole ?? (sanitizeToken(bindingId.replace(/-binding$/i, "")) || "agent");
    const agentId = ensureUniqueAgentId(`${family}-${roleOrBinding}`, usedAgentIds);

    const providerRef = deriveProviderRef(binding, model);
    const fallbackModelName = model.fallbacks?.[0]?.trim() || null;
    const fallbackProviderId = deriveFallbackProviderRef(fallbackModelName, fallbackModelByName);

    await upsertAgentProfile({
      roleId: agentId,
      label: model.label?.trim() || agentId,
      description: `Migrated from executor binding ${bindingId}`,
      runtimeType: "ucm",
      modelName: model.modelName,
      modelOverride: model.modelName,
      provider: providerRef,
      providerId: providerRef,
      reasoningMode: model.defaultReasoning?.mode ?? null,
      reasoningEffort: model.defaultReasoning?.effort ?? null,
      contextWindow: model.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      fallbackModelName,
      fallbackProviderId,
      maxTurns: 60,
      toolProfile: "coding",
      isBuiltin: 0,
    });
  }
}
