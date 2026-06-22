import { z } from "zod";

import { buildReasoningPatch } from "../reasoning-patch";
import type { ProviderPlugin } from "../provider-plugin";
import type { LeaderMessage, LeaderResultContent } from "../../services/manager-automation/autonomous-loop/autonomous-types";

/**
 * Spec §2 — OpenAI-compat dialect's tool message accepts only
 * `content: string`. When the leader emits an array-shaped tool
 * result (text + image blocks), flatten:
 *   - text blocks join with `\n`
 *   - image blocks become `[image elided: <mime>, <size> chars
 *     base64 — provider X does not support tool_result image blocks]`
 *     so the model knows an image WAS returned but can't see it.
 *
 * Per-dialect upgrade path: when a specific provider (DashScope,
 * kimi-vl, etc.) is confirmed to support native image-in-tool
 * message via the Responses API, set its plugin's
 * `supportsToolResultImageBlocks: true` and emit the native
 * `[{type:"input_text",...},{type:"input_image",...}]` shape
 * instead. Until verified, the placeholder is the safe default.
 */
function flattenToolResultContentForOpenAI(content: LeaderResultContent): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      // image: ~1.34× base64-overhead vs raw bytes; approximate the
      // raw size for the placeholder so a careful reader can gauge
      // what was elided without exposing the full payload.
      const approxBytes = Math.floor((block.data.length * 3) / 4);
      const sizeLabel = approxBytes > 1024 * 1024
        ? `${(approxBytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.ceil(approxBytes / 1024)} KB`;
      return `[image elided: ${block.mediaType}, ${sizeLabel} — provider does not support tool_result image blocks]`;
    })
    .join("\n");
}

// OpenAI Chat Completions multi-part user content: text + image_url
// blocks live side-by-side in an array. We only construct it when
// the leader message actually has an image; pure-text messages keep
// the simpler `content: "string"` shape so downstream tool-pair
// validators (`pairOpenAIToolMessages`) and providers that are
// strict about content shape don't have to special-case the array
// form for every message.
type OpenAIUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIUserContentPart[] | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function convertLeaderMessageToOpenAI(message: LeaderMessage): OpenAIMessage[] {
  switch (message.type) {
    case "user": {
      const results: OpenAIMessage[] = [];
      if (typeof message.content === "string") {
        return [{ role: "user", content: message.content }];
      }
      // Block-form user message. Translate text + image into
      // OpenAI's multi-part content array; route any inline
      // tool_result blocks (rare — leader typically emits
      // tool_result as its own LeaderToolResultMessage) to a
      // separate `role: "tool"` message since OpenAI's user
      // message can't carry tool_call_id.
      const userParts: OpenAIUserContentPart[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) {
          userParts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          // Embed as data: URL — OpenAI Chat Completions / qwen /
          // kimi all accept the same format. Vendors that don't
          // support vision will reject this with a 400 from their
          // own validator; we let that bubble rather than silently
          // dropping the image.
          userParts.push({
            type: "image_url",
            image_url: { url: `data:${block.mediaType};base64,${block.data}` },
          });
        }
      }
      if (userParts.length === 1 && userParts[0]?.type === "text") {
        // Single-text-block user message: keep the simple string
        // form for compatibility with strict providers.
        results.push({ role: "user", content: userParts[0].text });
      } else if (userParts.length > 0) {
        results.push({ role: "user", content: userParts });
      }
      for (const block of message.content) {
        if (block.type === "tool_result") {
          results.push({
            role: "tool",
            content: flattenToolResultContentForOpenAI(block.content),
            tool_call_id: block.tool_use_id,
          });
        }
      }
      return results;
    }
    case "assistant": {
      const textBlocks = message.content.filter((block) => block.type === "text");
      const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
      const thinkingBlocks = message.content.filter((block) => block.type === "thinking");

      // Cross-dialect replay: when an Anthropic-recorded turn produced
      // ONLY a thinking block (no text, no tool_use) and is being
      // replayed under OpenAI-compat, the older path returned [] and
      // the entire message vanished from history. That left any
      // subsequent tool_use → tool_result pairing dangling, since
      // openai-compat's strict adjacency requires the assistant turn
      // to precede its tool messages.
      //
      // Flatten thinking blocks into a synthesized text content ONLY
      // in the no-tool branch (the broken case). For tool_use turns
      // we keep `content: null` — OpenAI proper accepts it cleanly,
      // and replaying internal reasoning alongside live tool_calls
      // risks the next-turn model treating its own past reasoning as
      // imperative speech (a real prompt-injection vector flagged by
      // deepseek review). Volcengine's null-rejection quirk should be
      // handled per-vendor, not by globally injecting reasoning.
      //
      // Escape `]` in the thinking text so it can't terminate our
      // wrapper framing and bleed instructions out into the assistant
      // slot. Also strip leading/trailing brackets that would close
      // the marker prematurely.
      const escapeForMarker = (raw: string): string =>
        raw.replace(/\]/g, "⟧").replace(/\[/g, "⟦");
      const flattenThinking = (): string =>
        thinkingBlocks
          .map((b) => (b as { type: "thinking"; thinking: string }).thinking.trim())
          .filter(Boolean)
          .map((t) => `[Earlier reasoning from Anthropic turn: ${escapeForMarker(t)}]`)
          .join("\n\n");

      if (toolUseBlocks.length === 0) {
        const text = textBlocks.map((block) => block.text).join("\n");
        if (text) return [{ role: "assistant", content: text }];
        const flattened = flattenThinking();
        if (flattened) return [{ role: "assistant", content: flattened }];
        // Truly empty assistant turn — defensive drop. Some
        // OpenAI-compat providers reject `content: ""` with 400.
        return [];
      }

      // tool_use present: keep textContent as text-only or null. OpenAI
      // proper accepts `null + tool_calls` cleanly. Do NOT inject
      // flattened thinking here — it would put reasoning text into a
      // turn that should be a pure tool-call carrier.
      const textContent = textBlocks.map((b) => b.text).join("\n") || null;
      const toolCalls = toolUseBlocks.map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
      return [{ role: "assistant", content: textContent, tool_calls: toolCalls }];
    }
    case "tool_result":
      return [
        {
          role: "tool",
          content: flattenToolResultContentForOpenAI(message.content),
          tool_call_id: message.toolUseId,
        },
      ];
    default:
      return [];
  }
}

/**
 * Walk the converted message stream and (1) collect tool_call_ids that have
 * a corresponding `role: "tool"` message somewhere later, then (2) emit
 * paired pairs IN ADJACENCY ORDER. OpenAI / Volcengine spec requires
 * `role: "tool"` messages to immediately follow the assistant message that
 * declared their `tool_calls` — any interleaved user/assistant message
 * makes the API return `InvalidParameter`.
 *
 * Real failure mode: a user message queued between the assistant's
 * `tool_calls` checkpoint and the eventual tool_results, producing
 *   assistant(tool_calls) → user → tool result → tool result
 * which violates the spec. The fix below promotes tool messages to
 * immediately follow their declaring assistant, regardless of original
 * index — the user message still lands, but AFTER the spec-required pairs.
 *
 * Drops orphan tool messages and trims unanswered tool_calls from
 * assistant messages as before. Preserves user / system / plain-text
 * assistant messages unchanged in their relative order to each other.
 */
export function pairOpenAIToolMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  // Pre-pass — rewrite COLLIDING tool_call_ids. Legacy backward-compat
  // shim: new writes mint unique `tu_<random12>` ids at ingest, but old
  // checkpoints/mailbox payloads may still carry colliding predictable
  // per-tool-name counters (e.g. `grep:12`) that recur across turns.
  // Keep this for at least one full retention window.
  //
  // Strategy: on encountering a tool_call_id seen as declared+answered
  // before, rewrite it and its matching tool message id to a unique form
  // (`<orig>__r<n>`). First-seen pair stays untouched.
  const idOccurrenceCount = new Map<string, number>();
  // First pass: count occurrences of tool_call_ids in assistants.
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        idOccurrenceCount.set(tc.id, (idOccurrenceCount.get(tc.id) ?? 0) + 1);
      }
    }
  }
  // Second pass: walk in order, rewrite duplicates. Each
  // (originalId → newId) mapping is keyed by occurrence index so the
  // tool_result that comes AFTER the assistant gets the same rewrite.
  // We track per-id seen count and assign suffix accordingly.
  const seenCount = new Map<string, number>();
  const pendingRewrites: Map<string, string> = new Map(); // pending rewrite for next tool message of original id
  const rewritten: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      const newCalls = m.tool_calls.map((tc) => {
        const seen = seenCount.get(tc.id) ?? 0;
        seenCount.set(tc.id, seen + 1);
        if (seen === 0) {
          // First occurrence — keep original id.
          // Drain any stale pending rewrite for this id (covers an
          // odd ordering where a tool message was already consumed
          // by a prior turn before we got here).
          pendingRewrites.delete(tc.id);
          return tc;
        }
        const newId = `${tc.id}__r${seen}`;
        // Stash so the next tool message that arrives with the
        // original id can be rewritten to match.
        pendingRewrites.set(tc.id, newId);
        return { ...tc, id: newId };
      });
      rewritten.push({ ...m, tool_calls: newCalls });
      continue;
    }
    if (m.role === "tool" && m.tool_call_id) {
      const pending = pendingRewrites.get(m.tool_call_id);
      if (pending) {
        rewritten.push({ ...m, tool_call_id: pending });
        pendingRewrites.delete(m.tool_call_id);
        continue;
      }
    }
    rewritten.push(m);
  }
  // Continue using the rewritten message list for the rest of the
  // sanitization pipeline.
  messages = rewritten;

  // Pass 1: bucket tool messages by tool_call_id so we can pull them
  // forward when we reach the assistant that declared each id.
  const toolMessagesByCallId = new Map<string, OpenAIMessage>();
  const declaredCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      toolMessagesByCallId.set(m.tool_call_id, m);
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) declaredCallIds.add(tc.id);
    }
  }

  // answeredCallIds = ids that BOTH have a tool message AND are declared.
  // Bare orphans (tool with no declaring assistant) get dropped.
  const answeredCallIds = new Set<string>();
  for (const id of toolMessagesByCallId.keys()) {
    if (declaredCallIds.has(id)) answeredCallIds.add(id);
  }

  const emittedToolIds = new Set<string>();
  const result: OpenAIMessage[] = [];
  // void-mark — idOccurrenceCount is implicit input to the rewrite
  // pass; declaring it makes intent searchable but the variable
  // isn't used afterward.
  void idOccurrenceCount;

  for (const m of messages) {
    if (m.role === "tool") {
      // Tool messages get emitted ONLY when the adjacency-promotion path
      // below pulls them forward. If we encountered one in the original
      // stream and it hasn't been emitted yet, that means its declaring
      // assistant came LATER (which is impossible for orphans we
      // already filtered) OR — our actual case — an interleaved
      // user/assistant pushed it out of place. In both cases skip; we
      // already handled it (or will handle it) at the assistant.
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      // Trim tool_calls whose answers never arrived; if nothing remains
      // and there's no text either, drop the assistant message entirely.
      const keptCalls = m.tool_calls.filter((tc) => answeredCallIds.has(tc.id));
      const hasText = typeof m.content === "string" && m.content.trim().length > 0;
      if (keptCalls.length === 0 && !hasText) continue;
      if (keptCalls.length === 0) {
        result.push({ role: "assistant", content: m.content ?? null });
        continue;
      }
      result.push({ ...m, tool_calls: keptCalls });
      // Adjacency-promotion: emit each kept tool's answer immediately
      // after the assistant. Marks each as emitted so the original
      // (out-of-place) position above is skipped.
      for (const tc of keptCalls) {
        const toolMsg = toolMessagesByCallId.get(tc.id);
        if (toolMsg && !emittedToolIds.has(tc.id)) {
          result.push(toolMsg);
          emittedToolIds.add(tc.id);
        }
      }
      continue;
    }
    result.push(m);
  }
  return result;
}

function convertToolsToAnthropicFormat(tools: readonly any[]): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    let inputSchema: Record<string, unknown> = { type: "object", properties: {} };
    if (tool.inputJsonSchemaOverride) {
      inputSchema = tool.inputJsonSchemaOverride as Record<string, unknown>;
    } else {
      try {
        const jsonSchema = z.toJSONSchema(tool.inputSchema);
        const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
        inputSchema = rest;
      } catch {}
    }

    return {
      name: tool.name,
      // Prefer the tool's explicit description; fall back to a
      // humanized form of the name only when nothing is set.
      description: typeof tool.description === "string" && tool.description.trim().length > 0
        ? tool.description
        : String(tool.name).replace(/_/g, " "),
      input_schema: inputSchema,
    };
  });
}

function convertToolsToOpenAIFormat(tools: readonly any[]): Array<Record<string, unknown>> {
  const anthropicTools = convertToolsToAnthropicFormat(tools);
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export const openAICompatPlugin: ProviderPlugin = {
  id: "openai-compat",
  dialects: ["openai_chat_completions"],
  // OpenAI Chat Completions tool message content is string-only.
  // `flattenToolResultContentForOpenAI` (above) flattens images to
  // `[image elided: ...]` placeholders. Per-dialect upgrade
  // (DashScope, kimi-vl, glm-4v) requires verifying the wire format
  // against a live provider before flipping this flag.
  supportsToolResultImageBlocks: false,
  buildRequestBody: ({ messages, model, tools, maxOutputTokens, provider, modelProfile }) => {
    const effectiveModelProfile = {
      ...modelProfile,
      modelName: model,
    };

    return {
      ...(provider.requestOverrides ?? {}),
      ...(modelProfile.requestOverrides ?? {}),
      model,
      messages,
      stream: true,
      // OpenAI streaming spec: usage is null on every chunk unless we
      // ask for it explicitly. Most OpenAI-compat providers (Kimi /
      // DeepSeek / MiniMax / VolcEngine) return it unconditionally,
      // but a strict OpenAI client wouldn't — and the leader loop's
      // compaction baseline pin depends on real `inputTokens`. Asking
      // is cheap; not asking sometimes loses the count entirely.
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools } : {}),
      ...(maxOutputTokens || modelProfile.maxOutputTokens
        ? { max_tokens: maxOutputTokens ?? modelProfile.maxOutputTokens }
        : {}),
      ...buildReasoningPatch(provider, effectiveModelProfile),
    };
  },
  convertMessages: (messages, systemPrompt) => {
    const convertedMessages: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];
    for (const message of messages) {
      convertedMessages.push(...convertLeaderMessageToOpenAI(message));
    }

    // OpenAI-compat strictly requires every `role: "tool"` message to follow
    // an `assistant` message whose tool_calls includes its tool_call_id.
    // Orphans (e.g. from a half-applied compaction or a checkpoint that
    // captured tool results without their generating assistant message)
    // cause upstream "InvalidParameter" errors with no useful detail. Drop
    // them defensively here, plus drop assistant tool_calls whose matching
    // tool messages didn't survive.
    return { messages: pairOpenAIToolMessages(convertedMessages) };
  },
  convertTools: (tools) => convertToolsToOpenAIFormat(tools),
  resolveRequestPath: () => "/chat/completions",
};
