import { describe, expect, test } from "bun:test";

import {
  readWithIdleTimeout,
  SSE_IDLE_TIMEOUT_MESSAGE,
} from "../../../../src/services/manager-automation/autonomous-loop/sse-idle-timeout";

// A minimal reader stub matching the slice of ReadableStreamDefaultReader
// that readWithIdleTimeout uses.
function readerThatNeverResolves(): { read: () => Promise<ReadableStreamReadResult<Uint8Array>> } {
  return { read: () => new Promise(() => {}) };
}
function readerThatResolves(value: Uint8Array | undefined): {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
} {
  return {
    read: async () =>
      value === undefined
        ? ({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>)
        : ({ done: false, value } as ReadableStreamReadResult<Uint8Array>),
  };
}

describe("readWithIdleTimeout", () => {
  test("passes through a normal read result well before the idle deadline", async () => {
    const chunk = new TextEncoder().encode("hello");
    const result = await readWithIdleTimeout(readerThatResolves(chunk), 1000);
    expect(result.done).toBe(false);
    expect(result.value).toEqual(chunk);
  });

  test("passes through a clean done result", async () => {
    const result = await readWithIdleTimeout(readerThatResolves(undefined), 1000);
    expect(result.done).toBe(true);
  });

  test("throws an idle-timeout error if the upstream goes silent (read never resolves)", async () => {
    // This is the bug: upstream accepts the connection, streams nothing
    // further, never closes. Without a timeout read() hangs forever and
    // freezes the leader loop. The helper must reject promptly.
    let threw: Error | null = null;
    const started = Date.now();
    try {
      await readWithIdleTimeout(readerThatNeverResolves(), 50);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).toBeTruthy();
    expect(threw?.message).toContain(SSE_IDLE_TIMEOUT_MESSAGE);
    // returned via timeout, not by hanging
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
