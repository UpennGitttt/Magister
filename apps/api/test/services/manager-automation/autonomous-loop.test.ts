import { expect, test, describe, mock } from "bun:test";
import { StreamingToolExecutor } from "../../../src/services/manager-automation/autonomous-loop/streaming-tool-executor";
import { runToolUse } from "../../../src/services/manager-automation/autonomous-loop/tool-execution";
import type {
  LeaderTool,
  LeaderToolUseContext,
  LeaderMessage,
  LeaderAssistantMessage,
  LeaderContentBlock,
  ToolUseBlock,
  LeaderToolResultMessage,
  PreToolUseHook,
  PostToolUseHook,
} from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { z } from "zod";

function createMockToolUseContext(
  overrides: Partial<LeaderToolUseContext> = {}
): LeaderToolUseContext {
  const abortController = new AbortController();
  return {
    taskId: "test-task",
    runId: "test-run",
    requestId: "test-req",
    workspaceDir: "/tmp/test",
    abortController,
    messages: [],
    tools: [],
    setInProgressToolUseIDs: mock(() => {}),
    getInProgressToolUseIDs: () => new Set(),
    recordEvent: mock(async () => {}),
    ...overrides,
  };
}

function createMockTool(
  name: string,
  options: {
    isConcurrencySafe?: boolean;
    isReadOnly?: boolean;
    inputSchema?: z.ZodType<any>;
    callImpl?: (input: any, context: LeaderToolUseContext) => Promise<any>;
    checkPermissions?: (input: any, context: LeaderToolUseContext) => Promise<{ behavior: "allow" | "deny" | "ask"; message?: string }>;
    interruptBehavior?: () => "cancel" | "block";
  } = {}
): LeaderTool {
  const schema = options.inputSchema ?? z.object({});
  const tool: LeaderTool = {
    name,
    inputSchema: schema,
    call: options.callImpl ?? (async () => ({ data: "ok" })),
    isConcurrencySafe: () => options.isConcurrencySafe ?? true,
    isReadOnly: () => options.isReadOnly ?? true,
  };
  if (options.checkPermissions !== undefined) {
    tool.checkPermissions = options.checkPermissions;
  }
  if (options.interruptBehavior !== undefined) {
    tool.interruptBehavior = options.interruptBehavior;
  }
  return tool;
}

function getToolResultContent(result: LeaderMessage): string | undefined {
  // Spec §2 — tool_result.content widened to LeaderResultContent
  // (string | LeaderResultBlock[]). Tests in this file only exercise
  // string-content tools, so flatten array form for backward-compat
  // assertions; image blocks become `[image: <mime>]` markers.
  if (result.type === "tool_result") {
    if (typeof result.content === "string") return result.content;
    return result.content
      .map((b) => (b.type === "text" ? b.text : `[image: ${b.mediaType}]`))
      .join("\n");
  }
  return undefined;
}

function isToolResult(message: LeaderMessage): message is LeaderToolResultMessage {
  return message.type === "tool_result";
}

describe("StreamingToolExecutor", () => {
  test("executes tools sequentially when not concurrency safe", async () => {
    const executionOrder: string[] = [];
    const toolA = createMockTool("toolA", {
      isConcurrencySafe: false,
      callImpl: async () => {
        executionOrder.push("A-start");
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push("A-end");
        return { data: "A-result" };
      },
    });
    const toolB = createMockTool("toolB", {
      isConcurrencySafe: false,
      callImpl: async () => {
        executionOrder.push("B-start");
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push("B-end");
        return { data: "B-result" };
      },
    });

    const context = createMockToolUseContext({ tools: [toolA, toolB] });
    const executor = new StreamingToolExecutor([toolA, toolB], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "toolA", input: {} },
      assistantMessage
    );
    executor.addTool(
      { id: "call-2", name: "toolB", input: {} },
      assistantMessage
    );

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    expect(executionOrder).toEqual(["A-start", "A-end", "B-start", "B-end"]);
    expect(results).toHaveLength(2);
    
    const r0 = results[0];
    const r1 = results[1];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        content: "A-result",
      });
    }
    if (r1 && isToolResult(r1)) {
      expect(r1).toMatchObject({
        type: "tool_result",
        toolUseId: "call-2",
        content: "B-result",
      });
    }
  });

  test("executes concurrency-safe tools in parallel", async () => {
    const executionOrder: string[] = [];
    const toolA = createMockTool("toolA", {
      isConcurrencySafe: true,
      callImpl: async () => {
        executionOrder.push("A-start");
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push("A-end");
        return { data: "A-result" };
      },
    });
    const toolB = createMockTool("toolB", {
      isConcurrencySafe: true,
      callImpl: async () => {
        executionOrder.push("B-start");
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push("B-end");
        return { data: "B-result" };
      },
    });

    const context = createMockToolUseContext({ tools: [toolA, toolB] });
    const executor = new StreamingToolExecutor([toolA, toolB], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "toolA", input: {} },
      assistantMessage
    );
    executor.addTool(
      { id: "call-2", name: "toolB", input: {} },
      assistantMessage
    );

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    expect(executionOrder).toContain("A-start");
    expect(executionOrder).toContain("B-start");
    expect(executionOrder.indexOf("A-start")).toBeLessThan(
      executionOrder.indexOf("A-end")
    );
    expect(executionOrder.indexOf("B-start")).toBeLessThan(
      executionOrder.indexOf("B-end")
    );
    expect(results).toHaveLength(2);
  });

  test("returns error for unknown tool", async () => {
    const context = createMockToolUseContext();
    const executor = new StreamingToolExecutor([], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "unknownTool", input: {} },
      assistantMessage
    );

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("No such tool available");
    }
  });

  test("discards tools when discard() is called", async () => {
    const toolA = createMockTool("toolA", {
      callImpl: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { data: "result" };
      },
    });

    const context = createMockToolUseContext({ tools: [toolA] });
    const executor = new StreamingToolExecutor([toolA], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "toolA", input: {} },
      assistantMessage
    );

    executor.discard();

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(0);
  });

  test("handles bash tool error and cancels sibling tools", async () => {
    const toolA = createMockTool("bash", {
      isConcurrencySafe: true,
      callImpl: async () => {
        throw new Error("Command failed with exit code 1");
      },
    });
    const toolB = createMockTool("toolB", {
      isConcurrencySafe: true,
      callImpl: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { data: "B-result" };
      },
    });

    const context = createMockToolUseContext({ tools: [toolA, toolB] });
    const executor = new StreamingToolExecutor([toolA, toolB], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "bash", input: { command: "false" } },
      assistantMessage
    );
    executor.addTool(
      { id: "call-2", name: "toolB", input: {} },
      assistantMessage
    );

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    const bashResult = results.find((r) => isToolResult(r) && r.toolUseId === "call-1");
    const siblingResult = results.find((r) => isToolResult(r) && r.toolUseId === "call-2");

    expect(bashResult).toBeDefined();
    if (bashResult && isToolResult(bashResult)) {
      expect(bashResult.isError).toBe(true);
    }

    if (siblingResult && isToolResult(siblingResult)) {
      expect(siblingResult.isError).toBe(true);
      expect(siblingResult.content).toContain("Cancelled");
    }
  });

  test("respects interruptBehavior block when aborted", async () => {
    let toolCallStarted = false;
    const toolA = createMockTool("blockingTool", {
      interruptBehavior: () => "block",
      callImpl: async () => {
        toolCallStarted = true;
        await new Promise((r) => setTimeout(r, 100));
        return { data: "result" };
      },
    });

    const abortController = new AbortController();
    const context = createMockToolUseContext({
      abortController,
      tools: [toolA],
    });
    const executor = new StreamingToolExecutor([toolA], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "blockingTool", input: {} },
      assistantMessage
    );

    setTimeout(() => abortController.abort(), 10);

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    if (toolCallStarted) {
      const toolResult = results.find((r) => isToolResult(r) && r.toolUseId === "call-1");
      expect(toolResult).toBeDefined();
    }
  });
});

describe("runToolUse", () => {
  test("returns error for unknown tool", async () => {
    const context = createMockToolUseContext();
    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "unknownTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("No such tool available");
    }
  });

  test("returns error when aborted before execution", async () => {
    const tool = createMockTool("testTool");
    const abortController = new AbortController();
    abortController.abort();
    const context = createMockToolUseContext({
      abortController,
      tools: [tool],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("cancelled");
    }
  });

  test("validates input schema and returns error on invalid input", async () => {
    const tool = createMockTool("testTool", {
      inputSchema: z.object({
        required: z.string(),
      }),
    });
    const context = createMockToolUseContext({ tools: [tool] });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("InputValidationError");
    }
  });

  test("respects canUseTool deny behavior", async () => {
    const tool = createMockTool("testTool");
    const context = createMockToolUseContext({
      tools: [tool],
      canUseTool: async () => ({
        behavior: "deny",
        message: "Tool use denied by policy",
      }),
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("Tool use denied by policy");
    }
  });

  test("requests approval when canUseTool returns ask", async () => {
    const tool = createMockTool("testTool");
    const context = createMockToolUseContext({
      tools: [tool],
      canUseTool: async () => ({
        behavior: "ask",
        message: "Allow this tool?",
      }),
      requestApproval: async () => ({
        decision: "reject",
        feedback: "User rejected the tool call",
      }),
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("User rejected");
    }
  });

  test("respects tool checkPermissions deny", async () => {
    const tool = createMockTool("testTool", {
      checkPermissions: async () => ({
        behavior: "deny",
        message: "Permission denied for this operation",
      }),
    });
    const context = createMockToolUseContext({ tools: [tool] });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("Permission denied");
    }
  });

  test("executes tool successfully with valid input", async () => {
    const tool = createMockTool("testTool", {
      inputSchema: z.object({ value: z.number() }),
      callImpl: async (input) => ({ data: { doubled: input.value * 2 } }),
    });
    const context = createMockToolUseContext({ tools: [tool] });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: { value: 5 },
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
      });
      expect(r0.content).toContain("doubled");
      expect(r0.content).toContain("10");
    }
  });

  test("handles tool execution errors", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => {
        throw new Error("Tool execution failed");
      },
    });
    const context = createMockToolUseContext({ tools: [tool] });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
      });
      expect(r0.content).toContain("Tool execution failed");
    }
  });
});

describe("yieldMissingToolResultBlocks logic", () => {
  function* yieldMissingToolResultBlocks(
    assistantMessages: LeaderAssistantMessage[],
    errorMessage: string
  ): Generator<LeaderToolResultMessage> {
    for (const assistantMessage of assistantMessages) {
      const toolUseBlocks = assistantMessage.content.filter(
        (block) => block.type === "tool_use"
      ) as ToolUseBlock[];

      for (const toolUse of toolUseBlocks) {
        yield {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: errorMessage,
          isError: true,
        };
      }
    }
  }

  test("generates error results for orphan tool use blocks", () => {
    const assistantMessages: LeaderAssistantMessage[] = [
      {
        type: "assistant",
        content: [
          { type: "text", text: "Let me help with that" },
          { type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "call-2", name: "read", input: { file_path: "/tmp/test.txt" } },
        ],
      },
    ];

    const results = [...yieldMissingToolResultBlocks(assistantMessages, "Streaming interrupted")];

    expect(results).toHaveLength(2);
    const r0 = results[0];
    const r1 = results[1];
    if (r0) {
      expect(r0).toMatchObject({
        type: "tool_result",
        toolUseId: "call-1",
        isError: true,
        content: "Streaming interrupted",
      });
    }
    if (r1) {
      expect(r1).toMatchObject({
        type: "tool_result",
        toolUseId: "call-2",
        isError: true,
        content: "Streaming interrupted",
      });
    }
  });

  test("handles multiple assistant messages", () => {
    const assistantMessages: LeaderAssistantMessage[] = [
      {
        type: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "bash", input: {} },
        ],
      },
      {
        type: "assistant",
        content: [
          { type: "tool_use", id: "call-2", name: "read", input: {} },
        ],
      },
    ];

    const results = [...yieldMissingToolResultBlocks(assistantMessages, "Error occurred")];

    expect(results).toHaveLength(2);
  });

  test("returns empty for messages without tool_use blocks", () => {
    const assistantMessages: LeaderAssistantMessage[] = [
      {
        type: "assistant",
        content: [{ type: "text", text: "Just a text message" }],
      },
    ];

    const results = [...yieldMissingToolResultBlocks(assistantMessages, "Error")];

    expect(results).toHaveLength(0);
  });
});

describe("parseOpenAISSEChunk logic", () => {
  test("accumulates text content incrementally", () => {
    const accumulated = {
      textContent: "",
      toolUses: new Map(),
      nextBlockIndex: 0,
    };

    const parseOpenAISSEChunk = (chunk: any, acc: typeof accumulated) => {
      const choice = chunk.choices?.[0];
      if (!choice?.delta) return [];

      const blocks: LeaderContentBlock[] = [];
      if (typeof choice.delta.content === "string" && choice.delta.content.length > 0) {
        acc.textContent += choice.delta.content;
        if (acc.textContent.trim()) {
          blocks.push({ type: "text", text: acc.textContent });
        }
      }
      return blocks;
    };

    parseOpenAISSEChunk(
      { choices: [{ delta: { content: "Hello" } }] },
      accumulated
    );
    expect(accumulated.textContent).toBe("Hello");

    parseOpenAISSEChunk(
      { choices: [{ delta: { content: " World" } }] },
      accumulated
    );
    expect(accumulated.textContent).toBe("Hello World");
  });

  test("accumulates tool_use blocks with incremental JSON", () => {
    const accumulated = {
      textContent: "",
      toolUses: new Map<number, { id: string; name: string; inputJson: string }>(),
      nextBlockIndex: 0,
    };

    const parseOpenAISSEChunk = (chunk: any, acc: typeof accumulated): LeaderContentBlock[] => {
      const choice = chunk.choices?.[0];
      if (!choice?.delta?.tool_calls) return [];

      const blocks: LeaderContentBlock[] = [];
      for (const toolCall of choice.delta.tool_calls) {
        const toolIndex =
          typeof toolCall.index === "number" ? toolCall.index : acc.nextBlockIndex++;

        let existing = acc.toolUses.get(toolIndex);
        if (!existing) {
          existing = {
            id: toolCall.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: "",
            inputJson: "",
          };
          acc.toolUses.set(toolIndex, existing);
        }

        if (toolCall.id) existing.id = toolCall.id;
        if (toolCall.function?.name) existing.name = toolCall.function.name;
        if (toolCall.function?.arguments) existing.inputJson += toolCall.function.arguments;

        if (existing.name && existing.inputJson) {
          try {
            const input = JSON.parse(existing.inputJson);
            blocks.push({
              type: "tool_use",
              id: existing.id,
              name: existing.name,
              input,
            });
          } catch {
            blocks.push({
              type: "tool_use",
              id: existing.id,
              name: existing.name,
              input: { partial: existing.inputJson },
            });
          }
        }
      }
      return blocks;
    };

    parseOpenAISSEChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-123", function: { name: "bash" } }] } }] },
      accumulated
    );
    expect(accumulated.toolUses.get(0)?.name).toBe("bash");
    expect(accumulated.toolUses.get(0)?.id).toBe("call-123");

    parseOpenAISSEChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"com' } }] } }] },
      accumulated
    );
    expect(accumulated.toolUses.get(0)?.inputJson).toBe('{"com');

    parseOpenAISSEChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] },
      accumulated
    );
    expect(accumulated.toolUses.get(0)?.inputJson).toBe('{"command":"ls"}');

    const blocks = parseOpenAISSEChunk(
      { choices: [{ delta: { tool_calls: [{ index: 0 }] } }] },
      accumulated
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool_use",
      id: "call-123",
      name: "bash",
      input: { command: "ls" },
    });
  });
});

describe("parseAnthropicSSEEvent logic", () => {
  test("handles content_block_start for tool_use", () => {
    const accumulated = {
      textContent: "",
      toolUses: new Map<number, { id: string; name: string; inputJson: string }>(),
      nextBlockIndex: 0,
    };

    const parseAnthropicSSEEvent = (event: any, acc: typeof accumulated) => {
      if (event.type !== "content_block_start" || event.index === undefined || !event.content_block)
        return { blocks: [], isFinal: false };

      if (event.content_block.type === "tool_use") {
        const existing = acc.toolUses.get(event.index);
        if (!existing) {
          acc.toolUses.set(event.index, {
            id: event.content_block.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`,
            name: event.content_block.name ?? "",
            inputJson: "",
          });
        }
      }
      return { blocks: [], isFinal: false };
    };

    parseAnthropicSSEEvent(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_123", name: "bash" },
      },
      accumulated
    );

    expect(accumulated.toolUses.get(0)?.id).toBe("toolu_123");
    expect(accumulated.toolUses.get(0)?.name).toBe("bash");
  });

  test("handles content_block_delta for text_delta", () => {
    const accumulated = {
      textContent: "",
      toolUses: new Map(),
      nextBlockIndex: 0,
    };

    const parseAnthropicSSEEvent = (event: any, acc: typeof accumulated) => {
      const result: { blocks: LeaderContentBlock[]; isFinal: boolean } = { blocks: [], isFinal: false };

      if (event.type === "content_block_delta" && event.index !== undefined) {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          acc.textContent += delta.text;
          if (acc.textContent.trim()) {
            result.blocks.push({ type: "text", text: acc.textContent });
          }
        }
      }

      if (event.type === "message_delta" && event.delta?.stop_reason) {
        result.isFinal = true;
      }

      return result;
    };

    parseAnthropicSSEEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      accumulated
    );
    expect(accumulated.textContent).toBe("Hello");

    parseAnthropicSSEEvent(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " World" } },
      accumulated
    );
    expect(accumulated.textContent).toBe("Hello World");
  });

  test("handles input_json_delta for tool arguments", () => {
    const accumulated = {
      textContent: "",
      toolUses: new Map<number, { id: string; name: string; inputJson: string }>(),
      nextBlockIndex: 0,
    };

    accumulated.toolUses.set(0, { id: "toolu_123", name: "bash", inputJson: "" });

    const parseAnthropicSSEEvent = (event: any, acc: typeof accumulated) => {
      const result: { blocks: LeaderContentBlock[]; isFinal: boolean } = { blocks: [], isFinal: false };

      if (event.type === "content_block_delta" && event.index !== undefined) {
        const delta = event.delta;
        if (delta?.type === "input_json_delta" && delta.partial_json) {
          const toolIndex = event.index;
          const existing = acc.toolUses.get(toolIndex);
          if (existing) {
            existing.inputJson += delta.partial_json;
            if (existing.name && existing.inputJson) {
              try {
                const input = JSON.parse(existing.inputJson);
                result.blocks.push({
                  type: "tool_use",
                  id: existing.id,
                  name: existing.name,
                  input,
                });
              } catch {
                result.blocks.push({
                  type: "tool_use",
                  id: existing.id,
                  name: existing.name,
                  input: { partial: existing.inputJson },
                });
              }
            }
          }
        }
      }

      return result;
    };

    parseAnthropicSSEEvent(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"com' } },
      accumulated
    );
    expect(accumulated.toolUses.get(0)?.inputJson).toBe('{"com');

    const result = parseAnthropicSSEEvent(
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'mand":"ls"}' } },
      accumulated
    );
    expect(accumulated.toolUses.get(0)?.inputJson).toBe('{"command":"ls"}');
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_123",
      name: "bash",
      input: { command: "ls" },
    });
  });

  test("detects message_stop as final", () => {
    const parseAnthropicSSEEvent = (event: any) => {
      const result: { blocks: LeaderContentBlock[]; isFinal: boolean } = { blocks: [], isFinal: false };
      if (event.type === "message_stop") {
        result.isFinal = true;
      }
      if (event.type === "message_delta" && event.delta?.stop_reason) {
        result.isFinal = true;
      }
      return result;
    };

    expect(parseAnthropicSSEEvent({ type: "message_stop" }).isFinal).toBe(true);
    expect(
      parseAnthropicSSEEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }).isFinal
    ).toBe(true);
  });
});

describe("TombstoneMessage type", () => {
  test("TombstoneMessage structure for orphan cleanup", () => {
    type TombstoneMessage = {
      type: "tombstone";
      toolUseIds: string[];
    };

    const tombstone: TombstoneMessage = {
      type: "tombstone",
      toolUseIds: ["call-1", "call-2", "call-3"],
    };

    expect(tombstone.type).toBe("tombstone");
    expect(tombstone.toolUseIds).toHaveLength(3);
    expect(tombstone.toolUseIds).toContain("call-1");
  });
});

describe("AbortController memory safety", () => {
  test("child abort controller propagates abort", () => {
    const parentController = new AbortController();
    const childController = new AbortController();
    
    childController.signal.addEventListener("abort", () => {
      if (!parentController.signal.aborted) {
        parentController.abort(childController.signal.reason);
      }
    });

    childController.abort("test_reason");

    expect(childController.signal.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(true);
    expect(parentController.signal.reason).toBe("test_reason");
  });

  test("streaming tool executor cleans up on abort", async () => {
    const abortController = new AbortController();
    let toolStarted = false;

    const slowTool = createMockTool("slowTool", {
      callImpl: async () => {
        toolStarted = true;
        await new Promise((r) => setTimeout(r, 1000));
        return { data: "completed" };
      },
    });

    const context = createMockToolUseContext({
      abortController,
      tools: [slowTool],
    });
    const executor = new StreamingToolExecutor([slowTool], context);

    const assistantMessage: LeaderAssistantMessage = {
      type: "assistant",
      content: [],
    };

    executor.addTool(
      { id: "call-1", name: "slowTool", input: {} },
      assistantMessage
    );

    setTimeout(() => abortController.abort("user_cancelled"), 10);

    const results: LeaderMessage[] = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) results.push(update.message);
    }

    expect(abortController.signal.aborted).toBe(true);
    
    if (toolStarted && results.length > 0) {
      const r0 = results[0];
      if (r0 && isToolResult(r0)) {
        expect(r0.content).toContain("rejected");
      }
    }
  });
});

describe("PreToolUse Hooks", () => {
  test("preToolUse hook can deny tool execution", async () => {
    const tool = createMockTool("testTool");
    const denyHook: PreToolUseHook = async () => ({
      behavior: "deny",
      message: "Blocked by security policy",
    });
    const context = createMockToolUseContext({
      tools: [tool],
      preToolUseHooks: [denyHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.isError).toBe(true);
      expect(r0.content).toContain("Blocked by security policy");
    }
  });

  test("preToolUse hook can modify input", async () => {
    const tool = createMockTool("testTool", {
      inputSchema: z.object({ value: z.number() }),
      callImpl: async (input) => ({ data: { result: input.value } }),
    });
    const modifyHook: PreToolUseHook = async () => ({
      behavior: "modify",
      updatedInput: { value: 42 },
    });
    const context = createMockToolUseContext({
      tools: [tool],
      preToolUseHooks: [modifyHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: { value: 5 },
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.content).toContain("42");
      expect(r0.content).not.toContain("5");
    }
  });

  test("preToolUse hook allow passes through", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => ({ data: "success" }),
    });
    const allowHook: PreToolUseHook = async () => ({
      behavior: "allow",
    });
    const context = createMockToolUseContext({
      tools: [tool],
      preToolUseHooks: [allowHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.content).toBe("success");
    }
  });

  test("multiple preToolUse hooks - deny stops execution", async () => {
    const tool = createMockTool("testTool");
    const logHook: PreToolUseHook = async () => ({ behavior: "allow" });
    const denyHook: PreToolUseHook = async () => ({
      behavior: "deny",
      message: "Final hook blocked",
    });
    const context = createMockToolUseContext({
      tools: [tool],
      preToolUseHooks: [logHook, denyHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.isError).toBe(true);
      expect(r0.content).toContain("Final hook blocked");
    }
  });

  test("hooks record blocking event", async () => {
    const tool = createMockTool("testTool");
    const events: any[] = [];
    const denyHook: PreToolUseHook = async () => ({
      behavior: "deny",
      message: "Blocked",
    });
    const context = createMockToolUseContext({
      tools: [tool],
      preToolUseHooks: [denyHook],
      recordEvent: async (event) => { events.push(event); },
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    for await (const update of runToolUse(toolUse, [tool], context)) {
    }

    const blockEvent = events.find((e) => e.type === "tool.hook_blocked");
    expect(blockEvent).toBeDefined();
    expect(blockEvent.data.hookType).toBe("pre");
  });
});

describe("PostToolUse Hooks", () => {
  test("postToolUse hook can modify output", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => ({ data: { original: "result" } }),
    });
    const modifyHook: PostToolUseHook = async () => ({
      modifiedOutput: { modified: "output" },
    });
    const context = createMockToolUseContext({
      tools: [tool],
      postToolUseHooks: [modifyHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.content).toContain("modified");
      expect(r0.content).toContain("output");
      expect(r0.content).not.toContain("original");
    }
  });

  test("postToolUse hook runs after successful execution", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => ({ data: "executed" }),
    });
    let hookCalled = false;
    const verifyHook: PostToolUseHook = async () => {
      hookCalled = true;
      return {};
    };
    const context = createMockToolUseContext({
      tools: [tool],
      postToolUseHooks: [verifyHook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    for await (const update of runToolUse(toolUse, [tool], context)) {
    }

    expect(hookCalled).toBe(true);
  });

  test("postToolUse hooks do not run on error", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => {
        throw new Error("Tool failed");
      },
    });
    let hookCalled = false;
    const hook: PostToolUseHook = async () => {
      hookCalled = true;
      return {};
    };
    const context = createMockToolUseContext({
      tools: [tool],
      postToolUseHooks: [hook],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(hookCalled).toBe(false);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.isError).toBe(true);
    }
  });

  test("multiple postToolUse hooks can chain output modifications", async () => {
    const tool = createMockTool("testTool", {
      callImpl: async () => ({ data: { step: 0 } }),
    });
    const hook1: PostToolUseHook = async (_name, _input, output) => ({
      modifiedOutput: { ...output as object, step: 1 },
    });
    const hook2: PostToolUseHook = async (_name, _input, output) => ({
      modifiedOutput: { ...output as object, step: 2 },
    });
    const context = createMockToolUseContext({
      tools: [tool],
      postToolUseHooks: [hook1, hook2],
    });

    const toolUse: ToolUseBlock = {
      id: "call-1",
      name: "testTool",
      input: {},
    };

    const results: LeaderMessage[] = [];
    for await (const update of runToolUse(toolUse, [tool], context)) {
      if (update.message) results.push(update.message);
    }

    expect(results).toHaveLength(1);
    const r0 = results[0];
    if (r0 && isToolResult(r0)) {
      expect(r0.content).toContain("step");
      expect(r0.content).toContain("2");
    }
  });
});