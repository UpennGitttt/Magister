import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyUltimateDirs } from "../../src/lib/magister-migration";

const legacyDirName = "." + "ultimate";
const magisterDirName = ".magister";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "magister-migration-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("migrateLegacyUltimateDirs moves project and home legacy directories once", () => {
  const projectDir = join(tempRoot, "project");
  const homeDir = join(tempRoot, "home");
  mkdirSync(join(projectDir, legacyDirName, "uploads", "task_1"), { recursive: true });
  mkdirSync(join(homeDir, legacyDirName, "memory", "user"), { recursive: true });
  writeFileSync(join(projectDir, legacyDirName, "uploads", "task_1", "state.json"), "{\"ok\":true}\n");
  writeFileSync(join(homeDir, legacyDirName, "memory", "user", "note.md"), "remember\n");

  const info: string[] = [];
  const warn: string[] = [];
  migrateLegacyUltimateDirs({
    projectDir,
    userHomeDir: homeDir,
    logger: {
      info: (message) => info.push(message),
      warn: (message) => warn.push(message),
    },
  });

  expect(readFileSync(join(projectDir, magisterDirName, "uploads", "task_1", "state.json"), "utf8")).toBe("{\"ok\":true}\n");
  expect(readFileSync(join(homeDir, magisterDirName, "memory", "user", "note.md"), "utf8")).toBe("remember\n");
  expect(statSync(join(projectDir, legacyDirName)).isFile()).toBe(true);
  expect(statSync(join(homeDir, legacyDirName)).isFile()).toBe(true);
  expect(info).toEqual([
    `[migration] ${legacyDirName}/ → ${magisterDirName}/ (one-time)`,
    `[migration] ~/${legacyDirName}/ → ~/.magister/ (one-time)`,
  ]);
  expect(warn).toEqual([]);

  migrateLegacyUltimateDirs({
    projectDir,
    userHomeDir: homeDir,
    logger: {
      info: (message) => info.push(message),
      warn: (message) => warn.push(message),
    },
  });

  expect(info).toHaveLength(2);
  expect(readFileSync(join(projectDir, legacyDirName), "utf8")).toBe("moved to .magister/\n");
});

test("migrateLegacyUltimateDirs skips and warns when both legacy and target directories exist", () => {
  const projectDir = join(tempRoot, "project");
  mkdirSync(join(projectDir, legacyDirName), { recursive: true });
  mkdirSync(join(projectDir, magisterDirName), { recursive: true });

  const warn: string[] = [];
  migrateLegacyUltimateDirs({
    projectDir,
    logger: {
      info: () => undefined,
      warn: (message) => warn.push(message),
    },
  });

  expect(existsSync(join(projectDir, legacyDirName))).toBe(true);
  expect(warn).toEqual([
    `[migration] both ${legacyDirName}/ and ${magisterDirName}/ exist — skipping; manually consolidate.`,
  ]);
});
