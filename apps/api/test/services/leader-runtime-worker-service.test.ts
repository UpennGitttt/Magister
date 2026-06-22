import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { LeaderTool } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { resolveLeaderWorkerInputPath } from "../../src/workers/leader-runtime-worker";

const tempDirs: string[] = [];
let previousDbPath: string | undefined;
let buildLeaderWorkerEnv: typeof import("../../src/services/leader-runtime-worker-service").buildLeaderWorkerEnv;
let resolveLeaderWorkerMode: typeof import("../../src/services/leader-runtime-worker-service").resolveLeaderWorkerMode;
let runLeaderRuntimeInWorker: typeof import("../../src/services/leader-runtime-worker-service").runLeaderRuntimeInWorker;

beforeEach(async () => {
  mock.restore();
  const service = await import(
    `../../src/services/leader-runtime-worker-service.ts?leaderWorkerReal=${Date.now()}-${Math.random()}`
  ) as typeof import("../../src/services/leader-runtime-worker-service");
  ({
    buildLeaderWorkerEnv,
    resolveLeaderWorkerMode,
    runLeaderRuntimeInWorker,
  } = service);
  previousDbPath = process.env.MAGISTER_DB_PATH;
  const dbDir = await makeTempDir("leader-worker-db-");
  process.env.MAGISTER_DB_PATH = join(dbDir, "control.sqlite");
});

afterEach(async () => {
  if (previousDbPath === undefined) {
    delete process.env.MAGISTER_DB_PATH;
  } else {
    process.env.MAGISTER_DB_PATH = previousDbPath;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeWorkerScript(source: string): Promise<string> {
  const dir = await makeTempDir("leader-worker-test-");
  const script = join(dir, "worker.js");
  await writeFile(script, source, "utf8");
  return script;
}

async function writeExecutableScript(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessToExit(pid: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process exited between the final liveness check and cleanup.
    }
  }

  throw new Error(`expected worker process ${pid} to exit`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function canRunBubblewrap(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: [
        "bwrap",
        "--die-with-parent",
        "--dev", "/dev",
        "--proc", "/proc",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
        "--",
        "/bin/sh",
        "-c",
        "true",
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    return await proc.exited === 0;
  } catch {
    return false;
  }
}

const testModelRuntime = { modelName: "test-model" };

test("resolveLeaderWorkerMode defaults off and parses optional/required", () => {
  expect(resolveLeaderWorkerMode({})).toBe("off");
  expect(resolveLeaderWorkerMode({ MAGISTER_LEADER_WORKER_MODE: "optional" })).toBe("optional");
  expect(resolveLeaderWorkerMode({ MAGISTER_LEADER_WORKER_MODE: "required" })).toBe("required");
  expect(resolveLeaderWorkerMode({ MAGISTER_LEADER_WORKER_MODE: "bogus" })).toBe("off");
});

test("buildLeaderWorkerEnv keeps only runtime essentials and strips provider secrets", async () => {
  const homeDir = await makeTempDir("leader-worker-home-");
  const tmpDir = await makeTempDir("leader-worker-tmp-");

  const env = buildLeaderWorkerEnv({
    homeDir,
    tmpDir,
    baseEnv: {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      MAGISTER_DB_PATH: "/tmp/magister.sqlite",
      MAGISTER_EXECUTOR_CONFIG_PATH: "/tmp/executors.json",
      MAGISTER_SECRET_STORE_PATH: "/tmp/secrets.json",
      MAGISTER_AGENTS_HOME: "/home/user/.agents",
      MAGISTER_CODEX_HOME_SEED: "/home/user/.codex",
      MAGISTER_LEADER_AUTOCOMPACT_RATIO: "0.55",
      ANTHROPIC_API_KEY: "secret",
      FEISHU_APP_SECRET: "secret",
      DASHSCOPE_API_KEY: "secret",
      CODEX_HOME: "/should/not/be/directly-forwarded",
    },
  });

  expect(env.PATH).toBe("/usr/bin");
  expect(env.LANG).toBe("C.UTF-8");
  expect(env.MAGISTER_DB_PATH).toBeUndefined();
  expect(env.MAGISTER_EXECUTOR_CONFIG_PATH).toBeUndefined();
  expect(env.MAGISTER_SECRET_STORE_PATH).toBeUndefined();
  expect(env.MAGISTER_AGENTS_HOME).toBe("/home/user/.agents");
  expect(env.MAGISTER_CODEX_HOME_SEED).toBe("/home/user/.codex");
  expect(env.MAGISTER_LEADER_AUTOCOMPACT_RATIO).toBe("0.55");
  expect(env.HOME).toBe(homeDir);
  expect(env.TMPDIR).toBe(tmpDir);
  expect(env.TMP).toBe(tmpDir);
  expect(env.TEMP).toBe(tmpDir);
  expect(env.MAGISTER_LEADER_WORKER_CHILD).toBe("1");
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.FEISHU_APP_SECRET).toBeUndefined();
  expect(env.DASHSCOPE_API_KEY).toBeUndefined();
  expect(env.CODEX_HOME).toBeUndefined();
});

test("resolveLeaderWorkerInputPath reads the final argv entry", () => {
  expect(resolveLeaderWorkerInputPath(["bun", "worker.ts"])).toBeUndefined();
  expect(resolveLeaderWorkerInputPath(["bun", "worker.ts", "/tmp/input.json"])).toBe("/tmp/input.json");
  expect(resolveLeaderWorkerInputPath(["bun", "worker.ts", "--flag", "value", "/tmp/input.json"])).toBe("/tmp/input.json");
});

test("runLeaderRuntimeInWorker returns worker result", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify({
      type: "result",
      result: {
        reason: "completed",
        turnCount: 1,
        messages: [{ type: "assistant", content: [{ type: "text", text: "worker done" }] }]
      }
    }) + "\\n");
  `);
  const events: unknown[] = [];

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker",
      runId: "run-worker",
      requestId: "req-worker",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    observeEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.reason).toBe("completed");
  expect(result.turnCount).toBe(1);
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
  });
  expect(events).toHaveLength(0);
});

test("runLeaderRuntimeInWorker marks worker process failed when it exits before a result", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    process.stderr.write("worker crashed before result");
    process.exit(42);
  `);
  const processStates: unknown[] = [];

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-close-failed",
      runId: "run-worker-close-failed",
      requestId: "req-worker-close-failed",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    observeWorkerProcessState: (state) => {
      processStates.push(state);
    },
  });

  expect(result.reason).toBe("model_error");
  expect(processStates).toEqual([
    expect.objectContaining({ status: "active" }),
    expect.objectContaining({
      status: "failed",
      failureReason: "worker crashed before result",
    }),
  ]);
});

test("runLeaderRuntimeInWorker fails closed when worker sandbox is required but unavailable", async () => {
  const baseWorkspaceDir = await makeTempDir("leader-worker-base-");
  const workspaceDir = join(baseWorkspaceDir, ".worktrees", "rt");
  await mkdir(workspaceDir, { recursive: true });
  const markerPath = join(workspaceDir, "worker-ran.txt");
  const script = join(workspaceDir, "worker.js");
  const sandboxStates: unknown[] = [];
  const processStates: unknown[] = [];
  await writeFile(script, `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(markerPath)}, "ran");
    process.stdout.write(JSON.stringify({
      type: "result",
      result: { reason: "completed", turnCount: 1, messages: [] }
    }) + "\\n");
  `, "utf8");

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-sandbox-required",
      runId: "run-worker-sandbox-required",
      requestId: "req-worker-sandbox-required",
      workspaceDir,
      baseWorkspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    env: {
      PATH: "",
      MAGISTER_EXECUTION_SANDBOX_MODE: "required",
      MAGISTER_EXECUTION_SANDBOX_PROVIDER: "bubblewrap",
    },
    observeWorkerSandboxState: (state) => {
      sandboxStates.push(state);
    },
    observeWorkerProcessState: (state) => {
      processStates.push(state);
    },
  });

  expect(result.reason).toBe("model_error");
  const finalMessage = result.messages.at(-1);
  expect(finalMessage).toMatchObject({ type: "assistant" });
  expect(finalMessage?.type === "assistant" ? finalMessage.content : null).toEqual([
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Execution sandbox required but not active"),
    }),
  ]);
  expect(await fileExists(markerPath)).toBe(false);
  expect(sandboxStates).toEqual([
    expect.objectContaining({
      status: "failed",
      provider: "bubblewrap",
      network: "host",
      failureReason: expect.stringContaining("provider_not_found"),
    }),
  ]);
  expect(processStates).toEqual([
    expect.objectContaining({
      status: "failed",
      failureReason: expect.stringContaining("provider_not_found"),
    }),
  ]);
});

test("runLeaderRuntimeInWorker reports optional sandbox fallback when bubblewrap is unavailable", async () => {
  const baseWorkspaceDir = await makeTempDir("leader-worker-base-");
  const workspaceDir = join(baseWorkspaceDir, ".worktrees", "rt");
  await mkdir(workspaceDir, { recursive: true });
  const sandboxStates: unknown[] = [];
  const processStates: unknown[] = [];
  const script = join(workspaceDir, "worker.js");
  await writeFile(script, `
    process.stdout.write(JSON.stringify({
      type: "result",
      result: { reason: "completed", turnCount: 1, messages: [] }
    }) + "\\n");
  `, "utf8");

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-sandbox-optional-fallback",
      runId: "run-worker-sandbox-optional-fallback",
      requestId: "req-worker-sandbox-optional-fallback",
      workspaceDir,
      baseWorkspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    env: {
      PATH: "",
      MAGISTER_EXECUTION_SANDBOX_MODE: "optional",
      MAGISTER_EXECUTION_SANDBOX_PROVIDER: "bubblewrap",
    },
    observeWorkerSandboxState: (state) => {
      sandboxStates.push(state);
    },
    observeWorkerProcessState: (state) => {
      processStates.push(state);
    },
  });

  expect(result.reason).toBe("completed");
  expect(sandboxStates).toEqual([
    expect.objectContaining({
      status: "fallback",
      provider: "bubblewrap",
      network: "host",
      failureReason: "provider_not_found",
    }),
  ]);
  expect(processStates).toEqual([
    expect.objectContaining({
      status: "active",
    }),
  ]);
});

test("runLeaderRuntimeInWorker wraps the worker process with bubblewrap when sandboxing is configured", async () => {
  const baseWorkspaceDir = await makeTempDir("leader-worker-base-");
  const workspaceDir = join(baseWorkspaceDir, ".worktrees", "rt");
  await mkdir(workspaceDir, { recursive: true });
  const fakeBinDir = await makeTempDir("leader-worker-fake-bin-");
  const capturePath = join(fakeBinDir, "bwrap-argv.json");
  const fakeBwrapPath = join(fakeBinDir, "bwrap");
  const sandboxStates: unknown[] = [];
  const processStates: unknown[] = [];
  await writeExecutableScript(fakeBwrapPath, `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));
const sep = process.argv.indexOf("--");
if (sep < 0) process.exit(64);
const command = process.argv[sep + 1];
const args = process.argv.slice(sep + 2);
const child = cp.spawnSync(command, args, { stdio: "inherit", env: process.env, cwd: process.cwd() });
process.exit(child.status ?? 1);
`);
  const script = join(workspaceDir, "worker.js");
  await writeFile(script, `
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify({
      type: "result",
      result: {
        reason: "completed",
        turnCount: 1,
        messages: [{ type: "assistant", content: [{ type: "text", text: "wrapped" }] }]
      }
    }) + "\\n");
  `, "utf8");

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-sandbox-wrapped",
      runId: "run-worker-sandbox-wrapped",
      requestId: "req-worker-sandbox-wrapped",
      workspaceDir,
      baseWorkspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      MAGISTER_EXECUTION_SANDBOX_MODE: "required",
      MAGISTER_EXECUTION_SANDBOX_PROVIDER: "bubblewrap",
      MAGISTER_EXECUTION_SANDBOX_NETWORK: "disabled",
    },
    observeWorkerSandboxState: (state) => {
      sandboxStates.push(state);
    },
    observeWorkerProcessState: (state) => {
      processStates.push(state);
    },
  });

  expect(result.reason).toBe("completed");
  expect(sandboxStates).toEqual([
    expect.objectContaining({
      status: "active",
      provider: "bubblewrap",
      network: "disabled",
    }),
  ]);
  expect(processStates).toEqual([
    expect.objectContaining({
      status: "active",
    }),
  ]);
  const argv = JSON.parse(await readFile(capturePath, "utf8")) as string[];
  expect(argv).toContain("--unshare-net");
  expect(argv).toContain("--ro-bind");
  expect(argv).toContain(baseWorkspaceDir);
  expect(argv).toContain("--bind");
  expect(argv).toContain(workspaceDir);
  expect(argv.at(-2)).toBe(script);
});

test("runLeaderRuntimeInWorker bubblewrap smoke keeps main workspace read-only and runtime writable", async () => {
  if (!(await canRunBubblewrap())) return;

  const baseWorkspaceDir = await makeTempDir("leader-worker-base-");
  const workspaceDir = join(baseWorkspaceDir, ".worktrees", "rt");
  await mkdir(workspaceDir, { recursive: true });
  const blockedMainPath = join(baseWorkspaceDir, "blocked-main-write.txt");
  const runtimeWritePath = join(workspaceDir, "runtime-write.txt");
  const script = join(workspaceDir, "worker.js");
  const sandboxStates: unknown[] = [];
  const processStates: unknown[] = [];
  await writeFile(script, `
    const fs = require("node:fs");
    const path = require("node:path");
    const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    let mainWriteDenied = false;
    let runtimeWriteSucceeded = false;
    let homeWriteSucceeded = false;
    let tmpWriteSucceeded = false;
    try {
      fs.writeFileSync(path.join(input.baseWorkspaceDir, "blocked-main-write.txt"), "bad");
    } catch {
      mainWriteDenied = true;
    }
    try {
      fs.writeFileSync(path.join(input.workspaceDir, "runtime-write.txt"), "ok");
      runtimeWriteSucceeded = true;
    } catch {
      runtimeWriteSucceeded = false;
    }
    try {
      fs.writeFileSync(path.join(process.env.HOME, "home-write.txt"), "ok");
      homeWriteSucceeded = true;
    } catch {
      homeWriteSucceeded = false;
    }
    try {
      fs.writeFileSync(path.join(process.env.TMPDIR, "tmp-write.txt"), "ok");
      tmpWriteSucceeded = true;
    } catch {
      tmpWriteSucceeded = false;
    }
    process.stdout.write(JSON.stringify({
      type: "result",
      result: {
        reason: "completed",
        turnCount: 1,
        messages: [{
          type: "assistant",
          content: [{
            type: "text",
            text: JSON.stringify({
              mainWriteDenied,
              runtimeWriteSucceeded,
              homeWriteSucceeded,
              tmpWriteSucceeded
            })
          }]
        }]
      }
    }) + "\\n");
  `, "utf8");

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-sandbox-real",
      runId: "run-worker-sandbox-real",
      requestId: "req-worker-sandbox-real",
      workspaceDir,
      baseWorkspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    env: {
      ...process.env,
      MAGISTER_EXECUTION_SANDBOX_MODE: "required",
      MAGISTER_EXECUTION_SANDBOX_PROVIDER: "bubblewrap",
      MAGISTER_EXECUTION_SANDBOX_NETWORK: "host",
    },
    observeWorkerSandboxState: (state) => {
      sandboxStates.push(state);
    },
    observeWorkerProcessState: (state) => {
      processStates.push(state);
    },
  });

  expect(result.reason).toBe("completed");
  expect(result.messages.at(-1)).toMatchObject({
    type: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({
        mainWriteDenied: true,
        runtimeWriteSucceeded: true,
        homeWriteSucceeded: true,
        tmpWriteSucceeded: true,
      }),
    }],
  });
  expect(await fileExists(blockedMainPath)).toBe(false);
  expect(await fileExists(runtimeWritePath)).toBe(true);
  expect(sandboxStates).toEqual([
    expect.objectContaining({
      status: "active",
      provider: "bubblewrap",
      network: "host",
    }),
  ]);
  expect(processStates).toEqual([
    expect.objectContaining({
      status: "active",
    }),
  ]);
});

test("runLeaderRuntimeInWorker runs actual worker model calls through parent RPC", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const modelCalls: unknown[] = [];

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-model-rpc",
      runId: "run-worker-model-rpc",
      requestId: "req-worker-model-rpc",
      workspaceDir,
      systemPrompt: "system from parent",
      initialPrompt: "hello model rpc",
      modelRuntime: {
        modelName: "parent-test-model",
        contextWindow: 8192,
        maxOutputTokens: 512,
      },
    },
    apiConfig: {
      provider: {
        id: "provider",
        label: "Provider",
        vendor: "test",
        transport: "api",
        apiDialect: "openai_chat_completions",
        auth: { kind: "api_key", secretRef: "parent-only-secret" },
      },
      model: {
        id: "model",
        label: "Model",
        vendor: "test",
        modelName: "parent-test-model",
        providerRefs: { api: "provider" },
      },
      binding: {
        adapterId: "test-api",
        executionMode: "api",
        modelRef: "model",
        providerRef: "provider",
      },
    },
    callModel: async function* (params) {
      modelCalls.push(params);
      yield {
        type: "message_complete",
        content: [{ type: "text", text: "parent model rpc ok" }],
        model: "parent-test-model",
        provider: "provider",
        usage: { inputTokens: 7, outputTokens: 3 },
      };
    },
  });

  expect(result.reason).toBe("completed");
  expect(result.turnCount).toBe(1);
  expect(result.messages.at(-1)).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: "parent model rpc ok" }],
  });
  expect(modelCalls).toHaveLength(1);
  expect(modelCalls[0]).toMatchObject({
    systemPrompt: "system from parent",
    model: "parent-test-model",
  });
});

test("runLeaderRuntimeInWorker runs actual worker tool calls through parent RPC", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const parentToolCalls: Array<{ message: string; toolUseId?: string }> = [];
  const observedEvents: unknown[] = [];
  let callCount = 0;

  const remoteEchoTool: LeaderTool = {
    name: "remote_echo",
    description: "Echo a short message through the parent tool runtime.",
    inputSchema: z.object({ message: z.string() }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isPlanSafe: () => true,
    call: async (args, context) => {
      const message = String((args as { message: string }).message);
      parentToolCalls.push({
        message,
        ...(context.currentToolUseId ? { toolUseId: context.currentToolUseId } : {}),
      });
      await context.recordEvent({
        type: "test.parent_tool_event",
        timestamp: "2026-05-14T00:00:00.000Z",
        data: { toolUseId: context.currentToolUseId ?? null, message },
      });
      return { data: `echo:${message}` };
    },
  };

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-tool-rpc",
      runId: "run-worker-tool-rpc",
      requestId: "req-worker-tool-rpc",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "call remote tool",
      modelRuntime: {
        modelName: "parent-test-model",
        contextWindow: 8192,
        maxOutputTokens: 512,
      },
    },
    tools: [remoteEchoTool],
    callModel: async function* (params) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "message_complete",
          content: [
            { type: "tool_use", id: "tool-1", name: "remote_echo", input: { message: "hello" } },
          ],
          model: "parent-test-model",
          provider: "provider",
        };
        return;
      }
      const toolResult = [...params.messages].reverse().find((message) => message.type === "tool_result");
      yield {
        type: "message_complete",
        content: [{ type: "text", text: `final:${toolResult?.content ?? "missing"}` }],
        model: "parent-test-model",
        provider: "provider",
      };
    },
    observeEvent: (event) => {
      observedEvents.push(event);
    },
  });

  expect(result.reason).toBe("completed");
  expect(parentToolCalls).toEqual([{ message: "hello", toolUseId: "tool-1" }]);
  expect(result.messages.at(-1)).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: "final:echo:hello" }],
  });
  expect(observedEvents).toContainEqual(
    expect.objectContaining({
      type: "test.parent_tool_event",
      data: { toolUseId: "tool-1", message: "hello" },
    }),
  );
});

test("runLeaderRuntimeInWorker rejects worker execute_tool RPC for tools outside the parent allowlist", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    const path = require("node:path");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const responsePath = path.join(path.dirname(process.argv[2]), "rpc-responses", "tool-rpc.json");
    const poll = setInterval(() => {
      if (!fs.existsSync(responsePath)) return;
      clearInterval(poll);
      const message = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      if (!message.ok) {
        process.stdout.write(JSON.stringify({ type: "error", message: message.error.message }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        type: "result",
        result: { reason: "completed", turnCount: 1, messages: [] }
      }) + "\\n");
    }, 10);
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "tool-rpc",
      method: "execute_tool",
      params: {
        toolUse: { id: "tool-1", name: "not_allowed", input: {} },
        context: { messages: [] }
      }
    }) + "\\n");
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-tool-rpc-deny",
      runId: "run-worker-tool-rpc-deny",
      requestId: "req-worker-tool-rpc-deny",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello rpc",
      modelRuntime: testModelRuntime,
    },
    tools: [
      {
        name: "allowed_tool",
        inputSchema: z.object({}),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        call: async () => ({ data: "ok" }),
      },
    ],
    workerCommand: process.execPath,
    workerArgs: [script],
  });

  expect(result.reason).toBe("model_error");
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: expect.stringContaining("tool not allowed: not_allowed") }],
  });
});

test("runLeaderRuntimeInWorker keeps tool approval callbacks parent-owned", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const approvalRequests: unknown[] = [];
  let callCount = 0;

  const approvalTool: LeaderTool = {
    name: "approval_tool",
    description: "Requests parent approval before returning.",
    inputSchema: z.object({ message: z.string() }),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isPlanSafe: () => true,
    call: async (args, context) => {
      const approval = await context.requestApproval?.({
        toolName: "approval_tool",
        toolInput: args as Record<string, unknown>,
        toolUseId: context.currentToolUseId ?? "unknown",
        message: String((args as { message: string }).message),
      });
      return { data: `approval:${approval?.decision ?? "missing"}:${approval?.feedback ?? ""}` };
    },
  };

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-tool-approval",
      runId: "run-worker-tool-approval",
      requestId: "req-worker-tool-approval",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "call approval tool",
      modelRuntime: testModelRuntime,
    },
    tools: [approvalTool],
    requestApproval: async (request) => {
      approvalRequests.push(request);
      return { decision: "approve", feedback: "parent-ok" };
    },
    callModel: async function* (params) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "message_complete",
          content: [
            { type: "tool_use", id: "tool-approval-1", name: "approval_tool", input: { message: "allow?" } },
          ],
          model: "parent-test-model",
          provider: "provider",
        };
        return;
      }
      const toolResult = [...params.messages].reverse().find((message) => message.type === "tool_result");
      yield {
        type: "message_complete",
        content: [{ type: "text", text: `final:${toolResult?.content ?? "missing"}` }],
        model: "parent-test-model",
        provider: "provider",
      };
    },
  });

  expect(result.reason).toBe("completed");
  expect(approvalRequests).toEqual([
    {
      toolName: "approval_tool",
      toolInput: { message: "allow?" },
      toolUseId: "tool-approval-1",
      message: "allow?",
    },
  ]);
  expect(result.messages.at(-1)).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: "final:approval:approve:parent-ok" }],
  });
});

test("runLeaderRuntimeInWorker handles record_event and checkpoint RPC requests from worker", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    const path = require("node:path");
    const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const responseDir = path.join(path.dirname(process.argv[2]), "rpc-responses");
    const pending = new Set(["event-1", "checkpoint-1"]);
    const poll = setInterval(() => {
      for (const id of [...pending]) {
        const responsePath = path.join(responseDir, id + ".json");
        if (!fs.existsSync(responsePath)) continue;
        const message = JSON.parse(fs.readFileSync(responsePath, "utf8"));
        pending.delete(message.id);
      }
      if (pending.size === 0) {
        clearInterval(poll);
        process.stdout.write(JSON.stringify({
          type: "result",
          result: {
            reason: "completed",
            turnCount: 1,
            messages: [{ type: "assistant", content: [{ type: "text", text: "rpc done" }] }]
          }
        }) + "\\n");
      }
    }, 10);
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "event-1",
      method: "record_event",
      params: {
        event: {
          type: "leader.tool_call",
          timestamp: "2026-05-14T00:00:00.000Z",
          data: { toolUseId: "rpc-write", toolName: "write_file" }
        }
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "checkpoint-1",
      method: "checkpoint",
      params: {
        sessionId: "session_rpc",
        turnCount: 1,
        messages: [{ type: "assistant", content: [{ type: "text", text: config.initialPrompt }] }]
      }
    }) + "\\n");
  `);
  const events: unknown[] = [];

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-rpc",
      runId: "run-worker-rpc",
      requestId: "req-worker-rpc",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello rpc",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    observeEvent: (event) => {
      events.push(event);
    },
  });

  expect(result.reason).toBe("completed");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "leader.tool_call",
    data: { toolUseId: "rpc-write" },
  });

  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const eventRepository = new ExecutionEventRepository();
  const toolEvents = await eventRepository.listByTaskIdAndType("task-worker-rpc", "leader.tool_call");
  expect(toolEvents).toHaveLength(1);
  expect(JSON.parse(toolEvents[0]!.payloadJson ?? "{}")).toMatchObject({
    toolUseId: "rpc-write",
    toolName: "write_file",
  });
  const checkpointEvents = await eventRepository.listByTaskIdAndType(
    "task-worker-rpc",
    "leader.session_checkpoint",
  );
  expect(checkpointEvents).toHaveLength(1);
  expect(JSON.parse(checkpointEvents[0]!.payloadJson ?? "{}")).toMatchObject({
    sessionId: "session_rpc",
    requestId: "req-worker-rpc",
    turnCount: 1,
  });
});

test("runLeaderRuntimeInWorker preserves executionPolicy and doomState through checkpoint RPC", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    const path = require("node:path");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const responseDir = path.join(path.dirname(process.argv[2]), "rpc-responses");
    const poll = setInterval(() => {
      const responsePath = path.join(responseDir, "checkpoint-policy.json");
      if (!fs.existsSync(responsePath)) return;
      clearInterval(poll);
      process.stdout.write(JSON.stringify({
        type: "result",
        result: {
          reason: "completed",
          turnCount: 2,
          messages: [{ type: "assistant", content: [{ type: "text", text: "policy rpc done" }] }]
        }
      }) + "\\n");
    }, 10);
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "checkpoint-policy",
      method: "checkpoint",
      params: {
        sessionId: "session_policy",
        turnCount: 2,
        messages: [{ type: "assistant", content: [{ type: "text", text: "hi" }] }],
        executionPolicy: {
          mode: "escalate",
          source: "user",
          reason: "test escalation",
          constraints: {},
          counters: { escalationCount: 1 }
        },
        doomState: { window: ["fp1", "fp2", "fp3"] }
      }
    }) + "\\n");
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-rpc-policy",
      runId: "run-worker-rpc-policy",
      requestId: "req-worker-rpc-policy",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello policy rpc",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
  });

  expect(result.reason).toBe("completed");

  const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
  const eventRepository = new ExecutionEventRepository();
  const checkpointEvents = await eventRepository.listByTaskIdAndType(
    "task-worker-rpc-policy",
    "leader.session_checkpoint",
  );
  expect(checkpointEvents).toHaveLength(1);
  const payload = JSON.parse(checkpointEvents[0]!.payloadJson ?? "{}");
  expect(payload).toMatchObject({
    sessionId: "session_policy",
    requestId: "req-worker-rpc-policy",
    turnCount: 2,
    executionPolicy: {
      mode: "escalate",
      source: "user",
      reason: "test escalation",
      counters: { escalationCount: 1 },
    },
    doomState: { window: ["fp1", "fp2", "fp3"] },
  });
});

test("runLeaderRuntimeInWorker returns model_error when parent rejects a worker RPC", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    const path = require("node:path");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const responsePath = path.join(path.dirname(process.argv[2]), "rpc-responses", "bad-checkpoint.json");
    const poll = setInterval(() => {
      if (!fs.existsSync(responsePath)) return;
      clearInterval(poll);
      const message = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      if (!message.ok) {
        process.stdout.write(JSON.stringify({ type: "error", message: message.error.message }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        type: "result",
        result: { reason: "completed", turnCount: 1, messages: [] }
      }) + "\\n");
    }, 10);
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "bad-checkpoint",
      method: "checkpoint",
      params: {}
    }) + "\\n");
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-rpc-error",
      runId: "run-worker-rpc-error",
      requestId: "req-worker-rpc-error",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello rpc",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
  });

  expect(result.reason).toBe("model_error");
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: expect.stringContaining("checkpoint params must include") }],
  });
});

test("runLeaderRuntimeInWorker rejects excess in-flight worker RPC requests", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    const path = require("node:path");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const responsePath = path.join(path.dirname(process.argv[2]), "rpc-responses", "event-1.json");
    const poll = setInterval(() => {
      if (!fs.existsSync(responsePath)) return;
      clearInterval(poll);
      const message = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      if (!message.ok) {
        process.stdout.write(JSON.stringify({
          type: "error",
          message: message.error.code + ": " + message.error.message
        }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        type: "result",
        result: { reason: "completed", turnCount: 1, messages: [] }
      }) + "\\n");
    }, 10);
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "event-1",
      method: "record_event",
      params: {
        event: {
          type: "leader.tool_call",
          timestamp: "2026-05-14T00:00:00.000Z",
          data: { toolUseId: "rpc-limit", toolName: "write_file" }
        }
      }
    }) + "\\n");
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-rpc-limit",
      runId: "run-worker-rpc-limit",
      requestId: "req-worker-rpc-limit",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello rpc",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    maxInFlightRpcRequests: 0,
  });

  expect(result.reason).toBe("model_error");
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: expect.stringContaining("too_many_in_flight") }],
  });
});

test("runLeaderRuntimeInWorker rejects unsafe worker RPC ids", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify({
      type: "rpc.request",
      id: "../escape",
      method: "record_event",
      params: {
        event: {
          type: "leader.tool_call",
          timestamp: "2026-05-14T00:00:00.000Z",
          data: { toolUseId: "rpc-escape", toolName: "write_file" }
        }
      }
    }) + "\\n");
    setInterval(() => {}, 1000);
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-rpc-id",
      runId: "run-worker-rpc-id",
      requestId: "req-worker-rpc-id",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello rpc",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
  });

  expect(result.reason).toBe("model_error");
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: expect.stringContaining("invalid worker rpc id") }],
  });
});

test("runLeaderRuntimeInWorker sends abort to worker before killing the process", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.on("SIGTERM", () => {
      process.stdout.write(JSON.stringify({
        type: "result",
        result: {
          reason: "aborted",
          turnCount: 0,
          messages: []
        }
      }) + "\\n");
    });
    setInterval(() => {}, 1000);
  `);
  const abortController = new AbortController();
  const promise = runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-abort",
      runId: "run-worker-abort",
      requestId: "req-worker-abort",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    signal: abortController.signal,
  });

  setTimeout(() => abortController.abort(), 50);
  const result = await promise;

  expect(result.reason).toBe("aborted");
  expect(result.turnCount).toBe(0);
});

test("runLeaderRuntimeInWorker terminates worker process group after result", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const markerDir = await makeTempDir("leader-worker-marker-");
  const pidPath = join(markerDir, "pid");
  const childPidPath = join(markerDir, "child-pid");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdout: "ignore",
      stderr: "ignore",
    });
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
    process.stdout.write(JSON.stringify({
      type: "result",
      result: {
        reason: "completed",
        turnCount: 0,
        messages: []
      }
    }) + "\\n");
    setInterval(() => {}, 1000);
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-result-cleanup",
      runId: "run-worker-result-cleanup",
      requestId: "req-worker-result-cleanup",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
  });

  expect(result.reason).toBe("completed");
  const pid = Number(await readFile(pidPath, "utf8"));
  const childPid = Number(await readFile(childPidPath, "utf8"));
  await expectProcessToExit(pid);
  await expectProcessToExit(childPid);
});

test("runLeaderRuntimeInWorker cancels finish SIGKILL timer after worker closes", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    const fs = require("node:fs");
    JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.stdout.write(JSON.stringify({
      type: "result",
      result: {
        reason: "completed",
        turnCount: 0,
        messages: []
      }
    }) + "\\n");
  `);
  // Avoid attributing a previous lifecycle test's fallback timer to this
  // test while process.kill is temporarily monkey-patched below.
  await sleep(600);
  const originalKill = process.kill;
  const sigkillPids: number[] = [];
  const mutableProcess = process as typeof process & {
    kill: typeof process.kill;
  };

  mutableProcess.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") {
      sigkillPids.push(pid);
    }
    return originalKill.call(process, pid, signal);
  }) as typeof process.kill;

  try {
    const result = await runLeaderRuntimeInWorker({
      config: {
        taskId: "task-worker-finish-kill-timer",
        runId: "run-worker-finish-kill-timer",
        requestId: "req-worker-finish-kill-timer",
        workspaceDir,
        systemPrompt: "system",
        initialPrompt: "hello",
        modelRuntime: testModelRuntime,
      },
      workerCommand: process.execPath,
      workerArgs: [script],
    });

    expect(result.reason).toBe("completed");
    await sleep(700);
    expect(sigkillPids).toEqual([]);
  } finally {
    mutableProcess.kill = originalKill;
  }
});

test("runLeaderRuntimeInWorker rejects oversized stdout lines", async () => {
  const workspaceDir = await makeTempDir("leader-worker-workspace-");
  const script = await writeWorkerScript(`
    process.stdout.write("x".repeat(256));
    setInterval(() => {}, 1000);
  `);

  const result = await runLeaderRuntimeInWorker({
    config: {
      taskId: "task-worker-large-line",
      runId: "run-worker-large-line",
      requestId: "req-worker-large-line",
      workspaceDir,
      systemPrompt: "system",
      initialPrompt: "hello",
      modelRuntime: testModelRuntime,
    },
    workerCommand: process.execPath,
    workerArgs: [script],
    maxStdoutLineBytes: 128,
  });

  expect(result.reason).toBe("model_error");
  expect(result.messages[0]).toMatchObject({
    type: "assistant",
    content: [{ type: "text", text: expect.stringContaining("stdout line exceeded") }],
  });
});
