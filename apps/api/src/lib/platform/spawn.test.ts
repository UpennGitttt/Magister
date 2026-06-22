import { describe, expect, test } from "bun:test";

import { spawnProcess } from "./spawn";

describe("spawnProcess", () => {
  test("captures stdout text and a zero exit code", async () => {
    const proc = spawnProcess(["printf", "hello"]);
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(await proc.stdoutText()).toBe("hello");
  });

  test("caps buffered stdout at maxBufferBytes without dropping the exit", async () => {
    // `head -c 1000 /dev/zero` emits 1000 NUL bytes to stdout.
    const proc = spawnProcess(["head", "-c", "1000", "/dev/zero"], { maxBufferBytes: 100 });
    const code = await proc.exited;
    expect(code).toBe(0);
    expect((await proc.stdoutText()).length).toBe(100);
  });

  test("surfaces a non-zero exit code and stderr", async () => {
    const proc = spawnProcess(["ls", "/no/such/path/xyz"]);
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(await proc.stderrText()).toContain("No such file");
  });

  test("does not deadlock on output larger than the OS pipe buffer", async () => {
    // 200 KiB of stdout — well past the ~64 KiB pipe buffer. If the
    // helper awaited `exited` before draining, this would hang.
    const proc = spawnProcess(["head", "-c", "204800", "/dev/zero"]);
    const code = await proc.exited;
    expect(code).toBe(0);
    expect((await proc.stdoutText()).length).toBe(204800);
  });

  test("replaces the child environment when env is provided", async () => {
    const proc = spawnProcess(["env"], { env: { FOO: "bar" } });
    await proc.exited;
    expect(await proc.stdoutText()).toContain("FOO=bar");
  });

  test("rejects exited when the binary does not exist", async () => {
    const proc = spawnProcess(["this-binary-does-not-exist-xyz-123"]);
    await expect(proc.exited).rejects.toThrow();
  });

  test("flags truncated when output exceeds the cap", async () => {
    const proc = spawnProcess(["head", "-c", "1000", "/dev/zero"], { maxBufferBytes: 100 });
    await proc.exited;
    expect(proc.truncated).toBe(true);
  });

  test("does not flag truncated when output fits under the cap", async () => {
    const proc = spawnProcess(["printf", "hi"], { maxBufferBytes: 100 });
    await proc.exited;
    expect(proc.truncated).toBe(false);
  });
});
