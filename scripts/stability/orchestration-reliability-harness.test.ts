import { expect, mock, test } from "bun:test";

import {
  monitorTask,
  runHarness,
  type CreatedTask,
  type HarnessOptions,
} from "./orchestration-reliability-harness";

test("monitorTask retries blocked runs and can recover to completion", async () => {
  const options: HarnessOptions = {
    apiBaseUrl: "http://127.0.0.1:3000",
    workspaceId: "workspace_main",
    source: "web",
    taskKind: "coding",
    tasks: 1,
    concurrency: 1,
    pollMs: 1,
    taskTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    maxRecoveryAttempts: 2,
    chaosRate: 0,
    promptPrefix: "Reliability harness task",
  };
  const task: CreatedTask = {
    taskId: "task_1",
    seedRunId: "run_seed",
    startedAtMs: Date.now(),
    chaosEnabled: false,
  };

  const steps = [
    {
      method: "GET",
      path: "/tasks/task_1",
      body: { ok: true, data: { id: "task_1", state: "IN_PROGRESS" } },
    },
    {
      method: "GET",
      path: "/tasks/task_1",
      body: { ok: true, data: { id: "task_1", state: "BLOCKED" } },
    },
    {
      method: "GET",
      path: "/tasks/task_1/context",
      body: {
        ok: true,
        data: {
          roleLanes: [{ runId: "run_failed_1", state: "FAILED" }],
        },
      },
    },
    {
      method: "POST",
      path: "/runs/run_failed_1/retry",
      body: { ok: true, data: {} },
    },
    {
      method: "GET",
      path: "/tasks/task_1",
      body: { ok: true, data: { id: "task_1", state: "COMPLETED" } },
    },
    {
      method: "GET",
      path: "/tasks/task_1/timeline",
      body: {
        ok: true,
        data: {
          items: [{ type: "task.orchestration.stopped", stopReason: "stop_condition_met" }],
        },
      },
    },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = steps.shift();
    expect(next).toBeDefined();

    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input instanceof URL ? input.toString() : input.toString());

    expect(method).toBe(next!.method);
    expect(url.pathname).toBe(next!.path);

    return new Response(JSON.stringify(next!.body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await monitorTask(task, options);
    expect(result.terminalState).toBe("COMPLETED");
    expect(result.recoveryAttempts).toBe(1);
    expect(result.recoveredAfterBlock).toBe(true);
    expect(result.duplicateStopReasonCount).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(steps).toHaveLength(0);
});

test("monitorTask keeps completed outcome when timeline fetch fails", async () => {
  const options: HarnessOptions = {
    apiBaseUrl: "http://127.0.0.1:3000",
    workspaceId: "workspace_main",
    source: "web",
    taskKind: "coding",
    tasks: 1,
    concurrency: 1,
    pollMs: 1,
    taskTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    maxRecoveryAttempts: 2,
    chaosRate: 0,
    promptPrefix: "Reliability harness task",
  };
  const task: CreatedTask = {
    taskId: "task_2",
    seedRunId: "run_seed_2",
    startedAtMs: Date.now(),
    chaosEnabled: false,
  };

  const steps = [
    {
      method: "GET",
      path: "/tasks/task_2",
      status: 200,
      body: { ok: true, data: { id: "task_2", state: "COMPLETED" } },
    },
    {
      method: "GET",
      path: "/tasks/task_2/timeline",
      status: 500,
      body: { error: { message: "timeline_failed" } },
    },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = steps.shift();
    expect(next).toBeDefined();

    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input instanceof URL ? input.toString() : input.toString());

    expect(method).toBe(next!.method);
    expect(url.pathname).toBe(next!.path);

    return new Response(JSON.stringify(next!.body), {
      status: next!.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await monitorTask(task, options);
    expect(result.terminalState).toBe("COMPLETED");
    expect(result.duplicateStopReasonCount).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(steps).toHaveLength(0);
});

test("runHarness isolates task errors and reports error metrics", async () => {
  const options: HarnessOptions = {
    apiBaseUrl: "http://127.0.0.1:3000",
    workspaceId: "workspace_main",
    source: "web",
    taskKind: "coding",
    tasks: 2,
    concurrency: 1,
    pollMs: 1,
    taskTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    maxRecoveryAttempts: 2,
    chaosRate: 0,
    promptPrefix: "Reliability harness task",
  };

  const steps = [
    {
      method: "POST",
      path: "/tasks",
      status: 500,
      body: { error: { message: "create_failed" } },
    },
    {
      method: "POST",
      path: "/tasks",
      status: 200,
      body: { ok: true, data: { taskId: "task_2", latestRunId: "run_seed_2" } },
    },
    {
      method: "GET",
      path: "/tasks/task_2",
      status: 200,
      body: { ok: true, data: { id: "task_2", state: "COMPLETED" } },
    },
    {
      method: "GET",
      path: "/tasks/task_2/timeline",
      status: 200,
      body: {
        ok: true,
        data: {
          items: [{ type: "task.orchestration.stopped", stopReason: "stop_condition_met" }],
        },
      },
    },
  ];

  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;
  let printedSummary = "";

  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = steps.shift();
    expect(next).toBeDefined();

    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input instanceof URL ? input.toString() : input.toString());

    expect(method).toBe(next!.method);
    expect(url.pathname).toBe(next!.path);

    return new Response(JSON.stringify(next!.body), {
      status: next!.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  console.log = mock((value?: unknown) => {
    printedSummary = typeof value === "string" ? value : JSON.stringify(value);
  }) as typeof console.log;

  try {
    await runHarness(options);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }

  expect(steps).toHaveLength(0);

  const summary = JSON.parse(printedSummary) as {
    requestedTasks: number;
    createdTasks: number;
    results: {
      completed: number;
      errors: number;
      completionRate: number;
      errorRate: number;
    };
  };

  expect(summary.requestedTasks).toBe(2);
  expect(summary.createdTasks).toBe(1);
  expect(summary.results.completed).toBe(1);
  expect(summary.results.errors).toBe(1);
  expect(summary.results.completionRate).toBe(0.5);
  expect(summary.results.errorRate).toBe(0.5);
});

test("runHarness assigns chaos deterministically when seed is set", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleLog = console.log;

  async function collectPrompts(seed: number) {
    const prompts: string[] = [];
    let taskCounter = 0;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = new URL(input instanceof URL ? input.toString() : input.toString());

      if (method === "POST" && url.pathname === "/tasks") {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(bodyText) as { prompt?: string };
        prompts.push(body.prompt ?? "");
        taskCounter += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            data: { taskId: `task_${taskCounter}`, latestRunId: `run_seed_${taskCounter}` },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (method === "GET" && /^\/tasks\/task_\d+$/.test(url.pathname)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { id: url.pathname.split("/").at(-1) ?? "task_unknown", state: "COMPLETED" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (method === "GET" && /^\/tasks\/task_\d+\/timeline$/.test(url.pathname)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [] },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }) as typeof fetch;

    console.log = mock(() => undefined) as typeof console.log;

    const options: HarnessOptions = {
      apiBaseUrl: "http://127.0.0.1:3000",
      workspaceId: "workspace_main",
      source: "web",
      taskKind: "coding",
      tasks: 8,
      concurrency: 1,
      pollMs: 1,
      taskTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      maxRecoveryAttempts: 2,
      chaosRate: 0.5,
      seed,
      promptPrefix: "Reliability harness task",
    };

    await runHarness(options);
    return prompts;
  }

  try {
    const first = await collectPrompts(42);
    const second = await collectPrompts(42);
    const third = await collectPrompts(43);

    expect(first).toEqual(second);
    expect(first).not.toEqual(third);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
  }
});
