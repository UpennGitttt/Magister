export type HarnessOptions = {
  apiBaseUrl: string;
  workspaceId: string;
  source: "web" | "cli";
  taskKind: "coding" | "conversation";
  tasks: number;
  concurrency: number;
  pollMs: number;
  taskTimeoutMs: number;
  requestTimeoutMs: number;
  maxRecoveryAttempts: number;
  chaosRate: number;
  seed?: number;
  promptPrefix: string;
};

export type CreatedTask = {
  taskId: string;
  seedRunId: string;
  startedAtMs: number;
  chaosEnabled: boolean;
};

export type TaskTerminalState = "COMPLETED" | "BLOCKED" | "TIMEOUT" | "ERROR";

export type TaskResult = {
  taskId: string;
  seedRunId: string;
  terminalState: TaskTerminalState;
  durationMs: number;
  recoveryAttempts: number;
  recoveredAfterBlock: boolean;
  duplicateStopReasonCount: number;
  error?: string;
};

function parseNumberArg(raw: string | undefined, fallback: number) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseRateArg(raw: string | undefined, fallback: number) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function parseSeedArg(raw: string | undefined) {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const normalized = Math.trunc(parsed);
  if (normalized < 0) {
    return undefined;
  }
  return normalized;
}

function createDeterministicRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function parseArgs(argv: string[]): HarnessOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, value);
    index += 1;
  }

  return {
    apiBaseUrl: values.get("api") ?? "http://127.0.0.1:3700",
    workspaceId: values.get("workspace") ?? "workspace_main",
    source: values.get("source") === "cli" ? "cli" : "web",
    taskKind: values.get("task-kind") === "conversation" ? "conversation" : "coding",
    tasks: parseNumberArg(values.get("tasks"), 100),
    concurrency: parseNumberArg(values.get("concurrency"), 8),
    pollMs: parseNumberArg(values.get("poll-ms"), 2000),
    taskTimeoutMs: parseNumberArg(values.get("task-timeout-ms"), 20 * 60 * 1000),
    requestTimeoutMs: parseNumberArg(values.get("request-timeout-ms"), 30_000),
    maxRecoveryAttempts: parseNumberArg(values.get("max-recovery-attempts"), 2),
    chaosRate: parseRateArg(values.get("chaos-rate"), 0.15),
    seed: parseSeedArg(values.get("seed")),
    promptPrefix: values.get("prompt-prefix") ?? "Reliability harness task",
  };
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      body &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : `HTTP ${response.status}`;
    throw new Error(`${path}: ${message}`);
  }

  return body as T;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index] ?? 0;
}

async function createTask(
  options: HarnessOptions,
  index: number,
  randomValue: () => number,
): Promise<CreatedTask> {
  const chaosEnabled = randomValue() < options.chaosRate;
  const prompt =
    options.taskKind === "conversation"
      ? `${options.promptPrefix} #${index + 1}
请用一句话回答：你是谁？`
      : `${options.promptPrefix} #${index + 1}
Objective: Implement or refine a small coding task and report outcome.
Constraints: Keep the answer concise and execution-focused.
${chaosEnabled ? "Chaos: this task may receive manual continue/retry perturbations." : ""}`;

  const created = await requestJson<{
    ok: boolean;
    data: {
      taskId: string;
      latestRunId: string;
    };
  }>(options.apiBaseUrl, "/tasks", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      source: options.source,
      workspaceId: options.workspaceId,
      ...(options.taskKind === "coding"
        ? {
            taskManagerHints: {
              taskType: "coding",
              coordinationAction: "assign",
              stopCondition: "implementation_ready",
              childRuns: [
                {
                  roleId: "coder",
                },
              ],
            },
          }
        : {
            taskManagerHints: {
              taskType: "conversation",
              coordinationAction: "direct_answer",
              stopCondition: "reply_sent",
            },
          }),
      createdBy: "stability_harness",
    }),
  }, options.requestTimeoutMs);

  return {
    taskId: created.data.taskId,
    seedRunId: created.data.latestRunId,
    startedAtMs: Date.now(),
    chaosEnabled,
  };
}

function extractDuplicateStopReasons(history: {
  data?: {
    items?: Array<{
      type?: string;
      stopReason?: string;
    }>;
  };
}) {
  const stopReasons = (history.data?.items ?? [])
    .filter((item) => item.type === "task.orchestration.stopped")
    .map((item) => item.stopReason ?? "unknown");
  const counts = new Map<string, number>();
  for (const reason of stopReasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      duplicates += count - 1;
    }
  }
  return duplicates;
}

async function fetchDuplicateStopReasonCount(
  apiBaseUrl: string,
  taskId: string,
  requestTimeoutMs: number,
): Promise<number> {
  try {
    const history = await requestJson<{
      ok: boolean;
      data: {
        items: Array<{
          type?: string;
          stopReason?: string;
        }>;
      };
    }>(apiBaseUrl, `/tasks/${taskId}/timeline`, undefined, requestTimeoutMs);
    return extractDuplicateStopReasons(history);
  } catch {
    // Timeline fetch is best-effort observability data and should not flip task outcome to ERROR.
    return 0;
  }
}

export async function monitorTask(
  task: CreatedTask,
  options: HarnessOptions,
): Promise<TaskResult> {
  const deadline = Date.now() + options.taskTimeoutMs;
  let recoveryAttempts = 0;
  let sawBlocked = false;
  let chaosTriggered = false;

  while (Date.now() < deadline) {
    const summary = await requestJson<{
      ok: boolean;
      data: {
        id: string;
        state: string;
      };
    }>(options.apiBaseUrl, `/tasks/${task.taskId}`, undefined, options.requestTimeoutMs);

    const state = summary.data.state;
    if (state === "COMPLETED") {
      return {
        taskId: task.taskId,
        seedRunId: task.seedRunId,
        terminalState: state,
        durationMs: Date.now() - task.startedAtMs,
        recoveryAttempts,
        recoveredAfterBlock: sawBlocked && state === "COMPLETED",
        duplicateStopReasonCount: await fetchDuplicateStopReasonCount(
          options.apiBaseUrl,
          task.taskId,
          options.requestTimeoutMs,
        ),
      };
    }

    if (state === "BLOCKED") {
      sawBlocked = true;
    }

    if (task.chaosEnabled && !chaosTriggered) {
      chaosTriggered = true;
      try {
        await requestJson(options.apiBaseUrl, `/runs/${task.seedRunId}/continue`, {
          method: "POST",
          body: JSON.stringify({}),
        }, options.requestTimeoutMs);
      } catch {
        // Best-effort chaos perturbation.
      }
    }

    if (state === "BLOCKED") {
      if (recoveryAttempts >= options.maxRecoveryAttempts) {
        return {
          taskId: task.taskId,
          seedRunId: task.seedRunId,
          terminalState: "BLOCKED",
          durationMs: Date.now() - task.startedAtMs,
          recoveryAttempts,
          recoveredAfterBlock: false,
          duplicateStopReasonCount: await fetchDuplicateStopReasonCount(
            options.apiBaseUrl,
            task.taskId,
            options.requestTimeoutMs,
          ),
        };
      }

      const context = await requestJson<{
        ok: boolean;
        data: {
          roleLanes: Array<{
            runId?: string;
            state?: string;
          }>;
        };
      }>(
        options.apiBaseUrl,
        `/tasks/${task.taskId}/context`,
        undefined,
        options.requestTimeoutMs,
      );

      const failedLane = context.data.roleLanes.find(
        (lane) => lane.runId && lane.state === "FAILED",
      );
      const pendingLane = context.data.roleLanes.find(
        (lane) =>
          lane.runId &&
          (lane.state === "CREATED" || lane.state === "QUEUED" || lane.state === "BLOCKED"),
      );
      const targetRunId = failedLane?.runId ?? pendingLane?.runId;

      if (targetRunId) {
        recoveryAttempts += 1;
        if (failedLane?.runId) {
          await requestJson(options.apiBaseUrl, `/runs/${targetRunId}/retry`, {
            method: "POST",
            body: JSON.stringify({}),
          }, options.requestTimeoutMs).catch(() => undefined);
        } else {
          await requestJson(options.apiBaseUrl, `/runs/${targetRunId}/continue`, {
            method: "POST",
            body: JSON.stringify({}),
          }, options.requestTimeoutMs).catch(() => undefined);
        }
      }
    }

    await sleep(options.pollMs);
  }

  return {
    taskId: task.taskId,
    seedRunId: task.seedRunId,
    terminalState: "TIMEOUT",
    durationMs: Date.now() - task.startedAtMs,
    recoveryAttempts,
    recoveredAfterBlock: false,
    duplicateStopReasonCount: 0,
    error: "task_timeout",
  };
}

export async function runHarness(options: HarnessOptions) {
  const startedAt = Date.now();
  const randomValue =
    options.seed === undefined ? Math.random : createDeterministicRandom(options.seed);
  const createdTasks: CreatedTask[] = [];
  const results: TaskResult[] = [];
  const taskIndexes = Array.from({ length: options.tasks }, (_, index) => index);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= taskIndexes.length) {
        return;
      }
      const startedAtMs = Date.now();
      let createdTask: CreatedTask | undefined;
      try {
        createdTask = await createTask(options, index, randomValue);
        createdTasks.push(createdTask);
        const result = await monitorTask(createdTask, options);
        results.push(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown_harness_worker_error";
        results.push({
          taskId: createdTask?.taskId ?? `task_create_failed_${index + 1}`,
          seedRunId: createdTask?.seedRunId ?? "seed_run_unknown",
          terminalState: "ERROR",
          durationMs: Date.now() - startedAtMs,
          recoveryAttempts: 0,
          recoveredAfterBlock: false,
          duplicateStopReasonCount: 0,
          error: message,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.tasks) }, () => worker()),
  );

  const completed = results.filter((result) => result.terminalState === "COMPLETED");
  const blocked = results.filter((result) => result.terminalState === "BLOCKED");
  const timedOut = results.filter((result) => result.terminalState === "TIMEOUT");
  const errors = results.filter((result) => result.terminalState === "ERROR");
  const durations = results
    .filter(
      (result) =>
        result.terminalState === "COMPLETED" || result.terminalState === "BLOCKED",
    )
    .map((result) => result.durationMs);
  const totalRecoveryAttempts = results.reduce(
    (sum, result) => sum + result.recoveryAttempts,
    0,
  );
  const recoveredAfterBlock = results.filter((result) => result.recoveredAfterBlock).length;
  const duplicateStopReasonCount = results.reduce(
    (sum, result) => sum + result.duplicateStopReasonCount,
    0,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    apiBaseUrl: options.apiBaseUrl,
    workspaceId: options.workspaceId,
    requestedTasks: options.tasks,
    createdTasks: createdTasks.length,
    concurrency: options.concurrency,
    pollMs: options.pollMs,
    taskTimeoutMs: options.taskTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    maxRecoveryAttempts: options.maxRecoveryAttempts,
    chaosRate: options.chaosRate,
    taskKind: options.taskKind,
    seed: options.seed ?? null,
    runDurationMs: Date.now() - startedAt,
    results: {
      completed: completed.length,
      blocked: blocked.length,
      timedOut: timedOut.length,
      errors: errors.length,
      completionRate:
        options.tasks > 0 ? Number((completed.length / options.tasks).toFixed(4)) : 0,
      blockedRate:
        options.tasks > 0 ? Number((blocked.length / options.tasks).toFixed(4)) : 0,
      timeoutRate:
        options.tasks > 0 ? Number((timedOut.length / options.tasks).toFixed(4)) : 0,
      errorRate:
        options.tasks > 0 ? Number((errors.length / options.tasks).toFixed(4)) : 0,
    },
    recovery: {
      totalRecoveryAttempts,
      recoveredAfterBlock,
      recoveredAfterBlockRate:
        options.tasks > 0
          ? Number((recoveredAfterBlock / options.tasks).toFixed(4))
          : 0,
    },
    latency: {
      meanMs:
        durations.length > 0
          ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
          : 0,
      p95Ms: Math.round(percentile(durations, 95)),
    },
    duplicates: {
      duplicateStopReasonCount,
      duplicateStopReasonRate:
        options.tasks > 0
          ? Number((duplicateStopReasonCount / options.tasks).toFixed(4))
          : 0,
    },
    errorSamples: errors.slice(0, 5).map((item) => ({
      taskId: item.taskId,
      error: item.error ?? "unknown",
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  await runHarness(options);
}
