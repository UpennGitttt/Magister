import {
  classifyExecutorDispatchFailure,
  isTransientExecutorDispatchFailure,
} from "../../executors/executor-adapter";

export type DispatchFailureDisposition = {
  failureClass: "transient" | "auth" | "configuration" | "state";
  retryability: boolean;
  nextAction: "reroute" | "retry" | "manual_fix";
};

export type DispatchRunFailureCode =
  | "executor_unconfigured"
  | "executor_provider_missing"
  | "executor_model_missing"
  | "executor_invocation_failed"
  | "executor_timeout"
  | "executor_auth_failed"
  | "executor_unavailable";

export type DispatchRunFailure = {
  ok: false;
  runId: string;
  adapterId: string;
  state: string;
  code: DispatchRunFailureCode;
  message: string;
  failureClass: DispatchFailureDisposition["failureClass"];
  retryability: boolean;
  nextAction: DispatchFailureDisposition["nextAction"];
};

type RuntimeDispatchState = {
  id: string;
  state: string;
  activeExecutorId?: string | null;
  currentSessionId?: string | null;
};

export function buildConfigurationBlockMessage(displayName: string, roleId: string, missing: string[]) {
  const missingList = missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
  return `Configure ${displayName} before dispatching the ${roleId} run.${missingList}`;
}

export function classifyConfigurationBlockCode(missing: string[]): DispatchRunFailureCode {
  const providerMissing = missing.some((item) =>
    item === "baseUrl" ||
    item === "auth" ||
    item === "auth.secretRef" ||
    item === "headers.secretRef" ||
    item === "provider" ||
    item === "commandPath",
  );
  const modelMissing = missing.some((item) => item === "model" || item === "configuredModel");

  if (providerMissing && !modelMissing) {
    return "executor_provider_missing";
  }

  if (modelMissing && !providerMissing) {
    return missing.includes("configuredModel") ? "executor_unconfigured" : "executor_model_missing";
  }

  return missing.includes("configuredModel") ? "executor_unconfigured" : "executor_unconfigured";
}

export function classifyDispatchFailure(code: DispatchRunFailureCode): DispatchFailureDisposition {
  const disposition = classifyExecutorDispatchFailure(code);
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

  if (code === "executor_auth_failed") {
    return {
      failureClass: "auth",
      retryability: false,
      nextAction: "manual_fix",
    };
  }

  if (disposition.failureClass === "transient") {
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

export function buildDispatchFailure(
  input: {
    runId: string;
    adapterId: string;
    code: DispatchRunFailureCode;
    message: string;
  },
): DispatchRunFailure {
  const disposition = classifyDispatchFailure(input.code);
  return {
    ok: false,
    runId: input.runId,
    adapterId: input.adapterId,
    state: "FAILED",
    code: input.code,
    message: input.message,
    failureClass: disposition.failureClass,
    retryability: disposition.retryability,
    nextAction: disposition.nextAction,
  };
}

export function buildRuntimeDispatchBlock(
  runtime: RuntimeDispatchState,
  adapterId: string,
): DispatchRunFailure | null {
  if (runtime.state === "RUNNING") {
    const executorLabel = runtime.activeExecutorId ?? adapterId;
    const sessionSuffix = runtime.currentSessionId
      ? ` Session: ${runtime.currentSessionId}.`
      : "";

    return {
      ok: false,
      runId: runtime.id,
      adapterId,
      state: "FAILED",
      code: "executor_unavailable",
      message: `Run ${runtime.id} is already running on ${executorLabel}.${sessionSuffix}`,
      failureClass: "state",
      retryability: false,
      nextAction: "manual_fix",
    };
  }

  if (runtime.state === "COMPLETED") {
    return {
      ok: false,
      runId: runtime.id,
      adapterId,
      state: "FAILED",
      code: "executor_unavailable",
      message: `Run ${runtime.id} has already completed. Create a new run before dispatching it again.`,
      failureClass: "state",
      retryability: false,
      nextAction: "manual_fix",
    };
  }

  return null;
}

export function shouldRerouteAfterDispatchFailure(code: DispatchRunFailureCode) {
  return isTransientExecutorDispatchFailure(code);
}
