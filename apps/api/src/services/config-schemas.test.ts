/**
 * Phase 1 — C3 schema unification. `ModelProfileSchema` must carry the same
 * fields the hand-rolled `ModelProfileRecord` does (capabilityHints,
 * requestOverrides) plus the new catalog identity fields, so the two same-named
 * `ModelProfile` types don't drift and on-disk values survive a schema parse.
 * See docs/plans/2026-06-08-model-catalog-provider-ux.md §6.11.
 */
import { describe, expect, it } from "bun:test";

import { ModelProfileSchema } from "./config-schemas";

describe("ModelProfileSchema (C3)", () => {
  it("preserves capabilityHints, requestOverrides, and catalog identity fields", () => {
    const parsed = ModelProfileSchema.parse({
      modelName: "claude-sonnet-4-5",
      capabilityHints: { vision: true },
      requestOverrides: { temperature: 0.2 },
      catalogProviderId: "anthropic",
      catalogModelId: "claude-sonnet-4-5",
    });

    expect(parsed.capabilityHints).toEqual({ vision: true });
    expect(parsed.requestOverrides).toEqual({ temperature: 0.2 });
    expect(parsed.catalogProviderId).toBe("anthropic");
    expect(parsed.catalogModelId).toBe("claude-sonnet-4-5");
  });
});
