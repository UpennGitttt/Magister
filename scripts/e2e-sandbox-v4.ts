/**
 * Sandbox-elevation v4.3 — END-TO-END test exercising the FULL bash
 * dispatch pipeline in-process. No port binding, no LLM, but EVERY
 * other piece (tool registry, validation, approval lifecycle, trust
 * ledger split-entry, sandbox builder with extraBinds, bash_dispatch
 * telemetry event) runs through the production code paths.
 *
 * Approach:
 *   1. createLeaderTools() to get the real bash tool + request_permissions
 *   2. Mock minimal LeaderToolContext (taskId, workspaceDir, recordEvent, ...)
 *   3. Invoke the bash tool with v4 args; in parallel, watch for the
 *      approval row and resolve it programmatically (simulating user click)
 *   4. Verify: trust ledger has subjectKey="paths:*" (not "*")
 *   5. Verify: BLOCKER regression — isTrustedForApproval(*) returns false
 *      (path grant does NOT suppress unrelated require_escalated calls)
 *   6. Invoke a SECOND bash call without declaring with_additional_permissions —
 *      verify auto-inheritance: ledger grants applied as extraBinds
 *   7. Verify leader.bash_dispatch event recorded with binds-source breakdown
 *
 * Run: MAGISTER_PERMISSIONS_V4=on bun scripts/e2e-sandbox-v4.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { createSqliteClient, ensureDatabaseInitialized } from "@magister/db";

// Initialize DB (loads schema/migrations including v4 additional_permissions_json column)
const sqlite = createSqliteClient();
ensureDatabaseInitialized(sqlite);

import { createLeaderTools } from "../apps/api/src/services/manager-automation/autonomous-loop/manager-tools-adapter";
import {
  __clearAllApprovalTrustForTests,
  createApproval,
  findCoveringPermissionGrant,
  findGrantedAdditionalPermissions,
  getPendingApprovals,
  isTrustedForApproval,
  resolveApproval,
} from "../apps/api/src/services/command-approval-service";
import { ApprovalRepository } from "../apps/api/src/repositories/approval-repository";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

// ---------- Setup ----------
process.env.MAGISTER_PERMISSIONS_V4 = "on";  // explicit, in case caller didn't set

const TASK_ID = `e2e_task_${Date.now()}`;
const REQUEST_ID = `e2e_req_${Date.now()}`;
const HOME = homedir();
const tempWorkspace = mkdtempSync(join(tmpdir(), "e2e-sandbox-v4-"));
const tempCacheDir = join(tempWorkspace, "cache");
mkdirSync(tempCacheDir, { recursive: true });
const tempGitconfig = join(tempWorkspace, "gitconfig");
writeFileSync(tempGitconfig, "[user]\n  name = test\n");

// Recorded events for verification
const recordedEvents: Array<{ type: string; data: unknown }> = [];

const mockContext = {
  taskId: TASK_ID,
  requestId: REQUEST_ID,
  workspaceDir: tempWorkspace,
  recordEvent: async (event: { type: string; timestamp?: string; data?: unknown }) => {
    recordedEvents.push({ type: event.type, data: event.data });
  },
  // Minimal optional fields the bash dispatcher checks
  abortController: undefined,
  planApprovedThisRun: true,  // skip MEDIUM regex gate for cleaner test
};

console.log("\nSetup:");
console.log(`  task=${TASK_ID}`);
console.log(`  workspace=${tempWorkspace}`);
console.log(`  cache=${tempCacheDir}`);
console.log(`  HOME=${HOME}`);
console.log(`  MAGISTER_PERMISSIONS_V4=${process.env.MAGISTER_PERMISSIONS_V4}`);

__clearAllApprovalTrustForTests();

// Get the bash tool from the registry
const tools = createLeaderTools(tempWorkspace, undefined, undefined, {
  bashSandbox: {
    baseWorkspaceDir: tempWorkspace,
  },
});
const bashTool = tools.find((t) => t.name === "bash");
const requestPermissionsTool = tools.find((t) => t.name === "request_permissions");

if (!bashTool) {
  console.error("FATAL: bash tool not in registry");
  process.exit(1);
}

check("bash tool present in registry", true);
check("request_permissions tool present in registry (flag-gated)", requestPermissionsTool !== undefined);

/**
 * Simulate the user approving the next approval that appears for this task,
 * with trust_for_task=true. Polls every 100ms.
 */
async function autoApproveOnAppear(): Promise<{ approvalId: string; ms: number }> {
  const start = Date.now();
  const repo = new ApprovalRepository();
  while (Date.now() - start < 15_000) {
    const pending = await getPendingApprovals();
    const ours = pending.find((p) => p.taskId === TASK_ID);
    if (ours) {
      // Read the payload to verify v4 fields, THEN resolve manually
      // via the SAME path as the route would (calling resolveApproval
      // + addApprovalTrust as the routes/approvals.ts does).
      const row = await repo.getById(ours.id);
      const payload = row?.payloadJson ? JSON.parse(row.payloadJson) : null;
      const escalation = payload?.toolArgs?.escalation;
      const additionalPermissions = escalation?.additional_permissions;

      const outcome = await resolveApproval(ours.id, "approved");
      if (outcome?.landed && additionalPermissions) {
        // Simulate the route's trust-write path (paths:* entry for permissions)
        const { addApprovalTrust } = await import("../apps/api/src/services/command-approval-service");
        addApprovalTrust(TASK_ID, "bash", "paths:*", null, { additionalPermissions });
      }
      return { approvalId: ours.id, ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("approval did not appear within 15s");
}

// ---------- Test 1: bash with v4 with_additional_permissions ----------
section("1. Bash with with_additional_permissions — full dispatch flow");

const approvePromise1 = autoApproveOnAppear();
const bashResultPromise1 = bashTool.call(
  {
    command: "ls",
    sandbox_permissions: "with_additional_permissions",
    additional_permissions: {
      file_system: {
        read: [tempGitconfig],
        write: [tempCacheDir],
      },
    },
    justification: "set up build env",
  },
  mockContext as Parameters<typeof bashTool.call>[1],
);

const [approveInfo, bashResult] = await Promise.all([approvePromise1, bashResultPromise1]);
console.log(`  approval landed in ${approveInfo.ms}ms (id=${approveInfo.approvalId})`);

check(
  "bash tool returns a result object",
  bashResult && typeof bashResult === "object" && "data" in bashResult,
  `got ${JSON.stringify(bashResult).slice(0, 100)}`,
);

const bashData = String((bashResult as { data?: unknown }).data ?? "");
check(
  "bash output does NOT contain tool_use_error",
  !bashData.includes("tool_use_error"),
  bashData.slice(0, 200),
);

// ---------- Test 2: Trust ledger split-entry verification (codex BLOCKER Q2) ----------
section("2. Trust ledger: split-entry (BLOCKER Q2 regression check)");

check(
  "permission-only grant DOES NOT match wildcard '*' lookup (BLOCKER Q2)",
  isTrustedForApproval(TASK_ID, "bash", "*") === false,
);

const covered = findCoveringPermissionGrant(TASK_ID, {
  file_system: { entries: [{ path: tempCacheDir, access: "write" }] },
});
check(
  "permission grant covers its own subset (BLOCKER Q3c)",
  covered !== null,
);

const notCovered = findCoveringPermissionGrant(TASK_ID, {
  file_system: { entries: [{ path: "/etc/sudoers", access: "write" }] },
});
check(
  "unrelated path NOT covered (subset safety)",
  notCovered === null,
);

const grantedUnion = findGrantedAdditionalPermissions(TASK_ID, "bash");
check(
  "findGrantedAdditionalPermissions returns the granted profile",
  grantedUnion !== null && (grantedUnion.file_system?.entries.length ?? 0) >= 2,
);

// ---------- Test 3: AUTO-INHERITANCE (codex HIGH Q4a) ----------
section("3. Auto-inheritance: next bash without declaring v4 fields still gets binds");

// Reset event recording for this test
recordedEvents.length = 0;

// Second bash call — NO with_additional_permissions, NO additional_permissions.
// Spec §4.2: ledger grants should auto-apply as extraBinds.
const bashResult2 = await bashTool.call(
  { command: "ls" },
  mockContext as Parameters<typeof bashTool.call>[1],
);

check(
  "second bash (no v4 declared) executes without prompting",
  bashResult2 && typeof bashResult2 === "object",
);
const bashData2 = String((bashResult2 as { data?: unknown }).data ?? "");
check(
  "second bash output does NOT contain tool_use_error",
  !bashData2.includes("tool_use_error"),
  bashData2.slice(0, 200),
);

// Check that bash_dispatch event was emitted with ledger source
const dispatchEvent = recordedEvents.find((e) => e.type === "leader.bash_dispatch");
check(
  "leader.bash_dispatch event emitted (telemetry quick win #6)",
  dispatchEvent !== undefined,
);
if (dispatchEvent) {
  const data = dispatchEvent.data as {
    fromLedger?: Array<{ path: string }>;
    fromInline?: unknown[];
    effectiveBindCount?: number;
  };
  check(
    "bash_dispatch event has fromLedger entries (auto-inheritance verified)",
    Array.isArray(data.fromLedger) && data.fromLedger.length >= 2,
    `fromLedger=${JSON.stringify(data.fromLedger).slice(0, 150)}`,
  );
  check(
    "bash_dispatch event has effectiveBindCount > 0",
    typeof data.effectiveBindCount === "number" && data.effectiveBindCount >= 2,
    `count=${data.effectiveBindCount}`,
  );
  // Paths should be $HOME-redacted (UI keeps full paths, telemetry redacts)
  const ledgerPathSample = data.fromLedger?.[0]?.path ?? "";
  if (HOME && tempCacheDir.startsWith(HOME)) {
    check(
      "bash_dispatch fromLedger paths $HOME-redacted (spec acceptance #22)",
      ledgerPathSample.startsWith("~"),
      `sample path: ${ledgerPathSample}`,
    );
  } else {
    check(
      "bash_dispatch fromLedger paths surface (redaction N/A since tmp not under HOME)",
      ledgerPathSample.length > 0,
    );
  }
}

// ---------- Test 4: Critical-path deny rejection ----------
section("4. Critical-path deny rejection at validation");

const denyResult = await bashTool.call(
  {
    command: "cat /etc/shadow",
    sandbox_permissions: "with_additional_permissions",
    additional_permissions: {
      file_system: { read: ["/etc/shadow"] },
    },
    justification: "want to read /etc/shadow",
  },
  mockContext as Parameters<typeof bashTool.call>[1],
);
const denyData = String((denyResult as { data?: unknown }).data ?? "");
check(
  "/etc/shadow rejected at validation (tool_use_error)",
  denyData.includes("tool_use_error") && denyData.includes("non-grantable"),
  denyData.slice(0, 200),
);

// ---------- Test 5: request_permissions standalone tool ----------
if (requestPermissionsTool) {
  section("5. request_permissions standalone tool — batch grant");

  // Reset ledger for clean state
  __clearAllApprovalTrustForTests();
  recordedEvents.length = 0;

  const approvePromise2 = autoApproveOnAppear();
  const rpResult = await Promise.all([
    approvePromise2,
    requestPermissionsTool.call(
      {
        permissions: {
          file_system: {
            write: [tempCacheDir],
          },
        },
        reason: "Set up build env for the rest of this task",
      },
      mockContext as Parameters<typeof requestPermissionsTool.call>[1],
    ),
  ]);
  const rpData = String((rpResult[1] as { data?: unknown }).data ?? "");
  check(
    "request_permissions returns success (not tool_use_error)",
    !rpData.includes("tool_use_error"),
    rpData.slice(0, 200),
  );
  // Parse the JSON return
  try {
    const parsed = JSON.parse(rpData);
    check(
      "request_permissions returns { permissions, scope, ... }",
      "permissions" in parsed && "scope" in parsed,
    );
    check(
      "scope reflects actual user choice (task) — Q1a fix",
      parsed.scope === "task",
      `got scope=${parsed.scope}`,
    );
  } catch (err) {
    check("request_permissions return parsable", false, String(err).slice(0, 100));
  }
}

// ---------- Cleanup ----------
rmSync(tempWorkspace, { recursive: true, force: true });
__clearAllApprovalTrustForTests();

// ---------- Summary ----------
console.log(`\n=========================`);
console.log(`E2E test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll v4.3 E2E tests pass. ✓\n");
process.exit(0);
