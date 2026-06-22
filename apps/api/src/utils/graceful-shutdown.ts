/**
 * Bounded graceful shutdown.
 *
 * The API server has long-lived SSE connections (`/tasks/:taskId/stream`)
 * that never close on their own. A naive `await app.close()` waits for
 * every connection to drain, so it hangs forever on those streams — the
 * process then ignores SIGTERM until restart.sh escalates to SIGKILL
 * (observed: "did not exit on SIGTERM (8s), escalating to SIGKILL").
 *
 * This helper races `closeApp()` against a timeout. On clean close it
 * exits 0; on timeout it still releases the lock (so the next instance
 * can acquire) and signals a forced exit (1). Either way it returns
 * promptly instead of hanging.
 */
export interface GracefulShutdownDeps {
  /** Close the HTTP server / drain what can be drained (Fastify app.close). */
  closeApp: () => Promise<void>;
  /** Release the on-disk process lock so the next instance starts cleanly. */
  releaseLock: () => Promise<void>;
  /** Max time to wait for closeApp before forcing exit. Default 15s. */
  timeoutMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

// MUST stay below restart.sh's graceful_kill SIGTERM wait window (20s)
// so the process force-exits cleanly on its own before restart.sh
// escalates to SIGKILL. 5s is ample for app.close() to drain everything
// except never-closing SSE streams, which is exactly what we time out on.
const DEFAULT_TIMEOUT_MS = 5_000;

export async function runGracefulShutdown(
  deps: GracefulShutdownDeps,
): Promise<number> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timedOut");

  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });

  let result: typeof timedOut | undefined;
  try {
    result = await Promise.race([
      deps.closeApp().then(() => undefined as undefined),
      timeoutPromise,
    ]);
  } catch {
    // closeApp threw — treat as "best-effort close done", fall through to
    // lock release + clean exit. Swallow: nothing actionable at shutdown.
    result = undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Always release the lock, on both the clean and timed-out paths, so a
  // SIGKILLed-or-slow predecessor never strands the lock file.
  try { await deps.releaseLock(); } catch { /* swallow */ }

  return result === timedOut ? 1 : 0;
}
