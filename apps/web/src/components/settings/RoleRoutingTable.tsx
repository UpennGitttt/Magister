import { useEffect, useMemo, useRef, useState } from "react";
import { getAgentProfiles, updateAgentProfile } from "../../lib/api";
import { formatRuntimeLabel } from "../../lib/runtimeLabels";
import type { AgentProfile } from "../../lib/types";

// `manager` intentionally NOT in this list. The leader agent
// (built-in `Leader`) maps `manager → leader` via
// `config/executors.json` `roleMapping`, but this table assumes
// roleId == agentProfile.roleId for assignment, so adding `manager`
// here causes the auto-save PUT to upsert a new `manager` agent
// profile and produce a phantom legacy coordinator duplicate. Edit the
// leader agent via the Agents tab instead.
const FIXED_ROLES = ["architect", "coder", "reviewer", "lander", "deepresearcher"] as const;
type FixedRole = (typeof FIXED_ROLES)[number];

type RowState = {
  saving: boolean;
  error: string | null;
  success: boolean;
};

type RoleSelectionMap = Record<FixedRole, string>;
type RoleStateMap = Record<FixedRole, RowState>;

const DEFAULT_ROW_STATE: RowState = {
  saving: false,
  error: null,
  success: false,
};

function titleCase(value: string) {
  return value
    .replace(/[_.-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeRuntimeType(value: AgentProfile["runtimeType"]): "ucm" | "codex" | "opencode" | "claude-code" | "kiro" {
  if (value === "codex" || value === "opencode" || value === "claude-code" || value === "kiro") {
    return value;
  }
  return "ucm";
}

function buildDefaultSelections(profiles: AgentProfile[]): RoleSelectionMap {
  return FIXED_ROLES.reduce<RoleSelectionMap>((acc, role) => {
    acc[role] = profiles.some((profile) => profile.roleId === role) ? role : "";
    return acc;
  }, {
    architect: "",
    coder: "",
    reviewer: "",
    lander: "",
    deepresearcher: "",
  });
}

function buildDefaultRoleState(): RoleStateMap {
  return FIXED_ROLES.reduce<RoleStateMap>((acc, role) => {
    acc[role] = { ...DEFAULT_ROW_STATE };
    return acc;
  }, {
    architect: { ...DEFAULT_ROW_STATE },
    coder: { ...DEFAULT_ROW_STATE },
    reviewer: { ...DEFAULT_ROW_STATE },
    lander: { ...DEFAULT_ROW_STATE },
    deepresearcher: { ...DEFAULT_ROW_STATE },
  });
}

function sortProfiles(items: AgentProfile[]): AgentProfile[] {
  return [...items].sort((a, b) => {
    const left = (a.label?.trim() || a.roleId).toLowerCase();
    const right = (b.label?.trim() || b.roleId).toLowerCase();
    return left.localeCompare(right);
  });
}

function formatAgentOption(profile: AgentProfile): string {
  const label = profile.label?.trim() || profile.roleId;
  const runtime = normalizeRuntimeType(profile.runtimeType);
  return `${label} (${runtime})`;
}

function toUpdatePayload(source: AgentProfile): Partial<AgentProfile> {
  return {
    label: source.label ?? null,
    description: source.description ?? null,
    systemPromptOverride: source.systemPromptOverride ?? null,
    modelOverride: source.modelOverride ?? null,
    maxTurns: source.maxTurns ?? null,
    toolProfile: source.toolProfile ?? null,
    runtimeType: source.runtimeType ?? null,
  };
}

export function RoleRoutingTable() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selections, setSelections] = useState<RoleSelectionMap>(() => buildDefaultSelections([]));
  const [rowState, setRowState] = useState<RoleStateMap>(() => buildDefaultRoleState());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const clearSuccessTimeoutsRef = useRef<Partial<Record<FixedRole, number>>>({});

  const profileMap = useMemo(() => {
    return new Map(profiles.map((profile) => [profile.roleId, profile] as const));
  }, [profiles]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await getAgentProfiles();
        if (cancelled) return;
        const sorted = sortProfiles(data.items);
        setProfiles(sorted);
        setSelections(buildDefaultSelections(sorted));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load agent profiles");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      for (const timeoutId of Object.values(clearSuccessTimeoutsRef.current)) {
        if (typeof timeoutId === "number") {
          window.clearTimeout(timeoutId);
        }
      }
    };
  }, []);

  function setSingleRowState(role: FixedRole, patch: Partial<RowState>) {
    setRowState((prev) => ({
      ...prev,
      [role]: {
        ...prev[role],
        ...patch,
      },
    }));
  }

  function scheduleSuccessReset(role: FixedRole) {
    const existing = clearSuccessTimeoutsRef.current[role];
    if (typeof existing === "number") {
      window.clearTimeout(existing);
    }

    clearSuccessTimeoutsRef.current[role] = window.setTimeout(() => {
      setSingleRowState(role, { success: false });
      delete clearSuccessTimeoutsRef.current[role];
    }, 1400);
  }

  async function refreshProfiles() {
    const data = await getAgentProfiles();
    const sorted = sortProfiles(data.items);
    setProfiles(sorted);
    setSelections(buildDefaultSelections(sorted));
  }

  async function assignRole(role: FixedRole, selectedProfileRoleId: string, previousSelection: string) {
    if (!selectedProfileRoleId) {
      setSelections((prev) => ({ ...prev, [role]: previousSelection }));
      return;
    }

    const source = profileMap.get(selectedProfileRoleId);
    if (!source) {
      setSelections((prev) => ({ ...prev, [role]: previousSelection }));
      setSingleRowState(role, {
        error: "Selected agent profile not found.",
        saving: false,
        success: false,
      });
      return;
    }

    setSingleRowState(role, {
      saving: true,
      error: null,
      success: false,
    });

    try {
      await updateAgentProfile(role, toUpdatePayload(source));
      await refreshProfiles();
      setSingleRowState(role, {
        saving: false,
        error: null,
        success: true,
      });
      scheduleSuccessReset(role);
    } catch (err) {
      setSelections((prev) => ({ ...prev, [role]: previousSelection }));
      setSingleRowState(role, {
        saving: false,
        error: err instanceof Error ? err.message : "Failed to save role",
        success: false,
      });
    }
  }

  function handleSelectChange(role: FixedRole, nextValue: string) {
    const previousSelection = selections[role] ?? "";
    if (nextValue === previousSelection) {
      return;
    }

    setSelections((prev) => ({ ...prev, [role]: nextValue }));
    void assignRole(role, nextValue, previousSelection);
  }

  if (loading) return <p className="settings-loading">Loading roles…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  return (
    <section className="config-card role-mapping-card" aria-label="Role to agent mapping">
      <header className="config-card-header">
        <strong>Role Mapping</strong>
      </header>
      <p className="config-card-meta">Each role maps to one agent profile and saves automatically.</p>

      <div className="role-mapping-list">
        {FIXED_ROLES.map((role) => {
          const state = rowState[role];
          const selectedProfileRoleId = selections[role] ?? "";
          const selectedProfile = selectedProfileRoleId ? profileMap.get(selectedProfileRoleId) : profileMap.get(role);
          const runtimeType = selectedProfile
            ? normalizeRuntimeType(selectedProfile.runtimeType ?? "ucm")
            : null;

          return (
            <div key={role} className="role-mapping-row">
              <div className="role-mapping-role">
                <span className="role-badge">{titleCase(role)}</span>
              </div>

              <div className="role-mapping-control">
                <select
                  className="config-input role-mapping-select"
                  value={selectedProfileRoleId}
                  onChange={(event) => handleSelectChange(role, event.target.value)}
                  disabled={state.saving || profiles.length === 0}
                  aria-label={`${titleCase(role)} agent`}
                >
                  <option value="">Select agent…</option>
                  {profiles.map((profile) => (
                    <option key={profile.roleId} value={profile.roleId}>
                      {formatAgentOption(profile)}
                    </option>
                  ))}
                </select>

                {runtimeType ? (
                  <span className="status-badge status-subtle role-runtime-badge">
                    {formatRuntimeLabel(runtimeType)}
                  </span>
                ) : null}

                {state.saving ? (
                  <span className="role-row-status">Saving…</span>
                ) : null}
                {state.success ? (
                  <span className="role-row-status role-row-status--success">✓ Saved</span>
                ) : null}
              </div>

              {state.error ? <p className="role-row-error">{state.error}</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
