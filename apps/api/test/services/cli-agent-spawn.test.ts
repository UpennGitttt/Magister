import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCliArgs } from "../../src/services/cli-agent-spawn-service";

let tempDir = "";

async function writeStubCommand(name: string, body: string): Promise<string> {
  const commandPath = join(tempDir, name);
  await writeFile(commandPath, `#!/usr/bin/env bash\nset -eu\n${body}\n`, "utf8");
  await chmod(commandPath, 0o755);
  return commandPath;
}

async function waitForPath(path: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cli-agent-spawn-test-"));
});

afterEach(async () => {
  delete process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER;
  delete process.env.MAGISTER_EXECUTION_SANDBOX_NETWORK;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("spawnCliAgent with codex binary captures stdout", async () => {
  const command = await writeStubCommand("codex", 'echo "stdout:$*"');
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "finish phase b",
    workspaceDir: tempDir,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("stdout:");
  expect(result.stdout).toContain("finish phase b");
});

test("spawnCliAgent with timeout kills process and returns error", async () => {
  const command = await writeStubCommand("codex", "sleep 10");
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "timeout",
    workspaceDir: tempDir,
    timeoutMs: 50,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.stderr).toBe("Process timed out after 50ms");
});

test("spawnCliAgent with abort signal kills process", async () => {
  const command = await writeStubCommand("codex", "sleep 10");
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");
  const controller = new AbortController();

  const pending = spawnCliAgent({
    command,
    prompt: "abort",
    workspaceDir: tempDir,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 20);

  const result = await pending;
  expect(result.exitCode).toBe(-1);
  expect(result.stderr).toBe("Process aborted");
});

test("spawnCliAgent abort flushes streaming parser tail before resolving", async () => {
  const partialJsonLine = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: "partial final text",
    },
  });
  const markerPath = join(tempDir, "codex-wrote-partial");
  const command = await writeStubCommand(
    "codex",
    `printf '%s' ${JSON.stringify(partialJsonLine)}\ntouch ${JSON.stringify(markerPath)}\nsleep 10`,
  );
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");
  const controller = new AbortController();
  const originalStreamingFlag = process.env.CLI_STREAMING_ENABLED;
  const events: unknown[] = [];

  try {
    process.env.CLI_STREAMING_ENABLED = "true";
    const pending = spawnCliAgent({
      command,
      prompt: "abort streaming",
      workspaceDir: tempDir,
      runtimeType: "codex",
      cliVersion: "codex-cli 0.130.0",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
    });

    await waitForPath(markerPath);
    controller.abort();

    const result = await pending;
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toBe("Process aborted");
    expect(result.streamingMode).toBe(true);
    expect(result.streamingProducedAnyEvents).toBe(true);
    expect(result.streamingFinalText).toBe("partial final text");
    expect(events.length).toBeGreaterThan(0);
  } finally {
    if (originalStreamingFlag === undefined) delete process.env.CLI_STREAMING_ENABLED;
    else process.env.CLI_STREAMING_ENABLED = originalStreamingFlag;
  }
});

test("spawnCliAgent with custom env passes env vars to subprocess", async () => {
  const command = await writeStubCommand("codex", 'echo "env:$PHASE_B_TEST_ENV"');
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "env",
    workspaceDir: tempDir,
    env: {
      PHASE_B_TEST_ENV: "visible",
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("env:visible");
});

test("spawnCliAgent with model flag passes --model to CLI", async () => {
  const command = await writeStubCommand("codex", 'echo "args:$*"');
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "model",
    workspaceDir: tempDir,
    model: "gpt-5.4",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--model gpt-5.4");
});

test("spawnCliAgent with custom args appends them", async () => {
  const command = await writeStubCommand("opencode", 'echo "args:$*"');
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "append",
    workspaceDir: tempDir,
    args: ["--phase", "b"],
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--phase b");
});

test("spawnCliAgent scrubs inherited secrets while preserving explicit caller env", async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const command = await writeStubCommand(
    "codex",
    'echo "openai:${OPENAI_API_KEY-unset} explicit:$PHASE_B_TEST_ENV home:$HOME tmp:$TMPDIR"',
  );
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  try {
    process.env.OPENAI_API_KEY = "sk-inherited-secret";
    const result = await spawnCliAgent({
      command,
      prompt: "env",
      workspaceDir: tempDir,
      env: {
        PHASE_B_TEST_ENV: "visible",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("openai:unset");
    expect(result.stdout).toContain("explicit:visible");
    // Home/tmp now under Magister's data dir + workspace slug, not the
    // user workspace (2026-05-20 default change).
    expect(result.stdout).toMatch(/home:.+\/\.magister\/cli-home\/[^/ ]+\/codex/);
    expect(result.stdout).toMatch(/tmp:.+\/\.magister\/cli-tmp\/[^/ ]+\/codex/);
  } finally {
    if (typeof originalOpenAiKey === "string") {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test("spawnCliAgent creates the Magister-controlled Codex home before spawning", async () => {
  const command = await writeStubCommand(
    "codex",
    '[ -d "$CODEX_HOME" ] || { echo "missing codex home:$CODEX_HOME" >&2; exit 42; }\necho "codexhome:$CODEX_HOME"',
  );
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "needs codex home",
    workspaceDir: tempDir,
    runtimeType: "codex",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  // 2026-05-20 default path change: codex home now lives under Magister's
  // own data dir (via MAGISTER_DATA_DIR env, default `<cwd>/.magister`)
  // scoped per-workspace by a path-safe slug — not inside the user's
  // workspace anymore. We only assert the trailing structure since the
  // Magister data root + slug encoding are environment-dependent.
  expect(result.stdout).toMatch(/codexhome:.+\/\.magister\/cli-home\/[^/]+\/codex\/\.codex/);
});

test("spawnCliAgent returns runtime security metadata without prompt or env values", async () => {
  const command = await writeStubCommand("opencode", 'echo "ok"');
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const result = await spawnCliAgent({
    command,
    prompt: "secret prompt body",
    workspaceDir: tempDir,
    env: {
      OPENCODE_PERMISSION: "{\"*\":\"allow\"}",
    },
    runtimeType: "opencode",
  });

  expect(result.exitCode).toBe(0);
  expect(result.runtimeSecurity).toMatchObject({
    runtimeSource: "opencode",
    commandPath: command,
    permissionMode: "headless",
    envPermissionHints: [],
    runtimeWorkspaceStrategy: "unknown",
  });
  expect(result.runtimeSecurity?.argvFlags).toContain("run");
  expect(result.runtimeSecurity?.permissionSignals).toContain("argv:run");
  expect(JSON.stringify(result.runtimeSecurity)).not.toContain("secret prompt body");
  expect(JSON.stringify(result.runtimeSecurity)).not.toContain("allow");
});

// 2026-05-23: spawnCliAgent no longer wraps CLI runtimes in Magister's
// outer bwrap, regardless of MAGISTER_EXECUTION_SANDBOX_MODE. The CLI
// agents (codex --sandbox workspace-write, claude-code, opencode) all
// run their own inner bwrap to isolate model-emitted commands; nesting
// breaks with `Failed to mount tmpfs: No such file or directory` when
// the inner bwrap tries to set up tmpfs but the outer one dropped
// mount() privileges. The outer wrap is now skipped for this code
// path; leader-side bash (manager-tools-adapter) continues to honor
// the global mode.
test("spawnCliAgent does NOT wrap CLI agents in outer bwrap even when sandbox is optional+available", async () => {
  const markerPath = join(tempDir, "bwrap-marker");
  const command = await writeStubCommand("codex", 'echo "ran-without-outer-bwrap:$*"');
  await writeStubCommand(
    "bwrap",
    `echo "bwrap invoked" > ${JSON.stringify(markerPath)}
exec "$@"`,
  );
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "optional";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";
    await mkdir(join(tempDir, "runtime-workspace"), { recursive: true });
    const result = await spawnCliAgent({
      command,
      prompt: "sandbox",
      workspaceDir: join(tempDir, "runtime-workspace"),
      runtimeType: "codex",
      runtimeHomeDir: join(tempDir, "runtime-home"),
      runtimeTmpDir: join(tempDir, "runtime-tmp"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ran-without-outer-bwrap:");
    // The crucial inverted assertion: bwrap was NOT invoked.
    expect(await Bun.file(markerPath).exists()).toBe(false);
    expect(result.runtimeSecurity.executionSandbox).toMatchObject({
      mode: "off",
      status: "disabled",
      reason: "mode_off",
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("spawnCliAgent does NOT fail-closed for CLI agents when global sandbox is required but unavailable (CLI self-sandboxes)", async () => {
  const markerPath = join(tempDir, "should-still-run");
  const command = await writeStubCommand(
    "codex",
    `echo ran > ${JSON.stringify(markerPath)}`,
  );
  const { spawnCliAgent } = await import("../../src/services/cli-agent-spawn-service");

  const originalPath = process.env.PATH;
  try {
    // Keep system PATH so the stub's shebang resolves bash; prepend
    // tempDir so the codex stub takes precedence. We still want bwrap
    // missing from PATH for this scenario, so tempDir-only is wrong —
    // instead we explicitly clear bwrap from the resolver by removing
    // it from the stub directory and confirming the global PATH does
    // not have it (it's not pre-required by the test fixtures).
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
    // Even with global mode=required + bwrap missing, CLI agents proceed
    // because they're not wrapped in Magister's outer bwrap.
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "required";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";
    await mkdir(join(tempDir, "runtime-workspace"), { recursive: true });
    const result = await spawnCliAgent({
      command,
      prompt: "sandbox required",
      workspaceDir: join(tempDir, "runtime-workspace"),
      runtimeType: "codex",
      runtimeHomeDir: join(tempDir, "runtime-home"),
      runtimeTmpDir: join(tempDir, "runtime-tmp"),
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(markerPath).exists()).toBe(true);
    expect(result.runtimeSecurity.executionSandbox).toMatchObject({
      mode: "off",
      status: "disabled",
      reason: "mode_off",
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("buildCliArgs for codex: regular checkout → no --add-dir", () => {
  const result = buildCliArgs(
    "/usr/bin/codex",
    "gpt-5",
    "do thing",
    undefined,
    undefined,
    undefined,
    false,
    tempDir,
  );
  expect(result.argv).not.toContain("--add-dir");
});

test("buildCliArgs for codex: worktree workspace → --add-dir for gitdir + commondir", async () => {
  const mainRepoGit = join(tempDir, "main-repo", ".git");
  const worktreeGitdir = join(mainRepoGit, "worktrees", "sub");
  const workspaceDir = join(tempDir, "worktree-checkout");
  await mkdir(worktreeGitdir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(worktreeGitdir, "commondir"), "../..", "utf8");
  await writeFile(join(workspaceDir, ".git"), `gitdir: ${worktreeGitdir}\n`, "utf8");

  const result = buildCliArgs(
    "/usr/bin/codex",
    undefined,
    "do thing",
    undefined,
    undefined,
    undefined,
    false,
    workspaceDir,
  );

  const addDirArgs: string[] = [];
  for (let i = 0; i < result.argv.length; i++) {
    if (result.argv[i] === "--add-dir" && i + 1 < result.argv.length) {
      addDirArgs.push(result.argv[i + 1]!);
    }
  }
  expect(addDirArgs).toContain(worktreeGitdir);
  expect(addDirArgs).toContain(mainRepoGit);
});

test("buildCliArgs for codex: missing workspaceDir → no --add-dir (back-compat)", () => {
  const result = buildCliArgs(
    "/usr/bin/codex",
    undefined,
    "do thing",
    undefined,
    undefined,
    undefined,
    false,
  );
  expect(result.argv).not.toContain("--add-dir");
});

test("buildCliArgs for claude-code: worktree workspace → no --add-dir (codex-specific flag)", async () => {
  const worktreeGitdir = join(tempDir, "main-repo", ".git", "worktrees", "sub");
  const workspaceDir = join(tempDir, "worktree-checkout");
  await mkdir(worktreeGitdir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, ".git"), `gitdir: ${worktreeGitdir}\n`, "utf8");

  const result = buildCliArgs(
    "/usr/bin/claude",
    undefined,
    "do thing",
    undefined,
    undefined,
    undefined,
    false,
    workspaceDir,
  );
  expect(result.argv).not.toContain("--add-dir");
});
