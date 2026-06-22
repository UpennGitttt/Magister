// SELF-UNREGISTERING SHIM. Older builds of this app shipped a real
// caching service worker; users still have those installed. To
// guarantee that no stale shell or stale tool-result cache leaks into
// dev sessions (which has been observed to cause spurious page
// reloads when the SW intercepts an HMR-adjacent request), this file
// now intentionally does NOTHING beyond unregistering itself the
// moment any browser fetches it.
//
// Belt-and-suspenders with `main.tsx` which also calls
// `getRegistrations().then(reg.unregister())` on every page load.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", async (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    try {
      await self.registration.unregister();
    } catch {}
    // Do NOT force-reload clients here — that would itself cause the
    // page-refresh symptom the user is reporting. Instead we let
    // `main.tsx`'s unregister + cache-clear handle subsequent loads.
    // The currently-controlled page falls through the no-op fetch
    // handler below until the user navigates away and back.
  })());
});

// Pass-through fetch handler — never cache, never intercept. The
// browser will use this as long as the SW is the controller, which
// will be at most one navigation cycle (until the unregister above
// completes). After that, fetches go directly to the network.
self.addEventListener("fetch", () => {
  // intentionally empty — falls through to default handling
});
