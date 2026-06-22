import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWebHost } from "./src/lib/webHost";

// Load .env from project root (bun CWD is apps/web/ so process.env misses root .env)
function loadEnvFromRoot() {
  for (const p of [resolve(__dirname, "../../.env"), resolve(__dirname, ".env")]) {
    try {
      const content = readFileSync(p, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {}
  }
}
loadEnvFromRoot();

const apiTarget = process.env.MAGISTER_API_TARGET ?? "http://127.0.0.1:3700";
const webHost = resolveWebHost(process.env);

function basicAuthPlugin(): Plugin {
  return {
    name: "basic-auth",
    configureServer(server) {
      // Skip auth during E2E tests (CI or PLAYWRIGHT_TEST).
      if (process.env.CI || process.env.PLAYWRIGHT_TEST) {
        return;
      }
      // Re-read at server start time to pick up .env from project root
      const user = process.env.MAGISTER_WEB_AUTH_USER ?? "admin";
      const pass = process.env.MAGISTER_WEB_AUTH_PASS ?? "";
      if (!pass) return; // no password set = no auth
      const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
      server.middlewares.use((req, res, next) => {
        if (req.headers.authorization === expected) {
          next();
          return;
        }
        res.setHeader("WWW-Authenticate", 'Basic realm="Magister"');
        res.statusCode = 401;
        res.end("Unauthorized");
      });
    },
  };
}

// Inject build-time provenance so the Dashboard footer / Control
// Center version chip don't lie. Falls back to "dev" + "unknown" when
// git isn't available (CI image without git, etc.).
function readBuildProvenance() {
  try {
    const { execSync } = require("node:child_process");
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return { sha: sha || "unknown", builtAt: new Date().toISOString() };
  } catch {
    return { sha: "dev", builtAt: new Date().toISOString() };
  }
}

const __PROVENANCE__ = readBuildProvenance();

export default defineConfig({
  plugins: [basicAuthPlugin(), react()],
  define: {
    __MAGISTER_BUILD_SHA__: JSON.stringify(__PROVENANCE__.sha),
    __MAGISTER_BUILD_AT__: JSON.stringify(__PROVENANCE__.builtAt),
  },
  server: {
    host: webHost,
    port: 3701,
    allowedHosts: true,
    // Iteration history:
    //
    // 1. `hmr: false` — disabling HMR doesn't stop reloads. Without
    //    HMR every file change becomes a full reload via Vite's
    //    fallback channel.
    // 2. `hmr: { clientPort: 443, protocol: "wss" }` — meant to make
    //    the HMR WS work through Tailscale Funnel, but Funnel
    //    doesn't reliably support arbitrary WS upgrades. The Vite
    //    client then cycles through reconnect failures and eventually
    //    forces a `location.reload()` as recovery — manifested as
    //    "session page randomly refreshes" with no clear pattern.
    //
    // Final resolution for this dev environment: disable HMR AND
    // disable the file watcher entirely. Cost: developer must
    // manually refresh after editing files. Benefit: the user's
    // testing tab is stable — no more spontaneous reloads while a
    // separate session is editing source.
    //
    // For local-only dev where Tailscale isn't in the way, set
    // `MAGISTER_VITE_WATCH=1` to re-enable change detection.
    hmr: false,
    watch: process.env.MAGISTER_VITE_WATCH === "1"
      ? {
          ignored: [
            "**/node_modules/**",
            "**/.magister/**",
            "**/.local/**",
            "**/.superpowers/**",
            "**/.tmp*/**",
            "**/config/**",
          ],
        }
      : null,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  // `vite preview` serves the prod build (`dist/`) as plain static
  // files — no HMR, no client-side WS to the dev server, no
  // restart-detection ping loop. Use this when the dev server's WS
  // keeps dropping behind a reverse proxy and triggering reloads.
  preview: {
    host: webHost,
    port: 3701,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
