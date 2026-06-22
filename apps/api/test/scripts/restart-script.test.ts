import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const script = readFileSync(join(process.cwd(), "scripts/restart.sh"), "utf-8");

test("restart script starts services in an independent session", () => {
  expect(script).toContain("setsid");
  expect(script).toContain("API_PID=$!");
  expect(script).toContain("WEB_PID=$!");
});

test("restart script can recover when pid files are stale", () => {
  expect(script).toContain("stop_port_owner");
  expect(script).toContain("3700");
  expect(script).toContain("3701");
});

test("restart dry run maps PORT to API_PORT and exports the web proxy target", () => {
  const result = spawnSync("bash", ["scripts/restart.sh"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MAGISTER_RESTART_DRY_RUN: "1",
      PORT: "3010",
      WEB_PORT: "4174",
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("API_PORT=3010");
  expect(result.stdout).toContain("PORT=3010");
  expect(result.stdout).toContain("WEB_PORT=4174");
  expect(result.stdout).toContain("MAGISTER_API_TARGET=http://127.0.0.1:3010");
  expect(result.stdout).toContain(`MAGISTER_INSTALL_DIR=${process.cwd()}`);
});

test("restart-profile loads a profile env file and keeps profile state explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "magister-profile-test-"));
  const envFile = join(dir, ".env.dev");
  writeFileSync(envFile, [
    "PORT=3010",
    "WEB_PORT=4174",
    "MAGISTER_DISABLE_CHANNELS=1",
    "",
  ].join("\n"));

  try {
    const result = spawnSync("bash", ["scripts/restart-profile.sh", "dev"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        MAGISTER_RESTART_DRY_RUN: "1",
        MAGISTER_PROFILE_ENV_FILE: envFile,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MAGISTER_RUNTIME_PROFILE=dev");
    expect(result.stdout).toContain("API_PORT=3010");
    expect(result.stdout).toContain("WEB_PORT=4174");
    expect(result.stdout).toContain("MAGISTER_DISABLE_CHANNELS=1");
    expect(result.stdout).toContain("MAGISTER_API_TARGET=http://127.0.0.1:3010");
    expect(result.stdout).toContain(`MAGISTER_INSTALL_DIR=${process.cwd()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
