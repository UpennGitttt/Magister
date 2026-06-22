import { readFile } from "node:fs/promises";

import type {
  McpToolRisk,
  RuntimeDiffArtifact,
  RuntimeSecurityMetadata,
  SastAdvisoryResult,
  StaticGateReasonCode,
  StaticGateResult,
  VerificationEvidence,
} from "./safe-apply-types";

type StaticGateInput = {
  runtimeSecurity: RuntimeSecurityMetadata;
  diffArtifact: RuntimeDiffArtifact;
  verification: VerificationEvidence[];
  mcpToolRisk?: McpToolRisk[];
  sastAdvisory?: SastAdvisoryResult | null;
  trustedMcpServerCalled?: boolean;
  observedSideEffectEventTypes?: string[];
};

function reason(code: StaticGateReasonCode, message: string, path?: string, evidence?: string) {
  return {
    code,
    message,
    ...(path ? { path } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function hasVerification(verification: VerificationEvidence[]) {
  return verification.some((item) => item.status === "passed" || item.status === "not_required");
}

function isLowRiskPath(path: string) {
  return (
    path.startsWith("docs/") ||
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path.endsWith(".css") ||
    path.includes("/test/") ||
    path.includes("/tests/") ||
    path.includes(".test.")
  );
}

// Exported as the canonical "this path is high-risk and
// MUST receive human review" classifier. The review-assignment-router
// (RFC `2026-05-24-leader-review-autonomy.md` §5.2) consumes this
// same function so that the two policy surfaces (static-gate's
// reasons + the new router's assignee decision) cannot drift apart.
// Adding a new pattern here REQUIRES a matching fixture in
// `apps/api/test/services/safe-apply/is-high-risk-path.test.ts`
// — the test enumerates every branch so a silent removal or
// regression in the pattern set fails CI.
export function isHighRiskPath(path: string) {
  const normalized = path.toLowerCase();
  return (
    normalized === "config/secrets.json" ||
    normalized === "package.json" ||
    normalized.includes("/auth") ||
    normalized.includes("authorization") ||
    normalized.includes("approval") ||
    normalized.includes("permission") ||
    normalized.includes("sandbox") ||
    normalized.includes("shell") ||
    normalized.includes("/tool") ||
    normalized.includes("/mcp") ||
    normalized.includes("agent-resolution") ||
    normalized.includes("runtime-workspace") ||
    normalized.includes("worktree") ||
    normalized.includes("executor") ||
    normalized.includes("manager-automation/autonomous-loop") ||
    normalized.startsWith("packages/db/") ||
    normalized.includes("schema") ||
    normalized.includes("migration") ||
    normalized.startsWith(".magister") ||
    normalized.startsWith(".ssh") ||
    normalized.startsWith(".aws") ||
    normalized.includes(".netrc") ||
    (normalized.startsWith(".env") && !normalized.includes("example") && !normalized.includes("template"))
  );
}

function highRiskContentEvidence(patchText: string) {
  const checks: Array<[RegExp, string]> = [
    [/\beval\s*\(/i, "eval("],
    [/\bexec\s*\(/i, "exec("],
    [/child_process/i, "child_process"],
    [/\bspawn\s*\(/i, "spawn("],
    [/curl\s+[^|\n]*\|\s*(?:sh|bash)/i, "curl pipe shell"],
    [/wget\s+[^|\n]*\|\s*(?:sh|bash)/i, "wget pipe shell"],
    [/chmod\s+777/i, "chmod 777"],
    [/DROP\s+TABLE/i, "DROP TABLE"],
    [/TRUNCATE\s+TABLE/i, "TRUNCATE TABLE"],
    [/DELETE\s+FROM(?![\s\S]{0,120}\bWHERE\b)/i, "DELETE FROM without nearby WHERE"],
    [/dangerously-/i, "dangerously-"],
    [/skip-permission/i, "skip-permission"],
    [/bypass-approvals/i, "bypass-approvals"],
    [/>+\s*\/(?:etc|usr|bin|sbin|var)\//i, "shell redirection into system path"],
  ];
  return checks.find(([pattern]) => pattern.test(patchText))?.[1] ?? null;
}

export async function classifyStaticGate(input: StaticGateInput): Promise<StaticGateResult> {
  const reasons: StaticGateResult["reasons"] = [];
  const permissionMode = input.runtimeSecurity.permissionMode;

  if (permissionMode === "headless") {
    reasons.push(reason("runtime_headless", "Headless runtime output requires human review."));
  } else if (permissionMode === "bypassed" || permissionMode === "skipped") {
    reasons.push(reason("runtime_bypassed", "Runtime permission checks were bypassed or skipped."));
  } else if (permissionMode === "unknown") {
    reasons.push(reason("runtime_unknown_permission", "Runtime permission mode could not be classified."));
  }

  if (input.runtimeSecurity.sandboxMode === "danger-full-access") {
    reasons.push(reason("runtime_bypassed", "danger-full-access sandbox mode requires human review."));
  }

  if (input.runtimeSecurity.runtimeWorkspaceStrategy === "workspace_root") {
    reasons.push(reason("workspace_root_fallback", "Workspace root runtime output may include non-agent changes."));
  } else if (input.runtimeSecurity.runtimeWorkspaceStrategy === "unknown") {
    reasons.push(reason("missing_runtime_worktree", "Runtime worktree strategy is unknown."));
  }

  const executionSandbox = input.runtimeSecurity.executionSandbox ?? null;
  if (executionSandbox?.mode === "required" && executionSandbox.status !== "active") {
    reasons.push(reason(
      "execution_sandbox_required",
      "Execution sandbox is required but is not active.",
      undefined,
      [
        executionSandbox.provider,
        executionSandbox.status,
        executionSandbox.reason,
      ].filter(Boolean).join(":"),
    ));
  }

  if (input.diffArtifact.baseRevision === null) {
    reasons.push(reason("base_revision_unknown", "Base revision could not be determined."));
  }

  if (input.mcpToolRisk !== undefined) {
    for (const item of input.mcpToolRisk) {
      if (item.reason === "tool_mutating") {
        reasons.push(reason(
          "mcp_mutating_tool_called",
          "A mutating MCP tool was called.",
          undefined,
          item.namespacedToolName,
        ));
      } else if (item.reason === "tool_unknown") {
        reasons.push(reason(
          "mcp_unknown_tool_policy",
          "An MCP tool with unknown safety policy was called.",
          undefined,
          item.namespacedToolName,
        ));
      } else if (item.reason === "tool_unresolved") {
        reasons.push(reason(
          "mcp_tool_unresolved",
          "An MCP tool call could not be resolved to one configured server/tool policy.",
          undefined,
          item.namespacedToolName,
        ));
      }
    }
  } else if (input.trustedMcpServerCalled) {
    reasons.push(reason("trusted_mcp_server_called", "A trusted MCP server was called; Phase 1 treats this as mutating."));
  }

  if (input.sastAdvisory?.status === "findings") {
    const count = input.sastAdvisory.findings.length;
    reasons.push(reason(
      "sast_advisory_finding",
      "SAST advisory reported findings.",
      undefined,
      `${input.sastAdvisory.scanner}: ${count} finding${count === 1 ? "" : "s"}`,
    ));
  } else if (input.sastAdvisory?.status === "error" || input.sastAdvisory?.status === "timed_out") {
    reasons.push(reason(
      "sast_advisory_unavailable",
      "Configured SAST advisory scanner did not complete successfully.",
      undefined,
      input.sastAdvisory.reason ?? input.sastAdvisory.status,
    ));
  }

  if (input.diffArtifact.isEmpty && (input.observedSideEffectEventTypes?.length ?? 0) > 0) {
    reasons.push(reason(
      "empty_diff_with_side_effects",
      "No code diff was produced, but runtime side effects were observed.",
      undefined,
      input.observedSideEffectEventTypes?.join(", "),
    ));
  }

  if (input.diffArtifact.changedFiles.length > 5 || input.diffArtifact.addedLines + input.diffArtifact.removedLines > 200) {
    reasons.push(reason("diff_too_large", "Diff exceeds Phase 1 automatic-review size limits."));
  }

  for (const file of input.diffArtifact.changedFiles) {
    if (isHighRiskPath(file.path)) {
      reasons.push(reason("high_risk_path", "Diff touches a high-risk path.", file.path));
    }
    if (file.deletions > 50) {
      reasons.push(reason("large_deletion", "File deletes more than 50 lines.", file.path));
    }
    if (file.status === "deleted") {
      reasons.push(reason("deleted_file", "Diff deletes a file.", file.path));
    }
    if (file.isBinary || file.isExecutable) {
      reasons.push(reason("binary_or_executable", "Diff touches a binary or executable file.", file.path));
    }
  }

  const patchText = await readFile(input.diffArtifact.storageRef, "utf8").catch(() => "");
  const contentEvidence = highRiskContentEvidence(patchText);
  if (contentEvidence) {
    reasons.push(reason("high_risk_content", "Diff contains high-risk content.", undefined, contentEvidence));
  }

  if (!hasVerification(input.verification)) {
    reasons.push(reason("missing_verification", "No passing or not-required verification evidence was recorded."));
  }

  const lowRiskOnly = input.diffArtifact.changedFiles.every((file) => isLowRiskPath(file.path));
  if (reasons.length === 0 && lowRiskOnly) {
    return { risk: "AUTO_OK", reasons: [] };
  }

  return {
    risk: "HUMAN_REQUIRED",
    reasons: reasons.length === 0
      ? [reason("missing_verification", "Diff is outside Phase 1 low-risk auto-OK categories.")]
      : reasons,
  };
}
