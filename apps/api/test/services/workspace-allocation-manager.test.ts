import { expect, test } from "bun:test";

import {
  resolveWorkspaceAllocationDecision,
  type WorkspaceAllocationDecisionInput,
} from "../../src/services/workspace-allocation-manager";

function createInput(
  overrides: Partial<WorkspaceAllocationDecisionInput> = {},
): WorkspaceAllocationDecisionInput {
  return {
    roleId: "coder",
    isGitRepository: true,
    worktreeIsolationEnabled: true,
    hasActiveCodingRun: false,
    workspaceDirty: false,
    requestedStrategy: null,
    ...overrides,
  };
}

test("workspace allocation defaults coder runs to git worktree", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "coder",
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "git_worktree",
    resolvedStrategy: "git_worktree",
    decisionReason: "coding_lane_default",
    fallbackReason: null,
    isolationLevel: "isolated",
  });
});

test("workspace allocation defaults architect runs to git worktree", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "architect",
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "git_worktree",
    resolvedStrategy: "git_worktree",
    decisionReason: "coding_lane_default",
    fallbackReason: null,
    isolationLevel: "isolated",
  });
});

test("workspace allocation keeps manager runs on the shared root workspace", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "leader",
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "workspace_root",
    resolvedStrategy: "workspace_root",
    decisionReason: "non_coding_lane_default",
    fallbackReason: null,
    isolationLevel: "shared",
  });
});

test("workspace allocation upgrades reviewer runs to git worktree when another coding run is active", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "reviewer",
      hasActiveCodingRun: true,
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "git_worktree",
    resolvedStrategy: "git_worktree",
    decisionReason: "active_coding_run",
    fallbackReason: null,
    isolationLevel: "isolated",
  });
});

test("workspace allocation upgrades to git worktree when the workspace is dirty", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "leader",
      workspaceDirty: true,
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "git_worktree",
    resolvedStrategy: "git_worktree",
    decisionReason: "dirty_workspace",
    fallbackReason: null,
    isolationLevel: "isolated",
  });
});

test("workspace allocation falls back to workspace root when git worktrees are unavailable", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "coder",
      isGitRepository: false,
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "git_worktree",
    resolvedStrategy: "workspace_root",
    decisionReason: "coding_lane_default",
    fallbackReason: "non_git_workspace",
    isolationLevel: "shared",
  });
});

test("workspace allocation respects an explicit workspace-root override", () => {
  const decision = resolveWorkspaceAllocationDecision(
    createInput({
      roleId: "coder",
      requestedStrategy: "workspace_root",
    }),
  );

  expect(decision).toEqual({
    requestedStrategy: "workspace_root",
    resolvedStrategy: "workspace_root",
    decisionReason: "operator_override",
    fallbackReason: null,
    isolationLevel: "shared",
  });
});
