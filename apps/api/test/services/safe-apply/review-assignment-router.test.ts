// 2026-05-24 — Phase 1 (§5.2) router unit tests. Each branch of
// `routeAssignment` gets at least one test. The high-risk-path branch
// already has its own per-pattern fixture file
// (`is-high-risk-path.test.ts`); these tests focus on:
//   - workspace policy modes (hitl vs leader-driven)
//   - policy version forwards-compat
//   - sandbox / permission-mode escalations
//   - additive always_escalate paths

import { describe, expect, test } from "bun:test";

import {
  parseWorkspacePolicy,
  routeAssignment,
  type RouteAssignmentInput,
} from "../../../src/services/safe-apply/review-assignment-router";

const SAFE_INPUT: RouteAssignmentInput = {
  // a benign frontend-only change — none of these touch isHighRiskPath
  changedFilesJson: JSON.stringify([
    { path: "apps/web/src/components/Button.tsx" },
    { path: "apps/web/src/components/Button.test.tsx" },
  ]),
  permissionMode: "approval",
  sandboxMode: "workspace-write",
  runtimeWorkspaceStrategy: "isolated_worktree",
};

const HIGH_RISK_INPUT: RouteAssignmentInput = {
  changedFilesJson: JSON.stringify([
    { path: "apps/api/src/auth/login.ts" },
  ]),
  permissionMode: "approval",
  sandboxMode: "workspace-write",
  runtimeWorkspaceStrategy: "isolated_worktree",
};

describe("parseWorkspacePolicy", () => {
  test("null defaults to hitl/v1", () => {
    expect(parseWorkspacePolicy(null)).toEqual({ version: 1, mode: "hitl" });
  });

  test("malformed JSON falls back to hitl/v1", () => {
    expect(parseWorkspacePolicy("{not json")).toEqual({ version: 1, mode: "hitl" });
  });

  test("recognises leader-driven mode", () => {
    expect(parseWorkspacePolicy('{"version":1,"mode":"leader-driven"}')).toEqual({
      version: 1,
      mode: "leader-driven",
    });
  });

  test("unknown mode falls back to hitl", () => {
    expect(parseWorkspacePolicy('{"version":1,"mode":"bypass"}')).toEqual({
      version: 1,
      mode: "hitl",
    });
  });

  test("future policy version forces hitl (Q11 forwards-compat)", () => {
    expect(parseWorkspacePolicy('{"version":99,"mode":"leader-driven"}').mode).toBe("hitl");
  });

  test("alwaysEscalatePaths array is passed through", () => {
    const parsed = parseWorkspacePolicy(
      '{"version":1,"mode":"leader-driven","alwaysEscalatePaths":["apps/api/special/"]}',
    );
    expect(parsed.alwaysEscalatePaths).toEqual(["apps/api/special/"]);
  });

  test("non-string entries in alwaysEscalatePaths are dropped", () => {
    const parsed = parseWorkspacePolicy(
      '{"version":1,"mode":"leader-driven","alwaysEscalatePaths":["apps/", 42, null, ""]}',
    );
    expect(parsed.alwaysEscalatePaths).toEqual(["apps/"]);
  });
});

describe("routeAssignment", () => {
  test("hitl mode: always assigns to user, even on a router-safe diff", () => {
    const decision = routeAssignment(SAFE_INPUT, { version: 1, mode: "hitl" });
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toBe("workspace_policy:hitl");
  });

  test("leader-driven mode + safe diff: assigns to leader", () => {
    const decision = routeAssignment(SAFE_INPUT, { version: 1, mode: "leader-driven" });
    expect(decision.assignee).toBe("leader");
    expect(decision.reason).toBe("default");
  });

  test("leader-driven mode + high-risk path: escalates to user", () => {
    const decision = routeAssignment(HIGH_RISK_INPUT, { version: 1, mode: "leader-driven" });
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toMatch(/^static_gate_high_risk:/);
    expect(decision.reason).toContain("apps/api/src/auth/login.ts");
  });

  test("leader-driven mode + multiple high-risk hits: reason lists up to 5 + suffix", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      path: `apps/api/src/auth/file${i}.ts`,
    }));
    const decision = routeAssignment(
      { ...SAFE_INPUT, changedFilesJson: JSON.stringify(many) },
      { version: 1, mode: "leader-driven" },
    );
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toContain("+3 more");
  });

  test("leader-driven mode + danger-full-access sandbox: escalates", () => {
    const decision = routeAssignment(
      { ...SAFE_INPUT, sandboxMode: "danger-full-access" },
      { version: 1, mode: "leader-driven" },
    );
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toBe("danger_full_access");
  });

  test("leader-driven mode + headless on workspace_root: escalates", () => {
    const decision = routeAssignment(
      {
        ...SAFE_INPUT,
        permissionMode: "headless",
        runtimeWorkspaceStrategy: "workspace_root",
      },
      { version: 1, mode: "leader-driven" },
    );
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toBe("headless_on_workspace_root");
  });

  test("leader-driven mode + headless on isolated worktree: stays with leader (no escalation)", () => {
    const decision = routeAssignment(
      {
        ...SAFE_INPUT,
        permissionMode: "headless",
        runtimeWorkspaceStrategy: "isolated_worktree",
      },
      { version: 1, mode: "leader-driven" },
    );
    expect(decision.assignee).toBe("leader");
    expect(decision.reason).toBe("default");
  });

  test("workspace alwaysEscalatePaths: substring match flips to user", () => {
    const decision = routeAssignment(SAFE_INPUT, {
      version: 1,
      mode: "leader-driven",
      alwaysEscalatePaths: ["apps/web/src/components/"],
    });
    expect(decision.assignee).toBe("user");
    expect(decision.reason).toBe("workspace_policy:always_escalate");
  });

  test("workspace alwaysEscalatePaths: no match leaves leader", () => {
    const decision = routeAssignment(SAFE_INPUT, {
      version: 1,
      mode: "leader-driven",
      alwaysEscalatePaths: ["docs/"],
    });
    expect(decision.assignee).toBe("leader");
    expect(decision.reason).toBe("default");
  });

  test("malformed changedFilesJson degrades safely (treated as no files)", () => {
    const decision = routeAssignment(
      { ...SAFE_INPUT, changedFilesJson: "{not json" },
      { version: 1, mode: "leader-driven" },
    );
    // No files means no high-risk hits; falls through to default.
    expect(decision.assignee).toBe("leader");
    expect(decision.reason).toBe("default");
  });
});
