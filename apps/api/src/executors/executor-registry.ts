import type { ApiExecutorOptions } from "./api-executor-adapter";
import { createApiExecutorAdapter } from "./api-executor-adapter";
import type { ExecutorAdapter, ExecutorSlotSnapshot } from "./executor-adapter";
import { createCodexExecutorAdapter } from "./codex-executor-adapter";
import { createOpenCodeExecutorAdapter } from "./opencode-executor-adapter";
import { createStubExecutorAdapter } from "./stub-executor-adapter";
import {
  getExecutorCapabilities,
  type ExecutorCapabilities,
} from "../services/executor-capability-service";

export type CreateExecutorAdapterOptions = Pick<ApiExecutorOptions, "providers" | "models">;

export function getExecutorCapabilitiesForSlot(
  slot: Pick<ExecutorSlotSnapshot, "adapterId">,
): ExecutorCapabilities {
  return getExecutorCapabilities(slot.adapterId);
}

export function createExecutorAdapter(
  slot: ExecutorSlotSnapshot,
  options: CreateExecutorAdapterOptions = {},
): ExecutorAdapter {
  if (slot.executionMode === "api") {
    return createApiExecutorAdapter(slot, options);
  }

  if (slot.commandPath === "__stub__") {
    return createStubExecutorAdapter(slot);
  }

  if (slot.adapterId === "codex") {
    return createCodexExecutorAdapter(slot);
  }

  if (slot.adapterId === "opencode") {
    return createOpenCodeExecutorAdapter(slot);
  }

  return createStubExecutorAdapter(slot);
}
