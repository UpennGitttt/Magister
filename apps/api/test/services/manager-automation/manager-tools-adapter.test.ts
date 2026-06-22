import { expect, test, describe, mock, beforeEach, afterEach } from "bun:test";
import { createLeaderTools, DEFAULT_LEADER_TOOLS } from "../../../src/services/manager-automation/autonomous-loop/manager-tools-adapter";
import type { LeaderToolUseContext } from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";
import {
  __clearAllApprovalTrustForTests,
  addApprovalTrust,
  clearApprovalRecordsForTests,
  getPendingApprovals,
  resolveApproval,
} from "../../../src/services/command-approval-service";
import { existsSync } from "fs";
import { chmod, mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function createMockToolUseContext(
  overrides: Partial<LeaderToolUseContext> = {}
): LeaderToolUseContext {
  const abortController = new AbortController();
  return {
    taskId: "test-task",
    runId: "test-run",
      requestId: "req-test",
    workspaceDir: "/tmp/test",
    abortController,
    messages: [],
    tools: [],
    setInProgressToolUseIDs: mock(() => {}),
    getInProgressToolUseIDs: () => new Set(),
    recordEvent: mock(async () => {}),
    requestApproval: mock(async () => ({ decision: "approve" as const })),
    ...overrides,
  };
}

describe("createLeaderTools", () => {
  test("returns all default tools", () => {
    const tools = createLeaderTools("/tmp/test");
    const toolNames = tools.map((t) => t.name);
    
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("list_dir");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("web_fetch");
    expect(toolNames).toContain("time_now");
    expect(toolNames).toContain("send_media");
    expect(toolNames).toContain("spawn_teammate");
    expect(toolNames).toContain("request_human_input");
    expect(toolNames).toContain("update_plan");
  });

  test("DEFAULT_LEADER_TOOLS contains all expected tools", () => {
    expect(DEFAULT_LEADER_TOOLS).toContain("bash");
    expect(DEFAULT_LEADER_TOOLS).toContain("read_file");
    expect(DEFAULT_LEADER_TOOLS).toContain("write_file");
    expect(DEFAULT_LEADER_TOOLS).toContain("edit_file");
    expect(DEFAULT_LEADER_TOOLS).toContain("list_dir");
    expect(DEFAULT_LEADER_TOOLS).toContain("grep");
    expect(DEFAULT_LEADER_TOOLS).toContain("web_search");
    expect(DEFAULT_LEADER_TOOLS).toContain("web_fetch");
    expect(DEFAULT_LEADER_TOOLS).toContain("time_now");
    expect(DEFAULT_LEADER_TOOLS).toContain("send_media");
    expect(DEFAULT_LEADER_TOOLS).toContain("spawn_teammate");
    expect(DEFAULT_LEADER_TOOLS).toContain("request_human_input");
    // Regression guard for the kimi review finding: agent-profile-service
    // validates allowedTools/disallowedTools against this list, so a
    // missing entry would 400 any profile referencing it.
    expect(DEFAULT_LEADER_TOOLS).toContain("update_plan");
  });

  test("tools have correct aliases", () => {
    const tools = createLeaderTools("/tmp/test");
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    expect(toolMap.get("spawn_teammate")).toBeDefined();
    expect(toolMap.get("request_human_input")?.aliases).toContain("ask_human");
    expect(toolMap.get("request_human_input")?.aliases).toContain("human_input");
    expect(toolMap.get("write_file")?.aliases).toContain("write");
    expect(toolMap.get("write_file")?.aliases).toContain("create_file");
    expect(toolMap.get("edit_file")?.aliases).toContain("edit");
    expect(toolMap.get("edit_file")?.aliases).toContain("replace");
  });
});

async function waitForPendingApprovalForTask(taskId: string) {
  for (let i = 0; i < 40; i++) {
    const approval = (await getPendingApprovals()).find((item) => item.taskId === taskId);
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pending approval did not appear for ${taskId}`);
}

describe("sensitive internal bash reads", () => {
  let tempDir: string;
  let previousDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "leader-sensitive-read-"));
    previousDbPath = process.env.MAGISTER_DB_PATH;
    process.env.MAGISTER_DB_PATH = join(tempDir, "control.sqlite");
    __clearAllApprovalTrustForTests();
    await clearApprovalRecordsForTests();
  });

  afterEach(async () => {
    await clearApprovalRecordsForTests();
    __clearAllApprovalTrustForTests();
    if (previousDbPath === undefined) {
      delete process.env.MAGISTER_DB_PATH;
    } else {
      process.env.MAGISTER_DB_PATH = previousDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prompts then allows an approved one-time .env read", async () => {
    await writeFile(join(tempDir, ".env"), "SECRET_VALUE=ok\n", "utf8");
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const taskId = "task_sensitive_read";
    const call = tool!.call(
      { command: "cat .env" },
      createMockToolUseContext({ taskId, workspaceDir: tempDir }),
    );

    const approval = await waitForPendingApprovalForTask(taskId);
    expect(approval.summary).toContain("Sensitive internal path read");
    expect(JSON.stringify(approval.toolArgs)).toContain(".env");
    const approvalArgs = approval.toolArgs as {
      escalation?: { request_kind?: string; proposed_prefix_rule?: string[] };
    };
    expect(approvalArgs.escalation?.request_kind).toBe("sensitive_read");
    expect(approvalArgs.escalation?.proposed_prefix_rule).toBeUndefined();

    await resolveApproval(approval.id, "approved");
    const result = await call;
    const data = result.data as { exitCode: number; stdout: string; stderr: string };

    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("SECRET_VALUE=ok");
  });

  test("does not let broad task trust bypass a sensitive .env read prompt", async () => {
    await writeFile(join(tempDir, ".env"), "SECRET_VALUE=still-needs-approval\n", "utf8");
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const taskId = "task_sensitive_read_ignores_trust";
    addApprovalTrust(taskId, "bash", "*", null);

    const call = tool!.call(
      { command: "cat .env" },
      createMockToolUseContext({ taskId, workspaceDir: tempDir }),
    );

    const approval = await waitForPendingApprovalForTask(taskId);
    expect(approval.summary).toContain("Sensitive internal path read");

    await resolveApproval(approval.id, "approved");
    const result = await call;
    const data = result.data as { exitCode: number; stdout: string; stderr: string };

    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("SECRET_VALUE=still-needs-approval");
  });
});

describe("send_media tool", () => {
  test("copies local media and emits metadata-only leader.media_sent event", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "send-media-tool-test-"));
    const prevCwd = process.cwd();
    const prevDbPath = process.env.MAGISTER_DB_PATH;
    try {
      process.chdir(tempRoot);
      process.env.MAGISTER_DB_PATH = join(tempRoot, "control.sqlite");
      const workspaceDir = join(tempRoot, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(
        join(workspaceDir, "screenshot.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAASUVORK5CYII=",
          "base64",
        ),
      );

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const tools = createLeaderTools(workspaceDir);
      const tool = tools.find((t) => t.name === "send_media");
      expect(tool).toBeDefined();
      expect(tool!.isReadOnly({})).toBe(false);
      expect(tool!.isPlanSafe?.({})).toBe(false);

      const result = await tool!.call(
        { path: "screenshot.png", caption: "Current screen" },
        createMockToolUseContext({
          taskId: "task_media",
          runId: "rt_leader",
          requestId: "req_media",
          workspaceDir,
          currentToolUseId: "tu_media",
          recordEvent: async (event) => {
            events.push(event);
          },
        }),
      );

      expect(String(result.data)).toContain("Sent image");
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("leader.media_sent");
      expect(events[0]!.data).toMatchObject({
        kind: "image",
        mimeType: "image/png",
        filename: "screenshot.png",
        caption: "Current screen",
      });
      expect(JSON.stringify(events[0]!.data)).not.toContain("storagePath");
      expect(JSON.stringify(events[0]!.data)).not.toContain("iVBOR");
    } finally {
      process.chdir(prevCwd);
      if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
      else process.env.MAGISTER_DB_PATH = prevDbPath;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("spawn_teammate tool", () => {
  test("exists with correct flags", () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "spawn_teammate");
    expect(tool).toBeDefined();
    expect(tool!.isConcurrencySafe({})).toBe(false);
    expect(tool!.isReadOnly({})).toBe(false);
  });
});

describe("request_human_input tool", () => {
  test("returns success when requestApproval is available", async () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "request_human_input");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({
      requestApproval: async () => ({
        decision: "approve",
        feedback: "User approved the request",
      }),
    });

    const result = await tool!.call(
      { question: "Should I proceed?" },
      context
    );

    expect(result.data).toMatchObject({
      success: true,
      response: "User approved the request",
      decision: "approve",
    });
  });

  test("returns failure when requestApproval is not available", async () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "request_human_input");

    const contextWithoutApproval = {
      taskId: "test-task",
      runId: "test-run",
      requestId: "req-test",
      workspaceDir: "/tmp/test",
      abortController: new AbortController(),
      messages: [],
      tools: [],
      setInProgressToolUseIDs: mock(() => {}),
      getInProgressToolUseIDs: () => new Set(),
      recordEvent: mock(async () => {}),
    };

    const result = await tool!.call(
      { question: "Should I proceed?" },
      contextWithoutApproval as LeaderToolUseContext
    );

    const data = result.data as { success: boolean; message: string; question: string };
    expect(data).toMatchObject({
      success: false,
      message: "Human input request requires approval mechanism",
      question: "Should I proceed?",
    });
  });

  test("supports context parameter", async () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "request_human_input");

    const contextWithoutApproval = {
      taskId: "test-task",
      runId: "test-run",
      requestId: "req-test",
      workspaceDir: "/tmp/test",
      abortController: new AbortController(),
      messages: [],
      tools: [],
      setInProgressToolUseIDs: mock(() => {}),
      getInProgressToolUseIDs: () => new Set(),
      recordEvent: mock(async () => {}),
    };

    const result = await tool!.call(
      { question: "Continue?", context: "Additional context here" },
      contextWithoutApproval as LeaderToolUseContext
    );

    const data = result.data as { success: boolean; context: string };
    expect(data.context).toBe("Additional context here");
  });

  test("is NOT concurrency safe (sequencing matters — humans can't sensibly answer two prompts at once)", async () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "request_human_input");
    expect(tool!.isConcurrencySafe({})).toBe(false);
  });

  test("is read only", async () => {
    const tools = createLeaderTools("/tmp/test");
    const tool = tools.find((t) => t.name === "request_human_input");
    expect(tool!.isReadOnly({})).toBe(true);
  });
});

describe("leader bash execution sandbox", () => {
  let tempDir: string;
  let originalSandboxMode: string | undefined;
  let originalSandboxProvider: string | undefined;

  async function createFakeBwrap(input: {
    binDir: string;
    markerPath: string;
  }): Promise<string> {
    const bwrapPath = join(input.binDir, "bwrap");
    await mkdir(input.binDir, { recursive: true });
    await writeFile(
      bwrapPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(input.markerPath)}`,
        "while [ \"$1\" != \"--\" ]; do shift; done",
        "shift",
        "exec \"$@\"",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(bwrapPath, 0o755);
    return bwrapPath;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "leader-bash-sandbox-"));
    originalSandboxMode = process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
    originalSandboxProvider = process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER;
  });

  afterEach(async () => {
    if (originalSandboxMode === undefined) {
      delete process.env.MAGISTER_EXECUTION_SANDBOX_MODE;
    } else {
      process.env.MAGISTER_EXECUTION_SANDBOX_MODE = originalSandboxMode;
    }
    if (originalSandboxProvider === undefined) {
      delete process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER;
    } else {
      process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = originalSandboxProvider;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("keeps leader bash unwrapped when execution sandbox mode is off", async () => {
    const baseDir = join(tempDir, "repo");
    const runtimeDir = join(baseDir, ".worktrees", "leader-test");
    await mkdir(runtimeDir, { recursive: true });
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "off";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

    let resolverCalls = 0;
    const tools = createLeaderTools(runtimeDir, undefined, undefined, {
      bashSandbox: {
        baseWorkspaceDir: baseDir,
        commandResolver: async () => {
          resolverCalls += 1;
          return null;
        },
      },
    });
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({ workspaceDir: runtimeDir });
    const result = await tool!.call(
      { command: 'printf "off ok" > off.txt' },
      context,
    );

    const data = result.data as {
      exitCode: number;
      executionSandbox?: { status: string };
    };
    expect(data.exitCode).toBe(0);
    expect(data.executionSandbox).toBeUndefined();
    expect(resolverCalls).toBe(0);
    expect(await readFile(join(runtimeDir, "off.txt"), "utf8")).toBe("off ok");
  });

  test("wraps leader bash with bubblewrap when sandbox is optional and available", async () => {
    const baseDir = join(tempDir, "repo");
    const runtimeDir = join(baseDir, ".worktrees", "leader-test");
    const binDir = join(tempDir, "bin");
    const markerPath = join(tempDir, "bwrap-argv.txt");
    await mkdir(runtimeDir, { recursive: true });
    const bwrapPath = await createFakeBwrap({ binDir, markerPath });
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "optional";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

    const tools = createLeaderTools(runtimeDir, undefined, undefined, {
      bashSandbox: {
        baseWorkspaceDir: baseDir,
        commandResolver: async (command) => command === "bwrap" ? bwrapPath : null,
      },
    });
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({ workspaceDir: runtimeDir });
    const result = await tool!.call(
      { command: 'printf "wrapped ok" > wrapped.txt' },
      context,
    );

    const data = result.data as {
      exitCode: number;
      executionSandbox?: { status: string; provider: string; reason: string };
    };
    expect(data.exitCode).toBe(0);
    expect(data.executionSandbox).toMatchObject({
      status: "active",
      provider: "bubblewrap",
      reason: "wrapped",
    });
    expect(await readFile(join(runtimeDir, "wrapped.txt"), "utf8")).toBe("wrapped ok");
    const argv = await readFile(markerPath, "utf8");
    expect(argv).toContain("--ro-bind\n" + baseDir + "\n" + baseDir);
    expect(argv).toContain("--bind\n" + runtimeDir + "\n" + runtimeDir);
    expect(argv).toContain("--\n/bin/bash\n-c\n");
    const argvLines = argv.trimEnd().split("\n");
    const isolatedDirs = argvLines.filter((line) =>
      line.includes("magister-leader-bash-home-") || line.includes("magister-leader-bash-tmp-"),
    );
    expect(isolatedDirs.length).toBeGreaterThan(0);
    for (const dir of isolatedDirs) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  test("optional leader bash sandbox runs unwrapped with unavailable metadata when bubblewrap is unavailable", async () => {
    const baseDir = join(tempDir, "repo");
    const runtimeDir = join(baseDir, ".worktrees", "leader-test");
    await mkdir(runtimeDir, { recursive: true });
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "optional";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

    const tools = createLeaderTools(runtimeDir, undefined, undefined, {
      bashSandbox: {
        baseWorkspaceDir: baseDir,
        commandResolver: async () => null,
      },
    });
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({ workspaceDir: runtimeDir });
    const result = await tool!.call(
      { command: 'printf "optional fallback ok" > fallback.txt' },
      context,
    );

    const data = result.data as {
      exitCode: number;
      executionSandbox?: { mode: string; status: string; reason: string };
    };
    expect(data.exitCode).toBe(0);
    expect(data.executionSandbox).toMatchObject({
      mode: "optional",
      status: "unavailable",
      reason: "provider_not_found",
    });
    expect(await readFile(join(runtimeDir, "fallback.txt"), "utf8")).toBe("optional fallback ok");
  });

  test("wrapped leader bash honors abort signal", async () => {
    const baseDir = join(tempDir, "repo");
    const runtimeDir = join(baseDir, ".worktrees", "leader-test");
    const binDir = join(tempDir, "bin-abort");
    const markerPath = join(tempDir, "bwrap-abort-argv.txt");
    await mkdir(runtimeDir, { recursive: true });
    const bwrapPath = await createFakeBwrap({ binDir, markerPath });
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "optional";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

    const tools = createLeaderTools(runtimeDir, undefined, undefined, {
      bashSandbox: {
        baseWorkspaceDir: baseDir,
        commandResolver: async (command) => command === "bwrap" ? bwrapPath : null,
      },
    });
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const abortController = new AbortController();
    const context = createMockToolUseContext({
      workspaceDir: runtimeDir,
      abortController,
    });
    const call = tool!.call(
      { command: 'sleep 10; printf "late" > aborted.txt' },
      context,
    );
    setTimeout(() => abortController.abort(), 50);
    const result = await call;

    const data = result.data as {
      exitCode: number;
      stderr: string;
      executionSandbox?: { status: string; reason: string };
    };
    expect(data.exitCode).toBe(130);
    expect(data.stderr).toContain("[aborted by user]");
    expect(data.executionSandbox).toMatchObject({
      status: "active",
      reason: "wrapped",
    });
    await expect(Bun.file(join(runtimeDir, "aborted.txt")).exists()).resolves.toBe(false);
  });

  test("required leader bash sandbox fails closed before running command when bubblewrap is unavailable", async () => {
    const baseDir = join(tempDir, "repo");
    const runtimeDir = join(baseDir, ".worktrees", "leader-test");
    await mkdir(runtimeDir, { recursive: true });
    process.env.MAGISTER_EXECUTION_SANDBOX_MODE = "required";
    process.env.MAGISTER_EXECUTION_SANDBOX_PROVIDER = "bubblewrap";

    const tools = createLeaderTools(runtimeDir, undefined, undefined, {
      bashSandbox: {
        baseWorkspaceDir: baseDir,
        commandResolver: async () => null,
      },
    });
    const tool = tools.find((item) => item.name === "bash");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({ workspaceDir: runtimeDir });
    const result = await tool!.call(
      { command: 'printf "should not run" > should-not-exist.txt' },
      context,
    );

    const data = result.data as {
      exitCode: number;
      stderr: string;
      executionSandbox?: { status: string; reason: string };
    };
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toContain("Execution sandbox required but not active");
    expect(data.executionSandbox).toMatchObject({
      status: "unavailable",
      reason: "provider_not_found",
    });
    await expect(Bun.file(join(runtimeDir, "should-not-exist.txt")).exists()).resolves.toBe(false);
  });
});

describe("write_file tool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "write-file-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes file successfully", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "write_file");
    expect(tool).toBeDefined();

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "test.txt", content: "Hello, World!" },
      context
    );

    const data = result.data as { success: boolean; path: string; bytesWritten: number };
    expect(data).toMatchObject({
      success: true,
      path: "test.txt",
    });
    expect(data.bytesWritten).toBe(13);

    const content = await readFile(join(tempDir, "test.txt"), "utf-8");
    expect(content).toBe("Hello, World!");
  });

  test("creates parent directories when createDirs is true", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "write_file");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "subdir/nested/file.txt", content: "Nested content", createDirs: true },
      context
    );

    expect(result.data).toMatchObject({
      success: true,
    });

    const content = await readFile(join(tempDir, "subdir/nested/file.txt"), "utf-8");
    expect(content).toBe("Nested content");
  });

  test("fails when parent directory does not exist and createDirs is false", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "write_file");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "nonexistent/file.txt", content: "content" },
      context
    );

    const data = result.data as { success: boolean; error?: string };
    expect(data).toMatchObject({
      success: false,
    });
    expect(data.error).toBeDefined();
  });

  test("is not concurrency safe", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "write_file");
    expect(tool!.isConcurrencySafe({})).toBe(false);
  });

  test("is not read only", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "write_file");
    expect(tool!.isReadOnly({})).toBe(false);
  });
});

describe("edit_file tool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "edit-file-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("replaces content in file", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");
    expect(tool).toBeDefined();

    await writeFile(join(tempDir, "test.txt"), "Hello, World!", "utf-8");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "test.txt", oldString: "World", newString: "Universe" },
      context
    );

    expect(result.data).toMatchObject({
      success: true,
      path: "test.txt",
      replacementsMade: 1,
    });

    const content = await readFile(join(tempDir, "test.txt"), "utf-8");
    expect(content).toBe("Hello, Universe!");
  });

  test("fails when oldString not found", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");

    await writeFile(join(tempDir, "test.txt"), "Hello, World!", "utf-8");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "test.txt", oldString: "NotFound", newString: "Replaced" },
      context
    );

    expect(result.data).toMatchObject({
      success: false,
      error: "oldString not found in file",
    });
  });

  test("fails when multiple occurrences without replaceAll", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");

    await writeFile(join(tempDir, "test.txt"), "foo bar foo", "utf-8");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "test.txt", oldString: "foo", newString: "baz" },
      context
    );

    const data = result.data as { success: boolean; error: string };
    expect(data).toMatchObject({
      success: false,
    });
    expect(data.error).toContain("Found 2 occurrences");
  });

  test("replaces all occurrences with replaceAll", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");

    await writeFile(join(tempDir, "test.txt"), "foo bar foo baz foo", "utf-8");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "test.txt", oldString: "foo", newString: "qux", replaceAll: true },
      context
    );

    expect(result.data).toMatchObject({
      success: true,
      replacementsMade: 3,
    });

    const content = await readFile(join(tempDir, "test.txt"), "utf-8");
    expect(content).toBe("qux bar qux baz qux");
  });

  test("fails when file does not exist", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");

    const context = createMockToolUseContext({ workspaceDir: tempDir });
    const result = await tool!.call(
      { path: "nonexistent.txt", oldString: "old", newString: "new" },
      context
    );

    const data = result.data as { success: boolean; error?: string };
    expect(data).toMatchObject({
      success: false,
    });
    expect(data.error).toBeDefined();
  });

  test("is not concurrency safe", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");
    expect(tool!.isConcurrencySafe({})).toBe(false);
  });

  test("is not read only", async () => {
    const tools = createLeaderTools(tempDir);
    const tool = tools.find((t) => t.name === "edit_file");
    expect(tool!.isReadOnly({})).toBe(false);
  });
});
