/**
 * Phase 1 — S4. The agent-profile leader path and teammate-spawn path build a
 * ModelProfile from ResolvedAgentConfig; both historically dropped
 * capabilityHints, so a vision-capable model had its images stripped on the
 * most common path. agentConfigModelProfileFields() is the shared projection
 * that carries context/output/vision uniformly.
 * See docs/plans/2026-06-08-model-catalog-provider-ux.md §5.3.
 */
import { describe, expect, it } from "bun:test";

import { agentConfigModelProfileFields } from "./agent-resolution-service";

describe("agentConfigModelProfileFields (S4)", () => {
  it("carries capabilityHints (vision) alongside context/output", () => {
    const fields = agentConfigModelProfileFields({
      contextWindow: 200000,
      maxOutputTokens: 32768,
      capabilityHints: { vision: true },
    });
    expect(fields).toEqual({
      contextWindow: 200000,
      maxOutputTokens: 32768,
      capabilityHints: { vision: true },
    });
  });

  it("omits absent fields (no undefined keys)", () => {
    expect(agentConfigModelProfileFields({})).toEqual({});
    expect(agentConfigModelProfileFields({ capabilityHints: { vision: false } })).toEqual({
      capabilityHints: { vision: false },
    });
  });
});
