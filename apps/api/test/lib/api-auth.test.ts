import { describe, expect, test, afterEach } from "bun:test";
import Fastify from "fastify";
import {
  isLoopbackHost,
  assertBindSafe,
  hasApiToken,
  getApiToken,
  registerApiAuth,
  _resetAuthWarningForTest,
} from "../../src/lib/api-auth";

const ORIG = process.env.MAGISTER_API_TOKEN;
afterEach(() => {
  if (ORIG === undefined) delete process.env.MAGISTER_API_TOKEN;
  else process.env.MAGISTER_API_TOKEN = ORIG;
});

describe("isLoopbackHost", () => {
  test("recognizes loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });
  test("rejects routable addresses", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

describe("assertBindSafe", () => {
  test("throws on non-loopback bind without token", () => {
    expect(() => assertBindSafe("0.0.0.0", false)).toThrow();
  });
  test("allows non-loopback bind WITH token", () => {
    expect(() => assertBindSafe("0.0.0.0", true)).not.toThrow();
  });
  test("allows loopback bind without token", () => {
    expect(() => assertBindSafe("127.0.0.1", false)).not.toThrow();
  });
});

describe("token accessors", () => {
  test("hasApiToken reflects env presence", () => {
    process.env.MAGISTER_API_TOKEN = "secret-123";
    expect(hasApiToken()).toBe(true);
    expect(getApiToken()).toBe("secret-123");
    delete process.env.MAGISTER_API_TOKEN;
    expect(hasApiToken()).toBe(false);
  });
  test("blank token counts as absent", () => {
    process.env.MAGISTER_API_TOKEN = "   ";
    expect(hasApiToken()).toBe(false);
  });
});

describe("registerApiAuth hook", () => {
  afterEach(() => _resetAuthWarningForTest());

  async function buildTestApp() {
    const app = Fastify();
    registerApiAuth(app);
    app.get("/health", async () => ({ ok: true }));
    app.get("/tasks", async () => ({ ok: true, data: [] }));
    await app.ready();
    return app;
  }

  test("no token: all routes pass", async () => {
    delete process.env.MAGISTER_API_TOKEN;
    _resetAuthWarningForTest();
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/tasks" });
    expect(res.statusCode).toBe(200);
  });

  test("token set: /health exempt, /tasks requires Bearer", async () => {
    process.env.MAGISTER_API_TOKEN = "tok-abc";
    _resetAuthWarningForTest();
    const app = await buildTestApp();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const noAuth = await app.inject({ method: "GET", url: "/tasks" });
    expect(noAuth.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET", url: "/tasks",
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: "GET", url: "/tasks",
      headers: { authorization: "Bearer tok-abc" },
    });
    expect(ok.statusCode).toBe(200);

    delete process.env.MAGISTER_API_TOKEN;
  });
});
