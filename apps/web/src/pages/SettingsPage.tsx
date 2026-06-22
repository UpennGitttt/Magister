import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import "../styles/settings.css";
import {
  getAgentProfiles,
  getMcpServers,
  getModels,
  getProviders,
  getSkills,
  listWorkspaces,
} from "../lib/api";
import { ProviderList } from "../components/settings/ProviderList";
import { ModelList } from "../components/settings/ModelList";
import { BindingList } from "../components/settings/BindingList";
import { RoleRoutingTable } from "../components/settings/RoleRoutingTable";
import { SkillList } from "../components/settings/SkillList";
import { AgentList } from "../components/settings/AgentList";
import { McpServerList } from "../components/settings/McpServerList";
import { MemoryList } from "../components/settings/MemoryList";
import { WorkspaceList } from "../components/settings/WorkspaceList";
import { DiagnosticsPanel } from "../components/settings/DiagnosticsPanel";
import { ApprovalRulesTable } from "../components/settings/ApprovalRulesTable";
import { OnboardingWizard } from "../components/settings/OnboardingWizard";

type Tab = "setup" | "providers" | "models" | "bindings" | "agents" | "roles" | "skills" | "mcp" | "memory" | "workspaces" | "approval-rules" | "diagnostics";

// The configuration model is **agent → model → provider** — a Role
// gets a row in `agent_profiles` that names a model and a provider
// directly. The legacy `bindings` + `roleRouting` path is still
// honored at runtime for backward compatibility but is intentionally
// not exposed in the UI: redundant with the agent-direct path and
// just adds a layer of indirection users have to map in their head.
//
// `BindingList` / `RoleRoutingTable` are kept in the codebase rather
// than deleted so flipping the tabs back on (e.g. for support / debug
// of legacy configs) is a one-line change here. Backend routes
// (`/settings/bindings`, `/settings/role-routing`) are also still
// live for the same reason.
const TABS: Array<{ id: Tab; label: string }> = [
  // Workspaces tab — Path A discoverability. Same content as the
  // sidebar picker's "Manage workspaces" modal but inline + stays
  // open while the user navigates other tabs.
  //
  // Note: the old read-only Status tab is gone. The chat `/status`
  // slash command now injects the workspace+session snapshot inline
  // as a system message in the conversation (see
  // `formatStatusReportForChat` + `pushLocalDiagnostic`) — that
  // surface stays bound to the active session, where the report
  // actually means something, instead of a Settings sub-tab that
  // duplicated agent/MCP/skill info already on this page.
  // Setup — first-run onboarding wizard for the external CLI coding
  // agents (codex / claude-code / opencode). Placed first so new users
  // land here to get install + login state before configuring roles.
  { id: "setup", label: "Setup" },
  { id: "workspaces", label: "Workspaces" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  // Memory — read-only view of the leader's accumulated memory store
  // (M5 Phase 1). Writes happen via the leader's upsert_memory tool so
  // every change shows up in the runtime trace.
  { id: "memory", label: "Memory" },
  // Approval Rules — persistent rules from the bash sandbox
  // escalation protocol (spec §1). New in V1.1.
  { id: "approval-rules", label: "Approval Rules" },
  // Diagnostics — operator visibility into long-running runtime
  // behavior that's invisible from chat alone (compaction history;
  // future: doom-loop incidents, retry storms, etc.).
  { id: "diagnostics", label: "Diagnostics" },
];

const VALID_TABS = new Set<Tab>(TABS.map((t) => t.id));

function tabFromQuery(value: string | null): Tab | null {
  if (!value) return null;
  return VALID_TABS.has(value as Tab) ? (value as Tab) : null;
}

export function SettingsPage({ defaultTab }: { defaultTab?: Tab } = {}) {
  // `?tab=...` query string is the source of truth so links like
  // `/settings?tab=diagnostics` (e.g. from a chat slash command or a
  // bug-report URL) land on the right panel. Invalid values fall
  // back to `defaultTab` and finally to "providers".
  const [searchParams, setSearchParams] = useSearchParams();
  const queryTab = tabFromQuery(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState<Tab>(
    queryTab ?? defaultTab ?? "providers",
  );

  // Keep state in sync when the user navigates back/forward or types
  // a new query in the URL bar. Skip when query already matches state
  // (avoids resetting the tab when WE update the query below).
  useEffect(() => {
    const nextTab = queryTab ?? defaultTab ?? "providers";
    if (nextTab !== activeTab) {
      setActiveTab(nextTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryTab, defaultTab]);

  function handleTabChange(next: Tab) {
    setActiveTab(next);
    // Reflect the chosen tab in the URL so the page is bookmarkable
    // and refresh keeps the user on the same panel. `replace: true`
    // avoids polluting history with one entry per tab click.
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    setSearchParams(nextParams, { replace: true });
  }

  // Best-effort tab counts. The spec (§5.6) calls these out as a
  // scan aid in the left rail — e.g. "Agents 5", "MCP 3". We fetch
  // once on mount and tolerate any individual failure (the count
  // simply doesn't render for that tab).
  const [counts, setCounts] = useState<Partial<Record<Tab, number>>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fetchers: Array<[Tab, Promise<number>]> = [
        ["workspaces", listWorkspaces().then((r) => r.length).catch(() => NaN)],
        ["providers", getProviders().then((r) => r.items.length).catch(() => NaN)],
        ["models", getModels().then((r) => r.items.length).catch(() => NaN)],
        ["agents", getAgentProfiles().then((r) => r.items.length).catch(() => NaN)],
        ["skills", getSkills().then((r) => r.items.length).catch(() => NaN)],
        ["mcp", getMcpServers().then((r) => r.items.length).catch(() => NaN)],
      ];
      const results = await Promise.all(fetchers.map(([, p]) => p));
      if (cancelled) return;
      const next: Partial<Record<Tab, number>> = {};
      for (let i = 0; i < fetchers.length; i++) {
        const n = results[i];
        const f = fetchers[i];
        if (typeof n === "number" && Number.isFinite(n) && f) {
          next[f[0]] = n;
        }
      }
      setCounts(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-page">
      <header className="settings-page__header">
        <h1>Settings</h1>
        <p>Each Agent is bound to a Model, which is bound to a Provider. Skills and MCP servers attach per-agent.</p>
      </header>

      <div className="settings-page__layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((tab) => {
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav__item${activeTab === tab.id ? " settings-nav__item--active" : ""}`}
                onClick={() => handleTabChange(tab.id)}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                <span>{tab.label}</span>
                {typeof count === "number" ? (
                  <span className="settings-nav__count">{count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <section className="settings-content" role="tabpanel" aria-label={`${activeTab} settings`}>
          {activeTab === "setup" && <OnboardingWizard />}
          {activeTab === "providers" && <ProviderList />}
          {activeTab === "models" && <ModelList />}
          {activeTab === "bindings" && <BindingList />}
          {activeTab === "agents" && <AgentList />}
          {activeTab === "roles" && <RoleRoutingTable />}
          {activeTab === "skills" && <SkillList />}
          {activeTab === "mcp" && <McpServerList />}
          {activeTab === "memory" && <MemoryList />}
          {activeTab === "workspaces" && <WorkspaceList />}
          {activeTab === "approval-rules" && <ApprovalRulesTable />}
          {activeTab === "diagnostics" && <DiagnosticsPanel />}
        </section>
      </div>
    </div>
  );
}
