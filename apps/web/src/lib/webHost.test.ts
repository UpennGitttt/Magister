import { describe, expect, test } from "bun:test";

import { isLocalWebHost, resolveWebHost } from "./webHost";

describe("resolveWebHost", () => {
  test("defaults the web console to localhost only", () => {
    expect(resolveWebHost({})).toBe("127.0.0.1");
  });

  test("keeps explicit hosts for Tailscale or LAN access", () => {
    expect(resolveWebHost({ WEB_HOST: "100.64.12.34" })).toBe("100.64.12.34");
    expect(resolveWebHost({ WEB_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("treats blank WEB_HOST as unset", () => {
    expect(resolveWebHost({ WEB_HOST: "   " })).toBe("127.0.0.1");
  });

  test("classifies loopback hosts as local-only", () => {
    expect(isLocalWebHost("127.0.0.1")).toBe(true);
    expect(isLocalWebHost("localhost")).toBe(true);
    expect(isLocalWebHost("::1")).toBe(true);
    expect(isLocalWebHost("100.64.12.34")).toBe(false);
    expect(isLocalWebHost("0.0.0.0")).toBe(false);
  });
});
