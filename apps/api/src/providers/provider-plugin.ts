import type { ProviderConfig, ModelProfile } from "./types";
import type { LeaderMessage } from "../services/manager-automation/autonomous-loop/autonomous-types";

export type ProviderPlugin = {
  id: string;
  dialects: string[];
  buildRequestBody: (params: {
    messages: unknown[];
    systemPrompt: string;
    model: string;
    tools?: unknown[];
    maxOutputTokens?: number;
    provider: ProviderConfig;
    modelProfile: ModelProfile;
  }) => Record<string, unknown>;
  convertMessages: (
    messages: LeaderMessage[],
    systemPrompt: string,
  ) => { messages: unknown[]; system?: string };
  convertTools: (tools: readonly any[]) => unknown[];
  sanitizeReplayHistory?: (messages: LeaderMessage[]) => LeaderMessage[];
  resolveRequestPath: (baseUrl: string, model: string) => string;
  /**
   * Does this dialect's tool message format accept image blocks natively?
   * Anthropic Messages API: yes (tool_result.content can be an array of
   * text + image blocks). OpenAI Chat Completions: no (tool message
   * content is string-only).
   *
   * When `false`, the plugin's `convertMessages` flattens image
   * blocks to text placeholders. Flip per-dialect only after
   * verifying the wire format works against a live provider.
   *
   * Currently informational — each plugin's `convertMessages` already
   * implements the right behavior internally. Exposed here so
   * external code (UI capability detection, future routing decisions,
   * tests) can read the dialect's contract without grepping plugin
   * internals.
   *
   * V1.1 candidates for upgrade (DashScope qwen3.5-plus, kimi-vl,
   * glm-4v): need wire-format verification before flipping.
   */
  supportsToolResultImageBlocks: boolean;
};
