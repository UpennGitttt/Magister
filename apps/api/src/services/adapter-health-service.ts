import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { KNOWN_EXECUTOR_SLOTS } from "./executor-slot-service";
import { getExecutorCircuitState } from "./executor-circuit-breaker-service";

function parseMessage(payloadJson?: string | null) {
  if (!payloadJson) {
    return undefined;
  }

  try {
    const payload = JSON.parse(payloadJson) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }
  } catch {}

  return undefined;
}

export type AdapterHealthResource = {
  adapterId: string;
  displayName: string;
  healthState: "idle" | "active" | "degraded";
  activeSessionCount: number;
  circuitState: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  circuitOpenUntil?: string;
  lastError?: string;
};

export async function getAdapterHealthList(): Promise<AdapterHealthResource[]> {
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const executionEventRepository = new ExecutionEventRepository();

  const [runtimes, events] = await Promise.all([
    roleRuntimeRepository.listAll(),
    executionEventRepository.listAll(),
  ]);

  const now = new Date();
  return await Promise.all(KNOWN_EXECUTOR_SLOTS.map(async (adapter) => {
    const adapterRuntimes = runtimes.filter(
      (runtime) => runtime.activeExecutorId === adapter.adapterId,
    );
    const runtimeIds = new Set(adapterRuntimes.map((runtime) => runtime.id));
    const latestErrorEvent = [...events]
      .filter(
        (event) =>
          event.roleRuntimeId &&
          runtimeIds.has(event.roleRuntimeId) &&
          event.severity === "error",
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];

    const activeSessionCount = adapterRuntimes.filter(
      (runtime) =>
        Boolean(runtime.currentSessionId) &&
        runtime.state !== "COMPLETED" &&
        runtime.state !== "FAILED",
    ).length;
    const circuit = await getExecutorCircuitState(adapter.adapterId, { now });

    return {
      adapterId: adapter.adapterId,
      displayName: adapter.displayName,
      healthState:
        latestErrorEvent || circuit.state === "open" || circuit.state === "half_open"
          ? "degraded"
          : activeSessionCount > 0
            ? "active"
            : "idle",
      activeSessionCount,
      circuitState: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      ...(circuit.openUntil ? { circuitOpenUntil: circuit.openUntil } : {}),
      ...(latestErrorEvent
        ? {
            lastError:
              parseMessage(latestErrorEvent.payloadJson) ?? latestErrorEvent.type,
          }
        : {}),
    };
  }));
}
