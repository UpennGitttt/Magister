import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { initMemoryRuntime } from "../services/memory/memory-runtime";
import { runLeaderRuntime } from "../services/manager-automation/autonomous-loop/manager-autonomous-runtime";
import type {
  LeaderRuntimeCheckpoint,
  LeaderRuntimeResult,
} from "../services/manager-automation/autonomous-loop/manager-autonomous-runtime";
import type {
  SerializableExecuteToolParams,
  SerializableExecuteToolResult,
  SerializableLeaderModelCallParams,
  SerializableLeaderRuntimeConfig,
  SerializableLeaderToolDescriptor,
} from "../services/leader-runtime-worker-service";
import type {
  LeaderLoopEvent,
  LeaderModelCallParams,
  LeaderModelOutputEvent,
  LeaderTool,
} from "../services/manager-automation/autonomous-loop/autonomous-types";

const abortController = new AbortController();
process.on("SIGTERM", () => {
  abortController.abort();
});

if (import.meta.main) {
  void main();
}

export function resolveLeaderWorkerInputPath(argv: string[] = process.argv): string | undefined {
  return argv.length > 2 ? argv.at(-1) : undefined;
}

async function main(): Promise<void> {
  const inputPath = resolveLeaderWorkerInputPath();
  if (!inputPath) {
    writeError("leader worker missing input path");
    return;
  }
  // Memory runtime is per-process: the parent API server initialized
  // its own, but this worker is a separate Bun process and inherits
  // only env vars, not module state. Without this init, any code path
  // the worker hits that calls `getMemoryRuntime()` — most notably
  // `fireFailureReflection()` on a failed task — throws "runtime not
  // initialized" and stamps a `memory.extractor_error` event in the
  // DB. Mirrors the parent's resolution in server.ts:
  //   userScopeRoot = $MAGISTER_MEMORY_USER_DIR ?? homedir() + /.magister/memory
  //   projectScopeRoot = $MAGISTER_INSTALL_DIR ?? cwd + /.magister/memory
  // The worker's cwd is the task's workspace (not the repo root), so
  // we use MAGISTER_INSTALL_DIR (set by restart.sh on the parent and
  // inherited here) for projectScopeRoot to point at Magister's own
  // .magister/memory rather than the task workspace's.
  try {
    const memoryUserHome = process.env.MAGISTER_MEMORY_USER_DIR ?? homedir();
    const installDir = process.env.MAGISTER_INSTALL_DIR ?? process.cwd();
    initMemoryRuntime({
      userScopeRoot: join(memoryUserHome, ".magister", "memory"),
      projectScopeRoot: join(installDir, ".magister", "memory"),
    });
  } catch (err) {
    // Non-fatal: failing to init memory shouldn't bring the worker
    // down. The runtime call sites already wrap getMemoryRuntime()
    // failures and route them to memory.extractor_error events.
    writeJson({
      type: "warning",
      message: `memory init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    const config = JSON.parse(await readFile(inputPath, "utf8")) as SerializableLeaderRuntimeConfig;
    await run(config, join(dirname(inputPath), "rpc-responses"));
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
  }
}

async function run(config: SerializableLeaderRuntimeConfig, rpcResponseDir: string): Promise<void> {
  const rpcClient = createWorkerRpcClient(rpcResponseDir, abortController.signal);
  const tools = createProxyTools(config.toolDescriptors ?? [], rpcClient);
  try {
    const result = await runLeaderRuntime({
      ...config,
      abortController,
      tools,
      ...(typeof config.maxTurns === "number" ? { maxTurns: config.maxTurns } : {}),
      recordEvent: async (event: LeaderLoopEvent) => {
        await rpcClient.request("record_event", { event });
      },
      writeCheckpoint: async (data: LeaderRuntimeCheckpoint) => {
        await rpcClient.request("checkpoint", data);
      },
      callModel: async function* (params: LeaderModelCallParams) {
        yield* rpcClient.stream("call_model", serializeModelCallParams(params));
      },
    });
    writeResult(result);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
  }
}

function writeResult(result: LeaderRuntimeResult): void {
  writeJson({ type: "result", result });
}

function writeError(message: string): void {
  process.exitCode = 1;
  writeJson({ type: "error", message });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

type ParentRpcResponse =
  | { type: "rpc.response"; id: string; ok: true; result?: unknown }
  | { type: "rpc.response"; id: string; ok: false; error: { message: string; code?: string } };

type ParentRpcStreamEvent = {
  type: "rpc.stream_event";
  id: string;
  index: number;
  event: LeaderModelOutputEvent;
};

function createWorkerRpcClient(rpcResponseDir: string, signal: AbortSignal) {
  let nextId = 0;

  return {
    async request(method: string, params: unknown): Promise<unknown> {
      const id = `rpc_${Date.now()}_${nextId++}`;
      writeJson({ type: "rpc.request", id, method, params });
      const response = await waitForRpcResponse(join(rpcResponseDir, `${id}.json`), signal);
      if (response.ok) {
        return response.result;
      }
      throw new Error(response.error.message);
    },

    async *stream(method: string, params: unknown): AsyncGenerator<LeaderModelOutputEvent> {
      const id = `rpc_${Date.now()}_${nextId++}`;
      writeJson({ type: "rpc.request", id, method, params });
      const responsePath = join(rpcResponseDir, `${id}.json`);
      const streamDir = join(rpcResponseDir, `${id}.events`);
      let nextIndex = 0;
      let finalResponse: ParentRpcResponse | null = null;
      let delayMs = 10;

      while (!signal.aborted) {
        let progressed = false;
        while (true) {
          const eventPath = join(streamDir, `${nextIndex}.json`);
          const chunk = await tryReadRpcStreamEvent(eventPath);
          if (!chunk) break;
          if (chunk.id !== id || chunk.index !== nextIndex) {
            throw new Error(`invalid stream chunk for worker RPC ${id}`);
          }
          nextIndex++;
          progressed = true;
          yield chunk.event;
        }

        if (!finalResponse) {
          finalResponse = await tryReadRpcResponse(responsePath);
        }
        if (finalResponse) {
          if (!finalResponse.ok) {
            throw new Error(finalResponse.error.message);
          }
          const eventCount = readEventCount(finalResponse.result);
          if (nextIndex >= eventCount) {
            return;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, progressed ? 0 : delayMs));
        delayMs = progressed ? 10 : Math.min(delayMs * 2, 250);
      }
      throw new Error("leader worker RPC aborted");
    },
  };
}

async function waitForRpcResponse(path: string, signal: AbortSignal): Promise<ParentRpcResponse> {
  let delayMs = 10;
  while (!signal.aborted) {
    try {
      const response = JSON.parse(await readFile(path, "utf8")) as ParentRpcResponse;
      if (response.type === "rpc.response") {
        return response;
      }
    } catch {
      // Parent may not have written the response file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 250);
  }
  throw new Error("leader worker RPC aborted");
}

async function tryReadRpcResponse(path: string): Promise<ParentRpcResponse | null> {
  try {
    const response = JSON.parse(await readFile(path, "utf8")) as ParentRpcResponse;
    return response.type === "rpc.response" ? response : null;
  } catch {
    return null;
  }
}

async function tryReadRpcStreamEvent(path: string): Promise<ParentRpcStreamEvent | null> {
  try {
    const response = JSON.parse(await readFile(path, "utf8")) as ParentRpcStreamEvent;
    return response.type === "rpc.stream_event" ? response : null;
  } catch {
    return null;
  }
}

function readEventCount(result: unknown): number {
  if (result && typeof result === "object" && typeof (result as { eventCount?: unknown }).eventCount === "number") {
    return (result as { eventCount: number }).eventCount;
  }
  return 0;
}

function serializeModelCallParams(params: LeaderModelCallParams): SerializableLeaderModelCallParams {
  return {
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    ...(params.model ? { model: params.model } : {}),
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    tools: params.tools.map(serializeToolDescriptor),
  };
}

function serializeToolDescriptor(tool: LeaderTool): SerializableLeaderToolDescriptor {
  return {
    name: tool.name,
    ...(tool.aliases ? { aliases: tool.aliases } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputJsonSchemaOverride: serializeToolInputSchema(tool),
    concurrencySafe: readStaticToolBoolean(() => tool.isConcurrencySafe({})),
    readOnly: readStaticToolBoolean(() => tool.isReadOnly({})),
    ...(tool.isPlanSafe
      ? { planSafe: readStaticToolBoolean(() => tool.isPlanSafe?.({}) ?? false) }
      : {}),
  };
}

function serializeToolInputSchema(tool: LeaderTool): Record<string, unknown> {
  if (tool.inputJsonSchemaOverride) {
    return tool.inputJsonSchemaOverride;
  }
  try {
    const jsonSchema = z.toJSONSchema(tool.inputSchema);
    const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
    return rest;
  } catch {
    return { type: "object", properties: {} };
  }
}

function readStaticToolBoolean(fn: () => boolean): boolean {
  try {
    return Boolean(fn());
  } catch {
    return false;
  }
}

function createProxyTools(
  descriptors: readonly SerializableLeaderToolDescriptor[],
  rpcClient: ReturnType<typeof createWorkerRpcClient>,
): LeaderTool[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    ...(descriptor.aliases ? { aliases: descriptor.aliases } : {}),
    ...(descriptor.description ? { description: descriptor.description } : {}),
    inputSchema: z.record(z.string(), z.unknown()),
    ...(descriptor.inputJsonSchemaOverride
      ? { inputJsonSchemaOverride: descriptor.inputJsonSchemaOverride }
      : {}),
    call: async () => {
      throw new Error(`tool ${descriptor.name} must execute through parent RPC`);
    },
    remoteExecute: async function* (toolUse, context) {
      const result = await rpcClient.request(
        "execute_tool",
        serializeExecuteToolParams(toolUse, context),
      ) as SerializableExecuteToolResult;
      if (Array.isArray(result.events)) {
        for (const event of result.events) {
          await context.recordEvent(event);
        }
      }
      if (Array.isArray(result.updates)) {
        for (const update of result.updates) {
          yield update;
        }
      }
    },
    isConcurrencySafe: () => descriptor.concurrencySafe === true,
    isReadOnly: () => descriptor.readOnly === true,
    isPlanSafe: () => descriptor.planSafe === true,
  }));
}

function serializeExecuteToolParams(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  context: {
    messages: SerializableExecuteToolParams["context"]["messages"];
    inPlanMode?: boolean;
    alreadyAwaitingApproval?: boolean;
    planApprovedThisRun?: boolean;
    turnIndex?: number;
    currentToolUseId?: string;
    executionPolicy?: SerializableExecuteToolParams["context"]["executionPolicy"];
  },
): SerializableExecuteToolParams {
  return {
    toolUse,
    context: {
      messages: context.messages,
      ...(context.inPlanMode !== undefined ? { inPlanMode: context.inPlanMode } : {}),
      ...(context.alreadyAwaitingApproval !== undefined
        ? { alreadyAwaitingApproval: context.alreadyAwaitingApproval }
        : {}),
      ...(context.planApprovedThisRun !== undefined
        ? { planApprovedThisRun: context.planApprovedThisRun }
        : {}),
      ...(context.turnIndex !== undefined ? { turnIndex: context.turnIndex } : {}),
      ...(context.currentToolUseId !== undefined
        ? { currentToolUseId: context.currentToolUseId }
        : {}),
      // Thread executionPolicy to the parent so the parent-side tool-proxy gate
      // has the active policy when a worker-proxied tool runs via RPC.
      ...(context.executionPolicy !== undefined
        ? { executionPolicy: context.executionPolicy }
        : {}),
    },
  };
}
