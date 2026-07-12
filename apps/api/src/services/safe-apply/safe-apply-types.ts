export type PermissionMode =
  | "interactive"
  | "headless"
  | "skipped"
  | "bypassed"
  | "unknown";

export type RuntimeSource =
  | "ucm"
  | "codex"
  | "claude-code"
  | "opencode"
  | "kiro"
  | "unknown";

export type RuntimeWorkspaceStrategy =
  | "git_worktree"
  | "workspace_root"
  | "unknown";

export type ExecutionSandboxMode = "off" | "optional" | "required";

export type ExecutionSandboxProvider = "none" | "bubblewrap";

export type ExecutionSandboxProviderPreference = "auto" | ExecutionSandboxProvider;

export type ExecutionSandboxStatus =
  | "disabled"
  | "unavailable"
  | "available"
  | "active";

export type ExecutionSandboxMetadata = {
  mode: ExecutionSandboxMode;
  provider: ExecutionSandboxProvider;
  status: ExecutionSandboxStatus;
  commandPath: string | null;
  reason: string | null;
  network: "host" | "disabled" | "unknown";
  filesystem: {
    // Spec §1 V1.1 (2026-05-17): added `sandbox_writable` for the
    // same-workspace leader-bash case where the user's cwd IS the
    // writable root inside the sandbox (no separate worktree). The
    // workspace is still inside the bwrap jail (env allowlist, /tmp
    // isolation, etc.) but writes land in the user's cwd directly.
    mainWorkspace: "not_isolated" | "read_only" | "hidden" | "sandbox_writable" | "unknown";
    runtimeWorkspace: "host_writable" | "sandbox_writable" | "unknown";
    home: "host" | "isolated" | "unknown";
    tmp: "host" | "isolated" | "unknown";
  };
};

export type RuntimeSecurityMetadata = {
  runtimeSource: RuntimeSource;
  commandPath: string | null;
  argvFlags: string[];
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access" | null;
  permissionMode: PermissionMode;
  permissionSignals: string[];
  envPermissionHints: string[];
  runtimeWorkspaceStrategy: RuntimeWorkspaceStrategy;
  executionSandbox: ExecutionSandboxMetadata | null;
};

export type CliArgvMetadata = {
  runtimeSource: RuntimeSource;
  argvFlags: string[];
  permissionMode: PermissionMode;
  permissionSignals: string[];
};

export type CliArgvBuildResult = {
  argv: string[];
  argvMetadata: CliArgvMetadata;
};

export type ChangedFileSummary = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  oldPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isExecutable: boolean;
};

export type RuntimeDiffArtifact = {
  artifactId: string;
  artifactType: "runtime_diff";
  storageKind: "file";
  storageRef: string;
  diffHash: string;
  diffAlgorithm: {
    command: string[];
    gitVersion: string;
    hash: "sha256";
  };
  baseRevision: string | null;
  changedFiles: ChangedFileSummary[];
  addedLines: number;
  removedLines: number;
  isEmpty: boolean;
};

export type StaticGateRisk = "AUTO_OK" | "HUMAN_REQUIRED";

export type StaticGateReasonCode =
  | "runtime_headless"
  | "runtime_bypassed"
  | "runtime_unknown_permission"
  | "workspace_root_fallback"
  | "missing_runtime_worktree"
  | "trusted_mcp_server_called"
  | "mcp_mutating_tool_called"
  | "mcp_unknown_tool_policy"
  | "mcp_tool_unresolved"
  | "sast_advisory_finding"
  | "sast_advisory_unavailable"
  | "execution_sandbox_required"
  | "execution_sandbox_unavailable"
  | "empty_diff_with_side_effects"
  | "base_revision_unknown"
  | "high_risk_path"
  | "high_risk_content"
  | "diff_too_large"
  | "large_deletion"
  | "deleted_file"
  | "binary_or_executable"
  | "missing_verification";

export type StaticGateResult = {
  risk: StaticGateRisk;
  reasons: Array<{
    code: StaticGateReasonCode;
    message: string;
    path?: string;
    evidence?: string;
  }>;
};

export type SideEffectWarning = {
  code: "no_code_diff_runtime_side_effects_not_audited";
  message: string;
  observedEventTypes: string[];
  observedTools?: string[];
};

export type VerificationEvidence = {
  kind: "test" | "typecheck" | "lint" | "build" | "docs_not_required" | "manual_note";
  command?: string;
  exitCode?: number;
  status: "passed" | "failed" | "skipped" | "not_required" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  artifactId?: string;
};

export type McpToolRisk = {
  namespacedToolName: string;
  serverId: string | null;
  serverName: string;
  toolName: string;
  policy: "unknown" | "read_only" | "mutating";
  source: "discovered" | "manual" | "imported" | "unresolved";
  callCount: number;
  risk: "none" | "requires_review";
  reason: "tool_read_only" | "tool_mutating" | "tool_unknown" | "tool_unresolved";
};

export type SastAdvisoryFinding = {
  scanner: "semgrep" | "unknown";
  ruleId: string;
  severity: "info" | "warning" | "error" | "critical" | "unknown";
  path: string;
  line: number | null;
  message: string;
  metadata: Record<string, unknown>;
};

export type SastAdvisoryResult = {
  status: "skipped" | "passed" | "findings" | "error" | "timed_out";
  scanner: "semgrep" | "unknown" | "none";
  reason: string | null;
  findings: SastAdvisoryFinding[];
  command: string[] | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string;
};

export type ChangeReviewDraft = {
  taskId: string;
  roleRuntimeId: string | null;
  workspaceId: string;
  runtimeSecurity: RuntimeSecurityMetadata;
  diffArtifact: RuntimeDiffArtifact;
  gate: StaticGateResult;
  mcpToolRisk: McpToolRisk[];
  sastAdvisory: SastAdvisoryResult | null;
  sideEffectWarning: SideEffectWarning | null;
  verification: VerificationEvidence[];
};
