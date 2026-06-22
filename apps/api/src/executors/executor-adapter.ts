import { ArtifactRepository } from "../repositories/artifact-repository";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import type { RuntimeWorkspaceLease } from "../services/runtime-workspace-service";
import type { ExecutorCatalogEntry } from "./executor-catalog";

export type ExecutorSlotSnapshot = ExecutorCatalogEntry & {
  status: "configured" | "unconfigured";
  authMode?: "chatgpt" | "api_key";
  commandPath?: string;
  configuredModel?: string;
  modelRef?: string;
  providerRef?: string;
  configSource: "file" | "env" | "default";
  readiness?: {
    ready: boolean;
    missing: string[];
  };
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
};

export type ExecutorRuntimeSnapshot = {
  id: string;
  taskId: string;
  roleId: string;
  state: string;
  attemptCount: number;
  delegationMode?: string | null;
  activeExecutorId?: string | null;
  currentSessionId?: string | null;
  priorSessionId?: string | null;
  priorWorkdir?: string | null;
  resumePolicy?: string | null;
  workspaceStrategyOverride?: string | null;
  resumeAttemptedAt?: Date | null;
  resumeFailureReason?: string | null;
  startedAt?: Date | null;
  updatedAt?: Date | null;
  completedAt?: Date | null;
};

export type ExecutorTaskSnapshot = {
  id: string;
  workspaceId: string;
  source?: string | null;
  rootChannelBindingId?: string | null;
  state: string;
  title?: string;
  description?: string | null;
  updatedAt?: Date | null;
};

export type ExecutorDispatchDependencies = {
  roleRuntimeRepository: Pick<RoleRuntimeRepository, "update">;
  taskRepository: Pick<TaskRepository, "update">;
  artifactRepository: Pick<ArtifactRepository, "create" | "getById">;
  observabilityAdapter: Pick<LocalObservabilityAdapter, "recordEvent">;
};

export type ExecutorDispatchContext = {
  runtime: ExecutorRuntimeSnapshot;
  task: ExecutorTaskSnapshot;
  slot: ExecutorSlotSnapshot;
  runtimeWorkspace?: RuntimeWorkspaceLease | null;
  dependencies: ExecutorDispatchDependencies;
  now?: () => Date;
  createId?: () => string;
};

export type ExecutorDispatchSuccess = {
  ok: true;
  runId: string;
  adapterId: string;
  state: "COMPLETED";
  sessionId: string;
  artifactId: string;
};

export type ExecutorDispatchFailureCode =
  | "executor_unconfigured"
  | "executor_provider_missing"
  | "executor_model_missing"
  | "executor_invocation_failed"
  | "executor_timeout"
  | "executor_auth_failed"
  | "executor_unavailable";

export type ExecutorDispatchFailure = {
  ok: false;
  runId: string;
  adapterId: string;
  state: "FAILED";
  code: ExecutorDispatchFailureCode;
  message: string;
};

export type ExecutorDispatchFailureClass = "transient" | "auth" | "configuration";
export type ExecutorDispatchNextAction = "reroute" | "retry" | "manual_fix";

export type ExecutorDispatchFailureDisposition = {
  failureClass: ExecutorDispatchFailureClass;
  retryability: boolean;
  nextAction: ExecutorDispatchNextAction;
};

const TRANSIENT_EXECUTOR_FAILURE_CODES = new Set<ExecutorDispatchFailureCode>([
  "executor_invocation_failed",
  "executor_timeout",
  "executor_unavailable",
]);

export function classifyExecutorDispatchFailure(
  code: ExecutorDispatchFailureCode,
): ExecutorDispatchFailureDisposition {
  if (code === "executor_auth_failed") {
    return {
      failureClass: "auth",
      retryability: false,
      nextAction: "manual_fix",
    };
  }

  if (
    code === "executor_unconfigured" ||
    code === "executor_provider_missing" ||
    code === "executor_model_missing"
  ) {
    return {
      failureClass: "configuration",
      retryability: false,
      nextAction: "manual_fix",
    };
  }

  if (TRANSIENT_EXECUTOR_FAILURE_CODES.has(code)) {
    return {
      failureClass: "transient",
      retryability: true,
      nextAction: "reroute",
    };
  }

  return {
    failureClass: "configuration",
    retryability: false,
    nextAction: "manual_fix",
  };
}

export function isTransientExecutorDispatchFailure(code: ExecutorDispatchFailureCode) {
  return TRANSIENT_EXECUTOR_FAILURE_CODES.has(code);
}

export type ExecutorDispatchResult = ExecutorDispatchSuccess | ExecutorDispatchFailure;

export interface ExecutorAdapter {
  readonly slot: ExecutorSlotSnapshot;
  execute(context: ExecutorDispatchContext): Promise<ExecutorDispatchResult>;
}
