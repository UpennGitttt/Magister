import { getDefaultRoleRoutingForRole } from "../../executors/executor-catalog";
import { getExecutorSlotList } from "../executor-slot-service";
import {
  getExecutorReadiness,
  readExecutorConfigFile,
  resolveExecutorConfiguration,
} from "../executor-config-service";

type ExecutorSlot = NonNullable<Awaited<ReturnType<typeof getExecutorSlotList>>[number]>;

export type ResolvedDispatchTarget = {
  slot: ExecutorSlot;
  resolved: ReturnType<typeof resolveExecutorConfiguration>;
  readiness: ReturnType<typeof getExecutorReadiness>;
  routeSource: "primary" | "fallback" | "default";
};

export function resolveDispatchTargets(input: {
  adapterId: string;
  strategy?: "agent_only" | "prefer_agent" | "fallback_model" | "model_only";
  fallbackAdapterId?: string;
  roleId: string;
  config: Awaited<ReturnType<typeof readExecutorConfigFile>>;
  executorSlots: Awaited<ReturnType<typeof getExecutorSlotList>>;
}): ResolvedDispatchTarget[] {
  const { adapterId, roleId, config, executorSlots } = input;

  const buildTarget = (
    targetAdapterId: string,
    routeSource: ResolvedDispatchTarget["routeSource"],
  ): ResolvedDispatchTarget | null => {
    const slot = executorSlots.find((item) => item.adapterId === targetAdapterId);
    if (!slot) {
      return null;
    }

    const envConfiguredModel = process.env[slot.configKey]?.trim();
    const resolved = resolveExecutorConfiguration(config, slot.adapterId, envConfiguredModel);
    const readiness = getExecutorReadiness(config, slot.adapterId, process.env);
    return {
      slot,
      resolved,
      readiness,
      routeSource,
    };
  };

  const candidates: Array<{ adapterId: string; routeSource: ResolvedDispatchTarget["routeSource"] }> = [];
  const appendCandidate = (
    candidateAdapterId: string | undefined,
    routeSource: ResolvedDispatchTarget["routeSource"],
  ) => {
    if (!candidateAdapterId) {
      return;
    }
    if (candidates.some((item) => item.adapterId === candidateAdapterId)) {
      return;
    }
    candidates.push({
      adapterId: candidateAdapterId,
      routeSource,
    });
  };

  const defaultRoute = getDefaultRoleRoutingForRole(roleId);
  const strategy = input.strategy ?? defaultRoute?.strategy ?? "agent_only";
  const fallbackAdapterId = input.fallbackAdapterId ?? defaultRoute?.fallbackAdapterId;

  appendCandidate(adapterId, "primary");

  if (
    (strategy === "fallback_model" || strategy === "prefer_agent") &&
    fallbackAdapterId &&
    fallbackAdapterId !== adapterId
  ) {
    appendCandidate(fallbackAdapterId, "fallback");
  }

  if (defaultRoute?.adapterId && defaultRoute.adapterId !== adapterId) {
    appendCandidate(defaultRoute.adapterId, "default");
  }

  if (roleId === "leader" && adapterId === "model") {
    const managerCodingAgentFallbacks = executorSlots
      .filter(
        (slot) =>
          slot.adapterId !== adapterId &&
          slot.executorType === "coding_agent" &&
          slot.roleTargets.some((targetRoleId) => targetRoleId === roleId),
      )
      .sort((left, right) => {
        const leftPriority = left.adapterId === "codex" ? 0 : 1;
        const rightPriority = right.adapterId === "codex" ? 0 : 1;
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }

        return left.adapterId.localeCompare(right.adapterId);
      });

    for (const slot of managerCodingAgentFallbacks) {
      appendCandidate(slot.adapterId, "default");
    }
  }

  return candidates
    .map((candidate) => buildTarget(candidate.adapterId, candidate.routeSource))
    .filter((candidate): candidate is ResolvedDispatchTarget => Boolean(candidate));
}

export function toDispatchSlot(target: ResolvedDispatchTarget) {
  return {
    ...target.slot,
    executionMode: target.resolved.executionMode ?? target.slot.executionMode,
    ...(target.resolved.authMode ? { authMode: target.resolved.authMode } : {}),
    ...(target.resolved.commandPath ? { commandPath: target.resolved.commandPath } : {}),
    ...(target.resolved.configuredModel ? { configuredModel: target.resolved.configuredModel } : {}),
    ...(target.resolved.modelRef ? { modelRef: target.resolved.modelRef } : {}),
    ...(target.resolved.providerRef ? { providerRef: target.resolved.providerRef } : {}),
    ...(target.resolved.sandboxMode ? { sandboxMode: target.resolved.sandboxMode } : {}),
    ...(target.resolved.timeoutMs ? { timeoutMs: target.resolved.timeoutMs } : {}),
  };
}
