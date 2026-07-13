import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { getMagisterEnv } from "./env";

/** Paths reachable without auth. `/health` is a data-free liveness probe
 *  used by restart.sh; everything else requires a token when one is set. */
export const EXEMPT_PATHS: ReadonlySet<string> = new Set(["/health"]);

export function getApiToken(): string | undefined {
  const raw = getMagisterEnv("MAGISTER_API_TOKEN");
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function hasApiToken(): boolean {
  return getApiToken() !== undefined;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Fail-closed guard: refuse to bind a routable interface without a token.
 *  Called at startup before app.listen. */
export function assertBindSafe(host: string, tokenPresent: boolean): void {
  if (!tokenPresent && !isLoopbackHost(host)) {
    throw new Error(
      `[api-auth] Refusing to bind ${host} without MAGISTER_API_TOKEN. ` +
        `Binding a non-loopback interface exposes the API to the network; ` +
        `set MAGISTER_API_TOKEN, or bind 127.0.0.1 for local-only use.`,
    );
  }
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal length; length mismatch = no match.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

let warnedNoToken = false;

/** Install the API auth onRequest hook. When a token is configured, every
 *  non-exempt request must carry `Authorization: Bearer <token>`. When no
 *  token is configured, requests pass (loopback-only is enforced separately
 *  by assertBindSafe at startup) with a one-time warning. */
export function registerApiAuth(app: FastifyInstance): void {
  app.addHook("preHandler", (request, reply, done) => {
    const token = getApiToken();
    if (!token) {
      if (!warnedNoToken) {
        warnedNoToken = true;
        app.log.warn(
          "[api-auth] MAGISTER_API_TOKEN not set — API is unauthenticated " +
            "(loopback-only). Set it to require a Bearer token, incl. from localhost.",
        );
      }
      done();
      return;
    }
    const path = request.url.split("?")[0] ?? "";
    if (EXEMPT_PATHS.has(path)) {
      done();
      return;
    }

    const header = request.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokensMatch(provided, token)) {
      reply.status(401).send({ ok: false, error: { code: "unauthorized", message: "Missing or invalid API token." } });
      return;
    }
    done();
  });
}

export function _resetAuthWarningForTest(): void {
  warnedNoToken = false;
}
