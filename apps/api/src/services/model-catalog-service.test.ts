/**
 * Phase 1 — model catalog service (models.dev base layer).
 *
 * These tests cover the PURE pieces first (mapping + filtering); IO/snapshot
 * loading is exercised separately so the bulk of the logic stays fast and
 * deterministic. See docs/plans/2026-06-08-model-catalog-provider-ux.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetCatalogForTests,
  catalogModelToProfileDefaults,
  catalogProviderIdFor,
  getCatalog,
  getCatalogStatus,
  listChatModelsForProvider,
  lookupCatalogModel,
  searchCatalogModels,
  type CatalogModel,
  type CatalogProvider,
} from "./model-catalog-service";

function model(partial: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    name: partial.id,
    limit: { context: 200000, output: 8192 },
    ...partial,
  } as CatalogModel;
}

describe("catalogModelToProfileDefaults", () => {
  it("maps limit + modalities + name into a partial ModelProfileRecord", () => {
    const defaults = catalogModelToProfileDefaults(
      model({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (latest)",
        limit: { context: 200000, output: 8192 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      }),
    );

    expect(defaults.contextWindow).toBe(200000);
    expect(defaults.maxOutputTokens).toBe(8192);
    expect(defaults.label).toBe("Claude Sonnet 4.5 (latest)");
    expect(defaults.capabilityHints).toEqual({ vision: true });
  });

  it("omits capabilityHints when the model has no image input modality (no vision:false stamp)", () => {
    const defaults = catalogModelToProfileDefaults(
      model({ id: "deepseek-chat", modalities: { input: ["text"], output: ["text"] } }),
    );
    expect(defaults.capabilityHints).toBeUndefined();
  });

  it("keeps real output limits but clamps absurd ones (output==context data bugs)", () => {
    // Real model: passes through untouched.
    expect(catalogModelToProfileDefaults(
      model({ id: "claude", limit: { context: 200000, output: 64000 } }),
    ).maxOutputTokens).toBe(64000);
    // Aggregator bug (output duplicated from context): clamped to the ceiling.
    expect(catalogModelToProfileDefaults(
      model({ id: "agg", limit: { context: 1048576, output: 1048576 } }),
    ).maxOutputTokens).toBe(131072);
  });
});

describe("listChatModelsForProvider", () => {
  const provider: CatalogProvider = {
    id: "demo",
    name: "Demo",
    env: ["DEMO_API_KEY"],
    models: {
      chat: model({ id: "chat", modalities: { input: ["text"], output: ["text"] } }),
      "chat-audio-out": model({ id: "chat-audio-out", modalities: { input: ["text"], output: ["text", "audio"] } }),
      embed: model({ id: "embed", modalities: { input: ["text"], output: [] } }),
      zeroout: model({ id: "zeroout", limit: { context: 8000, output: 0 } }),
      deprecated: model({ id: "deprecated", status: "deprecated" }),
    },
  };

  it("keeps chat models, including text+audio output (issue #7), and drops embeddings/zero-output/deprecated", () => {
    const ids = listChatModelsForProvider(provider).map((m) => m.id).sort();
    expect(ids).toEqual(["chat", "chat-audio-out"]);
  });
});

describe("catalogProviderIdFor (baseUrl-sensitive vendor alias)", () => {
  it("routes China vs international endpoints to the right catalog id", () => {
    expect(catalogProviderIdFor("moonshot", "https://api.moonshot.cn/v1")).toBe("moonshotai-cn");
    expect(catalogProviderIdFor("moonshot", "https://api.moonshot.ai/v1")).toBe("moonshotai");
    expect(catalogProviderIdFor("alibaba", "https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("alibaba-cn");
    // International DashScope also contains "aliyuncs" but must NOT be treated as China.
    expect(catalogProviderIdFor("alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("alibaba");
  });

  it("maps the REAL VENDOR_PRESETS vendor strings (qwen, glm) the UI actually produces", () => {
    // config-schemas VENDOR_PRESETS use these — the Quick Setup dropdown stamps them.
    expect(catalogProviderIdFor("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe("alibaba-cn");
    expect(catalogProviderIdFor("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("alibaba");
    expect(catalogProviderIdFor("glm")).toBe("zhipuai");
  });

  it("maps simple vendors and returns undefined for unknown ones", () => {
    expect(catalogProviderIdFor("zhipu")).toBe("zhipuai");
    expect(catalogProviderIdFor("anthropic")).toBe("anthropic");
    expect(catalogProviderIdFor("openai")).toBe("openai");
    expect(catalogProviderIdFor("deepseek")).toBe("deepseek");
    expect(catalogProviderIdFor("some-custom-proxy")).toBeUndefined();
  });
});

describe("getCatalog / lookupCatalogModel (snapshot-backed)", () => {
  const prevPath = process.env.MAGISTER_MODELS_PATH;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "model-catalog-"));
    const fixture = {
      anthropic: {
        id: "anthropic",
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet-4-5": {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5 (latest)",
            limit: { context: 200000, output: 64000 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          // invalid: missing `limit` — must be skipped + counted, not crash the load
          broken: { id: "broken", name: "Broken" },
        },
      },
    };
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify(fixture));
    process.env.MAGISTER_MODELS_PATH = file;
    __resetCatalogForTests();
  });

  afterAll(() => {
    if (prevPath === undefined) delete process.env.MAGISTER_MODELS_PATH;
    else process.env.MAGISTER_MODELS_PATH = prevPath;
    __resetCatalogForTests();
  });

  it("loads providers from the configured path", async () => {
    const catalog = await getCatalog();
    expect(Object.keys(catalog)).toEqual(["anthropic"]);
    expect(getCatalogStatus().source).toBe("env");
    expect(getCatalogStatus().providerCount).toBe(1);
  });

  it("looks up a model by (providerId, modelId)", async () => {
    await getCatalog();
    const m = lookupCatalogModel("anthropic", "claude-sonnet-4-5");
    expect(m?.limit.context).toBe(200000);
  });

  it("skips invalid model entries and counts them, without dropping the provider", async () => {
    await getCatalog();
    expect(lookupCatalogModel("anthropic", "broken")).toBeUndefined();
    expect(lookupCatalogModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
    expect(getCatalogStatus().missCount).toBe(1);
  });
});

describe("searchCatalogModels (fuzzy, cross-provider)", () => {
  const prevPath = process.env.MAGISTER_MODELS_PATH;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "catalog-search-"));
    const mk = (id: string, name: string, vision = false) => ({
      id, name,
      limit: { context: 128000, output: 8192 },
      modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    });
    const fixture = {
      deepseek: { id: "deepseek", name: "DeepSeek", env: [], models: {
        "deepseek-v4-pro": mk("deepseek-v4-pro", "DeepSeek V4 Pro"),
        "deepseek-chat": mk("deepseek-chat", "DeepSeek Chat"),
      } },
      // same model id under a second provider — must dedup to one result
      "ollama-cloud": { id: "ollama-cloud", name: "Ollama Cloud", env: [], models: {
        "deepseek-v4-pro": mk("deepseek-v4-pro", "DeepSeek V4 Pro"),
      } },
      openai: { id: "openai", name: "OpenAI", env: [], models: {
        "gpt-5-pro": mk("gpt-5-pro", "GPT-5 Pro", true),
      } },
    };
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify(fixture));
    process.env.MAGISTER_MODELS_PATH = file;
    __resetCatalogForTests();
  });

  afterAll(() => {
    if (prevPath === undefined) delete process.env.MAGISTER_MODELS_PATH;
    else process.env.MAGISTER_MODELS_PATH = prevPath;
    __resetCatalogForTests();
  });

  it("matches despite missing/extra separators and case (deepseek-v4pro → deepseek-v4-pro)", async () => {
    await getCatalog();
    for (const q of ["deepseek-v4pro", "deepseekv4pro", "DeepSeek V4 Pro", "v4pro"]) {
      const ids = searchCatalogModels(q).map((m) => m.catalogModelId);
      expect(ids).toContain("deepseek-v4-pro");
    }
  });

  it("dedups the same model id seen under multiple providers", async () => {
    await getCatalog();
    const hits = searchCatalogModels("deepseek-v4-pro").filter((m) => m.catalogModelId === "deepseek-v4-pro");
    expect(hits.length).toBe(1);
  });

  it("returns mapped metadata (context/vision) on each hit", async () => {
    await getCatalog();
    const hit = searchCatalogModels("gpt-5-pro")[0];
    expect(hit?.contextWindow).toBe(128000);
    expect(hit?.vision).toBe(true);
    expect(hit?.catalogProviderId).toBe("openai");
  });

  it("returns nothing for a blank query", async () => {
    await getCatalog();
    expect(searchCatalogModels("   ")).toEqual([]);
  });
});

describe("committed snapshot integration", () => {
  const prevPath = process.env.MAGISTER_MODELS_PATH;

  beforeAll(() => {
    // Force the snapshot branch (no env override) so we exercise the real file.
    delete process.env.MAGISTER_MODELS_PATH;
    __resetCatalogForTests();
  });

  afterAll(() => {
    if (prevPath !== undefined) process.env.MAGISTER_MODELS_PATH = prevPath;
    __resetCatalogForTests();
  });

  it("loads the git-tracked models-snapshot.json with sane content", async () => {
    const catalog = await getCatalog();
    expect(getCatalogStatus().source).toBe("snapshot");
    expect(Object.keys(catalog).length).toBeGreaterThan(50);
    // anthropic is a stable, long-lived provider in models.dev
    expect(catalog.anthropic?.env).toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(catalog.anthropic?.models ?? {}).length).toBeGreaterThan(0);
  });
});
