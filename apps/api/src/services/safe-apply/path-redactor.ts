/**
 * Sandbox-elevation v4.3 spec acceptance #22 — $HOME redaction for
 * operator-facing log + telemetry output.
 *
 * Use this anywhere a path lands in a non-UI sink (execution events,
 * audit logs, operator trace panel). The UI keeps full paths so the
 * user can make informed approval decisions; only telemetry that
 * could expose username to operator-shared logs gets the redaction.
 *
 * Rules:
 *   /home/alice/.cache/uv → ~/.cache/uv  (when HOME=/home/alice)
 *   /home/alice           → ~
 *   /root/.cache/uv       → ~/.cache/uv  (when HOME=/root)
 *   /etc/shadow           → /etc/shadow  (unchanged — not under HOME)
 *   relative paths        → unchanged (already lack the username)
 *   undefined / null      → "" empty string
 *
 * Idempotent: redact(redact(x)) === redact(x).
 */
import { homedir } from "node:os";

let cachedHome: string | null = null;

function getHome(): string {
  if (cachedHome === null) cachedHome = homedir();
  return cachedHome;
}

export function redactHomePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const home = getHome();
  if (!home || home === "/") return path;
  // Exact match: /home/alice → ~
  if (path === home) return "~";
  // Prefix match: /home/alice/* → ~/...
  const prefix = home.endsWith("/") ? home : `${home}/`;
  if (path.startsWith(prefix)) {
    return "~/" + path.slice(prefix.length);
  }
  return path;
}

/**
 * Redact an array of {path, ...} entries — keeps all other fields,
 * replaces `path` with the redacted form. Used for binds-source
 * breakdown in `leader.bash_dispatch` telemetry events.
 */
export function redactPathEntries<T extends { path: string }>(entries: T[]): T[] {
  return entries.map((e) => ({ ...e, path: redactHomePath(e.path) }));
}

/**
 * Test-only: override the cached home dir. Production code uses the
 * OS resolver; tests need a stable value regardless of where they run.
 */
export function __setHomeForTests(home: string | null): void {
  cachedHome = home;
}
