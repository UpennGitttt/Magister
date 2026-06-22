import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessExecutionSandbox,
  buildBubblewrapSandboxCommand,
  prepareExecutionSandboxCommand,
  resolveExecutionSandboxConfig,
} from "../../../src/services/safe-apply/execution-sandbox-service";

const baseInput = {
  runtimeSource: "codex" as const,
  runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
  baseWorkspaceDir: "/repo",
  runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
  runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
  homeIsolated: true,
};

function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

test("resolveExecutionSandboxConfig defaults to optional auto host (spec §1.10 decision)", () => {
  // Spec §1.10 locked decision #1 (2026-05-17): default mode flipped
  // from "off" to "optional" so the sandbox protocol's protections
  // (bwrap env allowlist, /tmp isolation, CRITICAL hard-block path)
  // are active by default — bwrap is used when available, falls
  // back to unsandboxed if missing.
  expect(resolveExecutionSandboxConfig({})).toEqual({
    mode: "optional",
    provider: "auto",
    network: "host",
  });
});

test("assessExecutionSandbox off returns disabled metadata without path lookup", async () => {
  let lookups = 0;
  const metadata = await assessExecutionSandbox({
    ...baseInput,
    config: {
      mode: "off",
      provider: "auto",
      network: "host",
      commandResolver: async () => {
        lookups += 1;
        return "/usr/bin/bwrap";
      },
    },
  });

  expect(lookups).toBe(0);
  expect(metadata).toMatchObject({
    mode: "off",
    provider: "none",
    status: "disabled",
    commandPath: null,
    reason: "mode_off",
    network: "host",
    filesystem: {
      mainWorkspace: "not_isolated",
      runtimeWorkspace: "host_writable",
      home: "isolated",
      tmp: "host",
    },
  });
});

test("assessExecutionSandbox optional missing bubblewrap reports unavailable", async () => {
  const metadata = await assessExecutionSandbox({
    ...baseInput,
    homeIsolated: false,
    config: {
      mode: "optional",
      provider: "bubblewrap",
      network: "host",
      commandResolver: async () => null,
    },
  });

  expect(metadata).toMatchObject({
    mode: "optional",
    provider: "bubblewrap",
    status: "unavailable",
    commandPath: null,
    reason: "provider_not_found",
    filesystem: {
      home: "host",
      tmp: "host",
    },
  });
});

test("assessExecutionSandbox optional available provider is not active in V2A", async () => {
  const metadata = await assessExecutionSandbox({
    ...baseInput,
    config: {
      mode: "optional",
      provider: "auto",
      network: "host",
      commandResolver: async (command) => command === "bwrap" ? "/usr/bin/bwrap" : null,
    },
  });

  expect(metadata).toMatchObject({
    mode: "optional",
    provider: "bubblewrap",
    status: "available",
    commandPath: "/usr/bin/bwrap",
    reason: "provider_available_not_wrapping",
  });
});

test("buildBubblewrapSandboxCommand read-only binds main workspace and writable-binds runtime dirs", () => {
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
    env: {},
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
    runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
    runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
    network: "host",
    systemReadOnlyBinds: ["/usr", "/bin"],
  });

  expect(plan.command).toBe("/usr/bin/bwrap");
  expect(plan.args).toEqual(expect.arrayContaining([
    "--ro-bind",
    "/repo",
    "--bind",
    "/repo/.magister/runtime-workspaces/runs/task/run",
    "--chdir",
    "/repo/.magister/runtime-workspaces/runs/task/run",
    "--",
    "/usr/bin/codex",
  ]));
  expect(plan.args.join("\0")).toContain("/repo\0/repo");
  expect(plan.args.join("\0")).toContain(
    "/repo/.magister/runtime-workspaces/runs/task/run\0/repo/.magister/runtime-workspaces/runs/task/run",
  );
  expect(plan.args).not.toContain("--unshare-net");
});

test("buildBubblewrapSandboxCommand disables network when configured", () => {
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/usr/bin/opencode",
    args: ["run", "hello"],
    cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
    env: {},
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
    runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
    runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
    network: "disabled",
    systemReadOnlyBinds: [],
  });

  expect(plan.args).toContain("--unshare-net");
});

test("buildBubblewrapSandboxCommand binds host DNS config at its real path", () => {
  // The host symlinks /etc/resolv.conf → /run/systemd/resolve/resolv.conf
  // on most distros; without binding the real target file, the symlink
  // dangles inside the sandbox (since /run/ is not bound). The builder
  // resolves the host's symlink chain and binds the REAL file at its
  // real path (not at /etc/resolv.conf — bwrap would follow the
  // existing symlink and fail to create the dangling target).
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/bin/echo",
    args: ["hi"],
    cwd: "/repo",
    env: {},
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/runtime",
    runtimeHomeDir: "/repo/home",
    runtimeTmpDir: "/repo/tmp",
    network: "host",
    systemReadOnlyBinds: [],
  });
  const joined = plan.args.join("\0");
  if (existsSync("/etc/resolv.conf")) {
    // Real path is bound to itself: `--ro-bind <path> <same path>`.
    expect(joined).toMatch(/--ro-bind\0([^\0]+resolv\.conf)\0\1/);
  }
});

test("buildBubblewrapSandboxCommand read-only binds resolved command directory", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-bwrap-command-"));
  try {
    const commandPath = join(tempDir, "codex");
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(commandPath, 0o755);

    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "codex",
      args: ["exec", "hello"],
      cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
      env: { PATH: tempDir },
      baseWorkspaceDir: "/repo",
      runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
      runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
      runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
      network: "host",
      systemReadOnlyBinds: [],
    });

    expect(plan.args.join("\0")).toContain(`${tempDir}\0${tempDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepareExecutionSandboxCommand activates optional available bubblewrap metadata", () => {
  const available = {
    mode: "optional" as const,
    provider: "bubblewrap" as const,
    status: "available" as const,
    commandPath: "/usr/bin/bwrap",
    reason: "provider_available_not_wrapping",
    network: "host" as const,
    filesystem: {
      mainWorkspace: "not_isolated" as const,
      runtimeWorkspace: "host_writable" as const,
      home: "isolated" as const,
      tmp: "host" as const,
    },
  };
  const plan = prepareExecutionSandboxCommand({
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
    env: {},
    executionSandbox: available,
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
    runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
    runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
    systemReadOnlyBinds: [],
  });

  expect(plan.type).toBe("wrapped");
  expect(plan.executionSandbox).toMatchObject({
    status: "active",
    reason: "wrapped",
    filesystem: {
      mainWorkspace: "read_only",
      runtimeWorkspace: "sandbox_writable",
    },
  });
});

test("prepareExecutionSandboxCommand fails required unavailable sandbox before execution", () => {
  const unavailable = {
    mode: "required" as const,
    provider: "bubblewrap" as const,
    status: "unavailable" as const,
    commandPath: null,
    reason: "provider_not_found",
    network: "host" as const,
    filesystem: {
      mainWorkspace: "not_isolated" as const,
      runtimeWorkspace: "host_writable" as const,
      home: "isolated" as const,
      tmp: "host" as const,
    },
  };

  const plan = prepareExecutionSandboxCommand({
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
    env: {},
    executionSandbox: unavailable,
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
    runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
    runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
    systemReadOnlyBinds: [],
  });

  expect(plan.type).toBe("failed");
  if (plan.type !== "failed") throw new Error("Expected failed plan");
  expect(plan.failureReason).toContain("provider_not_found");
});

test("prepareExecutionSandboxCommand fails required disabled sandbox before execution", () => {
  const disabled = {
    mode: "required" as const,
    provider: "none" as const,
    status: "disabled" as const,
    commandPath: null,
    reason: "provider_none",
    network: "host" as const,
    filesystem: {
      mainWorkspace: "not_isolated" as const,
      runtimeWorkspace: "host_writable" as const,
      home: "isolated" as const,
      tmp: "host" as const,
    },
  };

  const plan = prepareExecutionSandboxCommand({
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo/.magister/runtime-workspaces/runs/task/run",
    env: {},
    executionSandbox: disabled,
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/.magister/runtime-workspaces/runs/task/run",
    runtimeHomeDir: "/repo/.magister/runtime-workspaces/runs/task/run/home",
    runtimeTmpDir: "/repo/.magister/runtime-workspaces/runs/task/run/tmp",
    systemReadOnlyBinds: [],
  });

  expect(plan.type).toBe("failed");
  if (plan.type !== "failed") throw new Error("Expected failed plan");
  expect(plan.failureReason).toContain("provider_none");
});

test("prepareExecutionSandboxCommand optional same workspace runs unwrapped with unavailable metadata", () => {
  const available = {
    mode: "optional" as const,
    provider: "bubblewrap" as const,
    status: "available" as const,
    commandPath: "/usr/bin/bwrap",
    reason: "provider_available_not_wrapping",
    network: "host" as const,
    filesystem: {
      mainWorkspace: "not_isolated" as const,
      runtimeWorkspace: "host_writable" as const,
      home: "host" as const,
      tmp: "host" as const,
    },
  };

  const plan = prepareExecutionSandboxCommand({
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo",
    env: {},
    executionSandbox: available,
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo",
    runtimeHomeDir: "/repo/.magister/cli-home/codex",
    runtimeTmpDir: "/repo/.magister/cli-tmp/codex",
    systemReadOnlyBinds: [],
  });

  expect(plan.type).toBe("unwrapped");
  expect(plan.executionSandbox).toMatchObject({
    status: "unavailable",
    reason: "runtime_workspace_not_isolated",
  });
});

test("prepareExecutionSandboxCommand refuses to activate when runtime workspace equals main workspace", () => {
  const available = {
    mode: "required" as const,
    provider: "bubblewrap" as const,
    status: "available" as const,
    commandPath: "/usr/bin/bwrap",
    reason: "provider_available_not_wrapping",
    network: "host" as const,
    filesystem: {
      mainWorkspace: "not_isolated" as const,
      runtimeWorkspace: "host_writable" as const,
      home: "host" as const,
      tmp: "host" as const,
    },
  };

  const plan = prepareExecutionSandboxCommand({
    command: "/usr/bin/codex",
    args: ["exec", "hello"],
    cwd: "/repo",
    env: {},
    executionSandbox: available,
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo",
    runtimeHomeDir: "/repo/.magister/cli-home/codex",
    runtimeTmpDir: "/repo/.magister/cli-tmp/codex",
    systemReadOnlyBinds: [],
  });

  expect(plan.type).toBe("failed");
  expect(plan.executionSandbox).toMatchObject({
    status: "unavailable",
    reason: "runtime_workspace_not_isolated",
  });
});

test("prepareExecutionSandboxCommand follows symlinks when comparing base and runtime workspaces", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-bwrap-workspace-"));
  try {
    const baseWorkspace = join(tempDir, "repo");
    const runtimeWorkspace = join(tempDir, "runtime-link");
    mkdirSync(baseWorkspace, { recursive: true });
    symlinkSync(baseWorkspace, runtimeWorkspace, "dir");
    const available = {
      mode: "required" as const,
      provider: "bubblewrap" as const,
      status: "available" as const,
      commandPath: "/usr/bin/bwrap",
      reason: "provider_available_not_wrapping",
      network: "host" as const,
      filesystem: {
        mainWorkspace: "not_isolated" as const,
        runtimeWorkspace: "host_writable" as const,
        home: "host" as const,
        tmp: "host" as const,
      },
    };

    const plan = prepareExecutionSandboxCommand({
      command: "/usr/bin/codex",
      args: ["exec", "hello"],
      cwd: runtimeWorkspace,
      env: {},
      executionSandbox: available,
      baseWorkspaceDir: baseWorkspace,
      runtimeWorkspaceDir: runtimeWorkspace,
      runtimeHomeDir: join(runtimeWorkspace, "home"),
      runtimeTmpDir: join(runtimeWorkspace, "tmp"),
      systemReadOnlyBinds: [],
    });

    expect(plan.type).toBe("failed");
    expect(plan.executionSandbox).toMatchObject({
      status: "unavailable",
      reason: "runtime_workspace_not_isolated",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Sandbox-elevation v4.3 §4.4 — extraBinds + allowNetwork ----------

test("buildBubblewrapSandboxCommand emits --ro-bind for extraBinds read entries", () => {
  // The bind-time TOCTOU defense calls realpathSync on each path, so
  // the path must exist. Use a real tmp file.
  const tempDir = mkdtempSync(join(tmpdir(), "magister-extrabind-"));
  try {
    const filePath = join(tempDir, "config.json");
    writeFileSync(filePath, "{}", "utf8");
    const canonicalFilePath = canonicalPath(filePath);

    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: canonicalFilePath, access: "read" }],
      classifyOptions: {},
    });

    const joined = plan.args.join("\0");
    expect(joined).toContain(`--ro-bind\0${canonicalFilePath}\0${canonicalFilePath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand emits --bind for extraBinds write entries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-extrabind-"));
  try {
    const filePath = join(tempDir, "cache");
    mkdirSync(filePath, { recursive: true });
    const canonicalFilePath = canonicalPath(filePath);

    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: canonicalFilePath, access: "write" }],
      classifyOptions: {},
    });

    const joined = plan.args.join("\0");
    expect(joined).toContain(`--bind\0${canonicalFilePath}\0${canonicalFilePath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand TOCTOU defense — symlink swap between approval and bind throws", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-toctou-"));
  try {
    const realA = join(tempDir, "real-a");
    const realB = join(tempDir, "real-b");
    mkdirSync(realA);
    mkdirSync(realB);
    const canonicalRealA = canonicalPath(realA);
    const symlink = join(tempDir, "approved-path");
    symlinkSync(realA, symlink);

    // Approval-time canonical resolved the symlink to realA. Now swap.
    rmSync(symlink);
    symlinkSync(realB, symlink);

    // The extraBind carries the ORIGINAL canonical (realA), but
    // bind-time realpath now returns realB → mismatch → throw.
    expect(() => buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: canonicalRealA, access: "read" }],   // approval-time canonical
      classifyOptions: {},
      // But we pass the symlink path which now resolves to realB
    })).not.toThrow();  // passing realA directly works (it's still realA)

    // For actual TOCTOU we need to pass a path that USED to resolve to
    // realA but now resolves to realB. We'd have to bind the symlink
    // path itself. The defense kicks in when the canonical changes.
    expect(() => buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      // Pass symlink path — bind-time realpath returns realB,
      // mismatch vs the symlink path itself.
      extraBinds: [{ path: symlink, access: "read" }],
      classifyOptions: {},
    })).toThrow(/canonical mismatch|refusing to bind/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand extraBinds skips ENOENT (approved path no longer exists)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-extrabind-enoent-"));
  try {
    const ghostPath = join(tempDir, "ghost");
    // Don't create the file — bind-time realpath returns ENOENT.

    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: ghostPath, access: "read" }],
      classifyOptions: {},
    });

    // ENOENT skipped silently — no bind emitted, but no throw either
    const joined = plan.args.join("\0");
    expect(joined).not.toContain(ghostPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand allowNetwork=true overrides metadata 'disabled'", () => {
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/bin/echo",
    args: ["hi"],
    cwd: "/tmp",
    env: {},
    baseWorkspaceDir: null,
    runtimeWorkspaceDir: "/tmp/rw",
    runtimeHomeDir: "/tmp/home",
    runtimeTmpDir: "/tmp/tmp",
    network: "disabled",       // would unshare-net by default
    systemReadOnlyBinds: [],
    allowNetwork: true,         // but override allows host network
  });

  expect(plan.args).not.toContain("--unshare-net");
});

test("buildBubblewrapSandboxCommand allowNetwork=true when network=host is no-op", () => {
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/bin/echo",
    args: ["hi"],
    cwd: "/tmp",
    env: {},
    baseWorkspaceDir: null,
    runtimeWorkspaceDir: "/tmp/rw",
    runtimeHomeDir: "/tmp/home",
    runtimeTmpDir: "/tmp/tmp",
    network: "host",
    systemReadOnlyBinds: [],
    allowNetwork: true,
  });

  expect(plan.args).not.toContain("--unshare-net");
});

test("buildBubblewrapSandboxCommand THROWS when extraBinds has entries but classifyOptions is undefined (codex A.3 review HIGH Q4)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-classify-required-"));
  try {
    const file = join(tempDir, "x");
    writeFileSync(file, "");

    expect(() => buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: file, access: "read" }],
      // classifyOptions: undefined — should throw
    })).toThrow(/classifyOptions is required/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand REJECTS extraBind targeting reserved runtime path (codex A.3 review Q1 MEDIUM)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-collision-"));
  try {
    expect(() => buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      // Try to write-bind the runtime workspace itself — collision
      extraBinds: [{ path: tempDir, access: "write" }],
      classifyOptions: {},
    })).toThrow(/runtime-reserved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand returns missingExtraBinds for ENOENT paths (codex A.3 review Q3 MEDIUM)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-missingbind-"));
  try {
    const ghostPath = join(tempDir, "ghost-no-such-file");
    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [{ path: ghostPath, access: "read" }],
      classifyOptions: {},
    });
    expect(plan.missingExtraBinds).toEqual([ghostPath]);
    // The ghost path doesn't land in args
    expect(plan.args.join("\0")).not.toContain(ghostPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand mixed read/write extraBinds in one call", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "magister-mixed-"));
  try {
    const readFile = join(tempDir, "readme.txt");
    const writeDir = join(tempDir, "cache");
    writeFileSync(readFile, "");
    mkdirSync(writeDir);
    const canonicalReadFile = canonicalPath(readFile);
    const canonicalWriteDir = canonicalPath(writeDir);

    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/bin/echo",
      args: ["hi"],
      cwd: "/tmp",
      env: {},
      baseWorkspaceDir: null,
      runtimeWorkspaceDir: tempDir,
      runtimeHomeDir: join(tempDir, "home"),
      runtimeTmpDir: join(tempDir, "tmp"),
      network: "host",
      systemReadOnlyBinds: [],
      extraBinds: [
        { path: canonicalReadFile, access: "read" },
        { path: canonicalWriteDir, access: "write" },
      ],
      classifyOptions: {},
    });
    const joined = plan.args.join("\0");
    expect(joined).toContain(`--ro-bind\0${canonicalReadFile}\0${canonicalReadFile}`);
    expect(joined).toContain(`--bind\0${canonicalWriteDir}\0${canonicalWriteDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand binds MAGISTER_EXTRA_ACCESS_ROOTS (ro + :rw)", () => {
  const roRoot = mkdtempSync(join(tmpdir(), "extra-ro-"));
  const rwRoot = mkdtempSync(join(tmpdir(), "extra-rw-"));
  try {
    const canonicalRoRoot = canonicalPath(roRoot);
    const canonicalRwRoot = canonicalPath(rwRoot);
    const plan = buildBubblewrapSandboxCommand({
      bwrapCommandPath: "/usr/bin/bwrap",
      command: "/usr/bin/codex",
      args: ["exec", "hi"],
      cwd: "/repo/run",
      env: { MAGISTER_EXTRA_ACCESS_ROOTS: `${roRoot},${rwRoot}:rw` },
      baseWorkspaceDir: "/repo",
      runtimeWorkspaceDir: "/repo/run",
      runtimeHomeDir: "/repo/run/home",
      runtimeTmpDir: "/repo/run/tmp",
      network: "host",
      systemReadOnlyBinds: [],
    });
    const joined = plan.args.join("\0");
    expect(joined).toContain(`--ro-bind\0${canonicalRoRoot}\0${canonicalRoRoot}`);
    expect(joined).toContain(`--bind\0${canonicalRwRoot}\0${canonicalRwRoot}`);
  } finally {
    rmSync(roRoot, { recursive: true, force: true });
    rmSync(rwRoot, { recursive: true, force: true });
  }
});

test("buildBubblewrapSandboxCommand skips a non-existent extra-access root", () => {
  const missing = join(tmpdir(), "magister-extra-missing-does-not-exist-xyz");
  const plan = buildBubblewrapSandboxCommand({
    bwrapCommandPath: "/usr/bin/bwrap",
    command: "/usr/bin/codex",
    args: ["exec", "hi"],
    cwd: "/repo/run",
    env: { MAGISTER_EXTRA_ACCESS_ROOTS: missing },
    baseWorkspaceDir: "/repo",
    runtimeWorkspaceDir: "/repo/run",
    runtimeHomeDir: "/repo/run/home",
    runtimeTmpDir: "/repo/run/tmp",
    network: "host",
    systemReadOnlyBinds: [],
  });
  expect(plan.args.join("\0")).not.toContain(missing);
});
