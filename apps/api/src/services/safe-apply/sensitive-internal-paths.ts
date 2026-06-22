// Shared Magister-internal path detector for bash command strings.
// This is honest-actor protection: it catches plain command text the
// model emits, not adversarial shell obfuscation.

const BASH_BOUNDARY_BEFORE = "(^|[\\s/'\"`=;|&<>()])";
const BASH_BOUNDARY_AFTER = "([\\s'\"`/;|&<>()]|$)";

const SENSITIVE_INTERNAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: ".local", pattern: new RegExp(`${BASH_BOUNDARY_BEFORE}\\.local(\\/|$|[\\s'"\`;|&<>()])`) },
  { name: ".magister", pattern: new RegExp(`${BASH_BOUNDARY_BEFORE}\\.magister(\\/|$|[\\s'"\`;|&<>()])`) },
  { name: "config/secrets.json", pattern: new RegExp(`${BASH_BOUNDARY_BEFORE}config\\/secrets\\.json${BASH_BOUNDARY_AFTER}`) },
  // Allow tracked templates; deny .env, .env.local, .env.production, etc.
  { name: ".env", pattern: new RegExp(`${BASH_BOUNDARY_BEFORE}\\.env(\\.(?!(example|template|sample|dist)([\\s'"\`/;|&<>()]|$))[^/\\s'"\`;|&<>()]+)?${BASH_BOUNDARY_AFTER}`) },
];

export function findSensitiveInternalPathMatch(command: string): string | null {
  for (const { name, pattern } of SENSITIVE_INTERNAL_PATTERNS) {
    if (pattern.test(command)) return name;
  }
  return null;
}

export function listSensitiveInternalPathMatches(command: string): string[] {
  const matches: string[] = [];
  for (const { name, pattern } of SENSITIVE_INTERNAL_PATTERNS) {
    if (pattern.test(command)) matches.push(name);
  }
  return matches;
}

export function hasSensitiveInternalPath(command: string): boolean {
  return findSensitiveInternalPathMatch(command) !== null;
}
