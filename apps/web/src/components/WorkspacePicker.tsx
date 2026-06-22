import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { WorkspaceManagerModal } from "./WorkspaceManagerModal";

/**
 * Sidebar-top workspace picker — Path A.
 *
 * Picks the workspace the rest of the app filters/grounds against.
 * Shape mirrors Linear / Notion / Vercel: clickable header showing
 * the active label + chevron, drop-down listing workspaces with the
 * default flagged, and "+ Add workspace" / "Manage workspaces" at
 * the bottom.
 *
 * URL prefixing (`/w/:workspaceId/...`) lives in the AppShell
 * routing — this component just changes the active id; routes
 * react via the hook + URL parsing.
 */
export function WorkspacePicker({ onAfterSelect }: { onAfterSelect?: () => void } = {}) {
  const { workspaces, active, setActive, refresh } = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function selectWorkspace(id: string) {
    setActive(id);
    setOpen(false);
    // Re-route any /w/:wid path to the new workspace. Other paths
    // (settings, status, agents, skills) stay where they are — they
    // re-render their data scoped to the new active workspace via
    // the hook.
    //
    // Strip any trailing /:taskId / /:reviewId / etc. resource segment.
    // The task selected in the OLD workspace doesn't exist in the new
    // one, and ChatPage has a redirect effect that sniffs the task's
    // true workspace and bounces the URL back. Without this, picking a
    // new workspace looked like the picker silently failed.
    //
    // Keep only the top-level section (sessions / board / tasks),
    // drop the resource id. The page then loads the new workspace's
    // list with no resource selected.
    const match = location.pathname.match(/^\/w\/[^/]+(\/[^/]+)?(?:\/[^/]+)*\/?$/);
    if (match) {
      const section = match[1] ?? "";
      navigate(`/w/${id}${section}`);
    }
    // Close the mobile drawer if we're in it. Without this the URL
    // updates + session list refetches but the user can't see the
    // change because the drawer is still covering the main panel.
    // Desktop calls pass no onAfterSelect, so this is a no-op there.
    onAfterSelect?.();
  }

  return (
    <div className="workspace-picker" ref={containerRef}>
      <button
        type="button"
        className="workspace-picker__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch workspace"
      >
        <span className="workspace-picker__icon" aria-hidden>📁</span>
        <span className="workspace-picker__label-stack">
          <span className="workspace-picker__label">{active?.label ?? "Loading…"}</span>
          {active ? (
            <span className="workspace-picker__path" title={active.basePath}>{active.basePath}</span>
          ) : null}
        </span>
        <span className="workspace-picker__chevron" aria-hidden>▾</span>
      </button>

      {open ? (
        <div className="workspace-picker__menu" role="listbox" aria-label="Workspaces">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="option"
              aria-selected={active?.id === w.id}
              className={`workspace-picker__option${active?.id === w.id ? " workspace-picker__option--active" : ""}`}
              onClick={() => selectWorkspace(w.id)}
            >
              <span className="workspace-picker__option-check">
                {active?.id === w.id ? "✓" : ""}
              </span>
              <span className="workspace-picker__option-text">
                <span className="workspace-picker__option-label">
                  {w.label}
                  {w.isDefault ? <span className="workspace-picker__default-tag"> default</span> : null}
                </span>
                <span className="workspace-picker__option-path" title={w.basePath}>{w.basePath}</span>
              </span>
            </button>
          ))}
          <div className="workspace-picker__divider" />
          <button
            type="button"
            className="workspace-picker__action"
            onClick={() => { setOpen(false); setManagerOpen(true); }}
          >
            + Add workspace…
          </button>
          <button
            type="button"
            className="workspace-picker__action workspace-picker__action--muted"
            onClick={() => { setOpen(false); navigate("/settings?tab=workspaces"); }}
          >
            Manage workspaces…
          </button>
        </div>
      ) : null}

      {managerOpen ? (
        <WorkspaceManagerModal
          onClose={() => { setManagerOpen(false); void refresh(); }}
        />
      ) : null}
    </div>
  );
}
