/**
 * Phase 1 — C2/C4. Catalog identity fields must survive a model write→read
 * round-trip (so Settings edits don't strip them), and writes must be atomic.
 * See docs/plans/2026-06-08-model-catalog-provider-ux.md §5.4, §5.7.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addModelsBatch, readExecutorConfigFile, updateModelConfig, writeExecutorConfigFile } from "./executor-config-service";

const EMPTY = { executors: {}, roleRouting: {}, roleMapping: {}, providers: {}, models: {}, bindings: {} };

describe("model config round-trip (C2)", () => {
  const prev = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exec-config-"));
    const file = join(dir, "executors.json");
    writeFileSync(file, JSON.stringify(EMPTY));
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH = file;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
    else process.env.MAGISTER_EXECUTOR_CONFIG_PATH = prev;
  });

  it("preserves catalogProviderId/catalogModelId/capabilityHints through write→read", async () => {
    await updateModelConfig("test-model", {
      modelName: "claude-sonnet-4-5",
      providerRefs: { api: "anthropic" },
      capabilityHints: { vision: true },
      catalogProviderId: "anthropic",
      catalogModelId: "claude-sonnet-4-5",
    });

    const config = await readExecutorConfigFile();
    const record = config.models["test-model"];
    expect(record?.catalogProviderId).toBe("anthropic");
    expect(record?.catalogModelId).toBe("claude-sonnet-4-5");
    expect(record?.capabilityHints).toEqual({ vision: true });
  });

  it("addModelsBatch adds many in one write and skips existing ids", async () => {
    const first = await addModelsBatch([
      { id: "claude-sonnet-4-5", input: { modelName: "claude-sonnet-4-5", providerRefs: { api: "anthropic" } } },
      { id: "claude-opus-4-1", input: { modelName: "claude-opus-4-1", providerRefs: { api: "anthropic" } } },
    ]);
    expect(first.added.sort()).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);
    expect(first.skipped).toEqual([]);

    const config = await readExecutorConfigFile();
    expect(Object.keys(config.models).sort()).toEqual(["claude-opus-4-1", "claude-sonnet-4-5"]);

    const second = await addModelsBatch([
      { id: "claude-sonnet-4-5", input: { modelName: "claude-sonnet-4-5", providerRefs: { api: "anthropic" } } },
    ]);
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual(["claude-sonnet-4-5"]);
  });

  it("reports un-normalizable records as failed (not silently dropped)", async () => {
    const res = await addModelsBatch([
      { id: "good", input: { modelName: "good-model", providerRefs: { api: "anthropic" } } },
      { id: "bad", input: { modelName: "   " } }, // blank modelName → normalize fails
    ]);
    expect(res.added).toEqual(["good"]);
    expect(res.failed).toEqual(["bad"]);
    const config = await readExecutorConfigFile();
    expect(config.models.bad).toBeUndefined();
  });

  it("writes atomically — no .tmp file left behind (C4)", async () => {
    await writeExecutorConfigFile({ ...EMPTY, models: { a: { modelName: "x" } } });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    const config = await readExecutorConfigFile();
    expect(config.models.a?.modelName).toBe("x");
  });
});
