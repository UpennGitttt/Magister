import { useEffect, useState } from "react";
import { getBindings, getModels, getProviders, updateBinding } from "../../lib/api";
import type {
  BindingList as BindingListType,
  ModelList as ModelListType,
  ProviderList as ProviderListType,
} from "../../lib/types";

type BindingItem = BindingListType["items"][number];
type ProviderItem = ProviderListType["items"][number];
type ModelItem = ModelListType["items"][number];

type BindingDraft = {
  providerRef: string;
  modelRef: string;
  executionMode: string;
  timeoutMs: string;
  commandPath: string;
  sandboxMode: string;
};

function toDraft(binding: BindingItem): BindingDraft {
  return {
    providerRef: binding.providerRef ?? "",
    modelRef: binding.modelRef,
    executionMode: binding.executionMode,
    timeoutMs: binding.timeoutMs != null ? String(binding.timeoutMs) : "",
    commandPath: binding.commandPath ?? "",
    sandboxMode: binding.sandboxMode ?? "",
  };
}

function titleCase(value: string) {
  return value
    .replace(/[_.-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatProviderLabel(provider: ProviderItem) {
  const label = provider.label?.trim() || provider.id;
  const vendor = provider.vendor?.trim() || "unknown";
  return `${label} (${vendor})`;
}

function formatModelLabel(model: ModelItem) {
  const label = model.label?.trim() || model.id;
  return `${label} (${model.modelName})`;
}

function ReadinessBadge({
  readiness,
}: {
  readiness: { ready: boolean; missing: string[] } | undefined;
}) {
  const isReady = readiness?.ready === true;
  const missingText = readiness?.missing?.join(", ") || "Not ready";
  return (
    <span className="status-badge status-subtle">
      <span
        aria-hidden="true"
        className="status-dot"
        style={{
          background: isReady ? "var(--success)" : "var(--warning)",
        }}
      />
      {isReady ? "Ready" : missingText}
    </span>
  );
}

function BindingCard({
  binding,
  providers,
  models,
  onSaved,
}: {
  binding: BindingItem;
  providers: ProviderItem[];
  models: ModelItem[];
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BindingDraft>(() => toDraft(binding));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerExists = draft.providerRef
    ? providers.some((provider) => provider.id === draft.providerRef)
    : true;
  const modelExists = models.some((model) => model.id === draft.modelRef);

  function handleChange(field: keyof BindingDraft, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave() {
    if (!draft.executionMode) {
      setError("Execution mode is required");
      return;
    }
    if (!draft.modelRef.trim()) {
      setError("Model ref is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const parsed = parseInt(draft.timeoutMs, 10);
      const timeoutNum = draft.timeoutMs.trim() && !isNaN(parsed) && parsed > 0 ? parsed : null;
      await updateBinding(binding.adapterId, {
        executionMode: draft.executionMode as "cli" | "api",
        modelRef: draft.modelRef.trim(),
        providerRef: draft.providerRef || null,
        timeoutMs: timeoutNum,
        commandPath: draft.commandPath || null,
        sandboxMode: draft.sandboxMode || null,
      });
      setEditing(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleToggleEdit() {
    if (editing) {
      setDraft(toDraft(binding));
      setError(null);
    }
    setEditing((prev) => !prev);
  }

  return (
    <article className="config-card">
      <div className="config-card-header">
        <strong>{titleCase(binding.adapterId)}</strong>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0 }}>
          <ReadinessBadge readiness={binding.readiness} />
          {binding.executionMode && (
            <span className="status-badge status-subtle">{binding.executionMode}</span>
          )}
          <button
            type="button"
            className={`config-edit-btn${editing ? " config-edit-btn--active" : ""}`}
            onClick={handleToggleEdit}
            aria-expanded={editing}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
      </div>

      <p className="config-card-meta">
        {[
          binding.providerRef ? `provider: ${binding.providerRef}` : null,
          binding.modelRef ? `model: ${binding.modelRef}` : null,
          binding.timeoutMs != null ? `timeout: ${binding.timeoutMs}ms` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "No binding configuration"}
      </p>

      {editing && (
        <div className="config-form" role="form" aria-label={`Edit ${titleCase(binding.adapterId)}`}>
          {error && <p className="settings-error">{error}</p>}

          <div className="config-field">
            <label htmlFor={`binding-provider-${binding.adapterId}`}>Provider Ref</label>
            <select
              id={`binding-provider-${binding.adapterId}`}
              className="config-input"
              value={draft.providerRef}
              onChange={(e) => handleChange("providerRef", e.target.value)}
            >
              <option value="">(none)</option>
              {!providerExists && draft.providerRef ? (
                <option value={draft.providerRef}>{draft.providerRef} (unknown)</option>
              ) : null}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {formatProviderLabel(provider)}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`binding-model-${binding.adapterId}`}>Model Ref</label>
            <select
              id={`binding-model-${binding.adapterId}`}
              className="config-input"
              value={draft.modelRef}
              onChange={(e) => handleChange("modelRef", e.target.value)}
            >
              {!modelExists && draft.modelRef ? (
                <option value={draft.modelRef}>{draft.modelRef} (unknown)</option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {formatModelLabel(model)}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`binding-mode-${binding.adapterId}`}>Execution Mode</label>
            <select
              id={`binding-mode-${binding.adapterId}`}
              className="config-input"
              value={draft.executionMode}
              onChange={(e) => handleChange("executionMode", e.target.value)}
            >
              <option value="api">API</option>
              <option value="cli">CLI</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`binding-timeout-${binding.adapterId}`}>Timeout (ms)</label>
            <input
              id={`binding-timeout-${binding.adapterId}`}
              className="config-input"
              type="text"
              inputMode="numeric"
              value={draft.timeoutMs}
              onChange={(e) => handleChange("timeoutMs", e.target.value)}
              placeholder="e.g. 60000"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`binding-command-${binding.adapterId}`}>Command Path</label>
            <input
              id={`binding-command-${binding.adapterId}`}
              className="config-input"
              type="text"
              value={draft.commandPath}
              onChange={(e) => handleChange("commandPath", e.target.value)}
              placeholder="Optional CLI path"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`binding-sandbox-${binding.adapterId}`}>Sandbox Mode</label>
            <select
              id={`binding-sandbox-${binding.adapterId}`}
              className="config-input"
              value={draft.sandboxMode}
              onChange={(e) => handleChange("sandboxMode", e.target.value)}
            >
              <option value="">None</option>
              <option value="read-only">Read Only</option>
              <option value="workspace-write">Workspace Write</option>
              <option value="danger-full-access">Danger: Full Access</option>
            </select>
          </div>

          <div className="config-form-footer">
            <button
              type="button"
              className="config-save-btn"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "Saving…" : `Save ${titleCase(binding.adapterId)}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function BindingList() {
  const [bindings, setBindings] = useState<BindingItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function fetchInitialData() {
    setLoading(true);
    setError(null);
    Promise.all([getBindings(), getProviders(), getModels()])
      .then(([bindingData, providerData, modelData]) => {
        setBindings(bindingData.items);
        setProviders(providerData.items);
        setModels(modelData.items);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load binding settings"),
      )
      .finally(() => setLoading(false));
  }

  function fetchBindings() {
    setLoading(true);
    setError(null);
    getBindings()
      .then((data) => setBindings(data.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load bindings"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchInitialData();
  }, []);

  if (loading) return <p className="settings-loading">Loading bindings…</p>;
  if (error) return <p className="settings-error">{error}</p>;
  if (providers.length === 0) {
    return <p className="settings-empty">No providers configured. Add one to get started.</p>;
  }
  if (models.length === 0) {
    return <p className="settings-empty">No models configured. Add one to get started.</p>;
  }
  if (bindings.length === 0) {
    return (
      <p className="settings-empty">
        No bindings configured. Create a binding to connect a model to a provider.
      </p>
    );
  }

  return (
    <div className="config-card-list">
      {bindings.map((binding) => (
        <BindingCard
          key={binding.adapterId}
          binding={binding}
          providers={providers}
          models={models}
          onSaved={fetchBindings}
        />
      ))}
    </div>
  );
}
