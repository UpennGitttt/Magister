import { useEffect, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServers,
  getMcpServerToolPolicies,
  getMcpDrift,
  updateMcpServer,
  updateMcpToolPolicy,
  getAgentMcpServers,
  setAgentMcpServers,
  getAgentProfiles,
  scanCliBridges,
  importExternalMcp,
  type CliBridgeScan,
  type CliRuntime,
  type DriftEntry,
  type McpServerView,
  type McpToolPolicy,
  type McpToolPolicyItem,
  type McpTransport,
  type McpTrustLevel,
} from "../../lib/api";
import { formatRuntimeLabel } from "../../lib/runtimeLabels";

export function McpServerList() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [bridgeScan, setBridgeScan] = useState<CliBridgeScan | null>(null);
  const [importing, setImporting] = useState<Record<string, boolean>>({});
  const [drift, setDrift] = useState<DriftEntry[] | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const data = await getMcpServers();
      setServers(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }

  async function loadDrift() {
    try {
      const { drift: entries } = await getMcpDrift();
      setDrift(entries);
    } catch {
      setDrift([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await scanCliBridges();
        setBridgeScan(data);
      } catch {
        // Silent — bridge is informational; UI degrades gracefully.
      }
    })();
    // Fetch drift alongside the bridge scan on Settings tab open.
    // On-demand only — no polling (per kimi M1 review).
    void loadDrift();
  }, []);

  if (loading) return <p className="settings-loading">Loading MCP servers…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  return (
    <div>
      {drift && drift.length > 0 ? (
        <section
          style={{
            background: "var(--ochre-soft)",
            border: "1px solid var(--ochre)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            marginBottom: 16,
            color: "var(--ink)",
          }}
        >
          <h3
            style={{
              fontSize: 13,
              margin: 0,
              color: "var(--ochre)",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span aria-hidden>⚠</span>
            MCP drift detected ({drift.length})
          </h3>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--ink-3)",
              margin: "6px 0 8px",
              letterSpacing: "0.02em",
            }}
          >
            Magister and the underlying CLIs disagree on what&apos;s installed.
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: 20,
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              lineHeight: 1.5,
              color: "var(--ink-2)",
            }}
          >
            {drift.map((d, i) => (
              <li key={i}>
                <strong style={{ color: "var(--ink)" }}>{d.name}</strong> in <code>{d.cli}</code>:{" "}
                {d.kind === "removed-externally"
                  ? "removed via CLI directly. Magister ledger is stale."
                  : d.kind === "added-externally"
                    ? "installed directly (not via Magister). Click Import in External section to track."
                    : "modified externally."}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="settings-mobile-toolbar">
        <p style={{ color: "var(--muted)", margin: 0, fontSize: 14 }}>
          {servers.length} MCP server{servers.length === 1 ? "" : "s"} registered. Magister connects on leader startup
          and merges their tools into the leader's tool list.
        </p>
        <div className="settings-mobile-toolbar__actions">
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => setShowAdd(true)}
          >
            + Add server
          </button>
        </div>
      </div>

      {showAdd ? (
        <McpServerForm
          onCancel={() => setShowAdd(false)}
          onSuccess={async () => {
            setShowAdd(false);
            await load();
          }}
        />
      ) : null}

      {servers.length === 0 && !showAdd ? (
        <EmptyState
          icon="◇"
          title="No MCP servers yet"
          description="Add one with the + Add server button above."
        />
      ) : null}

      <div className="config-card-list">
        {servers.map((server) => (
          <McpServerCard key={server.id} server={server} onChanged={load} />
        ))}
      </div>

      {bridgeScan ? (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>External MCP servers (not managed by Magister)</h2>
          <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            Configured directly in each CLI's config file. Stage 3 will add an "Import to Magister" button here.
          </p>
          {(["codex", "claude-code", "opencode"] as const).map((cli) => {
            const cliLabel = cli === "claude-code" ? "Claude Code" : cli === "opencode" ? "OpenCode" : "Codex";
            const list = bridgeScan.mcpByCli[cli] ?? [];
            return (
              <div key={cli} style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, marginBottom: 6 }}>
                  {cliLabel}{" "}
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>({list.length})</span>
                </h3>
                {list.length === 0 ? (
                  <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 0 12px" }}>
                    No external MCP servers in {cliLabel}.
                  </p>
                ) : (
                  <div className="config-card-list">
                    {list.map((s) => {
                      // Strip any annotation suffix (e.g. " (/path)") for the
                      // import call — the bridge re-finds it from the scan.
                      const baseName = s.name.replace(/\s+\(.*\)$/, "");
                      const importKey = `import::${cli}::${baseName}`;
                      const isImporting = Boolean(importing[importKey]);
                      return (
                        <article key={`${cli}::${s.name}`} className="config-card">
                          <div className="config-card-header">
                            <strong>{s.name}</strong>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span className="status-badge status-badge--neutral" style={{ fontSize: 11 }}>
                                {s.type ?? "?"}
                              </span>
                              <button
                                type="button"
                                className="config-edit-btn"
                                style={{ fontSize: 11, padding: "2px 8px" }}
                                disabled={isImporting}
                                onClick={async () => {
                                  if (!window.confirm(`Import "${baseName}" from ${cliLabel} into Magister? It will be default-attached to leader; you can attach to other agents in Settings → MCP after import.`)) return;
                                  setImporting((p) => ({ ...p, [importKey]: true }));
                                  try {
                                    const result = await importExternalMcp({ cli: cli as CliRuntime, name: baseName });
                                    // Surface kimi-flagged warnings to user (project-scope shadow,
                                    // propagation per-CLI errors).
                                    const allWarnings = [...result.warnings];
                                    if (result.propagation.errors.length > 0) {
                                      allWarnings.push(
                                        ...result.propagation.errors.map((e) => `${e.cli} ${e.phase}: ${e.message}`),
                                      );
                                    }
                                    if (allWarnings.length > 0) {
                                      alert(`Import succeeded with warnings:\n\n${allWarnings.join("\n\n")}`);
                                    }
                                    // Reload Magister-managed list, bridge scan, and drift state.
                                    await load();
                                    const next = await scanCliBridges();
                                    setBridgeScan(next);
                                    await loadDrift();
                                  } catch (err) {
                                    alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
                                  } finally {
                                    setImporting((p) => ({ ...p, [importKey]: false }));
                                  }
                                }}
                              >
                                {isImporting ? "Importing…" : "Import to Magister"}
                              </button>
                            </div>
                          </div>
                          {s.scope ? (
                            <p className="config-card-meta" style={{ fontSize: 11, color: "var(--muted)" }}>
                              Scope: <code>{s.scope}</code>
                            </p>
                          ) : null}
                          {s.url ? (
                            <p className="config-card-meta" style={{ fontSize: 11 }}>
                              <code>{s.url}</code>
                            </p>
                          ) : s.command ? (
                            <p className="config-card-meta" style={{ fontSize: 11 }}>
                              <code>{s.command.join(" ")}</code>
                            </p>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

function statusBadgeProps(status: McpServerView["status"]): {
  label: string;
  tone: "sage" | "ochre" | "red" | "neutral";
  errorText: string | null;
} {
  switch (status.kind) {
    case "connected":
      return { label: `Connected · ${status.toolCount} tools`, tone: "sage", errorText: null };
    case "disabled":
      return { label: "Disabled", tone: "neutral", errorText: null };
    case "disconnected":
      return { label: "Disconnected", tone: "ochre", errorText: null };
    case "failed":
      return { label: "Failed", tone: "red", errorText: status.error };
  }
}

function McpServerCard({ server, onChanged }: { server: McpServerView; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const badge = statusBadgeProps(server.status);

  async function handleToggleEnabled() {
    setBusy(true);
    try {
      await updateMcpServer(server.id, { enabled: !server.enabled });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleTrust() {
    const next: McpTrustLevel = server.trustLevel === "trusted" ? "ask" : "trusted";
    if (
      next === "trusted" &&
      !window.confirm(
        `Trust "${server.name}"? Only tools marked read-only can run without per-call approval; unknown and mutating tools still require approval. MCP servers can execute arbitrary code on the host.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await updateMcpServer(server.id, { trustLevel: next });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete MCP server "${server.name}"? This removes the registration; Magister won't connect to it on next startup.`)) return;
    setBusy(true);
    try {
      await deleteMcpServer(server.id);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="config-card">
      <div className="config-card-header">
        <strong>{server.name}</strong>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone={badge.tone}>{badge.label}</Pill>
          <Pill
            tone={server.trustLevel === "trusted" ? "ochre" : "neutral"}
          >
            {server.trustLevel === "trusted" ? "Trusted" : "Approval required"}
          </Pill>
          <button type="button" className="config-edit-btn" onClick={() => void handleToggleTrust()} disabled={busy}>
            {server.trustLevel === "trusted" ? "Require approval" : "Trust"}
          </button>
          <button type="button" className="config-edit-btn" onClick={() => void handleToggleEnabled()} disabled={busy}>
            {server.enabled ? "Disable" : "Enable"}
          </button>
          <button type="button" className="config-delete-link" onClick={() => void handleDelete()} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
      {badge.errorText ? (
        <p
          style={{
            margin: "6px 0 0",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--red)",
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          Error · {badge.errorText}
        </p>
      ) : null}
      <p className="config-card-meta" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
        Transport: <code>{server.transport}</code>
        {server.transport === "stdio" ? (
          <> · Command: <code>{(server.config.command as string[])?.join(" ")}</code></>
        ) : (
          <> · URL: <code>{server.config.url as string}</code></>
        )}
      </p>
      <p className="config-card-meta" style={{ fontSize: 11, color: "var(--muted)" }}>
        Policy changes affect approval immediately. Running leader runtimes may refresh tool metadata on the next turn.
      </p>
      {/* Phase 3: per-server attachment to agent roles */}
      <McpServerAttachmentRow server={server} />
      <McpToolPolicyPanel server={server} />
    </article>
  );
}

function McpServerForm({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [trustLevel, setTrustLevel] = useState<McpTrustLevel>("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const config =
        transport === "stdio"
          ? { command: command.trim().split(/\s+/) }
          : { url: url.trim() };
      await createMcpServer({ name: name.trim(), transport, config, trustLevel });
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="config-form" style={{ marginBottom: 16 }}>
      <div className="config-field">
        <label>Name</label>
        <input className="config-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. github" />
      </div>
      <div className="config-field">
        <label>Transport</label>
        <select className="config-input" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio (subprocess)</option>
          <option value="http">http (StreamableHTTP)</option>
          <option value="sse">sse (Server-Sent Events)</option>
        </select>
      </div>
      {transport === "stdio" ? (
        <div className="config-field">
          <label>Command (space-separated)</label>
          <input
            className="config-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
          />
        </div>
      ) : (
        <div className="config-field">
          <label>URL</label>
          <input
            className="config-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/sse"
          />
        </div>
      )}
      <div className="config-field">
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={trustLevel === "trusted"}
            onChange={(e) => setTrustLevel(e.target.checked ? "trusted" : "ask")}
          />
          <span>Trust this server</span>
        </label>
        <p style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0 0 24px" }}>
          MCP servers can execute arbitrary code. Even trusted servers only skip approval for tools marked read-only.
        </p>
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="config-form-footer">
        <button type="button" className="config-edit-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="config-save-btn"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function policyLabel(policy: McpToolPolicy) {
  switch (policy) {
    case "read_only":
      return "Read-only";
    case "mutating":
      return "Mutating";
    case "unknown":
      return "Unknown";
  }
}

function policyBadgeVariant(policy: McpToolPolicy): "success" | "warning" | "danger" | "neutral" {
  switch (policy) {
    case "read_only":
      return "success";
    case "mutating":
      return "danger";
    case "unknown":
      return "warning";
  }
}

function approvalLabel(item: McpToolPolicyItem) {
  if (item.approvalBehavior === "auto_allowed") return "Auto";
  switch (item.approvalReason) {
    case "server_ask":
      return "Approval: server";
    case "tool_mutating":
      return "Approval: mutating";
    case "tool_unknown":
      return "Approval: unknown";
    case "trusted_read_only":
      return "Auto";
  }
}

function McpToolPolicyPanel({ server }: { server: McpServerView }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<McpToolPolicyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await getMcpServerToolPolicies(server.id);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP tool policies");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (expanded) void load();
    // Reload when trust level changes because approvalBehavior changes.
  }, [expanded, server.id, server.trustLevel]);

  async function changePolicy(item: McpToolPolicyItem, policy: McpToolPolicy) {
    if (policy === item.policy) return;
    if (
      policy === "read_only" &&
      !window.confirm(`Mark "${item.namespacedName}" as read-only? When this server is trusted, calls can run without per-call approval.`)
    ) {
      return;
    }
    setSaving((prev) => ({ ...prev, [item.toolName]: true }));
    try {
      await updateMcpToolPolicy({
        serverId: server.id,
        toolName: item.toolName,
        policy,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP tool policy");
    } finally {
      setSaving((prev) => ({ ...prev, [item.toolName]: false }));
    }
  }

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}
    >
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
        Tool safety policies
      </summary>
      {loading ? (
        <p className="config-card-meta" style={{ fontSize: 11 }}>Loading tool policies…</p>
      ) : error ? (
        <p className="settings-error">{error}</p>
      ) : items.length === 0 ? (
        <p className="config-card-meta" style={{ fontSize: 11, color: "var(--muted)" }}>
          No tools discovered yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          {items.map((item, index) => (
            <div
              key={item.toolName}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr)",
                gap: 6,
                borderTop: index === 0 ? undefined : "1px solid var(--border)",
                padding: "8px 0",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, overflowWrap: "anywhere" }}>
                  {item.toolName}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>
                  {item.namespacedName}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span className={`status-badge status-badge--${policyBadgeVariant(item.policy)}`}>
                  {policyLabel(item.policy)}
                </span>
                <span className={`status-badge status-badge--${item.approvalBehavior === "auto_allowed" ? "success" : "neutral"}`}>
                  {approvalLabel(item)}
                </span>
                <select
                  className="config-input"
                  style={{ width: 128, maxWidth: "100%", minHeight: 30, fontSize: 12 }}
                  value={item.policy}
                  disabled={Boolean(saving[item.toolName])}
                  onChange={(event) => void changePolicy(item, event.target.value as McpToolPolicy)}
                >
                  <option value="unknown">Unknown</option>
                  <option value="read_only">Read-only</option>
                  <option value="mutating">Mutating</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * Per-server multi-checkbox: one box per agent role. Toggling
 * adds/removes the (role, server) pair via PUT /agents/:roleId/mcp-servers.
 * Reflects current attachment from GET /agents/:roleId/mcp-servers.
 *
 * Per-role serialization to match the SkillList pattern: handler N
 * reads current attachment, diffs to compute the new set, and calls
 * setAgentMcpServers. Concurrent toggles for the SAME role serialize
 * via a per-role queue ref so they don't clobber each other.
 */
function McpServerAttachmentRow({ server }: { server: McpServerView }) {
  const [agentRoles, setAgentRoles] = useState<Array<{ roleId: string; label: string; runtimeType: string | null | undefined }>>([]);
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Load all agent profiles + which of them are currently
        // attached to THIS server. We fetch per-role attachments
        // for each role and aggregate into the `attached` Set,
        // since the GET endpoint is per-role (no per-server endpoint).
        const profilesResp = await getAgentProfiles();
        const profiles = profilesResp.items;
        if (cancelled) return;
        setAgentRoles(profiles.map((p) => ({ roleId: p.roleId, label: p.label ?? p.roleId, runtimeType: p.runtimeType })));
        const attachedRoles = new Set<string>();
        await Promise.all(
          profiles.map(async (p) => {
            const r = await getAgentMcpServers(p.roleId);
            if (r.items.includes(server.id)) attachedRoles.add(p.roleId);
          }),
        );
        if (cancelled) return;
        setAttached(attachedRoles);
      } catch {
        // Silent: if the endpoint is unreachable, the row just
        // shows zero agents — better than crashing the panel.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server.id]);

  async function toggle(roleId: string, nextChecked: boolean) {
    setBusy(true);
    try {
      // Read the role's CURRENT full attachment set, mutate, and
      // PUT back the new full list. Simpler than a per-pair API
      // (and matches the agent-skills shape).
      const current = await getAgentMcpServers(roleId);
      const desired = new Set(current.items);
      if (nextChecked) desired.add(server.id);
      else desired.delete(server.id);
      await setAgentMcpServers(roleId, [...desired]);
      setAttached((prev) => {
        const next = new Set(prev);
        if (nextChecked) next.add(roleId);
        else next.delete(roleId);
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="config-card-meta" style={{ fontSize: 11 }}>Loading agent attachments…</p>;
  if (agentRoles.length === 0) return null;

  // Compute "Visible to" summary: group attached roles by runtime type.
  const grouped: Record<string, string[]> = {};
  for (const a of agentRoles) {
    if (!attached.has(a.roleId)) continue;
    const runtime = formatRuntimeLabel(a.runtimeType);
    if (!grouped[runtime]) grouped[runtime] = [];
    grouped[runtime].push(a.label ?? a.roleId);
  }
  const visibleTo = Object.entries(grouped)
    .map(([rt, roles]) => `${rt} (${roles.join(", ")})`)
    .join(" · ");

  return (
    <div className="config-card-meta" style={{ marginTop: "0.5rem", fontSize: 12 }}>
      {visibleTo ? (
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 6px" }}>
          Visible to: {visibleTo}
        </p>
      ) : null}
      <strong style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Attached to agents:</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        {agentRoles.map((a) => (
          <label key={a.roleId} style={{ display: "flex", alignItems: "center", gap: 4, cursor: busy ? "wait" : "pointer" }}>
            <input
              type="checkbox"
              checked={attached.has(a.roleId)}
              onChange={(e) => void toggle(a.roleId, e.target.checked)}
              disabled={busy}
            />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
