import { spawn } from "node:child_process";

/**
 * Runtime-portable process spawn helper.
 *
 * Built on `node:child_process`, which both Bun and Node implement
 * fully — so a SINGLE implementation works on both runtimes and we do
 * not need a Bun-vs-Node branch here. This replaces the ~16 direct
 * `Bun.spawn` call sites (see docs/plans/2026-06-02-runtime-portability.md).
 *
 * Array args, never a shell: `spawn(cmd[0], cmd.slice(1))` execvp's the
 * binary with the rest as positional args, preserving the no-shell-eval
 * injection guarantee the CLI bridges rely on.
 *
 * Pipes are drained eagerly (data listeners attached before anyone
 * awaits `exited`) so a child that fills the OS pipe buffer (>64 KiB)
 * cannot deadlock waiting for a reader.
 */
export interface SpawnHandle {
  /** Resolves with the child's exit code (0 if it exited via signal). */
  exited: Promise<number>;
  /** Accumulated stdout, decoded as UTF-8. Awaits process exit. */
  stdoutText(): Promise<string>;
  /** Accumulated stderr, decoded as UTF-8. Awaits process exit. */
  stderrText(): Promise<string>;
  /** Send a signal to the child (default SIGTERM). */
  kill(signal?: NodeJS.Signals): void;
  /** True once stdout or stderr hit `maxBufferBytes` and dropped bytes. */
  readonly truncated: boolean;
}

export interface SpawnOptions {
  /** Replaces the child environment entirely when provided. */
  env?: Record<string, string>;
  /** Working directory for the child. */
  cwd?: string;
  /**
   * Per-stream cap (bytes) on buffered stdout/stderr. Once a stream
   * reaches the cap, further bytes are dropped but the pipe keeps
   * draining so the child can't deadlock. Truncate-rather-than-OOM,
   * matching the existing skill-cli-runner 1 MiB guard. Default:
   * unbounded.
   */
  maxBufferBytes?: number;
}

/** Bounded sink: appends until `cap`, then drops while still draining. */
function createSink(cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (size >= cap) {
        truncated = true;
        return;
      }
      const room = cap - size;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      chunks.push(slice);
      size += slice.length;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get truncated() {
      return truncated;
    },
  };
}

export function spawnProcess(cmd: string[], opts: SpawnOptions = {}): SpawnHandle {
  const [command, ...args] = cmd;
  const child = spawn(command as string, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  const cap = opts.maxBufferBytes ?? Number.POSITIVE_INFINITY;
  const stdoutSink = createSink(cap);
  const stderrSink = createSink(cap);
  child.stdout?.on("data", (chunk: Buffer) => stdoutSink.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrSink.push(chunk));

  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });

  return {
    exited,
    async stdoutText() {
      await exited;
      return stdoutSink.text();
    },
    async stderrText() {
      await exited;
      return stderrSink.text();
    },
    kill(signal) {
      child.kill(signal);
    },
    get truncated() {
      return stdoutSink.truncated || stderrSink.truncated;
    },
  };
}
