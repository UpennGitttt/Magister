import { useEffect, useState } from "react";

import { request } from "../../lib/request";

/**
 * Settings → Approval Rules (Spec §1 V1.1).
 *
 * Lists every persisted `command_approval_rules` row with its
 * pattern preview, scope, hit-count, and an enable/disable toggle
 * + delete. Reads through the dedicated `/approval-rules` routes
 * (not lib/api.ts — that file is in the user's pending UI diff and
 * staying off limits for this slice).
 *
 * Rule CREATION is NOT in this UI: rules are born from the bash
 * approval flow's "Approve + save rule" decision (set
 * `save_rule: true` on POST /approvals/:id/resolve). This page is
 * the management surface — list, audit, revoke.
 */

type ApprovalRule = {
  id: string;
  tool: string;
  patternKind: string;
  patternJson: string;
  patternPreview: string;
  scope: string;
  projectPath: string | null;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string | null;
  enabled: boolean;
  hitCount: number;
  lastHitAt: string | null;
  justificationTemplate: string | null;
};

type ApprovalRulesResponse = { items: ApprovalRule[] };

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString();
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "never";
  const ageMs = Math.max(0, Date.now() - t);
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  return `${Math.floor(hour / 24)}d ago`;
}

export function ApprovalRulesTable() {
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const data = await request<ApprovalRulesResponse>("/approval-rules");
      setRules(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approval rules");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleToggle(rule: ApprovalRule): Promise<void> {
    setBusyId(rule.id);
    try {
      await request(`/approval-rules/${encodeURIComponent(rule.id)}`, {
        method: "POST",
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle rule");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(rule: ApprovalRule): Promise<void> {
    if (!window.confirm(`Delete rule "${rule.patternPreview}"? Future matching commands will go through approval again.`)) {
      return;
    }
    setBusyId(rule.id);
    try {
      await request(`/approval-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete rule");
    } finally {
      setBusyId(null);
    }
  }

  if (loading && rules === null) {
    return <p className="settings-loading">Loading approval rules…</p>;
  }
  if (error && rules === null) {
    return <p className="settings-error">{error}</p>;
  }
  const items = rules ?? [];

  return (
    <section className="approval-rules" aria-label="Approval rules">
      <div className="approval-rules__intro">
        <p>
          Persistent rules for the bash sandbox escalation protocol. Rules are created when you click <strong>Approve + save rule</strong> on a bash escalation prompt; matching future commands run without re-prompting.
        </p>
        <p className="approval-rules__meta">
          {items.length === 0 ? (
            "No rules yet — they appear here after you approve a bash escalation with a learnable prefix."
          ) : (
            <>{items.length} rule{items.length === 1 ? "" : "s"} ({items.filter((r) => r.enabled).length} enabled)</>
          )}
        </p>
      </div>

      {error && <p className="settings-error">{error}</p>}

      {items.length > 0 && (
        <div className="approval-rules__table-wrap">
          <table className="approval-rules__table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Scope</th>
                <th>Hits</th>
                <th>Last hit</th>
                <th>Approved</th>
                <th>Status</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((rule) => (
                <tr key={rule.id} className={!rule.enabled ? "approval-rules__row--disabled" : ""}>
                  <td>
                    <code className="approval-rules__pattern">{rule.patternPreview}</code>
                    <span className="approval-rules__kind">{rule.patternKind}</span>
                  </td>
                  <td>
                    {rule.scope}
                    {rule.scope === "project" && rule.projectPath ? (
                      <span className="approval-rules__path" title={rule.projectPath}>
                        {rule.projectPath.split("/").slice(-2).join("/")}
                      </span>
                    ) : null}
                  </td>
                  <td>{rule.hitCount}</td>
                  <td title={formatTimestamp(rule.lastHitAt)}>{formatRelative(rule.lastHitAt)}</td>
                  <td title={formatTimestamp(rule.approvedAt)}>{formatRelative(rule.approvedAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="approval-rules__toggle"
                      onClick={() => void handleToggle(rule)}
                      disabled={busyId === rule.id}
                      aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.patternPreview}`}
                    >
                      {rule.enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="approval-rules__delete"
                      onClick={() => void handleDelete(rule)}
                      disabled={busyId === rule.id}
                      aria-label={`Delete rule ${rule.patternPreview}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
