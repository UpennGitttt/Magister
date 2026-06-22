import { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";

import { getSystemStatus } from "../lib/api";
import { request } from "../lib/request";
import { useActiveWorkspace } from "../hooks/useActiveWorkspace";
import { WorkspacePicker } from "./WorkspacePicker";

type NavItem = {
  to: string;
  label: string;
  end: boolean;
  // P3 mockup §sidebar — leading glyph + optional right-side count
  // badge ("Sessions 3"). Glyphs are unicode geometry to keep the
  // bundle font-only (no SVG sprite), per spec.
  glyph: string;
  badge?: { label: string; tone?: "live" | "neutral" };
};

type NavSection = {
  title: string;
  items: NavItem[];
};

// Path A — the WORKSPACE section's links carry the active workspace
// id (`/w/:wid/...`). Sections are computed from the active id at
// render time; CONFIGURATION stays workspace-agnostic. When the
// hook hasn't resolved yet (first-time visitor with empty
// localStorage), we fall back to the FLAT routes — those redirect
// to the correct `/w/<active>/...` once the registry loads. Hard-
// coding "default" here would point at a non-existent slug because
// the seed id is `workspace_main` for backward compatibility.
function buildSections(activeId: string | null, sessionsLive: number): NavSection[] {
  const widPrefix = activeId ? `/w/${activeId}` : "";
  const sessionsItem: NavItem = {
    to: `${widPrefix}/sessions`,
    label: "Sessions",
    end: false,
    glyph: "⌬",
  };
  if (sessionsLive > 0) {
    sessionsItem.badge = { label: String(sessionsLive), tone: "live" };
  }
  return [
    {
      title: "WORKSPACE",
      items: [
        { to: activeId ? widPrefix : "/", label: "Control Center", end: true, glyph: "◧" },
        { to: `${widPrefix}/board`, label: "Board", end: false, glyph: "▦" },
        sessionsItem,
      ],
    },
    {
      title: "CONFIGURATION",
      items: [
        { to: "/settings", label: "Settings", end: false, glyph: "⚙" },
      ],
    },
  ];
}

// Poll the workspace's task list every 30s and count tasks whose state
// rolls up to a "running"-ish bucket — surfaced as a count badge on the
// Sessions row in the sidebar. Mirrors the rollup used in ChatPage's
// session list "X live" string.
const SESSIONS_LIVE_REFRESH_MS = 30_000;
const RUNNING_STATE_TOKENS = [
  "running",
  "executing",
  "in_progress",
  "reviewing",
  "testing",
  "intake",
  "clarifying",
  "planning",
  "queued",
  "pending",
];

function useSessionsLiveCount(workspaceId: string | null): number {
  const [count, setCount] = useState<number>(0);
  useEffect(() => {
    if (!workspaceId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await request<{ items?: Array<{ state?: string }> } | Array<{ state?: string }>>(
          `/tasks?limit=50&workspaceId=${encodeURIComponent(workspaceId)}`,
        );
        if (cancelled) return;
        const items = Array.isArray(res) ? res : res.items ?? [];
        const live = items.filter((task) => {
          const s = (task.state ?? "").toLowerCase();
          return RUNNING_STATE_TOKENS.some((token) => s.includes(token));
        }).length;
        setCount(live);
      } catch {
        // best-effort — leave the previous count in place
      }
    };
    void poll();
    const id = setInterval(() => void poll(), SESSIONS_LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceId]);
  return count;
}

type HealthState = "ok" | "warn" | "down" | "unknown";

// Poll the system-status endpoint every 30s. The badge previously
// hardcoded "Operational" — that lied to the user when the API
// was down (we'd still render the green pill while their request
// hung). Now the polling distinguishes:
//   ok      — endpoint returned successfully
//   warn    — endpoint returned but server is reporting issues
//   down    — fetch threw (server unreachable / 5xx)
//   unknown — first poll hasn't completed yet
const HEALTH_POLL_INTERVAL_MS = 30_000;

function useSystemHealth(): HealthState {
  const [state, setState] = useState<HealthState>("unknown");
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const status = await getSystemStatus();
        if (cancelled) return;
        // SystemStatus has no top-level distress field — the
        // server reports state nested under `workers.*` and
        // `integrations.*`. Walk the actual nested shape and
        // classify "degraded" as: Feishu gateway in error, OR
        // a worker recently reported a failure / blocked run.
        // The previous version probed top-level keys that don't
        // exist (`status.degraded`, `status.failing`, etc.) so
        // the warn branch was unreachable on a successful poll.
        const feishuErrored = status.integrations?.feishuGateway?.connectionState === "error";
        const recoveryBlocked =
          (status.workers?.runtimeRecovery?.lastBlockedRunIds?.length ?? 0) > 0;
        const retentionFailing = Boolean(status.workers?.artifactRetention?.lastFailureAt);
        const degraded = feishuErrored || recoveryBlocked || retentionFailing;
        setState(degraded ? "warn" : "ok");
      } catch {
        if (!cancelled) setState("down");
      }
    }
    void poll();
    const handle = setInterval(() => void poll(), HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);
  return state;
}

function healthBadgeProps(state: HealthState): { label: string; tone: "ok" | "warn" | "down" | "unknown" } {
  switch (state) {
    case "ok":
      return { label: "Operational", tone: "ok" };
    case "warn":
      return { label: "Degraded", tone: "warn" };
    case "down":
      return { label: "API unreachable", tone: "down" };
    case "unknown":
    default:
      return { label: "Checking…", tone: "unknown" };
  }
}

function formatClockTime(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function useNowTick(intervalMs: number): string {
  const [now, setNow] = useState(formatClockTime());
  useEffect(() => {
    const handle = setInterval(() => setNow(formatClockTime()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

const SIDEBAR_COLLAPSED_KEY = "magister:sidebar-collapsed";

function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

export function Sidebar({ mobileOpen = false, onClose }: { mobileOpen?: boolean; onClose?: () => void }) {
  const health = useSystemHealth();
  const badge = healthBadgeProps(health);
  const { activeId } = useActiveWorkspace();
  const sessionsLive = useSessionsLiveCount(activeId);
  const sections = buildSections(activeId, sessionsLive);
  const clockTime = useNowTick(30_000);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  return (
    <aside
      className="sidebar"
      data-mobile-open={mobileOpen ? "true" : "false"}
      data-collapsed={collapsed ? "true" : undefined}
      role={mobileOpen ? "dialog" : undefined}
      aria-modal={mobileOpen ? true : undefined}
      aria-label={mobileOpen ? "Navigation" : undefined}
    >
      <div className="sidebar__header">
        <div className="sidebar__brand">
          <img className="sidebar__logo" src="/icon.svg" alt="" aria-hidden="true" />
          <div className="sidebar__brand-text">
            <p className="sidebar__title">Magister</p>
            <p className="sidebar__subtitle">Agent Control Plane</p>
          </div>
        </div>
        <button
          type="button"
          className="sidebar__close"
          aria-label="Close navigation"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <WorkspacePicker {...(onClose ? { onAfterSelect: onClose } : {})} />

      <nav className="sidebar__nav" aria-label="Sidebar navigation">
        {sections.map((section) => (
          <section className="sidebar__section" key={section.title}>
            <p className="sidebar__section-title">{section.title}</p>
            <div className="sidebar__section-items">
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `sidebar__item${isActive ? " sidebar__item--active" : ""}`
                  }
                  onClick={onClose}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="sidebar__item-glyph" aria-hidden="true">{item.glyph}</span>
                  <span className="sidebar__item-label">{item.label}</span>
                  {item.badge ? (
                    <span
                      className={`sidebar__item-badge${item.badge.tone === "live" ? " sidebar__item-badge--live" : ""}`}
                    >
                      {item.badge.label}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="sidebar__health" data-tone={badge.tone} title={collapsed ? `${badge.label} · ${clockTime}` : undefined}>
        <span className="sidebar__health-dot" aria-hidden="true" />
        <span className="sidebar__health-label">{badge.label}</span>
        <span className="sidebar__health-time" aria-label={`Updated ${clockTime}`}>{clockTime}</span>
      </div>

      <button
        type="button"
        className="sidebar__collapse-toggle"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={toggleCollapsed}
      >
        <span aria-hidden="true">{collapsed ? "▸" : "◂"}</span>
      </button>
    </aside>
  );
}
