import { spawn } from "node:child_process";
import type { ExecutionSandboxMetadata } from "../safe-apply/safe-apply-types";
import { findSensitiveInternalPathMatch } from "../safe-apply/sensitive-internal-paths";
import { isPureReadOnlyBash } from "../safe-apply/risk-classifier";

type BashToolResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionSandbox?: ExecutionSandboxMetadata;
};

type BashSpawnOverride = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  executionSandbox: ExecutionSandboxMetadata;
};

/**
 * Run a bash command. Honors the abort signal end-to-end: when the
 * leader loop's abort fires (user clicked Stop), the running shell
 * is killed (SIGTERM, SIGKILL after 1.5s grace). Without this, the
 * previous `child_process.exec` wrapper had no signal hookup — a
 * long-running bash (sleep 60, large find, etc.) kept executing
 * until natural completion even after cancel, which the user
 * perceived as "cancel didn't work, the previous turn is still
 * going while my new chat just sits there".
 */
export async function executeBashTool(input: {
  workspaceDir: string;
  command: string;
  signal?: AbortSignal;
  spawnOverride?: BashSpawnOverride;
  approvedInternalPathRead?: boolean;
}): Promise<BashToolResult> {
  // Reject before spawn — the command never runs, no side effects to
  // clean up. The exit-code shape mirrors a normal bash failure so the
  // model's existing error-handling branches still apply.
  const deniedMatch = findSensitiveInternalPathMatch(input.command);
  const approvedRead = input.approvedInternalPathRead === true && isPureReadOnlyBash(input.command);
  if (deniedMatch !== null && !approvedRead) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `Command rejected: references Magister-internal path '${deniedMatch}'. These directories are off-limits to agent tools.`,
    };
  }
  const withSandboxMetadata = (
    result: Omit<BashToolResult, "executionSandbox">,
  ): BashToolResult => input.spawnOverride?.executionSandbox
    ? { ...result, executionSandbox: input.spawnOverride.executionSandbox }
    : result;

  return new Promise<BashToolResult>((resolve) => {
    // detached:true puts the child in its own process group so we can
    // signal the whole tree with `process.kill(-pid, sig)`. Otherwise
    // a TERM-trapping bash that has spawned `sleep 30` would die on
    // SIGKILL but the orphan sleep keeps the stdio pipes open and
    // child.on("close") never fires — the wait would hang past any
    // grace period.
    const child = spawn(
      input.spawnOverride?.command ?? "/bin/bash",
      input.spawnOverride?.args ?? ["-c", input.command],
      {
        cwd: input.spawnOverride?.cwd ?? input.workspaceDir,
        detached: true,
        ...(input.spawnOverride?.env ? { env: input.spawnOverride.env } : {}),
      },
    );

    let stdout = "";
    let stderr = "";
    const MAX_BUFFER = 1024 * 1024;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) {
        stdout += chunk.toString();
        if (stdout.length > MAX_BUFFER) {
          stdout = stdout.slice(0, MAX_BUFFER);
          truncated = true;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) {
        stderr += chunk.toString();
        if (stderr.length > MAX_BUFFER) {
          stderr = stderr.slice(0, MAX_BUFFER);
          truncated = true;
        }
      }
    });

    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    function killGroup(sig: NodeJS.Signals): void {
      // child.pid is the leader of the new process group (because we
      // spawned with detached:true). `process.kill(-pid, sig)` signals
      // every process in that group — bash plus any descendants like
      // `sleep 30` it spawned. Without this, killing only `child` left
      // grandchildren attached to the inherited stdio, blocking close.
      const pid = child.pid;
      if (typeof pid !== "number") return;
      try { process.kill(-pid, sig); } catch { /* swallow ESRCH */ }
    }
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      killGroup("SIGTERM");
      // SIGKILL after grace period — some commands (curl in retry
      // loop, recursive rm on slow disk) ignore SIGTERM briefly.
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
      }, 1500);
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let resolved = false;
    let postExitGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      if (postExitGraceTimer) clearTimeout(postExitGraceTimer);
      input.signal?.removeEventListener("abort", onAbort);
      const exitCode = aborted
        ? 130 // conventional SIGINT exit code; signals "user aborted"
        : (typeof code === "number" ? code : (sig ? 137 : 1));
      const annotated = aborted
        ? (stderr ? stderr + "\n[aborted by user]" : "[aborted by user]")
        : stderr;
      resolve(withSandboxMetadata({
        exitCode,
        stdout: stdout.trimEnd(),
        stderr: (annotated + (truncated ? "\n[truncated]" : "")).trimEnd(),
      }));
    };

    child.on("error", (_err) => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      if (postExitGraceTimer) clearTimeout(postExitGraceTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(withSandboxMetadata({
        exitCode: 1,
        stdout: stdout.trimEnd(),
        stderr: (stderr + (truncated ? "\n[truncated]" : "")).trimEnd(),
      }));
    });

    // `exit` fires when the bash process itself exits — independent
    // of whether its stdio pipes have drained. For `nohup setsid foo &`
    // patterns the bash exits in <1s but a backgrounded grandchild
    // (uvicorn, dev server, etc.) inherits the stdout/stderr FDs and
    // keeps the pipes open from Node's side, so `close` never fires
    // and the caller would hang to the 5-min tool timeout.
    //
    // Fix: on `exit`, give a 200ms grace period for any trailing
    // bytes the bash may have flushed just before exiting, then
    // forcibly destroy our pipe ends. The grandchild is unaffected
    // (it has its own FD targets after the shell redirect, so its
    // logs still hit /tmp/foo.log or wherever); we're only closing
    // OUR view of those pipes so `close` finally resolves.
    child.on("exit", (code, sig) => {
      if (resolved) return;
      const POST_EXIT_GRACE_MS = 200;
      postExitGraceTimer = setTimeout(() => {
        try { child.stdout?.destroy(); } catch { /* */ }
        try { child.stderr?.destroy(); } catch { /* */ }
        // Belt-and-suspenders: if `close` doesn't fire even after we
        // destroy, resolve from here. Cap at one full second past exit.
        setTimeout(() => finish(code, sig), 800);
      }, POST_EXIT_GRACE_MS);
    });

    child.on("close", (code, sig) => finish(code, sig));
  });
}
