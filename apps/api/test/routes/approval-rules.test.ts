/**
 * Spec §1 V1.1 (2026-05-17) — integration tests for the sandbox
 * escalation protocol's persistent-rule surface.
 *
 *   - GET /approval-rules
 *   - POST /approval-rules/:id (enable toggle)
 *   - DELETE /approval-rules/:id
 *   - GET /approval-rules/validation/banned-prefixes
 *   - POST /approvals/:id/resolve with save_rule:true (end-to-end)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildApp } from "../../src/app";
import { CommandApprovalRuleRepository } from "../../src/repositories/command-approval-rule-repository";
import { createApproval } from "../../src/services/command-approval-service";

const tempRoot = join(process.cwd(), ".tmp-approval-rules-route-db");

function writeStubRoutingConfig(configPath: string) {
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {},
      providers: {},
      models: {},
      bindings: {},
    }),
  );
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `rules-route-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = join(
    tempRoot,
    `executors-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

async function seedRule(opts: {
  id?: string;
  prefix?: string[];
  scope?: "global" | "project";
  projectPath?: string | null;
  enabled?: boolean;
  hits?: number;
} = {}) {
  const repo = new CommandApprovalRuleRepository();
  const id = opts.id ?? `rule_${Math.random().toString(16).slice(2)}`;
  await repo.create({
    id,
    tool: "bash",
    patternKind: "argv_prefix",
    patternJson: JSON.stringify(opts.prefix ?? ["npm", "install"]),
    scope: opts.scope ?? "global",
    projectPath: opts.projectPath ?? null,
    approvedBy: "test-user",
    approvedAt: new Date(),
    enabled: opts.enabled === false ? 0 : 1,
    hitCount: opts.hits ?? 0,
  });
  return id;
}

test("GET /approval-rules returns empty list when no rules exist", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/approval-rules" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true, data: { items: [] } });
});

test("GET /approval-rules surfaces pattern preview, scope, hit stats", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const id = await seedRule({
    prefix: ["git", "push", "origin"],
    scope: "project",
    projectPath: "/repo/A",
    hits: 5,
  });
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/approval-rules" });
  const body = res.json() as { ok: boolean; data: { items: Array<Record<string, unknown>> } };
  expect(body.ok).toBe(true);
  expect(body.data.items).toHaveLength(1);
  expect(body.data.items[0]).toMatchObject({
    id,
    tool: "bash",
    patternKind: "argv_prefix",
    patternPreview: "git push origin",
    scope: "project",
    projectPath: "/repo/A",
    hitCount: 5,
    enabled: true,
  });
});

test("POST /approval-rules/:id toggles enabled state", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const id = await seedRule({ enabled: true });
  const app = buildApp();

  const off = await app.inject({
    method: "POST",
    url: `/approval-rules/${id}`,
    payload: { enabled: false },
  });
  expect(off.statusCode).toBe(200);
  expect((off.json() as { data: { enabled: number } }).data.enabled).toBe(0);

  const on = await app.inject({
    method: "POST",
    url: `/approval-rules/${id}`,
    payload: { enabled: true },
  });
  expect((on.json() as { data: { enabled: number } }).data.enabled).toBe(1);
});

test("POST /approval-rules/:id returns 404 for unknown id", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/approval-rules/does-not-exist",
    payload: { enabled: false },
  });
  expect(res.statusCode).toBe(404);
});

test("DELETE /approval-rules/:id removes the row", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const id = await seedRule();
  const app = buildApp();

  const del = await app.inject({ method: "DELETE", url: `/approval-rules/${id}` });
  expect(del.statusCode).toBe(200);
  expect(del.json()).toMatchObject({ ok: true, data: { deleted: id } });

  const list = await app.inject({ method: "GET", url: "/approval-rules" });
  expect((list.json() as { data: { items: unknown[] } }).data.items).toHaveLength(0);
});

test("DELETE /approval-rules/:id returns 404 for unknown id", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();
  const res = await app.inject({ method: "DELETE", url: "/approval-rules/does-not-exist" });
  expect(res.statusCode).toBe(404);
});

test("GET /approval-rules/validation/banned-prefixes returns sample list", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/approval-rules/validation/banned-prefixes",
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    ok: boolean;
    data: { samples: Array<{ prefix: string[]; reason: string }> };
  };
  expect(body.ok).toBe(true);
  expect(body.data.samples.length).toBeGreaterThan(0);
  // Every sample is a banned prefix with a server-side reason.
  for (const sample of body.data.samples) {
    expect(Array.isArray(sample.prefix)).toBe(true);
    expect(typeof sample.reason).toBe("string");
    expect(sample.reason.length).toBeGreaterThan(0);
  }
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end save_rule path: bash escalation → approval → resolve with
// save_rule:true → command_approval_rules row appears.
// ─────────────────────────────────────────────────────────────────────

test("POST /approvals/:id/resolve { save_rule:true } persists a rule from escalation metadata", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();

  // Simulate what the bash decision pipeline writes: an approval whose
  // payload carries the proposed prefix_rule + scope + justification.
  const approval = await createApproval(
    "task_test",
    "bash",
    {
      command: "npm install --save react",
      escalation: {
        sandbox_permissions: "require_escalated",
        justification: "install dependencies before running tests",
        proposed_prefix_rule: ["npm", "install"],
        proposed_scope: "project",
        project_path: "/repo/A",
      },
    },
    "Escalation requested for bash: npm install --save react\nReason: install dependencies before running tests",
  );

  const res = await app.inject({
    method: "POST",
    url: `/approvals/${approval.id}/resolve`,
    payload: { decision: "approved", save_rule: true },
  });
  expect(res.statusCode).toBe(200);
  // Codex review P2 — response surfaces ruleSave.status so UI can tell
  // the difference between "approved + saved" vs "approved + refused".
  expect(res.json()).toMatchObject({
    data: { ruleSave: { status: "persisted" } },
  });

  // Rule materialized.
  const list = await app.inject({ method: "GET", url: "/approval-rules" });
  const items = (list.json() as { data: { items: Array<Record<string, unknown>> } }).data.items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    tool: "bash",
    patternKind: "argv_prefix",
    patternPreview: "npm install",
    scope: "project",
    projectPath: "/repo/A",
    enabled: true,
  });
});

test("POST /approvals/:id/resolve without save_rule does NOT persist a rule", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();

  const approval = await createApproval(
    "task_no_save",
    "bash",
    {
      command: "npm install",
      escalation: {
        sandbox_permissions: "require_escalated",
        justification: "one-off",
        proposed_prefix_rule: ["npm", "install"],
        proposed_scope: "project",
        project_path: "/repo/B",
      },
    },
    "Escalation: npm install",
  );

  await app.inject({
    method: "POST",
    url: `/approvals/${approval.id}/resolve`,
    payload: { decision: "approved" },
  });

  const list = await app.inject({ method: "GET", url: "/approval-rules" });
  expect((list.json() as { data: { items: unknown[] } }).data.items).toHaveLength(0);
});

test("POST /approvals/:id/resolve { save_rule:true } on rejection does NOT persist", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();

  const approval = await createApproval(
    "task_reject",
    "bash",
    {
      command: "rm -rf old-build",
      escalation: {
        sandbox_permissions: "require_escalated",
        justification: "wipe stale build",
        proposed_prefix_rule: ["rm", "-rf"],
        proposed_scope: "project",
        project_path: "/repo/C",
      },
    },
    "Escalation: rm -rf old-build",
  );

  await app.inject({
    method: "POST",
    url: `/approvals/${approval.id}/resolve`,
    payload: { decision: "rejected", save_rule: true },
  });

  const list = await app.inject({ method: "GET", url: "/approval-rules" });
  expect((list.json() as { data: { items: unknown[] } }).data.items).toHaveLength(0);
});

test("POST /approvals/:id/resolve { save_rule:true } with banned prefix does NOT persist (route-side re-validation)", async () => {
  writeStubRoutingConfig(process.env.MAGISTER_EXECUTOR_CONFIG_PATH!);
  const app = buildApp();

  // The client somehow submitted ["python","-c"] — a banned prefix.
  // The route's persistRuleFromApproval re-validates server-side and
  // refuses to persist, but the approval itself still resolves
  // (the user already approved this one execution).
  const approval = await createApproval(
    "task_banned",
    "bash",
    {
      command: "python -c 'import os; os.system(\"rm -rf .\")'",
      escalation: {
        sandbox_permissions: "require_escalated",
        justification: "run a script",
        proposed_prefix_rule: ["python", "-c"],
        proposed_scope: "global",
      },
    },
    "Escalation: python -c ...",
  );

  const res = await app.inject({
    method: "POST",
    url: `/approvals/${approval.id}/resolve`,
    payload: { decision: "approved", save_rule: true },
  });
  expect(res.statusCode).toBe(200);
  // Codex review P2 — response carries ruleSave.status === "failed"
  // so the UI can warn the user that the rule wasn't persisted even
  // though the approval itself succeeded.
  expect(res.json()).toMatchObject({
    data: {
      ruleSave: {
        status: "failed",
        error: expect.stringContaining("banned list"),
      },
    },
  });

  // Approval resolved but the banned rule was NOT persisted.
  const list = await app.inject({ method: "GET", url: "/approval-rules" });
  expect((list.json() as { data: { items: unknown[] } }).data.items).toHaveLength(0);
});
