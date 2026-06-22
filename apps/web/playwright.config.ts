import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "@playwright/test";

// Disable Vite basic auth for E2E tests so we don't need credentials
// in every spec.  The vite.config.ts basicAuthPlugin skips auth when
// the password is empty.
process.env.MAGISTER_WEB_AUTH_PASS = "";

const bundledChromiumPath = process.env.HOME
  ? path.join(
      process.env.HOME,
      "Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    )
  : "";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (bundledChromiumPath && existsSync(bundledChromiumPath) ? bundledChromiumPath : undefined);

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? "http://127.0.0.1:4174";

const sharedUse = {
  baseURL,
  headless: true,
  actionTimeout: 10_000,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: sharedUse,
  projects: [
    {
      name: "desktop",
      testIgnore: "**/*.mobile.spec.ts",
      use: {
        viewport: { width: 1440, height: 1200 },
      },
    },
    {
      name: "mobile-ios",
      testMatch: "**/*.mobile.spec.ts",
      use: {
        viewport: { width: 390, height: 844 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: "mobile-android",
      testMatch: "**/*.mobile.spec.ts",
      use: {
        viewport: { width: 412, height: 915 },
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.625,
      },
    },
  ],
  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          env: {
            PLAYWRIGHT_TEST: "1",
            MAGISTER_WEB_AUTH_PASS: "",
          },
          command: "npx vite --host 127.0.0.1 --port 4174 --strictPort",
          url: baseURL,
          cwd: ".",
          // Was `true` — but reusing whatever Vite happens to be running on
          // :4174 means tests can hit a server with auth enabled (the user's
          // prod-style local server), producing "Unauthorized" responses
          // before the test code runs. Always boot a fresh Vite with the
          // PLAYWRIGHT_TEST + empty-auth env baked in. CI starts clean
          // anyway; local devs lose the warm-cache speedup but gain
          // correctness.
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
