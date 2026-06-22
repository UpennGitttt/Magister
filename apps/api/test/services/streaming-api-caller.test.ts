import { afterEach, expect, test } from "bun:test";

import { callStreamingApi } from "../../src/services/manager-automation/autonomous-loop/streaming-api-caller";
import { createLeaderTools } from "../../src/services/manager-automation/autonomous-loop/manager-tools-adapter";
import type { ExecutorBinding, ModelProfile, ProviderConfig } from "../../src/providers/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("callStreamingApi sends web_search query in the tool schema for anthropic providers", async () => {
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const provider: ProviderConfig = {
    id: "anthropic_test",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://example.com",
    auth: { kind: "none" },
  };

  const model: ModelProfile = {
    id: "claude_test",
    modelName: "claude-test",
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "claude_test",
  };

  const tools = createLeaderTools(process.cwd());

  for await (const _message of callStreamingApi(
    {
      messages: [{ type: "user", content: "Search the web" }],
      systemPrompt: "You are a test harness.",
      tools,
    },
    {
      provider,
      model,
      binding,
      env: {} as NodeJS.ProcessEnv,
    },
  )) {
    // Exhaust the generator so the mocked request is made.
  }

  expect(requestBody).toBeTruthy();
  if (!requestBody) {
    throw new Error("Expected a request body from the mocked fetch call");
  }
  const capturedRequestBody = requestBody as { tools?: unknown };
  const requestTools = capturedRequestBody.tools;
  expect(Array.isArray(requestTools)).toBe(true);

  const webSearchTool = (requestTools as Array<Record<string, unknown>>).find(
    (tool) => tool.name === "web_search",
  );

  expect(webSearchTool).toBeTruthy();
  expect(webSearchTool?.input_schema).toMatchObject({
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results",
      },
    },
    required: ["query"],
  });
});

test("callStreamingApi uses provider-specific kimi thinking fields for openai-compatible streaming requests", async () => {
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const provider: ProviderConfig = {
    id: "kimi_test",
    vendor: "moonshot",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://api.moonshot.ai/v1",
    auth: { kind: "none" },
  };

  const model: ModelProfile = {
    id: "kimi_k2_5",
    modelName: "kimi-k2.5",
    defaultReasoning: {
      mode: "on",
      effort: "medium",
      budgetTokens: 2048,
    },
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "kimi_k2_5",
  };

  for await (const _message of callStreamingApi(
    {
      messages: [{ type: "user", content: "Think carefully." }],
      systemPrompt: "You are a test harness.",
    },
    {
      provider,
      model,
      binding,
      env: {} as NodeJS.ProcessEnv,
    },
  )) {
    // Exhaust the generator so the mocked request is made.
  }

  expect(requestBody).toMatchObject({
    model: "kimi-k2.5",
    thinking: {
      type: "enabled",
    },
    thinking_budget: 2048,
  });
  expect(requestBody).not.toHaveProperty("reasoning_effort");
});

test("callStreamingApi defaults api_key auth to Authorization for openai-compatible providers", async () => {
  let capturedAuthorizationHeader: string | null = null;
  let capturedApiKeyHeader: string | null = null;

  globalThis.fetch = (async (_input, init) => {
    const capturedHeaders = new Headers(init?.headers as HeadersInit);
    capturedAuthorizationHeader = capturedHeaders.get("authorization");
    capturedApiKeyHeader = capturedHeaders.get("x-api-key");
    return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const provider: ProviderConfig = {
    id: "openai_compat_test",
    vendor: "volcengine",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://example.com/v1",
    auth: { kind: "api_key", secretRef: "TEST_STREAMING_API_KEY" },
  };

  const model: ModelProfile = {
    id: "kimi_k2_6_ark",
    modelName: "kimi-k2.6-ark",
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "kimi_k2_6_ark",
  };

  for await (const _message of callStreamingApi(
    {
      messages: [{ type: "user", content: "Ping" }],
      systemPrompt: "You are a test harness.",
    },
    {
      provider,
      model,
      binding,
      env: { TEST_STREAMING_API_KEY: "ark-1234567890" } as NodeJS.ProcessEnv,
    },
  )) {
    // Exhaust the stream.
  }

  expect(capturedAuthorizationHeader).not.toBeNull();
  expect(capturedAuthorizationHeader === "Bearer ark-1234567890").toBe(true);
  expect(capturedApiKeyHeader).toBeNull();
});

// ──────────────────────────────────────────────────────────────────
// Thinking-content streaming
// Spec: docs/specs/2026-04-28-thinking-stream-spec.md
// ──────────────────────────────────────────────────────────────────

async function collectStreamEvents(
  body: string,
  provider: ProviderConfig,
  model: ModelProfile,
): Promise<{
  rawEvents: Array<{ type: string; payload: Record<string, unknown> }>;
  finalContent: Array<Record<string, unknown>>;
  finalUsage: Record<string, unknown> | null;
}> {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: model.id,
  };

  const rawEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let finalContent: Array<Record<string, unknown>> = [];
  let finalUsage: Record<string, unknown> | null = null;

  for await (const message of callStreamingApi(
    {
      messages: [{ type: "user", content: "Test" }],
      systemPrompt: "Test",
    },
    { provider, model, binding, env: {} as NodeJS.ProcessEnv },
  )) {
    const m = message as unknown as Record<string, unknown>;
    if (typeof m.type === "string") {
      rawEvents.push({ type: m.type, payload: m });
      if (m.type === "message_complete" && Array.isArray(m.content)) {
        finalContent = m.content as Array<Record<string, unknown>>;
        finalUsage = typeof m.usage === "object" && m.usage !== null
          ? (m.usage as Record<string, unknown>)
          : null;
      }
    }
  }

  return { rawEvents, finalContent, finalUsage };
}

const ANTHROPIC_PROVIDER: ProviderConfig = {
  id: "anthropic_test",
  vendor: "anthropic",
  transport: "api",
  apiDialect: "anthropic_messages",
  baseUrl: "https://example.com",
  auth: { kind: "none" },
};
const ANTHROPIC_MODEL: ModelProfile = { id: "claude_test", modelName: "claude-test" };

const OPENAI_COMPAT_PROVIDER: ProviderConfig = {
  id: "openai_compat_test",
  vendor: "volcengine",
  transport: "api",
  apiDialect: "openai_chat_completions",
  baseUrl: "https://example.com/v1",
  auth: { kind: "none" },
};
const OPENAI_COMPAT_MODEL: ModelProfile = { id: "kimi_thinking", modelName: "kimi-k2.5-thinking" };

test("OpenAI-compat: usage chunk is normalized to inclusive totals plus breakdown", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"content":"OK."}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":300,"total_tokens":1300,"prompt_tokens_details":{"cached_tokens":250},"completion_tokens_details":{"reasoning_tokens":120}}}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { finalUsage } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  expect(finalUsage).toMatchObject({
    inputTokens: 1_000,
    outputTokens: 300,
    nonCachedInputTokens: 750,
    cacheReadTokens: 250,
    reasoningTokens: 120,
    totalTokens: 1_300,
    source: "provider",
  });
});

test("Anthropic: stream usage merge recomputes inclusive input from cache breakdown", async () => {
  const sse = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK."}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { finalUsage } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  expect(finalUsage).toMatchObject({
    inputTokens: 160,
    outputTokens: 25,
    nonCachedInputTokens: 10,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    totalTokens: 185,
    source: "provider",
  });
});

test("OpenAI-compat: delta.reasoning_content emits thinking_delta and accumulates", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me "}}]}`,
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":"think..."}}]}`,
    `data: {"choices":[{"index":0,"delta":{"content":"Answer."}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  // Two thinking_delta events emitted in order.
  const thinkingEvents = rawEvents.filter((e) => e.type === "thinking_delta");
  expect(thinkingEvents).toHaveLength(2);
  expect((thinkingEvents[0]!.payload as { text?: string }).text).toBe("Let me ");
  expect((thinkingEvents[1]!.payload as { text?: string }).text).toBe("think...");

  // text_delta also flows.
  const textEvents = rawEvents.filter((e) => e.type === "text_delta");
  expect(textEvents).toHaveLength(1);
  expect((textEvents[0]!.payload as { text?: string }).text).toBe("Answer.");

  // Final assistant message has thinking FIRST, then text.
  expect(finalContent.length).toBeGreaterThanOrEqual(2);
  expect(finalContent[0]).toMatchObject({ type: "thinking", thinking: "Let me think..." });
  expect(finalContent[1]).toMatchObject({ type: "text", text: "Answer." });
});

test("OpenAI-compat: only reasoning_content (thinking-only response) yields a single thinking block", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":"Just thinking, no answer."}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  expect(rawEvents.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
  expect(rawEvents.filter((e) => e.type === "text_delta")).toHaveLength(0);
  expect(finalContent).toHaveLength(1);
  expect(finalContent[0]).toMatchObject({ type: "thinking" });
});

test("OpenAI-compat: empty reasoning_content emits no thinking_delta", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":""}}]}`,
    `data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  expect(rawEvents.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  // No thinking block in final content (whitespace-only is trimmed away).
  expect(finalContent.find((b) => b.type === "thinking")).toBeUndefined();
});

test("Anthropic: content_block_delta thinking_delta emits thinking_delta event and accumulates", async () => {
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering "}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"the request..."}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK."}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const thinkingEvents = rawEvents.filter((e) => e.type === "thinking_delta");
  expect(thinkingEvents).toHaveLength(2);
  expect((thinkingEvents[0]!.payload as { text?: string }).text).toBe("Considering ");
  expect((thinkingEvents[1]!.payload as { text?: string }).text).toBe("the request...");

  const textEvents = rawEvents.filter((e) => e.type === "text_delta");
  expect(textEvents).toHaveLength(1);
  expect((textEvents[0]!.payload as { text?: string }).text).toBe("OK.");

  expect(finalContent.length).toBe(2);
  expect(finalContent[0]).toMatchObject({ type: "thinking", thinking: "Considering the request..." });
  expect(finalContent[1]).toMatchObject({ type: "text", text: "OK." });
});

test("Anthropic: content_block_start for thinking block emits no event (just internal state)", async () => {
  // Only a content_block_start — no actual thinking_delta — should
  // produce zero events. The block is opened but never filled.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  expect(rawEvents.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
  expect(finalContent.find((b) => b.type === "thinking")).toBeUndefined();
});

test("Anthropic: signature_delta is ignored silently", async () => {
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm."}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc123"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  // Only the thinking_delta — no spurious event from signature_delta.
  expect(rawEvents.filter((e) => e.type === "thinking_delta")).toHaveLength(1);
  expect(finalContent[0]).toMatchObject({ type: "thinking", thinking: "Hmm." });
});

test("Anthropic: thinking + text + tool_use produces blocks in [thinking, text, tool_use] order", async () => {
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan: list files."}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Listing now."}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"list_dir"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp\\"}"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":2}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  expect(finalContent.length).toBe(3);
  expect(finalContent[0]).toMatchObject({ type: "thinking" });
  expect(finalContent[1]).toMatchObject({ type: "text" });
  expect(finalContent[2]).toMatchObject({ type: "tool_use", name: "list_dir" });
});

test("OpenAI-compat: single chunk with both reasoning_content AND content emits thinking BEFORE text", async () => {
  // Regression for kimi review: parser must order thinking_delta
  // before text_delta when both fields are present in the same
  // delta object. Otherwise downstream rendering of message_complete
  // would put text first, breaking the [thinking, text] block
  // ordering the projector / UI expects.
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"reasoning_content":"first I think","content":"then I answer"}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  // Find indices of the first thinking_delta and text_delta events.
  const thinkingIdx = rawEvents.findIndex((e) => e.type === "thinking_delta");
  const textIdx = rawEvents.findIndex((e) => e.type === "text_delta");
  expect(thinkingIdx).toBeGreaterThanOrEqual(0);
  expect(textIdx).toBeGreaterThanOrEqual(0);
  expect(thinkingIdx).toBeLessThan(textIdx);

  expect(finalContent[0]).toMatchObject({ type: "thinking", thinking: "first I think" });
  expect(finalContent[1]).toMatchObject({ type: "text", text: "then I answer" });
});

// ──────────────────────────────────────────────────────────────────
// P2 — retry/backoff coverage. Verifies the loop transparently
// retries 5xx / 429 / 529 responses, honors Retry-After when
// present, and falls through to the fallback model only after the
// per-model retry budget is spent.
//
// These tests stub `globalThis.fetch` directly (NOT via
// collectStreamEvents, which overrides fetch with its own canned
// response) and run callStreamingApi inline.
// ──────────────────────────────────────────────────────────────────

async function runWithFetchStub(
  stub: (input: unknown) => Promise<Response>,
  provider: ProviderConfig = ANTHROPIC_PROVIDER,
  model: ModelProfile = ANTHROPIC_MODEL,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  globalThis.fetch = stub as unknown as typeof fetch;
  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: model.id,
  };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for await (const message of callStreamingApi(
    { messages: [{ type: "user", content: "Test" }], systemPrompt: "Test" },
    { provider, model, binding, env: {} as NodeJS.ProcessEnv },
  )) {
    const m = message as unknown as Record<string, unknown>;
    if (typeof m.type === "string") events.push({ type: m.type, payload: m });
  }
  return events;
}

test("retries 503 then succeeds — same model, no fallback consumed", async () => {
  let attempts = 0;
  const events = await runWithFetchStub(async () => {
    attempts++;
    if (attempts < 3) {
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  expect(attempts).toBe(3);
  expect(events.find((e) => e.type === "message_complete")).toBeDefined();
});

test("does NOT retry 400 (auth/malformed)", async () => {
  let attempts = 0;
  await runWithFetchStub(async () => {
    attempts++;
    return new Response('{"error":"bad request"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  });
  expect(attempts).toBe(1);
});

test("retries 529 (Anthropic overload)", async () => {
  let attempts = 0;
  const events = await runWithFetchStub(async () => {
    attempts++;
    if (attempts < 2) {
      return new Response("overloaded", {
        status: 529,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  expect(attempts).toBe(2);
  expect(events.find((e) => e.type === "message_complete")).toBeDefined();
});

test("MAX_RETRIES exhausted on 503 surfaces error to caller", async () => {
  let attempts = 0;
  const events = await runWithFetchStub(async () => {
    attempts++;
    return new Response("down", { status: 503, headers: { "retry-after": "0" } });
  });
  // 1 initial + MAX_RETRIES=3 retries = 4 attempts total per model.
  expect(attempts).toBe(4);
  const completeEvent = events.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
});

test("Retry-After: 0 triggers immediate retry (kimi P1.7-P5 review M)", async () => {
  const startedAt = Date.now();
  let attempts = 0;
  const events = await runWithFetchStub(async () => {
    attempts++;
    if (attempts < 2) {
      return new Response("rate-limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const elapsed = Date.now() - startedAt;
  expect(attempts).toBe(2);
  // With Retry-After: 0 honored, the wait should be ~0ms — well
  // under the 100ms minimum jitter the prior bug forced.
  expect(elapsed).toBeLessThan(200);
  expect(events.find((e) => e.type === "message_complete")).toBeDefined();
});

// ──────────────────────────────────────────────────────────────────
// Canonical-id-at-ingest (2026-05-08 codex-reviewed). The streaming
// caller mints `tu_<random12>` for every tool_use the moment
// AccumulatedToolUse is created. Provider id (kimi's `grep:12`,
// Claude's `toolu_…`) goes to `providerToolUseId` for incident
// analysis only — never used for routing inside Magister.
// ──────────────────────────────────────────────────────────────────

test("OpenAI-compat: canonical id minted, provider id preserved on tool_use block", async () => {
  // Mimic kimi's id format (the bug source).
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"grep:12","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");
  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  // Canonical id has the `tu_` prefix and is NOT the model's `grep:12`.
  expect((toolBlock!.id as string).startsWith("tu_")).toBe(true);
  expect(toolBlock!.id).not.toBe("grep:12");
  // Provider id preserved for debug.
  expect(toolBlock!.providerToolUseId).toBe("grep:12");
  // tool_use_start emitted with the canonical id (frontend / UI sees this).
  const startEvent = rawEvents.find((e) => e.type === "tool_use_start");
  expect(startEvent).toBeDefined();
  expect(startEvent!.payload.id).toBe(toolBlock!.id);
});

test("OpenAI-compat: same model id in two streams gets two different canonical ids", async () => {
  // Each call to collectStreamEvents is a fresh stream with fresh
  // accumulated state, so even if the model emits `grep:12` again,
  // the canonical id mints fresh. This is what fixes the cross-turn
  // collision class at the architectural level.
  const ssePiece = (model: string) => [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"grep:12","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const r1 = await collectStreamEvents(ssePiece("a"), OPENAI_COMPAT_PROVIDER, OPENAI_COMPAT_MODEL);
  const r2 = await collectStreamEvents(ssePiece("b"), OPENAI_COMPAT_PROVIDER, OPENAI_COMPAT_MODEL);
  const id1 = r1.finalContent.find((b) => b.type === "tool_use")?.id;
  const id2 = r2.finalContent.find((b) => b.type === "tool_use")?.id;
  expect(id1).toBeDefined();
  expect(id2).toBeDefined();
  expect(id1).not.toBe(id2);
  // Both carry the SAME provider id (the model emitted `grep:12` twice).
  const p1 = r1.finalContent.find((b) => b.type === "tool_use")?.providerToolUseId;
  const p2 = r2.finalContent.find((b) => b.type === "tool_use")?.providerToolUseId;
  expect(p1).toBe("grep:12");
  expect(p2).toBe("grep:12");
});

test("Anthropic: canonical id minted, provider toolu_ id preserved", async () => {
  const sse = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m_1","model":"claude-test","stop_reason":null}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc123","name":"bash"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");
  const { finalContent } = await collectStreamEvents(sse, ANTHROPIC_PROVIDER, ANTHROPIC_MODEL);
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect((toolBlock!.id as string).startsWith("tu_")).toBe(true);
  expect(toolBlock!.id).not.toBe("toolu_abc123");
  expect(toolBlock!.providerToolUseId).toBe("toolu_abc123");
});

// ──────────────────────────────────────────────────────────────────
// 2026-05-24 — Cross-provider fallback. When the primary provider
// returns a 503-ish failure (or any non-retryable error after the
// per-model retry budget runs out), the streaming caller should
// dispatch the fallback model to `config.fallbackProvider` instead
// of inheriting the primary's baseUrl. Without this, a leader with
// primary=DeepSeek + fallback=kimi-k2.6-ark@volcengine-ark would
// POST kimi-k2.6-ark to api.deepseek.com → 404.
// ──────────────────────────────────────────────────────────────────

test("fallback model dispatches to fallbackProvider's baseUrl + dialect (cross-provider)", async () => {
  const urls: string[] = [];
  const models: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    urls.push(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (body.model) models.push(body.model);
    if (url.startsWith("https://api.deepseek.com")) {
      // Primary fails non-retryably (auth-shaped 401) so fallback engages.
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    // Fallback succeeds — anthropic-style minimal stream.
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const primaryProvider: ProviderConfig = {
    id: "DeepSeek",
    vendor: "deepseek",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    auth: { kind: "none" },
  };
  const fallbackProvider: ProviderConfig = {
    id: "volcengine-ark",
    vendor: "volcengine",
    transport: "api",
    apiDialect: "openai_chat_completions",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    auth: { kind: "none" },
  };
  const model: ModelProfile = {
    id: "deepseek_pro",
    modelName: "deepseek-v4-pro",
    fallbacks: ["kimi-k2.6-ark"],
  };
  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "deepseek_pro",
  };

  for await (const _ of callStreamingApi(
    { messages: [{ type: "user", content: "Hi" }], systemPrompt: "Hi" },
    { provider: primaryProvider, model, binding, fallbackProvider, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }

  expect(urls.length).toBeGreaterThanOrEqual(2);
  expect(urls[0]!.startsWith("https://api.deepseek.com")).toBe(true);
  expect(urls[urls.length - 1]!.startsWith("https://ark.cn-beijing.volces.com")).toBe(true);
  expect(models[0]).toBe("deepseek-v4-pro");
  expect(models[models.length - 1]).toBe("kimi-k2.6-ark");
});

test("non-vision model: image blocks in tool_result are replaced with text placeholder before send (Anthropic dialect)", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const nonVisionModel: ModelProfile = {
    ...ANTHROPIC_MODEL,
    modelName: "qwen3.7-max",
    // capabilityHints.vision intentionally absent — mirrors the bailian
    // qwen3.7-max profile that triggered InvalidParameter on a Playwright
    // screenshot tool_result.
  };

  const messagesWithImage = [
    { type: "user" as const, content: "take a screenshot" },
    {
      type: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tu_screenshot",
          name: "mcp__playwright__browser_take_screenshot",
          input: {},
        },
      ],
    },
    {
      type: "tool_result" as const,
      toolUseId: "tu_screenshot",
      content: [
        { type: "text" as const, text: "### Result\n- screenshot saved" },
        { type: "image" as const, mediaType: "image/png", data: "aGVsbG93b3JsZA==" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithImage, systemPrompt: "sys" },
    { provider: ANTHROPIC_PROVIDER, model: nonVisionModel, binding: { adapterId: "leader_api", executionMode: "api", modelRef: nonVisionModel.id }, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }

  expect(requestBody).toBeTruthy();
  const serialized = JSON.stringify(requestBody);
  // No image block survived to the wire.
  expect(serialized.includes('"type":"image"')).toBe(false);
  expect(serialized.includes('aGVsbG93b3JsZA==')).toBe(false);
  // Placeholder is present and mentions the actual model so the model
  // can name it when telling the user.
  expect(serialized.includes("image unavailable")).toBe(true);
  expect(serialized.includes("qwen3.7-max")).toBe(true);
});

test("non-vision model: user-uploaded image block is replaced with text placeholder (OpenAI-compat dialect)", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK."}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const nonVisionModel: ModelProfile = {
    ...OPENAI_COMPAT_MODEL,
    modelName: "text-only-model",
  };

  const messagesWithImage = [
    {
      type: "user" as const,
      content: [
        { type: "text" as const, text: "look at this" },
        { type: "image" as const, mediaType: "image/png", data: "dXBsb2FkZWQ=" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithImage, systemPrompt: "sys" },
    { provider: OPENAI_COMPAT_PROVIDER, model: nonVisionModel, binding: { adapterId: "leader_api", executionMode: "api", modelRef: nonVisionModel.id }, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }

  const serialized = JSON.stringify(requestBody);
  expect(serialized.includes('"type":"image_url"')).toBe(false);
  expect(serialized.includes('dXBsb2FkZWQ=')).toBe(false);
  expect(serialized.includes("image unavailable")).toBe(true);
  expect(serialized.includes("text-only-model")).toBe(true);
});

test("vision-capable model: image blocks survive intact through conversion", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const visionModel: ModelProfile = {
    ...ANTHROPIC_MODEL,
    modelName: "claude-sonnet-test",
    capabilityHints: { vision: true },
  };

  const messagesWithImage = [
    { type: "user" as const, content: "ping" },
    { type: "assistant" as const, content: [{ type: "tool_use" as const, id: "tu_x", name: "noop", input: {} }] },
    {
      type: "tool_result" as const,
      toolUseId: "tu_x",
      content: [
        { type: "text" as const, text: "ok" },
        { type: "image" as const, mediaType: "image/png", data: "aW1nQllURVM=" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithImage, systemPrompt: "sys" },
    { provider: ANTHROPIC_PROVIDER, model: visionModel, binding: { adapterId: "leader_api", executionMode: "api", modelRef: visionModel.id }, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }

  const serialized = JSON.stringify(requestBody);
  // image MUST reach the wire intact when vision flag is set.
  expect(serialized.includes('aW1nQllURVM=')).toBe(true);
  expect(serialized.includes("image unavailable")).toBe(false);
});

test("non-vision model: image blocks in assistant.content are flattened (defense-in-depth)", async () => {
  // Leader runtime today never builds assistant-role image blocks (model
  // output is text/thinking/tool_use only). This test pins the
  // defense-in-depth behavior so a future code path that DOES inline an
  // image into assistant content can't silently regress and surface as
  // an "Unexpected item type in content" 400 from text-only providers.
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const nonVisionModel: ModelProfile = { ...ANTHROPIC_MODEL, modelName: "qwen3.7-max" };
  const messagesWithAssistantImage = [
    { type: "user" as const, content: "hi" },
    {
      type: "assistant" as const,
      content: [
        { type: "text" as const, text: "here is a picture" },
        { type: "image" as const, mediaType: "image/png", data: "YXNzaXN0YW50SU1H" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithAssistantImage, systemPrompt: "sys" },
    { provider: ANTHROPIC_PROVIDER, model: nonVisionModel, binding: { adapterId: "leader_api", executionMode: "api", modelRef: nonVisionModel.id }, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }

  const serialized = JSON.stringify(requestBody);
  expect(serialized.includes('YXNzaXN0YW50SU1H')).toBe(false);
  expect(serialized.includes("image unavailable")).toBe(true);
});

test("fallback model uses primary provider when fallbackProvider not set (back-compat)", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    urls.push(url);
    if (urls.length === 1) {
      // Primary fails non-retryably.
      return new Response('{"error":"upstream rejected"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const model: ModelProfile = {
    ...ANTHROPIC_MODEL,
    fallbacks: ["claude-haiku-test"],
  };
  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: model.id,
  };
  for await (const _ of callStreamingApi(
    { messages: [{ type: "user", content: "Hi" }], systemPrompt: "Hi" },
    { provider: ANTHROPIC_PROVIDER, model, binding, env: {} as NodeJS.ProcessEnv },
  )) {
    // drain
  }
  // Both attempts target the primary provider's baseUrl.
  expect(urls.length).toBe(2);
  expect(urls.every((u) => u.startsWith(ANTHROPIC_PROVIDER.baseUrl!))).toBe(true);
});

test("a 400 from the provider yields message_complete with structured errorDetail (status/provider/body)", async () => {
  // Observability: when upstream rejects with 400, the error envelope must
  // carry the HTTP status, provider id, and (truncated) upstream body so the
  // downstream leader.model_error event records WHY it failed — not just a
  // bare message string. See autonomous-loop-service model_error recording.
  const upstreamBody = JSON.stringify({
    error: { message: "max_tokens should be [1, 65536]" },
  });

  globalThis.fetch = (async (_input, _init) =>
    new Response(upstreamBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "claude_test",
  };

  let errorEvent: Record<string, unknown> | null = null;
  for await (const message of callStreamingApi(
    { messages: [{ type: "user", content: "hi" }], systemPrompt: "test", tools: [] },
    { provider: ANTHROPIC_PROVIDER, model: ANTHROPIC_MODEL, binding, env: {} as NodeJS.ProcessEnv },
  )) {
    if (message.type === "message_complete" && message.isError) {
      errorEvent = message as unknown as Record<string, unknown>;
    }
  }

  expect(errorEvent).toBeTruthy();
  const detail = errorEvent?.errorDetail as
    | { status?: number; provider?: string; body?: string }
    | undefined;
  expect(detail).toBeTruthy();
  expect(detail?.status).toBe(400);
  expect(detail?.provider).toBe("anthropic_test");
  expect(typeof detail?.body).toBe("string");
  expect(detail?.body).toContain("max_tokens should be");
});

// ──────────────────────────────────────────────────────────────────
// PR1 — EOF-before-terminal guard (checkpoint-poisoning prevention).
//
// When the SSE stream closes (EOF) BEFORE the dialect's terminal event
// ([DONE] for OpenAI-compat, message_stop / message_delta{stop_reason}
// for Anthropic), a tool_use block that was mid-stream would have
// partial/malformed JSON → input:{} after JSON.parse throws.
// That poisoned tool call must NOT enter the leader loop as a
// real tool execution.
//
// Guard condition (streaming-api-caller.ts ~1139):
//   if (!sawTerminal && accumulated.toolUses.size > 0)
//
// Text-only truncation (no tool block) is left as-is since partial
// text is safe to deliver and doesn't poison the loop.
// ──────────────────────────────────────────────────────────────────

test("PR1 Anthropic: EOF before message_stop with open tool_use → isError message_complete (not a finalized tool call)", async () => {
  // Stream opens a tool_use block and starts emitting input_json_delta,
  // then closes WITHOUT message_stop. The guard must catch this and
  // emit an error result rather than a success message_complete with
  // input:{} from the failed JSON.parse of the partial args.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_partial","name":"bash"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls "}}`,
    // Stream ends here — no content_block_stop, no message_delta, no message_stop
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  // Must be an error result.
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  // The error content must mention stream closed / terminal event.
  const contentArr = completeEvent!.payload.content as Array<Record<string, unknown>>;
  const textBlock = contentArr.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toMatch(/stream closed before terminal event/i);
  // No tool_use block should have been finalized.
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR1 OpenAI-compat: EOF before [DONE] with open tool_use → isError message_complete (not a finalized tool call)", async () => {
  // Partial tool call, then stream ends with no [DONE] sentinel.
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_partial","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls "}}]}}]}`,
    // Stream closes — no finish_reason chunk, no [DONE]
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  const contentArr = completeEvent!.payload.content as Array<Record<string, unknown>>;
  const textBlock = contentArr.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toMatch(/stream closed before terminal event/i);
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR1 happy-path: Anthropic complete stream with message_stop still yields normal tool_use (no regression)", async () => {
  // Full well-formed stream — guard must NOT trigger.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ok","name":"bash"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  // Must NOT be an error.
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  // Tool block should be finalized with correct input.
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect(toolBlock!.name).toBe("bash");
  expect((toolBlock!.input as Record<string, unknown>).command).toBe("ls");
});

test("PR1 happy-path: OpenAI-compat complete stream with [DONE] still yields normal tool_use (no regression)", async () => {
  // Full well-formed stream — guard must NOT trigger.
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ok","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect(toolBlock!.name).toBe("bash");
  expect((toolBlock!.input as Record<string, unknown>).command).toBe("ls");
});

test("PR1 regression: OpenAI-compat finish_reason → usage chunk → [DONE] with tool_use must NOT false-positive as truncated", async () => {
  // The PRODUCTION sequence for any openai-compat provider that reports
  // usage mid-stream (Kimi, anything with stream_options.include_usage):
  // the model emits a complete tool call, a finish_reason chunk, THEN a
  // standalone usage chunk, THEN [DONE]. The loop breaks on the usage
  // chunk (`openAiReceivedFinal && usage`) BEFORE reading [DONE]. PR1
  // originally keyed `sawTerminal` only off [DONE], so this clean
  // completion was wrongly rejected as a truncated stream (isError) and
  // the real tool call was dropped. finish_reason is the dialect's true
  // terminal signal — the fix sets sawTerminal there.
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ok","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  // Must NOT be flagged as a truncated stream — finish_reason was seen.
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect(toolBlock!.name).toBe("bash");
  expect((toolBlock!.input as Record<string, unknown>).command).toBe("ls");
});

test("PR1 text-only EOF: Anthropic stream with only text and no message_stop still delivers text (not an error)", async () => {
  // Text-only truncation — no tool block open — should not be treated
  // as a poisoning event. The guard condition requires toolUses.size > 0.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial answer"}}`,
    // No message_stop — stream truncated after text only.
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  // Text-only truncation is NOT flagged as error (guard only triggers on tool blocks).
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const textBlock = finalContent.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toBe("Partial answer");
});

// ──────────────────────────────────────────────────────────────────
// PR2 — per-fallback ModelProfile
//
// The streaming caller's fallback chain must use each attempt's OWN
// ModelProfile for both vision-image stripping and buildRequestBody
// (maxOutputTokens / requestOverrides). Using the primary's profile
// on all attempts is wrong when primary and fallback differ in vision
// capability or output-token limits.
//
// Scenario: primary = vision-capable Claude; fallback = text-only
// Bailian/qwen (no capabilityHints.vision). The fallback attempt must
// strip images so the shim doesn't reject with "Unexpected item type".
// ──────────────────────────────────────────────────────────────────

test("PR2: fallback attempt with non-vision profile strips images even when primary is vision-capable", async () => {
  // Track the request bodies per URL so we can verify per-attempt content.
  const requestsByUrl: Record<string, string> = {};

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    requestsByUrl[url] = String(init?.body ?? "");

    if (url.startsWith("https://primary.example.com")) {
      // Primary fails with a non-retryable error so fallback engages.
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    // Fallback (text-only shim) succeeds.
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const primaryProvider: ProviderConfig = {
    id: "primary_vision",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://primary.example.com",
    auth: { kind: "none" },
  };
  const fallbackProvider: ProviderConfig = {
    id: "bailian_shim",
    vendor: "aliyun",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://fallback.example.com",
    auth: { kind: "none" },
  };

  // Primary model is vision-capable.
  const primaryModel: ModelProfile = {
    id: "claude_vision",
    modelName: "claude-primary",
    capabilityHints: { vision: true },
    maxOutputTokens: 8000,
    fallbacks: ["qwen3.7-max"],
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "claude_vision",
  };

  const messagesWithImage = [
    { type: "user" as const, content: "take a screenshot" },
    {
      type: "assistant" as const,
      content: [
        {
          type: "tool_use" as const,
          id: "tu_screenshot",
          name: "mcp__playwright__browser_take_screenshot",
          input: {},
        },
      ],
    },
    {
      type: "tool_result" as const,
      toolUseId: "tu_screenshot",
      content: [
        { type: "text" as const, text: "screenshot saved" },
        { type: "image" as const, mediaType: "image/png", data: "aGVsbG93b3JsZA==" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithImage, systemPrompt: "sys" },
    {
      provider: primaryProvider,
      model: primaryModel,
      binding,
      fallbackProvider,
      env: {} as NodeJS.ProcessEnv,
      // Attach the per-fallback profile: non-vision, lower maxOutputTokens.
      fallbackModelProfile: {
        id: "qwen_shim",
        modelName: "qwen3.7-max",
        // capabilityHints.vision intentionally absent.
        maxOutputTokens: 4096,
      },
    },
  )) {
    // drain
  }

  // The fallback (bailian) request body must NOT contain image data.
  const fallbackBody = requestsByUrl["https://fallback.example.com/v1/messages"];
  expect(fallbackBody).toBeDefined();
  const fallbackSerialized = fallbackBody ?? "";
  expect(fallbackSerialized.includes('"type":"image"')).toBe(false);
  expect(fallbackSerialized.includes("aGVsbG93b3JsZA==")).toBe(false);
  expect(fallbackSerialized.includes("image unavailable")).toBe(true);
  // Placeholder names the actual fallback model.
  expect(fallbackSerialized.includes("qwen3.7-max")).toBe(true);
});

test("PR2: fallback attempt with vision-capable profile keeps images intact", async () => {
  const requestsByUrl: Record<string, string> = {};

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    requestsByUrl[url] = String(init?.body ?? "");
    if (url.startsWith("https://primary.example.com")) {
      return new Response('{"error":"overloaded"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const primaryProvider: ProviderConfig = {
    id: "primary_text_only",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://primary.example.com",
    auth: { kind: "none" },
  };
  const fallbackProvider: ProviderConfig = {
    id: "fallback_vision",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://fallback.example.com",
    auth: { kind: "none" },
  };

  const primaryModel: ModelProfile = {
    id: "text_only_primary",
    modelName: "text-primary",
    // No capabilityHints.vision — primary strips images.
    fallbacks: ["claude-vision-fallback"],
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "text_only_primary",
  };

  const messagesWithImage = [
    {
      type: "user" as const,
      content: [
        { type: "text" as const, text: "look at this" },
        { type: "image" as const, mediaType: "image/png", data: "dmlzaW9uSU1H" },
      ],
    },
  ];

  for await (const _ of callStreamingApi(
    { messages: messagesWithImage, systemPrompt: "sys" },
    {
      provider: primaryProvider,
      model: primaryModel,
      binding,
      fallbackProvider,
      env: {} as NodeJS.ProcessEnv,
      // Fallback model IS vision-capable.
      fallbackModelProfile: {
        id: "claude_vision_fb",
        modelName: "claude-vision-fallback",
        capabilityHints: { vision: true },
      },
    },
  )) {
    // drain
  }

  const fallbackBody = requestsByUrl["https://fallback.example.com/v1/messages"];
  expect(fallbackBody).toBeDefined();
  const fallbackSerialized = fallbackBody ?? "";
  // Image data must reach the fallback intact (vision-capable fallback).
  expect(fallbackSerialized.includes("dmlzaW9uSU1H")).toBe(true);
  expect(fallbackSerialized.includes("image unavailable")).toBe(false);
});

test("PR2: buildRequestBody on fallback uses fallback profile's maxOutputTokens (not primary's)", async () => {
  const requestsByUrl: Record<string, Record<string, unknown>> = {};

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    requestsByUrl[url] = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.startsWith("https://primary.example.com")) {
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const primaryProvider: ProviderConfig = {
    id: "primary_provider_maxtok",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://primary.example.com",
    auth: { kind: "none" },
  };
  const fallbackProvider: ProviderConfig = {
    id: "fallback_provider_maxtok",
    vendor: "anthropic",
    transport: "api",
    apiDialect: "anthropic_messages",
    baseUrl: "https://fallback.example.com",
    auth: { kind: "none" },
  };

  const primaryModel: ModelProfile = {
    id: "primary_big_tokens",
    modelName: "primary-model",
    maxOutputTokens: 16000,
    fallbacks: ["fallback-model"],
  };

  const binding: ExecutorBinding = {
    adapterId: "leader_api",
    executionMode: "api",
    modelRef: "primary_big_tokens",
  };

  for await (const _ of callStreamingApi(
    { messages: [{ type: "user", content: "hi" }], systemPrompt: "sys" },
    {
      provider: primaryProvider,
      model: primaryModel,
      binding,
      fallbackProvider,
      env: {} as NodeJS.ProcessEnv,
      // Fallback profile caps max_tokens at 4096.
      fallbackModelProfile: {
        id: "fallback_small_tokens",
        modelName: "fallback-model",
        maxOutputTokens: 4096,
      },
    },
  )) {
    // drain
  }

  const fallbackBody = requestsByUrl["https://fallback.example.com/v1/messages"];
  expect(fallbackBody).toBeDefined();
  // max_tokens in the fallback request must come from the fallback profile,
  // not the primary's 16000.
  expect((fallbackBody as { max_tokens?: number })["max_tokens"]).toBe(4096);
});

// ──────────────────────────────────────────────────────────────────
// PR(truncated-toolcall) #2 — max_tokens / length-truncated tool call.
//
// Distinct from PR1 (EOF BEFORE terminal). Here the stream ends WITH a
// proper terminal event, but the dialect stop signal indicates
// OUTPUT-TOKEN truncation (anthropic stop_reason "max_tokens"; openai
// finish_reason "length") WHILE a tool_use block is still open / has
// incomplete args JSON. Finalizing it would checkpoint a partial tool
// call (e.g. spawn_teammate with `goal` cut off) → InputValidationError
// → identical re-emit → doom loop. The guard must instead emit an
// isError message_complete the leader loop treats as a recoverable
// model error.
//
// Happy paths (stop_reason end_turn/tool_use; finish_reason stop/
// tool_calls) with a COMPLETE tool call must NOT false-positive.
// ──────────────────────────────────────────────────────────────────

test("PR#2 Anthropic: stop_reason max_tokens with open tool_use → isError 'truncated' (not a finalized partial tool call)", async () => {
  // A spawn_teammate-shaped call whose JSON is cut off mid-`goal`,
  // then a message_delta carrying stop_reason "max_tokens".
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_trunc","name":"spawn_teammate"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"role\\":\\"coder\\",\\"expected_output\\":\\"a long shape\\",\\"goal\\":\\"start of a very lo"}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  const contentArr = completeEvent!.payload.content as Array<Record<string, unknown>>;
  const textBlock = contentArr.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toMatch(/truncat/i);
  expect(String(textBlock!.text)).toMatch(/token limit|output token/i);
  // No partial tool_use must be finalized.
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR#2 OpenAI-compat: finish_reason length with open tool_use → isError 'truncated' (not a finalized partial tool call)", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"spawn_teammate","arguments":"{\\"role\\":\\"coder\\",\\"expected_output\\":\\"shape\\",\\"goal\\":\\"start of a very lo"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  const contentArr = completeEvent!.payload.content as Array<Record<string, unknown>>;
  const textBlock = contentArr.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toMatch(/truncat/i);
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR#2 OpenAI-compat: finish_reason length followed by usage chunk then [DONE], open tool_use → still isError 'truncated'", async () => {
  // Production sequence: providers with include_usage emit
  // finish_reason, then a standalone usage chunk, then [DONE]. The
  // truncation verdict must survive that — it's keyed off the
  // finish_reason, not [DONE].
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"spawn_teammate","arguments":"{\\"role\\":\\"coder\\",\\"goal\\":\\"incomp"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR#2 happy-path Anthropic: stop_reason tool_use with COMPLETE tool call → normal tool_use (no false positive)", async () => {
  // The legitimate completion that COINCIDES with a tool call. Even
  // though there is an open tool_use, stop_reason is tool_use (not
  // max_tokens) → must finalize normally.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_ok","name":"bash"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect(toolBlock!.name).toBe("bash");
  expect((toolBlock!.input as Record<string, unknown>).command).toBe("ls");
});

test("PR#2 happy-path OpenAI-compat: finish_reason tool_calls with COMPLETE tool call → normal tool_use (no false positive)", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ok","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect(toolBlock!.name).toBe("bash");
});

test("PR#2 boundary: Anthropic stop_reason max_tokens with NO tool_use (text only) → NOT an error, text delivered", async () => {
  // max_tokens truncation of plain text is recoverable on the user
  // side — the guard must only fire when a tool_use block is open.
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A long partial answer"}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const textBlock = finalContent.find((b) => b.type === "text");
  expect(textBlock).toBeDefined();
  expect(String(textBlock!.text)).toBe("A long partial answer");
});

// ── PR(truncated-toolcall) #3: finish-reason-AGNOSTIC incomplete-args guard ──
// Reproduces the prod kimi-k2.6 incident: a spawn_teammate tool call whose
// args were cut off after `{"role":"coder"` (incomplete JSON) with a NORMAL
// finish reason. Pre-fix this fell through to buildFinalContentBlocks and got
// silently coerced to input:{} → empty-args doom loop.

test("PR#3 OpenAI-compat: incomplete tool args ({\"role\":\"coder\") + finish_reason tool_calls → isError (not empty input:{})", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"spawn_teammate","arguments":"{\\"role\\": \\"coder\\""}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect(completeEvent).toBeDefined();
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  // Must NOT finalize a poisoned empty tool_use.
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
  const text = (completeEvent!.payload.content as Array<{ type: string; text?: string }>)
    .find((b) => b.type === "text")?.text ?? "";
  expect(text).toMatch(/incomplete|cut off/i);
  expect(text).toContain("spawn_teammate");
});

test("PR#3 Anthropic: incomplete input_json_delta + stop_reason tool_use → isError (not empty input:{})", async () => {
  const sse = [
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_trunc","name":"spawn_teammate"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"role\\": \\"coder\\""}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    ANTHROPIC_PROVIDER,
    ANTHROPIC_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBe(true);
  expect(finalContent.find((b) => b.type === "tool_use")).toBeUndefined();
});

test("PR#3 no-false-positive: a COMPLETE multi-field tool call (normal finish) → normal tool_use", async () => {
  const sse = [
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_full","type":"function","function":{"name":"spawn_teammate","arguments":"{\\"role\\":\\"coder\\",\\"goal\\":\\"do the thing\\"}"}}]}}]}`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    `data: [DONE]`,
    "",
  ].join("\n\n");

  const { rawEvents, finalContent } = await collectStreamEvents(
    sse,
    OPENAI_COMPAT_PROVIDER,
    OPENAI_COMPAT_MODEL,
  );

  const completeEvent = rawEvents.find((e) => e.type === "message_complete");
  expect((completeEvent!.payload as { isError?: boolean }).isError).toBeFalsy();
  const toolBlock = finalContent.find((b) => b.type === "tool_use");
  expect(toolBlock).toBeDefined();
  expect((toolBlock!.input as Record<string, unknown>).goal).toBe("do the thing");
});
