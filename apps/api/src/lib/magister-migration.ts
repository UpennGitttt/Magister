import {
  existsSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type MigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export function migrateLegacyUltimateDirs(input: {
  projectDir: string;
  userHomeDir?: string;
  logger?: MigrationLogger;
}): void {
  const logger = input.logger ?? console;
  migrateLegacyUltimateDir({
    parentDir: input.projectDir,
    label: ".ultimate/", // legacy
    logger,
  });

  if (input.userHomeDir) {
    migrateLegacyUltimateDir({
      parentDir: input.userHomeDir,
      label: "~/.ultimate/", // legacy
      logger,
    });
  }
}

export function migrateLegacyUltimateDir(input: {
  parentDir: string;
  label?: string;
  logger?: MigrationLogger;
}): void {
  const logger = input.logger ?? console;
  const legacy = join(input.parentDir, ".ultimate"); // legacy
  const target = join(input.parentDir, ".magister");

  if (!existsSync(legacy)) return;
  if (!statSync(legacy).isDirectory()) return;

  if (existsSync(target)) {
    logger.warn(`[migration] both ${input.label ?? ".ultimate/"} and ${labelTarget(input.label)} exist — skipping; manually consolidate.`); // legacy
    return;
  }

  renameSync(legacy, target);
  writeFileSync(legacy, "moved to .magister/\n");
  logger.info(`[migration] ${input.label ?? ".ultimate/"} → ${labelTarget(input.label)} (one-time)`); // legacy
}

function labelTarget(label: string | undefined): string {
  return label?.startsWith("~/") ? "~/.magister/" : ".magister/";
}
