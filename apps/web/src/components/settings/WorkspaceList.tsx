import { useEffect, useRef, useState } from "react";

import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  setDefaultWorkspace,
  updateWorkspace,
  type WorkspaceView,
} from "../../lib/api";

/**
 * Workspaces management surface used in two places:
 *   - Settings → Workspaces tab (inline, full-width)
 *   - Sidebar workspace picker → "Manage workspaces" modal
 *
 * The same row + add-form components render in both contexts; the
 * modal just wraps `<WorkspaceList />` in modal chrome (see
 * `../WorkspaceManagerModal.tsx`).
 */
export function WorkspaceList({ heading = true }: { heading?: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    try {
      setLoading(true);
      setError(null);
      setWorkspaces(await listWorkspaces());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  return (
    <div>
      {heading ? (
        <header className="settings-section-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2>Workspaces</h2>
            <p style={{ margin: 0, color: "var(--ink-3)" }}>
              Project directories the agent can operate on. The default
              workspace seeds new tasks created without an explicit
              workspaceId; the picker in the sidebar switches the active
              one.
            </p>
          </div>
          <button type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </header>
      ) : null}

      {error ? <div className="modal-error">{error}</div> : null}
      {loading && workspaces.length === 0 ? <p>Loading…</p> : null}

      <ul className="workspace-manager__list">
        {workspaces.map((w) => (
          <WorkspaceRow key={w.id} workspace={w} workspaces={workspaces} onChanged={reload} />
        ))}
      </ul>

      {showAdd ? (
        <AddWorkspaceForm
          onCancel={() => setShowAdd(false)}
          onCreated={async () => { setShowAdd(false); await reload(); }}
        />
      ) : (
        <button type="button" className="workspace-manager__add" onClick={() => setShowAdd(true)}>
          + Add workspace
        </button>
      )}
    </div>
  );
}

export function WorkspaceRow({
  workspace,
  workspaces,
  onChanged,
}: {
  workspace: WorkspaceView;
  workspaces: WorkspaceView[];
  onChanged: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [label, setLabel] = useState(workspace.label);
  const [basePath, setBasePath] = useState(workspace.basePath);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mounted guard for the post-`onChanged` finally branch — kimi
  // review M2: parent typically removes the row on a successful
  // delete, so finally state-setters would otherwise warn about
  // an unmounted component update.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // Timer ref so `remove()` can cancel the auto-revert before the
  // API call fires .
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Confirm button ref so we can move keyboard focus when the
  // delete button gets unmounted by the row swap .
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  function startEdit() {
    // Kimi review M3 — clear delete-confirm state when entering
    // edit mode so an armed-then-edit-cancelled flow doesn't reveal
    // a stale red row when the user comes back.
    setConfirmingDelete(false);
    if (revertTimerRef.current) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
    setError(null);
    setEditing(true);
  }

  async function saveEdit() {
    try {
      setBusy(true);
      setError(null);
      await updateWorkspace(workspace.id, { label, basePath });
      if (mounted.current) setEditing(false);
      await onChanged();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Update failed");
    } finally { if (mounted.current) setBusy(false); }
  }

  async function makeDefault() {
    try {
      setBusy(true);
      setError(null);
      await setDefaultWorkspace(workspace.id);
      await onChanged();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Failed to set default");
    } finally { if (mounted.current) setBusy(false); }
  }

  async function remove() {
    // Two-state inline confirm — the previous
    // window.confirm() as mobile-hostile. Click 1 → confirmingDelete=true,
    // row turns red and shows a "Confirm delete" button. Click 2
    // calls the API.
    //
    // Cancel the auto-revert timer BEFORE the API call so the
    // delete UI doesn't flip back to "Delete" mid-request (kimi M1).
    if (revertTimerRef.current) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
    try {
      setBusy(true);
      setError(null);
      await deleteWorkspace(workspace.id);
      await onChanged();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      if (mounted.current) {
        setBusy(false);
        setConfirmingDelete(false);
      }
    }
  }

  // Auto-revert the confirm state after 3s — prevents a forgotten
  // "armed" delete button from going off later by accident. The
  // timer id lives in revertTimerRef so `remove()` can cancel it
  // before the API call fires.
  useEffect(() => {
    if (!confirmingDelete) {
      // Defensive cleanup if state was reset by something other
      // than the timer (e.g. startEdit).
      if (revertTimerRef.current) {
        clearTimeout(revertTimerRef.current);
        revertTimerRef.current = null;
      }
      return;
    }
    revertTimerRef.current = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => {
      if (revertTimerRef.current) {
        clearTimeout(revertTimerRef.current);
        revertTimerRef.current = null;
      }
    };
  }, [confirmingDelete]);

  // Move keyboard focus to the Confirm button when the inline
  // confirm appears, so a user navigating with Tab/Enter doesn't
  // get stranded on a button that was just unmounted (kimi M4).
  useEffect(() => {
    if (confirmingDelete && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [confirmingDelete]);

  return (
    <li className={`workspace-manager__row${confirmingDelete ? " workspace-manager__row--confirming" : ""}`}>
      {editing ? (
        <div className="workspace-manager__edit">
          <label>
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
          </label>
          <label>
            <span>Path</span>
            <input value={basePath} onChange={(e) => setBasePath(e.target.value)} disabled={busy} />
          </label>
          {error ? <div className="modal-error">{error}</div> : null}
          <div className="workspace-manager__edit-actions">
            <button type="button" onClick={() => { setEditing(false); setError(null); }} disabled={busy}>Cancel</button>
            <button type="button" className="primary" onClick={() => void saveEdit()} disabled={busy}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div className="workspace-manager__row-text">
            <strong>{workspace.label}</strong>
            {workspace.isDefault ? <span className="workspace-manager__default-tag">default</span> : null}
            <code title={workspace.basePath}>{workspace.basePath}</code>
            <span className="workspace-manager__id">id: {workspace.id}</span>
          </div>
          <div className="workspace-manager__row-actions">
            {confirmingDelete ? (
              <>
                <span className="workspace-manager__confirm-prompt">Delete this workspace?</span>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  className="danger"
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  {busy ? "Deleting…" : "Confirm delete"}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={startEdit} disabled={busy}>Rename / Path</button>
                {!workspace.isDefault ? (
                  <button type="button" onClick={() => void makeDefault()} disabled={busy}>Set default</button>
                ) : null}
                <button
                  type="button"
                  className="danger"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy || workspace.isDefault || workspaces.length <= 1}
                  title={workspace.isDefault ? "Set another workspace as default first" : workspaces.length <= 1 ? "At least one workspace required" : ""}
                >
                  Delete
                </button>
              </>
            )}
          </div>
          {error ? <div className="modal-error">{error}</div> : null}
        </>
      )}
    </li>
  );
}

export function AddWorkspaceForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [basePath, setBasePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await createWorkspace({ id, label, basePath });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally { setBusy(false); }
  }

  return (
    <form className="workspace-manager__form" onSubmit={submit}>
      <h3>Add workspace</h3>
      <label>
        <span>ID (slug)</span>
        <input
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
          placeholder="myapp"
          required
          disabled={busy}
        />
      </label>
      <label>
        <span>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="MyApp"
          required
          disabled={busy}
        />
      </label>
      <label>
        <span>Path</span>
        <input
          value={basePath}
          onChange={(e) => setBasePath(e.target.value)}
          placeholder="/opt/projects/myapp"
          required
          disabled={busy}
        />
      </label>
      {error ? <div className="modal-error">{error}</div> : null}
      <div className="workspace-manager__form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !id || !label || !basePath}>Add</button>
      </div>
    </form>
  );
}
