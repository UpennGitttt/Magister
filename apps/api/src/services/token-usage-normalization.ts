export type TokenUsageSource = "provider" | "estimated";

export type NormalizedTokenUsage = {
  /** Inclusive input tokens. For providers with prompt caching, this includes
   *  non-cached input + cache reads + cache writes when those fields are
   *  reported separately by the provider dialect. */
  inputTokens: number;
  /** Inclusive output tokens. Reasoning/thinking tokens are included here when
   *  the provider reports them as separate output-side spend. */
  outputTokens: number;
  nonCachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Undefined when a dialect, such as Anthropic Messages today, includes
   *  thinking in output_tokens without exposing a separate breakdown. */
  reasoningTokens?: number;
  totalTokens: number;
  source: TokenUsageSource;
  /** Provider/runtime usage object capped before it is persisted for audit. */
  rawUsage?: unknown;
};

const RAW_USAGE_MAX_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = nonNegativeInt(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function add(...values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function clampToTotal(value: number | undefined, total: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(value, total);
}

export function sanitizeRawUsage(raw: unknown): unknown | undefined {
  if (raw === undefined) return undefined;
  try {
    const json = JSON.stringify(raw);
    if (json === undefined) return undefined;
    const originalBytes = new TextEncoder().encode(json).length;
    if (originalBytes <= RAW_USAGE_MAX_BYTES) {
      return raw;
    }
    return {
      truncated: true,
      originalBytes,
      maxBytes: RAW_USAGE_MAX_BYTES,
    };
  } catch {
    return { unserializable: true };
  }
}

function withRawUsage<T extends Omit<NormalizedTokenUsage, "source">>(
  usage: T,
  raw: unknown,
): NormalizedTokenUsage {
  const rawUsage = sanitizeRawUsage(raw);
  return {
    ...usage,
    source: "provider",
    ...(rawUsage !== undefined ? { rawUsage } : {}),
  };
}

export function normalizeOpenAIChatUsage(raw: unknown): NormalizedTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {};

  const promptTokens = nonNegativeInt(raw.prompt_tokens);
  const completionTokens = nonNegativeInt(raw.completion_tokens);
  const explicitTotal = nonNegativeInt(raw.total_tokens);
  const cacheRead = firstNumber(
    raw.prompt_cache_hit_tokens,
    details.cached_tokens,
    details.cache_read_input_tokens,
    raw.cached_tokens,
  );
  const reasoning = clampToTotal(
    firstNumber(completionDetails.reasoning_tokens),
    completionTokens ?? 0,
  );

  if (
    promptTokens === undefined
    && completionTokens === undefined
    && explicitTotal === undefined
    && cacheRead === undefined
    && reasoning === undefined
  ) {
    return undefined;
  }

  const inputTokens = promptTokens ?? 0;
  const outputTokens = completionTokens ?? 0;
  const totalTokens = explicitTotal ?? inputTokens + outputTokens;
  const nonCachedInputTokens = Math.max(0, inputTokens - (cacheRead ?? 0));

  return withRawUsage({
    inputTokens,
    outputTokens,
    nonCachedInputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens,
  }, raw);
}

export function normalizeAnthropicUsage(raw: unknown): NormalizedTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const nonCachedInput = nonNegativeInt(raw.input_tokens);
  const outputTokens = nonNegativeInt(raw.output_tokens);
  const cacheRead = nonNegativeInt(raw.cache_read_input_tokens);
  const cacheWrite = nonNegativeInt(raw.cache_creation_input_tokens);

  if (
    nonCachedInput === undefined
    && outputTokens === undefined
    && cacheRead === undefined
    && cacheWrite === undefined
  ) {
    return undefined;
  }

  const inputTokens = add(nonCachedInput, cacheRead, cacheWrite);
  const output = outputTokens ?? 0;
  return withRawUsage({
    inputTokens,
    outputTokens: output,
    ...(nonCachedInput !== undefined ? { nonCachedInputTokens: nonCachedInput } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    totalTokens: inputTokens + output,
  }, raw);
}

export function mergeAnthropicTokenUsage(
  previous: NormalizedTokenUsage | undefined,
  next: NormalizedTokenUsage | undefined,
): NormalizedTokenUsage | undefined {
  if (!previous) return next;
  if (!next) return previous;

  const nonCachedInputTokens = next.nonCachedInputTokens ?? previous.nonCachedInputTokens;
  const cacheReadTokens = next.cacheReadTokens ?? previous.cacheReadTokens;
  const cacheWriteTokens = next.cacheWriteTokens ?? previous.cacheWriteTokens;
  const reasoningTokens = next.reasoningTokens ?? previous.reasoningTokens;
  const inputTokens = add(nonCachedInputTokens, cacheReadTokens, cacheWriteTokens);
  const outputTokens = next.outputTokens || previous.outputTokens || 0;
  const rawUsage = previous.rawUsage ?? next.rawUsage;

  return {
    inputTokens,
    outputTokens,
    ...(nonCachedInputTokens !== undefined ? { nonCachedInputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    totalTokens: inputTokens + outputTokens,
    source: "provider",
    ...(rawUsage !== undefined ? { rawUsage } : {}),
  };
}

export function normalizeGeminiUsage(raw: unknown): NormalizedTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = nonNegativeInt(raw.promptTokenCount);
  const cacheRead = nonNegativeInt(raw.cachedContentTokenCount);
  const candidates = nonNegativeInt(raw.candidatesTokenCount);
  const reasoning = nonNegativeInt(raw.thoughtsTokenCount);
  const explicitTotal = nonNegativeInt(raw.totalTokenCount);

  if (
    inputTokens === undefined
    && candidates === undefined
    && explicitTotal === undefined
  ) {
    return undefined;
  }

  const input = inputTokens ?? 0;
  const outputTokens = candidates === undefined ? 0 : add(candidates, reasoning);
  const nonCachedInputTokens = Math.max(0, input - (cacheRead ?? 0));
  return withRawUsage({
    inputTokens: input,
    outputTokens,
    nonCachedInputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(candidates !== undefined && reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: explicitTotal ?? input + outputTokens,
  }, raw);
}

export function normalizeCodexCliUsage(raw: unknown): NormalizedTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputTokens = nonNegativeInt(raw.input_tokens);
  const output = nonNegativeInt(raw.output_tokens);
  const reasoning = nonNegativeInt(raw.reasoning_output_tokens);
  const cacheRead = nonNegativeInt(raw.cached_input_tokens);

  if (
    inputTokens === undefined
    && output === undefined
    && reasoning === undefined
    && cacheRead === undefined
  ) {
    return undefined;
  }

  const input = inputTokens ?? 0;
  const outputTokens = add(output, reasoning);
  return withRawUsage({
    inputTokens: input,
    outputTokens,
    nonCachedInputTokens: Math.max(0, input - (cacheRead ?? 0)),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: input + outputTokens,
  }, raw);
}

export function normalizeClaudeCliUsage(raw: unknown): NormalizedTokenUsage | undefined {
  return normalizeAnthropicUsage(raw);
}

export function normalizeOpencodeCliTokens(raw: unknown): NormalizedTokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const cache = isRecord(raw.cache) ? raw.cache : {};
  const nonCachedInput = nonNegativeInt(raw.input);
  const visibleOutput = nonNegativeInt(raw.output);
  const reasoning = nonNegativeInt(raw.reasoning);
  const cacheRead = nonNegativeInt(cache.read);
  const cacheWrite = nonNegativeInt(cache.write);
  const explicitTotal = nonNegativeInt(raw.total);

  if (
    nonCachedInput === undefined
    && visibleOutput === undefined
    && reasoning === undefined
    && cacheRead === undefined
    && cacheWrite === undefined
    && explicitTotal === undefined
  ) {
    return undefined;
  }

  const inputTokens = add(nonCachedInput, cacheRead, cacheWrite);
  const outputTokens = add(visibleOutput, reasoning);
  return withRawUsage({
    inputTokens,
    outputTokens,
    ...(nonCachedInput !== undefined ? { nonCachedInputTokens: nonCachedInput } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: explicitTotal ?? inputTokens + outputTokens,
  }, raw);
}
