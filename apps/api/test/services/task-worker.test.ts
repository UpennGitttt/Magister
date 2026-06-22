import { describe, expect, test } from "bun:test";

import { TaskWorker, getAbortController } from "../../src/services/task-worker";
import type { TaskJob } from "../../src/services/process-task-intent-service";

function makeJob(taskId: string, requestId = `req_${taskId}`): TaskJob {
  return {
    taskId,
    runId: `run_${taskId}`,
    requestId,
    requestStartedAtMs: Date.now(),
    workspaceId: "ws_test",
    prompt: "",
  };
}

describe("TaskWorker.enqueue idempotency", () => {
  test("dedups by taskId when same id already active", async () => {
    let resolveFirst!: () => void;
    const blocking: (job: TaskJob) => Promise<void> = () =>
      new Promise<void>((resolve) => { resolveFirst = resolve; });
    const worker = new TaskWorker(1, blocking);
    worker.enqueue(makeJob("t1"));
    worker.enqueue(makeJob("t1", "req_dup"));
    expect(worker.snapshot().queuedCount).toBe(0); // first is active, not queued
    expect(worker.snapshot().activeCount).toBe(1);
    resolveFirst();
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("Regression: Ralph re-enqueue via requeueAfterCurrent", () => {
  test("self-requeue from inside the current job runs the next iteration", async () => {
    // Reproduces the bug fix: a job calls `worker.enqueue(...)` for
    // its own taskId from INSIDE the executor. Plain `enqueue` would
    // see active.has(taskId) === true and silently drop. The fixed
    // `requeueAfterCurrent` defers via setImmediate so it lands after
    // runOne.finally releases the active slot.
    let iterations = 0;
    let worker!: TaskWorker;
    const executor = async (job: TaskJob) => {
      iterations++;
      if (iterations === 1) {
        worker.requeueAfterCurrent(makeJob(job.taskId, "req_ralph_continuation"));
      }
    };
    worker = new TaskWorker(1, executor);
    worker.enqueue(makeJob("t_ralph"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(iterations).toBe(2);
    expect(worker.snapshot().activeCount).toBe(0);
    expect(worker.snapshot().queuedCount).toBe(0);
  });

  test("plain enqueue self-requeue is dropped (pins the regression so we can't undo the fix)", async () => {
    let iterations = 0;
    let worker!: TaskWorker;
    const executor = async (job: TaskJob) => {
      iterations++;
      if (iterations === 1) {
        worker.enqueue(makeJob(job.taskId, "req_dropped"));
      }
    };
    worker = new TaskWorker(1, executor);
    worker.enqueue(makeJob("t_broken"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(iterations).toBe(1); // second enqueue silently dropped
    expect(worker.snapshot().activeCount).toBe(0);
    expect(worker.snapshot().queuedCount).toBe(0);
  });

  test("requeueAfterCurrent from external caller (no active conflict) also works", async () => {
    let ran = 0;
    const executor = async () => { ran++; };
    const worker = new TaskWorker(1, executor);
    worker.requeueAfterCurrent(makeJob("t_external"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(1);
  });
});

describe("Worker / AbortController integration", () => {
  test("AbortController is registered during executor and released after", async () => {
    let observedDuringRun = false;
    let resolveJob!: () => void;
    const executor = async () => {
      observedDuringRun = getAbortController("t_abort") !== undefined;
      await new Promise<void>((r) => { resolveJob = r; });
    };
    const worker = new TaskWorker(1, executor);
    worker.enqueue(makeJob("t_abort"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observedDuringRun).toBe(true);
    resolveJob();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getAbortController("t_abort")).toBeUndefined();
  });
});
