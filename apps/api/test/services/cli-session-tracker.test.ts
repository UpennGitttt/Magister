import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCliResumeArgv,
  detectCliSessionId,
} from "../../src/services/cli-session-tracker";

// Spec: PR-D (CLI runtime resume). Pin the file-discovery contract
// so a future codex / claude session-file rename surfaces as a test
// failure rather than silently breaking resume_id.

describe("buildCliResumeArgv", () => {
  test("codex builds non-interactive `exec resume` argv before the session id", () => {
    const r = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "do the next thing",
    );
    expect(r.command).toBe("codex");
    expect(r.args).toContain("exec");
    expect(r.args).toContain("resume");
    expect(r.args).toContain("019dd4d3-560d-76d1-bfc1-a85c0239652c");
    // codex resume only accepts sandbox / approval policy via `-c
    // <key=value>` overrides — the bare `--sandbox` flag is exec-only
    // (regression bug fixed 2026-05-20 after end-to-end probe caught
    // it; pre-fix every codex resume failed with "unexpected argument
    // '--sandbox' found" before the session lookup ran).
    expect(r.args).toEqual(expect.arrayContaining([
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
    ]));
    expect(r.args).not.toContain("--sandbox");
    const uuidIdx = r.args.indexOf("019dd4d3-560d-76d1-bfc1-a85c0239652c");
    expect(r.args.indexOf("-c")).toBeLessThan(uuidIdx);
    expect(r.args.indexOf("--skip-git-repo-check")).toBeLessThan(uuidIdx);
    expect(r.args[r.args.length - 1]).toBe("do the next thing");
  });

  test("codex resume includes --model when provided", () => {
    const r = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "x",
      { model: "gpt-5.5" },
    );
    expect(r.args).toContain("--model");
    expect(r.args).toContain("gpt-5.5");
    // Order: exec resume [profile flags] [safety flags] <UUID> <prompt>
    const modelIdx = r.args.indexOf("--model");
    const uuidIdx = r.args.indexOf("019dd4d3-560d-76d1-bfc1-a85c0239652c");
    expect(modelIdx).toBeLessThan(uuidIdx);
    expect(r.args.indexOf("-c")).toBeLessThan(uuidIdx);
  });

  test("codex prepends instructions to the resume prompt when set", () => {
    const r = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "next step",
      { instructions: "you are a careful coder" },
    );
    const prompt = r.args[r.args.length - 1]!;
    expect(prompt).toContain("you are a careful coder");
    expect(prompt).toContain("next step");
  });

  test("codex resume propagates reasoningEffort via -c config override", () => {
    // Fresh-spawn argv builder honors profile.reasoningEffort; resume
    // needs the same hand-off so the continued session runs with the
    // same effort level. Uses `-c <key=value>` (config override) form
    // since codex resume doesn't accept the bare `--config` flag.
    const r = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "x",
      { reasoningEffort: "high" },
    );
    expect(r.args).toContain('model_reasoning_effort="high"');

    const r2 = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "x",
      { reasoningEffort: "xhigh" },
    );
    // xhigh is mapped to "high" (codex doesn't support xhigh).
    expect(r2.args).toContain('model_reasoning_effort="high"');

    // Invalid value is silently dropped, not propagated as a reasoning
    // override. (The sandbox/approval -c args still exist.)
    const r3 = buildCliResumeArgv(
      "codex",
      "019dd4d3-560d-76d1-bfc1-a85c0239652c",
      "x",
      { reasoningEffort: "garbage" },
    );
    expect(r3.args).not.toContain('model_reasoning_effort="garbage"');
    expect(r3.args.filter((a) => a.startsWith("model_reasoning_effort"))).toHaveLength(0);
  });

  test("claude builds `--resume <UUID> --permission-mode auto -p <prompt>`", () => {
    const r = buildCliResumeArgv(
      "claude-code",
      "138c8463-e99d-4ec7-a5a3-da4a0528d554",
      "follow-up",
    );
    expect(r.command).toBe("claude");
    expect(r.args).toContain("--resume");
    expect(r.args).toContain("138c8463-e99d-4ec7-a5a3-da4a0528d554");
    expect(r.args).toContain("--permission-mode");
    expect(r.args[r.args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(r.args).not.toContain("--dangerously-skip-permissions");
    expect(r.args).toContain("-p");
    const pIdx = r.args.indexOf("-p");
    expect(r.args[pIdx + 1]).toBe("follow-up");
  });

  test("claude includes --append-system-prompt when instructions set", () => {
    const r = buildCliResumeArgv(
      "claude-code",
      "138c8463-e99d-4ec7-a5a3-da4a0528d554",
      "x",
      { instructions: "be terse" },
    );
    expect(r.args).toContain("--append-system-prompt");
    const ix = r.args.indexOf("--append-system-prompt");
    expect(r.args[ix + 1]).toBe("be terse");
  });

  test("opencode builds `run --session <id> <prompt>`", () => {
    const r = buildCliResumeArgv(
      "opencode",
      "ses_40c0170fbffefxo9Mmmg6wvLr1",
      "fix the regression",
    );
    expect(r.command).toBe("opencode");
    expect(r.args).toContain("run");
    expect(r.args).toContain("--session");
    const sIdx = r.args.indexOf("--session");
    expect(r.args[sIdx + 1]).toBe("ses_40c0170fbffefxo9Mmmg6wvLr1");
    // Prompt comes last (matches fresh-spawn ordering — opencode's
    // yargs greedily consumes positional args until the next flag).
    expect(r.args[r.args.length - 1]).toBe("fix the regression");
    // Resume intentionally omits `--format json` (black-box mode,
    // matching codex/claude resume).
    expect(r.args).not.toContain("--format");
  });

  test("opencode honors --model and prepends instructions", () => {
    const r = buildCliResumeArgv(
      "opencode",
      "ses_test12345678901234567890",
      "go on",
      { model: "anthropic/claude-sonnet-4-6", instructions: "be brief" },
    );
    expect(r.args).toContain("--model");
    const mIdx = r.args.indexOf("--model");
    expect(r.args[mIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
    expect(r.args[r.args.length - 1]).toBe("be brief\n\n---\n\nFollow-up:\ngo on");
  });
});

describe("detectCliSessionId", () => {
  let codexHome: string;
  let claudeHomeOverride: string;
  let workspaceDir: string;

  // We override homedir() implicitly by setting HOME env so claude
  // discovery looks at our scratch dir.
  const ORIG_HOME = process.env.HOME;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-tracker-"));
    codexHome = join(root, "codex-home");
    claudeHomeOverride = root;
    workspaceDir = join(root, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    process.env.HOME = root;
  });

  afterEach(async () => {
    process.env.HOME = ORIG_HOME;
    // tempdir cleanup left to the OS — keeps tests fast.
  });

  test("codex: finds the newest jsonl with UUID and ignores older sessions", async () => {
    const sessionsDir = join(codexHome, "sessions", "2026", "04", "30");
    await mkdir(sessionsDir, { recursive: true });
    // Two files — the OLDER one was written before we "spawned",
    // the NEWER one (matching mtime ≥ spawnStartMs) is ours.
    const olderPath = join(sessionsDir, "rollout-2026-04-30T10-00-00-aaaaaaaa-bbbb-cccc-dddd-000000000001.jsonl");
    const newerPath = join(sessionsDir, "rollout-2026-04-30T11-00-00-aaaaaaaa-bbbb-cccc-dddd-000000000002.jsonl");
    await writeFile(olderPath, "{}\n");
    await writeFile(newerPath, "{}\n");
    const olderTime = new Date("2026-04-30T10:00:00Z");
    const newerTime = new Date("2026-04-30T11:00:00Z");
    await utimes(olderPath, olderTime, olderTime);
    await utimes(newerPath, newerTime, newerTime);

    const spawnStartMs = newerTime.getTime() - 100;
    const id = await detectCliSessionId({
      runtime: "codex",
      workspaceDir,
      codexHome,
      spawnStartMs,
    });
    expect(id).toBe("aaaaaaaa-bbbb-cccc-dddd-000000000002");
  });

  test("codex: returns null when no jsonl exists at all", async () => {
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    const id = await detectCliSessionId({
      runtime: "codex",
      workspaceDir,
      codexHome,
      spawnStartMs: Date.now(),
    });
    expect(id).toBeNull();
  });

  test("codex: returns null when only older files exist (none newer than spawnStart)", async () => {
    const sessionsDir = join(codexHome, "sessions", "2026", "04", "29");
    await mkdir(sessionsDir, { recursive: true });
    const old = join(sessionsDir, "rollout-2026-04-29T10-00-00-aaaaaaaa-bbbb-cccc-dddd-000000000003.jsonl");
    await writeFile(old, "{}\n");
    const oldTime = new Date("2026-04-29T10:00:00Z");
    await utimes(old, oldTime, oldTime);

    // Spawn started later than ALL existing files (with 1s margin).
    const spawnStartMs = oldTime.getTime() + 60_000;
    const id = await detectCliSessionId({
      runtime: "codex",
      workspaceDir,
      codexHome,
      spawnStartMs,
    });
    expect(id).toBeNull();
  });

  test("claude: encodes workspace path and finds the newest session", async () => {
    // Workspace dir = `${root}/workspace` so encoded path is
    // `-${ROOT_HEAD}-workspace`. Build the projects dir under
    // ~/.claude (which we redirected to root via HOME override).
    const encoded = "-" + workspaceDir.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(claudeHomeOverride, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    const sessionUuid = "138c8463-e99d-4ec7-a5a3-da4a0528d554";
    const sessionPath = join(projectDir, `${sessionUuid}.jsonl`);
    await writeFile(sessionPath, "{}\n");
    const t = new Date("2026-04-30T12:00:00Z");
    await utimes(sessionPath, t, t);

    const id = await detectCliSessionId({
      runtime: "claude-code",
      workspaceDir,
      spawnStartMs: t.getTime() - 100,
    });
    expect(id).toBe(sessionUuid);
  });

  test("claude: ignores files whose basename isn't a UUID", async () => {
    const encoded = "-" + workspaceDir.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(claudeHomeOverride, ".claude", "projects", encoded);
    await mkdir(projectDir, { recursive: true });
    const noisePath = join(projectDir, "history-2026-04-30.jsonl");
    await writeFile(noisePath, "{}\n");
    const t = new Date();
    await utimes(noisePath, t, t);

    const id = await detectCliSessionId({
      runtime: "claude-code",
      workspaceDir,
      spawnStartMs: t.getTime() - 100,
    });
    expect(id).toBeNull();
  });

  test("claude: encodes underscores AND dots as `-` (regression: 2026-05-20)", async () => {
    // Real claude-code encoding rule is "[^a-zA-Z0-9] → -" — earlier
    // code only handled `/`, so any path with `_` or `.` looked up a
    // missing directory and resume silently failed for every claude
    // teammate spawned against this codebase (the project name has
    // an underscore: `magister`).
    const trickyWorkspace = join(claudeHomeOverride, "tricky_path.v2", "magister_app");
    await mkdir(trickyWorkspace, { recursive: true });
    const trickyEncoded = "-" + trickyWorkspace.replace(/^\/+/, "").replace(/[^a-zA-Z0-9]/g, "-");
    const trickyProjectDir = join(claudeHomeOverride, ".claude", "projects", trickyEncoded);
    await mkdir(trickyProjectDir, { recursive: true });
    const sessionUuid = "00000000-1111-2222-3333-444444444444";
    const sessionPath = join(trickyProjectDir, `${sessionUuid}.jsonl`);
    await writeFile(sessionPath, "{}\n");
    const t = new Date("2026-05-20T12:00:00Z");
    await utimes(sessionPath, t, t);

    const id = await detectCliSessionId({
      runtime: "claude-code",
      workspaceDir: trickyWorkspace,
      spawnStartMs: t.getTime() - 100,
    });
    expect(id).toBe(sessionUuid);
  });

  test("opencode: finds the newest ses_*.json inside session storage", async () => {
    // Mimic opencode's real layout: storage/session/<projectHash>/ses_*.json.
    // The projectHash is opencode-internal and we walk recursively
    // rather than reconstruct it, so any subdir name is fine.
    // Each session JSON must include `directory` matching our
    // workspaceDir — opencode populates this from the run cwd, and
    // detectCliSessionId uses it to disambiguate cross-project bleed.
    const sessionRoot = join(claudeHomeOverride, "opencode-storage");
    const projectDir = join(sessionRoot, "fake-project-hash");
    await mkdir(projectDir, { recursive: true });
    const olderPath = join(projectDir, "ses_1bff05c76ffe214N6QvgibufH8.json");
    const newerPath = join(projectDir, "ses_40c0170fbffefxo9Mmmg6wvLr1.json");
    await writeFile(olderPath, JSON.stringify({ id: "ses_1bff05c76ffe214N6QvgibufH8", directory: workspaceDir }));
    await writeFile(newerPath, JSON.stringify({ id: "ses_40c0170fbffefxo9Mmmg6wvLr1", directory: workspaceDir }));
    const olderTime = new Date("2026-05-19T10:00:00Z");
    const newerTime = new Date("2026-05-20T10:00:00Z");
    await utimes(olderPath, olderTime, olderTime);
    await utimes(newerPath, newerTime, newerTime);

    const id = await detectCliSessionId({
      runtime: "opencode",
      workspaceDir,
      opencodeSessionRoot: sessionRoot,
      spawnStartMs: newerTime.getTime() - 100,
    });
    expect(id).toBe("ses_40c0170fbffefxo9Mmmg6wvLr1");
  });

  test("opencode: skips sessions whose `directory` is a DIFFERENT project (cross-project bleed)", async () => {
    // H-1 regression (self-review 2026-05-20): concurrent opencode
    // runs in different projects could fall in our mtime window. The
    // detector must verify the session JSON's `directory` field
    // matches our workspaceDir — picking the newest-by-mtime alone
    // would swap us into another project's session.
    const sessionRoot = join(claudeHomeOverride, "opencode-storage-bleed");
    const otherProjectDir = join(sessionRoot, "other-project-hash");
    const ourProjectDir = join(sessionRoot, "our-project-hash");
    await mkdir(otherProjectDir, { recursive: true });
    await mkdir(ourProjectDir, { recursive: true });
    // Newer-mtime session belongs to a DIFFERENT project — must be
    // skipped.
    const interloperPath = join(otherProjectDir, "ses_interlopr0001interlopr0002.json");
    await writeFile(
      interloperPath,
      JSON.stringify({ id: "ses_interlopr0001interlopr0002", directory: "/some/other/project" }),
    );
    const interloperTime = new Date("2026-05-20T11:00:00Z");
    await utimes(interloperPath, interloperTime, interloperTime);
    // Older session is ours — should be returned.
    const oursPath = join(ourProjectDir, "ses_oursoursours0001oursours0002.json");
    await writeFile(
      oursPath,
      JSON.stringify({ id: "ses_oursoursours0001oursours0002", directory: workspaceDir }),
    );
    const oursTime = new Date("2026-05-20T10:00:00Z");
    await utimes(oursPath, oursTime, oursTime);

    const id = await detectCliSessionId({
      runtime: "opencode",
      workspaceDir,
      opencodeSessionRoot: sessionRoot,
      spawnStartMs: oursTime.getTime() - 100,
    });
    expect(id).toBe("ses_oursoursours0001oursours0002");
  });

  test("opencode: returns null when matching candidates exist but none belong to our project", async () => {
    const sessionRoot = join(claudeHomeOverride, "opencode-storage-nomatch");
    const otherProjectDir = join(sessionRoot, "other-project-hash");
    await mkdir(otherProjectDir, { recursive: true });
    const otherPath = join(otherProjectDir, "ses_otherprojects01otherprojects02.json");
    await writeFile(
      otherPath,
      JSON.stringify({ id: "ses_otherprojects01otherprojects02", directory: "/some/other/project" }),
    );
    const t = new Date("2026-05-20T10:00:00Z");
    await utimes(otherPath, t, t);

    const id = await detectCliSessionId({
      runtime: "opencode",
      workspaceDir,
      opencodeSessionRoot: sessionRoot,
      spawnStartMs: t.getTime() - 100,
    });
    // Don't fall back to "newest regardless" — that'd swap projects.
    expect(id).toBeNull();
  });

  test("opencode: returns null when session storage is empty", async () => {
    const id = await detectCliSessionId({
      runtime: "opencode",
      workspaceDir,
      opencodeSessionRoot: join(claudeHomeOverride, "opencode-empty"),
      spawnStartMs: Date.now(),
    });
    expect(id).toBeNull();
  });

  test("opencode: ignores files whose basename isn't a ses_* id", async () => {
    const sessionRoot = join(claudeHomeOverride, "opencode-storage-2");
    const projectDir = join(sessionRoot, "fake-project");
    await mkdir(projectDir, { recursive: true });
    const noisePath = join(projectDir, "config.json");
    await writeFile(noisePath, "{}\n");
    const t = new Date();
    await utimes(noisePath, t, t);
    const id = await detectCliSessionId({
      runtime: "opencode",
      workspaceDir,
      opencodeSessionRoot: sessionRoot,
      spawnStartMs: t.getTime() - 100,
    });
    expect(id).toBeNull();
  });
});
