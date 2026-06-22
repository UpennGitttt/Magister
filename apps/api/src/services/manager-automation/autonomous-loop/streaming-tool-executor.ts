import type {
  LeaderTool,
  LeaderToolUseContext,
  LeaderMessage,
  LeaderAssistantMessage,
  MessageUpdate,
  ToolUseBlock,
} from "./autonomous-types";
import { findToolByName } from "./tool-registry";
import { runToolUse } from "./tool-execution";
import { createChildAbortController } from "../../../utils/abortController";

type ToolStatus = "queued" | "executing" | "completed" | "yielded";

type TrackedTool = {
  id: string;
  block: ToolUseBlock;
  assistantMessage: LeaderAssistantMessage;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  promise?: Promise<void>;
  results?: LeaderMessage[];
  pendingProgress: LeaderMessage[];
  contextModifiers?: Array<(context: LeaderToolUseContext) => LeaderToolUseContext>;
};

export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private toolUseContext: LeaderToolUseContext;
  private hasErrored = false;
  private erroredToolDescription = "";
  private siblingAbortController: AbortController;
  private discarded = false;
  private progressAvailableResolve?: (() => void) | undefined;

  constructor(
    private readonly toolDefinitions: readonly LeaderTool[],
    toolUseContext: LeaderToolUseContext
  ) {
    this.toolUseContext = toolUseContext;
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController
    );
  }

  discard(): void {
    this.discarded = true;
  }

  addTool(block: ToolUseBlock, assistantMessage: LeaderAssistantMessage): void {
    const existing = this.tools.find((t) => t.id === block.id);
    if (existing && existing.status === "queued") {
      existing.block = block;
      existing.assistantMessage = assistantMessage;
      return;
    }
    if (existing) {
      return;
    }

    const toolDefinition = findToolByName(this.toolDefinitions, block.name);
    if (!toolDefinition) {
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: "completed",
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          {
            type: "tool_result",
            toolUseId: block.id,
            content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
            isError: true,
          },
        ],
      });
      return;
    }

    const isConcurrencySafe = (() => {
      try {
        return Boolean(toolDefinition.isConcurrencySafe(block.input));
      } catch {
        return false;
      }
    })();

    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: "queued",
      isConcurrencySafe,
      pendingProgress: [],
    });

    void this.processQueue();
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter((t) => t.status === "executing");
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every((t) => t.isConcurrencySafe))
    );
  }

  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool);
      } else {
        if (!tool.isConcurrencySafe) break;
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: "sibling_error" | "user_interrupted" | "streaming_fallback"
  ): LeaderMessage {
    const messages: Record<string, string> = {
      user_interrupted: "User rejected tool use",
      streaming_fallback: "Streaming fallback - tool execution discarded",
      sibling_error: this.erroredToolDescription
        ? `Cancelled: parallel tool call ${this.erroredToolDescription} errored`
        : "Cancelled: parallel tool call errored",
    };
    return {
      type: "tool_result",
      toolUseId,
      content: `<tool_use_error>${messages[reason]}</tool_use_error>`,
      isError: true,
    };
  }

  private getAbortReason(
    tool: TrackedTool
  ): "sibling_error" | "user_interrupted" | "streaming_fallback" | null {
    if (this.discarded) return "streaming_fallback";
    if (this.hasErrored) return "sibling_error";
    if (this.toolUseContext.abortController.signal.aborted) {
      const behavior = this.getToolInterruptBehavior(tool);
      if (behavior === "block") return null;
      return "user_interrupted";
    }
    return null;
  }

  private getToolInterruptBehavior(tool: TrackedTool): "cancel" | "block" {
    const toolDefinition = findToolByName(this.toolDefinitions, tool.block.name);
    if (toolDefinition?.interruptBehavior) {
      return toolDefinition.interruptBehavior();
    }
    return "cancel";
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input;
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? "";
    if (typeof summary === "string" && summary.length > 0) {
      const truncated = summary.length > 40 ? summary.slice(0, 40) + "\u2026" : summary;
      return `${tool.block.name}(${truncated})`;
    }
    return tool.block.name;
  }

  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = "executing";
    this.toolUseContext.setInProgressToolUseIDs((prev) => new Set(prev).add(tool.id));

    const messages: LeaderMessage[] = [];
    const contextModifiers: Array<(context: LeaderToolUseContext) => LeaderToolUseContext> = [];

    const collectResults = async () => {
      const initialAbortReason = this.getAbortReason(tool);
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(tool.id, initialAbortReason)
        );
        tool.results = messages;
        tool.contextModifiers = contextModifiers;
        tool.status = "completed";
        return;
      }

      const toolAbortController = createChildAbortController(this.siblingAbortController);
      toolAbortController.signal.addEventListener(
        "abort",
        () => {
          if (
            toolAbortController.signal.reason !== "sibling_error" &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(toolAbortController.signal.reason);
          }
        },
        { once: true }
      );

      const toolContext = {
        ...this.toolUseContext,
        abortController: toolAbortController,
      };

      let thisToolErrored = false;

      for await (const update of runToolUse(tool.block, this.toolDefinitions, toolContext)) {
        const abortReason = this.getAbortReason(tool);
        if (abortReason && !thisToolErrored) {
          messages.push(
            this.createSyntheticErrorMessage(tool.id, abortReason)
          );
          break;
        }

        const isErrorResult =
          update.message?.type === "tool_result" && update.message.isError;

        if (isErrorResult) {
          thisToolErrored = true;
          if (tool.block.name === "bash") {
            this.hasErrored = true;
            this.erroredToolDescription = this.getToolDescription(tool);
            this.siblingAbortController.abort("sibling_error");
          }
        }

        if (update.message) {
          if (update.message.type === "progress") {
            tool.pendingProgress.push(update.message);
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve();
              this.progressAvailableResolve = undefined;
            }
          } else {
            messages.push(update.message);
          }
        }
        if (update.newContext) {
          contextModifiers.push(() => update.newContext!);
        }
      }

      tool.results = messages;
      tool.contextModifiers = contextModifiers;
      tool.status = "completed";

      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext);
        }
      }
    };

    const promise = collectResults();
    tool.promise = promise;

    void promise.finally(() => {
      void this.processQueue();
    });
  }

  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) return;

    for (const tool of this.tools) {
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!;
        yield { message: progressMessage, newContext: this.toolUseContext };
      }

      if (tool.status === "yielded") continue;

      if (tool.status === "completed" && tool.results) {
        tool.status = "yielded";

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext };
        }

        this.markToolUseAsComplete(tool.id);
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        break;
      }
    }
  }

  private hasPendingProgress(): boolean {
    return this.tools.some((t) => t.pendingProgress.length > 0);
  }

  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) return;

    while (this.hasUnfinishedTools()) {
      await this.processQueue();

      for (const result of this.getCompletedResults()) {
        yield result;
      }

      if (this.hasExecutingTools() && !this.hasCompletedResults() && !this.hasPendingProgress()) {
        const executingPromises = this.tools
          .filter((t) => t.status === "executing" && t.promise)
          .map((t) => t.promise!);

        const progressPromise = new Promise<void>((resolve: () => void) => {
          this.progressAvailableResolve = resolve;
        });

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise]);
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  private hasCompletedResults(): boolean {
    return this.tools.some((t) => t.status === "completed");
  }

  private hasExecutingTools(): boolean {
    return this.tools.some((t) => t.status === "executing");
  }

  private hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== "yielded");
  }

  getUpdatedContext(): LeaderToolUseContext {
    return this.toolUseContext;
  }

  private markToolUseAsComplete(toolUseId: string): void {
    this.toolUseContext.setInProgressToolUseIDs((prev) => {
      const next = new Set(prev);
      next.delete(toolUseId);
      return next;
    });
  }
}
