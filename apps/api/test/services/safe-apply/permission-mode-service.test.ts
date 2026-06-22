import { expect, test } from "bun:test";

import { derivePermissionMode } from "../../../src/services/safe-apply/permission-mode-service";

test("classifies codex --full-auto as headless", () => {
  const result = derivePermissionMode({
    runtimeSource: "codex",
    argv: ["exec", "--full-auto", "implement the task"],
    sandboxMode: "workspace-write",
    envPermissionHints: [],
    hasInteractiveApprovalChannel: false,
  });

  expect(result.permissionMode).toBe("headless");
  expect(result.permissionSignals).toContain("argv:--full-auto");
});

test("classifies danger-full-access sandbox as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "codex",
    argv: ["exec", "--sandbox", "danger-full-access", "implement the task"],
    sandboxMode: "danger-full-access",
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("sandbox:danger-full-access");
});

test("classifies codex dangerous bypass flag as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "codex",
    argv: ["exec", "--dangerously-bypass-approvals-and-sandbox", "implement the task"],
    sandboxMode: "workspace-write",
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("argv:--dangerously-bypass-approvals-and-sandbox");
});

test("classifies claude dangerous skip flag as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "claude-code",
    argv: ["--dangerously-skip-permissions", "-p", "review this patch"],
    sandboxMode: null,
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("argv:--dangerously-skip-permissions");
});

test("classifies claude explicit bypass permission mode as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "claude-code",
    argv: ["--permission-mode", "bypassPermissions", "-p", "review this patch"],
    sandboxMode: null,
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("argv:--permission-mode=bypassPermissions");
});

test("classifies claude print mode with acceptEdits as headless", () => {
  const result = derivePermissionMode({
    runtimeSource: "claude-code",
    argv: ["--permission-mode", "acceptEdits", "-p", "review this patch"],
    sandboxMode: null,
    envPermissionHints: [],
    hasInteractiveApprovalChannel: false,
  });

  expect(result.permissionMode).toBe("headless");
  expect(result.permissionSignals).toContain("argv:-p");
  expect(result.permissionSignals).toContain("argv:--permission-mode=acceptEdits");
  expect(result.permissionSignals).toContain("approval:non-interactive");
});

test("classifies claude IS_SANDBOX plus non-interactive execution as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "claude-code",
    argv: ["-p", "review this patch"],
    sandboxMode: null,
    envPermissionHints: ["IS_SANDBOX"],
    hasInteractiveApprovalChannel: false,
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("env:IS_SANDBOX");
  expect(result.permissionSignals).toContain("approval:non-interactive");
});

test("classifies opencode run as headless", () => {
  const result = derivePermissionMode({
    runtimeSource: "opencode",
    argv: ["run", "--format", "json", "implement the task"],
    sandboxMode: "workspace-write",
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("headless");
  expect(result.permissionSignals).toContain("argv:run");
});

test("classifies opencode dangerous skip flag as bypassed", () => {
  const result = derivePermissionMode({
    runtimeSource: "opencode",
    argv: ["run", "--dangerously-skip-permissions", "implement the task"],
    sandboxMode: "workspace-write",
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("argv:--dangerously-skip-permissions");
});

test("classifies Magister built-in runtime as interactive", () => {
  const result = derivePermissionMode({
    runtimeSource: "ucm",
    argv: [],
    sandboxMode: null,
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("interactive");
  expect(result.permissionSignals).toContain("runtime:ucm");
});

test("classifies permission env allow-all hints as bypassed without storing values", () => {
  const result = derivePermissionMode({
    runtimeSource: "opencode",
    argv: ["run", "implement the task"],
    sandboxMode: "workspace-write",
    envPermissionHints: ["OPENCODE_PERMISSION", "CUSTOM_PERMISSION_MODE"],
  });

  expect(result.permissionMode).toBe("bypassed");
  expect(result.permissionSignals).toContain("env:OPENCODE_PERMISSION");
  expect(result.permissionSignals.join(" ")).not.toContain("allow");
});

test("uses unknown when runtime cannot be classified", () => {
  const result = derivePermissionMode({
    runtimeSource: "unknown",
    argv: ["mystery", "implement the task"],
    sandboxMode: null,
    envPermissionHints: [],
  });

  expect(result.permissionMode).toBe("unknown");
  expect(result.permissionSignals).toContain("runtime:unknown");
});
