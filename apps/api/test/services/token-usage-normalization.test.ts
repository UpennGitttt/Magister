import { describe, expect, test } from "bun:test";

import {
  mergeAnthropicTokenUsage,
  normalizeAnthropicUsage,
  normalizeCodexCliUsage,
  normalizeGeminiUsage,
  normalizeOpenAIChatUsage,
  normalizeOpencodeCliTokens,
} from "../../src/services/token-usage-normalization";

describe("token usage normalization", () => {
  test("OpenAI Chat keeps prompt/completion totals inclusive and derives cache/reasoning breakdown", () => {
    const usage = normalizeOpenAIChatUsage({
      prompt_tokens: 1_000,
      completion_tokens: 300,
      total_tokens: 1_300,
      prompt_tokens_details: { cached_tokens: 250 },
      completion_tokens_details: { reasoning_tokens: 120 },
    });

    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 300,
      nonCachedInputTokens: 750,
      cacheReadTokens: 250,
      reasoningTokens: 120,
      totalTokens: 1_300,
      source: "provider",
      rawUsage: expect.any(Object),
    });
  });

  test("Anthropic usage sums non-cached input and cache fields into inclusive input", () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 10,
      output_tokens: 8,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    });

    expect(usage).toMatchObject({
      inputTokens: 160,
      outputTokens: 8,
      nonCachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 168,
      source: "provider",
    });
    expect(usage?.reasoningTokens).toBeUndefined();
  });

  test("Anthropic stream merge recomputes inclusive input from merged breakdown", () => {
    const start = normalizeAnthropicUsage({
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    });
    const delta = normalizeAnthropicUsage({ output_tokens: 25 });

    const merged = mergeAnthropicTokenUsage(start, delta);

    expect(merged).toMatchObject({
      inputTokens: 160,
      outputTokens: 25,
      nonCachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 185,
    });
  });

  test("Anthropic stream merge preserves the full message_start raw usage", () => {
    const startRaw = {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    };
    const start = normalizeAnthropicUsage(startRaw);
    const delta = normalizeAnthropicUsage({ output_tokens: 25 });

    const merged = mergeAnthropicTokenUsage(start, delta);

    expect(merged?.rawUsage).toEqual(startRaw);
  });

  test("Gemini adds thoughts tokens to visible candidate output", () => {
    const usage = normalizeGeminiUsage({
      promptTokenCount: 500,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 60,
      totalTokenCount: 600,
    });

    expect(usage).toMatchObject({
      inputTokens: 500,
      outputTokens: 100,
      nonCachedInputTokens: 300,
      cacheReadTokens: 200,
      reasoningTokens: 60,
      totalTokens: 600,
    });
  });

  test("Gemini does not fabricate output from thoughts when candidates are absent", () => {
    const usage = normalizeGeminiUsage({
      promptTokenCount: 500,
      thoughtsTokenCount: 60,
      totalTokenCount: 560,
    });

    expect(usage).toMatchObject({
      inputTokens: 500,
      outputTokens: 0,
      nonCachedInputTokens: 500,
      totalTokens: 560,
    });
    expect(usage?.reasoningTokens).toBeUndefined();
  });

  test("Gemini thoughts-only usage is ignored", () => {
    expect(normalizeGeminiUsage({ thoughtsTokenCount: 60 })).toBeUndefined();
  });

  test("CLI usage mappers expose inclusive totals and separate breakdown", () => {
    expect(normalizeCodexCliUsage({
      input_tokens: 1_000,
      cached_input_tokens: 250,
      output_tokens: 40,
      reasoning_output_tokens: 60,
    })).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
      nonCachedInputTokens: 750,
      cacheReadTokens: 250,
      reasoningTokens: 60,
      totalTokens: 1_100,
    });

    expect(normalizeOpencodeCliTokens({
      input: 10,
      output: 20,
      reasoning: 30,
      total: 165,
      cache: { read: 100, write: 5 },
    })).toMatchObject({
      inputTokens: 115,
      outputTokens: 50,
      nonCachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      reasoningTokens: 30,
      totalTokens: 165,
    });
  });

  test("derived breakdown clamps provider-inconsistent values instead of going negative", () => {
    const usage = normalizeOpenAIChatUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 150 },
      completion_tokens_details: { reasoning_tokens: 30 },
    });

    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      nonCachedInputTokens: 0,
      cacheReadTokens: 150,
      reasoningTokens: 20,
      totalTokens: 120,
    });
  });

  test("OpenAI Chat usage with no numeric fields is ignored instead of recording zeros", () => {
    expect(normalizeOpenAIChatUsage({})).toBeUndefined();
  });
});
