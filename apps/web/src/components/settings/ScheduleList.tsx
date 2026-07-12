import { useEffect, useState } from "react";

import { request } from "../../lib/request";

/**
 * Settings → Schedules — user-configurable recurring tasks (cron).
 *
 * Each schedule fires its prompt through the normal task pipeline at
 * the cron slot; spawned tasks show up on the Board like any other.
 * Backed by /schedules CRUD (routes/schedules.ts); the scheduler loop
 * lives in scheduled-task-service.ts.
 */

type Schedule = {
  id: string;
  name: string;
  cronExpr: string;
  prompt: string;
  workspaceId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SchedulesResponse = { items: Schedule[] };

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString();
}

const EMPTY_DRAFT = { name: "", cronExpr: "0 9 * * *", prompt: "" };

export function ScheduleList() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const data = await request<SchedulesResponse>("/schedules");
      setSchedules(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCreate(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await request("/schedules", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          cronExpr: draft.cronExpr.trim(),
          prompt: draft.prompt,
        }),
      });
      setDraft(EMPTY_DRAFT);
      setShowForm(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(schedule: Schedule): Promise<void> {
    setBusyId(schedule.id);
    try {
      await request(`/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle schedule");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(schedule: Schedule): Promise<void> {
    if (!window.confirm(`Delete schedule "${schedule.name}"? It will stop firing.`)) {
      return;
    }
    setBusyId(schedule.id);
    try {
      await request(`/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setBusyId(null);
    }
  }

  const canSave = draft.name.trim().length > 0 && draft.cronExpr.trim().length > 0 && draft.prompt.trim().length > 0;

  return (
    <div className="settings-section">
      <div className="settings-section__header">
        <div>
          <h2>Schedules</h2>
          <p>
            Recurring tasks on a cron expression (server-local time). Each trigger creates a
            normal task — it appears on the Board and in Chat. Example: <code>0 9 * * *</code>{" "}
            = every day at 09:00.
          </p>
        </div>
        <button type="button" className="config-button" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add schedule"}
        </button>
      </div>

      {error ? <p className="config-error">{error}</p> : null}

      {showForm ? (
        <div className="config-form">
          <label className="config-field">
            <span>Name</span>
            <input
              className="config-input"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Daily AI research digest"
            />
          </label>
          <label className="config-field">
            <span>Cron expression</span>
            <input
              className="config-input"
              value={draft.cronExpr}
              onChange={(e) => setDraft((d) => ({ ...d, cronExpr: e.target.value }))}
              placeholder="0 9 * * *"
            />
          </label>
          <label className="config-field">
            <span>Prompt</span>
            <textarea
              className="config-input"
              rows={4}
              value={draft.prompt}
              onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              placeholder="Research today's AI news and write a summary with sources."
            />
          </label>
          <button
            type="button"
            className="config-button config-button--primary"
            disabled={!canSave || saving}
            onClick={() => void handleCreate()}
          >
            {saving ? "Saving..." : "Create schedule"}
          </button>
        </div>
      ) : null}

      {loading ? <p>Loading…</p> : null}

      {schedules && schedules.length === 0 && !loading ? (
        <p className="config-empty">No schedules yet.</p>
      ) : null}

      {schedules && schedules.length > 0 ? (
        <table className="config-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Cron</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td title={s.prompt}>{s.name}</td>
                <td><code>{s.cronExpr}</code></td>
                <td>{s.enabled ? formatTimestamp(s.nextRunAt) : "paused"}</td>
                <td>
                  {formatTimestamp(s.lastRunAt)}
                  {s.lastError ? (
                    <span className="config-error" title={s.lastError}> ⚠</span>
                  ) : null}
                </td>
                <td>{s.enabled ? "enabled" : "disabled"}</td>
                <td>
                  <button
                    type="button"
                    className="config-button config-button--small"
                    disabled={busyId === s.id}
                    onClick={() => void handleToggle(s)}
                  >
                    {s.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    className="config-button config-button--small config-button--danger"
                    disabled={busyId === s.id}
                    onClick={() => void handleDelete(s)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
