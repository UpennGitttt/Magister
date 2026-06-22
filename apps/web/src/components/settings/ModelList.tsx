import { useEffect, useRef, useState } from "react";
import {
  createModel,
  deleteModel,
  getModels,
  getProviders,
  searchCatalogModels,
  updateModel,
  type CatalogSearchHit,
  type ModelDeleteCascadeReport,
} from "../../lib/api";
import type { ModelList as ModelListType, ProviderList as ProviderListType } from "../../lib/types";

type ModelItem = ModelListType["items"][number];
type ProviderItem = ProviderListType["items"][number];

type ModelDraft = {
  label: string;
  modelName: string;
  vendor: string;
  maxOutputTokens: string;
  contextWindow: string;
  providerRefApi: string;
  providerRefCli: string;
  reasoningMode: "off" | "auto" | "on";
  reasoningEffort: "" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningBudgetTokens: string;
  fallbacks: string;
  /** Whether the model accepts image input. Read from
   *  `capabilityHints.vision`; the frontend ChatInput uses this to
   *  warn before staging images. */
  vision: boolean;
};

function normalizeReasoningEffort(value: string | null | undefined): ModelDraft["reasoningEffort"] {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return "";
}

function toDraft(model: ModelItem): ModelDraft {
  return {
    label: model.label ?? "",
    modelName: model.modelName ?? "",
    vendor: model.vendor ?? "",
    maxOutputTokens: model.maxOutputTokens != null ? String(model.maxOutputTokens) : "",
    contextWindow: model.contextWindow != null ? String(model.contextWindow) : "",
    providerRefApi: model.providerRefs?.api ?? "",
    providerRefCli: model.providerRefs?.cli ?? "",
    reasoningMode: (model.defaultReasoning?.mode as "off" | "auto" | "on" | undefined) ?? "off",
    reasoningEffort: normalizeReasoningEffort(model.defaultReasoning?.effort),
    reasoningBudgetTokens:
      model.defaultReasoning?.budgetTokens != null ? String(model.defaultReasoning.budgetTokens) : "",
    fallbacks: model.fallbacks?.join(", ") ?? "",
    vision: model.capabilityHints?.vision === true,
  };
}

function parsePositiveInt(input: string): number | null {
  const value = input.trim();
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function summarizeReasoning(model: ModelItem) {
  const mode = model.defaultReasoning?.mode;
  const effort = model.defaultReasoning?.effort;
  const budgetTokens = model.defaultReasoning?.budgetTokens;

  if (!mode && !effort && budgetTokens == null) {
    return "reasoning: none";
  }

  const parts: string[] = [];
  if (mode) parts.push(`mode=${mode}`);
  if (effort) parts.push(`effort=${effort}`);
  if (budgetTokens != null) parts.push(`budget=${budgetTokens}`);

  return `reasoning: ${parts.join(", ")}`;
}

function readinessText(model: ModelItem) {
  if (!model.readiness) {
    return "Unknown";
  }
  return model.readiness.ready ? "Ready" : "Needs Setup";
}

function providerLabel(provider: ProviderItem) {
  const base = provider.label?.trim() ? provider.label : provider.id;
  return provider.vendor ? `${base} (${provider.vendor})` : base;
}

function ModelCard({
  model,
  providers,
  onSaved,
  onDeleted,
}: {
  model: ModelItem;
  providers: ProviderItem[];
  onSaved?: () => void;
  onDeleted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ModelDraft>(() => toDraft(model));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline two-step confirm to match the WorkspaceRow delete pattern —
  // first click flips the Delete button into a Confirm + Cancel pair.
  const [deleteStep, setDeleteStep] = useState<"idle" | "confirm" | "cascade-prompt">("idle");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<string | null>(null);

  async function performDelete(cascade: boolean) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteModel(model.id, { cascade });
      const cascadeReport = (result as { cascade?: ModelDeleteCascadeReport })?.cascade;
      if (cascadeReport) {
        const bits = [
          cascadeReport.bindingsRemoved.length > 0
            ? `${cascadeReport.bindingsRemoved.length} binding(s) removed`
            : null,
          cascadeReport.agentsCleared.length > 0
            ? `${cascadeReport.agentsCleared.length} agent(s) had modelName/Override cleared`
            : null,
        ].filter(Boolean);
        if (bits.length > 0) {
          // Best-effort surface — could be a toast later; for now an
          // alert is fine because cascading delete is operator-initiated.
          window.alert(`Cascade: ${bits.join("; ")}.`);
        }
      }
      onDeleted?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed";
      // Server returns 409 with `references` for in-use; surface the
      // count + offer cascade. The api helper throws an Error built
      // from `error.message`, so we detect by substring rather than a
      // structured field. (Future: refactor `request` to expose the
      // error body.)
      if (message.includes("referenced by")) {
        setDeleteRefs(message);
        setDeleteStep("cascade-prompt");
      } else {
        setDeleteError(message);
      }
    } finally {
      setDeleting(false);
    }
  }

  function handleChange(field: keyof ModelDraft, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave() {
    if (!draft.modelName.trim()) {
      setError("Model Name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const parsedFallbacks = draft.fallbacks
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      // Preserve any existing capabilityHints keys; only flip the
      // vision bit. Otherwise toggling vision would silently drop
      // any other hint another tool might have set out-of-band.
      const nextCapabilityHints: Record<string, unknown> = {
        ...(model.capabilityHints ?? {}),
        vision: draft.vision,
      };

      await updateModel(model.id, {
        label: draft.label.trim() || null,
        modelName: draft.modelName.trim(),
        vendor: draft.vendor.trim() || null,
        maxOutputTokens: parsePositiveInt(draft.maxOutputTokens),
        contextWindow: parsePositiveInt(draft.contextWindow),
        providerRefs: {
          api: draft.providerRefApi || null,
          cli: draft.providerRefCli || null,
        },
        defaultReasoning: {
          mode: draft.reasoningMode,
          effort: draft.reasoningEffort || null,
          budgetTokens: parsePositiveInt(draft.reasoningBudgetTokens),
        },
        fallbacks: parsedFallbacks.length > 0 ? parsedFallbacks : null,
        capabilityHints: nextCapabilityHints,
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
      setDraft(toDraft(model));
      setError(null);
    }
    setEditing((prev) => !prev);
  }

  return (
    <article className="config-card">
      <div className="config-card-header">
        <strong>{model.label || model.id}</strong>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0 }}>
          <span className="status-badge status-subtle">{readinessText(model)}</span>
          {model.vendor ? <span className="status-badge status-subtle">{model.vendor}</span> : null}
          {model.capabilityHints?.vision === true ? (
            <span className="status-badge status-subtle" title="Model accepts image input">👁 vision</span>
          ) : null}
          <div className="config-card-action-cluster">
            <button
              type="button"
              className={`config-edit-btn${editing ? " config-edit-btn--active" : ""}`}
              onClick={handleToggleEdit}
              aria-expanded={editing}
            >
              {editing ? "Cancel" : "Edit"}
            </button>
            {deleteStep === "idle" && !editing && (
              <button
                type="button"
                className="config-edit-btn"
                onClick={() => { setDeleteStep("confirm"); setDeleteError(null); }}
                disabled={deleting}
                title="Delete this model"
              >
                Delete
              </button>
            )}
            {deleteStep === "confirm" && (
              <>
                <button
                  type="button"
                  className="config-edit-btn config-edit-btn--active"
                  onClick={() => void performDelete(false)}
                  disabled={deleting}
                >
                  {deleting ? "…" : "Confirm"}
                </button>
                <button
                  type="button"
                  className="config-edit-btn"
                  onClick={() => { setDeleteStep("idle"); setDeleteError(null); }}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            )}
            {deleteStep === "cascade-prompt" && (
              <>
                <button
                  type="button"
                  className="config-edit-btn config-edit-btn--active"
                  onClick={() => void performDelete(true)}
                  disabled={deleting}
                  title="Remove all references (bindings, agent fields) too"
                >
                  {deleting ? "…" : "Force Delete"}
                </button>
                <button
                  type="button"
                  className="config-edit-btn"
                  onClick={() => { setDeleteStep("idle"); setDeleteError(null); setDeleteRefs(null); }}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {deleteError && (
        <p className="settings-error" style={{ marginTop: "0.5rem" }}>{deleteError}</p>
      )}
      {deleteStep === "cascade-prompt" && deleteRefs && (
        <div className="config-card-cascade-hint">
          <strong>This model is in use.</strong> {deleteRefs}
          <br />
          Pick <em>Force Delete</em> to clear those references — bindings will be removed and agents using this model will need a replacement.
        </div>
      )}

      <p className="config-card-meta">
        {[
          model.modelName ? `model: ${model.modelName}` : null,
          model.maxOutputTokens != null ? `maxOutputTokens: ${model.maxOutputTokens}` : null,
          model.contextWindow != null ? `contextWindow: ${model.contextWindow}` : null,
          summarizeReasoning(model),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {!model.readiness?.ready && model.readiness?.missing?.length ? (
        <p className="config-card-meta">Missing: {model.readiness.missing.join(", ")}</p>
      ) : null}

      {editing && (
        <div className="config-form" role="form" aria-label={`Edit ${model.label || model.id}`}>
          {error && <p className="settings-error">{error}</p>}

          <div className="config-field">
            <label htmlFor={`model-label-${model.id}`}>Label</label>
            <input
              id={`model-label-${model.id}`}
              className="config-input"
              type="text"
              value={draft.label}
              onChange={(e) => handleChange("label", e.target.value)}
              placeholder="Display name"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-name-${model.id}`}>Model Name</label>
            <input
              id={`model-name-${model.id}`}
              className="config-input"
              type="text"
              value={draft.modelName}
              onChange={(e) => handleChange("modelName", e.target.value)}
              placeholder="e.g. gpt-5.4"
              autoComplete="off"
              required
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-vendor-${model.id}`}>Vendor</label>
            <input
              id={`model-vendor-${model.id}`}
              className="config-input"
              type="text"
              value={draft.vendor}
              onChange={(e) => handleChange("vendor", e.target.value)}
              placeholder="e.g. openai"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-max-output-${model.id}`}>Max Output Tokens</label>
            <input
              id={`model-max-output-${model.id}`}
              className="config-input"
              type="number"
              min={1}
              value={draft.maxOutputTokens}
              onChange={(e) => handleChange("maxOutputTokens", e.target.value)}
              placeholder="e.g. 4096"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-context-window-${model.id}`}>Context Window</label>
            <input
              id={`model-context-window-${model.id}`}
              className="config-input"
              type="number"
              min={1}
              value={draft.contextWindow}
              onChange={(e) => handleChange("contextWindow", e.target.value)}
              placeholder="e.g. 128000"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-vision-${model.id}`} style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input
                id={`model-vision-${model.id}`}
                type="checkbox"
                checked={draft.vision}
                onChange={(e) => setDraft((prev) => ({ ...prev, vision: e.target.checked }))}
              />
              <span>Vision-capable (accepts images)</span>
            </label>
            <p className="config-card-meta" style={{ margin: "0.25rem 0 0 1.5rem" }}>
              Saved as <code>capabilityHints.vision</code> on the model record. ChatInput uses this to warn before staging images for a leader running this model.
            </p>
          </div>

          <div className="config-field">
            <label htmlFor={`model-provider-api-${model.id}`}>Provider Ref (API)</label>
            <select
              id={`model-provider-api-${model.id}`}
              className="config-input"
              value={draft.providerRefApi}
              onChange={(e) => handleChange("providerRefApi", e.target.value)}
            >
              <option value="">None</option>
              {providers.map((provider) => (
                <option key={`api-${provider.id}`} value={provider.id}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`model-provider-cli-${model.id}`}>Provider Ref (CLI)</label>
            <select
              id={`model-provider-cli-${model.id}`}
              className="config-input"
              value={draft.providerRefCli}
              onChange={(e) => handleChange("providerRefCli", e.target.value)}
            >
              <option value="">None</option>
              {providers.map((provider) => (
                <option key={`cli-${provider.id}`} value={provider.id}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`model-reasoning-mode-${model.id}`}>Default Reasoning: Mode</label>
            <select
              id={`model-reasoning-mode-${model.id}`}
              className="config-input"
              value={draft.reasoningMode}
              onChange={(e) => handleChange("reasoningMode", e.target.value as ModelDraft["reasoningMode"])}
            >
              <option value="off">Off</option>
              <option value="auto">Auto</option>
              <option value="on">On</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`model-reasoning-effort-${model.id}`}>Default Reasoning: Effort</label>
            <select
              id={`model-reasoning-effort-${model.id}`}
              className="config-input"
              value={draft.reasoningEffort}
              onChange={(e) => handleChange("reasoningEffort", e.target.value)}
            >
              <option value="">None</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`model-reasoning-budget-${model.id}`}>Default Reasoning: Budget Tokens</label>
            <input
              id={`model-reasoning-budget-${model.id}`}
              className="config-input"
              type="number"
              min={1}
              value={draft.reasoningBudgetTokens}
              onChange={(e) => handleChange("reasoningBudgetTokens", e.target.value)}
              placeholder="e.g. 2048"
              autoComplete="off"
            />
          </div>

          <div className="config-field">
            <label htmlFor={`model-fallbacks-${model.id}`}>Fallbacks</label>
            <input
              id={`model-fallbacks-${model.id}`}
              className="config-input"
              type="text"
              value={draft.fallbacks}
              onChange={(e) => handleChange("fallbacks", e.target.value)}
              placeholder="comma-separated model names"
              autoComplete="off"
            />
          </div>

          <div className="config-form-footer">
            <button
              type="button"
              className="config-save-btn"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "Saving…" : `Save ${model.label || model.id}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function AddModelForm({
  providers,
  existingIds,
  onCreated,
  onCancel,
}: {
  providers: ProviderItem[];
  existingIds: Set<string>;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [draft, setDraft] = useState<ModelDraft>({
    label: "",
    modelName: "",
    vendor: "",
    maxOutputTokens: "",
    contextWindow: "",
    providerRefApi: "",
    providerRefCli: "",
    reasoningMode: "auto",
    reasoningEffort: "medium",
    reasoningBudgetTokens: "",
    fallbacks: "",
    vision: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalog autofill: search models.dev, pick a hit → fill the fields below.
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogHits, setCatalogHits] = useState<CatalogSearchHit[]>([]);
  const [catalogSearching, setCatalogSearching] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const q = catalogQuery.trim();
    if (!q) { setCatalogHits([]); setCatalogSearching(false); return; }
    let cancelled = false;
    setCatalogSearching(true);
    const t = setTimeout(() => {
      searchCatalogModels(q)
        .then((data) => !cancelled && mountedRef.current && setCatalogHits(data.items))
        .catch(() => !cancelled && mountedRef.current && setCatalogHits([]))
        .finally(() => !cancelled && mountedRef.current && setCatalogSearching(false));
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [catalogQuery]);

  function applyCatalogHit(hit: CatalogSearchHit) {
    setId(hit.catalogModelId);
    setDraft((prev) => ({
      ...prev,
      label: hit.name,
      modelName: hit.catalogModelId,
      maxOutputTokens: hit.maxOutputTokens != null ? String(hit.maxOutputTokens) : prev.maxOutputTokens,
      contextWindow: hit.contextWindow != null ? String(hit.contextWindow) : prev.contextWindow,
      vision: hit.vision,
      // Default the provider to the only one if the user hasn't chosen yet.
      providerRefApi: prev.providerRefApi || (providers.length === 1 ? (providers[0]?.id ?? "") : prev.providerRefApi),
    }));
    setCatalogQuery("");
    setCatalogHits([]);
    setError(null);
  }

  function change(field: keyof ModelDraft, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function handleCreate() {
    const trimmedId = id.trim();
    if (!trimmedId) {
      setError("Model id is required (used as the key in executors.json — e.g. \"kimi-k2.6-ark\")");
      return;
    }
    if (existingIds.has(trimmedId)) {
      setError(`Model id "${trimmedId}" is already taken. Pick a different id.`);
      return;
    }
    if (!draft.modelName.trim()) {
      setError("Model Name is required (the literal name the provider API expects)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const parsedFallbacks = draft.fallbacks
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      await createModel({
        id: trimmedId,
        label: draft.label.trim() || null,
        modelName: draft.modelName.trim(),
        vendor: draft.vendor.trim() || null,
        maxOutputTokens: parsePositiveInt(draft.maxOutputTokens),
        contextWindow: parsePositiveInt(draft.contextWindow),
        providerRefs: {
          api: draft.providerRefApi || null,
          cli: draft.providerRefCli || null,
        },
        defaultReasoning: {
          mode: draft.reasoningMode,
          effort: draft.reasoningEffort || null,
          budgetTokens: parsePositiveInt(draft.reasoningBudgetTokens),
        },
        fallbacks: parsedFallbacks.length > 0 ? parsedFallbacks : null,
        capabilityHints: draft.vision ? { vision: true } : null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="config-card config-card--new">
      <div className="config-card-header">
        <strong>Add new model</strong>
        <button
          type="button"
          className="config-edit-btn"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>

      <div className="config-form" role="form" aria-label="Add new model">
        {error && <p className="settings-error">{error}</p>}

        {/* ──────── Add from catalog (autofill) ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Add from catalog</p>
          <div className="config-field">
            <input
              type="search"
              className="config-input"
              value={catalogQuery}
              onChange={(e) => setCatalogQuery(e.target.value)}
              placeholder="Search models.dev by name… e.g. deepseek-v4-pro — then pick to autofill"
              aria-label="Search catalog models"
              spellCheck={false}
            />
            <p className="config-field-hint">
              Fills Model ID, name, context window &amp; vision from models.dev. Or just fill the fields below manually.
            </p>
          </div>
          {catalogSearching && <p className="settings-loading">Searching…</p>}
          {!catalogSearching && catalogQuery.trim() && catalogHits.length === 0 && (
            <p className="config-field-hint">No models match “{catalogQuery.trim()}”.</p>
          )}
          {catalogHits.length > 0 && (
            <ul className="catalog-model-list">
              {catalogHits.map((h) => {
                const ctx = h.contextWindow && h.contextWindow >= 1000
                  ? `${Math.round(h.contextWindow / 1000)}k`
                  : h.contextWindow ? String(h.contextWindow) : null;
                return (
                  <li key={`${h.catalogProviderId}/${h.catalogModelId}`}>
                    <button type="button" className="catalog-model-row" onClick={() => applyCatalogHit(h)}>
                      <span className="catalog-model-row__main">
                        <span className="catalog-model-row__name">{h.name}</span>
                        <code className="catalog-model-row__id">
                          {h.catalogModelId}<span className="catalog-model-row__source"> · {h.catalogProviderId}</span>
                        </code>
                      </span>
                      <span className="catalog-model-row__badges">
                        {ctx && <span className="catalog-badge" title="Context window">{ctx} ctx</span>}
                        {h.vision && <span className="catalog-badge catalog-badge--vision" title="Multimodal (image input)">vision</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ──────── Identity ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Identity</p>

          <div className="config-field">
            <label htmlFor="new-model-id">Model ID</label>
            <input
              id="new-model-id"
              className="config-input"
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. kimi-k2.6-ark"
              autoComplete="off"
              required
            />
            <p className="config-field-hint">
              Internal key used in <code>config/executors.json</code>. Must be unique. Bindings + agents reference the model by this id.
            </p>
          </div>

          <div className="config-field">
            <label htmlFor="new-model-label">Label</label>
            <input
              id="new-model-label"
              className="config-input"
              type="text"
              value={draft.label}
              onChange={(e) => change("label", e.target.value)}
              placeholder="e.g. Kimi K2.6 (ARK)"
              autoComplete="off"
            />
            <p className="config-field-hint">Display name shown in the sidebar and model picker.</p>
          </div>

          <div className="config-field-pair">
            <div className="config-field">
              <label htmlFor="new-model-modelname">Model Name</label>
              <input
                id="new-model-modelname"
                className="config-input"
                type="text"
                value={draft.modelName}
                onChange={(e) => change("modelName", e.target.value)}
                placeholder="e.g. kimi-k2.6-ark"
                autoComplete="off"
                required
              />
              <p className="config-field-hint">The exact name the provider API expects.</p>
            </div>

            <div className="config-field">
              <label htmlFor="new-model-vendor">Vendor</label>
              <input
                id="new-model-vendor"
                className="config-input"
                type="text"
                value={draft.vendor}
                onChange={(e) => change("vendor", e.target.value)}
                placeholder="moonshot / zhipu / anthropic / openai"
                autoComplete="off"
              />
            </div>
          </div>
        </div>

        {/* ──────── Provider linkage ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Provider</p>

          <div className="config-field-pair">
            <div className="config-field">
              <label htmlFor="new-model-provider-api">API provider</label>
              <select
                id="new-model-provider-api"
                className="config-input"
                value={draft.providerRefApi}
                onChange={(e) => change("providerRefApi", e.target.value)}
              >
                <option value="">— select —</option>
                {providers.map((p) => (
                  <option key={`api-${p.id}`} value={p.id}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>

            <div className="config-field">
              <label htmlFor="new-model-provider-cli">CLI provider <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span></label>
              <select
                id="new-model-provider-cli"
                className="config-input"
                value={draft.providerRefCli}
                onChange={(e) => change("providerRefCli", e.target.value)}
              >
                <option value="">None</option>
                {providers.map((p) => (
                  <option key={`cli-${p.id}`} value={p.id}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ──────── Capacity ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Capacity</p>

          <div className="config-field-pair">
            <div className="config-field">
              <label htmlFor="new-model-max-output">Max output tokens</label>
              <input
                id="new-model-max-output"
                className="config-input"
                type="number"
                min={1}
                value={draft.maxOutputTokens}
                onChange={(e) => change("maxOutputTokens", e.target.value)}
                placeholder="e.g. 16384"
                autoComplete="off"
              />
            </div>

            <div className="config-field">
              <label htmlFor="new-model-context">Context window</label>
              <input
                id="new-model-context"
                className="config-input"
                type="number"
                min={1}
                value={draft.contextWindow}
                onChange={(e) => change("contextWindow", e.target.value)}
                placeholder="e.g. 131072"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="config-field">
            <label htmlFor="new-model-vision" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                id="new-model-vision"
                type="checkbox"
                checked={draft.vision}
                onChange={(e) => setDraft((d) => ({ ...d, vision: e.target.checked }))}
              />
              <span>Vision-capable (accepts images)</span>
            </label>
            <p className="config-field-hint">
              Saved as <code>capabilityHints.vision</code>. ChatInput uses this to warn before staging images.
            </p>
          </div>
        </div>

        {/* ──────── Reasoning policy ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Reasoning</p>

          <div className="config-field-pair">
            <div className="config-field">
              <label htmlFor="new-model-reasoning-mode">Mode</label>
              <select
                id="new-model-reasoning-mode"
                className="config-input"
                value={draft.reasoningMode}
                onChange={(e) => change("reasoningMode", e.target.value as ModelDraft["reasoningMode"])}
              >
                <option value="off">Off</option>
                <option value="auto">Auto</option>
                <option value="on">On</option>
              </select>
            </div>

            <div className="config-field">
              <label htmlFor="new-model-reasoning-effort">Effort</label>
              <select
                id="new-model-reasoning-effort"
                className="config-input"
                value={draft.reasoningEffort}
                onChange={(e) => change("reasoningEffort", e.target.value as ModelDraft["reasoningEffort"])}
              >
                <option value="">None</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh</option>
              </select>
            </div>
          </div>

          <div className="config-field">
            <label htmlFor="new-model-reasoning-budget">Budget tokens <span style={{ color: "var(--muted)", fontWeight: 400 }}>(optional)</span></label>
            <input
              id="new-model-reasoning-budget"
              className="config-input"
              type="number"
              min={1}
              value={draft.reasoningBudgetTokens}
              onChange={(e) => change("reasoningBudgetTokens", e.target.value)}
              placeholder="e.g. 2048"
              autoComplete="off"
            />
          </div>
        </div>

        {/* ──────── Fallbacks ──────── */}
        <div className="config-form-section">
          <p className="config-form-section-title">Fallbacks</p>

          <div className="config-field">
            <label htmlFor="new-model-fallbacks">Fallback model IDs</label>
            <input
              id="new-model-fallbacks"
              className="config-input"
              type="text"
              value={draft.fallbacks}
              onChange={(e) => change("fallbacks", e.target.value)}
              placeholder="e.g. kimi-k2.5, glm-5.1-ark"
              autoComplete="off"
            />
            <p className="config-field-hint">
              Comma-separated. Tried in order if the primary model returns a retryable error (rate limit, 5xx).
            </p>
          </div>
        </div>

        <div className="config-form-footer">
          <button
            type="button"
            className="config-save-btn"
            onClick={() => void handleCreate()}
            disabled={saving}
          >
            {saving ? "Creating…" : "Create model"}
          </button>
        </div>
      </div>
    </article>
  );
}

export function ModelList() {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function fetchModelSettings() {
    setLoading(true);
    setError(null);

    Promise.all([getModels(), getProviders()])
      .then(([modelsData, providersData]) => {
        setModels(modelsData.items);
        setProviders(providersData.items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load models"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchModelSettings();
  }, []);

  if (loading) return <p className="settings-loading">Loading models…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  return (
    <div className="config-card-list">
      {!adding && (
        <div className="config-list-header">
          <button
            type="button"
            className="config-save-btn"
            onClick={() => setAdding(true)}
          >
            + New model
          </button>
        </div>
      )}
      {adding && (
        <AddModelForm
          providers={providers}
          existingIds={new Set(models.map((m) => m.id))}
          onCreated={() => {
            setAdding(false);
            fetchModelSettings();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {models.length === 0 && !adding ? (
        <p className="settings-empty">No models configured.</p>
      ) : (
        models.map((model) => (
          <ModelCard
            key={model.id}
            model={model}
            providers={providers}
            onSaved={fetchModelSettings}
            onDeleted={fetchModelSettings}
          />
        ))
      )}
    </div>
  );
}
