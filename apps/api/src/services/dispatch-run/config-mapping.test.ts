/**
 * Phase 2 — §5.9. The dispatch/CLI executor pipeline builds ApiModelConfig via
 * mapModels(); it historically dropped contextWindow/maxOutputTokens at this
 * boundary, so catalog/model limits never reached that transport.
 * See docs/plans/2026-06-08-model-catalog-provider-ux.md §5.9.
 */
import { describe, expect, it } from "bun:test";

import { mapModels } from "./config-mapping";
import type { ModelProfileRecord } from "../executor-config-service";

describe("mapModels (§5.9)", () => {
  it("carries contextWindow and maxOutputTokens through to ApiModelConfig", () => {
    const models: Record<string, ModelProfileRecord> = {
      "claude-sonnet-4-5": {
        modelName: "claude-sonnet-4-5",
        contextWindow: 200000,
        maxOutputTokens: 32768,
        capabilityHints: { vision: true },
      },
    };
    const mapped = mapModels(models)["claude-sonnet-4-5"]!;
    expect(mapped.contextWindow).toBe(200000);
    expect(mapped.maxOutputTokens).toBe(32768);
    expect(mapped.capabilityHints).toEqual({ vision: true });
  });

  it("omits the limit fields when the record has none", () => {
    const mapped = mapModels({ m: { modelName: "x" } }).m!;
    expect("contextWindow" in mapped).toBe(false);
    expect("maxOutputTokens" in mapped).toBe(false);
  });
});
