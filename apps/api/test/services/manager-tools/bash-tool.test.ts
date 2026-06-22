import { test, expect } from "bun:test";
import { executeBashTool } from "../../../src/services/manager-tools/bash-tool";

test("executeBashTool resolves promptly when bash backgrounds a long-running child that inherits stdio", async () => {
  // Regression for the demo-service "stuck at 4m 05s" incident: a model
  // emits `nohup setsid uvicorn ... &` to background a server, the
  // bash shell exits in <100ms, but the grandchild inherits Node's
  // stdout/stderr pipe FDs (despite the shell-level `>` redirect,
  // some grandchild process patterns leave the pipe held open). The
  // `close` event then never fires and the caller waits to the
  // 5-min tool timeout.
  //
  // Fix: on `exit` we destroy our pipe ends after a short grace
  // period. This test exercises the worst-case shape — no redirect
  // at all, the grandchild explicitly inherits stdio — and confirms
  // resolution within ~1.5s instead of hanging.
  const t0 = Date.now();
  const r = await executeBashTool({
    workspaceDir: process.cwd(),
    // `sleep 30 &` puts a child sleeping in the background WITHOUT
    // any FD redirect. Bash exits immediately, but the sleep child
    // inherits the stdio pipes. Pre-fix this hung; post-fix it
    // returns in the 200ms grace + close epsilon.
    command: "sleep 30 &",
  });
  const elapsed = Date.now() - t0;
  expect(r.exitCode).toBe(0);
  // Generous upper bound — typical resolution is ~250ms.
  expect(elapsed).toBeLessThan(2000);
});

test("executeBashTool runs a simple command and returns stdout", async () => {
  const r = await executeBashTool({ workspaceDir: process.cwd(), command: "echo hello" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("hello");
  expect(r.stderr).toBe("");
});

test("executeBashTool captures non-zero exit code and stderr", async () => {
  const r = await executeBashTool({
    workspaceDir: process.cwd(),
    command: "ls /__no_such_dir_for_bash_test__ 2>&1; exit 7",
  });
  expect(r.exitCode).toBe(7);
});

test("executeBashTool kills child when abort signal fires mid-execution", async () => {
  // Critical regression: previously the bash tool used child_process.exec
  // with no signal hookup, so a long-running command kept executing after
  // the leader loop's cancel — user perceived "cancel didn't work, the
  // previous turn is still going".
  const ac = new AbortController();
  const t0 = Date.now();
  const promise = executeBashTool({
    workspaceDir: process.cwd(),
    command: "sleep 30",
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);
  const r = await promise;
  const elapsed = Date.now() - t0;
  // Should resolve within ~2s (kill grace is 1.5s) — well under sleep 30.
  expect(elapsed).toBeLessThan(2500);
  expect(r.exitCode).toBe(130);
  expect(r.stderr).toContain("aborted by user");
});

test("executeBashTool SIGKILL fallback fires for SIGTERM-ignoring child", async () => {
  // Some commands trap SIGTERM (curl in a retry loop, custom signal
  // handlers in long scripts) and only respect SIGKILL. The 1.5s
  // grace timer in bash-tool.ts is the safety net. Spawn a bash that
  // explicitly traps TERM and sleeps; abort and assert the call
  // resolves within ~3s (grace + a bit of slack), proving SIGKILL
  // actually fired.
  const ac = new AbortController();
  const t0 = Date.now();
  const promise = executeBashTool({
    workspaceDir: process.cwd(),
    // Ignore TERM, then sleep long enough that without SIGKILL we'd
    // hang the test runner.
    command: "trap '' TERM; sleep 30",
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);
  const r = await promise;
  const elapsed = Date.now() - t0;
  // Should resolve well under 30s; allow a generous 3.5s for grace +
  // CI overhead.
  expect(elapsed).toBeLessThan(3500);
  expect(elapsed).toBeGreaterThan(1500); // SIGKILL only fires AFTER the 1.5s grace
  expect(r.exitCode).toBe(130);
});

// Layer-4 denylist for Magister-internal paths. Honest-actor protection,
// not adversarial. The original 2026-05-03 incident was a model that
// asked grep to walk into `.local/`; if it had instead used `cat
// .local/control-plane.sqlite` directly we'd want the same kind of
// denial signal here as the path-taking tools surface.
test("executeBashTool rejects 'cat .local/control-plane.sqlite' before spawn", async () => {
  const r = await executeBashTool({
    workspaceDir: process.cwd(),
    command: "cat .local/control-plane.sqlite",
  });
  expect(r.exitCode).toBe(-1);
  expect(r.stderr).toContain("Magister-internal");
  expect(r.stderr).toContain(".local");
});

test("executeBashTool rejects find / cat against .magister, secrets, .env", async () => {
  for (const cmd of [
    "find .magister -name '*.json'",
    "cat config/secrets.json",
    "cat .env.production",
  ]) {
    const r = await executeBashTool({ workspaceDir: process.cwd(), command: cmd });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("rejected");
  }
});

test("executeBashTool allows an approval-backed read of .env", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "bash-approved-env-"));
  writeFileSync(join(ws, ".env"), "SECRET_VALUE=ok\n");

  const r = await executeBashTool({
    workspaceDir: ws,
    command: "cat .env",
    approvedInternalPathRead: true,
  });

  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("SECRET_VALUE=ok");
});

test("executeBashTool catches multi-statement bypasses (cd .local; cat x)", async () => {
  // Kimi review C2: shell metacharacter ; was not in the after-boundary
  // class, so `cd .local; cat x` slipped through. Verify it's caught.
  for (const cmd of [
    "cd .local; cat x",
    "true && cat .local/db",
    "echo hi | tee .magister/leak",
    "echo > .env.production",
    "(cat .env.local)",
  ]) {
    const r = await executeBashTool({ workspaceDir: process.cwd(), command: cmd });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("rejected");
  }
});

test("executeBashTool allows .env template files (.example/.template/.sample/.dist)", async () => {
  // Kimi review M3: .env.example etc are tracked templates with no
  // secrets — must NOT be denied. Touch a temp .env.example so cat
  // doesn't fail with ENOENT (we want exitCode 0, proving the regex
  // didn't reject before spawn).
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws = mkdtempSync(join(tmpdir(), "bash-env-"));
  writeFileSync(join(ws, ".env.example"), "EXAMPLE_VAR=value\n");
  const r = await executeBashTool({ workspaceDir: ws, command: "cat .env.example" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("EXAMPLE_VAR");
});

test("executeBashTool — common false-positive boundaries are NOT triggered", async () => {
  // .localhost-test, .envyfile (made-up dirs/files that share a prefix
  // with denied patterns) must not be rejected. The boundary anchors
  // require a separator character, so ".localFOO" should fall through.
  const r = await executeBashTool({
    workspaceDir: process.cwd(),
    command: "echo .localFOO .envyfile sometext",
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain(".localFOO");
});

test("executeBashTool allows ordinary commands (sanity)", async () => {
  const r = await executeBashTool({ workspaceDir: process.cwd(), command: "echo hi" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe("hi");
});

test("executeBashTool with already-aborted signal exits immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  const r = await executeBashTool({
    workspaceDir: process.cwd(),
    command: "sleep 30",
    signal: ac.signal,
  });
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(2500);
  expect(r.exitCode).toBe(130);
});
