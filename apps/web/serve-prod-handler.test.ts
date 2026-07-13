import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpHandler, deriveDeepLinkToken, type ServeConfig } from "./serve-prod-handler";

let distDir = "";
function cfg(over: Partial<ServeConfig> = {}): ServeConfig {
  return { apiTarget: "http://127.0.0.1:1", distDir, authUser: "admin", authPass: "", apiToken: "", ...over };
}

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), "serveprod-dist-"));
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>app</title>");
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "assets", "app.js"), "console.log('x'.repeat(2000))");
});
afterEach(() => rmSync(distDir, { recursive: true, force: true }));

describe("createHttpHandler", () => {
  test("serves index.html at / when auth is disabled", async () => {
    const res = await createHttpHandler(cfg())(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toContain("<title>app</title>");
  });

  test("SPA fallback: unknown route serves index.html", async () => {
    const res = await createHttpHandler(cfg())(new Request("http://x/board/123"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  test("path traversal falls back to index.html (no file escape)", async () => {
    const res = await createHttpHandler(cfg())(new Request("http://x/../../../../etc/passwd"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  test("serves a real asset with immutable cache + correct mime", async () => {
    const res = await createHttpHandler(cfg())(new Request("http://x/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("negotiates brotli compression for a compressible asset", async () => {
    const res = await createHttpHandler(cfg())(
      new Request("http://x/assets/app.js", { headers: { "accept-encoding": "br, gzip" } }),
    );
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
  });

  test("proxyApi injects the configured API token server-side", async () => {
    const seen: { authorization?: string } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const authHeader = new Headers(init.headers).get("authorization");
      if (authHeader) seen.authorization = authHeader;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const handler = createHttpHandler(cfg({ apiToken: "tok-abc" }));
      await handler(new Request("http://localhost:3701/api/tasks"));
      expect(seen.authorization).toBe("Bearer tok-abc");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  describe("auth (authPass set)", () => {
    const pass = "s3cret";
    test("401 with WWW-Authenticate when no credentials", async () => {
      const res = await createHttpHandler(cfg({ authPass: pass }))(new Request("http://x/"));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
    });

    test("wrong basic auth → 401", async () => {
      const bad = "Basic " + Buffer.from("admin:nope").toString("base64");
      const res = await createHttpHandler(cfg({ authPass: pass }))(
        new Request("http://x/", { headers: { authorization: bad } }),
      );
      expect(res.status).toBe(401);
    });

    test("valid basic auth → 200 + sets auth cookie", async () => {
      const good = "Basic " + Buffer.from(`admin:${pass}`).toString("base64");
      const res = await createHttpHandler(cfg({ authPass: pass }))(
        new Request("http://x/", { headers: { authorization: good } }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("magister_auth=");
    });

    test("deep-link ?k=<token> → 302 with cookie and stripped token", async () => {
      const token = deriveDeepLinkToken(pass);
      const res = await createHttpHandler(cfg({ authPass: pass }))(
        new Request(`http://x/board/9?k=${token}`),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/board/9");
      expect(res.headers.get("set-cookie")).toContain("magister_auth=");
    });
  });
});
