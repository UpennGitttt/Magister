import type { LeaderMessage, LeaderContentBlock, LeaderResultBlock, LeaderResultContent, LeaderStreamEvent, LeaderTool } from "./autonomous-types";
import type {
  ProviderConfig,
  ModelProfile,
  ExecutorBinding,
  ProviderApiDialect,
} from "../../../providers/types";
import { getSupportedDialects, resolveProviderPlugin } from "../../../providers/plugin-registry";
import type { ProviderPlugin } from "../../../providers/provider-plugin";
import { resolveSecretValue as resolveSecretValueFromStore } from "../../../services/local-secret-store-service";
import { readWithIdleTimeout, DEFAULT_SSE_IDLE_TIMEOUT_MS } from "./sse-idle-timeout";
import {
  mergeAnthropicTokenUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIChatUsage,
  type NormalizedTokenUsage,
} from "../../token-usage-normalization";
import { randomUUID } from "crypto";

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * P2 — retry/backoff for transient API errors.
 *
 *   1. Honors Retry-After header when present (Anthropic / OpenAI
 *      send this on 429 and 529).
 *   2. Single retry budget per MODEL — we still fall through to the
 *      fallback model after retries exhaust on the primary, so a
 *      provider that's hard-down doesn't block the user.
 *
 * Statuses we retry: 408 (timeout), 429 (rate limit), 500/502/503/504
 * (gateway / server), 529 (Anthropic overload). Network errors
 * (fetch threw) also retry.
 *
 * Statuses we DON'T retry: 4xx other than 408/429 (auth, malformed
 * request, model-not-found — retrying just burns time and quota).
 */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

function isRetryableStatus(status: number): boolean {
  return (
    status === 408
    || status === 429
    || status === 529
    || (status >= 500 && status <= 599)
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  // Kimi review M — accept Retry-After: 0 as immediate retry per
  // RFC 7231 §7.1.3 ("0" means "retry now"). Previously it fell
  // through to date parsing, which produced NaN and was treated as
  // "no Retry-After", forcing an unnecessary exponential backoff.
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
    }
  }
  // HTTP-date form per RFC 7231 §7.1.3
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta >= 0) return Math.min(delta, RETRY_AFTER_CAP_MS);
  }
  return null;
}

function computeBackoffMs(attempt: number, retryAfter: string | null): number {
  const honored = parseRetryAfter(retryAfter);
  if (honored != null) return honored;
  // Exponential backoff with full jitter: rand(0, base * 2^attempt),
  // capped at MAX_BACKOFF_MS. Full jitter avoids thundering herd
  // when many clients hit the same rate limit window simultaneously.
  const cap = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return Math.floor(Math.random() * cap);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function resolveSecretValue(
  secretRef: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!secretRef) return undefined;
  // First try the local secret store (config/secrets.json)
  const storeValue = resolveSecretValueFromStore(secretRef, env);
  if (storeValue) return storeValue;
  // Fallback to env var
  return env[secretRef];
}

function resolveHeaderValue(
  header: { name: string; value?: string; secretRef?: string; envRef?: string },
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicitValue = normalizeString(header.value);
  if (explicitValue) return explicitValue;
  return resolveSecretValue(header.secretRef, env) || resolveSecretValue(header.envRef, env);
}

function resolveAuthHeader(
  auth: ProviderConfig["auth"],
  env: NodeJS.ProcessEnv,
  apiDialect: ProviderApiDialect,
): { name: string; value: string } | undefined {
  if (auth.kind === "none") return undefined;

  if (auth.kind === "chatgpt_session") {
    const value = resolveSecretValue("OPENAI_API_KEY", env);
    return value ? { name: "Authorization", value: `Bearer ${value}` } : undefined;
  }

  const secret = resolveSecretValue(auth.secretRef, env);
  if (!secret) return undefined;

  const defaultHeaderName = auth.kind === "api_key"
    ? (apiDialect === "anthropic_messages" ? "x-api-key" : "Authorization")
    : "Authorization";
  const headerName = normalizeString(auth.headerName) || defaultHeaderName;
  const prefix = typeof auth.prefix === "string" ? auth.prefix : 
    (headerName.toLowerCase() === "authorization" ? "Bearer " : undefined);

  return {
    name: headerName,
    value: prefix && prefix.length > 0 ? `${prefix}${secret}` : secret,
  };
}

type SSEParseResult = {
  event?: string | undefined;
  data?: string | undefined;
};

function parseSSELine(line: string): SSEParseResult {
  if (line.startsWith("event:")) {
    return { event: line.slice(6).trim() };
  }
  if (line.startsWith("data:")) {
    return { data: line.slice(5).trimStart() };
  }
  return {};
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  idleMs: number = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): AsyncGenerator<SSEParseResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;

  try {
    while (true) {
      // Guard against an upstream that goes silent without closing the
      // socket — readWithIdleTimeout rejects after `idleMs` of no data,
      // so the caller's network-error path (retry / fallback) kicks in
      // instead of hanging the leader loop forever.
      const { done, value } = await readWithIdleTimeout(reader, idleMs);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 1);

        if (line.trim() === "") {
          if (currentEvent !== undefined || buffer.length > 0) {
            yield { event: currentEvent };
            currentEvent = undefined;
          }
          continue;
        }

        const parsed = parseSSELine(line);
        if (parsed.event) {
          currentEvent = parsed.event;
        }
        if (parsed.data) {
          yield { event: currentEvent, data: parsed.data };
          currentEvent = undefined;
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      const parsed = parseSSELine(trailing);
      if (parsed.data) {
        yield { event: currentEvent, data: parsed.data };
      }
    }
  } finally {
    // Cancel (not just releaseLock) so an early break / idle-timeout closes
    // the underlying stream + socket promptly instead of lingering until
    // undici's keep-alive teardown reclaims it. cancel() also releases the
    // reader lock; fall back to releaseLock only if cancel rejects.
    try {
      await reader.cancel();
    } catch {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

type OpenAIStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    delta?: {
      content?: string;
      // Thinking-capable providers (DeepSeek-R1 / Kimi / GLM-thinking)
      // emit reasoning tokens BEFORE the answer text on this field.
      // Spec: docs/specs/2026-04-28-thinking-stream-spec.md §"Wire format".
      reasoning_content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  // OpenAI / OpenAI-compat may include cache fields. Different
  // gateways spell them differently — we accept all known forms.
  // - prompt_cache_hit_tokens / prompt_cache_miss_tokens (DeepSeek native)
  // - prompt_tokens_details.cached_tokens (OpenAI proper, also DashScope)
  // - cached_tokens at root (some early DashScope flavors)
  // - prompt_tokens_details.cache_read_input_tokens (Together / Fireworks variant)
  //
  // Index signature on usage so we can sniff unknown keys at runtime
  // (logUnknownUsageKeysOnce) without TS complaints. New providers that
  // ship odd field names will surface in the log instead of silently
  // landing as cache_read=0 like dashscope-coding deepseek-v4-pro did
  // before audit 2026-05-22.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_read_input_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    [unknownKey: string]: unknown;
  };
};

type AnthropicStreamEvent = {
  type: string;
  index?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

type TokenUsage = NormalizedTokenUsage;

type AccumulatedToolUse = {
  /**
   * Magister-canonical id. MINTED ONCE on creation (`tu_<random12>`), never
   * mutates afterward. This is the id that flows into the leader's
   * `messages` array, checkpoints, gates, doom-loop fingerprints, and
   * the wire format on the next API call. Globally unique across the
   * conversation lifetime by construction (each stream produces fresh
   * randoms, and the only place this id gets written is here).
   *
   * Fixes the kimi-k2.6 "<toolname>:<idx>" id-collision class of bugs
   * (commit `d3e28ad` shimmed at the wire boundary; this is the
   * fundamental fix). Codex review verdict: keep wire shim as
   * backward-compat for old checkpoints, store provider id alongside.
   */
  id: string;
  /**
   * The id the model emitted on the SSE stream (e.g. `grep:12` from
   * kimi, or a `toolu_*` UUID from Anthropic). Kept for incident
   * analysis only. Never used for routing/keying inside Magister.
   * Undefined when the model didn't supply one (rare — both dialects
   * always emit one in practice, but defensive).
   */
  providerId?: string;
  name: string;
  inputJson: string;
  started: boolean;
};

/** Mint a Magister-canonical tool_use id. ~72 bits of entropy in 12 chars
 *  is plenty for cross-conversation uniqueness; no need to thread
 *  task/turn ids through the parser to derive a deterministic form. */
function mintCanonicalToolUseId(): string {
  return `tu_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

type AccumulatedContent = {
  textContent: string;
  // Thinking / reasoning content streamed before the answer. Captured
  // separately so buildFinalContentBlocks can prepend a `thinking`
  // block to message_complete.content[] for checkpoint persistence.
  thinkingContent: string;
  toolUses: Map<number, AccumulatedToolUse>;
  nextBlockIndex: number;
};

const KNOWN_OPENAI_USAGE_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cached_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
]);
const loggedUnknownUsageSignatures = new Set<string>();

function logUnknownUsageKeysOnce(usage: Record<string, unknown>, model: string | undefined): void {
  const unknown = Object.keys(usage).filter((k) => !KNOWN_OPENAI_USAGE_KEYS.has(k));
  if (unknown.length === 0) return;
  const signature = `${model ?? "unknown-model"}|${unknown.slice().sort().join(",")}`;
  if (loggedUnknownUsageSignatures.has(signature)) return;
  loggedUnknownUsageSignatures.add(signature);
  console.warn(
    `[streaming-api] unknown usage keys from ${model ?? "<no-model>"}: ${unknown.join(", ")} — extend OpenAIStreamChunk + parseOpenAISSEChunk if any of these are cache stats`,
  );
}


function parseOpenAISSEChunk(
  chunk: OpenAIStreamChunk,
  accumulated: AccumulatedContent,
): { events: LeaderStreamEvent[]; isFinal: boolean; finishReason?: string; usage?: TokenUsage } {
  const events: LeaderStreamEvent[] = [];
  const usage = typeof chunk.usage === "object" && chunk.usage !== null
    ? (() => {
      logUnknownUsageKeysOnce(chunk.usage as Record<string, unknown>, chunk.model);
      return normalizeOpenAIChatUsage(chunk.usage);
    })()
    : undefined;
  const choice = chunk.choices?.[0];
  if (!choice) return { events, isFinal: false, ...(usage ? { usage } : {}) };

  const delta = choice.delta;
  if (delta) {
    // Thinking content from DeepSeek-R1 / Kimi / GLM-thinking style
    // streams. Emitted on `delta.reasoning_content` BEFORE the answer
    // text. We capture and forward as a separate stream event so the
    // frontend can render it in a collapsible "🤔 Thinking..." block.
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      accumulated.thinkingContent += delta.reasoning_content;
      events.push({ type: "thinking_delta", text: delta.reasoning_content });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      accumulated.textContent += delta.content;
      events.push({ type: "text_delta", text: delta.content });
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const toolCall of delta.tool_calls) {
        const toolIndex = typeof toolCall.index === "number" ? toolCall.index : accumulated.nextBlockIndex++;

        let existing = accumulated.toolUses.get(toolIndex);
        if (!existing) {
          // Canonical-id-at-ingest (codex review 2026-05-08): mint
          // ONCE here. The model's id (`toolCall.id`) goes to
          // providerId for debug only; it never participates in
          // routing inside Magister. This fixes the kimi-k2.6 cross-turn
          // collision class of bugs at the architectural level.
          existing = {
            id: mintCanonicalToolUseId(),
            ...(toolCall.id ? { providerId: toolCall.id } : {}),
            name: "",
            inputJson: "",
            started: false,
          };
          accumulated.toolUses.set(toolIndex, existing);
        } else if (!existing.providerId && toolCall.id) {
          // Provider id arrived in a later delta chunk. Capture it
          // for debug, but do NOT touch existing.id — canonical is
          // immutable once minted.
          existing.providerId = toolCall.id;
        }

        if (toolCall.function?.name) {
          existing.name = toolCall.function.name;
        }

        if (!existing.started && existing.name) {
          existing.started = true;
          events.push({ type: "tool_use_start", id: existing.id, name: existing.name });
        }

        if (toolCall.function?.arguments) {
          existing.inputJson += toolCall.function.arguments;
          events.push({
            type: "tool_use_delta",
            id: existing.id,
            partialJson: toolCall.function.arguments,
          });
        }
      }
    }
  }

  return {
    events,
    isFinal: Boolean(choice.finish_reason),
    ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseAnthropicSSEEvent(
  event: AnthropicStreamEvent,
  accumulated: AccumulatedContent,
): { events: LeaderStreamEvent[]; isFinal: boolean; stopReason?: string; usage?: TokenUsage } {
  const result: { events: LeaderStreamEvent[]; isFinal: boolean; stopReason?: string; usage?: TokenUsage } = {
    events: [],
    isFinal: false,
  };
  const eventUsage = event.usage ?? event.message?.usage;
  if (eventUsage) {
    const normalizedUsage = normalizeAnthropicUsage(eventUsage);
    if (normalizedUsage) result.usage = normalizedUsage;
  }

  switch (event.type) {
    case "content_block_delta":
      if (event.index === undefined) break;

      const delta = event.delta;
      if (delta?.type === "text_delta" && delta.text) {
        accumulated.textContent += delta.text;
        result.events.push({ type: "text_delta", text: delta.text });
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
        // Anthropic extended thinking emits these between
        // content_block_start (type:thinking) and the eventual
        // content_block_start (type:text). signature_delta still
        // falls through silently — it's metadata for redaction.
        accumulated.thinkingContent += delta.thinking;
        result.events.push({ type: "thinking_delta", text: delta.thinking });
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const toolIndex = event.index;
        let existing = accumulated.toolUses.get(toolIndex);
        if (!existing) {
          // Canonical-id-at-ingest. Anthropic stream usually opens
          // with content_block_start carrying the provider id, so
          // landing here without an existing entry is rare (would
          // mean input_json_delta arrived before content_block_start
          // — anomalous but defensive).
          existing = {
            id: mintCanonicalToolUseId(),
            name: "",
            inputJson: "",
            started: false,
          };
          accumulated.toolUses.set(toolIndex, existing);
        }
        existing.inputJson += delta.partial_json;
        result.events.push({
          type: "tool_use_delta",
          id: existing.id,
          partialJson: delta.partial_json,
        });
      }
      break;

    case "content_block_start":
      if (event.index === undefined || !event.content_block) break;

      if (event.content_block.type === "tool_use") {
        const existing = accumulated.toolUses.get(event.index);
        if (!existing) {
          // Canonical-id-at-ingest. Anthropic always sends id +
          // name on content_block_start, so the provider id capture
          // is straightforward.
          const created: AccumulatedToolUse = {
            id: mintCanonicalToolUseId(),
            ...(event.content_block.id ? { providerId: event.content_block.id } : {}),
            name: event.content_block.name ?? "",
            inputJson: "",
            started: false,
          };
          if (created.name) {
            created.started = true;
            result.events.push({ type: "tool_use_start", id: created.id, name: created.name });
          }
          accumulated.toolUses.set(event.index, created);
        } else {
          // Existing entry was created by a prior delta. Capture
          // provider id if it arrives now (and we haven't already);
          // canonical id stays put.
          if (!existing.providerId && event.content_block.id) {
            existing.providerId = event.content_block.id;
          }
          if (event.content_block.name) existing.name = event.content_block.name;
          if (!existing.started && existing.name) {
            existing.started = true;
            result.events.push({ type: "tool_use_start", id: existing.id, name: existing.name });
          }
        }
      }
      break;

    case "message_delta":
      if (event.delta?.stop_reason) {
        result.isFinal = true;
        result.stopReason = event.delta.stop_reason;
      }
      break;

    case "message_stop":
      result.isFinal = true;
      break;
  }

  return result;
}

function buildFinalContentBlocks(accumulated: AccumulatedContent): LeaderContentBlock[] {
  const blocks: LeaderContentBlock[] = [];

  // Thinking goes FIRST — it's what the model produced before the
  // answer. Persisting it on message_complete.content[] keeps it in
  // checkpoints so a snapshot replay reconstructs the same UI.
  if (accumulated.thinkingContent.trim()) {
    blocks.push({ type: "thinking", thinking: accumulated.thinkingContent.trim() });
  }

  if (accumulated.textContent.trim()) {
    blocks.push({ type: "text", text: accumulated.textContent.trim() });
  }

  for (const [, tool] of accumulated.toolUses) {
    if (tool.name) {
      // Carry providerToolUseId only when the model gave us one AND
      // it differs from canonical (always true now since canonical
      // is a freshly-minted `tu_…` and provider ids look different).
      // Surfaced here for incident analysis — tool-execution.ts and
      // build-task-tree-service.ts consume it for raw-provider
      // correlation.
      const providerHint = tool.providerId && tool.providerId !== tool.id
        ? { providerToolUseId: tool.providerId }
        : {};
      try {
        const input = JSON.parse(tool.inputJson);
        blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input, ...providerHint });
      } catch {
        blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: {}, ...providerHint });
      }
    }
  }

  return blocks;
}

export type StreamingApiCallerParams = {
  messages: LeaderMessage[];
  systemPrompt: string;
  model?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  tools?: readonly LeaderTool[];
};

/**
 * Replace `image` blocks with a text placeholder when the target
 * model has no `capabilityHints.vision` flag. Without this, every
 * Anthropic-compat shim that wraps a text-only backend (e.g. Bailian
 * `qwen3.7-max` at /apps/anthropic/v1/messages) rejects the request
 * with `Unexpected item type in content` the moment a screenshot or
 * other image-returning tool result lands in history.
 *
 * The OpenAI-compat plugin has its own image-flattening for
 * tool_result content (string-only role:"tool" content), but that
 * pass only fires inside the converter and doesn't cover user-uploaded
 * images either — this layer is the single gate that mirrors the
 * declared model capability into wire payload everywhere.
 *
 * Placeholder phrasing intentionally uses conditional surfacing ("only
 * if the current request depends on it") so that historical placeholders
 * accumulated from prior turns don't cause the model to spontaneously
 * lecture the user about vision limits on every reply.
 *
 * Per-attempt profile (PR2): each attempt candidate now carries its own
 * `modelProfile` so this function is always called with the correct
 * vision flag. The primary candidate uses `config.model`; each fallback
 * uses `config.fallbackModelProfile` (if supplied) or a synthesized
 * profile with the fallback model name and the primary's other fields.
 * See `StreamingApiCallerConfig.fallbackModelProfile`.
 */
function buildVisionElisionPlaceholder(modelName: string): string {
  return `[image unavailable: omitted because active model "${modelName}" has no vision capability. Do not infer visual details from this image; mention the limitation only if the current request depends on it.]`;
}

function stripImagesForNonVisionModel(
  messages: LeaderMessage[],
  model: ModelProfile,
): LeaderMessage[] {
  if (model.capabilityHints?.vision === true) return messages;
  const placeholder = buildVisionElisionPlaceholder(model.modelName);

  const sanitizeResultContent = (content: LeaderResultContent): LeaderResultContent | null => {
    if (typeof content === "string") return null;
    let changed = false;
    const out: LeaderResultBlock[] = content.map((block) => {
      if (block.type === "image") {
        changed = true;
        return { type: "text" as const, text: placeholder };
      }
      return block;
    });
    return changed ? out : null;
  };

  let mutated = false;
  const result: LeaderMessage[] = messages.map((m) => {
    if (m.type === "user") {
      if (typeof m.content === "string") return m;
      let changed = false;
      const newBlocks: LeaderContentBlock[] = m.content.map((b) => {
        if (b.type === "image") {
          changed = true;
          return { type: "text" as const, text: placeholder };
        }
        if (b.type === "tool_result") {
          const swapped = sanitizeResultContent(b.content);
          if (swapped) {
            changed = true;
            return { ...b, content: swapped };
          }
        }
        return b;
      });
      if (changed) {
        mutated = true;
        return { ...m, content: newBlocks };
      }
      return m;
    }
    if (m.type === "assistant") {
      // Defense-in-depth: the leader runtime today never produces
      // assistant-role image blocks (model output is text/thinking/
      // tool_use), but `LeaderContentBlock` permits it. If a future
      // path ever inlines images into assistant.content (e.g. echoing
      // user uploads), this catches them before they'd otherwise reach
      // anthropic-plugin.ts:215-240 / openai-compat-plugin.ts:105-119
      // and potentially become an empty assistant message.
      let changed = false;
      const newBlocks: LeaderContentBlock[] = m.content.map((b) => {
        if (b.type === "image") {
          changed = true;
          return { type: "text" as const, text: placeholder };
        }
        return b;
      });
      if (changed) {
        mutated = true;
        return { ...m, content: newBlocks };
      }
      return m;
    }
    if (m.type === "tool_result") {
      const swapped = sanitizeResultContent(m.content);
      if (swapped) {
        mutated = true;
        return { ...m, content: swapped };
      }
      return m;
    }
    return m;
  });

  return mutated ? result : messages;
}

export type StreamingApiCallerConfig = {
  provider: ProviderConfig;
  model: ModelProfile;
  binding: ExecutorBinding;
  env?: NodeJS.ProcessEnv;
  // Cross-provider fallback. When set, `model.fallbacks`
  // entries are dispatched to THIS provider (different baseUrl + auth +
  // dialect + plugin) instead of the primary. Without this, fallback
  // candidates always inherit the primary's baseUrl, so a leader
  // configured with provider=DeepSeek + fallback=kimi-k2.6-ark would
  // try to POST kimi-k2.6-ark to api.deepseek.com → 404. Codex review
  // of 7b80495 (BLOCKER) flagged this; the agent_profiles
  // `fallback_provider_id` column had been resolved by
  // agent-resolution-service but the caller dropped it on the floor.
  fallbackProvider?: ProviderConfig;
  // Per-fallback ModelProfile (PR2). When the fallback model has
  // different capabilities from the primary (e.g. a text-only
  // Bailian/qwen shim used as fallback while the primary is vision-
  // capable), supply the full profile here so the attempt uses the
  // correct capabilityHints.vision flag for image stripping and the
  // correct maxOutputTokens / requestOverrides for buildRequestBody.
  //
  // When omitted, the fallback attempt synthesizes a profile from the
  // primary with only `modelName` swapped — preserving the legacy
  // same-profile behavior. That is safe when primary and fallback are
  // genuinely equivalent except for the model name, but will silently
  // send images to a text-only fallback if the primary is vision-
  // capable. Callers that know the fallback profile SHOULD supply it.
  fallbackModelProfile?: ModelProfile;
};

// Per-attempt context. Everything that depends on the
// PROVIDER + MODEL-PROFILE chosen for an attempt lives here, so a
// fallback to a different provider (or a fallback that differs in
// vision capability) can rebuild baseUrl / auth / headers / plugin /
// converted-messages instead of inheriting the primary's. Built lazily
// and cached by (provider.id + vision-flag), since the dialect-specific
// plugin.convertMessages is the only expensive bit and is idempotent
// within a single call.
type AttemptContext = {
  provider: ProviderConfig;
  baseUrl: string;
  plugin: ProviderPlugin;
  headers: Headers;
  convertedMessages: ReturnType<ProviderPlugin["convertMessages"]>["messages"];
  convertedSystem: string | undefined;
  convertedTools: ReturnType<ProviderPlugin["convertTools"]> | undefined;
};

export async function* callStreamingApi(
  params: StreamingApiCallerParams,
  config: StreamingApiCallerConfig,
): AsyncGenerator<LeaderStreamEvent> {
  const env = config.env ?? process.env;
  const effectiveModel = params.model ?? config.model.modelName;

  const contextCache = new Map<string, AttemptContext>();
  const buildAttemptContext = (provider: ProviderConfig, modelName: string, modelProfile: ModelProfile): AttemptContext => {
    // Cache key incorporates vision capability (converted messages differ
    // when images are stripped vs kept) AND modelName: provider headers can
    // be built per model via `whenModelPattern`, so two attempts on the same
    // provider but different models must NOT share a context (a same-provider
    // fallback would otherwise reuse the primary model's headers).
    const visionFlag = modelProfile.capabilityHints?.vision === true;
    const cacheKey = `${provider.id}::model=${modelName}::vision=${String(visionFlag)}`;
    const cached = contextCache.get(cacheKey);
    if (cached) return cached;

    const baseUrl = normalizeString(provider.baseUrl);
    if (!baseUrl) {
      throw new Error(`Provider ${provider.id} is missing a baseUrl`);
    }
    const plugin = resolveProviderPlugin(provider.apiDialect);
    if (!plugin) {
      const supportedDialects = getSupportedDialects().join(", ");
      throw new Error(
        `Unsupported API dialect "${provider.apiDialect}" — no provider plugin registered. Supported: ${supportedDialects}`,
      );
    }
    const authHeader = resolveAuthHeader(provider.auth, env, provider.apiDialect);
    if (provider.auth.kind !== "none" && !authHeader) {
      const secretRef = provider.auth.kind === "chatgpt_session" ? "OPENAI_API_KEY" : provider.auth.secretRef;
      throw new Error(`Provider ${provider.id} is missing secretRef ${secretRef}`);
    }

    const headers = new Headers({ "content-type": "application/json" });
    // Force uncompressed SSE so reasoning_content tokens stream as the
    // server flushes them, instead of being held by a gzip block.
    headers.set("accept-encoding", "identity");
    if (provider.apiDialect === "anthropic_messages") {
      headers.set("anthropic-version", "2023-06-01");
    }
    if (authHeader) {
      headers.set(authHeader.name, authHeader.value);
    }
    for (const header of provider.headers ?? []) {
      if (header.whenDialect?.length && !header.whenDialect.includes(provider.apiDialect)) continue;
      if (header.whenModelPattern?.length && !header.whenModelPattern.some((pattern) => modelName.includes(pattern))) continue;
      const value = resolveHeaderValue(header, env);
      if (value) headers.set(header.name, value);
    }

    // PR2: use the per-attempt modelProfile for vision filtering so a
    // text-only fallback doesn't inherit the primary's vision=true flag.
    const visionFilteredMessages = stripImagesForNonVisionModel(params.messages, modelProfile);
    const replayMessages = plugin.sanitizeReplayHistory
      ? plugin.sanitizeReplayHistory(visionFilteredMessages)
      : visionFilteredMessages;
    const { messages: convertedMessages, system: convertedSystem } = plugin.convertMessages(
      replayMessages,
      params.systemPrompt,
    );
    const convertedTools = params.tools?.length ? plugin.convertTools(params.tools) : undefined;

    const ctx: AttemptContext = {
      provider,
      baseUrl,
      plugin,
      headers,
      convertedMessages,
      convertedSystem,
      convertedTools,
    };
    contextCache.set(cacheKey, ctx);
    return ctx;
  };

  // Build the attempt sequence. Primary candidate uses config.provider
  // and config.model. Each fallback candidate uses config.fallbackProvider
  // (if set, else the primary provider) and a per-fallback ModelProfile.
  //
  // Per-fallback profile resolution (PR2):
  //   1. If config.fallbackModelProfile is set, every fallback in the
  //      chain uses it (single-fallback design — the common case).
  //   2. Otherwise, synthesize a profile from the primary with only
  //      `modelName` swapped. This preserves legacy same-profile
  //      behavior but will silently send images to a text-only fallback
  //      if the primary is vision-capable. Callers that know the fallback
  //      differs SHOULD supply fallbackModelProfile.
  type AttemptCandidate = { modelName: string; provider: ProviderConfig; modelProfile: ModelProfile };
  const fallbackProvider = config.fallbackProvider ?? config.provider;
  const candidates: AttemptCandidate[] = [];
  const seen = new Set<string>();
  const pushCandidate = (modelName: string, provider: ProviderConfig, modelProfile: ModelProfile) => {
    const trimmed = modelName.trim();
    if (!trimmed) return;
    const key = `${provider.id}::${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ modelName: trimmed, provider, modelProfile });
  };
  pushCandidate(effectiveModel, config.provider, config.model);
  for (const fallback of config.model.fallbacks ?? []) {
    // Resolve per-fallback profile: explicit > synthesized-from-primary.
    const fallbackProfile: ModelProfile = config.fallbackModelProfile
      ? { ...config.fallbackModelProfile, modelName: config.fallbackModelProfile.modelName || fallback }
      : { ...config.model, modelName: fallback };
    pushCandidate(fallback, fallbackProvider, fallbackProfile);
  }

  let response: Response | undefined;
  let lastErrorMessage: string | undefined;
  let lastErrorDetail: { status: number; provider: string; model: string; body: string } | undefined;
  let chosenModel: string | undefined;
  let chosenContext: AttemptContext | undefined;
  let lastProviderId = config.provider.id;
  let lastHeaders: Headers | undefined;
  let lastUrl: string | undefined;
  let lastSerializedBody: string | undefined;
  for (let attemptIndex = 0; attemptIndex < candidates.length; attemptIndex += 1) {
    const candidate = candidates[attemptIndex];
    if (!candidate) {
      continue;
    }
    const { modelName, provider, modelProfile: candidateProfile } = candidate;
    const providerId = provider.id;
    lastProviderId = providerId;
    let ctx: AttemptContext;
    try {
      ctx = buildAttemptContext(provider, modelName, candidateProfile);
    } catch (cause) {
      lastErrorMessage = cause instanceof Error ? cause.message : String(cause);
      console.warn(`[streaming-api] attempt-context build failed for ${providerId}: ${lastErrorMessage}`);
      response = undefined;
      continue;
    }
    chosenModel = modelName;
    chosenContext = ctx;
    const requestPath = ctx.plugin.resolveRequestPath(ctx.baseUrl, modelName);
    const url = new URL(requestPath.replace(/^\//, ""), normalizeBaseUrl(ctx.baseUrl)).toString();
    lastUrl = url;
    lastHeaders = ctx.headers;
    const body = ctx.plugin.buildRequestBody({
      messages: ctx.convertedMessages,
      systemPrompt: ctx.convertedSystem ?? params.systemPrompt,
      model: modelName,
      ...(ctx.convertedTools?.length ? { tools: ctx.convertedTools } : {}),
      ...(typeof params.maxOutputTokens === "number" ? { maxOutputTokens: params.maxOutputTokens } : {}),
      provider,
      // PR2: use the per-attempt profile so maxOutputTokens,
      // requestOverrides, and capabilityHints come from the correct
      // model rather than always using the primary's profile.
      modelProfile: candidateProfile,
    });
    const serializedBody = JSON.stringify(body);
    lastSerializedBody = serializedBody;

    // P2 — retry loop for THIS model. On retryable error we wait
    // (honoring Retry-After when present, exp-backoff with full
    // jitter otherwise) and re-attempt. Non-retryable errors break
    // out of retry and fall through to model fallback below.
    let retryableExhausted = false;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: ctx.headers,
          body: serializedBody,
          signal: params.signal ?? null,
        });
      } catch (cause) {
        if ((cause as { name?: string }).name === "AbortError" || params.signal?.aborted) {
          throw cause;
        }
        lastErrorMessage = cause instanceof Error ? cause.message : String(cause);
        response = undefined;
        // Network errors are retryable. Sleep then retry.
        if (retry < MAX_RETRIES) {
          const wait = computeBackoffMs(retry, null);
          console.warn(
            `[streaming-api] network error on ${providerId}/${modelName} (attempt ${retry + 1}/${MAX_RETRIES + 1}), retrying in ${wait}ms: ${lastErrorMessage}`,
          );
          try {
            await sleep(wait, params.signal ?? null);
          } catch (sleepErr) {
            // Kimi review M — distinguish user cancellation from
            // network failure. Re-throw the AbortError from sleep
            // (rather than the original fetch error) so callers can
            // tell "you cancelled" from "network drop".
            if (params.signal?.aborted) throw sleepErr;
            throw cause;
          }
          continue;
        }
        retryableExhausted = true;
        break;
      }

      if (response.ok) break; // success path

      if (!isRetryableStatus(response.status)) {
        // Non-retryable (auth, malformed body, model-not-found, etc.).
        // Break out of retry loop; will fall through to model fallback.
        break;
      }

      // Retryable error → wait, retry. peek at Retry-After before
      // we drain the body (which we'd need to do anyway for error
      // logging on the FINAL failure).
      const retryAfter = response.headers.get("retry-after");
      if (retry < MAX_RETRIES) {
        const wait = computeBackoffMs(retry, retryAfter);
        console.warn(
          `[streaming-api] ${response.status} on ${providerId}/${modelName} (attempt ${retry + 1}/${MAX_RETRIES + 1}), retrying in ${wait}ms${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`,
        );
        // Drain body to release the connection; we don't need it
        // unless this is the final attempt.
        await response.text().catch(() => "");
        try {
          await sleep(wait, params.signal ?? null);
        } catch (cause) {
          throw cause; // aborted while sleeping
        }
        continue;
      }
      retryableExhausted = true;
    }
    // Marker so the outer block can distinguish "retryable but
    // exhausted" (will appear as a non-OK response below) from
    // "non-retryable" (also non-OK below) — same downstream behavior
    // (fall through to next model), so we don't need to branch.
    void retryableExhausted;

    if (response?.ok) {
      break;
    }

    if (response && !response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorMessage = `API request failed with status ${response.status}`;
      try {
        const errorBody = JSON.parse(errorText) as { error?: unknown; message?: unknown };
        if (errorBody.error) {
          errorMessage = typeof errorBody.error === "string"
            ? errorBody.error
            : typeof errorBody.error === "object" && errorBody.error !== null && "message" in errorBody.error
              ? String((errorBody.error as { message: unknown }).message)
              : JSON.stringify(errorBody.error);
        } else if (errorBody.message) {
          errorMessage = String(errorBody.message);
        }
      } catch {
        if (errorText) errorMessage = errorText;
      }
      lastErrorMessage = errorMessage;

      // Structured error detail for the model_error event (observability):
      // capture status + provider + a small (2KB) slice of the upstream body
      // so downstream records WHY it failed without re-reading stderr dumps.
      const EVENT_BODY_CAP = 2_000;
      const eventBody = errorText.length > EVENT_BODY_CAP
        ? errorText.slice(0, EVENT_BODY_CAP) + `... (truncated ${errorText.length - EVENT_BODY_CAP} bytes)`
        : errorText;
      lastErrorDetail = {
        status: response.status,
        provider: providerId,
        model: modelName,
        body: eventBody,
      };

      // Dump request/response context to stderr so backend-side debugging can
      // figure out *which parameter* upstream rejected. Auth header is
      // stripped. Payload is truncated to keep the log bounded — but big
      // enough now to fit a typical multi-turn conversation (was 8KB which
      // dropped the tail of any ~15+ tool_result history).
      const MAX_DUMP = 200_000;
      const bodyTruncated = serializedBody.length > MAX_DUMP
        ? serializedBody.slice(0, MAX_DUMP) + `... (truncated ${serializedBody.length - MAX_DUMP} bytes)`
        : serializedBody;
      const errTextTruncated = errorText.length > MAX_DUMP
        ? errorText.slice(0, MAX_DUMP) + `... (truncated ${errorText.length - MAX_DUMP} bytes)`
        : errorText;
      const safeHeaders: Record<string, string> = {};
      for (const [k, v] of ctx.headers.entries()) {
        if (/^(authorization|x-api-key|api-key|cookie)$/i.test(k)) continue;
        safeHeaders[k] = v;
      }
      console.error(
        "[streaming-api:error-dump]",
        JSON.stringify({
          provider: providerId,
          model: modelName,
          url,
          status: response.status,
          errorMessage,
          responseBody: errTextTruncated,
          requestHeaders: safeHeaders,
          requestBody: bodyTruncated,
        }, null, 2),
      );

      if (response.status === 400) {
        yield {
          type: "message_complete",
          content: [{ type: "text", text: errorMessage }],
          isError: true,
          ...(chosenModel ? { model: chosenModel } : {}),
          provider: providerId,
          ...(lastErrorDetail ? { errorDetail: lastErrorDetail } : {}),
        };
        return;
      }
    }

    if (attemptIndex < candidates.length - 1) {
      const next = candidates[attemptIndex + 1];
      if (next) {
        console.warn(
          `[streaming-api] Primary attempt failed (${providerId}/${modelName}), trying fallback: ${next.provider.id}/${next.modelName}`,
        );
      }
    }
  }
  void lastHeaders;
  void lastUrl;
  void lastSerializedBody;

  if (!response?.ok) {
    yield {
      type: "message_complete",
      content: [{ type: "text", text: lastErrorMessage ?? "API request failed" }],
      isError: true,
      ...(chosenModel ? { model: chosenModel } : {}),
      provider: lastProviderId,
      ...(lastErrorDetail ? { errorDetail: lastErrorDetail } : {}),
    };
    return;
  }

  if (!response.body) {
    yield {
      type: "message_complete",
      content: [{ type: "text", text: "No response body" }],
      ...(chosenModel ? { model: chosenModel } : {}),
      provider: lastProviderId,
    };
    return;
  }

  const accumulated: AccumulatedContent = {
    textContent: "",
    thinkingContent: "",
    toolUses: new Map(),
    nextBlockIndex: 0,
  };

  // Stream parsing follows the SUCCESSFUL attempt's dialect, not the
  // primary provider's, since cross-provider fallback may have switched
  // anthropic_messages → openai_chat_completions (or vice versa).
  const winningProvider = chosenContext?.provider ?? config.provider;
  const isAnthropic = winningProvider.apiDialect === "anthropic_messages";
  let usage: TokenUsage | undefined;
  let openAiReceivedFinal = false;
  // PR(truncated-toolcall) #2 — the dialect's terminal stop signal,
  // captured so the finalize region can distinguish a CLEAN completion
  // (end_turn / tool_use / stop / tool_calls) from an OUTPUT-token
  // TRUNCATION (anthropic stop_reason "max_tokens"; openai
  // finish_reason "length"). A truncated stop while a tool_use block is
  // still open means the args JSON is incomplete and must NOT be
  // finalized as a real tool call — see the guard below.
  let terminalStopReason: string | undefined;
  // PR1 — checkpoint-poisoning guard. Set to true ONLY when the
  // dialect's real terminal marker is processed:
  //   - OpenAI:    `[DONE]` sentinel (the unconditional `break` below)
  //   - Anthropic: `message_stop` / `message_delta{stop_reason}` sets
  //                `isFinal = true` → the `if (isFinal) break` path
  // If the TCP connection drops (EOF) BEFORE the terminal marker, the
  // for-await loop exits with sawTerminal=false. Any tool_use block
  // that was mid-stream at that point has malformed/partial JSON and
  // must NOT be finalized as a real tool call — doing so checkpoints a
  // poisoned tool_use and sends it into the leader loop.
  let sawTerminal = false;

  try {
    for await (const sse of parseSSEStream(response.body)) {
      if (sse.data === "[DONE]") {
        // OpenAI terminal marker — the loop exits cleanly.
        sawTerminal = true;
        break;
      }
      if (!sse.data) continue;

      let data: unknown;
      try {
        data = JSON.parse(sse.data);
      } catch {
        continue;
      }

      if (isAnthropic) {
        const event = data as AnthropicStreamEvent;
        const { events, isFinal, stopReason, usage: parsedUsage } = parseAnthropicSSEEvent(event, accumulated);
        if (parsedUsage) {
          usage = mergeAnthropicTokenUsage(usage, parsedUsage);
        }
        // Capture stop_reason whenever it arrives (message_delta carries
        // it; message_stop does not). Don't clobber a previously-seen
        // value with a later undefined.
        if (stopReason) terminalStopReason = stopReason;
        for (const streamEvent of events) {
          yield streamEvent;
        }
        if (isFinal) {
          // Anthropic terminal marker (`message_stop` / `message_delta`
          // with stop_reason) — loop exits cleanly.
          sawTerminal = true;
          break;
        }
      } else {
        const chunk = data as OpenAIStreamChunk;
        const { events, isFinal, finishReason, usage: parsedUsage } = parseOpenAISSEChunk(chunk, accumulated);
        if (parsedUsage) {
          usage = parsedUsage;
        }
        if (finishReason) terminalStopReason = finishReason;
        for (const streamEvent of events) {
          yield streamEvent;
        }
        if (isFinal) {
          openAiReceivedFinal = true;
          // `finish_reason` IS the OpenAI dialect's terminal signal: it
          // guarantees the model finished emitting (incl. complete
          // tool_call args). `[DONE]` is only a transport sentinel. We
          // must mark the stream terminated HERE — otherwise the common
          // sequence `finish_reason → usage chunk → [DONE]` breaks on the
          // usage chunk below (before [DONE] is read), leaving
          // sawTerminal=false and tripping the PR1 truncation guard as a
          // false positive on a cleanly-completed tool call.
          sawTerminal = true;
          if (usage) {
            break;
          }
        } else if (openAiReceivedFinal && usage) {
          break;
        }
      }
    }
  } catch (cause) {
    throw cause;
  }

  // PR1 — guard against checkpoint poisoning via a partial tool call.
  // If the stream closed before the dialect's terminal event AND there
  // are any tool_use blocks in the accumulator (which means at minimum
  // a tool_use_start was emitted, so the tool block was mid-stream),
  // do NOT finalize them as real tool calls. Emit an error result so
  // the leader loop treats this as a recoverable model error and
  // retries, rather than checkpointing a poisoned `input: {}` call.
  //
  // Condition: !sawTerminal && accumulated.toolUses.size > 0
  //
  // Text-only truncation (no tool block) is left as-is: the text
  // blocks emitted so far are safe to deliver (partial text is
  // recoverable on the user side), and preventing it would be a larger
  // change requiring text truncation detection logic.
  if (!sawTerminal && accumulated.toolUses.size > 0) {
    console.warn(
      `[streaming-api] stream closed before terminal event with ${accumulated.toolUses.size} open tool_use block(s) — rejecting as error to prevent partial-tool checkpoint`,
      { provider: winningProvider.id, model: chosenModel },
    );
    yield {
      type: "message_complete",
      content: [{ type: "text", text: "stream closed before terminal event" }],
      isError: true,
      ...(chosenModel ? { model: chosenModel } : {}),
      provider: winningProvider.id,
    };
    return;
  }

  // PR(truncated-toolcall) #2 — guard against an OUTPUT-token-truncated
  // tool call. Unlike PR1 (EOF BEFORE the terminal event), here the
  // stream DID end with a proper terminal event, but the dialect stop
  // signal indicates the model hit its output token limit mid-emission:
  //   - Anthropic: stop_reason === "max_tokens"
  //   - OpenAI:    finish_reason === "length"
  // If a tool_use block is open at that point (toolUses.size > 0), its
  // arguments JSON is incomplete (e.g. a spawn_teammate call cut off
  // before the required `goal` field). Finalizing it would checkpoint a
  // partial tool call → InputValidationError → the model re-emits the
  // SAME huge call → re-truncates → doom-loop. Instead, emit an isError
  // message_complete (same shape PR1 uses) that the leader loop treats
  // as a recoverable model error, with a message steering the model to
  // retry with a SHORTER call.
  //
  // Scoped narrowly: ONLY when the stop signal is a truncation marker
  // AND a tool block is open. A clean stop (end_turn / tool_use / stop /
  // tool_calls) with a complete tool call is untouched, so this cannot
  // false-positive on a legitimate tool call that merely coincides with
  // a tool-use terminal. Text-only truncation (no tool block) is also
  // left as-is — partial text is recoverable on the user side.
  const isTruncatedStop = terminalStopReason === "max_tokens" || terminalStopReason === "length";
  if (isTruncatedStop && accumulated.toolUses.size > 0) {
    console.warn(
      `[streaming-api] terminal stop "${terminalStopReason}" with ${accumulated.toolUses.size} open tool_use block(s) — output token limit hit mid tool call; rejecting as error to prevent partial-tool checkpoint + doom loop`,
      { provider: winningProvider.id, model: chosenModel },
    );
    yield {
      type: "message_complete",
      content: [
        {
          type: "text",
          text:
            "tool call truncated: the response hit the output token limit before the tool call was complete (the arguments JSON is incomplete). Retry with a shorter tool call — shorten large optional fields and keep the required fields.",
        },
      ],
      isError: true,
      ...(chosenModel ? { model: chosenModel } : {}),
      provider: winningProvider.id,
    };
    return;
  }

  // PR(truncated-toolcall) #3 — finish-reason-AGNOSTIC incomplete-args guard.
  // The #2 guard above only fires on an explicit truncation stop signal
  // (max_tokens/length). But some models (observed: kimi-k2.6 on
  // volcengine-ark) cut a tool call's arguments short for a LARGE arg
  // (e.g. spawn_teammate's huge `goal`) and end the stream with a NORMAL
  // stop signal — emitting only `{"role":"coder"` worth of args. That
  // incomplete JSON falls through to buildFinalContentBlocks, where the
  // `JSON.parse` catch SILENTLY coerces it to `input: {}` — an empty tool
  // call → InputValidationError → the model re-emits the same call → it
  // re-truncates identically → doom-loop ("参数被吃掉了").
  //
  // Catch it here: any accumulated tool_use whose args text is NON-EMPTY
  // but does NOT parse as JSON is a truncated/incomplete call. Emit an
  // isError message_complete (recoverable) instead of a poisoned input:{}.
  // A no-arg tool (inputJson "" or "{}") parses or is empty → not caught;
  // a complete call parses → not caught. So this can't false-positive on a
  // legitimate call.
  const incompleteToolNames: string[] = [];
  for (const [, tool] of accumulated.toolUses) {
    if (!tool.name) continue;
    const argsText = tool.inputJson.trim();
    if (argsText.length === 0) continue;
    try {
      JSON.parse(argsText);
    } catch {
      incompleteToolNames.push(tool.name);
    }
  }
  if (incompleteToolNames.length > 0) {
    console.warn(
      `[streaming-api] incomplete/unparseable tool_use arguments (truncated mid-JSON) for [${incompleteToolNames.join(", ")}] with terminal stop "${terminalStopReason ?? "n/a"}" — rejecting as error to prevent an empty-args (input:{}) checkpoint + doom loop`,
      { provider: winningProvider.id, model: chosenModel },
    );
    yield {
      type: "message_complete",
      content: [
        {
          type: "text",
          text:
            `tool call incomplete: the arguments for ${incompleteToolNames.join(", ")} were cut off before the JSON finished, so no usable arguments were received. This usually means the call was too large to emit in one response. Re-send the call with COMPLETE, valid arguments — if a field (e.g. a teammate "goal") is very large, make it more concise rather than pasting huge context.`,
        },
      ],
      isError: true,
      ...(chosenModel ? { model: chosenModel } : {}),
      provider: winningProvider.id,
    };
    return;
  }

  const finalBlocks = buildFinalContentBlocks(accumulated);
  yield {
    type: "message_complete",
    content: finalBlocks,
    ...(usage ? { usage } : {}),
    ...(chosenModel ? { model: chosenModel } : {}),
    provider: winningProvider.id,
  };
}
