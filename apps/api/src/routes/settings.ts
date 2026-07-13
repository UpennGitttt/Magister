import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  listExecutorBindings,
  listModelProfiles,
  listProviderPresetCatalog,
  listProviderConfigs,
  readExecutorConfigFile,
  type ExecutorBindingInput,
  type ModelProfileInput,
  type ProviderAuthConfig,
  type ProviderConfigInput,
  type ProviderHeaderRule,
  type ReasoningPolicy,
  deleteProviderConfig,
  ProviderInUseError,
  deleteModelConfig,
  ModelInUseError,
  updateExecutorBinding,
  updateExecutorConfig,
  updateModelConfig,
  updateProviderConfig,
  updateRoleRoutingConfig,
  addModelsBatch,
} from "../services/executor-config-service";
import {
  catalogModelToProfileDefaults,
  catalogProviderIdFor,
  getCatalog,
  listChatModelsForProvider,
  searchCatalogModels,
} from "../services/model-catalog-service";
import { VENDOR_PRESETS } from "../services/config-schemas";
import {
  collectSecretRefsFromHeaderRules,
  getProviderAuthSecretRefs,
  getSecretStatus,
  getSecretValueForAuth,
  listSecretStatuses,
  readLocalSecretStoreFile,
  writeSecretValue,
} from "../services/local-secret-store-service";
import { getMagisterEnv } from "../lib/env";
import { getExecutorSlotList } from "../services/executor-slot-service";
import { getRoleRoutingList } from "../services/role-routing-service";
import {
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  upsertAgentProfile,
} from "../services/agent-profile-service";
import { getAgentStatuses, getRoleHeartbeatsSnapshot, STALE_THRESHOLD_MS } from "../services/agent-heartbeat-service";
import { discoverModels, type DiscoveredModel } from "../services/model-discovery-service";

const updateExecutorSchema = z.object({
  authMode: z.enum(["chatgpt", "api_key"]).nullable().optional(),
  commandPath: z.string().trim().nullable().optional(),
  configuredModel: z.string().trim().nullable().optional(),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
});

const providerAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chatgpt_session"),
  }),
  z.object({
    kind: z.literal("api_key"),
    secretRef: z.string().trim().min(1),
    headerName: z.string().trim().min(1).nullable().optional(),
    prefix: z.string().trim().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal("oauth_token"),
    secretRef: z.string().trim().min(1),
    headerName: z.string().trim().min(1).nullable().optional(),
    prefix: z.string().trim().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal("none"),
  }),
]);

const providerHeaderSchema = z.object({
  name: z.string().trim().min(1),
  value: z.string().trim().min(1).nullable().optional(),
  secretRef: z.string().trim().min(1).nullable().optional(),
  envRef: z.string().trim().min(1).nullable().optional(),
  whenDialect: z
    .array(
      z.enum([
        "openai_chat_completions",
        "openai_responses",
        "anthropic_messages",
        "gemini_generate_content",
        "cli_native",
      ]),
    )
    .nullable()
    .optional(),
  whenModelPattern: z.array(z.string().trim().min(1)).nullable().optional(),
});

const providerCliSchema = z.object({
  commandPath: z.string().trim().nullable().optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .nullable()
    .optional(),
});

const providerSchema = z.object({
  presetId: z.string().trim().min(1).nullable().optional(),
  label: z.string().trim().nullable().optional(),
  vendor: z.string().trim().nullable().optional(),
  transport: z.enum(["cli", "api"]),
  apiDialect: z.enum([
    "openai_chat_completions",
    "openai_responses",
    "anthropic_messages",
    "gemini_generate_content",
    "cli_native",
  ]),
  baseUrl: z.string().trim().nullable().optional(),
  auth: providerAuthSchema,
  headers: z.array(providerHeaderSchema).nullable().optional(),
  cli: providerCliSchema.nullable().optional(),
  requestOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  quirks: z.record(z.string(), z.unknown()).nullable().optional(),
});

const reasoningPolicySchema = z.object({
  mode: z.enum(["off", "auto", "on"]),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  budgetTokens: z.number().int().positive().nullable().optional(),
  visibility: z.enum(["hidden", "summary", "full"]).nullable().optional(),
});

const modelSchema = z.object({
  label: z.string().trim().nullable().optional(),
  vendor: z.string().trim().nullable().optional(),
  modelName: z.string().trim().min(1),
  fallbacks: z.array(z.string().trim().min(1)).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  providerRefs: z
    .object({
      cli: z.string().trim().nullable().optional(),
      api: z.string().trim().nullable().optional(),
    })
    .nullable()
    .optional(),
  defaultReasoning: reasoningPolicySchema.nullable().optional(),
  requestOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  capabilityHints: z.record(z.string(), z.unknown()).nullable().optional(),
});

const bindingSchema = z.object({
  executionMode: z.enum(["cli", "api"]),
  modelRef: z.string().trim().min(1),
  providerRef: z.string().trim().nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  commandPath: z.string().trim().nullable().optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .nullable()
    .optional(),
});

const updateRoleRoutingSchema = z.object({
  adapterId: z.string().trim().nullable(),
  strategy: z.enum(["agent_only", "prefer_agent", "fallback_model", "model_only"]).nullable().optional(),
  fallbackAdapterId: z.string().trim().nullable().optional(),
});

const agentProfileSchema = z.object({
  label: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  systemPromptOverride: z.string().trim().nullable().optional(),
  modelName: z.string().trim().nullable().optional(),
  modelOverride: z.string().trim().nullable().optional(),
  providerId: z.string().trim().nullable().optional(),
  reasoningMode: z.enum(["off", "auto", "on"]).nullable().optional(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  fallbackModelName: z.string().trim().nullable().optional(),
  fallbackProviderId: z.string().trim().nullable().optional(),
  status: z.string().trim().nullable().optional(),
  mcpConfig: z.string().trim().nullable().optional(),
  maxConcurrentTasks: z.number().int().positive().nullable().optional(),
  runtimeType: z.enum(["ucm", "codex", "opencode", "claude-code", "kiro"]).optional().nullable(),
  provider: z.string().trim().nullable().optional(),
  commandPath: z.string().trim().nullable().optional(),
  customEnv: z.string().trim().nullable().optional(),
  customArgs: z.string().trim().nullable().optional(),
  maxTurns: z.number().int().positive().nullable().optional(),
  toolProfile: z.enum(["full", "coding", "research", "minimal"]).nullable().optional(),
  allowedTools: z.array(z.string().min(1)).nullable().optional(),
  disallowedTools: z.array(z.string().min(1)).nullable().optional(),
});

function compactTrimmedString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function discoverUcmModelsFromConfig(
  providerId: string | null,
  modelName: string | null,
  config: Awaited<ReturnType<typeof readExecutorConfigFile>>,
): DiscoveredModel[] {
  if (!providerId && !modelName) {
    return [];
  }

  const items = new Map<string, DiscoveredModel>();
  for (const [modelRef, model] of Object.entries(config.models)) {
    const resolvedModelName = compactTrimmedString(model.modelName);
    if (!resolvedModelName) {
      continue;
    }

    const providerCandidates = new Set<string>();
    const apiProvider = compactTrimmedString(model.providerRefs?.api);
    const cliProvider = compactTrimmedString(model.providerRefs?.cli);
    if (apiProvider) {
      providerCandidates.add(apiProvider);
    }
    if (cliProvider) {
      providerCandidates.add(cliProvider);
    }

    for (const binding of Object.values(config.bindings)) {
      if (binding.modelRef !== modelRef) {
        continue;
      }
      const bindingProvider = compactTrimmedString(binding.providerRef);
      if (bindingProvider) {
        providerCandidates.add(bindingProvider);
      }
    }

    if (providerId && !providerCandidates.has(providerId)) {
      continue;
    }

    const provider =
      providerId ??
      apiProvider ??
      cliProvider ??
      [...providerCandidates][0] ??
      "unknown";

    items.set(resolvedModelName, {
      id: resolvedModelName,
      provider,
      label: compactTrimmedString(model.label) ?? resolvedModelName,
      ...(modelName && modelName === resolvedModelName ? { isDefault: true } : {}),
    });
  }

  return [...items.values()];
}

function applyModelDefault(
  items: DiscoveredModel[],
  providerId: string | null,
  modelName: string | null,
): DiscoveredModel[] {
  const providerScoped = providerId ? items.filter((item) => item.provider === providerId) : items;
  if (!modelName) {
    return providerScoped;
  }

  return providerScoped.map((item) => {
    if (item.id === modelName || item.label === modelName) {
      return { ...item, isDefault: true };
    }

    if (item.isDefault) {
      return { ...item, isDefault: false };
    }

    return item;
  });
}

/** Sentinel emitted by `redactProviderAuth` / `redactProviderHeaders`
 *  when a sensitive field is hidden from API responses. The PUT
 *  handler treats incoming fields equal to this string as "user
 *  unchanged" and substitutes them back from the unredacted record on
 *  disk — without that, an Edit-then-Save round-trip would write
 *  the literal "[redacted]" into config/executors.json, destroying
 *  the real secretRef name. */
const REDACTED_SENTINEL = "[redacted]";

function redactProviderAuth(
  auth: ProviderAuthConfig | null | undefined,
): ProviderAuthConfig | null | undefined {
  if (!auth) {
    return auth;
  }

  if (auth.kind === "api_key" || auth.kind === "oauth_token") {
    return {
      kind: auth.kind,
      secretRef: REDACTED_SENTINEL,
      ...(auth.headerName ? { headerName: auth.headerName } : {}),
      ...(auth.prefix ? { prefix: auth.prefix } : {}),
    };
  }

  return auth;
}

/** When the body's auth carries the redacted sentinel for secretRef
 *  (because the UI just echoed back the GET response untouched),
 *  substitute the real secretRef from the existing record. Same for
 *  headers (value / secretRef). Mutates `body` in place — we own the
 *  parsed copy. */
function unredactProviderBody(
  body: z.infer<typeof providerSchema>,
  existing: { auth?: ProviderAuthConfig | null; headers?: ProviderHeaderRule[] | null } | undefined,
): void {
  if (!existing) return;

  if (
    (body.auth.kind === "api_key" || body.auth.kind === "oauth_token")
    && body.auth.secretRef === REDACTED_SENTINEL
    && existing.auth
    && (existing.auth.kind === "api_key" || existing.auth.kind === "oauth_token")
  ) {
    body.auth.secretRef = existing.auth.secretRef;
  }

  if (body.headers && existing.headers) {
    const existingByName = new Map(existing.headers.map((h) => [h.name, h] as const));
    for (const h of body.headers) {
      const e = existingByName.get(h.name);
      if (!e) continue;
      if (h.value === REDACTED_SENTINEL && typeof e.value === "string") {
        h.value = e.value;
      }
      if (h.secretRef === REDACTED_SENTINEL && typeof e.secretRef === "string") {
        h.secretRef = e.secretRef;
      }
    }
  }
}

function redactProviderHeaders(headers: ProviderHeaderRule[] | undefined) {
  if (!headers?.length) {
    return headers;
  }

  return headers.map((header) => ({
    ...header,
    ...(header.value ? { value: "[redacted]" } : {}),
    ...(header.secretRef ? { secretRef: "[redacted]" } : {}),
  }));
}

function buildProviderReadiness(provider: {
  transport: string;
  baseUrl?: string | null;
  auth?: ProviderAuthConfig | null;
  cli?: { commandPath?: string | null } | null;
  headers?: ProviderHeaderRule[] | null;
}) {
  const missing: string[] = [];

  if (provider.transport === "api" && !compactTrimmedString(provider.baseUrl ?? undefined)) {
    missing.push("baseUrl");
  }

  if (
    provider.auth &&
    provider.auth.kind !== "none" &&
    !getProviderAuthSecretRefs(provider.auth).every((ref) => getSecretStatus(ref).ready)
  ) {
    missing.push("auth.secretRef");
  }

  const headerRefs = collectSecretRefsFromHeaderRules(provider.headers ?? undefined);
  if (headerRefs.length > 0 && !headerRefs.every((ref) => getSecretStatus(ref).ready)) {
    missing.push("headers.secretRef");
  }

  if (
    provider.transport === "cli" &&
    !compactTrimmedString(provider.cli?.commandPath ?? undefined)
  ) {
    missing.push("commandPath");
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

function buildModelReadiness(
  model: { modelName?: string | null; defaultReasoning?: ReasoningPolicy | null },
) {
  const missing: string[] = [];

  if (!compactTrimmedString(model.modelName ?? undefined)) {
    missing.push("modelName");
  }

  return {
    ready: missing.length === 0,
    missing,
    thinkingReady: Boolean(model.defaultReasoning?.mode ?? model.defaultReasoning?.effort),
  };
}

function buildBindingReadiness(
  binding: {
    executionMode?: string | null;
    providerRef?: string | null;
    modelRef?: string | null;
    commandPath?: string | null;
    sandboxMode?: string | null;
  },
  provider: {
    transport: string;
    baseUrl?: string | null;
    auth?: ProviderAuthConfig | null;
    cli?: { commandPath?: string | null } | null;
    headers?: ProviderHeaderRule[] | null;
  } | null,
  model: { modelName?: string | null } | null,
) {
  const missing: string[] = [];
  const executionMode = compactTrimmedString(binding.executionMode ?? undefined);

  if (!executionMode) {
    missing.push("executionMode");
  }

  if (!compactTrimmedString(binding.modelRef ?? undefined)) {
    missing.push("modelRef");
  }

  if (executionMode === "api") {
    if (!provider || !compactTrimmedString(provider.baseUrl ?? undefined)) {
      missing.push("baseUrl");
    }

    if (
      !provider ||
      (provider.auth &&
        provider.auth.kind !== "none" &&
        !getProviderAuthSecretRefs(provider.auth).every((ref) => getSecretStatus(ref).ready))
    ) {
      missing.push("auth.secretRef");
    }

    const headerRefs = collectSecretRefsFromHeaderRules(provider?.headers ?? undefined);
    if (headerRefs.length > 0 && !headerRefs.every((ref) => getSecretStatus(ref).ready)) {
      missing.push("headers.secretRef");
    }
  }

  if (executionMode === "cli") {
    if (
      !compactTrimmedString(binding.commandPath ?? undefined) &&
      !compactTrimmedString(provider?.cli?.commandPath ?? undefined)
    ) {
      missing.push("commandPath");
    }
  }

  if (!model || !compactTrimmedString(model.modelName ?? undefined)) {
    missing.push("modelName");
  }

  return {
    ready: missing.length === 0,
    missing,
  };
}

function toProviderAuth(input: z.infer<typeof providerAuthSchema>): ProviderAuthConfig {
  if (input.kind === "chatgpt_session" || input.kind === "none") {
    return { kind: input.kind };
  }

  const secretRef = input.secretRef.trim();
  const auth: ProviderAuthConfig =
    input.kind === "api_key"
      ? { kind: "api_key", secretRef }
      : { kind: "oauth_token", secretRef };

  const headerName = compactTrimmedString(input.headerName);
  if (headerName) {
    auth.headerName = headerName;
  }

  const prefix = compactTrimmedString(input.prefix);
  if (prefix) {
    auth.prefix = prefix;
  }

  return auth;
}

function toProviderHeaders(
  headers: z.infer<typeof providerHeaderSchema>[] | null | undefined,
): ProviderHeaderRule[] | undefined {
  if (!headers?.length) {
    return undefined;
  }

  return headers.map((header) => {
    const normalized: ProviderHeaderRule = {
      name: header.name.trim(),
    };

    const value = compactTrimmedString(header.value);
    if (value) {
      normalized.value = value;
    }

    const secretRef = compactTrimmedString(header.secretRef);
    if (secretRef) {
      normalized.secretRef = secretRef;
    }

    const envRef = compactTrimmedString(header.envRef);
    if (envRef) {
      normalized.envRef = envRef;
    }

    const whenDialect = header.whenDialect?.length ? header.whenDialect : undefined;
    if (whenDialect) {
      normalized.whenDialect = whenDialect;
    }

    const whenModelPattern = header.whenModelPattern?.map((pattern) => pattern.trim()).filter(Boolean);
    if (whenModelPattern?.length) {
      normalized.whenModelPattern = whenModelPattern;
    }

    return normalized;
  });
}

function toProviderCli(
  cli: z.infer<typeof providerCliSchema> | null | undefined,
): ProviderConfigInput["cli"] {
  if (!cli) {
    return undefined;
  }

  const commandPath = compactTrimmedString(cli.commandPath);
  const sandboxMode = cli.sandboxMode ?? undefined;

  if (!commandPath && !sandboxMode) {
    return undefined;
  }

  return {
    ...(commandPath ? { commandPath } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
  };
}

function toReasoningPolicy(
  input: z.infer<typeof reasoningPolicySchema> | null | undefined,
  existing?: ReasoningPolicy,
): ReasoningPolicy | undefined {
  // Tri-state semantics for each optional field:
  //   - undefined in body → preserve existing
  //   - null     in body → explicit clear
  //   - value    in body → set to that value
  //
  // Without this, a UI that doesn't expose every reasoning subkey
  // (e.g. ModelList exposes mode/effort/budget but not `visibility`)
  // would silently overwrite existing values with undefined and
  // drop fields the user never intended to touch. That's exactly
  // the regression that prompted this fix — saving any model from
  // the UI was wiping `visibility` because the form didn't have a
  // control for it.
  if (input === null) {
    return undefined;
  }
  if (!input) {
    return existing;
  }

  const policy: ReasoningPolicy = {
    mode: input.mode,
  };

  if (input.effort === undefined) {
    if (existing?.effort) policy.effort = existing.effort;
  } else if (input.effort !== null) {
    policy.effort = input.effort;
  }

  if (input.budgetTokens === undefined) {
    if (typeof existing?.budgetTokens === "number") policy.budgetTokens = existing.budgetTokens;
  } else if (typeof input.budgetTokens === "number") {
    policy.budgetTokens = input.budgetTokens;
  }

  if (input.visibility === undefined) {
    if (existing?.visibility) policy.visibility = existing.visibility;
  } else if (input.visibility !== null) {
    policy.visibility = input.visibility;
  }

  return policy;
}

function toModelProviderRefs(
  providerRefs: z.infer<typeof modelSchema.shape.providerRefs>,
): ModelProfileInput["providerRefs"] {
  if (!providerRefs) {
    return undefined;
  }

  const cli = compactTrimmedString(providerRefs.cli);
  const api = compactTrimmedString(providerRefs.api);

  if (!cli && !api) {
    return undefined;
  }

  return {
    ...(cli ? { cli } : {}),
    ...(api ? { api } : {}),
  };
}

function toBindingPayload(input: z.infer<typeof bindingSchema>): ExecutorBindingInput {
  const payload: ExecutorBindingInput = {
    executionMode: input.executionMode,
    modelRef: input.modelRef.trim(),
  };

  const providerRef = compactTrimmedString(input.providerRef);
  if (providerRef) {
    payload.providerRef = providerRef;
  }

  if (typeof input.timeoutMs === "number") {
    payload.timeoutMs = input.timeoutMs;
  }

  const commandPath = compactTrimmedString(input.commandPath);
  if (commandPath) {
    payload.commandPath = commandPath;
  }

  if (input.sandboxMode) {
    payload.sandboxMode = input.sandboxMode;
  }

  return payload;
}

function collectKnownSecretRefs(config: Awaited<ReturnType<typeof readExecutorConfigFile>>) {
  const providerRefs = Object.values(config.providers).flatMap((provider) => [
    ...getProviderAuthSecretRefs(provider.auth),
    ...collectSecretRefsFromHeaderRules(provider.headers),
  ]);
  const storeRefs = Object.keys(readLocalSecretStoreFile().secrets);

  return [...new Set([...providerRefs, ...storeRefs])];
}

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/settings/executors", async () => {
    const items = await getExecutorSlotList();
    return {
      ok: true,
      data: {
        items: items.map((item) => {
          return {
            ...item,
            readiness: item.readiness,
          };
        }),
      },
    };
  });

  app.get("/settings/providers", async () => {
    const items = await listProviderConfigs();
    return {
      ok: true,
      data: {
        items: items.map((item) => ({
          ...item,
          auth: redactProviderAuth(item.auth),
          headers: redactProviderHeaders(item.headers),
          readiness: buildProviderReadiness(item),
        })),
      },
    };
  });

  app.get("/settings/provider-presets", async () => {
    const items = await listProviderPresetCatalog();
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.get("/settings/vendor-presets", async () => {
    return { ok: true, data: VENDOR_PRESETS };
  });

  app.get("/settings/secrets", async () => {
    const config = await readExecutorConfigFile();
    const items = listSecretStatuses(collectKnownSecretRefs(config));
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.put("/settings/secrets/:secretRef", async (request) => {
    const params = z.object({ secretRef: z.string().trim().min(1) }).parse(request.params);
    const body = z.object({ value: z.string().min(1) }).parse(request.body);
    const result = writeSecretValue(params.secretRef, body.value);

    return {
      ok: true,
      data: result,
    };
  });

  // Reveal a provider's configured API key (personal-use tool — lets the
  // operator verify what's actually stored, e.g. catch a base-URL-pasted-as-key
  // mistake). Returns the real secretRef + value, not the redacted list form.
  app.get("/settings/providers/:providerId/secret", async (request, reply) => {
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const config = await readExecutorConfigFile();
    const provider = config.providers[params.providerId];
    if (!provider) {
      reply.status(404);
      return { ok: false, error: { code: "provider_not_found", message: `Provider "${params.providerId}" not found.` } };
    }
    const auth = provider.auth;
    const secretRef = auth && (auth.kind === "api_key" || auth.kind === "oauth_token") ? auth.secretRef : null;
    const realValue = getSecretValueForAuth(auth) ?? "";
    const revealAllowed = (getMagisterEnv("MAGISTER_ALLOW_SECRET_REVEAL") ?? "on").toLowerCase() !== "off";
    const value = revealAllowed ? realValue : "";
    return { ok: true, data: { secretRef: secretRef ?? null, value, configured: realValue.length > 0 } };
  });

  // Write a provider's API key by provider id — the server resolves the real
  // secretRef from config, so the client never needs it (it's redacted in list
  // responses). Avoids a key edit landing under the literal "[redacted]" ref.
  app.put("/settings/providers/:providerId/secret", async (request, reply) => {
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const body = z.object({ value: z.string().min(1) }).parse(request.body);
    const config = await readExecutorConfigFile();
    const provider = config.providers[params.providerId];
    if (!provider) {
      reply.status(404);
      return { ok: false, error: { code: "provider_not_found", message: `Provider "${params.providerId}" not found.` } };
    }
    const auth = provider.auth;
    let secretRef = auth && (auth.kind === "api_key" || auth.kind === "oauth_token") ? auth.secretRef : null;
    if (!secretRef) {
      // No ref yet (e.g. auth was "none") — derive a stable one from the id.
      secretRef = `${params.providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    }
    const result = writeSecretValue(secretRef, body.value);
    return { ok: true, data: result };
  });

  // Explicit create endpoint. The service-layer `updateProviderConfig`
  // is already upsert-shaped, but a distinct POST lets the UI validate
  // "id already exists" with a 409 and avoid silent overwrites.
  app.post("/settings/providers", async (request, reply) => {
    const body = providerSchema.extend({
      id: z.string().trim().min(1, "id is required"),
    }).parse(request.body);

    const existingProviders = await listProviderConfigs();
    if (existingProviders.some((item) => item.id === body.id)) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "already_exists",
          message: `Provider id "${body.id}" already exists. Pick a different id, or PUT to update.`,
        },
      };
    }

    const providerInput: ProviderConfigInput = {
      transport: body.transport,
      apiDialect: body.apiDialect,
      auth: toProviderAuth(body.auth),
    };

    if (body.presetId !== undefined) {
      providerInput.presetId = body.presetId;
    }
    const providerLabel = compactTrimmedString(body.label);
    if (providerLabel) providerInput.label = providerLabel;
    const providerVendor = compactTrimmedString(body.vendor);
    if (providerVendor) providerInput.vendor = providerVendor;
    const providerBaseUrl = compactTrimmedString(body.baseUrl);
    if (providerBaseUrl) providerInput.baseUrl = providerBaseUrl;
    const providerHeaders = body.headers !== undefined
      ? toProviderHeaders(body.headers)
      : undefined;
    if (providerHeaders) providerInput.headers = providerHeaders;
    const providerCli = body.cli !== undefined ? toProviderCli(body.cli) : undefined;
    if (providerCli) providerInput.cli = providerCli;
    if (body.requestOverrides) providerInput.requestOverrides = body.requestOverrides;
    if (body.capabilities) providerInput.capabilities = body.capabilities;
    if (body.quirks) providerInput.quirks = body.quirks;

    await updateProviderConfig(body.id, providerInput);

    const items = await listProviderConfigs();
    const created = items.find((item) => item.id === body.id);
    if (!created) {
      reply.status(500);
      return {
        ok: false,
        error: {
          code: "create_failed",
          message: `Provider "${body.id}" was not persisted. Check executors.json for write errors.`,
        },
      };
    }
    reply.status(201);
    return {
      ok: true,
      data: {
        ...created,
        auth: redactProviderAuth(created.auth),
        headers: redactProviderHeaders(created.headers),
      },
    };
  });

  app.put("/settings/providers/:providerId", async (request, reply) => {
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const body = providerSchema.parse(request.body);
    const existingProviders = await listProviderConfigs();
    const existing = existingProviders.find((item) => item.id === params.providerId);
    // Defensive un-redaction: GET emits "[redacted]" for sensitive
    // fields; an Edit-then-Save round-trip on the UI would otherwise
    // persist that literal back to disk and destroy the real secretRef.
    unredactProviderBody(body, existing);
    const providerInput: ProviderConfigInput = {
      transport: body.transport,
      apiDialect: body.apiDialect,
      auth: toProviderAuth(body.auth),
    };

    if (body.presetId !== undefined) {
      providerInput.presetId = body.presetId;
    } else if (existing?.presetId !== undefined) {
      providerInput.presetId = existing.presetId;
    }

    const providerLabel = compactTrimmedString(body.label);
    if (providerLabel) {
      providerInput.label = providerLabel;
    } else if (body.label === undefined && existing?.label) {
      providerInput.label = existing.label;
    }

    const providerVendor = compactTrimmedString(body.vendor);
    if (providerVendor) {
      providerInput.vendor = providerVendor;
    } else if (body.vendor === undefined && existing?.vendor) {
      providerInput.vendor = existing.vendor;
    }

    const providerBaseUrl = compactTrimmedString(body.baseUrl);
    if (providerBaseUrl) {
      providerInput.baseUrl = providerBaseUrl;
    } else if (body.baseUrl === undefined && existing?.baseUrl) {
      providerInput.baseUrl = existing.baseUrl;
    }

    const providerHeaders = body.headers === undefined
      ? existing?.headers ?? undefined
      : toProviderHeaders(body.headers);
    if (providerHeaders) {
      providerInput.headers = providerHeaders;
    }

    const providerCli = body.cli === undefined ? existing?.cli ?? undefined : toProviderCli(body.cli);
    if (providerCli) {
      providerInput.cli = providerCli;
    }

    const requestOverrides = body.requestOverrides === undefined
      ? existing?.requestOverrides
      : body.requestOverrides ?? undefined;
    if (requestOverrides) {
      providerInput.requestOverrides = requestOverrides;
    }

    const capabilities = body.capabilities === undefined
      ? existing?.capabilities
      : body.capabilities ?? undefined;
    if (capabilities) {
      providerInput.capabilities = capabilities;
    }

    const quirks = body.quirks === undefined
      ? existing?.quirks
      : body.quirks ?? undefined;
    if (quirks) {
      providerInput.quirks = quirks;
    }

    await updateProviderConfig(params.providerId, providerInput);

    const items = await listProviderConfigs();
    const updated = items.find((item) => item.id === params.providerId);

    if (!updated) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Provider not found: ${params.providerId}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        ...updated,
        auth: redactProviderAuth(updated.auth),
        headers: redactProviderHeaders(updated.headers),
      },
    };
  });

  app.delete("/settings/providers/:providerId", async (request, reply) => {
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        // Accept "1" / "true" from a query string. Defaults to false.
        cascade: z
          .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
          .optional(),
      })
      .parse(request.query);
    const cascade = query.cascade === "1" || query.cascade === "true";
    try {
      const result = await deleteProviderConfig(params.providerId, { cascade });
      return {
        ok: true,
        data: {
          providerId: params.providerId,
          ...(result && "cascade" in result ? { cascade: result.cascade } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ProviderInUseError) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "provider_in_use",
            message: err.message,
            references: err.references,
          },
        };
      }
      throw err;
    }
  });

  app.get("/settings/models", async () => {
    const items = await listModelProfiles();
    return {
      ok: true,
      data: {
        items: items.map((item) => ({
          ...item,
          readiness: buildModelReadiness(item),
        })),
      },
    };
  });

  // Catalog: the chat-capable models models.dev knows for this provider's
  // vendor/baseUrl, annotated with whether each is already added. Drives the
  // "Browse models" bulk-add picker (spec §5.8).
  app.get("/settings/providers/:providerId/catalog-models", async (request, reply) => {
    const params = z.object({ providerId: z.string().min(1) }).parse(request.params);
    const providers = await listProviderConfigs();
    const provider = providers.find((p) => p.id === params.providerId);
    if (!provider) {
      reply.status(404);
      return { ok: false, error: { code: "provider_not_found", message: `Provider "${params.providerId}" not found.` } };
    }
    const catalogProviderId = catalogProviderIdFor(provider.vendor ?? "", provider.baseUrl);
    const catalog = await getCatalog();
    const catalogProvider = catalogProviderId ? catalog[catalogProviderId] : undefined;
    if (!catalogProvider) {
      return {
        ok: true,
        data: { providerId: params.providerId, catalogProviderId: catalogProviderId ?? null, items: [] },
      };
    }
    const existing = await listModelProfiles();
    // A model counts as "added" if its catalog id is linked OR a model already
    // occupies that id (addModelsBatch keys by id) — otherwise a colliding
    // manual model would show addable forever yet always get skipped.
    const addedKeys = new Set<string>();
    for (const m of existing) {
      addedKeys.add(m.id);
      if (typeof m.catalogModelId === "string") addedKeys.add(m.catalogModelId);
    }
    const items = listChatModelsForProvider(catalogProvider).map((m) => {
      const defaults = catalogModelToProfileDefaults(m);
      return {
        catalogModelId: m.id,
        name: m.name,
        contextWindow: defaults.contextWindow,
        maxOutputTokens: defaults.maxOutputTokens,
        vision: defaults.capabilityHints?.vision === true,
        alreadyAdded: addedKeys.has(m.id),
      };
    });
    return { ok: true, data: { providerId: params.providerId, catalogProviderId, items } };
  });

  // Bulk-add catalog models to a provider. Each model is materialized with
  // concrete context/output/vision pulled from the catalog (spec §5.8).
  app.post("/settings/models/bulk", async (request, reply) => {
    // Two ways to specify what to add:
    //  - catalogModelIds: ids within THIS provider's vendor-mapped catalog (the
    //    "Browse models" grid path).
    //  - items: explicit {catalogProviderId, catalogModelId} pairs — used by the
    //    cross-catalog search so an aggregator provider (volcengine/openrouter)
    //    can pull a model filed under its origin vendor.
    const body = z.object({
      providerId: z.string().min(1),
      catalogModelIds: z.array(z.string().min(1)).optional(),
      items: z.array(z.object({
        catalogProviderId: z.string().min(1),
        catalogModelId: z.string().min(1),
      })).optional(),
    }).parse(request.body);

    const providers = await listProviderConfigs();
    const provider = providers.find((p) => p.id === body.providerId);
    if (!provider) {
      reply.status(404);
      return { ok: false, error: { code: "provider_not_found", message: `Provider "${body.providerId}" not found.` } };
    }
    const catalog = await getCatalog();

    // Resolve the (catalogProviderId, catalogModelId) pairs to materialize.
    let pairs: Array<{ catalogProviderId: string; catalogModelId: string }>;
    if (body.items && body.items.length > 0) {
      pairs = body.items;
    } else if (body.catalogModelIds && body.catalogModelIds.length > 0) {
      const catalogProviderId = catalogProviderIdFor(provider.vendor ?? "", provider.baseUrl);
      const catalogProvider = catalogProviderId ? catalog[catalogProviderId] : undefined;
      if (!catalogProvider) {
        reply.status(422);
        return {
          ok: false,
          error: {
            code: "no_catalog_mapping",
            message: `No models.dev catalog models for vendor "${provider.vendor ?? ""}"${catalogProviderId ? ` (mapped to "${catalogProviderId}")` : ""}. Try searching the catalog by model name.`,
          },
        };
      }
      pairs = body.catalogModelIds.map((catalogModelId) => ({ catalogProviderId: catalogProviderId!, catalogModelId }));
    } else {
      reply.status(400);
      return { ok: false, error: { code: "nothing_to_add", message: "Provide catalogModelIds or items." } };
    }

    const notFound: string[] = [];
    const records = pairs.flatMap(({ catalogProviderId, catalogModelId }) => {
      const model = catalog[catalogProviderId]?.models[catalogModelId];
      if (!model) { notFound.push(catalogModelId); return []; }
      const defaults = catalogModelToProfileDefaults(model);
      const input: ModelProfileInput = {
        modelName: catalogModelId,
        providerRefs: { api: body.providerId },
        catalogProviderId,
        catalogModelId,
        ...(defaults.label !== undefined ? { label: defaults.label } : {}),
        ...(defaults.contextWindow !== undefined ? { contextWindow: defaults.contextWindow } : {}),
        ...(defaults.maxOutputTokens !== undefined ? { maxOutputTokens: defaults.maxOutputTokens } : {}),
        ...(defaults.capabilityHints !== undefined ? { capabilityHints: defaults.capabilityHints } : {}),
      };
      return [{ id: catalogModelId, input }];
    });

    const result = await addModelsBatch(records);
    reply.status(201);
    return { ok: true, data: { ...result, failed: [...result.failed, ...notFound] } };
  });

  // Cross-catalog fuzzy model search (by id or name). Lets an aggregator
  // provider (no 1:1 vendor mapping) pull any model's metadata by name.
  app.get("/settings/catalog/search", async (request) => {
    const query = z.object({ q: z.string().optional() }).parse(request.query);
    await getCatalog();
    const items = (query.q ?? "").trim() ? searchCatalogModels(query.q!.trim()) : [];
    return { ok: true, data: { items } };
  });

  app.post("/settings/models", async (request, reply) => {
    const body = modelSchema.extend({
      id: z.string().trim().min(1, "id is required"),
    }).parse(request.body);

    const existingModels = await listModelProfiles();
    if (existingModels.some((item) => item.id === body.id)) {
      reply.status(409);
      return {
        ok: false,
        error: {
          code: "already_exists",
          message: `Model id "${body.id}" already exists. Pick a different id, or PUT to update.`,
        },
      };
    }

    const modelInput: ModelProfileInput = {
      modelName: body.modelName,
    };
    if (body.fallbacks?.length) {
      modelInput.fallbacks = body.fallbacks.map((f) => f.trim()).filter(Boolean);
    }
    const modelLabel = compactTrimmedString(body.label);
    if (modelLabel) modelInput.label = modelLabel;
    const modelVendor = compactTrimmedString(body.vendor);
    if (modelVendor) modelInput.vendor = modelVendor;
    if (typeof body.maxOutputTokens === "number") modelInput.maxOutputTokens = body.maxOutputTokens;
    if (typeof body.contextWindow === "number") modelInput.contextWindow = body.contextWindow;
    const refs = body.providerRefs ? toModelProviderRefs(body.providerRefs) : undefined;
    if (refs) modelInput.providerRefs = refs;
    if (body.defaultReasoning) {
      const reasoning = toReasoningPolicy(body.defaultReasoning, undefined);
      if (reasoning) modelInput.defaultReasoning = reasoning;
    }
    if (body.requestOverrides) modelInput.requestOverrides = body.requestOverrides;
    if (body.capabilityHints) modelInput.capabilityHints = body.capabilityHints;

    await updateModelConfig(body.id, modelInput);

    const items = await listModelProfiles();
    const created = items.find((item) => item.id === body.id);
    if (!created) {
      reply.status(500);
      return {
        ok: false,
        error: {
          code: "create_failed",
          message: `Model "${body.id}" was not persisted. Check executors.json for write errors.`,
        },
      };
    }
    reply.status(201);
    return {
      ok: true,
      data: created,
    };
  });

  app.delete("/settings/models/:modelId", async (request, reply) => {
    const params = z.object({ modelId: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        cascade: z
          .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
          .optional(),
      })
      .parse(request.query);
    const cascade = query.cascade === "1" || query.cascade === "true";
    try {
      const result = await deleteModelConfig(params.modelId, { cascade });
      return {
        ok: true,
        data: {
          modelId: params.modelId,
          ...(result && "cascade" in result ? { cascade: result.cascade } : {}),
        },
      };
    } catch (err) {
      if (err instanceof ModelInUseError) {
        reply.status(409);
        return {
          ok: false,
          error: {
            code: "model_in_use",
            message: err.message,
            references: err.references,
          },
        };
      }
      throw err;
    }
  });

  app.put("/settings/models/:modelId", async (request, reply) => {
    const params = z.object({ modelId: z.string().min(1) }).parse(request.params);
    const body = modelSchema.parse(request.body);
    const existingModels = await listModelProfiles();
    const existing = existingModels.find((item) => item.id === params.modelId);
    const modelInput: ModelProfileInput = {
      modelName: body.modelName,
    };

    const modelFallbacks = body.fallbacks === undefined
      ? existing?.fallbacks
      : body.fallbacks?.map((fallback) => fallback.trim()).filter(Boolean);
    if (modelFallbacks?.length) {
      modelInput.fallbacks = modelFallbacks;
    }

    const modelLabel = compactTrimmedString(body.label);
    if (modelLabel) {
      modelInput.label = modelLabel;
    } else if (body.label === undefined && existing?.label) {
      modelInput.label = existing.label;
    }

    const modelVendor = compactTrimmedString(body.vendor);
    if (modelVendor) {
      modelInput.vendor = modelVendor;
    } else if (body.vendor === undefined && existing?.vendor) {
      modelInput.vendor = existing.vendor;
    }

    if (typeof body.maxOutputTokens === "number") {
      modelInput.maxOutputTokens = body.maxOutputTokens;
    } else if (body.maxOutputTokens === undefined && typeof existing?.maxOutputTokens === "number") {
      modelInput.maxOutputTokens = existing.maxOutputTokens;
    }

    if (typeof body.contextWindow === "number") {
      modelInput.contextWindow = body.contextWindow;
    } else if (body.contextWindow === undefined && typeof existing?.contextWindow === "number") {
      modelInput.contextWindow = existing.contextWindow;
    }

    const modelProviderRefs = body.providerRefs === undefined
      ? existing?.providerRefs
      : toModelProviderRefs(body.providerRefs);
    if (modelProviderRefs) {
      modelInput.providerRefs = modelProviderRefs;
    }

    const defaultReasoning = body.defaultReasoning === undefined
      ? existing?.defaultReasoning
      : toReasoningPolicy(body.defaultReasoning, existing?.defaultReasoning);
    if (defaultReasoning) {
      modelInput.defaultReasoning = defaultReasoning;
    }

    const requestOverrides = body.requestOverrides === undefined
      ? existing?.requestOverrides
      : body.requestOverrides ?? undefined;
    if (requestOverrides) {
      modelInput.requestOverrides = requestOverrides;
    }

    const capabilityHints = body.capabilityHints === undefined
      ? existing?.capabilityHints
      : body.capabilityHints ?? undefined;
    if (capabilityHints) {
      modelInput.capabilityHints = capabilityHints;
    }

    // C2 — the form doesn't carry catalog identity; preserve it on update so a
    // Settings edit doesn't strip the link to models.dev (and the materialized
    // metadata's provenance / refresh path).
    if (existing?.catalogProviderId) modelInput.catalogProviderId = existing.catalogProviderId;
    if (existing?.catalogModelId) modelInput.catalogModelId = existing.catalogModelId;

    await updateModelConfig(params.modelId, modelInput);

    const items = await listModelProfiles();
    const updated = items.find((item) => item.id === params.modelId);

    if (!updated) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Model not found: ${params.modelId}`,
        },
      };
    }

    return {
      ok: true,
      data: updated,
    };
  });

  app.get("/settings/bindings", async () => {
    const [items, providers, models] = await Promise.all([
      listExecutorBindings(),
      listProviderConfigs(),
      listModelProfiles(),
    ]);
    const providerMap = new Map(providers.map((provider) => [provider.id, provider] as const));
    const modelMap = new Map(models.map((model) => [model.id, model] as const));
    return {
      ok: true,
      data: {
        items: items.map((item) => {
          const provider = item.providerRef ? providerMap.get(item.providerRef) ?? null : null;
          const model = item.modelRef ? modelMap.get(item.modelRef) ?? null : null;

          return {
            ...item,
            readiness: buildBindingReadiness(item, provider, model),
          };
        }),
      },
    };
  });

  app.put("/settings/bindings/:adapterId", async (request, reply) => {
    const params = z.object({ adapterId: z.string().min(1) }).parse(request.params);
    const body = bindingSchema.parse(request.body);
    await updateExecutorBinding(params.adapterId, toBindingPayload(body));

    const items = await listExecutorBindings();
    const updated = items.find((item) => item.adapterId === params.adapterId);

    if (!updated) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Binding not found: ${params.adapterId}`,
        },
      };
    }

    return {
      ok: true,
      data: updated,
    };
  });

  app.put("/settings/executors/:adapterId", async (request, reply) => {
    const params = z.object({ adapterId: z.string().min(1) }).parse(request.params);
    const body = updateExecutorSchema.parse(request.body);
    const slots = await getExecutorSlotList();
    const target = slots.find((slot) => slot.adapterId === params.adapterId);

    if (!target) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Executor slot not found: ${params.adapterId}`,
        },
      };
    }

    await updateExecutorConfig(params.adapterId, {
      authMode: body.authMode ?? null,
      commandPath: body.commandPath ?? null,
      configuredModel: body.configuredModel ?? null,
      sandboxMode: body.sandboxMode ?? null,
      timeoutMs: body.timeoutMs ?? null,
    });

    const refreshed = await getExecutorSlotList();
    const updated = refreshed.find((slot) => slot.adapterId === params.adapterId);

    return {
      ok: true,
      data: updated,
    };
  });

  app.get("/settings/agents", async () => {
    const items = await listAgentProfiles();
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.get("/settings/tools", async () => {
    const { listConfigurableLeaderTools } = await import("../services/manager-automation/autonomous-loop/manager-tools-adapter");
    const items = listConfigurableLeaderTools(process.cwd())
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
      }));

    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.get("/settings/agents/statuses", async () => {
    const statuses = await getAgentStatuses();
    return {
      ok: true,
      data: {
        items: statuses,
      },
    };
  });

  // Per-agent heartbeat snapshot. Merges in-memory (freshest) signals
  // from `recordRoleHeartbeat` with DB-persisted `lastHeartbeatAt`
  // from `agent_profiles`. Dashboard polls this every 5s and renders
  // the `LIVE · Xs` indicator with a 1s tick on the client side.
  app.get("/agents/heartbeats", async () => {
    const statuses = await getAgentStatuses();
    const memorySnapshot = getRoleHeartbeatsSnapshot();
    const now = Date.now();
    const items = statuses.map((profile) => {
      const inMemory = memorySnapshot.get(profile.roleId) ?? null;
      const lastSeenAt = Math.max(
        inMemory ?? 0,
        profile.lastHeartbeatAt ?? 0,
      ) || null;
      const secondsAgo = lastSeenAt !== null
        ? Math.max(0, Math.floor((now - lastSeenAt) / 1000))
        : null;
      const isLive = lastSeenAt !== null && (now - lastSeenAt) < STALE_THRESHOLD_MS;
      return {
        roleId: profile.roleId,
        label: profile.label,
        lastSeenAt,
        secondsAgo,
        isLive,
      };
    });
    return {
      ok: true,
      data: {
        items,
        now,
        staleThresholdMs: STALE_THRESHOLD_MS,
      },
    };
  });

  app.get("/settings/agents/:roleId/models", async (request, reply) => {
    const params = z.object({ roleId: z.string().trim().min(1) }).parse(request.params);
    const query = request.query as {
      runtimeType?: string;
      commandPath?: string;
      providerId?: string;
      refresh?: string;
    };
    const profile = await getAgentProfile(params.roleId);

    if (!profile) {
      // No saved profile — use query params only (for new agents or unsaved edits)
      if (!query.runtimeType) {
        reply.status(404);
        return {
          ok: false,
          error: { code: "not_found", message: `Agent profile not found: ${params.roleId}` },
        };
      }
    }

    // Query params override DB values (so unsaved draft changes work)
    const validRuntimes = ["ucm", "codex", "opencode", "claude-code", "kiro"] as const;
    const hasRuntimeOverride = validRuntimes.includes(query.runtimeType as any);
    const runtimeType = hasRuntimeOverride
      ? (query.runtimeType as typeof validRuntimes[number])
      : validRuntimes.includes(profile?.runtimeType as any)
        ? (profile!.runtimeType as typeof validRuntimes[number])
        : "ucm";
    // Bare command names so spawn resolves them via PATH — hard-coding
    // /usr/bin/<cli> was a Linux-only assumption that broke model
    // discovery on macOS/others (codex lives in /opt/homebrew/bin,
    // /usr/local/bin, nvm, …), silently falling back to the built-in
    // catalog. PATH resolution matches how cli-bridge probes versions.
    const defaultCommandPaths: Partial<Record<typeof validRuntimes[number], string>> = {
      codex: "codex",
      opencode: "opencode",
      "claude-code": "claude",
      kiro: "kiro-cli",
    };
    const commandPath =
      query.commandPath?.trim() ||
      (hasRuntimeOverride && runtimeType !== profile?.runtimeType
        ? (defaultCommandPaths[runtimeType] ?? null)
        : (profile?.commandPath?.trim() ?? null));
    // Query param overrides saved profile so the user can switch the
    // provider dropdown in the agent form and immediately see that
    // provider's model list. A present-but-empty providerId means the
    // user intentionally selected "default", so do not fall back to
    // the saved provider.
    const hasProviderOverride = Object.prototype.hasOwnProperty.call(query, "providerId");
    const providerOverride = query.providerId?.trim() ?? "";
    const providerId = hasProviderOverride
      ? (providerOverride || null)
      : (profile?.providerId?.trim() || profile?.provider?.trim() || null);
    const modelName = profile?.modelName?.trim() || profile?.modelOverride?.trim() || null;

    let discoveredModels: DiscoveredModel[] = [];
    let supported = true;

    if (runtimeType === "ucm") {
      discoveredModels = discoverUcmModelsFromConfig(providerId, modelName, await readExecutorConfigFile());
    } else {
      const discovered = await discoverModels(runtimeType, commandPath, {
        refresh: query.refresh === "1" || query.refresh === "true",
      });
      discoveredModels = discovered.models ?? discovered;
      supported = discovered.supported !== false;
    }

    // Only filter by providerId for Magister mode — CLI modes have their own provider grouping
    const filterProviderId = runtimeType === "ucm" ? providerId : null;
    const models = applyModelDefault(discoveredModels, filterProviderId, modelName);
    return {
      ok: true,
      data: { models, supported },
    };
  });

  app.put("/settings/agents/:roleId", async (request, reply) => {
    const params = z.object({ roleId: z.string().trim().min(1) }).parse(request.params);
    const body = agentProfileSchema.parse(request.body);

    try {
      // Only forward the per-agent tool fields when the request
      // explicitly includes them. The service layer's update path
      // distinguishes "key omitted" from "key set to null" via
      // hasOwnProperty (see agent-profile-service.ts:405-409).
      // Using `body.foo ?? null` here would coerce `undefined` to
      // `null` and the service would interpret that as "explicitly
      // clear it" — silently wiping a user's tool restrictions on
      // any partial PUT that didn't include them.
      const profilePatch: Parameters<typeof upsertAgentProfile>[0] = {
        roleId: params.roleId,
        label: body.label ?? null,
        description: body.description ?? null,
        systemPromptOverride: body.systemPromptOverride ?? null,
        modelName: body.modelName ?? null,
        modelOverride: body.modelOverride ?? null,
        providerId: body.providerId ?? null,
        reasoningMode: body.reasoningMode ?? null,
        reasoningEffort: body.reasoningEffort ?? null,
        contextWindow: body.contextWindow ?? null,
        maxOutputTokens: body.maxOutputTokens ?? null,
        fallbackModelName: body.fallbackModelName ?? null,
        fallbackProviderId: body.fallbackProviderId ?? null,
        status: body.status ?? null,
        mcpConfig: body.mcpConfig ?? null,
        maxConcurrentTasks: body.maxConcurrentTasks ?? null,
        runtimeType: body.runtimeType ?? null,
        provider: body.provider ?? null,
        commandPath: body.commandPath ?? null,
        customEnv: body.customEnv ?? null,
        customArgs: body.customArgs ?? null,
        maxTurns: body.maxTurns ?? null,
        toolProfile: body.toolProfile ?? null,
      };
      if ("allowedTools" in body) {
        profilePatch.allowedTools = body.allowedTools ?? null;
      }
      if ("disallowedTools" in body) {
        profilePatch.disallowedTools = body.disallowedTools ?? null;
      }
      const updated = await upsertAgentProfile(profilePatch);

      return {
        ok: true,
        data: updated,
      };
    } catch (error) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "invalid_agent_profile",
          message: error instanceof Error ? error.message : "Failed to upsert agent profile",
        },
      };
    }
  });

  app.delete("/settings/agents/:roleId", async (request, reply) => {
    const params = z.object({ roleId: z.string().trim().min(1) }).parse(request.params);
    const target = await getAgentProfile(params.roleId);

    if (!target) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Agent profile not found: ${params.roleId}`,
        },
      };
    }

    if ((target.isBuiltin ?? 0) === 1) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "builtin_agent_protected",
          message: `Cannot delete builtin agent profile: ${params.roleId}`,
        },
      };
    }

    const deleted = await deleteAgentProfile(params.roleId);
    if (!deleted) {
      reply.status(500);
      return {
        ok: false,
        error: {
          code: "delete_failed",
          message: `Failed to delete agent profile: ${params.roleId}`,
        },
      };
    }

    return {
      ok: true,
      data: {
        deleted: true,
      },
    };
  });

  app.get("/settings/role-routing", async () => {
    const items = await getRoleRoutingList();
    return {
      ok: true,
      data: {
        items,
      },
    };
  });

  app.put("/settings/role-routing/:roleId", async (request, reply) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(request.params);
    const body = updateRoleRoutingSchema.parse(request.body);

    const current = await getRoleRoutingList();
    const target = current.find((item) => item.roleId === params.roleId);
    if (!target) {
      reply.status(404);
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Role routing not found: ${params.roleId}`,
        },
      };
    }

    if (body.adapterId && !target.allowedAdapterIds.includes(body.adapterId)) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "invalid_adapter",
          message: `Adapter ${body.adapterId} is not allowed for role ${params.roleId}`,
        },
      };
    }

    if (
      body.fallbackAdapterId &&
      !target.allowedAdapterIds.includes(body.fallbackAdapterId)
    ) {
      reply.status(400);
      return {
        ok: false,
        error: {
          code: "invalid_fallback_adapter",
          message: `Fallback adapter ${body.fallbackAdapterId} is not allowed for role ${params.roleId}`,
        },
      };
    }

    await updateRoleRoutingConfig(params.roleId, {
      adapterId: body.adapterId,
      ...(body.strategy ? { strategy: body.strategy } : {}),
      ...(body.fallbackAdapterId ? { fallbackAdapterId: body.fallbackAdapterId } : {}),
    });
    const refreshed = await getRoleRoutingList();
    const updated = refreshed.find((item) => item.roleId === params.roleId);

    return {
      ok: true,
      data: updated,
    };
  });
}
