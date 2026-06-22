import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChangeReviewDraft } from "../../../src/services/safe-apply/change-review-draft-service";
import type {
  RuntimeDiffArtifact,
  RuntimeSecurityMetadata,
  StaticGateResult,
} from "../../../src/services/safe-apply/safe-apply-types";

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("createChangeReviewDraft stores diff, gate, draft artifacts and a compact event", async () => {
  const artifactsDir = tempDir("safe-apply-review-draft-");
  const patchPath = join(artifactsDir, "patch.diff");
  writeFileSync(patchPath, "diff --git a/docs/a.md b/docs/a.md\n+secret patch bytes\n", "utf8");
  const artifactCreates: Array<Record<string, unknown>> = [];
  const eventCreates: Array<Record<string, unknown>> = [];
  const diffArtifact: RuntimeDiffArtifact = {
    artifactId: "artifact_runtime_diff",
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef: patchPath,
    diffHash: "abc123",
    diffAlgorithm: {
      command: ["git", "diff", "--no-color", "--binary", "--full-index", "--find-renames=50%"],
      gitVersion: "git version 2.43.0",
      hash: "sha256",
    },
    baseRevision: "base",
    changedFiles: [],
    addedLines: 1,
    removedLines: 0,
    isEmpty: false,
  };
  const runtimeSecurity: RuntimeSecurityMetadata = {
    runtimeSource: "codex",
    commandPath: "codex",
    argvFlags: ["exec", "--full-auto"],
    sandboxMode: "workspace-write",
    permissionMode: "headless",
    permissionSignals: ["argv:--full-auto"],
    envPermissionHints: [],
    runtimeWorkspaceStrategy: "git_worktree",
    executionSandbox: null,
  };
  const gate: StaticGateResult = {
    risk: "HUMAN_REQUIRED",
    reasons: [{ code: "runtime_headless", message: "Headless runtime output requires review." }],
  };

  const result = await createChangeReviewDraft({
    taskId: "task_1",
    roleRuntimeId: "runtime_1",
    workspaceId: "workspace_main",
    runtimeSecurity,
    diffArtifact,
    gate,
    mcpToolRisk: [
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
    ],
    sastAdvisory: {
      status: "findings",
      scanner: "semgrep",
      reason: null,
      command: ["semgrep", "--json", "src/a.ts"],
      durationMs: 24,
      startedAt: "2026-05-13T00:00:00.000Z",
      finishedAt: "2026-05-13T00:00:00.024Z",
      findings: [
        {
          scanner: "semgrep",
          ruleId: "rule.eval",
          severity: "warning",
          path: "src/a.ts",
          line: 1,
          message: "eval call",
          metadata: {},
        },
      ],
    },
    sideEffectWarning: {
      code: "no_code_diff_runtime_side_effects_not_audited",
      message: "No code diff was produced; runtime side effects are not audited in Phase 1.",
      observedEventTypes: ["leader.tool_call"],
    },
    verification: [],
    artifactsDir,
    createId: (() => {
      const ids = ["gate", "draft", "event"];
      let index = 0;
      return () => ids[index++] ?? `extra_${index}`;
    })(),
    now: () => new Date("2026-05-13T00:00:00.000Z"),
    artifactRepository: {
      async create(input) {
        artifactCreates.push(input as Record<string, unknown>);
      },
    },
    executionEventRepository: {
      async create(input) {
        eventCreates.push(input as Record<string, unknown>);
        return 1;
      },
    },
  });

  expect(result.draft.gate.risk).toBe("HUMAN_REQUIRED");
  expect(artifactCreates.map((artifact) => artifact.artifactType)).toEqual([
    "runtime_diff",
    "static_gate_result",
    "change_review_draft",
  ]);
  expect(eventCreates).toHaveLength(1);
  expect(eventCreates[0]).toMatchObject({
    type: "safe_apply.review_draft_created",
    artifactId: "artifact_draft",
    taskId: "task_1",
    roleRuntimeId: "runtime_1",
    workspaceId: "workspace_main",
  });
  const eventPayload = JSON.parse(String(eventCreates[0]?.payloadJson));
  expect(eventPayload).toMatchObject({
    diffArtifactId: "artifact_runtime_diff",
    gateArtifactId: "artifact_gate",
    risk: "HUMAN_REQUIRED",
    reasonCodes: ["runtime_headless"],
    diffHash: "abc123",
    mcpToolRiskCount: 1,
    sastAdvisoryStatus: "findings",
    sastFindingCount: 1,
    sideEffectWarning: "no_code_diff_runtime_side_effects_not_audited",
  });
  expect(JSON.stringify(eventPayload)).not.toContain("secret patch bytes");

  const draftArtifact = artifactCreates.find((artifact) => artifact.artifactType === "change_review_draft");
  const draftJson = JSON.parse(readFileSync(String(draftArtifact?.storageRef), "utf8"));
  expect(draftJson.runtimeSecurity.permissionMode).toBe("headless");
  expect(draftJson.mcpToolRisk).toEqual([
    expect.objectContaining({
      namespacedToolName: "mcp__github__create_issue",
      policy: "mutating",
      reason: "tool_mutating",
    }),
  ]);
  expect(draftJson.sastAdvisory).toMatchObject({
    status: "findings",
    scanner: "semgrep",
    findings: [expect.objectContaining({ ruleId: "rule.eval" })],
  });
  expect(draftJson.sideEffectWarning.observedEventTypes).toEqual(["leader.tool_call"]);
});
