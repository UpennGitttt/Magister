import { afterEach, describe, expect, test } from "bun:test";

const originalWebHost = process.env.WEB_HOST;

async function loadViteConfig() {
  const mod = await import(`../../vite.config.ts?test=${Date.now()}-${Math.random()}`);
  return mod.default as {
    server?: { host?: string | boolean };
    preview?: { host?: string | boolean };
  };
}

afterEach(() => {
  if (originalWebHost === undefined) {
    delete process.env.WEB_HOST;
  } else {
    process.env.WEB_HOST = originalWebHost;
  }
});

describe("vite web host config", () => {
  test("defaults dev and preview servers to localhost", async () => {
    delete process.env.WEB_HOST;

    const config = await loadViteConfig();

    expect(config.server?.host).toBe("127.0.0.1");
    expect(config.preview?.host).toBe("127.0.0.1");
  });

  test("uses explicit WEB_HOST for Tailscale or LAN access", async () => {
    process.env.WEB_HOST = "100.64.12.34";

    const config = await loadViteConfig();

    expect(config.server?.host).toBe("100.64.12.34");
    expect(config.preview?.host).toBe("100.64.12.34");
  });
});
