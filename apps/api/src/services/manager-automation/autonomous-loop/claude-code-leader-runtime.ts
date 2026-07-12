import { randomUUID } from "node:crypto";

import { query, createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

import type {
  LeaderContentBlock,
  LeaderMessage,
  LeaderTool,
  LeaderToolUseContext,
} from "./autonomous-types";
import type { LeaderRuntimeConfig, LeaderRuntimeResult } from "./manager-autonomous-runtime";
import { resolveLeaderRuntimeTools } from "./manager-autonomous-runtime";
import { createEventProjector } from "../../leader-event-projector";
import { LeaderSessionStore } from "../../leader-session-store";
import { recordUsage } from "../../token-usage-service";

/**
 * Claude Code leader runtime — drives the leader loop on the LOCAL
 * Claude Code CLI (subscription login) instead of a provider API key.
 *
 * Architecture (borrowed from awslabs/cli-agent-orchestrator's MCP-
 * injection model, adapted to in-process): Claude Code runs the
 * model→tool_use→observation loop itself via the Agent SDK; every
 * Magister leader tool (bash, spawn_teammate, git_commit, approvals,
 * ...) is exposed to it as an in-process MCP tool whose handler runs
 * HERE — so risk classification, approval gates, sandboxing, and
 * event projection all stay inside the Magister process.
 *
 * Deliberate v1 scope (ponytail: each has an upgrade path):
 * - compaction / doom-loop / plan-mode are Claude Code's own (or absent);
 *   Magister's versions live in the ucm loop only.
 * - MCP-bridged tools without a zod object schema are skipped (logged);
 *   attach those MCP servers to Claude Code directly if needed.
 * - inbound image attachments are not forwarded (text prompt only).
 * - usage is recorded once per run (from the terminal `result` message),
 *   not per turn — token-budget enforcement is ucm-loop only for now.
 */

export type ClaudeCodeLeaderOptions = {
  modelName?: string;
  commandPath?: string;
};

const CLAUDE_SESSION_PREFIX = "claude-code:";

/** Claude Code built-ins that would bypass Magister's tool gates. */
const DISALLOWED_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookRead",
  "Cd",
  "KillShell",
  "BashOutput",
  "SlashCommand",
  "Skill",
  "TodoWrite",
];

function mintToolUseId(): string {
  return `tu_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function isLeaderResultBlockArray(value: unknown): value is Array<
  { type: "text"; text: string } | { type: "image"; mediaType: string; data: string }
> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (b) =>
        b !== null &&
        typeof b === "object" &&
        ((b as { type?: string }).type === "text" || (b as { type?: string }).type === "image"),
    )
  );
}

type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function toMcpContent(data: unknown): McpContentBlock[] {
  if (isLeaderResultBlockArray(data)) {
    return data.map((b) =>
      b.type === "text"
        ? { type: "text" as const, text: b.text }
        : { type: "image" as const, data: b.data, mimeType: b.mediaType },
    );
  }
  if (typeof data === "string") {
    return [{ type: "text", text: data }];
  }
  try {
    return [{ type: "text", text: JSON.stringify(data, null, 2) ?? "null" }];
  } catch {
    return [{ type: "text", text: String(data) }];
  }
}

function summarizeForEvent(content: McpContentBlock[]): string {
  return content
    .map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`))
    .join("\n")
    .slice(0, 8_000);
}

/**
 * Extract the zod raw shape the SDK's `tool()` helper needs. Leader
 * tools are zod objects (have `.shape`); MCP-bridge tools use
 * `z.record(z.unknown())` and have none — those are skipped by the
 * caller.
 */
function zodObjectShape(schema: unknown): Record<string, unknown> | null {
  const shape = (schema as { shape?: unknown })?.shape;
  if (shape && typeof shape === "object" && !Array.isArray(shape)) {
    return shape as Record<string, unknown>;
  }
  return null;
}

const MCP_TOOL_PREFIX = "mcp__magister__";

function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

export async function runLeaderRuntimeWithClaudeCode(
  config: LeaderRuntimeConfig,
  options: ClaudeCodeLeaderOptions = {},
): Promise<LeaderRuntimeResult> {
  const toolSetup = config.tools
    ? { tools: [...config.tools], maxTurns: config.maxTurns ?? 60 }
    : await resolveLeaderRuntimeTools({
        workspaceDir: config.workspaceDir,
        ...(config.tavilyConfig ? { tavilyConfig: config.tavilyConfig } : {}),
        ...(config.baseWorkspaceDir !== undefined ? { baseWorkspaceDir: config.baseWorkspaceDir } : {}),
      });
  const tools = toolSetup.tools;

  const projectEvent = createEventProjector({
    taskId: config.taskId,
    runId: config.runId,
    requestId: config.requestId,
    ...(config.channelBindingId !== undefined ? { channelBindingId: config.channelBindingId } : {}),
    agentRole: "leader",
    agentName: "Leader",
    agentDepth: 0,
  });
  const recordEventFn = async (event: { type: string; timestamp: string; data: Record<string, unknown> }) => {
    if (config.recordEvent) {
      await config.recordEvent(event);
      return;
    }
    if (config.observeEvent) {
      try {
        await config.observeEvent(event);
      } catch (err) {
        console.warn(
          "[claude-code-leader] observeEvent failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await projectEvent(event);
  };

  const sessionStore = new LeaderSessionStore();

  // Multi-turn continuity rides on Claude Code's own session files:
  // the prior checkpoint stores `claude-code:<uuid>` and we resume by
  // id — restoredMessages are NOT replayed (the CLI session already
  // holds that history).
  let resumeSessionId: string | undefined;
  try {
    const prior = await sessionStore.getLatestCheckpoint(config.runId);
    if (prior?.sessionId?.startsWith(CLAUDE_SESSION_PREFIX)) {
      resumeSessionId = prior.sessionId.slice(CLAUDE_SESSION_PREFIX.length);
    }
  } catch {
    // No checkpoint — fresh session.
  }

  const collectedMessages: LeaderMessage[] = [];
  collectedMessages.push({
    type: "user",
    content: config.initialPrompt,
    requestId: config.requestId,
  });

  if (config.initialAttachmentBlocks && config.initialAttachmentBlocks.length > 0) {
    console.warn(
      "[claude-code-leader] image attachments are not forwarded to the Claude Code leader runtime yet — text prompt only",
    );
  }

  let inProgressToolUseIds = new Set<string>();
  const toolUseContext: LeaderToolUseContext = {
    taskId: config.taskId,
    runId: config.runId,
    requestId: config.requestId,
    workspaceDir: config.workspaceDir,
    abortController: config.abortController,
    messages: collectedMessages,
    tools,
    getInProgressToolUseIDs: () => inProgressToolUseIds,
    setInProgressToolUseIDs: (f) => {
      inProgressToolUseIds = f(inProgressToolUseIds);
    },
    recordEvent: recordEventFn,
    ...(config.requestApproval ? { requestApproval: config.requestApproval } : {}),
  };

  const sdkToolDefs: Array<SdkMcpToolDefinition<any>> = [];
  const skippedTools: string[] = [];
  for (const leaderTool of tools) {
    const shape = zodObjectShape(leaderTool.inputSchema);
    if (!shape) {
      skippedTools.push(leaderTool.name);
      continue;
    }
    sdkToolDefs.push(
      sdkTool(
        leaderTool.name,
        leaderTool.description ?? leaderTool.name.replace(/_/g, " "),
        shape as any,
        async (args: Record<string, unknown>) => {
          const toolUseId = mintToolUseId();
          await recordEventFn({
            type: "leader.tool_call",
            timestamp: new Date().toISOString(),
            data: {
              toolName: leaderTool.name,
              toolUseId,
              inputSummary: JSON.stringify(args).slice(0, 2_000),
              input: args,
            },
          });
          try {
            const result = await (leaderTool as LeaderTool).call(
              args,
              { ...toolUseContext, currentToolUseId: toolUseId },
              (data) => {
                void recordEventFn({
                  type: "tool.progress",
                  timestamp: new Date().toISOString(),
                  data: { toolUseId, progress: data },
                });
              },
            );
            const content = toMcpContent(result.data);
            await recordEventFn({
              type: "leader.tool_result",
              timestamp: new Date().toISOString(),
              data: {
                toolUseId,
                toolName: leaderTool.name,
                isError: false,
                outputSummary: summarizeForEvent(content),
              },
            });
            return { content };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await recordEventFn({
              type: "leader.tool_result",
              timestamp: new Date().toISOString(),
              data: {
                toolUseId,
                toolName: leaderTool.name,
                isError: true,
                outputSummary: message.slice(0, 8_000),
              },
            });
            return {
              content: [{ type: "text" as const, text: `<tool_use_error>${message}</tool_use_error>` }],
              isError: true,
            };
          }
        },
      ),
    );
  }
  if (skippedTools.length > 0) {
    console.warn(
      `[claude-code-leader] skipped ${skippedTools.length} tool(s) without an object schema (attach their MCP servers to Claude Code directly instead): ${skippedTools.join(", ")}`,
    );
  }

  const magisterServer = createSdkMcpServer({
    name: "magister",
    version: "1.0.0",
    tools: sdkToolDefs,
    alwaysLoad: true,
  });

  // Allowlist the child env (same posture as mcp-pool-service's
  // STDIO_ENV_ALLOWLIST): the CLI only needs PATH/HOME/locale to find
  // its ~/.claude subscription login, and inheriting everything would
  // hand Magister's secrets (Feishu/Tavily/auth keys) to the child.
  // ANTHROPIC_API_KEY is inherently excluded, which is the whole point
  // of this runtime — an env key would silently switch billing to the API.
  const CHILD_ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TZ",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ];
  const childEnv: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  let turnCount = config.startTurnCount ?? 1;
  let claudeSessionId: string | null = null;

  const writeCheckpoint = async (terminal: boolean) => {
    const data = {
      sessionId: claudeSessionId
        ? `${CLAUDE_SESSION_PREFIX}${claudeSessionId}`
        : `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      turnCount,
      messages: collectedMessages,
      ...(terminal ? { terminal: true } : {}),
    };
    if (config.writeCheckpoint) {
      await config.writeCheckpoint(data);
      return;
    }
    await sessionStore.writeCheckpoint({
      ...data,
      taskId: config.taskId,
      runId: config.runId,
      requestId: config.requestId,
    });
  };

  try {
    await recordEventFn({
      type: "leader.turn_start",
      timestamp: new Date().toISOString(),
      data: { turnCount, chainId: config.runId },
    });

    const q = query({
      prompt: config.initialPrompt,
      options: {
        cwd: config.workspaceDir,
        ...(options.modelName ? { model: options.modelName } : {}),
        systemPrompt: config.systemPrompt,
        mcpServers: { magister: magisterServer },
        disallowedTools: DISALLOWED_BUILTIN_TOOLS,
        // Magister tools enforce their own risk classifier + approval
        // gates inside their handlers; Claude Code's prompt layer must
        // not double-gate them.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        maxTurns: toolSetup.maxTurns,
        abortController: config.abortController,
        env: childEnv,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(options.commandPath ? { pathToClaudeCodeExecutable: options.commandPath } : {}),
      },
    });

    let resultReason = "completed";

    for await (const msg of q) {
      if (msg.type === "stream_event") {
        const event = msg.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          await recordEventFn({
            type: "leader.stream_delta",
            timestamp: new Date().toISOString(),
            data: { type: "text_delta", text: event.delta.text },
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
          await recordEventFn({
            type: "leader.stream_delta",
            timestamp: new Date().toISOString(),
            data: { type: "thinking_delta", text: event.delta.thinking },
          });
        }
        continue;
      }

      if (msg.type === "assistant") {
        claudeSessionId = msg.session_id;
        const blocks: LeaderContentBlock[] = [];
        let hasToolUse = false;
        for (const block of msg.message.content as unknown as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            blocks.push({ type: "thinking", thinking: block.thinking });
          } else if (block.type === "tool_use") {
            hasToolUse = true;
            blocks.push({
              type: "tool_use",
              id: String(block.id),
              name: stripMcpPrefix(String(block.name)),
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        if (blocks.length > 0) {
          collectedMessages.push({ type: "assistant", content: blocks });
        }
        await recordEventFn({
          type: "leader.turn_complete",
          timestamp: new Date().toISOString(),
          data: { turnCount, hasToolUse },
        });
        turnCount += 1;
        if (hasToolUse) {
          await recordEventFn({
            type: "leader.turn_start",
            timestamp: new Date().toISOString(),
            data: { turnCount, chainId: config.runId },
          });
        }
        continue;
      }

      if (msg.type === "result") {
        claudeSessionId = msg.session_id;
        if (msg.subtype !== "success") {
          resultReason = "model_error";
          await recordEventFn({
            type: "leader.model_error",
            timestamp: new Date().toISOString(),
            data: { error: `claude-code result: ${msg.subtype}` },
          });
        }
        const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (usage) {
          try {
            await recordUsage({
              taskId: config.taskId,
              runId: config.runId,
              requestId: config.requestId,
              roleId: "leader",
              turnNumber: turnCount,
              model: options.modelName ?? "claude-code",
              provider: "claude-code-local",
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              usageSource: "provider",
            });
          } catch (err) {
            console.warn(
              "[claude-code-leader] usage recording failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }

    await writeCheckpoint(true);
    return {
      reason: config.abortController.signal.aborted ? "aborted_streaming" : resultReason,
      turnCount,
      messages: collectedMessages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.abortController.signal.aborted) {
      await writeCheckpoint(false).catch(() => {});
      return { reason: "aborted_streaming", turnCount, messages: collectedMessages };
    }
    console.warn(`[claude-code-leader] runtime error: ${message}`);
    await recordEventFn({
      type: "leader.model_error",
      timestamp: new Date().toISOString(),
      data: { error: message },
    }).catch(() => {});
    await writeCheckpoint(false).catch(() => {});
    return { reason: "model_error", turnCount, messages: collectedMessages };
  }
}
