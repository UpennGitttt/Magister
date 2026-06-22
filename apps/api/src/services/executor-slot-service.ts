import { EXECUTOR_CATALOG, type ExecutorCatalogEntry } from "../executors/executor-catalog";
import type { ExecutorSlotSnapshot } from "../executors/executor-adapter";
import {
  getExecutorReadiness,
  readExecutorConfigFile,
  resolveExecutorConfiguration,
} from "./executor-config-service";

export const KNOWN_EXECUTOR_SLOTS: readonly ExecutorCatalogEntry[] = EXECUTOR_CATALOG;

export type ExecutorSlotResource = ExecutorSlotSnapshot;

export async function getExecutorSlotList(): Promise<ExecutorSlotResource[]> {
  const config = await readExecutorConfigFile();

  return KNOWN_EXECUTOR_SLOTS.map((slot) => {
    const envConfiguredModel = process.env[slot.configKey]?.trim();
    const resolved = resolveExecutorConfiguration(config, slot.adapterId, envConfiguredModel);
    const configuredModel = resolved.configuredModel;
    const executionMode = resolved.executionMode ?? slot.executionMode;
    const executorType: ExecutorCatalogEntry["executorType"] =
      slot.executorType === "model" ? "model" : "coding_agent";

    const resource: ExecutorSlotResource = {
      adapterId: slot.adapterId,
      displayName: slot.displayName,
      executorType,
      roleTargets: [...slot.roleTargets],
      configKey: slot.configKey,
      executionMode,
      status: configuredModel ? "configured" : "unconfigured",
      configSource: resolved.configSource,
      readiness: getExecutorReadiness(config, slot.adapterId),
      ...(resolved.modelRef ? { modelRef: resolved.modelRef } : {}),
      ...(resolved.providerRef ? { providerRef: resolved.providerRef } : {}),
      ...(resolved.authMode ? { authMode: resolved.authMode } : {}),
      ...(resolved.commandPath ? { commandPath: resolved.commandPath } : {}),
      ...(configuredModel ? { configuredModel } : {}),
      ...(resolved.sandboxMode ? { sandboxMode: resolved.sandboxMode } : {}),
      ...(resolved.timeoutMs ? { timeoutMs: resolved.timeoutMs } : {}),
      notes: slot.notes,
    };

    return resource;
  });
}
