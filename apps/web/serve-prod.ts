/**
 * Production static server for the web frontend — Bun-first, Node-capable.
 *
 * Serves the built dist/ directory with API + WebSocket proxying. The request
 * handling lives in serve-prod-handler.ts (runtime-neutral, unit-tested); this
 * file is the runtime bootstrap: Bun.serve on Bun, node:http + `ws` on Node.
 * No HMR, no auto-refresh.
 *
 * See docs/plans/2026-06-02-runtime-portability.md.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  createHttpHandler,
  checkAuth,
  isWebSocketUpgrade,
  deriveDeepLinkToken,
  type ServeConfig,
} from "./serve-prod-handler";
import { isLocalWebHost, resolveWebHost } from "./src/lib/webHost";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

// Load .env from project root (don't override already-set env).
const envPath = resolve(here, "../../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const PORT = Number(process.env.WEB_PORT ?? 3701);
const HOST = resolveWebHost(process.env);
const cfg: ServeConfig = {
  apiTarget: process.env.MAGISTER_API_TARGET ?? "http://127.0.0.1:3700",
  distDir: resolve(here, "dist"),
  authUser: process.env.MAGISTER_WEB_AUTH_USER ?? "admin",
  authPass: process.env.MAGISTER_WEB_AUTH_PASS ?? "",
  apiToken: process.env.MAGISTER_API_TOKEN ?? "",
};
const BACKEND_WS_URL = cfg.apiTarget.replace(/^http/, "ws") + "/ws";

const handler = createHttpHandler(cfg);

/** Feishu deep-link token (used by the outbound card service). */
export function getDeepLinkToken(): string {
  return deriveDeepLinkToken(cfg.authPass);
}

if (isBun) {
  startBunServer();
} else {
  startNodeServer();
}

console.log(`Web serving dist/ on http://${HOST}:${PORT} (API → ${cfg.apiTarget}) [${isBun ? "bun" : "node"}]`);
if (!cfg.authPass && !isLocalWebHost(HOST)) {
  console.warn(
    `⚠ Web console is bound to ${HOST} with NO auth (MAGISTER_WEB_AUTH_PASS is empty): anyone who can reach this host on :${PORT} gets full access to your agents. Set MAGISTER_WEB_AUTH_PASS before exposing it on a shared network.`,
  );
}

// ---------------------------------------------------------------------------
// Bun runtime: Bun.serve + its native WebSocket plumbing.
// ---------------------------------------------------------------------------
function startBunServer(): void {
  const BunServe = (globalThis as { Bun: { serve: (o: unknown) => unknown } }).Bun;
  BunServe.serve({
    port: PORT,
    hostname: HOST,
    // SSE streams stay open for a task's lifetime; disable Bun's 10s idle kill.
    idleTimeout: 0,
    // Match the API body limit so large uploads reach Fastify (not 413 here).
    maxRequestBodySize: 150 * 1024 * 1024,
    async fetch(req: Request, server: { upgrade: (r: Request) => boolean }) {
      if (isWebSocketUpgrade(req)) {
        const auth = checkAuth(req, cfg);
        if (auth) return auth;
        return server.upgrade(req) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return handler(req);
    },
    websocket: {
      open(ws: { send: (d: string) => void; close: () => void } & Record<string, unknown>) {
        try {
          const backend = new WebSocket(BACKEND_WS_URL);
          backend.onmessage = (e: MessageEvent) => {
            try { ws.send(String(e.data)); } catch { /* client gone */ }
          };
          backend.onclose = () => { try { ws.close(); } catch { /* already closed */ } };
          backend.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
          ws._backend = backend;
        } catch {
          ws.close();
        }
      },
      message(ws: Record<string, unknown>, message: string) {
        const backend = ws._backend as WebSocket | undefined;
        if (backend?.readyState === WebSocket.OPEN) backend.send(String(message));
      },
      close(ws: Record<string, unknown>) {
        const backend = ws._backend as WebSocket | undefined;
        if (backend) { try { backend.close(); } catch { /* already closed */ } }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Node runtime: node:http + the `ws` library (Node 20 has no global WebSocket).
// ---------------------------------------------------------------------------
function startNodeServer(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const http = require_("node:http") as typeof import("node:http");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Readable } = require_("node:stream") as typeof import("node:stream");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS = require_("ws") as typeof import("ws");

  const nodeReqToWebRequest = (nreq: import("node:http").IncomingMessage): Request => {
    const host = nreq.headers.host ?? "localhost";
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v != null) headers.set(k, String(v));
    }
    const hasBody = nreq.method !== "GET" && nreq.method !== "HEAD";
    return new Request(`http://${host}${nreq.url ?? "/"}`, {
      method: nreq.method,
      headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: hasBody ? (Readable.toWeb(nreq) as any) : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  };

  const writeWebResponse = (res: Response, nres: import("node:http").ServerResponse): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers: Record<string, string | string[]> = {};
    res.headers.forEach((value, key) => {
      // Hop-by-hop headers must not be forwarded by a proxy.
      if (key === "transfer-encoding" || key === "connection" || key === "keep-alive") return;
      headers[key] = value;
    });
    // Preserve multiple Set-Cookie values if present.
    const setCookies = res.headers.getSetCookie?.();
    if (setCookies && setCookies.length > 0) headers["set-cookie"] = setCookies;
    nres.writeHead(res.status, headers);
    if (res.body) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Readable.fromWeb(res.body as any).pipe(nres);
    } else {
      nres.end();
    }
  };

  const server = http.createServer((nreq, nres) => {
    void (async () => {
      try {
        const response = await handler(nodeReqToWebRequest(nreq));
        writeWebResponse(response, nres);
      } catch {
        if (!nres.headersSent) nres.writeHead(500, { "content-type": "text/plain" });
        nres.end("Internal Server Error");
      }
    })();
  });
  // SSE / long uploads: Node 18+ defaults requestTimeout to 5min, which would
  // sever a streaming task. Disable per-request timeouts (the backend closes
  // its side; the browser closes on navigation).
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  const wss = new WS.WebSocketServer({ noServer: true });
  server.on("upgrade", (nreq, socket, head) => {
    const req = nodeReqToWebRequest(nreq);
    if (!isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }
    if (checkAuth(req, cfg)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(nreq, socket, head, (client) => {
      let backend: import("ws").WebSocket | null = null;
      try {
        backend = new WS.WebSocket(BACKEND_WS_URL);
        backend.on("message", (d: import("ws").RawData) => {
          try { client.send(d.toString()); } catch { /* client gone */ }
        });
        backend.on("close", () => { try { client.close(); } catch { /* closed */ } });
        backend.on("error", () => { try { client.close(); } catch { /* closed */ } });
      } catch {
        client.close();
        return;
      }
      client.on("message", (d: import("ws").RawData) => {
        if (backend && backend.readyState === WS.WebSocket.OPEN) backend.send(d.toString());
      });
      client.on("close", () => { try { backend?.close(); } catch { /* closed */ } });
    });
  });

  server.listen(PORT, HOST);
}
