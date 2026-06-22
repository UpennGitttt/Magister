import { useEffect, useMemo, useRef, useState } from "react";
import {
  addCatalogModels,
  createProvider,
  deleteProvider,
  getProviderCatalogModels,
  getProviders,
  getVendorPresets,
  revealProviderSecret,
  searchCatalogModels,
  setProviderSecret,
  updateProvider,
  updateSecret,
} from "../../lib/api";
import { ApiError } from "../../lib/request";

type ProviderReference =
  | { kind: "model"; modelId: string; field: string }
  | { kind: "binding"; adapterId: string; field: string }
  | { kind: "agent"; roleId: string; field: string };
import type { ProviderList as ProviderListType } from "../../lib/types";

type ProviderItem = ProviderListType["items"][number];

type VendorPreset = {
  apiDialect: string;
  vendor: string;
  baseUrl: string;
  auth: { kind: string; secretRef: string; headerName?: string; prefix?: string };
  models: readonly string[];
};

type VendorPresetMap = Record<string, VendorPreset>;

type ProviderDraft = {
  label: string;
  baseUrl: string;
  secretRef: string;
  /** Optional inline API key value. If provided on save, we write it
   *  to the secret store under the (possibly newly-typed) ref name.
   *  Cleared after a successful save so the field doesn't keep
   *  showing a sensitive value across re-renders. */
  secretValue: string;
};

function toDraft(provider: ProviderItem): ProviderDraft {
  // auth.secretRef comes back as "[redacted]" from the API — don't populate the draft with it
  const rawSecretRef = provider.auth?.secretRef ?? "";
  return {
    label: provider.label ?? "",
    baseUrl: provider.baseUrl ?? "",
    secretRef: rawSecretRef === "[redacted]" ? "" : rawSecretRef,
    secretValue: "",
  };
}

function QuickSetupDropdown({
  presets,
  onApply,
}: {
  presets: VendorPresetMap;
  onApply: (draft: Partial<ProviderDraft>) => void;
}) {
  const [selected, setSelected] = useState("");

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const key = e.target.value;
    setSelected(key);
    if (!key) return;
    const preset = presets[key];
    if (!preset) return;
    onApply({
      baseUrl: preset.baseUrl,
      secretRef: preset.auth.secretRef,
    });
  }

  return (
    <div className="config-field">
      <label htmlFor="quick-setup-select">Quick Setup</label>
      <select
        id="quick-setup-select"
        className="config-input"
        value={selected}
        onChange={handleChange}
      >
        <option value="">— select a provider preset —</option>
        {Object.entries(presets).map(([key, preset]) => (
          <option key={key} value={key}>
            {preset.vendor} ({preset.apiDialect})
          </option>
        ))}
      </select>
    </div>
  );
}

// Map the backend's machine-readable missing-field codes to short
// human-readable labels. The codes (e.g. "auth.secretRef") are useful
// for log-grepping but unhelpful in the UI — they read like internal
// jargon and don't tell the user what to do.
const MISSING_FIELD_LABEL: Record<string, string> = {
  "auth.secretRef": "API key not set",
  "headers.secretRef": "Header secret not set",
  "auth": "Auth not configured",
  "baseUrl": "Base URL not set",
  "commandPath": "CLI path not set",
  "provider": "Provider not found",
};

function humanizeMissing(missing: string[] | undefined): string {
  if (!missing?.length) return "Not ready";
  return missing.map((m) => MISSING_FIELD_LABEL[m] ?? m).join(", ");
}

function ReadinessBadge({
  readiness,
}: {
  readiness: { ready: boolean; missing: string[] } | undefined;
}) {
  const isReady = readiness?.ready === true;
  const label = isReady ? "Ready" : humanizeMissing(readiness?.missing);
  // Keep the raw codes available on hover for support/debug.
  const tooltip = isReady
    ? undefined
    : `Backend codes: ${readiness?.missing?.join(", ") ?? "(none)"}`;
  return (
    <span className="status-badge status-subtle" title={tooltip}>
      <span
        aria-hidden="true"
        className="status-dot"
        style={{
          background: isReady ? "var(--success)" : "var(--warning)",
        }}
      />
      {label}
    </span>
  );
}

function fmtTokens(n: number | undefined): string | null {
  if (typeof n !== "number" || n <= 0) return null;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** A unified picker row — from the provider's vendor catalog OR a cross-catalog search. */
type PickRow = {
  catalogProviderId: string;
  catalogModelId: string;
  name: string;
  contextWindow?: number | undefined;
  vision: boolean;
  alreadyAdded: boolean;
  /** Shown for search hits so the user sees where the metadata comes from. */
  source?: string | undefined;
};
const rowKey = (r: { catalogProviderId: string; catalogModelId: string }) =>
  JSON.stringify([r.catalogProviderId, r.catalogModelId]);

/**
 * Catalog model picker. Two ways in: the provider's vendor models (ticked from a
 * grid), or a fuzzy search across all of models.dev — the latter lets aggregator
 * endpoints (volcengine / openrouter) pull any model's metadata by name. Context
 * window + vision come from the catalog, so nothing is hand-typed.
 */
function BrowseModelsPanel({
  provider,
  onClose,
  onAdded,
}: {
  provider: ProviderItem;
  onClose: () => void;
  onAdded?: (() => void) | undefined;
}) {
  const [vendorRows, setVendorRows] = useState<PickRow[] | null>(null);
  const [vendorMapped, setVendorMapped] = useState(true);
  const [query, setQuery] = useState("");
  const [searchRows, setSearchRows] = useState<PickRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: number; failed: number } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set true on (re)mount too — under StrictMode the cleanup runs once before
    // the real mount, which would otherwise leave this stuck false and no-op
    // every `mountedRef.current && setState(...)` guard below.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadVendorModels = useMemo(() => async () => {
    const data = await getProviderCatalogModels(provider.id);
    if (!mountedRef.current) return;
    setVendorMapped(Boolean(data.catalogProviderId) && data.items.length > 0);
    setVendorRows(
      data.catalogProviderId
        ? data.items.map((m) => ({
            catalogProviderId: data.catalogProviderId!,
            catalogModelId: m.catalogModelId,
            name: m.name,
            contextWindow: m.contextWindow,
            vision: m.vision,
            alreadyAdded: m.alreadyAdded,
          }))
        : [],
    );
  }, [provider.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loadVendorModels()
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Failed to load catalog"))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [loadVendorModels]);

  // Debounced cross-catalog search. `cancelled` guards against a slow response
  // for a stale query landing after the query changed/cleared.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchRows([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchCatalogModels(q)
        .then((data) => {
          if (cancelled || !mountedRef.current) return;
          setSearchRows(data.items.map((h) => ({
            catalogProviderId: h.catalogProviderId,
            catalogModelId: h.catalogModelId,
            name: h.name,
            contextWindow: h.contextWindow,
            vision: h.vision,
            alreadyAdded: false,
            source: h.catalogProviderId,
          })));
        })
        .catch(() => !cancelled && mountedRef.current && setSearchRows([]))
        .finally(() => !cancelled && mountedRef.current && setSearching(false));
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const searchMode = query.trim().length > 0;
  // Selections are per-mode — don't let hidden vendor-mode picks ride along into
  // a search-mode submit (or vice-versa).
  useEffect(() => { setSelected(new Set()); }, [searchMode]);
  const rows = searchMode ? searchRows : (vendorRows ?? []);
  const selectable = useMemo(() => rows.filter((r) => !r.alreadyAdded), [rows]);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(rowKey(r)));

  function toggle(r: PickRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = rowKey(r);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) selectable.forEach((r) => next.delete(rowKey(r)));
      else selectable.forEach((r) => next.add(rowKey(r)));
      return next;
    });
  }

  async function handleAdd() {
    if (selected.size === 0) return;
    setSaving(true);
    setError(null);
    const items = [...selected].map((k) => {
      const [catalogProviderId, catalogModelId] = JSON.parse(k) as [string, string];
      return { catalogProviderId: catalogProviderId!, catalogModelId: catalogModelId! };
    });
    try {
      const res = await addCatalogModels(provider.id, items);
      await loadVendorModels(); // refresh "Added" flags (vendor grid)
      if (!mountedRef.current) return;
      setResult({ added: res.added.length, skipped: res.skipped.length, failed: res.failed.length });
      setSelected(new Set());
      // Flip just-added rows to "Added" in the search list too (it isn't re-fetched).
      const addedIds = new Set(res.added);
      setSearchRows((prev) => prev.map((r) => addedIds.has(r.catalogModelId) ? { ...r, alreadyAdded: true } : r));
      onAdded?.();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "Bulk add failed");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="catalog-panel" role="region" aria-label={`Browse catalog models for ${provider.label}`}>
      <header className="catalog-panel__head">
        <div className="catalog-panel__title">
          <span>Catalog models</span>
          {!searchMode && vendorRows && vendorRows.length > 0 && (
            <span className="catalog-panel__count">{vendorRows.length}</span>
          )}
        </div>
        <button type="button" className="config-edit-btn" onClick={onClose}>Close</button>
      </header>
      <p className="catalog-panel__hint">
        Metadata (context window, vision) comes from models.dev — no manual entry.
        {!vendorMapped && !searchMode ? " This provider isn't a known brand, so search by model name below." : ""}
      </p>

      <input
        type="search"
        className="config-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search all of models.dev by name… e.g. deepseek-v4-pro"
        aria-label="Search catalog models"
        spellCheck={false}
      />

      {loading && <p className="settings-loading">Loading catalog…</p>}
      {error && <p className="settings-error">{error}</p>}
      {result && (
        <p className="catalog-panel__result" role="status">
          ✓ Added {result.added} model{result.added === 1 ? "" : "s"}
          {result.skipped > 0 ? ` · skipped ${result.skipped} already present` : ""}
          {result.failed > 0 ? ` · ${result.failed} failed (not in catalog)` : ""}.
        </p>
      )}

      {searchMode && searching && <p className="settings-loading">Searching…</p>}
      {searchMode && !searching && searchRows.length === 0 && (
        <p className="catalog-panel__hint">No models match “{query.trim()}”.</p>
      )}

      {rows.length > 0 && (
        <>
          <label className="catalog-selectall">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} />
            <span>{searchMode ? "Select all results" : "Select all unadded"} <span className="catalog-selectall__n">({selectable.length})</span></span>
          </label>

          <ul className="catalog-model-list">
            {rows.map((r) => {
              const ctx = fmtTokens(r.contextWindow);
              const k = rowKey(r);
              const checked = selected.has(k);
              return (
                <li key={k}>
                  <label
                    className={
                      "catalog-model-row"
                      + (r.alreadyAdded ? " catalog-model-row--added" : "")
                      + (checked ? " catalog-model-row--selected" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      className="catalog-model-row__check"
                      checked={checked}
                      disabled={r.alreadyAdded}
                      onChange={() => toggle(r)}
                    />
                    <span className="catalog-model-row__main">
                      <span className="catalog-model-row__name">{r.name}</span>
                      <code className="catalog-model-row__id">
                        {r.catalogModelId}
                        {r.source ? <span className="catalog-model-row__source"> · {r.source}</span> : null}
                      </code>
                    </span>
                    <span className="catalog-model-row__badges">
                      {ctx && <span className="catalog-badge" title="Context window">{ctx} ctx</span>}
                      {r.vision && <span className="catalog-badge catalog-badge--vision" title="Multimodal (image input)">vision</span>}
                      {r.alreadyAdded && <span className="catalog-badge catalog-badge--added">Added</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <footer className="catalog-panel__footer">
            <button type="button" className="config-save-btn" disabled={saving || selected.size === 0} onClick={handleAdd}>
              {saving ? "Adding…" : selected.size === 0 ? "Select models to add" : `Add ${selected.size} model${selected.size === 1 ? "" : "s"}`}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function ProviderCard({
  provider,
  presets,
  onSaved,
}: {
  provider: ProviderItem;
  presets: VendorPresetMap;
  onSaved?: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(() => toDraft(provider));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);
  // Display-only revealed key — kept SEPARATE from draft.secretValue so that
  // merely viewing the key never counts as "rotate to a new value" on Save.
  const [revealedValue, setRevealedValue] = useState("");

  async function handleRevealKey() {
    if (showKey) { setShowKey(false); return; } // hide (keep nothing typed)
    setRevealing(true);
    try {
      const data = await revealProviderSecret(provider.id);
      setRevealedValue(data.value);
      setShowKey(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal key");
    } finally {
      setRevealing(false);
    }
  }
  /** When the first delete attempt is refused with 409, we stash the
   *  reference list so the inline panel can render a per-card
   *  "Delete with cascade" button rather than burying the references
   *  inside an alert(). */
  const [blockingRefs, setBlockingRefs] = useState<ProviderReference[] | null>(null);

  async function performDelete(cascade: boolean) {
    setDeleting(true);
    setError(null);
    try {
      await deleteProvider(provider.id, { cascade });
      setBlockingRefs(null);
      onSaved?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === "provider_in_use" && Array.isArray(err.details?.references)) {
        setBlockingRefs(err.details.references as ProviderReference[]);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Delete failed");
        setBlockingRefs(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(
      `Delete provider "${provider.label || provider.id}"?\n\n`
      + `This removes it from config/executors.json. If any model, binding, or agent still references it, the delete is refused so you can decide whether to cascade.`,
    )) return;
    await performDelete(false);
  }

  async function handleCascadeDelete() {
    if (!blockingRefs) return;
    const summary = blockingRefs.map((r) => {
      if (r.kind === "model") return `• model "${r.modelId}" (${r.field}) — provider link cleared, model removed if no refs left`;
      if (r.kind === "binding") return `• binding "${r.adapterId}" — removed entirely`;
      return `• agent "${r.roleId}" (${r.field}) — field cleared, agent kept`;
    }).join("\n");
    if (!window.confirm(
      `Cascade-delete ${blockingRefs.length} reference(s)?\n\n${summary}\n\n`
      + `Then the provider itself is removed. This cannot be undone.`,
    )) return;
    await performDelete(true);
  }

  function handleCancelCascade() {
    setBlockingRefs(null);
    setError(null);
  }

  function handleChange(field: keyof ProviderDraft, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function handleApplyPreset(patch: Partial<ProviderDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      // Merge draft fields into the full provider object (backend requires transport, apiDialect, auth)
      // If secretRef is empty, preserve the existing one on the backend (don't send "[redacted]")
      const existingAuth = provider.auth ?? { kind: "none" as const };
      const authPayload = (existingAuth.kind === "api_key" || existingAuth.kind === "oauth_token")
        ? {
            ...existingAuth,
            // Only update secretRef if user typed a new value; empty = keep existing
            ...(draft.secretRef.trim() ? { secretRef: draft.secretRef.trim() } : {}),
          }
        : existingAuth;
      // Persist a new key value, if one was typed. If the user named an explicit
      // Secret Ref, write under it; otherwise write by provider id so the server
      // resolves the real ref (list responses redact it — writing the literal
      // "[redacted]" was the old bug).
      if (draft.secretValue.trim()) {
        const typedRef = draft.secretRef.trim();
        if (typedRef) {
          await updateSecret(typedRef, { value: draft.secretValue.trim() });
        } else {
          await setProviderSecret(provider.id, draft.secretValue.trim());
        }
      }
      await updateProvider(provider.id, {
        transport: provider.transport ?? "api",
        apiDialect: provider.apiDialect ?? "openai_chat_completions",
        auth: authPayload,
        label: draft.label || null,
        baseUrl: draft.baseUrl || null,
        vendor: provider.vendor ?? null,
      });
      setEditing(false);
      // Clear the inline value field after save so it doesn't show
      // a sensitive value across re-renders.
      setDraft((prev) => ({ ...prev, secretValue: "" }));
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleToggleEdit() {
    if (editing) {
      setDraft(toDraft(provider));
      setError(null);
    }
    setShowKey(false); // never carry a revealed key across edit toggles
    setRevealedValue("");
    setEditing((prev) => !prev);
  }

  return (
    <article className="config-card">
      <div className="config-card-header">
        <strong>{provider.label}</strong>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0 }}>
          <span className="status-badge status-subtle">{provider.vendor}</span>
          <ReadinessBadge readiness={provider.readiness} />
          <button
            type="button"
            className={`config-edit-btn${browsing ? " config-edit-btn--active" : ""}`}
            onClick={() => setBrowsing((v) => !v)}
            aria-expanded={browsing}
            disabled={editing || deleting}
            title="Add models from the models.dev catalog (context window + vision auto-filled)"
          >
            {browsing ? "Hide models" : "Browse models"}
          </button>
          <button
            type="button"
            className={`config-edit-btn${editing ? " config-edit-btn--active" : ""}`}
            onClick={handleToggleEdit}
            aria-expanded={editing}
            disabled={deleting}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className="config-edit-btn"
            style={{ color: "var(--error)" }}
            onClick={handleDelete}
            disabled={editing || saving || deleting}
            title="Remove provider from config/executors.json (refused if still referenced)"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {!editing && error && <p className="settings-error">{error}</p>}

      {!editing && blockingRefs && (
        <div className="settings-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <strong>Cannot delete: {blockingRefs.length} reference{blockingRefs.length === 1 ? "" : "s"} still point at this provider.</strong>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {blockingRefs.map((r, i) => (
              <li key={i}>
                {r.kind === "model" && <>model <code>{r.modelId}</code> (<code>{r.field}</code>)</>}
                {r.kind === "binding" && <>binding <code>{r.adapterId}</code> (<code>{r.field}</code>)</>}
                {r.kind === "agent" && <>agent <code>{r.roleId}</code> (<code>{r.field}</code>)</>}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="config-edit-btn"
              style={{ color: "var(--error)" }}
              onClick={() => void handleCascadeDelete()}
              disabled={deleting}
            >
              {deleting ? "Cascading…" : `Delete provider + ${blockingRefs.length} reference${blockingRefs.length === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="config-edit-btn"
              onClick={handleCancelCascade}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="config-card-meta">
        {provider.transport}
        {provider.apiDialect ? ` · ${provider.apiDialect}` : ""}
        {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
        {provider.auth?.secretRef ? ` · key: ${provider.auth.secretRef}` : ""}
      </p>

      {browsing && !editing && (
        <BrowseModelsPanel
          provider={provider}
          onClose={() => setBrowsing(false)}
          onAdded={onSaved}
        />
      )}

      {editing && (
        <div className="config-form" role="form" aria-label={`Edit ${provider.label}`}>
          {error && <p className="settings-error">{error}</p>}

          {Object.keys(presets).length > 0 && (
            <QuickSetupDropdown presets={presets} onApply={handleApplyPreset} />
          )}

          <div className="config-field">
            <label htmlFor={`provider-label-${provider.id}`}>Label</label>
            <input
              id={`provider-label-${provider.id}`}
              className="config-input"
              type="text"
              value={draft.label}
              onChange={(e) => handleChange("label", e.target.value)}
              placeholder="Provider display name"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`provider-baseurl-${provider.id}`}>Base URL</label>
            <input
              id={`provider-baseurl-${provider.id}`}
              className="config-input"
              type="text"
              value={draft.baseUrl}
              onChange={(e) => handleChange("baseUrl", e.target.value)}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`provider-secret-${provider.id}`}>Secret Ref (env var name)</label>
            <input
              id={`provider-secret-${provider.id}`}
              className="config-input"
              type="text"
              value={draft.secretRef}
              onChange={(e) => handleChange("secretRef", e.target.value)}
              placeholder="e.g. OPENAI_API_KEY"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`provider-secret-value-${provider.id}`}>
              API Key
              {provider.readiness?.ready && (
                <span className="key-configured-tag">✓ configured</span>
              )}
            </label>
            <div className="key-input-wrap">
              <input
                id={`provider-secret-value-${provider.id}`}
                className="config-input key-input"
                type={showKey ? "text" : "password"}
                value={showKey ? (draft.secretValue || revealedValue) : draft.secretValue}
                onChange={(e) => handleChange("secretValue", e.target.value)}
                placeholder={provider.readiness?.ready ? "•••••••• — click the eye to view, or type to replace" : "Paste your API key"}
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="key-eye-btn"
                onClick={() => void handleRevealKey()}
                disabled={revealing}
                aria-label={showKey ? "Hide API key" : "Reveal API key"}
                title={showKey ? "Hide" : "Reveal stored key"}
              >
                {revealing ? "…" : showKey ? "🙈" : "👁"}
              </button>
            </div>
            <p className="config-field-hint">
              {provider.readiness?.ready
                ? "A key is saved. Click the eye to verify it, or type a new one to replace."
                : "Saved to the secret store. Leave blank if you set it via an env var."}
            </p>
          </div>

          <div className="config-form-footer">
            <button
              type="button"
              className="config-save-btn"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "Saving…" : `Save ${provider.label}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

type NewProviderDraft = {
  id: string;
  label: string;
  vendor: string;
  baseUrl: string;
  secretRef: string;
  /** Optional inline API key value. If provided, we PUT the value to
   *  the secret store under `secretRef` so the user doesn't need
   *  shell access to edit `config/secrets.json`. Empty string means
   *  "use the existing env var" (the operator manages it elsewhere). */
  secretValue: string;
  apiDialect: string;
  /** Auth header name + bearer prefix. Optional; when blank the
   *  streaming caller picks dialect-default headers (`Authorization:
   *  Bearer …` for openai_chat_completions, `x-api-key` for
   *  anthropic_messages — see streaming-api-caller.ts). Presets that
   *  specify them (e.g. `deepseek-anthropic`'s `Authorization` +
   *  `Bearer `) now propagate through properly. */
  headerName: string;
  prefix: string;
};

const EMPTY_NEW_DRAFT: NewProviderDraft = {
  id: "",
  label: "",
  vendor: "",
  baseUrl: "",
  secretRef: "",
  secretValue: "",
  apiDialect: "openai_chat_completions",
  headerName: "",
  prefix: "",
};

// Friendly brand names for the preset keys (the raw keys/vendors read as jargon).
const BRAND_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  "deepseek-anthropic": "DeepSeek · Anthropic API",
  minimax: "MiniMax",
  qwen: "Qwen · DashScope",
  glm: "GLM · Zhipu",
  gemini: "Gemini",
};
function brandLabel(key: string): string {
  return BRAND_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function NewProviderForm({
  presets,
  existingIds,
  onCreated,
  onCancel,
}: {
  presets: VendorPresetMap;
  existingIds: ReadonlySet<string>;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<NewProviderDraft>(EMPTY_NEW_DRAFT);
  /** Selected brand: a preset key, "custom", or null (nothing picked yet). */
  const [brand, setBrand] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange<K extends keyof NewProviderDraft>(field: K, value: NewProviderDraft[K]) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function selectBrand(key: string) {
    setBrand(key);
    setShowAdvanced(false);
    setError(null);
    if (key === "custom") {
      // Sensible OpenAI-compatible defaults; user fills id + base URL.
      setDraft((prev) => ({
        ...EMPTY_NEW_DRAFT,
        secretValue: prev.secretValue,
        apiDialect: "openai_chat_completions",
        headerName: "Authorization",
        prefix: "Bearer ",
      }));
      return;
    }
    const preset = presets[key];
    if (!preset) return;
    // Explicit pick → fully autofill from the preset (overwrite prior brand's values).
    setDraft((prev) => ({
      ...EMPTY_NEW_DRAFT,
      secretValue: prev.secretValue,
      id: key,
      label: brandLabel(key),
      vendor: preset.vendor,
      baseUrl: preset.baseUrl,
      secretRef: preset.auth.secretRef,
      apiDialect: preset.apiDialect,
      headerName: preset.auth.headerName ?? "",
      prefix: preset.auth.prefix ?? "",
    }));
  }

  async function handleSave() {
    setError(null);
    const id = draft.id.trim();
    if (!id) {
      setError("Provider id is required (e.g. \"minimax\")");
      return;
    }
    if (existingIds.has(id)) {
      setError(`Provider id "${id}" already exists — edit it on the card above instead`);
      return;
    }
    if (!draft.baseUrl.trim()) {
      setError("Base URL is required");
      return;
    }
    // If user pasted an API key value, derive a default secret ref
    // name from the provider id so the operator doesn't need to
    // think about env-var naming.
    const secretRef = draft.secretRef.trim()
      || (draft.secretValue.trim() ? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY` : "");
    setSaving(true);
    try {
      // Persist the actual API key first (if provided) so the
      // provider config below references a ref that's already
      // populated. If the operator skipped this and just provided
      // a ref, we trust the env var is set externally.
      if (draft.secretValue.trim() && secretRef) {
        await updateSecret(secretRef, { value: draft.secretValue.trim() });
      }
      // POST (explicit create) — the server-side 409s on duplicate id,
      // so a race with another tab adding the same id is caught cleanly
      // instead of silently overwriting an existing provider. Preset
      // headerName + prefix are preserved through to the saved provider.
      // Empty (or whitespace-only) values are stripped so the streaming
      // caller's dialect-default fallback fires when the user didn't
      // customize.
      //
      // CRITICAL: do NOT trim the `prefix` value. `"Bearer "` (with
      // trailing space) is the canonical OAuth-style prefix, and
      // streaming-api-caller concatenates the prefix to the secret
      // value directly (`${prefix}${secret}`). Trimming would
      // produce `"Bearersecret"` and break auth. Caller is expected
      // to include any wanted separator in the prefix itself.
      const headerName = draft.headerName.trim();
      const prefixRaw = draft.prefix;
      const prefixIsBlank = prefixRaw.trim().length === 0;
      const apiKeyAuth = secretRef
        ? {
            kind: "api_key" as const,
            secretRef,
            ...(headerName ? { headerName } : {}),
            ...(prefixIsBlank ? {} : { prefix: prefixRaw }),
          }
        : null;
      await createProvider({
        id,
        transport: "api",
        apiDialect: draft.apiDialect.trim() || "openai_chat_completions",
        auth: apiKeyAuth ?? { kind: "none" },
        label: draft.label.trim() || id,
        baseUrl: draft.baseUrl.trim(),
        vendor: draft.vendor.trim() || draft.label.trim() || id,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  const isCustom = brand === "custom";
  const knownBrand = brand !== null && !isCustom;

  return (
    <article className="config-card config-card--new">
      <div className="config-card-header">
        <h3 className="config-card-title">New provider</h3>
      </div>
      <div className="config-form" role="form" aria-label="Create provider">
        {error && <p className="settings-error">{error}</p>}

        {/* Step 1 — pick a brand (autofills endpoint + protocol), or Custom. */}
        <div className="config-field">
          <label>Choose a provider</label>
          <div className="provider-brand-grid">
            {Object.entries(presets).map(([key, preset]) => (
              <button
                type="button"
                key={key}
                className={"provider-brand-tile" + (brand === key ? " provider-brand-tile--selected" : "")}
                onClick={() => selectBrand(key)}
                aria-pressed={brand === key}
              >
                <span className="provider-brand-tile__name">{brandLabel(key)}</span>
                <span className="provider-brand-tile__meta">{preset.auth.secretRef ?? preset.apiDialect}</span>
              </button>
            ))}
            <button
              type="button"
              className={"provider-brand-tile provider-brand-tile--custom" + (isCustom ? " provider-brand-tile--selected" : "")}
              onClick={() => selectBrand("custom")}
              aria-pressed={isCustom}
            >
              <span className="provider-brand-tile__name">Custom</span>
              <span className="provider-brand-tile__meta">Any OpenAI-compatible API</span>
            </button>
          </div>
          {!brand && (
            <p className="config-field-hint">Pick a brand to autofill the endpoint &amp; protocol — then just paste your key. Not listed? Choose <strong>Custom</strong>.</p>
          )}
        </div>

        {brand && (
          <>
            {/* Custom needs id + base URL up front (no preset to fill them). */}
            {isCustom && (
              <>
                <div className="config-field">
                  <label htmlFor="new-provider-id">Provider ID *</label>
                  <input
                    id="new-provider-id"
                    className="config-input"
                    type="text"
                    value={draft.id}
                    onChange={(e) => handleChange("id", e.target.value)}
                    placeholder="lowercase slug, e.g. openrouter / volceengine"
                    autoComplete="off"
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="new-provider-baseurl">Base URL *</label>
                  <input
                    id="new-provider-baseurl"
                    className="config-input"
                    type="text"
                    value={draft.baseUrl}
                    onChange={(e) => handleChange("baseUrl", e.target.value)}
                    placeholder="https://api.example.com/v1"
                    autoComplete="off"
                  />
                </div>
              </>
            )}

            {/* The one field everyone needs: the API key. */}
            <div className="config-field">
              <label htmlFor="new-provider-secret-value">API Key</label>
              <input
                id="new-provider-secret-value"
                className="config-input"
                type="password"
                value={draft.secretValue}
                onChange={(e) => handleChange("secretValue", e.target.value)}
                placeholder="Paste your API key"
                autoComplete="new-password"
                spellCheck={false}
              />
              <p className="config-field-hint">
                {knownBrand && draft.secretRef
                  ? <>Saved to the secret store as <code>{draft.secretRef}</code>. </>
                  : null}
                Already set it in <code>.env</code>? Leave this blank.
              </p>
            </div>

            <div className="config-field">
              <label htmlFor="new-provider-label">Label</label>
              <input
                id="new-provider-label"
                className="config-input"
                type="text"
                value={draft.label}
                onChange={(e) => handleChange("label", e.target.value)}
                placeholder="Display name"
              />
            </div>

            {/* Advanced — endpoint/protocol/auth details, prefilled for brands. */}
            <button
              type="button"
              className="config-form-disclosure"
              aria-expanded={showAdvanced}
              aria-controls="new-provider-advanced"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>
                <span className="config-form-disclosure-title">Advanced</span>
                <span className="config-form-disclosure-summary">
                  {knownBrand ? "Endpoint, protocol & auth (prefilled)" : "Protocol & auth headers"}
                </span>
              </span>
              <span className="config-form-disclosure-chevron" aria-hidden="true">▶</span>
            </button>

            {showAdvanced && (
              <div className="config-form-section" id="new-provider-advanced">
                {knownBrand && (
                  <>
                    <div className="config-field">
                      <label htmlFor="new-provider-id-adv">Provider ID</label>
                      <input
                        id="new-provider-id-adv"
                        className="config-input"
                        type="text"
                        value={draft.id}
                        onChange={(e) => handleChange("id", e.target.value)}
                        autoComplete="off"
                      />
                    </div>
                    <div className="config-field">
                      <label htmlFor="new-provider-baseurl-adv">Base URL</label>
                      <input
                        id="new-provider-baseurl-adv"
                        className="config-input"
                        type="text"
                        value={draft.baseUrl}
                        onChange={(e) => handleChange("baseUrl", e.target.value)}
                        autoComplete="off"
                      />
                    </div>
                  </>
                )}
                <div className="config-field">
                  <label htmlFor="new-provider-dialect">API Dialect</label>
                  <select
                    id="new-provider-dialect"
                    className="config-input"
                    value={draft.apiDialect}
                    onChange={(e) => handleChange("apiDialect", e.target.value)}
                  >
                    <option value="openai_chat_completions">openai_chat_completions</option>
                    <option value="openai_responses">openai_responses</option>
                    <option value="anthropic_messages">anthropic_messages</option>
                  </select>
                </div>
                <div className="config-field">
                  <label htmlFor="new-provider-secret">Secret Ref (env var name)</label>
                  <input
                    id="new-provider-secret"
                    className="config-input"
                    type="text"
                    value={draft.secretRef}
                    onChange={(e) => handleChange("secretRef", e.target.value)}
                    placeholder={`auto: ${(draft.id.trim() || "PROVIDER").toUpperCase().replace(/-/g, "_")}_API_KEY`}
                    autoComplete="off"
                  />
                  <p className="config-field-hint">Names the secret slot. Blank = auto-derive from Provider ID.</p>
                </div>
                <div className="config-field">
                  <label htmlFor="new-provider-header-name">Auth Header Name</label>
                  <input
                    id="new-provider-header-name"
                    className="config-input"
                    type="text"
                    value={draft.headerName}
                    onChange={(e) => handleChange("headerName", e.target.value)}
                    placeholder={draft.apiDialect === "anthropic_messages" ? "default: x-api-key" : "default: Authorization"}
                    autoComplete="off"
                  />
                </div>
                <div className="config-field">
                  <label htmlFor="new-provider-prefix">Auth Value Prefix</label>
                  <input
                    id="new-provider-prefix"
                    className="config-input"
                    type="text"
                    value={draft.prefix}
                    onChange={(e) => handleChange("prefix", e.target.value)}
                    placeholder={draft.apiDialect === "anthropic_messages" ? "default: (none)" : "default: Bearer "}
                    autoComplete="off"
                  />
                  <p className="config-field-hint">
                    Inserted before the secret value. Use <code>Bearer&nbsp;</code> (with trailing space) for OAuth-style headers.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        <div className="config-form-footer">
          {brand && (
            <button
              type="button"
              className="config-save-btn"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "Creating…" : "Create provider"}
            </button>
          )}
          <button
            type="button"
            className="config-edit-btn"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </article>
  );
}

export function ProviderList() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [presets, setPresets] = useState<VendorPresetMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function fetchProviders() {
    setLoading(true);
    Promise.all([
      getProviders(),
      getVendorPresets().catch(() => ({ data: {} } as { data: Record<string, unknown> })),
    ])
      .then(([providersData, vendorData]) => {
        setProviders(providersData.items);
        const raw = (vendorData as { data?: unknown }).data ?? vendorData;
        setPresets(typeof raw === "object" && raw !== null ? (raw as VendorPresetMap) : {});
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load providers"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchProviders();
  }, []);

  const existingIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);

  if (loading) return <p className="settings-loading">Loading providers…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  return (
    <div className="config-card-list">
      <div className="config-list-header">
        <button
          type="button"
          className="config-save-btn"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "Cancel new provider" : "+ New provider"}
        </button>
      </div>

      {adding && (
        <NewProviderForm
          presets={presets}
          existingIds={existingIds}
          onCreated={() => {
            setAdding(false);
            fetchProviders();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {providers.length === 0 && !adding ? (
        <p className="settings-empty">No providers configured. Click "+ New provider" to add one.</p>
      ) : (
        providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} presets={presets} onSaved={fetchProviders} />
        ))
      )}
    </div>
  );
}
