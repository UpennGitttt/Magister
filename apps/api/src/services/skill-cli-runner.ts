/**
 * Wrapper around the `skills` CLI (`npx skills@latest`) for the
 * skill management endpoints. We never invoke the CLI inline in
 * route handlers — they go through this module so the timeout,
 * output cap, and shell-injection guards live in one place.
 *
 * Why the portable `spawnProcess` helper and not `child_process.exec`:
 * spawnProcess passes array args straight to the binary (no shell), so
 * it doesn't shell-evaluate the command — it execvps the first arg with
 * the rest as positional args. That eliminates a class of shell-injection
 * risk if a route ever forwarded user-supplied strings into the args
 * (which it shouldn't, but defense in depth costs nothing here). The same
 * helper runs on both Bun and Node.
 */

import { spawnProcess } from "../lib/platform/spawn";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // npx + git clone for a fresh repo can hit ~2 min on a cold cache; 5 min is the upper bound we'll wait.
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB stdout/stderr cap each. The CLI's normal output is < 10 KB; 1 MiB is "something has gone really wrong" territory and we'd rather truncate than OOM.

/**
 * Validate the `<owner>/<repo>[@<skill>]` source string we accept
 * from the import endpoint. Letters, digits, dot, underscore, and
 * hyphen only — matches what GitHub allows for repos. Refuses
 * anything that could be misread as a flag or shell metachar even
 * though `spawnProcess` would treat it as a literal arg.
 */
const SOURCE_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(@[a-zA-Z0-9_.-]+)?$/;

export function isValidSkillSource(source: string): boolean {
  return SOURCE_PATTERN.test(source) && !source.startsWith("-");
}

/**
 * Same constraint we apply to manual skill names. Mirrors the
 * GitHub repo-name rules so anything we generate is portable to
 * the rest of the ecosystem if the user later publishes it.
 */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export type SkillCliResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when we killed the process for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** True when stdout or stderr hit the byte cap and was truncated. */
  truncated: boolean;
  /** Wall-clock duration, milliseconds. Useful for the UI to show
   *  how long an install/update took. */
  durationMs: number;
};

/**
 * Run `npx skills@latest <args>` with safety rails. The process is
 * spawned with `stdin: "ignore"` so it can't hang on prompts; the
 * `npx skills` CLI accepts `-y` to auto-confirm, which the import
 * route always passes.
 *
 * Returns a structured result rather than throwing on non-zero
 * exit — callers usually want to surface stderr verbatim to the
 * UI, so collapsing failures into exceptions would lose that.
 */
export async function runSkillsCli(
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<SkillCliResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const proc = spawnProcess(["npx", "skills@latest", ...args], {
    cwd: opts?.cwd ?? process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      // Force colorless output so the byte cap isn't blown by
      // ANSI sequences and the UI displays cleanly.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    // Per-stream 1 MiB cap; the helper keeps draining past the cap so
    // the subprocess can't deadlock on a full pipe — it just stops
    // buffering and flags `truncated`.
    maxBufferBytes: MAX_OUTPUT_BYTES,
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeoutHandle);

  const stdout = await proc.stdoutText();
  const stderr = await proc.stderrText();
  const truncated = proc.truncated;

  return {
    ok: exitCode === 0 && !timedOut,
    exitCode,
    stdout,
    stderr,
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
