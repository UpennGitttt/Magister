import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSemgrepJson,
  runSastAdvisory,
} from "../../../src/services/safe-apply/sast-advisory-service";
import type { RuntimeDiffArtifact } from "../../../src/services/safe-apply/safe-apply-types";

const tempDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function diffArtifact(workspaceDir: string): RuntimeDiffArtifact {
  return {
    artifactId: "artifact_diff",
    artifactType: "runtime_diff",
    storageKind: "file",
    storageRef: join(workspaceDir, ".magister", "runtime.patch"),
    diffHash: "hash",
    diffAlgorithm: {
      command: ["git", "diff"],
      gitVersion: "git version 2.43.0",
      hash: "sha256",
    },
    baseRevision: "base",
    changedFiles: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
        isExecutable: false,
      },
      {
        path: "src/old.ts",
        status: "deleted",
        additions: 0,
        deletions: 1,
        isBinary: false,
        isExecutable: false,
      },
    ],
    addedLines: 1,
    removedLines: 1,
    isEmpty: false,
  };
}

function changedFile(path: string): RuntimeDiffArtifact["changedFiles"][number] {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    isBinary: false,
    isExecutable: false,
  };
}

test("parseSemgrepJson maps semgrep results into advisory findings", () => {
  const findings = parseSemgrepJson(JSON.stringify({
    results: [
      {
        check_id: "typescript.lang.security.audit.detect-eval-with-expression",
        path: "src/a.ts",
        start: { line: 12 },
        extra: {
          severity: "ERROR",
          message: "Detected eval with a non-literal argument.",
          metadata: { cwe: ["CWE-95"] },
        },
      },
    ],
  }));

  expect(findings).toEqual([
    expect.objectContaining({
      scanner: "semgrep",
      ruleId: "typescript.lang.security.audit.detect-eval-with-expression",
      severity: "error",
      path: "src/a.ts",
      line: 12,
      message: "Detected eval with a non-literal argument.",
    }),
  ]);
});

test("runSastAdvisory returns skipped when disabled", async () => {
  const workspaceDir = tempDir("safe-apply-sast-disabled-");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src/a.ts"), "eval(input)\n", "utf8");

  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: diffArtifact(workspaceDir),
    config: { enabled: false },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("skipped");
  expect(result.reason).toBe("not_configured");
  expect(result.findings).toEqual([]);
});

test("runSastAdvisory runs a configured semgrep-compatible command over scannable files", async () => {
  const workspaceDir = tempDir("safe-apply-sast-run-");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src/a.ts"), "eval(input)\n", "utf8");

  const script = [
    "console.log(JSON.stringify({",
    "results: [{",
    "check_id: 'rule.eval',",
    "path: 'src/a.ts',",
    "start: { line: 1 },",
    "extra: { severity: 'WARNING', message: 'eval call', metadata: {} }",
    "}]",
    "}));",
  ].join("");

  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: diffArtifact(workspaceDir),
    config: {
      enabled: true,
      command: process.execPath,
      args: ["-e", script],
      timeoutMs: 5_000,
    },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("findings");
  expect(result.command?.slice(0, 3)).toEqual([process.execPath, "-e", script]);
  const delimiterIndex = result.command?.lastIndexOf("--") ?? -1;
  expect(delimiterIndex).toBeGreaterThan(2);
  expect(result.command?.[delimiterIndex + 1]).toBe("src/a.ts");
  expect(result.command).toContain("src/a.ts");
  expect(result.command).not.toContain("src/old.ts");
  expect(result.findings).toEqual([
    expect.objectContaining({
      ruleId: "rule.eval",
      severity: "warning",
      path: "src/a.ts",
      line: 1,
    }),
  ]);
});

test("runSastAdvisory separates scanner args from flag-like file names", async () => {
  const workspaceDir = tempDir("safe-apply-sast-flag-like-path-");
  writeFileSync(join(workspaceDir, "--config=empty.yml"), "eval(input)\n", "utf8");

  const script = [
    "console.log(JSON.stringify({",
    "results: [{",
    "check_id: 'rule.flag-like-path',",
    "path: '--config=empty.yml',",
    "start: { line: 1 },",
    "extra: { severity: 'ERROR', message: 'flag-like path scanned', metadata: {} }",
    "}]",
    "}));",
  ].join("");
  const artifact = diffArtifact(workspaceDir);
  artifact.changedFiles = [changedFile("--config=empty.yml")];

  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: artifact,
    config: {
      enabled: true,
      command: process.execPath,
      args: ["-e", script],
      timeoutMs: 5_000,
    },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("findings");
  const delimiterIndex = result.command?.lastIndexOf("--") ?? -1;
  expect(delimiterIndex).toBeGreaterThan(2);
  expect(result.command?.[delimiterIndex + 1]).toBe("--config=empty.yml");
});

test("runSastAdvisory refuses diff paths that resolve outside the workspace", async () => {
  const parentDir = tempDir("safe-apply-sast-path-traversal-");
  const workspaceDir = join(parentDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(parentDir, "outside.ts"), "eval(input)\n", "utf8");
  const artifact = diffArtifact(workspaceDir);
  artifact.changedFiles = [changedFile("../outside.ts")];

  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: artifact,
    config: {
      enabled: true,
      command: process.execPath,
      args: ["-e", "throw new Error('scanner should not run for escaped paths')"],
      timeoutMs: 5_000,
    },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("skipped");
  expect(result.reason).toBe("no_scannable_files");
  expect(result.command).not.toContain("../outside.ts");
});

test("runSastAdvisory returns error when enabled scanner exits non-zero", async () => {
  const workspaceDir = tempDir("safe-apply-sast-error-");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src/a.ts"), "eval(input)\n", "utf8");

  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: diffArtifact(workspaceDir),
    config: {
      enabled: true,
      command: process.execPath,
      args: ["-e", "console.error('scanner failed'); process.exit(3);"],
      timeoutMs: 5_000,
    },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("error");
  expect(result.reason).toContain("scanner failed");
  expect(result.findings).toEqual([]);
});

test("runSastAdvisory times out scanners that ignore SIGTERM", async () => {
  const workspaceDir = tempDir("safe-apply-sast-timeout-");
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src/a.ts"), "eval(input)\n", "utf8");

  const startedMs = Date.now();
  const result = await runSastAdvisory({
    workspaceDir,
    diffArtifact: diffArtifact(workspaceDir),
    config: {
      enabled: true,
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      timeoutMs: 50,
    },
    now: () => new Date("2026-05-14T00:00:00.000Z"),
  });

  expect(result.status).toBe("timed_out");
  expect(result.reason).toContain("timed out");
  expect(Date.now() - startedMs).toBeLessThan(2_000);
});
