/**
 * Runtime-neutral HTTP handler for the production web server.
 *
 * Pure Web-platform APIs (Request/Response/Headers/URL/fetch) + node:fs/zlib/
 * crypto only — runs identically on Bun and stock Node. The runtime-specific
 * server bootstrap (Bun.serve vs node:http) and WebSocket proxy live in
 * serve-prod.ts; this module is the shared, unit-testable request handler.
 *
 * See docs/plans/2026-06-02-runtime-portability.md (serve-prod Node path).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { createHmac } from "node:crypto";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";

export interface ServeConfig {
  /** Backend API origin, e.g. http://127.0.0.1:3700 */
  apiTarget: string;
  /** Absolute path to the built dist/ directory. */
  distDir: string;
  /** Basic-auth user (default "admin"). */
  authUser: string;
  /** Basic-auth password; empty string disables auth entirely. */
  authPass: string;
  /** API bearer token injected server-side into backend requests. Empty = none. */
  apiToken: string;
}

const AUTH_COOKIE_NAME = "magister_auth";
const LEGACY_AUTH_COOKIE_NAME = "ucm_auth";

const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function pickEncoding(accept: string | null, ext: string): "br" | "gzip" | null {
  if (!accept || !COMPRESSIBLE_EXTS.has(ext)) return null;
  if (/\bbr\b/.test(accept)) return "br";
  if (/\bgzip\b/.test(accept)) return "gzip";
  return null;
}

const signCookie = (pass: string) =>
  createHmac("sha256", pass).update("magister_auth").digest("hex").slice(0, 16);
const signLegacyCookie = (pass: string) =>
  createHmac("sha256", pass).update("ucm_auth").digest("hex").slice(0, 16);
const deepLinkToken = (pass: string) =>
  createHmac("sha256", pass).update("magister_card_link").digest("hex").slice(0, 24);
const legacyDeepLinkToken = (pass: string) =>
  createHmac("sha256", pass).update("ucm_card_link").digest("hex").slice(0, 24);

/** True for a `/api/ws` WebSocket upgrade request (handled by the runtime shim). */
export function isWebSocketUpgrade(req: Request): boolean {
  return new URL(req.url).pathname === "/api/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Auth gate (shared by the HTTP handler and the WS-upgrade shims). Returns a
 * Response to short-circuit (401 / 302-deeplink) or null when authorised.
 */
export function checkAuth(req: Request, cfg: ServeConfig): Response | null {
  const { authUser, authPass } = cfg;
  if (!authPass) return null;
  // Strip the deep-link ?k= token FIRST so it never survives past the gate.
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("k");
  if (tokenParam && (tokenParam === deepLinkToken(authPass) || tokenParam === legacyDeepLinkToken(authPass))) {
    url.searchParams.delete("k");
    const cleanUrl = url.pathname + (url.search || "") + url.hash;
    return new Response(null, {
      status: 302,
      headers: new Headers({
        Location: cleanUrl,
        "Set-Cookie": `${AUTH_COOKIE_NAME}=${signCookie(authPass)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      }),
    });
  }
  const cookies = req.headers.get("cookie") ?? "";
  if (
    cookies.includes(`${AUTH_COOKIE_NAME}=${signCookie(authPass)}`) ||
    cookies.includes(`${LEGACY_AUTH_COOKIE_NAME}=${signLegacyCookie(authPass)}`)
  ) {
    return null;
  }
  const expected = "Basic " + Buffer.from(`${authUser}:${authPass}`).toString("base64");
  if (req.headers.get("authorization") === expected) return null;
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Magister"' },
  });
}

function needsAuthCookie(req: Request, cfg: ServeConfig): boolean {
  if (!cfg.authPass) return false;
  const cookies = req.headers.get("cookie") ?? "";
  return !cookies.includes(`${AUTH_COOKIE_NAME}=${signCookie(cfg.authPass)}`) && !!req.headers.get("authorization");
}

function withAuthCookie(res: Response, cfg: ServeConfig): Response {
  const headers = new Headers(res.headers);
  headers.set(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${signCookie(cfg.authPass)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Build the shared request handler. The returned function takes a Web `Request`
 * and resolves to a Web `Response`; both runtimes adapt their native server to
 * this shape.
 */
export function createHttpHandler(cfg: ServeConfig): (req: Request) => Promise<Response> {
  const { apiTarget, distDir } = cfg;

  // Per-asset compression cache (immutable hashed bundles → compress once).
  const compressionCache = new Map<string, { gzip: Buffer; br: Buffer }>();
  function getCompressed(filePath: string, raw: Buffer): { gzip: Buffer; br: Buffer } {
    let entry = compressionCache.get(filePath);
    if (!entry) {
      entry = {
        gzip: gzipSync(raw, { level: 6 }),
        br: brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
      };
      compressionCache.set(filePath, entry);
    }
    return entry;
  }

  async function proxyApi(req: Request, url: URL, setCookie: boolean): Promise<Response> {
    const backendPath = url.pathname.replace(/^\/api/, "") + url.search;
    const isStream = url.pathname.match(/\/tasks\/[^/]+\/stream$/);
    try {
      const outHeaders = new Headers(req.headers);
      if (cfg.apiToken) outHeaders.set("authorization", `Bearer ${cfg.apiToken}`);
      const backendResp = await fetch(`${apiTarget}${backendPath}`, {
        method: req.method,
        headers: outHeaders,
        body: req.method !== "GET" && req.method !== "HEAD" ? (req.body ?? null) : null,
        // Node's undici requires duplex for a streaming request body.
        ...(req.body ? { duplex: "half" } : {}),
      } as RequestInit);

      const respHeaders = new Headers(backendResp.headers);
      if (isStream) {
        respHeaders.set("cache-control", "no-cache, no-transform");
        respHeaders.set("x-accel-buffering", "no");
        respHeaders.set("content-encoding", "identity");
        respHeaders.delete("content-length");
        const res = new Response(backendResp.body, { status: backendResp.status, headers: respHeaders });
        return setCookie ? withAuthCookie(res, cfg) : res;
      }

      const ct = backendResp.headers.get("content-type") ?? "";
      const alreadyEncoded = !!backendResp.headers.get("content-encoding");
      const compressible = !alreadyEncoded && /\b(?:json|javascript|text)\b/.test(ct);
      const encoding = compressible ? pickEncoding(req.headers.get("accept-encoding"), ".json") : null;
      if (encoding) {
        const buf = Buffer.from(await backendResp.arrayBuffer());
        const out =
          encoding === "br"
            ? brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
            : gzipSync(buf, { level: 6 });
        respHeaders.set("content-encoding", encoding);
        respHeaders.set("content-length", String(out.length));
        respHeaders.set("vary", "accept-encoding");
        const res = new Response(out as unknown as BodyInit, { status: backendResp.status, headers: respHeaders });
        return setCookie ? withAuthCookie(res, cfg) : res;
      }

      // `fetch` already decoded any content-encoding into `backendResp.body`,
      // so forwarding the backend's content-encoding/content-length would be a
      // lie (Node would truncate / the browser would fail to decode). Drop
      // them and let the transport frame the decoded bytes.
      respHeaders.delete("content-encoding");
      respHeaders.delete("content-length");
      const res = new Response(backendResp.body, { status: backendResp.status, headers: respHeaders });
      return setCookie ? withAuthCookie(res, cfg) : res;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Backend unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  function serveStatic(req: Request, url: URL, setCookie: boolean): Response {
    let filePath = join(distDir, url.pathname);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(distDir + "/") && resolved !== distDir) {
      filePath = join(distDir, "index.html"); // path traversal → SPA index
    } else if (url.pathname === "/" || !existsSync(filePath)) {
      filePath = join(distDir, "index.html"); // SPA fallback
    }
    try {
      const ext = extname(filePath);
      const encoding = pickEncoding(req.headers.get("accept-encoding"), ext);
      const headers: Record<string, string> = {
        "content-type": MIME_TYPES[ext] || "application/octet-stream",
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
        vary: "accept-encoding",
      };
      const raw = readFileSync(filePath);
      let body: BodyInit;
      if (encoding) {
        const compressed = getCompressed(filePath, raw);
        const bytes = encoding === "br" ? compressed.br : compressed.gzip;
        body = bytes as unknown as BodyInit;
        headers["content-encoding"] = encoding;
        headers["content-length"] = String(bytes.length);
      } else {
        body = raw as unknown as BodyInit;
      }
      const res = new Response(body, { headers });
      return setCookie ? withAuthCookie(res, cfg) : res;
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const authResponse = checkAuth(req, cfg);
    if (authResponse) return authResponse;
    const setCookie = needsAuthCookie(req, cfg);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api")) return proxyApi(req, url, setCookie);
    return serveStatic(req, url, setCookie);
  };
}

/** Derive the Feishu deep-link token from a password (empty if no auth). */
export function deriveDeepLinkToken(authPass: string): string {
  return authPass ? createHmac("sha256", authPass).update("magister_card_link").digest("hex").slice(0, 24) : "";
}
