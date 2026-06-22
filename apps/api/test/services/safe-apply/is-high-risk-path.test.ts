// 2026-05-24 — Per-pattern fixtures for `isHighRiskPath`. Each branch
// of the function gets at least one positive case and a neighbouring
// negative case so any regression (a stray edit that loosens or
// tightens the matcher) fails CI.
//
// This is the source-of-truth contract for both:
//   - safe-apply's static gate (HUMAN_REQUIRED reason injection)
//   - review-assignment-router (Phase 1 of the Leader-driven review RFC)
//
// Adding a new branch to `isHighRiskPath` MUST add a test here.

import { describe, expect, test } from "bun:test";

import { isHighRiskPath } from "../../../src/services/safe-apply/static-gate-service";

describe("isHighRiskPath positive cases (each existing branch)", () => {
  const positives: Array<[string, string]> = [
    // exact-match
    ["config/secrets.json", "exact: secrets.json"],
    ["package.json", "exact: package.json"],
    // substring
    ["apps/api/src/auth/login.ts", "/auth substring"],
    ["packages/core/src/authorization.ts", "authorization substring"],
    ["apps/web/src/components/approval-card.tsx", "approval substring"],
    ["apps/api/src/services/permission-mode-service.ts", "permission substring"],
    ["apps/api/src/services/sandbox-elevation.ts", "sandbox substring"],
    ["apps/api/src/services/shell-runner.ts", "shell substring"],
    ["apps/api/src/services/tool-execution.ts", "/tool substring"],
    ["apps/api/src/mcp/server.ts", "/mcp substring"],
    ["apps/api/src/services/agent-resolution-service.ts", "agent-resolution substring"],
    ["apps/api/src/services/runtime-workspace-service.ts", "runtime-workspace substring"],
    ["apps/api/src/services/worktree-cleanup.ts", "worktree substring"],
    ["apps/api/src/services/executor-config-service.ts", "executor substring"],
    [
      "apps/api/src/services/manager-automation/autonomous-loop/streaming-api-caller.ts",
      "autonomous-loop substring",
    ],
    // startsWith
    ["packages/db/src/schema.ts", "packages/db/ prefix"],
    ["packages/db/migrations/0001_init.sql", "packages/db/ prefix on migrations"],
    [".magister/state.json", ".magister prefix"],
    [".ssh/id_rsa", ".ssh prefix"],
    [".aws/credentials", ".aws prefix"],
    // includes
    [".netrc", ".netrc substring"],
    ["home/user/.netrc", ".netrc substring nested"],
    ["packages/db/schema.ts", "schema substring (db schema)"],
    ["apps/api/src/db/migrations/0042.sql", "migration substring"],
    // env tail
    [".env", ".env exact"],
    [".env.prod", ".env.prod"],
    [".env.dev", ".env.dev"],
  ];

  for (const [path, label] of positives) {
    test(`flags ${label} → ${path}`, () => {
      expect(isHighRiskPath(path)).toBe(true);
    });
  }
});

describe("isHighRiskPath negative cases (allow-listed neighbours)", () => {
  const negatives: Array<[string, string]> = [
    // .env exceptions: example/template are safe
    [".env.example", ".env.example is documentation"],
    [".env.template", ".env.template is documentation"],
    // not exactly package.json
    ["apps/api/package-lock.json", "package-lock.json not in list (intentional — lock files arguably low-risk)"],
    ["docs/package-naming.md", "package.json substring inside another doc path"],
    // not a config/secrets.json
    ["config/secrets.example.json", "secrets.example.json (different from secrets.json)"],
    // ordinary code
    ["apps/web/src/components/UserCard.tsx", "ordinary component"],
    ["docs/plans/2026-05-24-leader-review-autonomy.md", "docs file"],
    ["README.md", "README"],
    ["apps/web/src/styles/chat.css", "css file"],
    ["apps/api/test/services/foo.test.ts", "test file"],
  ];

  for (const [path, label] of negatives) {
    test(`does NOT flag ${label} → ${path}`, () => {
      expect(isHighRiskPath(path)).toBe(false);
    });
  }
});

describe("isHighRiskPath is case-insensitive", () => {
  test("uppercase AUTH path is still flagged", () => {
    expect(isHighRiskPath("apps/api/src/AUTH/login.ts")).toBe(true);
  });
  test("mixed-case Schema.ts is flagged", () => {
    expect(isHighRiskPath("packages/db/src/Schema.ts")).toBe(true);
  });
});
