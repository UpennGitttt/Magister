import { expect, test } from "bun:test";
import { ReasoningPolicySchema, ModelProfileSchema, ProviderConfigSchema } from "../../src/services/config-schemas";

test("ReasoningPolicySchema validates correct input", () => {
  const result = ReasoningPolicySchema.safeParse({ mode: "auto", effort: "high", budgetTokens: 10000 });
  expect(result.success).toBe(true);
});

test("ReasoningPolicySchema rejects invalid mode", () => {
  const result = ReasoningPolicySchema.safeParse({ mode: "turbo" });
  expect(result.success).toBe(false);
});

test("ReasoningPolicySchema rejects negative budgetTokens", () => {
  const result = ReasoningPolicySchema.safeParse({ mode: "on", budgetTokens: -100 });
  expect(result.success).toBe(false);
});

test("ModelProfileSchema validates with reasoning", () => {
  const result = ModelProfileSchema.safeParse({
    modelName: "gpt-4o",
    maxOutputTokens: 16384,
    defaultReasoning: { mode: "auto", effort: "high" },
  });
  expect(result.success).toBe(true);
});

test("ProviderConfigSchema validates anthropic provider", () => {
  const result = ProviderConfigSchema.safeParse({
    transport: "api",
    apiDialect: "anthropic_messages",
    vendor: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { kind: "api_key", secretRef: "ANTHROPIC_API_KEY", headerName: "x-api-key" },
  });
  expect(result.success).toBe(true);
});
