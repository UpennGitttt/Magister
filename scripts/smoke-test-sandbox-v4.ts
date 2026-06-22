/**
 * Sandbox-elevation v4.3 smoke test — exercises the actual modules
 * with realistic inputs and asserts the contracts hold end-to-end.
 *
 * Why not unit tests: this verifies the WIRING between modules — bash
 * dispatcher → approval service → trust ledger → sandbox builder — in
 * a way that catches integration breakage unit tests miss.
 *
 * Why not full E2E: spinning up the API + a real LLM is overkill +
 * non-deterministic. This script exercises the deterministic paths.
 *
 * Run: `MAGISTER_PERMISSIONS_V4=on bun scripts/smoke-test-sandbox-v4.ts`
 */
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

import {
  classifyPathSensitivity,
  isCriticallyDenied,
} from "../apps/api/src/services/safe-apply/path-sensitivity";
import {
  validateAndNormalize,
  PermissionValidationError,
} from "../apps/api/src/services/safe-apply/additional-permissions";
import {
  buildBubblewrapSandboxCommand,
} from "../apps/api/src/services/safe-apply/execution-sandbox-service";
import {
  scoreToolCall,
} from "../apps/api/src/services/safe-apply/risk-classifier";
import {
  sanitizeJustification,
} from "../apps/api/src/services/safe-apply/justification-sanitizer";
import {
  addApprovalTrust,
  __clearAllApprovalTrustForTests,
  findGrantedAdditionalPermissions,
  findCoveringPermissionGrant,
  findCoveringPermissionGrantExpiry,
  consumeExpiredAdditionalPermissionsForTask,
  isTrustedForApproval,
} from "../apps/api/src/services/command-approval-service";

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

const HOME = homedir();

// ---------- 1. Path sensitivity classifier ----------
section("1. Path sensitivity classifier — core deny-list");
check(
  "/etc/shadow read → critical",
  classifyPathSensitivity("/etc/shadow", "read").level === "critical",
);
check(
  "~/.ssh/authorized_keys write → critical",
  classifyPathSensitivity(`${HOME}/.ssh/authorized_keys`, "write").level === "critical",
);
check(
  "~/.cache/uv write → safe",
  classifyPathSensitivity(`${HOME}/.cache/uv`, "write").level === "safe",
);
check(
  "~/.cargo/bin write → caution (PATH supply-chain)",
  classifyPathSensitivity(`${HOME}/.cargo/bin/cargo`, "write").level === "caution",
);
check(
  "isCriticallyDenied helper agrees",
  isCriticallyDenied("/etc/shadow", "read") === true
    && isCriticallyDenied(`${HOME}/.cache/uv`, "write") === false,
);

// ---------- 2. additional-permissions validator ----------
section("2. additional-permissions validator");
try {
  const result = validateAndNormalize({
    raw: {
      file_system: {
        read: [`${HOME}/.gitconfig`],
        write: [`${HOME}/.cache/uv`],
      },
    },
    mode: "with_additional_permissions",
    canonicalize: (p) => p,
  });
  check(
    "valid profile validates",
    result.profile.file_system?.entries.length === 2,
  );
} catch (err) {
  check("valid profile validates", false, String(err));
}

try {
  validateAndNormalize({
    raw: { file_system: { read: ["/etc/shadow"] } },
    mode: "with_additional_permissions",
    canonicalize: (p) => p,
  });
  check("critical path rejected", false, "should have thrown");
} catch (err) {
  check(
    "critical path rejected at validation",
    err instanceof PermissionValidationError && err.code === "path_on_deny_list",
  );
}

try {
  validateAndNormalize({
    raw: { file_system: { read: ["/tmp/foo\nbar"] } },
    mode: "with_additional_permissions",
    canonicalize: (p) => p,
  });
  check("control-char path rejected", false, "should have thrown");
} catch (err) {
  check(
    "control-char path rejected",
    err instanceof PermissionValidationError && err.code === "path_forbidden_chars",
  );
}

try {
  validateAndNormalize({
    raw: { file_system: { read: ["/tmp/*"] } },
    mode: "with_additional_permissions",
    canonicalize: (p) => p,
  });
  check("glob path rejected", false, "should have thrown");
} catch (err) {
  check(
    "glob path rejected",
    err instanceof PermissionValidationError && err.code === "path_glob_unsupported",
  );
}

// access:"none" → metadata only, NOT escalation
const noneResult = validateAndNormalize({
  raw: { file_system: { entries: [{ path: `${HOME}/.aws/credentials`, access: "none" }] } },
  mode: "with_additional_permissions",
  canonicalize: (p) => p,
});
check(
  "access:none demoted to use_default (NOT require_escalated)",
  noneResult.effectiveMode === "use_default",
);
check(
  "access:none surfaces in denyReadRequestedButUnsupported",
  noneResult.denyReadRequestedButUnsupported.length === 1,
);

// ---------- 3. Risk classifier ----------
section("3. Risk classifier — with_additional_permissions → HIGH");
check(
  "with_additional_permissions → HIGH",
  scoreToolCall({
    toolName: "bash",
    input: { command: "cat README.md", sandbox_permissions: "with_additional_permissions" },
  }).riskClass === "HIGH",
);
check(
  "require_escalated → HIGH",
  scoreToolCall({
    toolName: "bash",
    input: { command: "ls", sandbox_permissions: "require_escalated" },
  }).riskClass === "HIGH",
);
check(
  "default bash → MEDIUM",
  scoreToolCall({
    toolName: "bash",
    input: { command: "ls" },
  }).riskClass === "MEDIUM",
);
check(
  "rm -rf / hard-blocked (CRITICAL beats with_additional_permissions)",
  scoreToolCall({
    toolName: "bash",
    input: { command: "rm -rf /", sandbox_permissions: "with_additional_permissions" },
  }).riskClass === "CRITICAL",
);

// ---------- 4. Justification sanitizer ----------
section("4. Justification sanitizer");
check(
  "strips RTL override",
  !sanitizeJustification("ok‮ malicious").includes("‮"),
);
check(
  "strips zero-width",
  !sanitizeJustification("a​b").includes("​"),
);
check(
  "strips combining diacritics",
  sanitizeJustification("á") === "a",
);
check(
  "preserves normal multi-line",
  sanitizeJustification("Line 1\nLine 2") === "Line 1\nLine 2",
);
check(
  "caps at 500 chars",
  sanitizeJustification("x".repeat(1000)).length === 500,
);

// ---------- 5. Sandbox builder extraBinds + TOCTOU ----------
section("5. Sandbox builder extraBinds");
const tempDir = mkdtempSync(join(tmpdir(), "smoke-"));
try {
  const cacheDir = join(tempDir, "cache");
  writeFileSync(cacheDir, "");

  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/bin/echo",
    args: ["hi"],
    cwd: tempDir,
    env: {},
    baseWorkspaceDir: null,
    runtimeWorkspaceDir: tempDir,
    runtimeHomeDir: join(tempDir, "home"),
    runtimeTmpDir: join(tempDir, "tmp"),
    network: "host",
    systemReadOnlyBinds: [],
    extraBinds: [{ path: cacheDir, access: "read" }],
    classifyOptions: {},
  });
  check(
    "extraBinds emit --ro-bind for read entries",
    plan.args.join("\0").includes(`--ro-bind\0${cacheDir}\0${cacheDir}`),
  );
  check(
    "missingExtraBinds returned (empty when paths exist)",
    Array.isArray(plan.missingExtraBinds) && plan.missingExtraBinds.length === 0,
  );

  // Build with non-existent path → missingExtraBinds populated
  const ghost = join(tempDir, "ghost-no-such");
  const plan2 = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/bin/echo",
    args: ["hi"],
    cwd: tempDir,
    env: {},
    baseWorkspaceDir: null,
    runtimeWorkspaceDir: tempDir,
    runtimeHomeDir: join(tempDir, "home"),
    runtimeTmpDir: join(tempDir, "tmp"),
    network: "host",
    systemReadOnlyBinds: [],
    extraBinds: [{ path: ghost, access: "read" }],
    classifyOptions: {},
  });
  check(
    "ENOENT path accumulates in missingExtraBinds",
    plan2.missingExtraBinds.includes(ghost),
  );

  // classifyOptions required when extraBinds present
  try {
    buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: tempDir,
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: cacheDir, access: "read" }],
      // classifyOptions intentionally omitted
    });
    check("classifyOptions required when extraBinds set", false, "should have thrown");
  } catch (err) {
    check(
      "classifyOptions required when extraBinds set (codex HIGH Q4 fix)",
      String(err).includes("classifyOptions is required"),
    );
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------- 6. Trust ledger v4.3 helpers ----------
section("6. Trust ledger v4.3 helpers — split-entry + subset check");
__clearAllApprovalTrustForTests();
const TASK = "smoke_task_1";

// Permission-only grant (request_permissions style)
addApprovalTrust(TASK, "bash", "paths:*", null, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
  },
});

// Permission grant should NOT match wildcard lookup
check(
  "Permission-only grant DOES NOT trust wildcard (codex BLOCKER Q2 fix)",
  isTrustedForApproval(TASK, "bash", "*") === false,
);

// Permission grant should cover its own request
check(
  "Permission grant covers requested subset (codex BLOCKER Q3c fix)",
  findCoveringPermissionGrant(TASK, {
    file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
  }) !== null,
);

// Permission grant should NOT cover unrelated path
check(
  "Permission grant does NOT cover unrelated path",
  findCoveringPermissionGrant(TASK, {
    file_system: { entries: [{ path: "/etc/sudoers", access: "write" }] },
  }) === null,
);

// write covers read
__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", null, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "write" }] },
  },
});
check(
  "write grant covers read request",
  findCoveringPermissionGrant(TASK, {
    file_system: { entries: [{ path: "/a", access: "read" }] },
  }) !== null,
);

// read does NOT cover write
__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", null, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "read" }] },
  },
});
check(
  "read grant does NOT cover write request",
  findCoveringPermissionGrant(TASK, {
    file_system: { entries: [{ path: "/a", access: "write" }] },
  }) === null,
);

// ---------- 7. Scope reflection ----------
section("7. Scope reflection — Q1a fix");
__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", null, {  // null = task scope → 72h
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "write" }] },
  },
});
const taskExpiry = findCoveringPermissionGrantExpiry(TASK, {
  file_system: { entries: [{ path: "/a", access: "write" }] },
});
check(
  "task-scope expiry > now + 1h",
  taskExpiry !== null && taskExpiry > Date.now() + 60 * 60 * 1000,
);
check(
  "task-scope expiry < now + 72h + 1s (cap)",
  taskExpiry !== null && taskExpiry < Date.now() + 72 * 60 * 60 * 1000 + 1000,
);

__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", 5 * 60 * 1000, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "write" }] },
  },
});
const fiveMinExpiry = findCoveringPermissionGrantExpiry(TASK, {
  file_system: { entries: [{ path: "/a", access: "write" }] },
});
check(
  "5-min scope expiry < now + 1h (→ scope='turn')",
  fiveMinExpiry !== null && fiveMinExpiry < Date.now() + 60 * 60 * 1000,
);

// ---------- 8. Grants expired notice ----------
section("8. Grants expired notice — Q1d fix");
__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", 0, {  // durationMs=0 = instantly expired
  additionalPermissions: {
    file_system: { entries: [{ path: "/expired", access: "write" }] },
  },
});
addApprovalTrust(TASK, "bash", "paths:*", null, {  // task scope (long-lived)
  additionalPermissions: {
    file_system: { entries: [{ path: "/active", access: "read" }] },
  },
});
const expired = consumeExpiredAdditionalPermissionsForTask(TASK);
check(
  "expired entry surfaces",
  expired.length === 1 && expired[0]!.path === "/expired",
);
check(
  "active entry survives consumption",
  findCoveringPermissionGrant(TASK, {
    file_system: { entries: [{ path: "/active", access: "read" }] },
  }) !== null,
);
check(
  "second consume returns empty (one-shot)",
  consumeExpiredAdditionalPermissionsForTask(TASK).length === 0,
);

// ---------- 9. Union semantics ----------
section("9. Union semantics — auto-inheritance");
__clearAllApprovalTrustForTests();
addApprovalTrust(TASK, "bash", "paths:*", null, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "read" }] },
  },
});
addApprovalTrust(TASK, "bash", "paths:*", null, {
  additionalPermissions: {
    file_system: { entries: [{ path: "/a", access: "write" }] },
  },
});
const union = findGrantedAdditionalPermissions(TASK, "bash");
check(
  "write covers read across grants (union)",
  union?.file_system?.entries.length === 1
    && union?.file_system?.entries[0]?.access === "write",
);

// Cleanup
__clearAllApprovalTrustForTests();

// ---------- Summary ----------
console.log(`\n=========================`);
console.log(`Smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll v4.3 smoke tests pass. ✓");
process.exit(0);
