const warnedLegacyEnvPairs = new Set<string>();

type WarnFn = (message: string) => void;

export function getMagisterEnv(
  newName: `MAGISTER_${string}`,
  env: NodeJS.ProcessEnv = process.env,
  warn: WarnFn = (message) => console.warn(message),
  legacyName: string = newName.replace(/^MAGISTER_/, "UCM_"),
): string | undefined {
  const newVal = env[newName];
  if (newVal !== undefined) return newVal;

  // Deprecated-prefix fallbacks, checked in order: the explicit legacyName
  // (default `UCM_*`) then the `ULTIMATE_*` prefix. Lets existing .env files
  // on the old prefixes keep working, with a one-time deprecation warning.
  for (const legacy of [legacyName, newName.replace(/^MAGISTER_/, "ULTIMATE_")]) {
    const legacyVal = env[legacy];
    if (legacyVal !== undefined) {
      warnOnceLegacyEnv(legacy, newName, warn);
      return legacyVal;
    }
  }
  return undefined;
}

function warnOnceLegacyEnv(
  legacyName: string,
  newName: string,
  warn: WarnFn,
): void {
  const key = `${legacyName}->${newName}`;
  if (warnedLegacyEnvPairs.has(key)) return;
  warnedLegacyEnvPairs.add(key);
  warn(`[env] ${legacyName} is deprecated; use ${newName} instead.`);
}

export function _resetLegacyEnvWarningsForTest(): void {
  warnedLegacyEnvPairs.clear();
}
