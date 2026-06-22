import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";

import { listWorkspaces, type WorkspaceView } from "../lib/api";

/**
 * Path A — global active workspace hook.
 *
 * Sources of truth, in priority order:
 *   1. **URL** (`/w/:wid/...`) — the operator just navigated to a
 *      workspace-scoped route, that id is the truth until they
 *      leave.
 *   2. **localStorage** (`magister_active_workspace_id`) — sticky
 *      across non-workspace routes (settings, status). Survives
 *      hard reloads.
 *   3. **Server default** (`workspaces.is_default`) — bootstrap
 *      fallback when no local pick yet.
 *
 * Both URL and cache are reactive across ALL consumers in the same
 * tab. Earlier versions of this hook held `activeId` in each
 * consumer's local `useState`, which gave each Picker / Sidebar /
 * ChatInput / AppShell its own independent snapshot — the picker
 * could navigate and update its own state while the sidebar's
 * stale-mounted state kept rendering the old workspace's links.
 * URL via `useLocation`, cache via `useSyncExternalStore` + a same-tab
 * `CustomEvent` (the native `storage` event only fires for OTHER tabs,
 * not the writer).
 *
 * The workspaces registry is also module-scoped: 9 consumers used
 * to fetch the list 9 times on mount; now one fetch fans out via
 * the shared snapshot.
 */
export const ACTIVE_WORKSPACE_STORAGE_KEY = "magister_active_workspace_id";
const LEGACY_STORAGE_KEY = "ucm_active_workspace_id";

function readCachedId(): string | null {
  try {
    const cached = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    if (cached !== null) return cached;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) {
      localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return legacy;
  } catch {
    return null;
  }
}

// Module-scoped snapshot of the cached id. The localStorage write
// is just persistence; this in-memory value is what React subscribes
// to so cross-tab `storage` events AND same-tab writes flow through
// one observation point. Reading localStorage in `getSnapshot` on
// every render was unreliable in JSDOM-backed tests — the snapshot
// occasionally returned a stale value even after a successful
// `setItem` in the same tick.
let cachedIdSnapshot: string | null = (() => {
  if (typeof window === "undefined") return null;
  return readCachedId();
})();
const cacheListeners = new Set<() => void>();

function notifyCacheListeners() {
  for (const l of cacheListeners) l();
}

function writeCachedId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, id);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* private mode — accept loss in storage but still update memory */
  }
  if (cachedIdSnapshot === id) return;
  cachedIdSnapshot = id;
  notifyCacheListeners();
}

function subscribeToCacheChanges(callback: () => void): () => void {
  cacheListeners.add(callback);
  // Cross-tab: another tab may have updated localStorage. Re-read
  // and notify our in-memory snapshot.
  let storageHandler: ((e: StorageEvent) => void) | null = null;
  if (typeof window !== "undefined") {
    storageHandler = (e: StorageEvent) => {
      if (e.key !== ACTIVE_WORKSPACE_STORAGE_KEY && e.key !== null) return;
      const next = readCachedId();
      if (next === cachedIdSnapshot) return;
      cachedIdSnapshot = next;
      notifyCacheListeners();
    };
    window.addEventListener("storage", storageHandler);
  }
  return () => {
    cacheListeners.delete(callback);
    if (storageHandler && typeof window !== "undefined") {
      window.removeEventListener("storage", storageHandler);
    }
  };
}

function getCachedIdSnapshot(): string | null {
  return cachedIdSnapshot;
}

// Reset module-scoped state. Test-only — production has no need to
// drop the registry cache or the cached id (other than via the
// normal write path). Exported so tests get deterministic isolation
// without re-importing the module via Bun's module loader (which is
// noisy and slow in batched runs).
export function __resetWorkspaceHookForTests(): void {
  cachedIdSnapshot = null;
  registrySnapshot = [];
  registryLoading = true;
  registryError = null;
  registryFetchInFlight = null;
  // Notify any still-mounted listeners so React tears down stale
  // renders. afterEach cleanup() typically runs first so this is a
  // belt-and-suspenders signal.
  notifyCacheListeners();
  notifyRegistryListeners();
}

// Module-scoped registry. Snapshot identity must be stable between
// notifications or useSyncExternalStore warns about infinite loops.
let registrySnapshot: WorkspaceView[] = [];
let registryLoading = true;
let registryError: string | null = null;
const registryListeners = new Set<() => void>();
let registryFetchInFlight: Promise<void> | null = null;

function notifyRegistryListeners() {
  for (const l of registryListeners) l();
}

async function fetchRegistry(): Promise<void> {
  if (registryFetchInFlight) return registryFetchInFlight;
  registryFetchInFlight = (async () => {
    try {
      const items = await listWorkspaces();
      registrySnapshot = items;
      registryError = null;
    } catch (err) {
      registryError = err instanceof Error ? err.message : "Failed to load workspaces";
    } finally {
      registryLoading = false;
      registryFetchInFlight = null;
      notifyRegistryListeners();
    }
  })();
  return registryFetchInFlight;
}

function subscribeToRegistry(cb: () => void): () => void {
  registryListeners.add(cb);
  return () => {
    registryListeners.delete(cb);
  };
}

const EMPTY_REGISTRY: WorkspaceView[] = [];

function parseUrlWorkspaceId(pathname: string): string | null {
  const m = pathname.match(/^\/w\/([^/]+)/);
  return m ? m[1] ?? null : null;
}

export function useActiveWorkspace() {
  const location = useLocation();
  const urlId = useMemo(() => parseUrlWorkspaceId(location.pathname), [location.pathname]);

  const cachedId = useSyncExternalStore(
    subscribeToCacheChanges,
    getCachedIdSnapshot,
    () => null,
  );
  const workspaces = useSyncExternalStore(
    subscribeToRegistry,
    () => registrySnapshot,
    () => EMPTY_REGISTRY,
  );
  const loadingRegistry = useSyncExternalStore(
    subscribeToRegistry,
    () => registryLoading,
    () => true,
  );
  const error = useSyncExternalStore(
    subscribeToRegistry,
    () => registryError,
    () => null,
  );

  useEffect(() => {
    if (registryLoading || workspaces.length === 0) {
      void fetchRegistry();
    }
  }, [workspaces.length]);

  // Resolution: URL > known cache > server default > first available.
  // A URL-sourced id is trusted WHILE we can't disprove it — registry still
  // loading (deep-link renders instantly) or the fetch errored (we can't
  // confirm absence, so don't strand the tab) — or when it matches a real
  // workspace. Only once the registry has loaded CLEANLY and the id is
  // definitively absent (deleted workspace / typo'd URL) do we fall through
  // to the default instead of pinning the app to a ghost id. That ghost was
  // what left the picker stuck on "Loading…" after a workspace was deleted
  // out from under an open /w/:wid tab.
  const activeId = useMemo(() => {
    if (urlId && (loadingRegistry || error || workspaces.some((w) => w.id === urlId))) {
      return urlId;
    }
    if (cachedId && workspaces.some((w) => w.id === cachedId)) return cachedId;
    const def = workspaces.find((w) => w.isDefault) ?? workspaces[0] ?? null;
    return def?.id ?? cachedId ?? null;
  }, [urlId, cachedId, workspaces, loadingRegistry, error]);

  // Persist a server-resolved default so the next cold start avoids
  // the registry round-trip. Only writes a KNOWN id (a URL typo or
  // a deleted workspace must not pollute the cache).
  useEffect(() => {
    if (!activeId || activeId === cachedId) return;
    if (workspaces.some((w) => w.id === activeId)) {
      writeCachedId(activeId);
    }
  }, [activeId, cachedId, workspaces]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const setActive = useCallback((id: string) => {
    writeCachedId(id);
  }, []);

  const refresh = useCallback(async () => {
    registryFetchInFlight = null;
    registryLoading = true;
    notifyRegistryListeners();
    await fetchRegistry();
  }, []);

  // URL-sourced ids render instantly. Cache- or default-sourced ids
  // wait for the registry fetch so we don't flash a stale snapshot
  // that the reconcile step is about to replace.
  const loading = urlId ? false : loadingRegistry;

  return { workspaces, active, activeId, setActive, refresh, loading, error };
}
