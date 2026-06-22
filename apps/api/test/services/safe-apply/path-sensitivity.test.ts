/**
 * Sandbox-elevation v4.3 §4.7 — path sensitivity classifier tests.
 *
 * All inputs are canonical absolute paths. The classifier rejects non-
 * canonical input loudly (no `..`, no `~`, no `.`).
 */
import { expect, test, describe } from "bun:test";

import {
  classifyPathSensitivity,
  isCriticallyDenied,
} from "../../../src/services/safe-apply/path-sensitivity";

const HOME = "/home/alice";
const MAGISTER = "/opt/magister-install";
const WORKSPACE = "/home/alice/workspace/repo";
const opts = { homeDir: HOME, magisterInstallDir: MAGISTER, workspaceRoot: WORKSPACE };

describe("critical — system credential files", () => {
  test.each([
    ["/etc/shadow", "read"],
    ["/etc/shadow", "write"],
    ["/etc/sudoers", "read"],
    ["/etc/sudoers", "write"],
    ["/etc/passwd", "write"],
    ["/etc/sudoers.d/wheel", "read"],
    ["/etc/sudoers.d/wheel", "write"],
    ["/etc/ssh/sshd_config", "read"],
    ["/etc/ssh/ssh_host_rsa_key", "read"],
  ] as const)("%s (%s) → critical", (path, access) => {
    expect(classifyPathSensitivity(path, access, opts).level).toBe("critical");
  });
});

describe("critical — direct memory / disk", () => {
  test.each([
    "/dev/sda",
    "/dev/sda1",
    "/dev/nvme0n1",
    "/dev/nvme0n1p1",
    "/dev/vda",
    "/dev/mmcblk0",
    "/dev/disk/by-uuid/xxx",
    "/proc/1234/mem",
  ])("%s (write) → critical", (path) => {
    expect(classifyPathSensitivity(path, "write", opts).level).toBe("critical");
  });

  test("/dev/null write is NOT critical (commonly used for output redirection)", () => {
    expect(classifyPathSensitivity("/dev/null", "write", opts).level).not.toBe("critical");
  });
});

describe("critical — SSH key tamper", () => {
  test.each([
    [`${HOME}/.ssh/authorized_keys`, "write"],
    [`${HOME}/.ssh/id_ed25519.pub`, "write"],
    [`${HOME}/.ssh/id_rsa`, "write"],
    [`${HOME}/.ssh/config`, "write"],
    [`${HOME}/.ssh/known_hosts`, "write"],
  ] as const)("%s (%s) → critical", (path, access) => {
    expect(classifyPathSensitivity(path, access, opts).level).toBe("critical");
  });
});

describe("critical — /etc write", () => {
  test.each([
    "/etc/nginx/sites-enabled/default",
    "/etc/systemd/system/foo.service",
    "/etc/cron.d/job",
  ])("%s (write) → critical", (path) => {
    expect(classifyPathSensitivity(path, "write", opts).level).toBe("critical");
  });

  test("/etc/resolv.conf write IS allowed (our DNS bind needs it as RO target)", () => {
    expect(classifyPathSensitivity("/etc/resolv.conf", "write", opts).level).not.toBe("critical");
  });

  test("/etc/* read = NOT critical (we allow reading /etc/gitconfig etc.)", () => {
    expect(classifyPathSensitivity("/etc/nginx/nginx.conf", "read", opts).level).not.toBe("critical");
  });
});

describe("critical — Magister own secrets + runtime", () => {
  test(`${MAGISTER}/config/secrets.json (any access) → critical`, () => {
    expect(classifyPathSensitivity(`${MAGISTER}/config/secrets.json`, "read", opts).level).toBe("critical");
    expect(classifyPathSensitivity(`${MAGISTER}/config/secrets.json`, "write", opts).level).toBe("critical");
  });

  test(`${MAGISTER}/.magister/runtime-workspaces/* (write) → critical`, () => {
    expect(classifyPathSensitivity(`${MAGISTER}/.magister/foo`, "write", opts).level).toBe("critical");
    expect(classifyPathSensitivity(`${MAGISTER}/.ultimate/bar`, "write", opts).level).toBe("critical");
  });
});

describe("critical — workspace .env write (injection surface)", () => {
  test(`${WORKSPACE}/.env (write) → critical`, () => {
    expect(classifyPathSensitivity(`${WORKSPACE}/.env`, "write", opts).level).toBe("critical");
  });
  test(`${WORKSPACE}/.env.production (write) → critical`, () => {
    expect(classifyPathSensitivity(`${WORKSPACE}/.env.production`, "write", opts).level).toBe("critical");
  });
  test(`${WORKSPACE}/sub/.env (write) → critical`, () => {
    expect(classifyPathSensitivity(`${WORKSPACE}/sub/.env`, "write", opts).level).toBe("critical");
  });
});

describe("caution — workspace .env read (leak surface)", () => {
  test(`${WORKSPACE}/.env (read) → caution`, () => {
    expect(classifyPathSensitivity(`${WORKSPACE}/.env`, "read", opts).level).toBe("caution");
  });
});

describe("caution — SSH read (keys / config / known_hosts)", () => {
  test.each([
    `${HOME}/.ssh/id_ed25519`,
    `${HOME}/.ssh/id_rsa`,
    `${HOME}/.ssh/config`,
    `${HOME}/.ssh/known_hosts`,
  ])("%s (read) → caution", (path) => {
    expect(classifyPathSensitivity(path, "read", opts).level).toBe("caution");
  });
});

describe("caution — cloud credentials", () => {
  test.each([
    [`${HOME}/.aws/credentials`, "read"],
    [`${HOME}/.aws/config`, "read"],
    [`${HOME}/.config/gcloud/application_default_credentials.json`, "read"],
    [`${HOME}/.config/gcloud/credentials.db`, "write"],
    [`${HOME}/.azure/credentials`, "read"],
    [`${HOME}/.kube/config`, "read"],
    [`${HOME}/.docker/config.json`, "read"],
  ] as const)("%s (%s) → caution", (path, access) => {
    expect(classifyPathSensitivity(path, access, opts).level).toBe("caution");
  });
});

describe("caution — package manager auth + GPG + shell history", () => {
  test.each([
    [`${HOME}/.npmrc`, "read"],
    [`${HOME}/.pnpmrc`, "read"],
    [`${HOME}/.yarnrc.yml`, "read"],
    [`${HOME}/.pypirc`, "read"],
    [`${HOME}/.config/pip/pip.conf`, "read"],
    [`${HOME}/.gnupg/secring.gpg`, "read"],
    [`${HOME}/.gnupg/pubring.kbx`, "write"],
    [`${HOME}/.bash_history`, "read"],
    [`${HOME}/.zsh_history`, "read"],
    [`${HOME}/.python_history`, "read"],
    [`${HOME}/.netrc`, "read"],
    [`${HOME}/.git-credentials`, "read"],
    [`${HOME}/.config/gh/hosts.yml`, "read"],
  ] as const)("%s (%s) → caution", (path, access) => {
    expect(classifyPathSensitivity(path, access, opts).level).toBe("caution");
  });
});

describe("caution — $PATH supply-chain vectors (binaries on PATH)", () => {
  test.each([
    `${HOME}/.cargo/bin/cargo`,
    `${HOME}/.local/bin/mybin`,
    `${HOME}/.npm-global/bin/foo`,
    `${HOME}/.yarn/bin/yarn`,
    `${HOME}/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc`,
  ])("%s (write) → caution (PATH supply-chain)", (path) => {
    expect(classifyPathSensitivity(path, "write", opts).level).toBe("caution");
  });

  test(`${HOME}/.cargo/bin/cargo (READ) → not flagged as PATH supply-chain (read is fine)`, () => {
    // Read is OK — the supply-chain risk is from writing executables
    expect(classifyPathSensitivity(`${HOME}/.cargo/bin/cargo`, "read", opts).level).not.toBe("critical");
  });
});

describe("caution — generic catch-all (credential-shaped filenames)", () => {
  test.each([
    "/srv/app/private.pem",
    "/etc/myservice/api.key",
    "/opt/cert/server.p12",
    "/home/alice/.local/share/random-credentials-file",
    "/home/alice/Documents/aws-secret-backup",
  ])("%s (read) → caution (credential-shaped name)", (path) => {
    expect(classifyPathSensitivity(path, "read", opts).level).toBe("caution");
  });
});

describe("safe — narrow build caches + tmp", () => {
  test.each([
    `${HOME}/.cache/uv`,
    `${HOME}/.cache/uv/something`,
    `${HOME}/.cache/pip/wheels`,
    `${HOME}/.cache/pnpm/store`,
    `${HOME}/.cache/yarn/v6`,
    `${HOME}/.cache/go-build/abc`,
    `${HOME}/.npm/_cacache/index`,
    `${HOME}/.cargo/registry/cache`,
    `${HOME}/.cargo/git/checkouts`,
    `${HOME}/.local/share/uv/python`,
    `${HOME}/.rustup/downloads/foo`,
    "/var/tmp/buildlog",
    "/tmp/random-file",
  ])("%s (write) → safe", (path) => {
    expect(classifyPathSensitivity(path, "write", opts).level).toBe("safe");
  });

  test(`${HOME}/.gitconfig (read) → safe`, () => {
    expect(classifyPathSensitivity(`${HOME}/.gitconfig`, "read", opts).level).toBe("safe");
  });
  test("/etc/gitconfig (read) → safe", () => {
    expect(classifyPathSensitivity("/etc/gitconfig", "read", opts).level).toBe("safe");
  });
});

describe("safe — `~/.cargo/bin` is NOT safe even though `~/.cargo/registry` is", () => {
  // Regression for codex review item 7 (v4.1): keep cargo bin distinct
  // from registry so PATH supply-chain stays caution.
  test(`${HOME}/.cargo/bin/myattacker (write) is caution, not safe`, () => {
    const result = classifyPathSensitivity(`${HOME}/.cargo/bin/myattacker`, "write", opts);
    expect(result.level).toBe("caution");
  });
  test(`${HOME}/.cargo/registry/cache (write) is safe`, () => {
    const result = classifyPathSensitivity(`${HOME}/.cargo/registry/cache`, "write", opts);
    expect(result.level).toBe("safe");
  });
});

describe("default — unknown paths default to caution (user must explicitly approve)", () => {
  test(`${HOME}/Documents/random-doc.txt → caution`, () => {
    expect(classifyPathSensitivity(`${HOME}/Documents/random-doc.txt`, "read", opts).level).toBe("caution");
  });
  test("/srv/app/data.json → caution", () => {
    expect(classifyPathSensitivity("/srv/app/data.json", "write", opts).level).toBe("caution");
  });
});

describe("prefix matching — `.ssh-backup` does NOT match `.ssh` prefix", () => {
  test(`${HOME}/.ssh-backup/notes (read) → caution (default), not critical`, () => {
    // Critical SSH-key rules must NOT eat ~/.ssh-backup or ~/.sshfoo
    expect(classifyPathSensitivity(`${HOME}/.ssh-backup/notes`, "read", opts).level).not.toBe("critical");
  });
  // Codex A.1 review LOW #2: lock the boundary against future
  // regressions — these adversarial siblings must NOT match `.ssh`.
  test.each([
    `${HOME}/.ssh-keys/notes`,
    `${HOME}/.ssh_old/notes`,
    `${HOME}/.ssh.tmp/notes`,
    `${HOME}/.sshfoo/notes`,
  ])("%s (read) → caution (NOT critical)", (path) => {
    expect(classifyPathSensitivity(path, "read", opts).level).not.toBe("critical");
  });
});

describe("/etc/passwd vs /etc/shadow access semantics (codex A.1 review MEDIUM #1)", () => {
  test("/etc/passwd READ → caution (publicly readable on Linux; only write is critical)", () => {
    expect(classifyPathSensitivity("/etc/passwd", "read", opts).level).not.toBe("critical");
  });
  test("/etc/passwd WRITE → critical (account injection surface)", () => {
    expect(classifyPathSensitivity("/etc/passwd", "write", opts).level).toBe("critical");
  });
  test("/etc/shadow READ → critical (hash exposure)", () => {
    expect(classifyPathSensitivity("/etc/shadow", "read", opts).level).toBe("critical");
  });
});

describe("catch-all credential pattern precedence (codex A.1 review MEDIUM #5)", () => {
  // Catch-all must run BEFORE safe rules so credential-shaped files
  // inside otherwise-safe parents still flag as caution.
  test("/tmp/private.pem (write) → caution, not safe", () => {
    expect(classifyPathSensitivity("/tmp/private.pem", "write", opts).level).toBe("caution");
  });
  test(`${HOME}/.cache/uv/aws-secret (write) → caution, not safe`, () => {
    expect(classifyPathSensitivity(`${HOME}/.cache/uv/aws-secret`, "write", opts).level).toBe("caution");
  });
  test(`${HOME}/.cache/uv/some.key (write) → caution, not safe`, () => {
    expect(classifyPathSensitivity(`${HOME}/.cache/uv/some.key`, "write", opts).level).toBe("caution");
  });
});

describe("Magister-install protection requires explicit magisterInstallDir (codex HIGH #3)", () => {
  test(`${MAGISTER}/config/secrets.json (read) WITH magisterInstallDir → critical`, () => {
    expect(classifyPathSensitivity(`${MAGISTER}/config/secrets.json`, "read", opts).level).toBe("critical");
  });
  test("when magisterInstallDir is undefined, secrets.json under cwd is NOT auto-classified critical", () => {
    // No fallback to process.cwd() — Magister protection is OFF if caller didn't pass.
    const noMagisterOpts = { homeDir: HOME };
    expect(classifyPathSensitivity(`${MAGISTER}/config/secrets.json`, "read", noMagisterOpts).level)
      .not.toBe("critical");
  });
});

describe("workspace .env protection requires explicit workspaceRoot", () => {
  test(`${WORKSPACE}/.env (write) WITH workspaceRoot → critical`, () => {
    expect(classifyPathSensitivity(`${WORKSPACE}/.env`, "write", opts).level).toBe("critical");
  });
  test("when workspaceRoot is undefined, .env write falls back to caution catch-all (still surfaces but not blocked)", () => {
    const noWsOpts = { homeDir: HOME, magisterInstallDir: MAGISTER };
    // No workspace context → .env is not specifically critical, but the catch-all DOES still flag it.
    // (Filename catch-all checks *secret*, *.pem, *.key, etc. — `.env` doesn't match those patterns.)
    // So in the absence of workspaceRoot, .env falls through to default caution. Verify behavior:
    const result = classifyPathSensitivity(`${WORKSPACE}/.env`, "write", noWsOpts);
    expect(result.level).not.toBe("critical");
    expect(result.level).toBe("caution");  // default for user-home / unknown
  });
});

describe("input validation — reject non-canonical / non-absolute", () => {
  test("relative path throws", () => {
    expect(() => classifyPathSensitivity("./foo", "read", opts)).toThrow(/absolute/);
  });
  test("path with `..` throws", () => {
    expect(() => classifyPathSensitivity("/foo/../bar", "read", opts)).toThrow(/canonical/);
  });
  test("path with `~` throws", () => {
    expect(() => classifyPathSensitivity("~/foo", "read", opts)).toThrow();
  });
  test("path with `/./` throws", () => {
    expect(() => classifyPathSensitivity("/foo/./bar", "read", opts)).toThrow(/canonical/);
  });
  test("empty string throws", () => {
    expect(() => classifyPathSensitivity("", "read", opts)).toThrow();
  });
});

describe("isCriticallyDenied helper", () => {
  test("critical paths are denied", () => {
    expect(isCriticallyDenied("/etc/shadow", "read", opts)).toBe(true);
    expect(isCriticallyDenied(`${HOME}/.ssh/authorized_keys`, "write", opts)).toBe(true);
  });
  test("caution paths are NOT denied at validation (only flagged in UI)", () => {
    expect(isCriticallyDenied(`${HOME}/.aws/credentials`, "read", opts)).toBe(false);
    expect(isCriticallyDenied(`${HOME}/.cargo/bin/cargo`, "write", opts)).toBe(false);
  });
  test("safe paths are NOT denied", () => {
    expect(isCriticallyDenied(`${HOME}/.cache/uv/index`, "write", opts)).toBe(false);
  });
});
