import { WorkspaceList } from "./settings/WorkspaceList";

/**
 * Path A — workspace management modal. Now just a modal wrapper
 * around `WorkspaceList`; the same content also renders inline as
 * a Settings → Workspaces tab. Both surfaces share the row + add
 * form components defined in WorkspaceList for consistency.
 *
 * Inline confirm step  lives inside
 * `WorkspaceRow` — replaces the previous `window.confirm()` which
 * was mobile-hostile (modal-on-modal renders weirdly on iOS / web
 * views) and accessibility-poor (browser confirm doesn't pass
 * focus management).
 */
export function WorkspaceManagerModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Workspace manager">
      <div className="modal-content workspace-manager">
        <header className="modal-header">
          <h2>Manage workspaces</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div style={{ padding: "12px 20px 20px" }}>
          <WorkspaceList heading={false} />
        </div>
      </div>
    </div>
  );
}
