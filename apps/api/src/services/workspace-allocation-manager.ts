export type WorkspaceAllocationStrategy = "workspace_root" | "git_worktree";

export type WorkspaceAllocationDecisionReason =
  | "coding_lane_default"
  | "non_coding_lane_default"
  | "active_coding_run"
  | "dirty_workspace"
  | "operator_override";

export type WorkspaceAllocationFallbackReason =
  | "non_git_workspace"
  | "worktree_isolation_disabled";

export type WorkspaceAllocationDecisionInput = {
  roleId: string;
  isGitRepository: boolean;
  worktreeIsolationEnabled: boolean;
  hasActiveCodingRun: boolean;
  workspaceDirty: boolean;
  requestedStrategy: WorkspaceAllocationStrategy | null;
};

export type WorkspaceAllocationDecision = {
  requestedStrategy: WorkspaceAllocationStrategy;
  resolvedStrategy: WorkspaceAllocationStrategy;
  decisionReason: WorkspaceAllocationDecisionReason;
  fallbackReason: WorkspaceAllocationFallbackReason | null;
  isolationLevel: "shared" | "isolated";
};

const CODING_ROLE_IDS = new Set(["architect", "coder", "lander"]);

function toIsolationLevel(
  strategy: WorkspaceAllocationStrategy,
): WorkspaceAllocationDecision["isolationLevel"] {
  return strategy === "git_worktree" ? "isolated" : "shared";
}

export function resolveWorkspaceAllocationDecision(
  input: WorkspaceAllocationDecisionInput,
): WorkspaceAllocationDecision {
  if (input.requestedStrategy === "workspace_root") {
    return {
      requestedStrategy: "workspace_root",
      resolvedStrategy: "workspace_root",
      decisionReason: "operator_override",
      fallbackReason: null,
      isolationLevel: "shared",
    };
  }

  let requestedStrategy: WorkspaceAllocationStrategy;
  let decisionReason: WorkspaceAllocationDecisionReason;

  if (input.requestedStrategy === "git_worktree") {
    requestedStrategy = "git_worktree";
    decisionReason = "operator_override";
  } else if (input.workspaceDirty) {
    requestedStrategy = "git_worktree";
    decisionReason = "dirty_workspace";
  } else if (input.hasActiveCodingRun) {
    requestedStrategy = "git_worktree";
    decisionReason = "active_coding_run";
  } else if (CODING_ROLE_IDS.has(input.roleId)) {
    requestedStrategy = "git_worktree";
    decisionReason = "coding_lane_default";
  } else {
    requestedStrategy = "workspace_root";
    decisionReason = "non_coding_lane_default";
  }

  if (requestedStrategy === "git_worktree" && !input.worktreeIsolationEnabled) {
    return {
      requestedStrategy,
      resolvedStrategy: "workspace_root",
      decisionReason,
      fallbackReason: "worktree_isolation_disabled",
      isolationLevel: "shared",
    };
  }

  if (requestedStrategy === "git_worktree" && !input.isGitRepository) {
    return {
      requestedStrategy,
      resolvedStrategy: "workspace_root",
      decisionReason,
      fallbackReason: "non_git_workspace",
      isolationLevel: "shared",
    };
  }

  return {
    requestedStrategy,
    resolvedStrategy: requestedStrategy,
    decisionReason,
    fallbackReason: null,
    isolationLevel: toIsolationLevel(requestedStrategy),
  };
}
