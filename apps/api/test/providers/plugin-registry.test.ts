import { test, expect } from "bun:test";

import { resolveProviderPlugin } from "../../src/providers/plugin-registry";

test("resolveProviderPlugin returns matching plugins for known dialects", () => {
  expect([
    resolveProviderPlugin("anthropic_messages")?.id,
    resolveProviderPlugin("openai_chat_completions")?.id,
  ]).toEqual(["anthropic", "openai-compat"]);
});

test("resolveProviderPlugin returns undefined for unknown dialect", () => {
  expect(resolveProviderPlugin("unknown_dialect")).toBeUndefined();
});
