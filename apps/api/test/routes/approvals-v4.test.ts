/**
 * Sandbox-elevation v4.3 — route-level E2E tests.
 *
 * Uses Fastify's `app.inject()` to dispatch through the actual route
 * handler chain (validation + parsing + service dispatch + response
 * serialization) without binding a port. Covers:
 *   - /approvals/:id/resolve with v4 conflict/storedOutcome response
 *   - dual-channel collision yields conflict=true
 *   - trust extras land correctly when "Trust for task" is requested
 *   - persistRuleFromApproval rejects request_permissions (no prefix)
 */
import { afterEach, beforeEach, expect, test, describe } from "bun:test";

import { buildApp } from "../../src/app";
import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { createApproval } from "../../src/services/command-approval-service";
import {
  __clearAllApprovalTrustForTests,
  findCoveringPermissionGrant,
  isTrustedForApproval,
} from "../../src/services/command-approval-service";

const TASK = "task_e2e_v4";

beforeEach(() => {
  __clearAllApprovalTrustForTests();
});

afterEach(() => {
  __clearAllApprovalTrustForTests();
});

describe("v4.3 route — /approvals/:id/resolve with additional_permissions", () => {
  test("approve with trust_for_task writes paths:* ledger entry + matching subset auto-passes", async () => {
    const app = buildApp();

    // Create an approval payload mimicking what request_permissions emits
    const approval = await createApproval(
      TASK,
      "bash",
      {
        command: "request_permissions: set up env",
        escalation: {
          sandbox_permissions: "with_additional_permissions",
          justification: "set up env",
          additional_permissions: {
            file_system: { entries: [{ path: "/home/u/.cache/uv", access: "write" }] },
          },
          request_kind: "request_permissions",
          proposed_scope: "project",
          project_path: "/workspace/repo",
        },
      },
      "Permission grant",
      "req_e2e_1",
    );

    // Approve with trust_for_task=true
    const response = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved", trust_for_task: true }),
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.data.trustApplied).toBe("task");

    // Subset-aware check: the granted paths should now auto-pass on subsequent bash
    const covered = findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/home/u/.cache/uv", access: "write" }] },
    });
    expect(covered).not.toBeNull();

    // Critical security check: an UNRELATED require_escalated bash should NOT
    // auto-trust on this path grant — that's the codex BLOCKER Q2 regression test.
    expect(isTrustedForApproval(TASK, "bash", "*")).toBe(false);

    await app.close();
  });

  test("dual-channel conflict returns conflict=true + storedOutcome", async () => {
    const app = buildApp();

    const approval = await createApproval(
      TASK,
      "bash",
      { command: "ls" },
      "Dangerous",
      "req_e2e_2",
    );

    // First resolve: approved
    const first = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved" }),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.data.conflict ?? false).toBe(false);

    // Second resolve: rejected — dual-channel conflict
    const second = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "rejected" }),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.data.conflict).toBe(true);
    expect(secondBody.data.storedOutcome).toBe("approved");

    await app.close();
  });

  test("approve without trust → no ledger entry written", async () => {
    const app = buildApp();

    const approval = await createApproval(
      TASK,
      "bash",
      {
        command: "uv sync",
        escalation: {
          sandbox_permissions: "with_additional_permissions",
          justification: "uv sync",
          additional_permissions: {
            file_system: { entries: [{ path: "/home/u/.cache/uv", access: "write" }] },
          },
        },
      },
      "Permission",
      "req_e2e_3",
    );

    const response = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved" }),  // no trust flags
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.trustApplied).toBeUndefined();

    // Verify no ledger entry was written
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/home/u/.cache/uv", access: "write" }] },
    })).toBeNull();

    await app.close();
  });

  test("sensitive_read approval ignores trust_for_task", async () => {
    const app = buildApp();

    const approval = await createApproval(
      TASK,
      "bash",
      {
        command: "cat .env",
        escalation: {
          sandbox_permissions: "sensitive_read",
          justification: "read sensitive internal path",
          request_kind: "sensitive_read",
          sensitive_read: {
            access: "read",
            matches: [".env"],
            one_time: true,
          },
        },
      },
      "Sensitive internal path read",
      "req_e2e_sensitive_read",
    );

    const response = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved", trust_for_task: true }),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.trustApplied).toBeUndefined();
    expect(isTrustedForApproval(TASK, "bash", "*")).toBe(false);

    await app.close();
  });

  test("save_rule with request_permissions (no prefix) returns ruleSave.status='failed'", async () => {
    const app = buildApp();

    const approval = await createApproval(
      TASK,
      "bash",
      {
        command: "request_permissions: grant",
        escalation: {
          sandbox_permissions: "with_additional_permissions",
          justification: "grant",
          additional_permissions: {
            file_system: { entries: [{ path: "/home/u/.cache/pnpm", access: "write" }] },
          },
          request_kind: "request_permissions",
          // No proposed_prefix_rule!
          proposed_scope: "project",
          project_path: "/workspace/repo",
        },
      },
      "Permission",
      "req_e2e_4",
    );

    const response = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved", save_rule: true }),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.ruleSave.status).toBe("failed");
    expect(body.data.ruleSave.error).toContain("proposed_prefix_rule");

    await app.close();
  });

  test("save_rule with proposed_prefix_rule + additional_permissions persists row with both", async () => {
    const app = buildApp();

    const approval = await createApproval(
      TASK,
      "bash",
      {
        command: "uv sync",
        escalation: {
          sandbox_permissions: "with_additional_permissions",
          justification: "uv sync setup",
          additional_permissions: {
            file_system: { entries: [{ path: "/home/u/.cache/uv", access: "write" }] },
          },
          proposed_prefix_rule: ["uv", "sync"],
          proposed_scope: "project",
          project_path: "/workspace/repo",
        },
      },
      "Permission",
      "req_e2e_5",
    );

    const response = await app.inject({
      method: "POST",
      url: `/approvals/${approval.id}/resolve`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ decision: "approved", save_rule: true, trust_for_task: true }),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.ruleSave.status).toBe("persisted");

    await app.close();
  });
});
