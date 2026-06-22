/**
 * Translate MCP tool definitions to Magister's `LeaderTool` shape.
 *
 * Naming: tools are exposed as `mcp__<server>__<tool>`. The
 * `mcp__` prefix is a widely adopted convention. Both OpenAI
 * and Anthropic tool-name regexes accept this; a colon would
 * be REJECTED.
 *
 * The wire-side MCP `callTool` receives the ORIGINAL tool name,
 * not the namespaced one — namespacing is purely a Magister-side
 * collision-avoidance convention.
 *
 * IMPORTANT: this converter does NOT close over an MCP `Client`
 * reference. Instead it takes a `dispatch(serverId, toolName,
 * args, ctx)` callback that the pool owns. When a server
 * disconnects, the pool's dispatch returns an isError result
 * immediately instead of letting `client.callTool` hang on a
 * broken pipe. We translate isError to a throw because Magister's
 * tool-execution.ts maps thrown errors to tool_result.isError.
 */

import { z } from "zod";

import type { LeaderTool } from "./manager-automation/autonomous-loop/autonomous-types";
import type { McpToolPolicyValue } from "../repositories/mcp-tool-policy-repository";

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export type McpDispatchResult = {
  // MCP protocol: tool result content is an array of typed blocks.
  // Spec §2 — `image` and other block types are now surfaced (not
  // dropped) so vision-capable MCP tools (playwright screenshot,
  // everything's get-tiny-image, etc.) flow through to the leader.
  content: Array<{
    type: string;
    text?: string;
    /** Base64-encoded payload for `image` (and `audio`) blocks. */
    data?: string;
    /** MIME type for `image` / `audio` / `resource` blocks. */
    mimeType?: string;
  }>;
  isError?: boolean;
};

export type McpDispatchContext = {
  taskId?: string;
  /** Per-prompt requestId — surfaced so MCP-side approval emits can
   *  tag `leader.approval_requested` with the exchange's requestId
   *  (the web projector keys exchanges on requestId; an event with
   *  empty requestId lands in a phantom no-id exchange and the inline
   *  approve/reject card never renders). */
  requestId?: string;
  signal?: AbortSignal;
};

export type McpDispatch = (
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx?: McpDispatchContext,
) => Promise<McpDispatchResult>;

const TOOL_NAME_PREFIX = "mcp__";
const TOOL_NAME_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;

export function namespacedToolName(serverName: string, toolName: string): string {
  const safeServer = serverName.replace(TOOL_NAME_SAFE_CHARS, "_");
  const safeTool = toolName.replace(TOOL_NAME_SAFE_CHARS, "_");
  return `${TOOL_NAME_PREFIX}${safeServer}__${safeTool}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(TOOL_NAME_PREFIX);
}

export function parseMcpToolName(
  name: string,
): { serverName: string; toolName: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(TOOL_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

export function mcpToolToLeaderTool(input: {
  serverId: string;
  serverName: string;
  mcpTool: McpToolDef;
  policy?: McpToolPolicyValue;
  dispatch: McpDispatch;
}): LeaderTool {
  const { serverId, serverName, mcpTool, dispatch } = input;
  const policy = input.policy ?? "unknown";
  const inputSchema = z.record(z.string(), z.unknown());

  // Surface the MCP server's actual JSON Schema to the model.
  // Without this, `z.record(z.unknown())` round-trips through
  // z.toJSONSchema as `{type:"object", propertyNames:{type:"string"}}`
  // and the model literally stuffs args into a `propertyNames`
  // field (caught during E2E 2026-05-02). Provider plugins prefer
  // `inputJsonSchemaOverride` over `z.toJSONSchema(inputSchema)`.
  return {
    name: namespacedToolName(serverName, mcpTool.name),
    description: mcpTool.description ?? `MCP tool from ${serverName}`,
    inputSchema,
    inputJsonSchemaOverride: mcpTool.inputSchema as Record<string, unknown>,
    isConcurrencySafe: () => false,
    isReadOnly: () => policy === "read_only",
    isPlanSafe: () => policy === "read_only",
    call: async (args: Record<string, unknown>, context) => {
      // LeaderToolUseContext exposes `abortController:
      // AbortController` (NOT a bare signal); read .signal off it.
      const ctx = context as
        | { taskId?: string; requestId?: string; abortController?: AbortController }
        | undefined;
      try {
        const dispatchCtx: McpDispatchContext = {};
        if (ctx?.taskId) dispatchCtx.taskId = ctx.taskId;
        if (ctx?.requestId) dispatchCtx.requestId = ctx.requestId;
        if (ctx?.abortController?.signal) dispatchCtx.signal = ctx.abortController.signal;
        const result = await dispatch(serverId, mcpTool.name, args ?? {}, dispatchCtx);
        // Spec §2 — pass image blocks through as LeaderResultBlock[]
        // (text + image variants). Other block kinds (resource,
        // audio, etc.) still degrade to a text placeholder until
        // their leader-side semantics are designed.
        const blocks: Array<
          | { type: "text"; text: string }
          | { type: "image"; mediaType: string; data: string }
        > = [];
        for (const block of result.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push({ type: "text", text: block.text });
          } else if (
            block.type === "image"
            && typeof block.data === "string"
            && typeof block.mimeType === "string"
          ) {
            blocks.push({ type: "image", mediaType: block.mimeType, data: block.data });
          } else {
            blocks.push({
              type: "text",
              text: `[mcp ${serverName}: returned ${block.type} content, unsupported in V1]`,
            });
          }
        }
        // On error: dispatcher expects a thrown Error with the text
        // payload. Flatten image blocks to placeholders for the throw
        // path so the error message stays grep-able.
        if (result.isError) {
          const errText = blocks.length === 0
            ? "[mcp tool returned empty content]"
            : blocks
                .map((b) => (b.type === "text" ? b.text : `[image: ${b.mediaType}]`))
                .join("\n");
          throw new Error(errText);
        }
        // All-text payloads (single or multi-block) collapse to a
        // joined string so downstream callers that branch on
        // `typeof data === "string"` keep working uniformly.
        // Image-bearing payloads → array so the executor forwards
        // to the plugin's array-content path. (Codex review #3
        // 2026-05-17: avoid the previous single-vs-multi string/
        // array asymmetry that was a footgun for consumers.)
        if (blocks.length === 0) {
          return { data: "[mcp tool returned empty content]" };
        }
        const allText = blocks.every((b) => b.type === "text");
        if (allText) {
          return { data: blocks.map((b) => (b as { text: string }).text).join("\n") };
        }
        return { data: blocks };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("MCP tool error: ")) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`MCP tool error: ${msg}`);
      }
    },
  };
}
