import { useEffect, useMemo, useState } from "react";
import {
  deleteAgentProfile,
  getAgentProfiles,
  getModels,
  getProviders,
  updateAgentProfile,
} from "../../lib/api";
import type {
  AgentProfile,
  ModelList as ModelListType,
  ProviderList as ProviderListType,
} from "../../lib/types";
import { formatRuntimeLabel } from "../../lib/runtimeLabels";
import { ModelSelector } from "./ModelSelector";

type AgentItem = AgentProfile;
type ProviderItem = ProviderListType["items"][number];
type ModelItem = ModelListType["items"][number];
type ToolProfile = NonNullable<AgentProfile["toolProfile"]>;
type RuntimeType = NonNullable<AgentProfile["runtimeType"]>;

/** Model inheritance defaults surfaced in the agent form. Agent has
 *  its own `maxOutputTokens` / `contextWindow` / `reasoningMode` /
 *  `reasoningEffort` columns that act as overrides (null = inherit
 *  from model). The form renders captions like "Model default: 16384"
 *  under each override input so the inheritance semantics aren't a
 *  hidden footgun. Resolved here, in the parent, because ModelSelector
 *  only exposes the selected name string. */
type ModelDefaults = {
  maxOutputTokens: number | null;
  contextWindow: number | null;
  reasoningMode: "off" | "auto" | "on" | null;
  reasoningEffort: string | null;
  vision: boolean;
};

function resolveModelDefaults(
  modelName: string,
  modelsById: Map<string, ModelItem>,
): ModelDefaults | null {
  if (!modelName.trim()) return null;
  const model = modelsById.get(modelName.trim());
  if (!model) return null;
  const mode = model.defaultReasoning?.mode;
  return {
    maxOutputTokens:
      typeof model.maxOutputTokens === "number" ? model.maxOutputTokens : null,
    contextWindow:
      typeof model.contextWindow === "number" ? model.contextWindow : null,
    reasoningMode: mode === "off" || mode === "auto" || mode === "on" ? mode : null,
    reasoningEffort: model.defaultReasoning?.effort ?? null,
    vision: model.capabilityHints?.vision === true,
  };
}

type AgentDraft = {
  roleId: string;
  label: string;
  description: string;
  runtimeType: RuntimeType;
  providerId: string;
  commandPath: string;
  systemPromptOverride: string;
  modelName: string;
  reasoningMode: "" | "off" | "auto" | "on";
  reasoningEffort: "" | "minimal" | "low" | "medium" | "high" | "xhigh";
  contextWindow: string;
  maxOutputTokens: string;
  fallbackModelName: string;
  fallbackProviderId: string;
  customEnv: string;
  customArgs: string;
  maxTurns: string;
  toolProfile: "" | ToolProfile;
  allowedTools: string[];
  disallowedTools: string[];
};

const TOOL_PROFILE_OPTIONS: ToolProfile[] = ["full", "coding", "research", "minimal"];

const RUNTIME_TYPE_OPTIONS: Array<{ value: RuntimeType; label: string }> = [
  { value: "ucm", label: "Magister Built-in" },
  { value: "codex", label: "Codex CLI" },
  { value: "opencode", label: "OpenCode CLI" },
  { value: "claude-code", label: "Claude Code" },
  { value: "kiro", label: "Kiro CLI" },
];

const DEFAULT_CLI_COMMAND_PATHS: Partial<Record<RuntimeType, string>> = {
  codex: "codex",
  opencode: "opencode",
  "claude-code": "claude",
  kiro: "kiro-cli",
};

const LEGACY_LINUX_CLI_COMMAND_PATHS: Partial<Record<RuntimeType, string>> = {
  codex: "/usr/bin/codex",
  opencode: "/usr/bin/opencode",
  "claude-code": "/usr/bin/claude",
  kiro: "/usr/bin/kiro-cli",
};

const REASONING_MODE_OPTIONS: Array<NonNullable<AgentDraft["reasoningMode"]>> = ["off", "auto", "on"];
const REASONING_EFFORT_OPTIONS: Array<{ value: Exclude<AgentDraft["reasoningEffort"], "">; label: string }> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High (xhigh)" },
];

function normalizeRuntimeType(value: string | null | undefined): RuntimeType {
  if (value === "codex" || value === "opencode" || value === "claude-code" || value === "kiro") {
    return value;
  }
  return "ucm";
}

function toNullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCliCommandPath(runtimeType: RuntimeType, commandPath: string | null | undefined): string {
  const trimmed = commandPath?.trim() ?? "";
  const defaultPath = DEFAULT_CLI_COMMAND_PATHS[runtimeType];
  if (!defaultPath) {
    return trimmed;
  }

  return trimmed === LEGACY_LINUX_CLI_COMMAND_PATHS[runtimeType] ? defaultPath : trimmed;
}

function toDraft(agent: AgentItem): AgentDraft {
  const runtimeType = normalizeRuntimeType(agent.runtimeType);
  return {
    roleId: agent.roleId,
    label: agent.label ?? "",
    description: agent.description ?? "",
    runtimeType,
    providerId: agent.providerId ?? agent.provider ?? "",
    commandPath: normalizeCliCommandPath(runtimeType, agent.commandPath),
    systemPromptOverride: agent.systemPromptOverride ?? "",
    modelName: agent.modelName ?? agent.modelOverride ?? "",
    reasoningMode: (agent.reasoningMode === "off" || agent.reasoningMode === "auto" || agent.reasoningMode === "on")
      ? agent.reasoningMode
      : "",
    reasoningEffort:
      (agent.reasoningEffort === "minimal" ||
        agent.reasoningEffort === "low" ||
        agent.reasoningEffort === "medium" ||
        agent.reasoningEffort === "high" ||
        agent.reasoningEffort === "xhigh")
        ? agent.reasoningEffort
        : "",
    contextWindow:
      agent.contextWindow === null || agent.contextWindow === undefined ? "" : String(agent.contextWindow),
    maxOutputTokens:
      agent.maxOutputTokens === null || agent.maxOutputTokens === undefined ? "" : String(agent.maxOutputTokens),
    fallbackModelName: agent.fallbackModelName ?? "",
    fallbackProviderId: agent.fallbackProviderId ?? "",
    customEnv: agent.customEnv ?? "",
    customArgs: agent.customArgs ?? "",
    maxTurns: agent.maxTurns === null || agent.maxTurns === undefined ? "" : String(agent.maxTurns),
    toolProfile: agent.toolProfile ?? "",
    allowedTools: Array.isArray(agent.allowedTools) ? [...agent.allowedTools] : [],
    disallowedTools: Array.isArray(agent.disallowedTools) ? [...agent.disallowedTools] : [],
  };
}

function emptyDraft(): AgentDraft {
  return {
    roleId: "",
    label: "",
    description: "",
    runtimeType: "ucm",
    providerId: "",
    commandPath: "",
    systemPromptOverride: "",
    modelName: "",
    reasoningMode: "",
    reasoningEffort: "",
    contextWindow: "",
    maxOutputTokens: "",
    fallbackModelName: "",
    fallbackProviderId: "",
    customEnv: "",
    customArgs: "",
    maxTurns: "",
    toolProfile: "",
    allowedTools: [],
    disallowedTools: [],
  };
}

function toPayload(draft: AgentDraft): Partial<AgentProfile> {
  const runtimeType = normalizeRuntimeType(draft.runtimeType);
  const maxTurnsRaw = draft.maxTurns.trim();
  const maxTurnsNum = maxTurnsRaw ? Number(maxTurnsRaw) : null;
  const contextWindowRaw = draft.contextWindow.trim();
  const contextWindowNum = contextWindowRaw ? Number(contextWindowRaw) : null;
  const maxOutputTokensRaw = draft.maxOutputTokens.trim();
  const maxOutputTokensNum = maxOutputTokensRaw ? Number(maxOutputTokensRaw) : null;
  const modelName = toNullableTrimmed(draft.modelName);
  const payload: Partial<AgentProfile> = {
    runtimeType,
    description: toNullableTrimmed(draft.description),
    systemPromptOverride: toNullableTrimmed(draft.systemPromptOverride),
    modelName,
    // Keep legacy field populated during transition.
    modelOverride: modelName,
    reasoningMode: draft.reasoningMode || null,
    reasoningEffort: draft.reasoningEffort || null,
  };

  const label = toNullableTrimmed(draft.label);
  if (label) {
    payload.label = label;
  }

  if (runtimeType === "ucm") {
    const providerId = toNullableTrimmed(draft.providerId);
    payload.providerId = providerId;
    payload.provider = providerId;
    payload.contextWindow =
      contextWindowNum !== null && Number.isFinite(contextWindowNum) && contextWindowNum > 0
        ? Math.floor(contextWindowNum)
        : null;
    payload.maxOutputTokens =
      maxOutputTokensNum !== null && Number.isFinite(maxOutputTokensNum) && maxOutputTokensNum > 0
        ? Math.floor(maxOutputTokensNum)
        : null;
    payload.fallbackModelName = toNullableTrimmed(draft.fallbackModelName);
    payload.fallbackProviderId = toNullableTrimmed(draft.fallbackProviderId);
    payload.toolProfile = draft.toolProfile || null;
    payload.maxTurns =
      maxTurnsNum !== null && Number.isFinite(maxTurnsNum) && maxTurnsNum > 0
        ? Math.floor(maxTurnsNum)
        : null;
    payload.commandPath = null;
    payload.customEnv = null;
    payload.customArgs = null;
    return payload;
  }

  payload.commandPath = toNullableTrimmed(draft.commandPath);
  payload.customEnv = toNullableTrimmed(draft.customEnv);
  payload.customArgs = toNullableTrimmed(draft.customArgs);
  payload.providerId = null;
  payload.provider = null;
  payload.contextWindow = null;
  payload.maxOutputTokens = null;
  payload.fallbackModelName = null;
  payload.fallbackProviderId = null;
  payload.toolProfile = null;
  payload.maxTurns = null;
  return payload;
}

function formatProviderLabel(provider: ProviderItem): string {
  const label = provider.label?.trim() || provider.id;
  const vendor = provider.vendor?.trim();
  return vendor ? `${label} (${vendor})` : label;
}

/** Compact human-readable token count: 16384 → "16K", 131072 → "128K",
 *  2000000 → "2M". Used in the model badges + override captions where
 *  raw numbers would be visually noisy. */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function findProviderLabel(providerId: string | null | undefined, providers: ProviderItem[]): string | null {
  const normalized = providerId?.trim();
  if (!normalized) {
    return null;
  }

  const matched = providers.find((provider) => provider.id === normalized);
  return matched ? formatProviderLabel(matched) : normalized;
}

function AgentFormFields({
  draft,
  providers,
  modelsById,
  includeRoleId,
  disabled,
  idPrefix,
  onChange,
  onResetLegacyToolOverrides,
}: {
  draft: AgentDraft;
  providers: ProviderItem[];
  modelsById: Map<string, ModelItem>;
  includeRoleId: boolean;
  disabled: boolean;
  idPrefix: string;
  onChange: (field: keyof AgentDraft, value: string) => void;
  onResetLegacyToolOverrides?: () => void;
}) {
  const runtimeType = normalizeRuntimeType(draft.runtimeType);
  const canUseModelSelector = !includeRoleId && draft.roleId.trim().length > 0;
  // Resolve the currently-selected model so we can surface "Model
  // default: X" captions under each override input. Null when no
  // model is selected or the typed name doesn't match a registered
  // model — captions are suppressed in that case (per codex risk
  // note: don't fabricate values from stale state).
  const modelDefaults = useMemo(
    () => resolveModelDefaults(draft.modelName, modelsById),
    [draft.modelName, modelsById],
  );
  // Count of fields whose values diverge from the model default —
  // used to label the "Advanced overrides" toggle in the collapsed
  // state ("3 fields overriding model" vs "Inheriting model
  // defaults"). Drives the affordance, not the runtime.
  const overrideCount = useMemo(() => {
    let n = 0;
    if (draft.contextWindow.trim().length > 0) n += 1;
    if (draft.maxOutputTokens.trim().length > 0) n += 1;
    if (draft.reasoningMode !== "") n += 1;
    if (draft.reasoningEffort !== "") n += 1;
    return n;
  }, [draft.contextWindow, draft.maxOutputTokens, draft.reasoningMode, draft.reasoningEffort]);
  const [advancedOpen, setAdvancedOpen] = useState(overrideCount > 0);
  const legacyToolOverrideCount = draft.allowedTools.length + draft.disallowedTools.length;

  return (
    <div className="agent-form-grid">
      {/* ─── IDENTITY ─── */}
      <section className="config-form-section">
        <h4 className="config-form-section-title">Identity</h4>
      {includeRoleId ? (
        <div className="config-field">
          <label htmlFor={`${idPrefix}-role-id`}>Role ID</label>
          <input
            id={`${idPrefix}-role-id`}
            className="config-input"
            type="text"
            value={draft.roleId}
            onChange={(e) => onChange("roleId", e.target.value)}
            placeholder="e.g. qa"
            autoComplete="off"
            disabled={disabled}
          />
        </div>
      ) : null}

      <div className="config-field">
        <label htmlFor={`${idPrefix}-label`}>Label</label>
        <input
          id={`${idPrefix}-label`}
          className="config-input"
          type="text"
          value={draft.label}
          onChange={(e) => onChange("label", e.target.value)}
          placeholder="Agent display name"
          disabled={disabled}
        />
      </div>

      <div className="config-field">
        <label htmlFor={`${idPrefix}-description`}>Description</label>
        <textarea
          id={`${idPrefix}-description`}
          className="config-input"
          rows={6}
          value={draft.description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder={
            "What it does (one line; note if read-only).\n" +
            "Spawn when: <numeric / scenario triggers, e.g. \"3+ files touched\" or \"i18n string changes\">\n" +
            "Pass: <required handoff data, e.g. \"original ask + locale list\">\n" +
            "Returns: <output shape, e.g. \"diff summary + lint status\">"
          }
          disabled={disabled}
        />
        <p className="config-field-hint">
          The leader reads this verbatim when picking which teammate to spawn. Follow the
          shape <code>what it does → when to spawn → what to pass → what it returns</code> so
          it routes correctly and writes a usable goal. See builtin roles (coder, reviewer,
          ...) for reference.
        </p>
      </div>
      </section>

      {/* ─── RUNTIME ─── */}
      <section className="config-form-section">
        <h4 className="config-form-section-title">Runtime</h4>
      <div className="config-field">
        <label htmlFor={`${idPrefix}-runtime-type`}>Runtime Type</label>
        <select
          id={`${idPrefix}-runtime-type`}
          className="config-input"
          value={runtimeType}
          onChange={(e) => onChange("runtimeType", normalizeRuntimeType(e.target.value))}
          disabled={disabled || draft.roleId === "leader"}
        >
          {RUNTIME_TYPE_OPTIONS.filter((opt) =>
            draft.roleId === "leader" ? opt.value === "ucm" : true,
          ).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      </section>

      {/* ─── MODEL ─── */}
      <section className="config-form-section">
        <h4 className="config-form-section-title">Model</h4>
      <div className="config-field">
        <label>Model Name</label>
        {canUseModelSelector ? (
          <ModelSelector
            runtimeType={runtimeType}
            agentId={draft.roleId}
            commandPath={draft.commandPath}
            // Pass the in-progress provider so the model list refetches
            // when the user changes the provider dropdown — without
            // this, switching e.g. volceengine → minimax keeps showing
            // volce models until save + reload.
            providerId={draft.providerId}
            value={draft.modelName}
            onChange={(nextModelName) => onChange("modelName", nextModelName)}
            disabled={disabled}
          />
        ) : (
          <input
            id={`${idPrefix}-model-name`}
            className="config-input"
            type="text"
            value={draft.modelName}
            onChange={(e) => onChange("modelName", e.target.value)}
            placeholder={runtimeType === "ucm" ? "e.g. kimi-k2.6-ark" : "Enter model name manually"}
            autoComplete="off"
            disabled={disabled}
          />
        )}
        {modelDefaults ? (
          <div className="agent-model-badges">
            {modelDefaults.vision ? (
              <span className="status-badge status-subtle" title="Selected model accepts image input">
                👁 vision-capable
              </span>
            ) : (
              <span className="status-badge status-subtle" style={{ opacity: 0.6 }} title="Selected model does not accept image input">
                text-only
              </span>
            )}
            {modelDefaults.contextWindow ? (
              <span className="status-badge status-subtle" title="Default context window from the model definition">
                ctx {formatTokenCount(modelDefaults.contextWindow)}
              </span>
            ) : null}
            {modelDefaults.maxOutputTokens ? (
              <span className="status-badge status-subtle" title="Default max output tokens from the model definition">
                out {formatTokenCount(modelDefaults.maxOutputTokens)}
              </span>
            ) : null}
          </div>
        ) : draft.modelName.trim().length > 0 ? (
          <p className="config-field-hint">
            Not a registered model id. Capabilities and defaults are unknown — overrides below are required if you need specific limits.
          </p>
        ) : null}
      </div>

      {runtimeType === "ucm" ? (
        <div className="config-field">
          <label htmlFor={`${idPrefix}-provider-id`}>Provider</label>
          <select
            id={`${idPrefix}-provider-id`}
            className="config-input"
            value={draft.providerId}
            onChange={(e) => onChange("providerId", e.target.value)}
            disabled={disabled}
          >
            <option value="">— default —</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {formatProviderLabel(provider)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      </section>

      {/* ─── REASONING (advanced overrides) ─── */}
      <section className="config-form-section">
        <h4 className="config-form-section-title">Reasoning</h4>
      {/* ──────── Advanced overrides ────────
        * Collapsible. Empty fields inherit from the selected model.
        * Captions surface the inherited value per codex's guidance
        * — placeholder would read as an example, hint reads as state. */}
      <div className="config-form-section">
        <button
          type="button"
          className="config-form-disclosure"
          aria-expanded={advancedOpen}
          aria-controls={`${idPrefix}-advanced`}
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>
            <span className="config-form-disclosure-title">Advanced overrides</span>
            <span className="config-form-disclosure-summary">
              {overrideCount > 0
                ? `${overrideCount} field${overrideCount === 1 ? "" : "s"} overriding model`
                : "Inheriting model defaults"}
            </span>
          </span>
          <span className="config-form-disclosure-chevron" aria-hidden="true">▶</span>
        </button>

        {advancedOpen ? (
          <div id={`${idPrefix}-advanced`} style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <div className="config-field">
              <label htmlFor={`${idPrefix}-reasoning-mode`}>Reasoning mode</label>
              <select
                id={`${idPrefix}-reasoning-mode`}
                className="config-input"
                value={draft.reasoningMode}
                onChange={(e) => onChange("reasoningMode", e.target.value)}
                disabled={disabled}
              >
                <option value="">Inherit from model</option>
                {REASONING_MODE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              {modelDefaults?.reasoningMode ? (
                <p className="config-field-hint">Model default: <code>{modelDefaults.reasoningMode}</code></p>
              ) : null}
            </div>

            <div className="config-field">
              <label htmlFor={`${idPrefix}-reasoning-effort`}>Reasoning effort</label>
              <select
                id={`${idPrefix}-reasoning-effort`}
                className="config-input"
                value={draft.reasoningEffort}
                onChange={(e) => onChange("reasoningEffort", e.target.value)}
                disabled={disabled}
              >
                <option value="">Inherit from model</option>
                {REASONING_EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {modelDefaults?.reasoningEffort ? (
                <p className="config-field-hint">Model default: <code>{modelDefaults.reasoningEffort}</code></p>
              ) : null}
            </div>

            {runtimeType === "ucm" ? (
              <>
                <div className="config-field">
                  <label htmlFor={`${idPrefix}-context-window`}>Context window</label>
                  <input
                    id={`${idPrefix}-context-window`}
                    className="config-input"
                    type="number"
                    min={1}
                    value={draft.contextWindow}
                    onChange={(e) => onChange("contextWindow", e.target.value)}
                    placeholder="Inherit from model"
                    disabled={disabled}
                  />
                  {modelDefaults?.contextWindow ? (
                    <p className="config-field-hint">
                      Model default: <code>{modelDefaults.contextWindow.toLocaleString()}</code> ({formatTokenCount(modelDefaults.contextWindow)})
                    </p>
                  ) : (
                    <p className="config-field-hint">Leave blank to inherit. Override to set this agent&apos;s context limit.</p>
                  )}
                </div>

                <div className="config-field">
                  <label htmlFor={`${idPrefix}-max-output-tokens`}>Max output tokens</label>
                  <input
                    id={`${idPrefix}-max-output-tokens`}
                    className="config-input"
                    type="number"
                    min={1}
                    value={draft.maxOutputTokens}
                    onChange={(e) => onChange("maxOutputTokens", e.target.value)}
                    placeholder="Inherit from model"
                    disabled={disabled}
                  />
                  {modelDefaults?.maxOutputTokens ? (
                    <p className="config-field-hint">
                      Model default: <code>{modelDefaults.maxOutputTokens.toLocaleString()}</code> ({formatTokenCount(modelDefaults.maxOutputTokens)})
                    </p>
                  ) : (
                    <p className="config-field-hint">Leave blank to inherit. Override to cap this agent&rsquo;s replies (e.g. keep a reviewer concise).</p>
                  )}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      </section>

      {/* ─── TOOL PROFILE / CUSTOM CONFIG ─── */}
      <section className="config-form-section">
        <h4 className="config-form-section-title">
          {runtimeType === "ucm" ? "Tool Profile" : "Custom Config"}
        </h4>
      {runtimeType === "ucm" ? (
        <>
          <div className="config-field">
            <label htmlFor={`${idPrefix}-fallback-model-name`}>Fallback Model</label>
            <input
              id={`${idPrefix}-fallback-model-name`}
              className="config-input"
              type="text"
              value={draft.fallbackModelName}
              onChange={(e) => onChange("fallbackModelName", e.target.value)}
              placeholder="e.g. glm-5.1-ark"
              autoComplete="off"
              disabled={disabled}
            />
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-fallback-provider-id`}>Fallback Provider</label>
            <select
              id={`${idPrefix}-fallback-provider-id`}
              className="config-input"
              value={draft.fallbackProviderId}
              onChange={(e) => onChange("fallbackProviderId", e.target.value)}
              disabled={disabled}
            >
              <option value="">— default —</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {formatProviderLabel(provider)}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-system-prompt`}>Instructions / System Prompt</label>
            <textarea
              id={`${idPrefix}-system-prompt`}
              className="config-input"
              value={draft.systemPromptOverride}
              onChange={(e) => onChange("systemPromptOverride", e.target.value)}
              placeholder="System prompt override"
              rows={6}
              disabled={disabled}
              style={{ height: "auto", minHeight: "9rem", padding: "10px 14px", resize: "vertical" }}
            />
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-tool-profile`}>Tool Profile</label>
            <select
              id={`${idPrefix}-tool-profile`}
              className="config-input"
              value={draft.toolProfile}
              onChange={(e) => onChange("toolProfile", e.target.value)}
              disabled={disabled}
            >
              <option value="">— default —</option>
              {TOOL_PROFILE_OPTIONS.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </div>

          {legacyToolOverrideCount > 0 ? (
            <div className="config-field">
              <label>Legacy tool overrides</label>
              <p className="config-field-hint">
                This agent has legacy raw tool overrides. They are hidden because tool availability is now managed by
                profile and runtime policy.
              </p>
              {onResetLegacyToolOverrides ? (
                <button
                  type="button"
                  className="config-edit-btn"
                  onClick={onResetLegacyToolOverrides}
                  disabled={disabled}
                >
                  Reset legacy overrides
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="config-field">
            <label htmlFor={`${idPrefix}-max-turns`}>Max Turns</label>
            <input
              id={`${idPrefix}-max-turns`}
              className="config-input"
              type="number"
              min={1}
              max={100}
              value={draft.maxTurns}
              onChange={(e) => onChange("maxTurns", e.target.value)}
              placeholder="60"
              disabled={disabled}
            />
            <p className="config-field-hint">
              Maximum reasoning turns this agent can use before the loop stops. Default: 60.
            </p>
          </div>

          {draft.roleId === "leader" ? (
            <p className="settings-warning">Restricting leader tools can remove delegation or approval capabilities for future leader turns.</p>
          ) : null}
        </>
      ) : (
        <>
          <div className="config-field">
            <label htmlFor={`${idPrefix}-command-path`}>Command Path</label>
            <input
              id={`${idPrefix}-command-path`}
              className="config-input"
              type="text"
              value={draft.commandPath}
              onChange={(e) => onChange("commandPath", e.target.value)}
              placeholder="e.g. /usr/bin/codex"
              autoComplete="off"
              disabled={disabled}
            />
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-system-prompt`}>Instructions</label>
            <textarea
              id={`${idPrefix}-system-prompt`}
              className="config-input"
              value={draft.systemPromptOverride}
              onChange={(e) => onChange("systemPromptOverride", e.target.value)}
              placeholder="Prompt/instructions sent to the CLI agent"
              rows={6}
              disabled={disabled}
              style={{ height: "auto", minHeight: "9rem", padding: "10px 14px", resize: "vertical" }}
            />
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-custom-env`}>Custom Env</label>
            <textarea
              id={`${idPrefix}-custom-env`}
              className="config-input"
              value={draft.customEnv}
              onChange={(e) => onChange("customEnv", e.target.value)}
              placeholder={"OPENAI_API_KEY=...\\nANOTHER_KEY=..."}
              rows={4}
              disabled={disabled}
              style={{ height: "auto", minHeight: "7rem", padding: "10px 14px", resize: "vertical" }}
            />
          </div>

          <div className="config-field">
            <label htmlFor={`${idPrefix}-custom-args`}>Custom Args</label>
            <input
              id={`${idPrefix}-custom-args`}
              className="config-input"
              type="text"
              value={draft.customArgs}
              onChange={(e) => onChange("customArgs", e.target.value)}
              placeholder="e.g. --dangerously-skip-permissions --quiet"
              autoComplete="off"
              disabled={disabled}
            />
          </div>
        </>
      )}
      </section>
    </div>
  );
}

function AgentCard({
  agent,
  providers,
  modelsById,
  onChanged,
}: {
  agent: AgentItem;
  providers: ProviderItem[];
  modelsById: Map<string, ModelItem>;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(() => toDraft(agent));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBuiltin = Boolean(agent.isBuiltin);
  const runtimeType = normalizeRuntimeType(agent.runtimeType);
  const modelName = agent.modelName?.trim() || agent.modelOverride?.trim() || "No model configured";
  const providerName = findProviderLabel(agent.providerId ?? agent.provider, providers);
  // Mockup-aligned summary fields: leading glyph (1st char of
  // roleId, uppercased), runtime pill (Magister / CODEX / ...),
  // provider/CLI subtitle for the runtime row, and a derived
  // status string. We don't currently track per-agent
  // heartbeats so state is presented as "READY" (idle, no clock
  // suffix) for any registered agent; the live indicator wires
  // in once a heartbeat surface is available.
  const glyphChar = (agent.roleId.trim().charAt(0) || "?").toUpperCase();
  const runtimePill = formatRuntimeLabel(runtimeType);
  const runtimeDetail =
    runtimeType === "ucm"
      ? (providerName ?? "default provider")
      : (agent.commandPath?.trim() || "no command path");

  function onDraftChange(field: keyof AgentDraft, value: string) {
    setDraft((prev) => {
      const next = { ...prev, [field]: value };
      // Auto-fill command path when runtime type changes
      if (field === "runtimeType" && value !== "ucm") {
        const nextRuntimeType = normalizeRuntimeType(value);
        if (!prev.commandPath || prev.commandPath === DEFAULT_CLI_COMMAND_PATHS[prev.runtimeType] || prev.commandPath === "") {
          next.commandPath = DEFAULT_CLI_COMMAND_PATHS[nextRuntimeType] ?? "";
        }
        // Clear model when switching runtime (discovery will show different models)
        next.modelName = "";
      }
      return next;
    });
  }

  function handleToggleEdit() {
    if (editing) {
      setDraft(toDraft(agent));
      setError(null);
    }
    setEditing((prev) => !prev);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const result = await updateAgentProfile(agent.roleId, toPayload(draft));
      const warning = (result as Record<string, unknown>)?.warning;
      if (typeof warning === "string") {
        setError(`⚠️ Saved, but: ${warning}`);
        // Keep form open so user sees the warning
        onChanged();
      } else {
        setEditing(false);
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetLegacyToolOverrides() {
    setSaving(true);
    setError(null);
    try {
      await updateAgentProfile(agent.roleId, {
        allowedTools: null,
        disallowedTools: null,
      });
      setDraft((prev) => ({ ...prev, allowedTools: [], disallowedTools: [] }));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const confirmed = window.confirm(`Delete agent profile "${agent.roleId}"?`);
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    try {
      await deleteAgentProfile(agent.roleId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="agent-row">
      <button
        type="button"
        className={`agent-summary${editing ? " agent-summary--open" : ""}`}
        onClick={handleToggleEdit}
        aria-expanded={editing}
        aria-controls={`agent-form-${agent.roleId}`}
        aria-label={`${editing ? "Collapse" : "Expand"} ${agent.roleId} agent profile`}
      >
        <span className={`ag-glyph${isBuiltin ? " ag-glyph--live" : ""}`} aria-hidden="true">
          {glyphChar}
        </span>
        <span className="ag-identity">
          <span className="ag-roleid">{agent.roleId}</span>
          <span className="ag-label">{agent.label || agent.description || "—"}</span>
        </span>
        <span className="ag-modelinfo">
          <span className="ag-model">{modelName}</span>
          <span className="ag-runtime">
            <span className="ag-runtime__pill">{runtimePill}</span>
            <span className="ag-runtime__sep">·</span>
            <span>{runtimeDetail}</span>
          </span>
        </span>
        <span className={`ag-state${isBuiltin ? " ag-state--live" : ""}`}>
          {isBuiltin ? "Built-in" : "Custom"}
        </span>
        <span className="ag-chev" aria-hidden="true">{editing ? "▴" : "▾"}</span>
      </button>

      {editing ? (
        <div
          id={`agent-form-${agent.roleId}`}
          className="agent-row__form"
          role="form"
          aria-label={`Edit ${agent.roleId}`}
        >
          {error ? <p className="settings-error">{error}</p> : null}

          <AgentFormFields
            draft={draft}
            providers={providers}
            modelsById={modelsById}
            includeRoleId={false}
            disabled={saving}
            idPrefix={`agent-${agent.roleId}`}
            onChange={onDraftChange}
            onResetLegacyToolOverrides={handleResetLegacyToolOverrides}
          />

          {/* Skill attachments moved to the Skills tab — manage them
              there as part of the unified pool view. The agent edit
              form no longer carries a per-agent skill multi-select
              to avoid two parallel sources of truth. */}

          <div className="config-form-footer">
            {!isBuiltin ? (
              <>
                <button
                  type="button"
                  className="config-delete-link"
                  onClick={handleDelete}
                  disabled={deleting || saving}
                  aria-label={`Delete ${agent.roleId} agent`}
                >
                  {deleting ? "Deleting…" : "⌫ Delete agent"}
                </button>
                <span className="config-form-footer-spacer" />
              </>
            ) : null}
            <button type="button" className="config-edit-btn" onClick={handleToggleEdit} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="config-save-btn" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function AgentList() {
  const [items, setItems] = useState<AgentItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState<AgentDraft>(() => emptyDraft());
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Indexed map for O(1) modelName → Model lookup. Recomputed only
  // when the models list changes (rare — fetched once at mount).
  const modelsById = useMemo(() => {
    const m = new Map<string, ModelItem>();
    for (const model of models) m.set(model.id, model);
    return m;
  }, [models]);

  function fetchAgents() {
    setLoading(true);
    setError(null);
    getAgentProfiles()
      .then((data) => {
        setItems(data.items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load agents"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([getAgentProfiles(), getProviders(), getModels()])
      .then(([agentData, providerData, modelData]) => {
        setItems(agentData.items);
        setProviders(providerData.items);
        setModels(modelData.items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load agents"))
      .finally(() => setLoading(false));
  }, []);

  function openNewForm() {
    setCreating(true);
    setCreateError(null);
    setCreatingDraft(emptyDraft());
  }

  function cancelNewForm() {
    setCreating(false);
    setCreateError(null);
    setCreateSaving(false);
    setCreatingDraft(emptyDraft());
  }

  function updateCreateDraft(field: keyof AgentDraft, value: string) {
    setCreatingDraft((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "runtimeType" && value !== "ucm") {
        next.commandPath = DEFAULT_CLI_COMMAND_PATHS[normalizeRuntimeType(value)] ?? "";
        next.modelName = "";
      }
      return next;
    });
  }

  async function saveNewAgent() {
    const roleId = creatingDraft.roleId.trim();
    if (!roleId) {
      setCreateError("Role ID is required");
      return;
    }

    setCreateSaving(true);
    setCreateError(null);
    try {
      await updateAgentProfile(roleId, toPayload(creatingDraft));
      cancelNewForm();
      fetchAgents();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create agent");
      setCreateSaving(false);
    }
  }

  if (loading) return <p className="settings-loading">Loading agents…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  const agentCount = items.length;

  return (
    <div>
      <div className="settings-content-head">
        <div className="settings-content-head__titles">
          <span className="settings-content-title">Agents</span>
          <span className="settings-content-sub">
            {agentCount} registered · resolves role → agent profile → provider
          </span>
        </div>
        <div className="settings-content-head__action">
          <button
            type="button"
            className={`config-save-btn${creating ? " config-edit-btn--active" : ""}`}
            onClick={openNewForm}
            disabled={creating}
          >
            + New agent
          </button>
        </div>
      </div>

      {creating ? (
        <article className="agent-row">
          <div className="agent-summary agent-summary--open" aria-label="New agent profile">
            <span className="ag-glyph" aria-hidden="true">+</span>
            <span className="ag-identity">
              <span className="ag-roleid">{creatingDraft.roleId || "new agent"}</span>
              <span className="ag-label">Custom · pending save</span>
            </span>
            <span className="ag-modelinfo">
              <span className="ag-model">{creatingDraft.modelName || "—"}</span>
              <span className="ag-runtime">
                <span className="ag-runtime__pill">{formatRuntimeLabel(creatingDraft.runtimeType)}</span>
              </span>
            </span>
            <span className="ag-state">Draft</span>
            <span className="ag-chev" aria-hidden="true">▴</span>
          </div>

          <div className="agent-row__form" role="form" aria-label="Create agent profile">
            {createError ? <p className="settings-error">{createError}</p> : null}

            <AgentFormFields
              draft={creatingDraft}
              providers={providers}
              modelsById={modelsById}
              includeRoleId={true}
              disabled={createSaving}
              idPrefix="new-agent"
              onChange={updateCreateDraft}
            />

            <div className="config-form-footer">
              <button type="button" className="config-edit-btn" onClick={cancelNewForm} disabled={createSaving}>
                Cancel
              </button>
              <button type="button" className="config-save-btn" onClick={saveNewAgent} disabled={createSaving}>
                {createSaving ? "Saving…" : "+ Save Agent"}
              </button>
            </div>
          </div>
        </article>
      ) : null}

      {items.length === 0 ? (
        <p className="settings-empty">No agent profiles configured.</p>
      ) : (
        items.map((agent) => (
          <AgentCard
            key={agent.roleId}
            agent={agent}
            providers={providers}
            modelsById={modelsById}
            onChanged={fetchAgents}
          />
        ))
      )}
    </div>
  );
}
