import { beforeEach, expect, test } from "bun:test";

import {
  clearApprovalRecordsForTests,
  createApproval,
  expireOldApprovals,
  getApproval,
  getExpiredApprovals,
  getPendingApprovals,
  isDangerousCommand,
  resolveApproval,
  sanitizeCommandPreview,
  waitForApproval,
} from "../../src/services/command-approval-service";

beforeEach(async () => {
  await clearApprovalRecordsForTests();
});

test("sanitizeCommandPreview redacts Bearer tokens", () => {
  const preview = sanitizeCommandPreview("curl -H 'Authorization: Bearer very-secret-token' https://example.com");
  expect(preview).toContain("[REDACTED]");
  expect(preview).not.toContain("very-secret-token");
});

test("sanitizeCommandPreview redacts sk- API keys", () => {
  const preview = sanitizeCommandPreview("echo sk-1234567890abcdefghijklmnop");
  expect(preview).toContain("sk-[REDACTED]");
  expect(preview).not.toContain("sk-1234567890abcdefghijklmnop");
});

test("isDangerousCommand catches git push -f after args", () => {
  expect(isDangerousCommand("git push origin main -f")).toBe(true);
});

test("isDangerousCommand catches chmod 0777", () => {
  expect(isDangerousCommand("chmod 0777 script.sh")).toBe(true);
});

test("isDangerousCommand catches rm dir -rf", () => {
  expect(isDangerousCommand("rm /tmp/test -rf")).toBe(true);
});

// Safe-cleanup whitelist — `rm -rf __pycache__` etc. should NOT trip
// the danger gate. This is the most-common form the user kept hitting:
// "delete __pycache__" forced an approval prompt every time.
test("isDangerousCommand allows rm -rf <path>/__pycache__", () => {
  expect(isDangerousCommand("rm -rf /opt/foo/server/__pycache__")).toBe(false);
  expect(isDangerousCommand("rm -rf foo/.pytest_cache")).toBe(false);
  expect(isDangerousCommand("rm -rf /tmp/.ruff_cache/")).toBe(false);
});

test("isDangerousCommand allows rm -r <path>/__pycache__", () => {
  expect(isDangerousCommand("rm -r /opt/foo/__pycache__")).toBe(false);
});

test("isDangerousCommand allows find -name __pycache__ -exec rm -rf", () => {
  expect(
    isDangerousCommand(
      "find /opt/foo -type d -name __pycache__ -exec rm -rf {} +",
    ),
  ).toBe(false);
});

test("isDangerousCommand allows the find form with stderr-redirect + echo tail", () => {
  // Exact form the model emitted in the user's session.
  expect(
    isDangerousCommand(
      `find /opt/foo -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null; echo "done"`,
    ),
  ).toBe(false);
});

test("isDangerousCommand still trips on unrelated rm -rf", () => {
  // Whitelist must NOT swallow rm -rf on arbitrary paths.
  expect(isDangerousCommand("rm -rf /opt/foo/important_data")).toBe(true);
  expect(isDangerousCommand("rm -rf /")).toBe(true);
});

test("isDangerousCommand still trips on rm -rf of safe-named lookalike that's NOT the dir", () => {
  // `rm -rf __pycache__/something_else` — the target is INSIDE the
  // safe dir, but matches the regex form with a trailing extra path
  // segment that doesn't end in a safe name. Should still trip danger.
  expect(
    isDangerousCommand("rm -rf /opt/foo/__pycache__/secret_file"),
  ).toBe(true);
});

test("isDangerousCommand allows safe commands like ls, cat, git status", () => {
  expect(isDangerousCommand("ls -la")).toBe(false);
  expect(isDangerousCommand("cat README.md")).toBe(false);
  expect(isDangerousCommand("git status")).toBe(false);
});

test("createApproval stores pending approval", async () => {
  const record = await createApproval("task-1", "bash", { command: "rm -rf /tmp/test" }, "dangerous command");

  expect(record.status).toBe("pending");
  expect(record.taskId).toBe("task-1");

  const stored = await getApproval(record.id);
  expect(stored).not.toBeNull();
  expect(stored?.status).toBe("pending");
  const pending = await getPendingApprovals();
  expect(pending.some((item) => item.id === record.id)).toBe(true);
});

test("resolveApproval with approve marks as approved", async () => {
  const record = await createApproval("task-2", "bash", { command: "rm -rf /tmp/test" }, "dangerous command");

  const outcome = await resolveApproval(record.id, "approved");
  expect(outcome).not.toBeNull();
  expect(outcome?.record.status).toBe("approved");
  expect(outcome?.record.resolvedBy).toBe("user");
  expect(typeof outcome?.record.resolvedAt).toBe("number");
  expect(outcome?.landed).toBe(true);
  expect(outcome?.conflict).toBe(false);
});

test("resolveApproval with reject marks as rejected", async () => {
  const record = await createApproval("task-3", "bash", { command: "rm -rf /tmp/test" }, "dangerous command");

  const outcome = await resolveApproval(record.id, "rejected");
  expect(outcome).not.toBeNull();
  expect(outcome?.record.status).toBe("rejected");
  expect(outcome?.record.resolvedBy).toBe("user");
  expect(typeof outcome?.record.resolvedAt).toBe("number");
  expect(outcome?.landed).toBe(true);
  expect(outcome?.conflict).toBe(false);
});

test("getExpiredApprovals returns approvals older than timeout", async () => {
  // Insert a fresh approval normally + backdate a separate row directly
  // via the repo (we can't mutate `createdAt` on the returned record any
  // more — it's read-only from the DB).
  const fresh = await createApproval("task-4", "bash", { command: "ls" }, "safe summary");

  const { ApprovalRepository } = await import("../../src/repositories/approval-repository");
  const repo = new ApprovalRepository();
  const oldId = `approval_${crypto.randomUUID()}`;
  const wellPastTimeout = new Date(Date.now() - 6 * 60 * 1000);
  await repo.create({
    id: oldId,
    taskId: "task-5",
    approvalType: "bash",
    state: "pending",
    requestedAt: wellPastTimeout,
    resolvedAt: null,
    resolvedBy: null,
    payloadJson: JSON.stringify({ toolName: "bash", toolArgs: { command: "rm -rf /tmp/test" }, summary: "dangerous command" }),
  });

  const expiredCandidates = await getExpiredApprovals();
  expect(expiredCandidates.some((item) => item.id === oldId)).toBe(true);
  expect(expiredCandidates.some((item) => item.id === fresh.id)).toBe(false);

  const expiredCount = await expireOldApprovals();
  expect(expiredCount).toBeGreaterThanOrEqual(1);

  const expired = await getApproval(oldId);
  expect(expired?.status).toBe("rejected");
  expect(expired?.resolvedBy).toBe("auto_timeout");
});

test("waitForApproval returns expired when signal is aborted", async () => {
  const record = await createApproval("task-abort", "bash", { command: "rm -rf /tmp/test" }, "dangerous command");
  const controller = new AbortController();
  controller.abort();

  const result = await waitForApproval(record.id, 10_000, controller.signal);
  expect(result).toBe("expired");

  const updated = await getApproval(record.id);
  expect(updated?.status).toBe("expired");
  expect(updated?.resolvedBy).toBe("abort");
});

// Regression: the abort path must project a resolution event, like the
// timeout path does. Without it, the unmatched `leader.approval_requested`
// event leaves the task stuck on "Waiting for a human approval" forever.
test("waitForApproval emits a resolution event when aborted", async () => {
  const { ExecutionEventRepository } = await import(
    "../../src/repositories/execution-event-repository"
  );
  const record = await createApproval(
    "task-abort-event",
    "bash",
    { command: "rm -rf /tmp/test" },
    "dangerous command",
  );
  const controller = new AbortController();
  controller.abort();

  await waitForApproval(record.id, 10_000, controller.signal);

  const eventRepo = new ExecutionEventRepository();
  const resolved = await eventRepo.listByTaskIdAndType(
    "task-abort-event",
    "leader.approval_resolved",
  );
  const matched = resolved.some((evt) => {
    if (!evt.payloadJson) return false;
    try {
      return (JSON.parse(evt.payloadJson) as { approvalId?: string }).approvalId === record.id;
    } catch {
      return false;
    }
  });
  expect(matched).toBe(true);
});

// Note: the previous "old approval records are cleaned up when limit
// exceeded" test asserted the in-memory `MAX_APPROVAL_RECORDS = 500`
// LRU eviction. That cap is gone — approvals now live in SQLite and
// are pruned by `task-retention-service` along with their parent task,
// so a separate per-approval LRU is redundant. Test deleted.

test("requestApprovalForTool queues and resolves on user decision", async () => {
  const { requestApprovalForTool } = await import("../../src/services/command-approval-service");

  const promise = requestApprovalForTool({
    taskId: "task_1",
    toolKind: "mcp_tool",
    summary: "MCP github.create_repo: { name: 'test' }",
    metadata: { server: "github", tool: "create_repo" },
  });

  // Wait until the createApproval inside requestApprovalForTool has
  // landed before we try to read it.
  let pending: Awaited<ReturnType<typeof getPendingApprovals>> = [];
  for (let i = 0; i < 20; i++) {
    pending = await getPendingApprovals();
    if (pending.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(pending).toHaveLength(1);
  await resolveApproval(pending[0]!.id, "approved");

  const decision = await promise;
  expect(decision).toBe("approved");
});

test("requestApprovalForTool returns 'rejected' when user denies", async () => {
  const { requestApprovalForTool } = await import("../../src/services/command-approval-service");

  const promise = requestApprovalForTool({
    taskId: "task_1",
    toolKind: "mcp_tool",
    summary: "MCP postgres.drop_table",
    metadata: {},
  });
  let pending: Awaited<ReturnType<typeof getPendingApprovals>> = [];
  for (let i = 0; i < 20; i++) {
    pending = await getPendingApprovals();
    if (pending.length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(pending).toHaveLength(1);
  await resolveApproval(pending[0]!.id, "rejected");
  expect(await promise).toBe("rejected");
});

test("resolveApproval CAS: second resolve returns existing state, no overwrite", async () => {
  const record = await createApproval(
    "task-cas",
    "bash",
    { command: "rm -rf /tmp/a" },
    "dangerous",
  );
  const first = await resolveApproval(record.id, "approved");
  expect(first?.record.status).toBe("approved");
  expect(first?.landed).toBe(true);

  // Race: second resolve attempts to reject the already-approved row.
  // CAS at the repo layer should reject (changes === 0), and the
  // service should return the EXISTING approved state — not flip to
  // rejected. v4.3 §4.5 adds: landed=false + conflict=true (different
  // decision than stored) + storedOutcome="approved".
  const second = await resolveApproval(record.id, "rejected");
  expect(second?.record.status).toBe("approved");
  expect(second?.landed).toBe(false);
  expect(second?.conflict).toBe(true);
  expect(second?.storedOutcome).toBe("approved");
  // And the persisted state should still be approved.
  const reread = await getApproval(record.id);
  expect(reread?.status).toBe("approved");
});

test("resolveApproval CAS: idempotent replay (same decision) does NOT report conflict", async () => {
  const record = await createApproval(
    "task-cas-replay",
    "bash",
    { command: "ls" },
    "safe",
  );
  await resolveApproval(record.id, "approved");
  // Same decision replayed — landed=false but conflict=false.
  const replay = await resolveApproval(record.id, "approved");
  expect(replay?.landed).toBe(false);
  expect(replay?.conflict).toBe(false);
  expect(replay?.storedOutcome).toBe("approved");
});

test("timeout fails closed (rejected, not approved)", async () => {
  // Create approval then wait past deadline — should reject, not approve.
  const record = await createApproval(
    "task-timeout-closed",
    "bash",
    { command: "rm -rf /tmp/test" },
    "dangerous command",
  );

  // Use a tiny timeout (1ms) so it expires immediately when waitForApproval polls.
  const outcome = await waitForApproval(record.id, 1);
  expect(outcome).toBe("rejected");

  const row = await getApproval(record.id);
  expect(row?.status).toBe("rejected");
  expect(row?.resolvedBy).toBe("auto_timeout");
});
