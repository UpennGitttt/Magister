import type { ExecutionSandboxMode } from "./safe-apply/safe-apply-types";

export type LeaderSafeApplyMode = "off" | "optional" | "required";
export type LeaderWorkerMode = "off" | "optional" | "required";

export type LeaderRuntimeWorkspaceStatus = {
  status: "main_workspace" | "isolated_worktree" | "failed";
  workspaceDir: string;
  baseWorkspaceDir: string | null;
  failureReason?: string;
};

export type LeaderWorkerProcessStatus = {
  status: "not_requested" | "active" | "fallback" | "failed";
  failureReason?: string;
};

export type LeaderWorkerSandboxStatus = {
  status: "not_requested" | "active" | "fallback" | "failed";
  provider: "none" | "bubblewrap" | "unknown";
  network: "host" | "disabled";
  failureReason?: string;
};

export type LeaderHardeningStatus = {
  safeApplyMode: LeaderSafeApplyMode;
  workerMode: LeaderWorkerMode;
  executionSandboxMode: ExecutionSandboxMode;
  runtimeWorkspace: LeaderRuntimeWorkspaceStatus;
  workerProcess: LeaderWorkerProcessStatus;
  workerSandbox: LeaderWorkerSandboxStatus;
};

export function createInitialLeaderHardeningStatus(input: {
  safeApplyMode: LeaderSafeApplyMode;
  workerMode: LeaderWorkerMode;
  executionSandboxMode: ExecutionSandboxMode;
  executionSandboxNetwork: "host" | "disabled" | "unknown";
  workspaceDir: string;
}): LeaderHardeningStatus {
  return {
    safeApplyMode: input.safeApplyMode,
    workerMode: input.workerMode,
    executionSandboxMode: input.executionSandboxMode,
    runtimeWorkspace: {
      status: "main_workspace",
      workspaceDir: input.workspaceDir,
      baseWorkspaceDir: null,
    },
    workerProcess: {
      status: input.workerMode === "off" ? "not_requested" : "fallback",
    },
    workerSandbox: {
      status: "not_requested",
      provider: "none",
      network: normalizeNetwork(input.executionSandboxNetwork),
    },
  };
}

export function normalizeNetwork(value: "host" | "disabled" | "unknown"): "host" | "disabled" {
  return value === "disabled" ? "disabled" : "host";
}
