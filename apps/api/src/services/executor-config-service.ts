import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type ExecutorAdapterId,
  type RoleRoutingConfigRecord,
  type RoleRoutingStrategy,
  getDefaultRoleRoutingForRole,
  getExecutorCatalogEntry,
} from "../executors/executor-catalog";
import {
  collectSecretRefsFromHeaderRules,
  getProviderAuthSecretRefs,
  getSecretStatus,
} from "./local-secret-store-service";
import { ReasoningPolicySchema, ExecutorConfigFileSchema } from "./config-schemas";

export type ExecutorConfigRecord = {
  authMode?: "chatgpt" | "api_key";
  commandPath?: string;
  configuredModel?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type RoleRoutingMap = Record<string, RoleRoutingConfigRecord>;
export type RoleMappingMap = Record<string, string>;

export type ApiDialect =
  | "openai_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "cli_native";

export type ProviderAuthConfig =
  | { kind: "chatgpt_session" }
  | { kind: "api_key"; secretRef: string; headerName?: string; prefix?: string }
  | { kind: "oauth_token"; secretRef: string; headerName?: string; prefix?: string }
  | { kind: "none" };

export type ProviderHeaderRule = {
  name: string;
  value?: string;
  secretRef?: string;
  envRef?: string;
  whenDialect?: ApiDialect[];
  whenModelPattern?: string[];
};

export type ProviderConfigRecord = {
  presetId?: string;
  label?: string;
  vendor?: string;
  transport: "cli" | "api";
  apiDialect: ApiDialect;
  baseUrl?: string;
  auth?: ProviderAuthConfig;
  headers?: ProviderHeaderRule[];
  cli?: {
    commandPath?: string;
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  };
  requestOverrides?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  quirks?: Record<string, unknown>;
};

export type ReasoningPolicy = {
  mode: "off" | "auto" | "on";
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  budgetTokens?: number;
  visibility?: "hidden" | "summary" | "full";
};

export type ModelProfileRecord = {
  label?: string;
  vendor?: string;
  modelName: string;
  fallbacks?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  providerRefs?: {
    cli?: string;
    api?: string;
  };
  defaultReasoning?: ReasoningPolicy;
  requestOverrides?: Record<string, unknown>;
  capabilityHints?: Record<string, unknown>;
  /** Stable models.dev catalog identity (set when added from the catalog). */
  catalogProviderId?: string;
  catalogModelId?: string;
};

export type ExecutorBindingRecord = {
  executionMode: "cli" | "api";
  modelRef: string;
  providerRef?: string;
  timeoutMs?: number;
  commandPath?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
};

export type ExecutorConfigFile = {
  executors: Record<string, ExecutorConfigRecord>;
  roleRouting: RoleRoutingMap;
  roleMapping?: RoleMappingMap;
  providers: Record<string, ProviderConfigRecord>;
  models: Record<string, ModelProfileRecord>;
  bindings: Record<string, ExecutorBindingRecord>;
};

export type ProviderConfigInput = {
  presetId?: string | null | undefined;
  label?: string | null;
  vendor?: string | null;
  transport: ProviderConfigRecord["transport"];
  apiDialect: ApiDialect;
  baseUrl?: string | null;
  auth: ProviderAuthConfig;
  headers?: ProviderHeaderRule[] | null | undefined;
  cli?: {
    commandPath?: string | null;
    sandboxMode?: ProviderConfigRecord["cli"] extends infer CliConfig
      ? CliConfig extends { sandboxMode?: infer SandboxMode }
        ? SandboxMode | null
        : never
      : never;
  } | null | undefined;
  requestOverrides?: Record<string, unknown> | null | undefined;
  capabilities?: Record<string, unknown> | null | undefined;
  quirks?: Record<string, unknown> | null | undefined;
};

export type ModelProfileInput = {
  label?: string | null;
  vendor?: string | null;
  modelName: string;
  fallbacks?: string[] | null | undefined;
  contextWindow?: number | null | undefined;
  maxOutputTokens?: number | null | undefined;
  providerRefs?: {
    cli?: string | null;
    api?: string | null;
  } | null | undefined;
  defaultReasoning?: ReasoningPolicy | null | undefined;
  requestOverrides?: Record<string, unknown> | null | undefined;
  capabilityHints?: Record<string, unknown> | null | undefined;
  catalogProviderId?: string | null | undefined;
  catalogModelId?: string | null | undefined;
};

export type ExecutorBindingInput = {
  executionMode: ExecutorBindingRecord["executionMode"];
  modelRef: string;
  providerRef?: string | null | undefined;
  timeoutMs?: number | null | undefined;
  commandPath?: string | null | undefined;
  sandboxMode?: ExecutorBindingRecord["sandboxMode"] | null | undefined;
};

export type ResolvedExecutorConfiguration = {
  configSource: "file" | "env" | "default";
  executionMode?: "cli" | "api";
  authMode?: ExecutorConfigRecord["authMode"];
  commandPath?: string;
  configuredModel?: string;
  sandboxMode?: ExecutorConfigRecord["sandboxMode"];
  timeoutMs?: number;
  providerRef?: string;
  modelRef?: string;
};

export type ReadinessSnapshot = {
  ready: boolean;
  missing: string[];
};

export type ProviderPresetRecord = {
  label: string;
  vendor: string;
  transport: "cli" | "api";
  apiDialect: ApiDialect;
  baseUrl: string;
  auth: ProviderAuthConfig;
};

type LegacyExecutorConfigMap = Record<string, ExecutorConfigRecord>;

const DIALECTS: ApiDialect[] = [
  "openai_chat_completions",
  "openai_responses",
  "anthropic_messages",
  "gemini_generate_content",
  "cli_native",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExecutorAdapterId(value: string): value is ExecutorAdapterId {
  return getExecutorCatalogEntry(value) !== null;
}

function isExecutorConfigRecord(value: unknown): value is ExecutorConfigRecord {
  if (!isPlainObject(value)) {
    return false;
  }

  if (
    !("configuredModel" in value) &&
    !("authMode" in value) &&
    !("commandPath" in value) &&
    !("sandboxMode" in value) &&
    !("timeoutMs" in value)
  ) {
    return true;
  }

  return (
    (value.authMode === undefined || value.authMode === "chatgpt" || value.authMode === "api_key") &&
    (value.commandPath === undefined || typeof value.commandPath === "string") &&
    (value.sandboxMode === undefined ||
      value.sandboxMode === "read-only" ||
      value.sandboxMode === "workspace-write" ||
      value.sandboxMode === "danger-full-access") &&
    (value.configuredModel === undefined || typeof value.configuredModel === "string") &&
    (value.timeoutMs === undefined ||
      (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)))
  );
}

function normalizeExecutorConfigRecord(value: ExecutorConfigRecord): ExecutorConfigRecord {
  const authMode = value.authMode === "chatgpt" || value.authMode === "api_key"
    ? value.authMode
    : undefined;
  const commandPath = value.commandPath?.trim() ? value.commandPath.trim() : undefined;
  const configuredModel = value.configuredModel?.trim() ? value.configuredModel.trim() : undefined;
  const sandboxMode =
    value.sandboxMode === "read-only" ||
    value.sandboxMode === "workspace-write" ||
    value.sandboxMode === "danger-full-access"
      ? value.sandboxMode
      : undefined;
  const timeoutMs =
    typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
      ? Math.round(value.timeoutMs)
      : undefined;

  return {
    ...(authMode ? { authMode } : {}),
    ...(commandPath ? { commandPath } : {}),
    ...(configuredModel ? { configuredModel } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function normalizeExecutorMap(value: unknown): Record<string, ExecutorConfigRecord> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value).filter(
    (entry): entry is [string, ExecutorConfigRecord] => isExecutorConfigRecord(entry[1]),
  );

  return Object.fromEntries(
    entries.map(([adapterId, record]) => [adapterId, normalizeExecutorConfigRecord(record)]),
  );
}

function normalizeRoleRoutingMap(value: unknown): RoleRoutingMap {
  if (!isPlainObject(value)) {
    return {};
  }

  const next: RoleRoutingMap = {};

  // Codex review Q3: when both `leader` and `manager` keys exist
  // in the same config object, the explicit `leader` MUST win
  // regardless of JSON property order. Detect both up front so we
  // can route the `manager` alias to a no-op when `leader` is
  // present, instead of relying on iteration order. (Object.entries
  // preserves insertion order, so leader-then-manager would
  // overwrite leader — that's the regression Codex flagged.)
  const hasExplicitLeader = "leader" in (value as Record<string, unknown>);

  for (const [rawRoleId, record] of Object.entries(value)) {
    // Canonical role is `leader`. Old configs may use `manager`.
    // Normalize on read; explicit `leader` trumps legacy alias.
    if (rawRoleId === "manager" && hasExplicitLeader) {
      continue; // explicit leader wins; ignore the legacy alias
    }
    const roleId = rawRoleId === "manager" ? "leader" : rawRoleId;
    if (typeof record === "string" && record.trim().length > 0) {
      const adapterId = record.trim();

      const defaultRoute = getDefaultRoleRoutingForRole(roleId);
      const catalogEntry = getExecutorCatalogEntry(adapterId);
      next[roleId] = {
        adapterId,
        strategy:
          defaultRoute?.strategy ??
          (catalogEntry?.executorType === "model"
            ? "model_only"
            : "agent_only"),
        ...(defaultRoute?.fallbackAdapterId
          ? { fallbackAdapterId: defaultRoute.fallbackAdapterId }
          : {}),
      };
      continue;
    }

    if (!isPlainObject(record) || typeof record.adapterId !== "string" || !record.adapterId.trim()) {
      continue;
    }

    const adapterId = record.adapterId.trim();

    const strategy =
      record.strategy === "agent_only" ||
      record.strategy === "prefer_agent" ||
      record.strategy === "fallback_model" ||
      record.strategy === "model_only"
        ? (record.strategy as RoleRoutingStrategy)
        : undefined;
    const fallbackAdapterIdCandidate =
      typeof record.fallbackAdapterId === "string" && record.fallbackAdapterId.trim()
        ? record.fallbackAdapterId.trim()
        : undefined;
    const fallbackAdapterId = fallbackAdapterIdCandidate ?? undefined;
    const defaultRoute = getDefaultRoleRoutingForRole(roleId);
    const effectiveStrategy =
      strategy ??
      defaultRoute?.strategy ??
      (getExecutorCatalogEntry(adapterId)?.executorType === "model"
        ? "model_only"
        : "agent_only");
    const effectiveFallbackAdapterId =
      fallbackAdapterId ??
      (effectiveStrategy === "fallback_model" ? defaultRoute?.fallbackAdapterId : undefined);

    next[roleId] = {
      adapterId,
      strategy: effectiveStrategy,
      ...(effectiveFallbackAdapterId ? { fallbackAdapterId: effectiveFallbackAdapterId } : {}),
    };
  }

  return next;
}

function normalizeRoleMappingMap(value: unknown): RoleMappingMap {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string" && entry[1].trim().length > 0;
  });

  return Object.fromEntries(entries.map(([roleId, agentId]) => [roleId, agentId.trim()]));
}

function normalizeProviderAuthConfig(value: unknown): ProviderAuthConfig | undefined {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    return undefined;
  }

  if (value.kind === "chatgpt_session" || value.kind === "none") {
    return { kind: value.kind };
  }

  if (
    (value.kind === "api_key" || value.kind === "oauth_token") &&
    typeof value.secretRef === "string" &&
    value.secretRef.trim()
  ) {
    return {
      kind: value.kind,
      secretRef: value.secretRef.trim(),
      ...(typeof value.headerName === "string" && value.headerName.trim()
        ? { headerName: value.headerName.trim() }
        : {}),
      ...(typeof value.prefix === "string" && value.prefix.length > 0
        ? { prefix: value.prefix }
        : {}),
    };
  }

  return undefined;
}

function normalizeHeaderRule(value: unknown): ProviderHeaderRule | undefined {
  if (!isPlainObject(value) || typeof value.name !== "string" || !value.name.trim()) {
    return undefined;
  }

  const whenDialect = Array.isArray(value.whenDialect)
    ? value.whenDialect.filter((item): item is ApiDialect => typeof item === "string" && DIALECTS.includes(item as ApiDialect))
    : undefined;
  const whenModelPattern = Array.isArray(value.whenModelPattern)
    ? value.whenModelPattern.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

  return {
    name: value.name.trim(),
    ...(typeof value.value === "string" && value.value.trim() ? { value: value.value.trim() } : {}),
    ...(typeof value.secretRef === "string" && value.secretRef.trim()
      ? { secretRef: value.secretRef.trim() }
      : {}),
    ...(typeof value.envRef === "string" && value.envRef.trim() ? { envRef: value.envRef.trim() } : {}),
    ...(whenDialect && whenDialect.length > 0 ? { whenDialect } : {}),
    ...(whenModelPattern && whenModelPattern.length > 0 ? { whenModelPattern } : {}),
  };
}

function normalizeProviderConfigRecord(value: unknown): ProviderConfigRecord | undefined {
  if (
    !isPlainObject(value) ||
    (value.transport !== "cli" && value.transport !== "api") ||
    typeof value.apiDialect !== "string" ||
    !DIALECTS.includes(value.apiDialect as ApiDialect)
  ) {
    return undefined;
  }

  const auth = normalizeProviderAuthConfig(value.auth);
  const headers = Array.isArray(value.headers)
    ? value.headers.map(normalizeHeaderRule).filter((rule): rule is ProviderHeaderRule => Boolean(rule))
    : [];
  let cli: ProviderConfigRecord["cli"] | undefined;
  if (isPlainObject(value.cli)) {
    const commandPath =
      typeof value.cli.commandPath === "string" && value.cli.commandPath.trim()
        ? value.cli.commandPath.trim()
        : undefined;
    const sandboxMode =
      value.cli.sandboxMode === "read-only" ||
      value.cli.sandboxMode === "workspace-write" ||
      value.cli.sandboxMode === "danger-full-access"
        ? value.cli.sandboxMode
        : undefined;

    cli = {
      ...(commandPath ? { commandPath } : {}),
      ...(sandboxMode ? { sandboxMode } : {}),
    };
  }

  return {
    transport: value.transport,
    apiDialect: value.apiDialect as ApiDialect,
    ...(typeof value.presetId === "string" && value.presetId.trim()
      ? { presetId: value.presetId.trim() }
      : {}),
    ...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim() } : {}),
    ...(typeof value.vendor === "string" && value.vendor.trim() ? { vendor: value.vendor.trim() } : {}),
    ...(typeof value.baseUrl === "string" && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
    ...(auth ? { auth } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(cli && Object.keys(cli).length > 0 ? { cli } : {}),
    ...(isPlainObject(value.requestOverrides) ? { requestOverrides: value.requestOverrides } : {}),
    ...(isPlainObject(value.capabilities) ? { capabilities: value.capabilities } : {}),
    ...(isPlainObject(value.quirks) ? { quirks: value.quirks } : {}),
  };
}

function normalizeProviderMap(value: unknown): Record<string, ProviderConfigRecord> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .map(([providerRef, record]) => [providerRef, normalizeProviderConfigRecord(record)] as const)
    .filter(([, record]) => Boolean(record));

  return Object.fromEntries(
    entries.map(([providerRef, record]) => [providerRef, record as ProviderConfigRecord]),
  );
}

function normalizeReasoningPolicy(value: unknown): ReasoningPolicy | undefined {
  const result = ReasoningPolicySchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const data = result.data;
  return {
    mode: data.mode,
    ...(data.effort !== undefined ? { effort: data.effort } : {}),
    ...(data.budgetTokens !== undefined ? { budgetTokens: data.budgetTokens } : {}),
    ...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
  };
}

function normalizeModelProfileRecord(value: unknown): ModelProfileRecord | undefined {
  if (!isPlainObject(value) || typeof value.modelName !== "string" || !value.modelName.trim()) {
    return undefined;
  }

  const fallbacks = Array.isArray(value.fallbacks)
    ? [...new Set(
        value.fallbacks
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      )]
    : undefined;
  const providerRefs = isPlainObject(value.providerRefs)
    ? {
        ...(typeof value.providerRefs.cli === "string" && value.providerRefs.cli.trim()
          ? { cli: value.providerRefs.cli.trim() }
          : {}),
        ...(typeof value.providerRefs.api === "string" && value.providerRefs.api.trim()
          ? { api: value.providerRefs.api.trim() }
          : {}),
      }
    : undefined;
  const defaultReasoning = normalizeReasoningPolicy(value.defaultReasoning);

  const contextWindow = typeof value.contextWindow === "number" && value.contextWindow > 0
    ? value.contextWindow
    : undefined;
  const maxOutputTokens = typeof value.maxOutputTokens === "number" && value.maxOutputTokens > 0
    ? value.maxOutputTokens
    : undefined;

  return {
    modelName: value.modelName.trim(),
    ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}),
    ...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim() } : {}),
    ...(typeof value.vendor === "string" && value.vendor.trim() ? { vendor: value.vendor.trim() } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(providerRefs && Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
    ...(defaultReasoning ? { defaultReasoning } : {}),
    ...(isPlainObject(value.requestOverrides) ? { requestOverrides: value.requestOverrides } : {}),
    ...(isPlainObject(value.capabilityHints) ? { capabilityHints: value.capabilityHints } : {}),
    ...(typeof value.catalogProviderId === "string" && value.catalogProviderId.trim()
      ? { catalogProviderId: value.catalogProviderId.trim() }
      : {}),
    ...(typeof value.catalogModelId === "string" && value.catalogModelId.trim()
      ? { catalogModelId: value.catalogModelId.trim() }
      : {}),
  };
}

/**
 * Map a ModelProfileInput (nullable API shape) into a normalized
 * ModelProfileRecord. Single source of truth so updateModelConfig and
 * addModelsBatch never drift on which fields they persist.
 */
function normalizeModelInput(input: ModelProfileInput): ModelProfileRecord | undefined {
  const providerRefs =
    input.providerRefs && (input.providerRefs.cli || input.providerRefs.api)
      ? {
          ...(input.providerRefs.cli ? { cli: input.providerRefs.cli } : {}),
          ...(input.providerRefs.api ? { api: input.providerRefs.api } : {}),
        }
      : undefined;
  return normalizeModelProfileRecord({
    label: input.label ?? undefined,
    vendor: input.vendor ?? undefined,
    modelName: input.modelName,
    fallbacks: input.fallbacks ?? undefined,
    contextWindow: input.contextWindow ?? undefined,
    maxOutputTokens: input.maxOutputTokens ?? undefined,
    providerRefs,
    defaultReasoning: input.defaultReasoning ?? undefined,
    requestOverrides: input.requestOverrides ?? undefined,
    capabilityHints: input.capabilityHints ?? undefined,
    catalogProviderId: input.catalogProviderId ?? undefined,
    catalogModelId: input.catalogModelId ?? undefined,
  });
}

function normalizeModelMap(value: unknown): Record<string, ModelProfileRecord> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .map(([modelRef, record]) => [modelRef, normalizeModelProfileRecord(record)] as const)
    .filter(([, record]) => Boolean(record));

  return Object.fromEntries(entries.map(([modelRef, record]) => [modelRef, record as ModelProfileRecord]));
}

function normalizeBindingRecord(value: unknown): ExecutorBindingRecord | undefined {
  if (
    !isPlainObject(value) ||
    (value.executionMode !== "cli" && value.executionMode !== "api") ||
    typeof value.modelRef !== "string" ||
    !value.modelRef.trim()
  ) {
    return undefined;
  }

  const timeoutMs =
    typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
      ? Math.round(value.timeoutMs)
      : undefined;

  return {
    executionMode: value.executionMode,
    modelRef: value.modelRef.trim(),
    ...(typeof value.providerRef === "string" && value.providerRef.trim()
      ? { providerRef: value.providerRef.trim() }
      : {}),
    ...(typeof value.commandPath === "string" && value.commandPath.trim()
      ? { commandPath: value.commandPath.trim() }
      : {}),
    ...(value.sandboxMode === "read-only" ||
    value.sandboxMode === "workspace-write" ||
    value.sandboxMode === "danger-full-access"
      ? { sandboxMode: value.sandboxMode }
      : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function normalizeBindingMap(value: unknown): Record<string, ExecutorBindingRecord> {
  if (!isPlainObject(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .map(([adapterId, record]) => [adapterId, normalizeBindingRecord(record)] as const)
    .filter(([, record]) => Boolean(record));

  return Object.fromEntries(entries.map(([adapterId, record]) => [adapterId, record as ExecutorBindingRecord]));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function collectProviderReadinessIssues(
  provider: ProviderConfigRecord | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!provider) {
    return ["provider"];
  }

  const missing: string[] = [];

  if (provider.transport === "api") {
    if (!provider.baseUrl?.trim()) {
      missing.push("baseUrl");
    }

    if (!provider.auth || provider.auth.kind === "none") {
      missing.push("auth");
    } else {
      const authRefs = getProviderAuthSecretRefs(provider.auth);
      if (authRefs.length > 0) {
        const authReady = authRefs.every((ref) => getSecretStatus(ref, env).ready);
        if (!authReady) {
          missing.push("auth.secretRef");
        }
      }
    }
  }

  if (provider.transport === "cli") {
    if (!provider.cli?.commandPath?.trim()) {
      missing.push("commandPath");
    }
  }

  const headerRefs = collectSecretRefsFromHeaderRules(provider.headers);
  if (headerRefs.length > 0) {
    const headerReady = headerRefs.every((ref) => getSecretStatus(ref, env).ready);
    if (!headerReady) {
      missing.push("headers.secretRef");
    }
  }

  return uniqueStrings(missing);
}

export function getProviderReadiness(
  provider: ProviderConfigRecord | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReadinessSnapshot {
  const missing = collectProviderReadinessIssues(provider, env);
  return {
    ready: missing.length === 0,
    missing,
  };
}

export function getModelReadiness(
  config: ExecutorConfigFile,
  modelRef: string | undefined,
): ReadinessSnapshot {
  const missing = !modelRef?.trim() ? ["model"] : config.models[modelRef.trim()] ? [] : ["model"];
  return {
    ready: missing.length === 0,
    missing,
  };
}

export function getBindingReadiness(
  config: ExecutorConfigFile,
  adapterId: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadinessSnapshot {
  const binding = config.bindings[adapterId];
  if (!binding) {
    const legacy = config.executors[adapterId];
    const missing = legacy?.configuredModel?.trim() ? [] : ["configuredModel"];
    return {
      ready: missing.length === 0,
      missing,
    };
  }

  const missing: string[] = [];
  const model = config.models[binding.modelRef];

  if (!model) {
    missing.push("model");
  }

  const providerRef =
    binding.providerRef ||
    (binding.executionMode === "api" ? model?.providerRefs?.api : model?.providerRefs?.cli);

  if (!providerRef?.trim()) {
    missing.push("provider");
  }

  const provider = providerRef ? config.providers[providerRef] : undefined;
  missing.push(...collectProviderReadinessIssues(provider, env));

  return {
    ready: uniqueStrings(missing).length === 0,
    missing: uniqueStrings(missing),
  };
}

export function getExecutorReadiness(
  config: ExecutorConfigFile,
  adapterId: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadinessSnapshot {
  const envConfiguredModel = getExecutorCatalogEntry(adapterId)
    ? env[getExecutorCatalogEntry(adapterId)!.configKey]?.trim()
    : undefined;
  const resolved = resolveExecutorConfiguration(config, adapterId, envConfiguredModel);
  if (config.bindings[adapterId]) {
    return getBindingReadiness(config, adapterId, env);
  }

  const missing: string[] = [];

  if (!resolved.configuredModel?.trim()) {
    missing.push("configuredModel");
  }

  if (resolved.executionMode === "api") {
    if (!resolved.providerRef?.trim()) {
      missing.push("provider");
    }

    if (resolved.providerRef?.trim()) {
      const provider = config.providers[resolved.providerRef.trim()];
      missing.push(...collectProviderReadinessIssues(provider, env));
    }
  } else if (resolved.executionMode === "cli") {
    if (!resolved.commandPath?.trim()) {
      missing.push("commandPath");
    }
  }

  const uniqueMissing = uniqueStrings(missing);
  return {
    ready: uniqueMissing.length === 0,
    missing: uniqueMissing,
  };
}

function createMutableConfigSnapshot(current: ExecutorConfigFile): ExecutorConfigFile {
  return {
    executors: { ...current.executors },
    roleRouting: { ...current.roleRouting },
    roleMapping: current.roleMapping ? { ...current.roleMapping } : {},
    providers: { ...current.providers },
    models: { ...current.models },
    bindings: { ...current.bindings },
  };
}

type ProviderPresetCatalogItem = { id: string } & ProviderPresetRecord;

const PROVIDER_PRESET_CATALOG: ProviderPresetCatalogItem[] = [
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    vendor: "moonshot",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
    auth: { kind: "api_key", secretRef: "MOONSHOT_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  {
    id: "glm",
    label: "GLM (Zhipu)",
    vendor: "zhipu",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    auth: { kind: "api_key", secretRef: "ZHIPU_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  {
    id: "dashscope",
    label: "DashScope / Qwen",
    vendor: "alibaba",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    auth: { kind: "api_key", secretRef: "DASHSCOPE_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
  {
    id: "minimax-anthropic",
    label: "MiniMax (Anthropic Compatible)",
    vendor: "minimax",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    auth: { kind: "api_key", secretRef: "MINIMAX_API_KEY", headerName: "Authorization", prefix: "Bearer " },
  },
];

function getExecutorConfigPath() {
  return (
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH?.trim() ||
    join(process.cwd(), "config", "executors.json")
  );
}

function normalizeConfigFile(
  parsed: ExecutorConfigFile | LegacyExecutorConfigMap | null | undefined,
): ExecutorConfigFile {
  if (!parsed || typeof parsed !== "object") {
    return {
      executors: {},
      roleRouting: {},
      roleMapping: {},
      providers: {},
      models: {},
      bindings: {},
    };
  }

  if ("executors" in parsed || "roleRouting" in parsed || "roleMapping" in parsed || "providers" in parsed || "models" in parsed || "bindings" in parsed) {
    return {
      executors: "executors" in parsed ? normalizeExecutorMap(parsed.executors) : {},
      roleRouting: "roleRouting" in parsed ? normalizeRoleRoutingMap(parsed.roleRouting) : {},
      roleMapping: "roleMapping" in parsed ? normalizeRoleMappingMap(parsed.roleMapping) : {},
      providers: "providers" in parsed ? normalizeProviderMap(parsed.providers) : {},
      models: "models" in parsed ? normalizeModelMap(parsed.models) : {},
      bindings: "bindings" in parsed ? normalizeBindingMap(parsed.bindings) : {},
    };
  }

  return {
    executors: normalizeExecutorMap(parsed),
    roleRouting: {},
    roleMapping: {},
    providers: {},
    models: {},
    bindings: {},
  };
}

function mapProviderAuthToExecutorAuth(
  auth: ProviderAuthConfig | undefined,
): ExecutorConfigRecord["authMode"] | undefined {
  if (!auth) {
    return undefined;
  }

  if (auth.kind === "chatgpt_session") {
    return "chatgpt";
  }

  if (auth.kind === "api_key" || auth.kind === "oauth_token") {
    return "api_key";
  }

  return undefined;
}

function buildLegacyResolvedConfiguration(
  legacyRecord: ExecutorConfigRecord | undefined,
  envConfiguredModel: string | undefined,
): ResolvedExecutorConfiguration {
  const fileConfiguredModel = legacyRecord?.configuredModel?.trim();
  const configuredModel = fileConfiguredModel || envConfiguredModel;
  const configSource = legacyRecord
    ? "file"
    : envConfiguredModel
      ? "env"
      : "default";

  return {
    configSource,
    ...(legacyRecord?.authMode ? { authMode: legacyRecord.authMode } : {}),
    ...(legacyRecord?.commandPath ? { commandPath: legacyRecord.commandPath } : {}),
    ...(configuredModel ? { configuredModel } : {}),
    ...(legacyRecord?.sandboxMode ? { sandboxMode: legacyRecord.sandboxMode } : {}),
    ...(legacyRecord?.timeoutMs ? { timeoutMs: legacyRecord.timeoutMs } : {}),
  };
}

export async function listProviderPresetCatalog(): Promise<ProviderPresetCatalogItem[]> {
  return [...PROVIDER_PRESET_CATALOG];
}

export function resolveExecutorConfiguration(
  config: ExecutorConfigFile,
  adapterId: string,
  envConfiguredModel?: string,
): ResolvedExecutorConfiguration {
  const binding = config.bindings[adapterId];
  const model = binding ? config.models[binding.modelRef] : undefined;
  const providerRef =
    binding?.providerRef ||
    (binding?.executionMode === "api" ? model?.providerRefs?.api : model?.providerRefs?.cli);
  const provider = providerRef ? config.providers[providerRef] : undefined;

  if (binding) {
    const authMode = mapProviderAuthToExecutorAuth(provider?.auth);
    const commandPath = binding.commandPath || provider?.cli?.commandPath;
    const sandboxMode = binding.sandboxMode || provider?.cli?.sandboxMode;

    return {
      configSource: "file",
      executionMode: binding.executionMode,
      modelRef: binding.modelRef,
      ...(providerRef ? { providerRef } : {}),
      ...(model?.modelName ? { configuredModel: model.modelName } : {}),
      ...(authMode ? { authMode } : {}),
      ...(commandPath ? { commandPath } : {}),
      ...(sandboxMode ? { sandboxMode } : {}),
      ...(binding.timeoutMs ? { timeoutMs: binding.timeoutMs } : {}),
    };
  }

  return buildLegacyResolvedConfiguration(config.executors[adapterId], envConfiguredModel);
}

export async function readExecutorConfigFile(): Promise<ExecutorConfigFile> {
  const configPath = getExecutorConfigPath();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as ExecutorConfigFile | LegacyExecutorConfigMap;
    const normalized = normalizeConfigFile(parsed);

    // Validate top-level structure with Zod schema as safety net
    const zodResult = ExecutorConfigFileSchema.safeParse(normalized);
    if (!zodResult.success) {
      console.warn("[executor-config] Zod validation warnings:", zodResult.error.issues.map(i => i.message).join("; "));
    }

    return normalized;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        executors: {},
        roleRouting: {},
        roleMapping: {},
        providers: {},
        models: {},
        bindings: {},
      };
    }

    throw cause;
  }
}

let writeTmpCounter = 0;

export async function writeExecutorConfigFile(nextConfig: ExecutorConfigFile) {
  const configPath = getExecutorConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  // Atomic write (C4): serialize to a temp file then rename, so a crash
  // mid-write can never leave a truncated/corrupt config. The temp name is
  // unique per write (pid + counter) so two concurrent writers don't clobber
  // a shared temp file or race the rename. Same directory → rename is atomic.
  const tmpPath = `${configPath}.${process.pid}.${writeTmpCounter++}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(nextConfig, null, 2));
    await rename(tmpPath, configPath);
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leave an orphan temp file.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function listProviderConfigs(): Promise<Array<{ id: string; readiness: ReadinessSnapshot } & ProviderConfigRecord>> {
  const config = await readExecutorConfigFile();
  return Object.entries(config.providers).map(([id, record]) => ({
    id,
    ...record,
    readiness: getProviderReadiness(record),
  }));
}

export async function listModelProfiles(): Promise<Array<{ id: string } & ModelProfileRecord>> {
  const config = await readExecutorConfigFile();
  return Object.entries(config.models).map(([id, record]) => ({ id, ...record }));
}

export async function listExecutorBindings(): Promise<
  Array<{ adapterId: string; readiness: ReadinessSnapshot } & ExecutorBindingRecord>
> {
  const config = await readExecutorConfigFile();
  return Object.entries(config.bindings).map(([adapterId, record]) => ({
    adapterId,
    ...record,
    readiness: getBindingReadiness(config, adapterId),
  }));
}

export async function updateProviderConfig(
  providerRef: string,
  input: ProviderConfigInput,
) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const existingPresetId = current.providers[providerRef]?.presetId;
  const presetId =
    input.presetId === undefined
      ? existingPresetId
      : input.presetId?.trim()
        ? input.presetId.trim()
        : undefined;
  const normalized = normalizeProviderConfigRecord({
    ...(presetId ? { presetId } : {}),
    label: input.label ?? undefined,
    vendor: input.vendor ?? undefined,
    transport: input.transport,
    apiDialect: input.apiDialect,
    baseUrl: input.baseUrl ?? undefined,
    auth: input.auth,
    headers: input.headers ?? undefined,
    cli: input.cli
      ? {
          ...(input.cli.commandPath ? { commandPath: input.cli.commandPath } : {}),
          ...(input.cli.sandboxMode ? { sandboxMode: input.cli.sandboxMode } : {}),
        }
      : undefined,
    requestOverrides: input.requestOverrides ?? undefined,
    capabilities: input.capabilities ?? undefined,
    quirks: input.quirks ?? undefined,
  });

  if (normalized) {
    next.providers[providerRef] = normalized;
  } else {
    delete next.providers[providerRef];
  }

  await writeExecutorConfigFile(next);
}

export type ProviderReference =
  | { kind: "model"; modelId: string; field: "providerRefs.cli" | "providerRefs.api" }
  | { kind: "binding"; adapterId: string; field: "providerRef" }
  | { kind: "agent"; roleId: string; field: "providerId" | "fallbackProviderId" | "provider" };

/** Scan executors.json + agent_profiles for things pointing at this
 *  provider. Returns [] if nothing references it. Caller decides
 *  whether to refuse or cascade. */
export async function findProviderReferences(
  providerRef: string,
): Promise<ProviderReference[]> {
  const config = await readExecutorConfigFile();
  const refs: ProviderReference[] = [];

  for (const [modelId, model] of Object.entries(config.models)) {
    if (model.providerRefs?.cli === providerRef) {
      refs.push({ kind: "model", modelId, field: "providerRefs.cli" });
    }
    if (model.providerRefs?.api === providerRef) {
      refs.push({ kind: "model", modelId, field: "providerRefs.api" });
    }
  }

  for (const [adapterId, binding] of Object.entries(config.bindings)) {
    if (binding.providerRef === providerRef) {
      refs.push({ kind: "binding", adapterId, field: "providerRef" });
    }
  }

  const { createDb, agentProfiles } = await import("@magister/db");
  const db = createDb();
  const profiles = await db.select().from(agentProfiles);
  for (const p of profiles) {
    if (p.providerId === providerRef) {
      refs.push({ kind: "agent", roleId: p.roleId, field: "providerId" });
    }
    if (p.fallbackProviderId === providerRef) {
      refs.push({ kind: "agent", roleId: p.roleId, field: "fallbackProviderId" });
    }
    // Legacy `provider` column — resolution falls back to it when
    // providerId is null (agent-resolution-service.ts:159). Older
    // profiles in the wild can still carry only this field.
    if (p.provider === providerRef) {
      refs.push({ kind: "agent", roleId: p.roleId, field: "provider" });
    }
  }

  return refs;
}

function formatProviderReference(ref: ProviderReference): string {
  if (ref.kind === "model") return `model "${ref.modelId}" (${ref.field})`;
  if (ref.kind === "binding") return `binding "${ref.adapterId}" (${ref.field})`;
  return `agent "${ref.roleId}" (${ref.field})`;
}

export class ProviderInUseError extends Error {
  constructor(public readonly references: ProviderReference[]) {
    const list = references.map(formatProviderReference).join(", ");
    super(
      `Provider is referenced by ${references.length} item(s): ${list}. Update or delete those first.`,
    );
    this.name = "ProviderInUseError";
  }
}

export type ProviderDeleteCascade = {
  /** Bindings removed entirely (a binding without a provider is unusable). */
  bindingsRemoved: string[];
  /** Models that still have at least one providerRef after the matching
   *  field was cleared — only the field was nulled, the model row stayed. */
  modelsCleared: string[];
  /** Models removed because they had no other providerRef left after
   *  the matching field was cleared. */
  modelsRemoved: string[];
  /** Agent profiles whose `providerId` / `fallbackProviderId` / legacy
   *  `provider` columns were nulled. The agent rows themselves stay. */
  agentsCleared: Array<{ roleId: string; fields: Array<"providerId" | "fallbackProviderId" | "provider"> }>;
};

export async function deleteProviderConfig(
  providerRef: string,
  options: { cascade?: boolean } = {},
): Promise<{ cascade?: ProviderDeleteCascade } | void> {
  const current = await readExecutorConfigFile();
  if (!current.providers[providerRef]) {
    return; // idempotent — already gone
  }

  const refs = await findProviderReferences(providerRef);
  if (refs.length > 0 && !options.cascade) {
    throw new ProviderInUseError(refs);
  }

  const next = createMutableConfigSnapshot(current);
  delete next.providers[providerRef];

  const cascade: ProviderDeleteCascade = {
    bindingsRemoved: [],
    modelsCleared: [],
    modelsRemoved: [],
    agentsCleared: [],
  };

  if (options.cascade) {
    // Cascade order: clean executor-config refs first, then DB
    // refs. Doing it in this order keeps the file write atomic and
    // makes the DB step idempotent even if the file write later
    // fails (which would leave the DB still pointing at a config
    // that's been pruned — DB check on next agent resolution would
    // surface that anyway).

    for (const [adapterId, binding] of Object.entries(next.bindings)) {
      if (binding.providerRef === providerRef) {
        delete next.bindings[adapterId];
        cascade.bindingsRemoved.push(adapterId);
      }
    }

    for (const [modelId, model] of Object.entries(next.models)) {
      const refsBefore = { ...(model.providerRefs ?? {}) };
      const updatedRefs: { cli?: string; api?: string } = {};
      if (refsBefore.cli && refsBefore.cli !== providerRef) updatedRefs.cli = refsBefore.cli;
      if (refsBefore.api && refsBefore.api !== providerRef) updatedRefs.api = refsBefore.api;

      const matched =
        refsBefore.cli === providerRef || refsBefore.api === providerRef;
      if (!matched) continue;

      if (Object.keys(updatedRefs).length === 0) {
        delete next.models[modelId];
        cascade.modelsRemoved.push(modelId);
      } else {
        next.models[modelId] = { ...model, providerRefs: updatedRefs };
        cascade.modelsCleared.push(modelId);
      }
    }
  }

  await writeExecutorConfigFile(next);

  if (options.cascade) {
    const { createDb, agentProfiles } = await import("@magister/db");
    const { eq } = await import("@magister/db");
    const db = createDb();
    const profiles = await db.select().from(agentProfiles);
    for (const p of profiles) {
      const fieldsToClear: Array<"providerId" | "fallbackProviderId" | "provider"> = [];
      const patch: Partial<{ providerId: null; fallbackProviderId: null; provider: null }> = {};
      if (p.providerId === providerRef) {
        fieldsToClear.push("providerId");
        patch.providerId = null;
      }
      if (p.fallbackProviderId === providerRef) {
        fieldsToClear.push("fallbackProviderId");
        patch.fallbackProviderId = null;
      }
      if (p.provider === providerRef) {
        fieldsToClear.push("provider");
        patch.provider = null;
      }
      if (fieldsToClear.length > 0) {
        await db.update(agentProfiles).set(patch).where(eq(agentProfiles.roleId, p.roleId));
        cascade.agentsCleared.push({ roleId: p.roleId, fields: fieldsToClear });
      }
    }

    return { cascade };
  }
}

/** Symmetric to ProviderReference / findProviderReferences — what
 *  in the config or DB points at this model id. Used by
 *  `deleteModelConfig` to decide refuse-vs-cascade. */
export type ModelReference =
  | { kind: "binding"; adapterId: string; field: "modelRef" }
  | { kind: "agent"; roleId: string; field: "modelName" | "modelOverride" };

export async function findModelReferences(
  modelRef: string,
): Promise<ModelReference[]> {
  const config = await readExecutorConfigFile();
  const refs: ModelReference[] = [];

  for (const [adapterId, binding] of Object.entries(config.bindings)) {
    if (binding.modelRef === modelRef) {
      refs.push({ kind: "binding", adapterId, field: "modelRef" });
    }
  }

  const { createDb, agentProfiles } = await import("@magister/db");
  const db = createDb();
  const profiles = await db.select().from(agentProfiles);
  for (const p of profiles) {
    if (p.modelName === modelRef) {
      refs.push({ kind: "agent", roleId: p.roleId, field: "modelName" });
    }
    if (p.modelOverride === modelRef) {
      refs.push({ kind: "agent", roleId: p.roleId, field: "modelOverride" });
    }
  }

  return refs;
}

function formatModelReference(ref: ModelReference): string {
  if (ref.kind === "binding") return `binding "${ref.adapterId}" (${ref.field})`;
  return `agent "${ref.roleId}" (${ref.field})`;
}

export class ModelInUseError extends Error {
  constructor(public readonly references: ModelReference[]) {
    const list = references.map(formatModelReference).join(", ");
    super(
      `Model is referenced by ${references.length} item(s): ${list}. Update or delete those first, or pass cascade=true.`,
    );
    this.name = "ModelInUseError";
  }
}

export type ModelDeleteCascade = {
  /** Bindings removed entirely (a binding without a model is unusable). */
  bindingsRemoved: string[];
  /** Agents whose `modelName` and/or `modelOverride` columns were
   *  cleared. The agent rows themselves stay so the operator can
   *  pick a replacement model in Settings → Agents. */
  agentsCleared: Array<{ roleId: string; fields: Array<"modelName" | "modelOverride"> }>;
};

/** Symmetric to deleteProviderConfig. Models live in
 *  `executors.json:models` and are referenced from bindings + agent
 *  profile rows. Refusing-by-default protects against silent agent
 *  breakage; cascade clears references the way the operator
 *  expects from the Provider delete flow. */
export async function deleteModelConfig(
  modelRef: string,
  options: { cascade?: boolean } = {},
): Promise<{ cascade?: ModelDeleteCascade } | void> {
  const current = await readExecutorConfigFile();
  if (!current.models[modelRef]) {
    return; // idempotent — already gone
  }

  const refs = await findModelReferences(modelRef);
  if (refs.length > 0 && !options.cascade) {
    throw new ModelInUseError(refs);
  }

  const next = createMutableConfigSnapshot(current);
  delete next.models[modelRef];

  const cascade: ModelDeleteCascade = {
    bindingsRemoved: [],
    agentsCleared: [],
  };

  if (options.cascade) {
    for (const [adapterId, binding] of Object.entries(next.bindings)) {
      if (binding.modelRef === modelRef) {
        delete next.bindings[adapterId];
        cascade.bindingsRemoved.push(adapterId);
      }
    }
  }

  await writeExecutorConfigFile(next);

  if (options.cascade) {
    const { createDb, agentProfiles } = await import("@magister/db");
    const { eq } = await import("@magister/db");
    const db = createDb();
    const profiles = await db.select().from(agentProfiles);
    for (const p of profiles) {
      const fieldsToClear: Array<"modelName" | "modelOverride"> = [];
      const patch: Partial<{ modelName: null; modelOverride: null }> = {};
      if (p.modelName === modelRef) {
        fieldsToClear.push("modelName");
        patch.modelName = null;
      }
      if (p.modelOverride === modelRef) {
        fieldsToClear.push("modelOverride");
        patch.modelOverride = null;
      }
      if (fieldsToClear.length > 0) {
        await db.update(agentProfiles).set(patch).where(eq(agentProfiles.roleId, p.roleId));
        cascade.agentsCleared.push({ roleId: p.roleId, fields: fieldsToClear });
      }
    }

    return { cascade };
  }
}

export async function updateModelConfig(
  modelRef: string,
  input: ModelProfileInput,
) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const normalized = normalizeModelInput(input);

  if (normalized) {
    next.models[modelRef] = normalized;
  } else {
    delete next.models[modelRef];
  }

  await writeExecutorConfigFile(next);
}

/**
 * Add several models in a single read→write (bulk catalog add). Existing model
 * ids are left untouched and reported as `skipped`. One atomic write for the
 * whole batch (avoids N round-trips and N corruption windows).
 */
export async function addModelsBatch(
  records: Array<{ id: string; input: ModelProfileInput }>,
): Promise<{ added: string[]; skipped: string[]; failed: string[] }> {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = []; // couldn't normalize (bad/empty input) — surfaced, not silently dropped

  for (const { id, input } of records) {
    const modelRef = id.trim();
    if (!modelRef) { failed.push(id); continue; }
    if (next.models[modelRef]) {
      skipped.push(modelRef);
      continue;
    }
    const normalized = normalizeModelInput(input);
    if (!normalized) { failed.push(modelRef); continue; }
    next.models[modelRef] = normalized;
    added.push(modelRef);
  }

  if (added.length > 0) await writeExecutorConfigFile(next);
  return { added, skipped, failed };
}

export async function updateExecutorBinding(
  adapterId: string,
  input: ExecutorBindingInput,
) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const normalized = normalizeBindingRecord({
    executionMode: input.executionMode,
    modelRef: input.modelRef,
    ...(input.providerRef ? { providerRef: input.providerRef } : {}),
    ...(input.commandPath ? { commandPath: input.commandPath } : {}),
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (normalized) {
    next.bindings[adapterId] = normalized;
  } else {
    delete next.bindings[adapterId];
  }

  await writeExecutorConfigFile(next);
}

export async function updateExecutorConfig(
  adapterId: string,
  input: {
    authMode?: ExecutorConfigRecord["authMode"] | null;
    commandPath?: string | null;
    configuredModel?: string | null;
    sandboxMode?: ExecutorConfigRecord["sandboxMode"] | null;
    timeoutMs?: number | null;
  },
) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const trimmedCommandPath = input.commandPath?.trim();
  const trimmedModel = input.configuredModel?.trim();
  const nextRecord = normalizeExecutorConfigRecord({
    ...(input.authMode ? { authMode: input.authMode } : {}),
    ...(trimmedCommandPath ? { commandPath: trimmedCommandPath } : {}),
    ...(trimmedModel ? { configuredModel: trimmedModel } : {}),
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (Object.keys(nextRecord).length > 0) {
    next.executors[adapterId] = nextRecord;
  } else {
    delete next.executors[adapterId];
  }

  await writeExecutorConfigFile(next);
}

export async function updateRoleRouting(roleId: string, adapterId: string | null) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);

  if (adapterId?.trim()) {
    const trimmedAdapterId = adapterId.trim();
    if (!isExecutorAdapterId(trimmedAdapterId)) {
      delete next.roleRouting[roleId];
      await writeExecutorConfigFile(next);
      return;
    }
    const defaultRoute = getDefaultRoleRoutingForRole(roleId);
    next.roleRouting[roleId] = {
      adapterId: trimmedAdapterId,
      strategy:
        defaultRoute?.strategy ??
        (getExecutorCatalogEntry(trimmedAdapterId)?.executorType === "model"
          ? "model_only"
          : "agent_only"),
      ...(defaultRoute?.fallbackAdapterId ? { fallbackAdapterId: defaultRoute.fallbackAdapterId } : {}),
    };
  } else {
    delete next.roleRouting[roleId];
  }

  await writeExecutorConfigFile(next);
}

export async function updateRoleRoutingConfig(
  roleId: string,
  input: {
    adapterId: string | null;
    strategy?: RoleRoutingStrategy | null;
    fallbackAdapterId?: string | null;
  },
) {
  const current = await readExecutorConfigFile();
  const next = createMutableConfigSnapshot(current);
  const trimmedAdapterId = input.adapterId?.trim();

  if (!trimmedAdapterId || !isExecutorAdapterId(trimmedAdapterId)) {
    delete next.roleRouting[roleId];
    await writeExecutorConfigFile(next);
    return;
  }

  const defaultRoute = getDefaultRoleRoutingForRole(roleId);
  const strategy =
    input.strategy ??
    defaultRoute?.strategy ??
    (getExecutorCatalogEntry(trimmedAdapterId)?.executorType === "model"
      ? "model_only"
      : "agent_only");
  const trimmedFallbackAdapterId = input.fallbackAdapterId?.trim();
  const fallbackAdapterId =
    trimmedFallbackAdapterId && isExecutorAdapterId(trimmedFallbackAdapterId)
      ? trimmedFallbackAdapterId
      : defaultRoute?.fallbackAdapterId;

  next.roleRouting[roleId] = {
    adapterId: trimmedAdapterId,
    strategy,
    ...(fallbackAdapterId && strategy === "fallback_model"
      ? { fallbackAdapterId }
      : {}),
  };

  await writeExecutorConfigFile(next);
}
