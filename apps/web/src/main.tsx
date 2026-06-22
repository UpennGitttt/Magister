// Block Vite's "server connection lost → auto-reload" behavior in dev.
// Tailscale Funnel doesn't reliably hold the dev WebSocket open, so the
// Vite client cycles between "lost" and "restored" and auto-issues a
// `location.reload()` on every restore. Even `hmr: false` doesn't stop
// that loop — the WS is the keep-alive ping channel, separate from HMR.
//
// We patch reload BEFORE any Vite client code runs (this file is the
// app entry; @vite/client is imported AFTER us by Vite's transform).
// In production the patch never sees any reload to block.
if (import.meta.env.DEV) {
  try {
    const originalReload = window.location.reload.bind(window.location);
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: () => {
        // eslint-disable-next-line no-console
        console.warn("[magister-diag] location.reload() blocked — caller stack:", new Error().stack);
      },
    });
    // Expose an escape hatch for cases where a manual reload is needed.
    (window as unknown as { ucmForceReload?: () => void }).ucmForceReload = originalReload;
  } catch {
    // Some browsers protect location.reload — skip the patch.
  }
}

import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./AppShell";
import "./styles/tokens.css";
import "./styles/variables.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/sidebar.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root was not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);

// Unregister stale service workers that cache old JS bundles. Wait
// for the unregister to complete BEFORE doing further work — earlier
// the fire-and-forget left a window where a stale SW could intercept
// in-flight requests / claim the page mid-navigation. We also clear
// any caches the SW had populated so a stale shell can't load on the
// next navigation.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (regs) => {
    await Promise.all(regs.map((reg) => reg.unregister()));
    if ("caches" in self) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // Best-effort cleanup; storage may be locked.
      }
    }
  });

  // Some browsers reload the page when a SW becomes the new
  // controller (controllerchange) — we don't WANT that here because
  // the SW is already deprecated. Swallow the event explicitly so
  // any well-meaning future code that listens for it doesn't reload.
  navigator.serviceWorker.addEventListener("controllerchange", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  });
}

// Diagnostics: log any unload, URL change, or visibility change so
// we can trace what triggered a perceived "refresh" during dev.
// Attach early so we beat any other listener.
if (import.meta.env.DEV) {
  // Real reload markers — fire only on actual document destruction
  // or bfcache eviction.
  window.addEventListener("beforeunload", () => {
    // eslint-disable-next-line no-console
    console.warn("[magister-diag] beforeunload");
  });
  window.addEventListener("pagehide", (e) => {
    // eslint-disable-next-line no-console
    console.warn("[magister-diag] pagehide persisted=" + e.persisted);
  });
  window.addEventListener("pageshow", (e) => {
    // eslint-disable-next-line no-console
    console.warn("[magister-diag] pageshow persisted=" + e.persisted);
  });

  // URL change without reload — covers history.pushState /
  // replaceState / popstate. If the URL changes but no `pagehide`
  // fires, it's React Router (or any pushState caller), NOT a
  // browser refresh.
  let lastHref = location.href;
  const logUrlChange = (kind: string) => {
    const next = location.href;
    if (next !== lastHref) {
      // eslint-disable-next-line no-console
      console.warn(`[magister-diag] url ${kind} ${lastHref} -> ${next}`, new Error("stack").stack);
      lastHref = next;
    }
  };
  window.addEventListener("popstate", () => logUrlChange("popstate"));
  // Wrap pushState/replaceState so router-level navigations announce themselves.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<typeof original>) {
      const r = original.apply(this, args);
      logUrlChange(method);
      return r;
    } as typeof original;
  }

  // visibilitychange — when the tab is backgrounded the page may
  // be discarded by the OS / browser. Logs help distinguish that
  // from a refresh.
  document.addEventListener("visibilitychange", () => {
    // eslint-disable-next-line no-console
    console.warn("[magister-diag] visibility=" + document.visibilityState);
  });
}
