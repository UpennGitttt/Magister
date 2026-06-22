import { useEffect, useMemo, useState } from "react";

import {
  configureOnboardingProvider,
  getOnboardingProviderPresets,
  getOnboardingStatus,
  saveFeishuCredentials,
} from "../../lib/api";
import type {
  CliAgentStatus,
  OnboardingProviderPreset,
  OnboardingStatus,
} from "../../lib/api";

type StepId = "providers" | "cli" | "feishu";

/**
 * Settings → Setup. The first-run onboarding wizard. Three steps, driven by
 * GET /onboarding/status:
 *   1. Providers (required) — pick a preset, paste a key → the leader becomes
 *      runnable in one shot (POST /onboarding/provider).
 *   2. CLI agents (optional) — install/login detection for codex/claude/opencode.
 *   3. Feishu (optional) — app id/secret → POST /feishu/setup, reconnects live.
 */
export function OnboardingWizard() {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<StepId>("providers");

  async function reload() {
    try {
      setError(null);
      const next = await getOnboardingStatus();
      setStatus(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load setup status");
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const steps: Array<{ id: StepId; label: string; done: boolean; required: boolean }> = useMemo(
    () => [
      { id: "providers", label: "Provider", done: Boolean(status?.providers.configured), required: true },
      { id: "cli", label: "CLI agents", done: Boolean(status?.cliAgents.anyReady), required: false },
      { id: "feishu", label: "Feishu", done: Boolean(status?.feishu.state.ready), required: false },
    ],
    [status],
  );

  return (
    <div className="onboard">
      <header className="settings-section-header">
        <div>
          <h2>Setup</h2>
          <p>
            Get Magister running: add a model provider (required), then optionally wire up the
            external CLI coding agents and the Feishu gateway.
          </p>
        </div>
        <button type="button" className="config-edit-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}

      {status?.complete ? (
        <div className="onboard__banner onboard__banner--ok">
          ✓ Magister is ready — the leader has a provider configured. The steps below are optional.
        </div>
      ) : (
        <div className="onboard__banner">
          Add a provider to finish setup — the agent can&apos;t think without one.
        </div>
      )}

      <nav className="onboard__rail" aria-label="Setup steps">
        {steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            className={`onboard__step${active === step.id ? " onboard__step--active" : ""}`}
            onClick={() => setActive(step.id)}
          >
            <span className={`onboard__step-dot${step.done ? " onboard__step-dot--done" : ""}`}>
              {step.done ? "✓" : index + 1}
            </span>
            <span className="onboard__step-label">
              {step.label}
              {step.required ? <em className="onboard__req"> · required</em> : null}
            </span>
          </button>
        ))}
      </nav>

      <div className="onboard__panel">
        {loading && !status ? (
          <p className="settings-loading">Loading setup…</p>
        ) : active === "providers" ? (
          <ProvidersStep status={status} onSaved={reload} />
        ) : active === "cli" ? (
          <CliStep items={status?.cliAgents.items ?? []} />
        ) : (
          <FeishuStep status={status} onSaved={reload} />
        )}
      </div>
    </div>
  );
}

// ── Step 1: Providers ─────────────────────────────────────────────────

function ProvidersStep({
  status,
  onSaved,
}: {
  status: OnboardingStatus | null;
  onSaved: () => Promise<OnboardingStatus | null>;
}) {
  const [presets, setPresets] = useState<OnboardingProviderPreset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const items = await getOnboardingProviderPresets();
        setPresets(items);
        if (items.length > 0 && !presetId) {
          setPresetId(items[0]!.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load provider presets");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = presets.find((p) => p.id === presetId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!preset) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const result = await configureOnboardingProvider({
        presetId,
        apiKey: apiKey.trim(),
        ...(modelName.trim() ? { modelName: modelName.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey("");
      setOk(`Configured — leader now uses ${result.modelName}.`);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to configure provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="config-card onboard__card">
      <header className="onboard__card-head">
        <h3 style={{ margin: 0 }}>Model provider</h3>
        {status?.providers.configured ? (
          <span className="onboard__badge onboard__badge--ok">✓ configured</span>
        ) : (
          <span className="onboard__badge">not configured</span>
        )}
      </header>
      <p className="onboard__hint">
        Pick a provider and paste an API key. Magister wires the provider, model, and leader agent
        in one shot, then verifies the leader actually resolves. Your key is stored locally in
        <code> config/secrets.json</code> (gitignored).
      </p>

      {error ? <div className="settings-error" role="alert">{error}</div> : null}
      {ok ? <div className="onboard__banner onboard__banner--ok">{ok}</div> : null}

      <form className="onboard__form" onSubmit={submit}>
        <label className="onboard__field">
          <span>Provider</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="onboard__field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={preset ? `stored as ${preset.id === "custom" ? "CUSTOM_API_KEY" : preset.vendor.toUpperCase() + "…"}` : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <label className="onboard__field">
          <span>Model</span>
          <input
            type="text"
            placeholder={preset?.defaultModel || "model name"}
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
          />
        </label>

        {preset?.requiresBaseUrl ? (
          <label className="onboard__field">
            <span>Base URL</span>
            <input
              type="text"
              placeholder="https://your-endpoint/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
        ) : null}

        <div className="onboard__actions">
          <button type="submit" className="config-edit-btn" disabled={busy || !apiKey.trim() || !preset}>
            {busy ? "Configuring…" : "Save & verify"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ── Step 2: CLI agents ────────────────────────────────────────────────

function CliStep({ items }: { items: CliAgentStatus[] }) {
  return (
    <section className="config-card onboard__card">
      <header className="onboard__card-head">
        <h3 style={{ margin: 0 }}>External CLI coding agents</h3>
      </header>
      <p className="onboard__hint">
        Optional. Magister can drive Codex, Claude Code, and OpenCode. Install one and log in at the
        system level — Magister reuses each CLI&apos;s own credentials, so there&apos;s no key to
        enter here. Then set a role&apos;s Runtime to that CLI in the <strong>Roles</strong> tab.
      </p>
      <div className="cli-setup__cards">
        {items.map((item) => (
          <CliAgentCard key={item.cli} status={item} />
        ))}
      </div>
    </section>
  );
}

function CliAgentCard({ status }: { status: CliAgentStatus }) {
  const { label, installed, version, authenticated, installHint, loginHint } = status;
  return (
    <section className="config-card cli-setup__card">
      <header className="cli-setup__card-head">
        <h3 style={{ margin: 0 }}>{label}</h3>
        <div className="cli-setup__badges">
          <Badge ok={installed} okLabel={`✓ ${version ?? "installed"}`} failLabel="✗ not installed" />
          <Badge ok={authenticated} okLabel="✓ logged in" failLabel="✗ not logged in" />
        </div>
      </header>
      {!installed ? (
        <div className="cli-setup__hint">
          <p style={{ margin: "0 0 4px" }}>Install:</p>
          <code className="cli-setup__cmd">{installHint}</code>
        </div>
      ) : !authenticated ? (
        <div className="cli-setup__hint">
          <p style={{ margin: "0 0 4px" }}>Log in:</p>
          <code className="cli-setup__cmd">{loginHint}</code>
        </div>
      ) : (
        <p className="cli-setup__ready">Ready — set a role&apos;s Runtime to {label} in the Roles tab.</p>
      )}
    </section>
  );
}

// ── Step 3: Feishu ────────────────────────────────────────────────────

function FeishuStep({
  status,
  onSaved,
}: {
  status: OnboardingStatus | null;
  onSaved: () => Promise<OnboardingStatus | null>;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const feishu = status?.feishu;
  const disabled = Boolean(feishu?.channelsDisabled);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const result = await saveFeishuCredentials({
        ...(appId.trim() ? { appId: appId.trim() } : {}),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
      });
      setAppId("");
      setAppSecret("");
      const state = result.gateway?.connectionState;
      setOk(
        result.state.ready
          ? `Saved.${state ? ` Gateway: ${state}.` : ""}`
          : "Saved, but still missing fields.",
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Feishu credentials");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="config-card onboard__card">
      <header className="onboard__card-head">
        <h3 style={{ margin: 0 }}>Feishu gateway</h3>
        {feishu?.state.ready ? (
          <span className="onboard__badge onboard__badge--ok">✓ configured</span>
        ) : (
          <span className="onboard__badge">not configured</span>
        )}
      </header>

      {disabled ? (
        <p className="onboard__hint">
          Channels are disabled (<code>MAGISTER_DISABLE_CHANNELS</code>). Feishu won&apos;t connect
          until you remove that flag. You can still save credentials below.
        </p>
      ) : (
        <p className="onboard__hint">
          Optional. Connect a Feishu (Lark) bot so you can talk to Magister from chat. Create an app
          in the Feishu developer console, then paste its App ID and App Secret. Saving reconnects
          the gateway live — no restart. Stored locally in <code>config/secrets.json</code>.
        </p>
      )}

      {error ? <div className="settings-error" role="alert">{error}</div> : null}
      {ok ? <div className="onboard__banner onboard__banner--ok">{ok}</div> : null}

      <form className="onboard__form" onSubmit={submit}>
        <label className="onboard__field">
          <span>App ID</span>
          <input
            type="text"
            autoComplete="off"
            placeholder={feishu?.state.fields.appId.present ? feishu.state.fields.appId.redactedValue : "cli_…"}
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
        </label>
        <label className="onboard__field">
          <span>App Secret</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={feishu?.state.fields.appSecret.present ? "•••• (stored)" : "app secret"}
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
          />
        </label>
        <div className="onboard__actions">
          <button
            type="submit"
            className="config-edit-btn"
            disabled={busy || (!appId.trim() && !appSecret.trim())}
          >
            {busy ? "Saving…" : "Save & reconnect"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Badge({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return (
    <span
      className="cli-setup__badge"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid var(--line)",
        color: ok ? "#16a34a" : "var(--ink-3)",
        background: ok ? "color-mix(in srgb, #16a34a 12%, transparent)" : "var(--surface-soft)",
        whiteSpace: "nowrap",
      }}
    >
      {ok ? okLabel : failLabel}
    </span>
  );
}
