/**
 * Project an MCP prompt's rendered `PromptMessage[]` (from
 * `client.getPrompt(...)`) into Magister's first-turn shape:
 *
 *   - `userBlocks`: LeaderContentBlock[] for the LAST user-role
 *     message, joined with any image attachments and rendered as
 *     the first user message of the new task.
 *   - `assistantPreamble`: LeaderMessage[] for ALL prior messages
 *     (user + assistant), preserving order, prepended to the
 *     runtime's `restoredMessages` so the leader's first model
 *     call sees the full multi-turn priming.
 *
 * The split is "last user wins" — most prompts are a single
 * user-role message ("Review this PR: ..."), in which case
 * `assistantPreamble` is empty and `userBlocks` is the rendered
 * content. For multi-turn templates (rare; some prompts include
 * an assistant priming reply), the prefix lands in the preamble
 * and the trailing user message is the current request.
 *
 * Content variants supported: text, image (flat LeaderContentBlock
 * shape with `mediaType`+`data`), resource_link (text marker),
 * embedded resource with text (inlined), embedded resource with
 * blob (text marker), audio (text marker — Magister has no audio
 * leader block).
 */

import type {
  LeaderAssistantMessage,
  LeaderContentBlock,
  LeaderMessage,
  LeaderUserMessage,
} from "./manager-automation/autonomous-loop/autonomous-types";

/**
 * Discriminated union mirroring the MCP SDK's `PromptMessage.content`
 * shape (SDK 1.x). Strict typing here means the `switch` below is
 * exhaustive — if the SDK adds a new content variant in a future
 * version, our `default` branch becomes unreachable and TypeScript
 * flags the missing handler at compile time. Without this, an SDK
 * upgrade silently falls through to `default: return []` and the
 * model sees an empty user message instead of the new content.
 */
export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        text?: string;
        blob?: string;
        mimeType?: string;
      };
    };

export type McpPromptMessage = {
  role: "user" | "assistant";
  content: McpPromptContent;
};

function projectContentToBlocks(content: McpPromptContent, isAssistant: boolean): LeaderContentBlock[] {
  if (!content) return [];
  switch (content.type) {
    case "text":
      return [{ type: "text", text: content.text }];
    case "image": {
      // LeaderContentBlock.image is FLAT: { type, mediaType, data }
      // (the {source:{type:"base64",...}} shape is the Anthropic
      // wire format produced by the plugin, NOT the vendor-neutral
      // block).
      if (isAssistant) {
        // No assistant-image LeaderContentBlock variant — mark as text.
        return [{ type: "text", text: `[mcp prompt assistant image elided] mime=${content.mimeType ?? "image/unknown"}` }];
      }
      return [{ type: "image", mediaType: content.mimeType, data: content.data }];
    }
    case "audio":
      return [{ type: "text", text: `[mcp audio attachment elided] mime=${content.mimeType ?? "audio/unknown"}` }];
    case "resource_link":
      return [{
        type: "text",
        text: `[mcp resource link] uri=${content.uri}${content.name ? ` name=${content.name}` : ""}${content.mimeType ? ` mime=${content.mimeType}` : ""}`,
      }];
    case "resource": {
      const r = content.resource ?? {};
      if (typeof r.text === "string") {
        return [{
          type: "text",
          text: `[mcp resource ${r.uri}]\n${r.text}`,
        }];
      }
      if (typeof r.blob === "string") {
        return [{
          type: "text",
          text: `[mcp resource blob] uri=${r.uri} mime=${r.mimeType ?? "application/octet-stream"}`,
        }];
      }
      return [];
    }
    default: {
      // Exhaustiveness guard. With the discriminated `McpPromptContent`
      // union above, this branch is statically unreachable; the
      // `never` assertion turns "SDK added a new content variant" into
      // a compile error instead of a silent runtime fall-through to
      // an empty user message.
      const _exhaustive: never = content;
      void _exhaustive;
      return [];
    }
  }
}

export function projectPromptMessages(
  messages: McpPromptMessage[],
): { userBlocks: LeaderContentBlock[]; assistantPreamble: LeaderMessage[] } {
  if (messages.length === 0) return { userBlocks: [], assistantPreamble: [] };

  // Find the LAST user-role message — its content becomes the
  // first-turn user blocks. Everything before it is preamble.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex < 0) {
    // No user role at all — entire conversation is assistant preamble.
    const preamble: LeaderMessage[] = [];
    for (const msg of messages) {
      const blocks = projectContentToBlocks(msg.content, true);
      const am: LeaderAssistantMessage = { type: "assistant", content: blocks };
      preamble.push(am);
    }
    return { userBlocks: [], assistantPreamble: preamble };
  }

  const lastUserMsg = messages[lastUserIndex]!;
  const userBlocks = projectContentToBlocks(lastUserMsg.content, false);

  const preamble: LeaderMessage[] = [];
  for (let i = 0; i < lastUserIndex; i++) {
    const msg = messages[i]!;
    const blocks = projectContentToBlocks(msg.content, msg.role === "assistant");
    if (msg.role === "user") {
      const um: LeaderUserMessage = { type: "user", content: blocks };
      preamble.push(um);
    } else {
      const am: LeaderAssistantMessage = { type: "assistant", content: blocks };
      preamble.push(am);
    }
  }

  return { userBlocks, assistantPreamble: preamble };
}
