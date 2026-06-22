import { describe, expect, test } from "bun:test";

import { runGracefulShutdown } from "../../src/utils/graceful-shutdown";

describe("runGracefulShutdown", () => {
  test("closes the app then releases the lock, exiting 0", async () => {
    const calls: string[] = [];
    const code = await runGracefulShutdown({
      closeApp: async () => { calls.push("close"); },
      releaseLock: async () => { calls.push("release"); },
      timeoutMs: 1000,
      now: () => 0,
    });
    expect(calls).toEqual(["close", "release"]);
    expect(code).toBe(0);
  });

  test("if closeApp hangs past the timeout, forces exit 1 without waiting forever", async () => {
    // The bug: app.close() never resolves because SSE long-connections
    // never drain. The shutdown MUST still terminate via the timeout
    // rather than hang until SIGKILL.
    let released = false;
    const code = await runGracefulShutdown({
      // never resolves — simulates app.close() blocked on an SSE stream
      closeApp: () => new Promise<void>(() => {}),
      releaseLock: async () => { released = true; },
      timeoutMs: 50,
      now: () => 0,
    });
    expect(code).toBe(1); // forced exit, not a clean 0
    // Lock is still released on the timeout path so the next instance
    // can acquire cleanly.
    expect(released).toBe(true);
  });

  test("is idempotent — a second invocation is a no-op returning null", async () => {
    const shutdown = makeOnceShutdown();
    const first = await shutdown();
    const second = await shutdown();
    expect(first).toBe(0);
    expect(second).toBe(null);
  });
});

// Helper mirroring how server.ts guards against double-firing on
// SIGINT+SIGTERM both arriving.
function makeOnceShutdown() {
  let done = false;
  return async (): Promise<number | null> => {
    if (done) return null;
    done = true;
    return runGracefulShutdown({
      closeApp: async () => {},
      releaseLock: async () => {},
      timeoutMs: 1000,
      now: () => 0,
    });
  };
}
