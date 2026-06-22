/**
 * Model catalog service — models.dev as a base metadata layer.
 *
 * Phase 1 ships the PURE mapping/filtering helpers plus snapshot-backed
 * loading (no runtime network fetch). User config remains the override layer;
 * see docs/plans/2026-06-08-model-catalog-provider-ux.md.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelProfileRecord } from "./executor-config-service";

/** Generous ceiling for catalog-derived maxOutputTokens. High enough to preserve
 *  every real chat model (Claude 64k, GPT 128k), low enough to catch catalog
 *  data bugs where output == context (e.g. an aggregator listing 1,048,576). The
 *  streaming caller's maxOutputTokensRecovery still handles provider 400s. */
export const MAX_OUTPUT_TOKENS_CAP = 131072;

/** Where the committed, git-tracked snapshot lives (spec §5.7 / C6). */
const SNAPSHOT_PATH = join(process.cwd(), "config", "model-catalog", "models-snapshot.json");

export type CatalogSource = "env" | "cache" | "network" | "snapshot" | "none";

export type CatalogStatus = {
  source: CatalogSource;
  updatedAt: number | null;
  providerCount: number;
  /** Count of catalog model entries dropped during validation. */
  missCount: number;
};

export type CatalogModelModalities = {
  input: string[];
  output: string[];
};

export type CatalogModel = {
  id: string;
  name: string;
  limit: { context: number; output: number; input?: number };
  modalities?: CatalogModelModalities;
  reasoning?: boolean;
  tool_call?: boolean;
  status?: "alpha" | "beta" | "deprecated";
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
};

export type CatalogProvider = {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  api?: string;
  models: Record<string, CatalogModel>;
};

/**
 * Map a catalog model into the subset of ModelProfileRecord fields we trust
 * from the catalog. User-specified fields win at merge time (caller's job).
 */
export function catalogModelToProfileDefaults(model: CatalogModel): Partial<ModelProfileRecord> {
  const vision = model.modalities?.input?.includes("image") === true;
  return {
    label: model.name,
    contextWindow: model.limit.context,
    // Catalog output limit, clamped to a generous ceiling so real models pass
    // untouched but absurd values (output == context data bugs) don't leak.
    maxOutputTokens: Math.min(model.limit.output, MAX_OUTPUT_TOKENS_CAP),
    // Only stamp vision when true. Stamping { vision: false } would let a stale
    // catalog override a correct value and cause images to be silently stripped.
    ...(vision ? { capabilityHints: { vision: true } } : {}),
  };
}

/**
 * The chat-capable models a provider exposes, suitable for the bulk-add picker.
 * Filters out embeddings / zero-output / non-text-output / deprecated|alpha.
 */
export function listChatModelsForProvider(
  provider: CatalogProvider,
): Array<{ id: string } & CatalogModel> {
  return Object.values(provider.models).filter((model) => {
    if (model.limit.output <= 0) return false;
    if (model.status === "deprecated" || model.status === "alpha") return false;
    // Require text output when modalities are declared; treat absent modalities
    // as a plain chat model (text in/out).
    if (model.modalities && !model.modalities.output.includes("text")) return false;
    return true;
  });
}

/**
 * Resolve a Magister provider (vendor + baseUrl) to a models.dev catalog id.
 * baseUrl-sensitive because catalog ids split China vs international endpoints
 * (spec §5.6). Returns undefined for vendors we don't map → catalog is a no-op.
 */
export function catalogProviderIdFor(vendor: string, baseUrl?: string): string | undefined {
  const u = (baseUrl ?? "").toLowerCase();
  // Explicit `.cn` host signals a China endpoint for any vendor.
  const isCnHost = /\.cn(?:[/:]|$)/.test(u);
  switch (vendor) {
    case "moonshot": return isCnHost ? "moonshotai-cn" : "moonshotai";
    case "zhipu":
    case "glm": return "zhipuai"; // config-schemas VENDOR_PRESETS uses "glm"; onboarding uses "zhipu"
    case "alibaba":
    case "qwen": {
      // DashScope's host is `*.aliyuncs.com` (CN) vs `dashscope-intl.aliyuncs.com`
      // (international). Only Alibaba/Qwen use this signal.
      const cn = isCnHost || (u.includes("aliyuncs") && !u.includes("intl"));
      return cn ? "alibaba-cn" : "alibaba"; // VENDOR_PRESETS uses "qwen" (DashScope)
    }
    case "minimax": return isCnHost ? "minimax-cn" : "minimax";
    case "deepseek": return "deepseek";
    case "openai": return "openai";
    case "anthropic": return "anthropic";
    default: return undefined;
  }
}

// ─── snapshot loading ────────────────────────────────────────────────────────

type CatalogState = {
  catalog: Record<string, CatalogProvider>;
  status: CatalogStatus;
};

let memo: Promise<CatalogState> | null = null;

function isValidModel(value: unknown): value is CatalogModel {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.name !== "string") return false;
  const limit = m.limit as Record<string, unknown> | undefined;
  if (!limit || typeof limit.context !== "number" || typeof limit.output !== "number") return false;
  return true;
}

/** Parse a raw models.dev document, dropping (and counting) invalid models. */
function parseCatalog(raw: unknown): { catalog: Record<string, CatalogProvider>; missCount: number } {
  const catalog: Record<string, CatalogProvider> = {};
  let missCount = 0;
  if (typeof raw !== "object" || raw === null) return { catalog, missCount };

  for (const [providerId, providerRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerRaw !== "object" || providerRaw === null) continue;
    const p = providerRaw as Record<string, unknown>;
    const modelsRaw = (p.models as Record<string, unknown>) ?? {};
    const models: Record<string, CatalogModel> = {};
    for (const [modelId, modelRaw] of Object.entries(modelsRaw)) {
      if (isValidModel(modelRaw)) models[modelId] = modelRaw;
      else missCount++;
    }
    catalog[providerId] = {
      id: typeof p.id === "string" ? p.id : providerId,
      name: typeof p.name === "string" ? p.name : providerId,
      env: Array.isArray(p.env) ? (p.env as string[]) : [],
      ...(typeof p.npm === "string" ? { npm: p.npm } : {}),
      ...(typeof p.api === "string" ? { api: p.api } : {}),
      models,
    };
  }
  return { catalog, missCount };
}

const EMPTY_STATE: CatalogState = {
  catalog: {},
  status: { source: "none", updatedAt: null, providerCount: 0, missCount: 0 },
};

async function loadCatalog(): Promise<CatalogState> {
  // Phase 1: snapshot-only. Source order: explicit env override → committed
  // snapshot. (Last-known-good cache + network land in Phase 3.)
  const candidates: Array<{ path: string; source: CatalogSource }> = [];
  const override = process.env.MAGISTER_MODELS_PATH?.trim();
  if (override) candidates.push({ path: override, source: "env" });
  candidates.push({ path: SNAPSHOT_PATH, source: "snapshot" });

  for (const { path, source } of candidates) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue; // missing file → try next candidate
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue; // corrupt JSON → never poison startup; try next
    }
    const { catalog, missCount } = parseCatalog(raw);
    return {
      catalog,
      status: { source, updatedAt: null, providerCount: Object.keys(catalog).length, missCount },
    };
  }
  return EMPTY_STATE;
}

// `lookupCatalogModel` and `getCatalogStatus` are sync, so we cache the
// resolved state once the async load settles.
let resolvedState: CatalogState | null = null;
let lastStatus: CatalogStatus = EMPTY_STATE.status;

export async function getCatalog(): Promise<Record<string, CatalogProvider>> {
  if (!memo) {
    memo = loadCatalog().then((s) => {
      resolvedState = s;
      lastStatus = s.status;
      return s;
    });
  }
  return (await memo).catalog;
}

export function getCatalogStatus(): CatalogStatus {
  return lastStatus;
}

export function lookupCatalogModel(
  catalogProviderId: string,
  catalogModelId: string,
): CatalogModel | undefined {
  return resolvedState?.catalog[catalogProviderId]?.models[catalogModelId];
}

export type CatalogSearchHit = {
  catalogProviderId: string;
  catalogModelId: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision: boolean;
};

/** Drop everything that isn't a letter or digit, lowercase — so "deepseek-v4pro"
 *  and "DeepSeek V4 Pro" both normalize to "deepseekv4pro". */
function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Fuzzy search the WHOLE catalog by model id or name, ignoring separators/case.
 * Cross-provider (so aggregator endpoints like volcengine/openrouter can pull a
 * model's metadata even though the catalog files it under its origin vendor).
 * Deduped by model id, ranked exact → id-substring → name-substring.
 */
export function searchCatalogModels(query: string, limit = 30): CatalogSearchHit[] {
  const q = normalizeForSearch(query);
  if (!q || !resolvedState) return [];
  const seen = new Set<string>();
  const scored: Array<{ hit: CatalogSearchHit; rank: number }> = [];
  for (const provider of Object.values(resolvedState.catalog)) {
    for (const model of listChatModelsForProvider(provider)) {
      const nid = normalizeForSearch(model.id);
      const nname = normalizeForSearch(model.name);
      let rank: number;
      if (nid === q) rank = 0;
      else if (nid.includes(q)) rank = 1;
      else if (nname.includes(q)) rank = 2;
      else continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const d = catalogModelToProfileDefaults(model);
      scored.push({
        rank,
        hit: {
          catalogProviderId: provider.id,
          catalogModelId: model.id,
          name: model.name,
          ...(d.contextWindow !== undefined ? { contextWindow: d.contextWindow } : {}),
          ...(d.maxOutputTokens !== undefined ? { maxOutputTokens: d.maxOutputTokens } : {}),
          vision: d.capabilityHints?.vision === true,
        },
      });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.hit.catalogModelId.localeCompare(b.hit.catalogModelId));
  return scored.slice(0, limit).map((s) => s.hit);
}

export function __resetCatalogForTests(): void {
  memo = null;
  resolvedState = null;
  lastStatus = EMPTY_STATE.status;
}
