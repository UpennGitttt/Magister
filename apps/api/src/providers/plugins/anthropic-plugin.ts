import { z } from "zod";

import { buildReasoningPatch } from "../reasoning-patch";
import type { ProviderPlugin } from "../provider-plugin";
import type {
  LeaderContentBlock,
  LeaderMessage,
} from "../../services/manager-automation/autonomous-loop/autonomous-types";
import { pairLeaderToolMessages } from "../../services/manager-automation/autonomous-loop/message-pairing";

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

// `cache_control` is an optional Anthropic field that marks where
// the prompt-caching prefix ends. Any content block in messages /
// tools / system can carry it; up to 4 markers per request.
type CacheControl = { type: "ephemeral" };

// Anthropic API accepts `tool_result.content` as either a string or
// an array of text/image blocks; Magister passes the array form when a
// tool returns LeaderResultBlock[].
type AnthropicToolResultBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicToolResultBlock[];
      is_error?: boolean;
      cache_control?: CacheControl;
    }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: CacheControl }
  // DeepSeek's anthropic-compat endpoint (and Anthropic Claude in
  // extended-thinking mode) require any previously-emitted assistant
  // thinking block to be passed back in the next request, otherwise
  // the API rejects. `signature` is the verification token Anthropic
  // returns on signature_delta events; when we don't have one we omit
  // the field — DeepSeek's check is content-based, and Anthropic
  // tolerates a missing signature.
  | { type: "thinking"; thinking: string; signature?: string };

function toAnthropicToolResultContent(
  content: import("../../services/manager-automation/autonomous-loop/autonomous-types").LeaderResultContent,
): string | AnthropicToolResultBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) =>
    block.type === "text"
      ? { type: "text" as const, text: block.text }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: block.mediaType, data: block.data },
        },
  );
}

function toAnthropicRole(message: LeaderMessage): "user" | "assistant" | undefined {
  if (message.type === "assistant") {
    return "assistant";
  }
  if (message.type === "user" || message.type === "tool_result") {
    return "user";
  }
  return undefined;
}

function toUserContentBlocks(message: LeaderMessage): LeaderContentBlock[] {
  if (message.type === "user") {
    if (typeof message.content === "string") {
      return [{ type: "text", text: message.content }];
    }

    return message.content
      .filter(
        (block) => block.type === "text" || block.type === "tool_result" || block.type === "image",
      )
      .map((block) => {
        if (block.type === "text") {
          return { type: "text", text: block.text } as const;
        }
        if (block.type === "image") {
          return { type: "image", mediaType: block.mediaType, data: block.data } as const;
        }
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        } as const;
      });
  }

  if (message.type === "tool_result") {
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolUseId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      },
    ];
  }

  return [];
}

function mergeUserRoleMessages(previous: LeaderMessage, current: LeaderMessage): LeaderMessage {
  const previousBlocks = toUserContentBlocks(previous);
  const currentBlocks = toUserContentBlocks(current);

  return {
    ...(previous.uuid ? { uuid: previous.uuid } : {}),
    ...(previous.timestamp ? { timestamp: previous.timestamp } : {}),
    ...(previous.isMeta ? { isMeta: previous.isMeta } : {}),
    type: "user",
    content: [...previousBlocks, ...currentBlocks],
  };
}

function sanitizeAnthropicReplayHistory(messages: LeaderMessage[]): LeaderMessage[] {
  // First, drop orphan tool_use / tool_result blocks. Anthropic rejects
  // any history where a tool_use block isn't followed by a matching
  // tool_result, so this MUST run before role-merging — otherwise an
  // orphan tool_use survives into the merged assistant message and the
  // API call 400s with `tool_use ids found without tool_result`. See
  // `message-pairing.ts` for the algorithm.
  const paired = pairLeaderToolMessages(messages);

  const sanitized: LeaderMessage[] = [];
  let lastRole: "user" | "assistant" | undefined;
  let lastRoleIndex = -1;

  for (const message of paired) {
    const role = toAnthropicRole(message);
    if (!role) {
      sanitized.push(message);
      continue;
    }

    if (role !== lastRole || lastRoleIndex < 0) {
      sanitized.push(message);
      lastRole = role;
      lastRoleIndex = sanitized.length - 1;
      continue;
    }

    const previous = sanitized[lastRoleIndex];
    if (!previous) {
      sanitized.push(message);
      lastRole = role;
      lastRoleIndex = sanitized.length - 1;
      continue;
    }

    if (role === "assistant" && previous.type === "assistant" && message.type === "assistant") {
      const mergedAssistant: LeaderMessage = {
        ...previous,
        content: [...previous.content, ...message.content],
      };
      sanitized[lastRoleIndex] = mergedAssistant;
      continue;
    }

    if (role === "user") {
      sanitized[lastRoleIndex] = mergeUserRoleMessages(previous, message);
      continue;
    }

    sanitized.push(message);
    lastRole = role;
    lastRoleIndex = sanitized.length - 1;
  }

  return sanitized;
}

function convertLeaderMessageToAnthropic(message: LeaderMessage): AnthropicMessage[] {
  switch (message.type) {
    case "user": {
      if (typeof message.content === "string") {
        return [{ role: "user", content: message.content }];
      }
      const blocks: AnthropicContentBlock[] = message.content
        .filter((b) => b.type === "text" || b.type === "tool_result" || b.type === "image")
        .map((b) => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") {
            return {
              type: "image",
              source: { type: "base64", media_type: b.mediaType, data: b.data },
            };
          }
          return {
            type: "tool_result",
            tool_use_id: b.tool_use_id,
            content: toAnthropicToolResultContent(b.content),
            ...(b.is_error ? { is_error: true } : {}),
          };
        });
      return [{ role: "user", content: blocks }];
    }
    case "assistant": {
      // Include `thinking` blocks in replay. Anthropic-compat endpoints
      // (DeepSeek, Claude extended-thinking) require previously-emitted
      // thinking content to be passed back on the next turn or they reject.
      //
      // `signature` is omitted because we don't currently capture
      // signature_delta into persisted thinking blocks. DeepSeek's check
      // is content-presence based; Anthropic tolerates omitted signatures.
      const blocks: AnthropicContentBlock[] = message.content
        .filter(
          (block) => block.type === "text" || block.type === "tool_use" || block.type === "thinking",
        )
        .map((block) => {
          if (block.type === "text") return { type: "text", text: block.text };
          if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
          // Drop Magister-internal `providerToolUseId` so Anthropic
          // doesn't see an unknown field. Use spread-then-omit instead
          // of an explicit whitelist to preserve legitimate passthrough
          // fields (e.g. `cache_control: ephemeral`).
          const { providerToolUseId: _drop, ...rest } = block;
          void _drop;
          return rest;
        });
      // Safety net: an assistant message with NO thinking block would
      // trigger the "thinking must be passed back" error on anthropic-
      // compat endpoints. Insert a single-char placeholder so the
      // structural contract is met even when actual thinking history
      // is unrecoverable (never overwrites real content).
      const hasThinking = blocks.some((b) => b.type === "thinking");
      const hasTextOrTool = blocks.some((b) => b.type === "text" || b.type === "tool_use");
      if (!hasThinking && hasTextOrTool) {
        blocks.unshift({ type: "thinking", thinking: " " });
      }
      return [{ role: "assistant", content: blocks }];
    }
    case "tool_result":
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolUseId,
              content: toAnthropicToolResultContent(message.content),
              ...(message.isError ? { is_error: true } : {}),
            },
          ],
        },
      ];
    default:
      return [];
  }
}

/**
 * Anthropic prompt-caching breakpoint (P1.6). cache_control on the
 * last tool definition tells the API to cache the entire
 * (system + tools) prefix; subsequent identical requests up to that
 * point pay ~10% of normal input-token cost. Up to 4 breakpoints
 * total per request — we use 2 (one on the system text, one on the
 * last tool) so there's room for future user/assistant markers.
 *
 * Anthropic auto-skips the cache when total cached prefix is below
 * ~1024 tokens, so always-on placement is safe even for short
 * sessions; below the floor the marker is a no-op rather than a
 * cost regression.
 */
const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

function convertToolsToAnthropicFormat(tools: readonly any[]): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = tools.map((tool) => {
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
      description: typeof tool.description === "string" && tool.description.trim().length > 0
        ? tool.description
        : String(tool.name).replace(/_/g, " "),
      input_schema: inputSchema,
    };
  });

  if (converted.length > 0) {
    const lastIdx = converted.length - 1;
    converted[lastIdx] = {
      ...converted[lastIdx]!,
      cache_control: CACHE_CONTROL_EPHEMERAL,
    };
  }
  return converted;
}

/**
 * Convert the system-prompt string into Anthropic's array-of-blocks
 * form with a cache_control breakpoint at the end. The string form
 * is also valid for the API but doesn't accept cache_control; the
 * array form costs nothing extra to produce and unlocks caching for
 * the whole system prompt.
 *
 * Stability note (kimi P1.6 review): the cache hits ONLY when the
 * system prompt bytes are identical across requests within the
 * 5-minute ephemeral TTL. Magister's system prompt is composed in
 * `process-task-intent-service.ts` once per task and reused across
 * all turns of that task (so within-task caching works). Day-boundary
 * date strings in `frameworkProtocol` (`Current date: …`) cause a
 * one-time invalidation across midnight UTC for tasks that span the
 * boundary; not worth eliminating because the impact is bounded
 * (one cold turn per day per task).
 */
function buildCacheableSystem(systemPrompt: string): Array<Record<string, unknown>> {
  return [
    { type: "text", text: systemPrompt, cache_control: CACHE_CONTROL_EPHEMERAL },
  ];
}

function resolveAnthropicRequestPath(baseUrl: string) {
  const normalized = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  return normalized.endsWith("/v1") ? "/messages" : "/v1/messages";
}

export const anthropicPlugin: ProviderPlugin = {
  id: "anthropic",
  dialects: ["anthropic_messages"],
  // Anthropic Messages API natively accepts text + image blocks in
  // tool_result.content. `toAnthropicToolResultContent` (above)
  // translates LeaderResultContent → the wire shape.
  supportsToolResultImageBlocks: true,
  buildRequestBody: ({ messages, systemPrompt, model, tools, maxOutputTokens, provider, modelProfile }) => {
    const effectiveModelProfile = {
      ...modelProfile,
      modelName: model,
    };

    return {
      ...(provider.requestOverrides ?? {}),
      ...(modelProfile.requestOverrides ?? {}),
      model,
      max_tokens: maxOutputTokens ?? modelProfile.maxOutputTokens ?? 4096,
      // P1.6 — system as cache-marked block array. Anthropic accepts
      // both string and array forms; we prefer array because it's
      // the only form that supports cache_control. Below ~1024 tokens
      // the API silently ignores the marker, so this is safe even
      // for short prompts.
      system: buildCacheableSystem(systemPrompt),
      messages,
      stream: true,
      ...(tools?.length ? { tools } : {}),
      ...buildReasoningPatch(provider, effectiveModelProfile),
    };
  },
  convertMessages: (messages, systemPrompt) => {
    const convertedMessages: AnthropicMessage[] = [];
    for (const message of messages) {
      convertedMessages.push(...convertLeaderMessageToAnthropic(message));
    }

    // P1.6 rolling cache — mark the LAST content block of the LAST
    // pre-final user-role message with cache_control. This caches
    // the entire history up to (but not including) the final user
    // turn that just arrived. On the next call, that final turn
    // becomes "last but one" and shifts the cache prefix forward.
    // Combined with the system + tools breakpoints we use 3 of
    // Anthropic's 4 allowed cache markers per request.
    if (convertedMessages.length >= 2) {
      for (let i = convertedMessages.length - 2; i >= 0; i--) {
        const msg = convertedMessages[i]!;
        if (msg.role !== "user") continue;
        if (typeof msg.content === "string") {
          convertedMessages[i] = {
            role: "user",
            content: [
              { type: "text", text: msg.content, cache_control: CACHE_CONTROL_EPHEMERAL },
            ],
          };
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          const blocks = [...msg.content];
          const last = blocks[blocks.length - 1]!;
          // `thinking` blocks never appear in user-role content (the
          // user-message converter filters them out); narrow the type
          // here so cache_control attachment is well-typed.
          if (last.type !== "thinking") {
            blocks[blocks.length - 1] = {
              ...last,
              cache_control: CACHE_CONTROL_EPHEMERAL,
            };
          }
          convertedMessages[i] = { role: "user", content: blocks };
        }
        break;
      }
    }

    return { messages: convertedMessages, system: systemPrompt };
  },
  convertTools: (tools) => convertToolsToAnthropicFormat(tools),
  sanitizeReplayHistory: (messages) => sanitizeAnthropicReplayHistory(messages),
  resolveRequestPath: (baseUrl) => resolveAnthropicRequestPath(baseUrl),
};
