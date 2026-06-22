/**
 * Skills tab — unified view + management of the machine-wide skill
 * pool (`~/.agents/skills/`). Read-through against the filesystem;
 * the Magister DB only carries leader's attachment rows. Everything
 * mutating goes through `/skills*` endpoints which orchestrate
 * filesystem + symlinks + DB.
 *
 * Operations supported:
 *   - Import from GitHub (POST /skills/import → npx skills add)
 *   - Create a manual skill (POST /skills → writes SKILL.md)
 *   - Edit a manual skill (PUT /skills/:name)
 *   - Refresh GitHub-sourced skill (POST /skills/:name/refresh)
 *   - Delete (DELETE /skills/:name)
 *   - Toggle attachment per agent (PUT /agents/:role/skills)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import { Pill } from "../ui/Pill";
import {
  createManualSkill,
  deleteSkillFromPool,
  getExternalSkills,
  getSkillDetail,
  getSkills,
  importSkillFromGithub,
  refreshSkill,
  resetBundledSkill,
  scanCliBridges,
  setAgentSkills,
  updateManualSkill,
  type CliBridgeScan,
  type CliRuntime,
  type ExternalSkillEntry,
  type SkillAgentRole,
  type SkillStatus,
  type SkillView,
} from "../../lib/api";

const AGENT_ROLES: ReadonlyArray<{ id: SkillAgentRole; label: string }> = [
  { id: "leader", label: "Leader" },
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
];

function formatRelativeDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function shortenSourceUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

export function SkillList() {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  // Per-role serialization queue. The /agents/:roleId/skills PUT
  // is a FULL REPLACE — handler N reads the current attachment
  // set and computes `desired` against it. If two toggles fire on
  // the same role before the first PUT (and its load() refresh)
  // settle, handler 2 sees the stale snapshot and its desired
  // set silently drops handler 1's new attachment.
  //
  // Fix: chain each toggle for a given role onto the prior
  // promise. The chained handler reads `skillsRef.current`
  // (mirrored from `skills` state via the effect below) AT
  // EXECUTION TIME — by then handler 1's load() has refreshed
  // state and React has re-rendered, so the ref points at the
  // post-handler-1 set. Different roles still proceed in
  // parallel — the race only exists for same-role concurrent
  // toggles.
  //
  // Why a ref and not the `skills` state directly: closures
  // capture `skills` at the time `toggleAttachment` is INVOKED,
  // not at the time the chained `then` body executes. By the
  // time the body runs, the closure-captured `skills` is still
  // the snapshot from when the user clicked, which is exactly
  // the stale value we wanted to avoid.
  const [bridgeScan, setBridgeScan] = useState<CliBridgeScan | null>(null);

  const roleQueueRef = useRef<Map<SkillAgentRole, Promise<void>>>(new Map());
  const skillsRef = useRef<SkillView[]>([]);
  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const data = await getSkills();
      setSkills(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
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
  }, []);

  const totals = useMemo(() => {
    // Explicit per-kind filter so a future sourceKind doesn't
    // silently bucket into manual via subtraction. (codex review N4)
    const githubCount = skills.filter((s) => s.sourceKind === "github").length;
    const builtinCount = skills.filter((s) => s.sourceKind === "builtin").length;
    const manualCount = skills.filter((s) => s.sourceKind === "manual").length;
    return { total: skills.length, github: githubCount, manual: manualCount, builtin: builtinCount };
  }, [skills]);

  function setBusy(key: string, value: boolean) {
    setPending((prev) => {
      const next = { ...prev };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  async function toggleAttachment(skill: SkillView, role: SkillAgentRole, nextChecked: boolean) {
    const cellKey = `attach::${skill.name}::${role}`;
    setBusy(cellKey, true);
    setWarnings([]);

    // Chain onto the prior promise for this role. The handler
    // body MUST read `skills` (via the freshly-rendered closure
    // captured by the next render) only after the prior toggle's
    // `load()` has settled, otherwise we'd diff against stale
    // state and silently drop the prior toggle's attachment.
    const prior = roleQueueRef.current.get(role) ?? Promise.resolve();
    const next = prior.then(async () => {
      try {
        // Read from the ref so we get the post-prior-load() value,
        // not the stale closure-captured snapshot.
        const currentForRole = skillsRef.current
          .filter((s) => s.attachedAgents.includes(role))
          .map((s) => s.name);
        const desired = nextChecked
          ? Array.from(new Set([...currentForRole, skill.name]))
          : currentForRole.filter((n) => n !== skill.name);

        const result = await setAgentSkills(role, desired);
        if (result.failed.length > 0) {
          setWarnings(result.failed.map((f) => `${role} ${f.action} "${f.name}": ${f.error}`));
        }
        await load();
      } catch (err) {
        setWarnings([err instanceof Error ? err.message : `Failed to update ${role}/${skill.name}`]);
      } finally {
        setBusy(cellKey, false);
      }
    });
    // Catch in the chained ref so a single toggle failure doesn't
    // poison the entire queue for that role — subsequent toggles
    // still get to run.
    roleQueueRef.current.set(role, next.catch(() => undefined));
    await next;
  }

  async function handleRefresh(skill: SkillView) {
    const key = `refresh::${skill.name}`;
    setBusy(key, true);
    setWarnings([]);
    try {
      await refreshSkill(skill.name);
      await load();
    } catch (err) {
      setWarnings([err instanceof Error ? err.message : `Failed to refresh ${skill.name}`]);
    } finally {
      setBusy(key, false);
    }
  }

  async function handleResetOverride(skill: SkillView) {
    if (!window.confirm(
      `Reset "${skill.name}" to the Magister-bundled default?\n\n`
      + `This discards your customization (description and/or content). `
      + `The leader will see the repo version on its next turn.`
    )) {
      return;
    }
    const key = `reset::${skill.name}`;
    setBusy(key, true);
    setWarnings([]);
    try {
      await resetBundledSkill(skill.name);
      await load();
    } catch (err) {
      setWarnings([err instanceof Error ? err.message : `Failed to reset ${skill.name}`]);
    } finally {
      setBusy(key, false);
    }
  }

  async function handleDelete(skill: SkillView) {
    const attachedNote = skill.attachedAgents.length
      ? `\n\nIt's currently attached to: ${skill.attachedAgents.join(", ")}. Those attachments will be removed too.`
      : "";
    if (!window.confirm(`Delete skill "${skill.name}" from the pool?${attachedNote}\n\nThis removes ~/.agents/skills/${skill.name}/, all CLI symlinks, and the lock entry. Re-installable via Import for GitHub skills.`)) {
      return;
    }
    const key = `delete::${skill.name}`;
    setBusy(key, true);
    setWarnings([]);
    try {
      await deleteSkillFromPool(skill.name);
      await load();
    } catch (err) {
      setWarnings([err instanceof Error ? err.message : `Failed to delete ${skill.name}`]);
    } finally {
      setBusy(key, false);
    }
  }

  function findCliStatus(scan: CliBridgeScan | null, skillName: string): Partial<Record<CliRuntime, SkillStatus>> {
    if (!scan) return {};
    const inPool = scan.skills.inPool.find((s) => s.name === skillName);
    if (inPool) return inPool.perCli;
    const inPrivate = scan.skills.cliPrivate.find((s) => s.name === skillName);
    return inPrivate?.perCli ?? {};
  }

  function statusBadgeVariant(status: SkillStatus | undefined): string {
    if (!status) return "status-badge--neutral";
    switch (status.kind) {
      case "magister-symlinked": return "status-badge--success";
      case "cli-private": return "status-badge--warning";
      case "missing": return "status-badge--warning";
      default: return "status-badge--neutral";
    }
  }

  function statusLabel(cli: CliRuntime, status: SkillStatus | undefined): string {
    const cliLabel = cli === "claude-code" ? "Claude Code" : cli === "opencode" ? "OpenCode" : "Codex";
    // Codex auto-discovers ~/.agents/skills/ — the pool entry is enough
    // for codex to see the skill, regardless of the per-CLI symlink. So
    // for codex, "missing" symlink is fine (codex still sees it); render
    // as auto-discovered rather than as a warning.
    if (cli === "codex") return `${cliLabel} (auto)`;
    if (!status) return `${cliLabel}: unknown`;
    switch (status.kind) {
      case "magister-symlinked": return `${cliLabel} ✓`;
      case "cli-private": return `${cliLabel} (private)`;
      case "missing": return `${cliLabel} ⚠ missing`;
      default: return cliLabel;
    }
  }

  if (loading) return <p className="settings-loading">Loading skills…</p>;
  if (error) return <p className="settings-error">{error}</p>;

  return (
    <div>
      <div className="settings-mobile-toolbar">
        <p
          style={{
            color: "var(--ink-3)",
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            letterSpacing: "0.04em",
          }}
        >
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{totals.total}</span> total
          {totals.builtin > 0 ? <> · {totals.builtin} bundled</> : null}
          {" · "}{totals.github} github · {totals.manual} manual
        </p>
        <div className="settings-mobile-toolbar__actions">
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => {
              setImportOpen(true);
              setCreateOpen(false);
            }}
          >
            + Import from GitHub
          </button>
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => {
              setCreateOpen(true);
              setImportOpen(false);
            }}
          >
            + Create custom
          </button>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="settings-error" style={{ marginBottom: 12 }}>
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      ) : null}

      {importOpen ? (
        <ImportSkillForm
          onCancel={() => setImportOpen(false)}
          onSuccess={async () => {
            setImportOpen(false);
            await load();
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateSkillForm
          onCancel={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            await load();
          }}
        />
      ) : null}

      {skills.length === 0 && !importOpen && !createOpen ? (
        <EmptyState
          icon="◇"
          title="No skills installed yet"
          description="Use + Import from GitHub or + Create custom above."
        />
      ) : null}

      <div className="config-card-list">
        {skills.map((skill) => {
          const sourceLabel = shortenSourceUrl(skill.sourceUrl);
          const updatedRel = formatRelativeDate(skill.updatedAt);
          const refreshing = Boolean(pending[`refresh::${skill.name}`]);
          const deleting = Boolean(pending[`delete::${skill.name}`]);
          const editing = editingName === skill.name;
          return (
            <article key={skill.name} className="config-card">
              <div className="config-card-header">
                <strong style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{skill.name}</strong>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexShrink: 0 }}>
                  <Pill
                    tone={
                      skill.sourceKind === "builtin"
                        ? "neutral"
                        : skill.sourceKind === "github"
                          ? "blue"
                          : "sage"
                    }
                  >
                    {skill.sourceKind === "builtin"
                      ? "Magister bundled"
                      : skill.sourceKind === "github"
                        ? "github"
                        : "manual"}
                  </Pill>
                  {skill.hasOverride ? (
                    <Pill tone="ochre">Modified</Pill>
                  ) : null}
                  {/* Edit is available for both `manual` (writes to
                      the pool) and `builtin` (writes to the repo's
                      packages/builtin-skills/ — the form surfaces a
                      "commit this" warning so the user knows). github
                      skills can't be edited locally — only Refresh. */}
                  {skill.sourceKind === "manual" || skill.sourceKind === "builtin" ? (
                    <button
                      type="button"
                      className={`config-edit-btn${editing ? " config-edit-btn--active" : ""}`}
                      onClick={() => setEditingName(editing ? null : skill.name)}
                      disabled={refreshing || deleting}
                    >
                      {editing ? "Cancel" : "Edit"}
                    </button>
                  ) : skill.sourceKind === "github" ? (
                    <button
                      type="button"
                      className="config-edit-btn"
                      onClick={() => void handleRefresh(skill)}
                      disabled={refreshing || deleting}
                      title="Run `npx skills update` for this skill"
                    >
                      {refreshing ? "Refreshing…" : "Refresh"}
                    </button>
                  ) : null}
                  {/* Bundled skills travel with the repo; deletion would
                      orphan the leader's orchestration suite for every
                      user on this commit. Hide the Delete button. The
                      backend rejects bundled-name deletes anyway as a
                      defense-in-depth guard. Bundled rows with an
                      override get a "Reset" button in the same slot —
                      idempotent restore-to-default. */}
                  {skill.sourceKind === "builtin" ? (
                    skill.hasOverride ? (
                      <button
                        type="button"
                        className="config-edit-btn"
                        onClick={() => void handleResetOverride(skill)}
                        disabled={refreshing || deleting || Boolean(pending[`reset::${skill.name}`])}
                        title="Discard this instance's customization and restore the bundled default."
                      >
                        {pending[`reset::${skill.name}`] ? "Resetting…" : "Reset to default"}
                      </button>
                    ) : null
                  ) : (
                    <button
                      type="button"
                      className="config-edit-btn"
                      style={{ color: "var(--error)" }}
                      onClick={() => void handleDelete(skill)}
                      disabled={refreshing || deleting}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  )}
                </div>
              </div>

              {skill.description ? (
                <p className="config-card-meta">{skill.description}</p>
              ) : (
                <p className="config-card-meta" style={{ color: "var(--error)" }}>
                  ⚠ Missing description in SKILL.md frontmatter — the model has no firing condition to decide on.
                </p>
              )}

              <p className="config-card-meta" style={{ fontSize: 11 }}>
                {skill.sourceKind === "builtin" ? (
                  <>Source: <code>packages/builtin-skills/{skill.dirName ?? skill.name}/SKILL.md</code> (repo)</>
                ) : sourceLabel ? (
                  <>Source: {sourceLabel}</>
                ) : (
                  <>Source: local manual file</>
                )}
                {skill.sourceCommit ? <> @ <code>{skill.sourceCommit.slice(0, 7)}</code></> : null}
                {updatedRel ? <> · Updated {updatedRel}</> : null}
              </p>

              {editing
                && (skill.sourceKind === "manual" || skill.sourceKind === "builtin") ? (
                <EditManualSkillForm
                  skill={skill}
                  onCancel={() => setEditingName(null)}
                  onSuccess={async () => {
                    setEditingName(null);
                    await load();
                  }}
                />
              ) : null}

              {/* Bundled skills are never propagated to CLI skill dirs
                  (they live in the repo, leader-only). The "On disk"
                  bridge scan only makes sense for skills that actually
                  CAN land in `~/.{cli}/skills/`. */}
              {bridgeScan && skill.sourceKind !== "builtin" ? (
                <div style={{ marginBottom: 8 }}>
                  <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    On disk
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {(["claude-code", "opencode", "codex"] as const).map((cli) => {
                      const cliStatus = findCliStatus(bridgeScan, skill.name);
                      const status = cliStatus[cli];
                      // Codex auto-loads everything in the pool, so its
                      // badge is always informational (neutral), never
                      // ⚠ warning even if the symlink is missing.
                      const variant = cli === "codex" ? "status-badge--neutral" : statusBadgeVariant(status);
                      return (
                        <span key={cli} className={`status-badge ${variant}`} style={{ fontSize: 11 }}>
                          {statusLabel(cli, status)}
                        </span>
                      );
                    })}
                    {/* Stage 2: "Sync now" — re-run symlink sync to fix any "missing" status */}
                    <button
                      type="button"
                      className="config-edit-btn"
                      style={{ fontSize: 11, padding: "2px 8px", marginLeft: 4 }}
                      disabled={Boolean(pending[`sync::${skill.name}`])}
                      onClick={async () => {
                        const cellKey = `sync::${skill.name}`;
                        setPending((p) => ({ ...p, [cellKey]: true }));
                        try {
                          const { syncCliSkill } = await import("../../lib/api");
                          await syncCliSkill(skill.name);
                          // Re-fetch the bridge scan to update badges.
                          const { scanCliBridges } = await import("../../lib/api");
                          const next = await scanCliBridges();
                          setBridgeScan(next);
                        } catch (err) {
                          alert(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
                        } finally {
                          setPending((p) => ({ ...p, [cellKey]: false }));
                        }
                      }}
                    >
                      {pending[`sync::${skill.name}`] ? "Syncing…" : "Sync now"}
                    </button>
                  </div>
                </div>
              ) : null}

              <div
                style={{
                  marginTop: "8px",
                  padding: "8px",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  background: "var(--surface-subtle)",
                }}
              >
                <p
                  style={{
                    margin: "0 0 6px",
                    fontSize: 11,
                    color: "var(--muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Used by
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
                  {AGENT_ROLES.map(({ id, label }) => {
                    // Bundled skills are leader-only and physically live
                    // in the repo (not in ~/.agents/skills/). The CLI
                    // toggles would do nothing meaningful — bundled
                    // names can't be symlinked into ~/.{cli}/skills/
                    // because the source isn't in the pool. Render a
                    // read-only "leader-only" marker on the leader row
                    // and hide the CLI rows entirely.
                    if (skill.sourceKind === "builtin") {
                      if (id !== "leader") return null;
                      return (
                        <span
                          key={id}
                          title="Magister-bundled skills are always attached to the leader and cannot be propagated to CLI agents."
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 13,
                            color: "var(--muted)",
                            cursor: "help",
                          }}
                        >
                          <span style={{ fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 3 }}>auto</span>
                          <span>{label}</span>
                        </span>
                      );
                    }
                    // Codex auto-discovers `~/.agents/skills/` directly —
                    // detaching from Magister removes the per-CLI symlink but
                    // codex still reads the pool. The toggle had zero net
                    // effect on what skills codex actually sees, so we
                    // render a read-only "auto" badge to avoid misleading
                    // users into thinking they're controlling something.
                    if (id === "codex") {
                      return (
                        <span
                          key={id}
                          title="Codex auto-discovers all skills in the pool (~/.agents/skills/) regardless of Magister attachments. Per-CLI toggles only matter for Claude Code and OpenCode."
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 13,
                            color: "var(--muted)",
                            cursor: "help",
                          }}
                        >
                          <span style={{ fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 3 }}>auto</span>
                          <span>{label}</span>
                        </span>
                      );
                    }
                    const checked = skill.attachedAgents.includes(id);
                    const cellKey = `attach::${skill.name}::${id}`;
                    const isPending = Boolean(pending[cellKey]);
                    const inputId = `skill-${skill.name}-${id}`;
                    return (
                      <label
                        key={id}
                        htmlFor={inputId}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 13,
                          cursor: isPending ? "wait" : "pointer",
                          opacity: isPending ? 0.6 : 1,
                        }}
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={checked}
                          disabled={isPending}
                          onChange={(e) => void toggleAttachment(skill, id, e.target.checked)}
                        />
                        <span>{label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {bridgeScan && bridgeScan.skills.cliPrivate.length > 0 ? (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>External skills (CLI-private, not in Magister pool)</h2>
          <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            These skills live in a CLI's own directory, not the shared <code>~/.agents/skills/</code> pool.
            Click <strong>Promote to Magister</strong> to move the content into the pool and add symlinks back. Codex private skills cannot be promoted (Codex uses its own skill system).
          </p>
          <div className="config-card-list">
            {bridgeScan.skills.cliPrivate.map((skill) => {
              const ownerCli = (Object.keys(skill.perCli) as CliRuntime[])[0];
              const ownerStatus = ownerCli ? skill.perCli[ownerCli] : undefined;
              const cliLabel = ownerCli === "claude-code" ? "Claude Code" : ownerCli === "opencode" ? "OpenCode" : "Codex";
              const isCodex = ownerCli === "codex";
              const promoteKey = `promote::${skill.name}::${ownerCli}`;
              const isPromoting = Boolean(pending[promoteKey]);
              return (
                <article key={`external::${skill.name}`} className="config-card">
                  <div className="config-card-header">
                    <strong>{skill.name}</strong>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="status-badge status-badge--neutral" style={{ fontSize: 11 }}>
                        {cliLabel} private
                      </span>
                      {ownerCli && !isCodex ? (
                        <button
                          type="button"
                          className="config-edit-btn"
                          style={{ fontSize: 11, padding: "2px 8px" }}
                          disabled={isPromoting}
                          onClick={async () => {
                            if (!window.confirm(`Promote "${skill.name}" from ${cliLabel} into the Magister pool? This moves the directory and replaces the original with a symlink.`)) return;
                            setPending((p) => ({ ...p, [promoteKey]: true }));
                            try {
                              const { promoteCliSkill } = await import("../../lib/api");
                              await promoteCliSkill({ name: skill.name, sourceCli: ownerCli });
                              const { scanCliBridges } = await import("../../lib/api");
                              const next = await scanCliBridges();
                              setBridgeScan(next);
                            } catch (err) {
                              alert(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
                            } finally {
                              setPending((p) => ({ ...p, [promoteKey]: false }));
                            }
                          }}
                        >
                          {isPromoting ? "Promoting…" : "Promote to Magister"}
                        </button>
                      ) : isCodex ? (
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>(Codex private — not promotable)</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="config-card-meta" style={{ fontSize: 11, color: "var(--muted)" }}>
                    Path: <code>{ownerStatus?.kind === "cli-private" ? (ownerStatus as { path: string }).path : "—"}</code>
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <ExternalSkillsSection />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// External skills (codex auto-loads + superpowers meta-pack)
// ─────────────────────────────────────────────────────────────────

function ExternalSkillsSection() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getExternalSkills>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  async function load(refresh = false) {
    try {
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setData(await getExternalSkills(refresh));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !data) return null; // hide entirely until first fetch
  if (error) {
    return (
      <section className="settings-section" style={{ marginTop: 24 }}>
        <p style={{ color: "var(--red)" }}>External skills: {error}</p>
        <button type="button" onClick={() => void load()}>Retry</button>
      </section>
    );
  }
  if (!data) return null;

  const codex = data.codex;
  const groupOrder: ExternalSkillEntry["source"][] = [
    "codex-bundled",
    "codex-superpowers",
    "magister-pool",
    "unknown",
  ];
  const groupLabels: Record<ExternalSkillEntry["source"], string> = {
    "codex-bundled": "Codex bundled",
    "codex-superpowers": "Codex superpowers (meta-pack)",
    "magister-pool": "Magister pool (also editable above)",
    unknown: "Other (unknown source)",
  };
  const grouped: Record<ExternalSkillEntry["source"], ExternalSkillEntry[]> = {
    "codex-bundled": [],
    "codex-superpowers": [],
    "magister-pool": [],
    unknown: [],
  };
  for (const skill of codex.skills) grouped[skill.source].push(skill);

  return (
    <section className="settings-section" style={{ marginTop: 24 }}>
      <header
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <h3 style={{ margin: 0 }}>
            {open ? "▾" : "▸"} External skills (read-only) — {codex.totalCount}
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>
            What codex's loader actually injects into the model prompt — bundled built-ins +
            Magister pool + any installed meta-pack. Magister cannot edit or detach these; they're owned
            by the codex CLI / the meta-pack source.
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void load(true); }}
          disabled={refreshing}
          title={`Source of truth: ${codex.method === "probe" ? "codex CLI probe" : "directory scan (codex CLI unavailable)"}`}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <p style={{ fontSize: 11, color: "var(--muted)", margin: "8px 0" }}>
        Source: {codex.method === "probe"
          ? <span title="Ran `codex debug prompt-input` and parsed the rendered system prompt">via codex CLI probe</span>
          : <span title={codex.fallbackReason ?? ""}>via directory scan ({codex.fallbackReason ?? "codex CLI unavailable"})</span>}
        {" · captured "}
        {(() => { try { return new Date(codex.takenAt).toLocaleString(); } catch { return codex.takenAt; } })()}
      </p>

      {open ? (
        <div>
          {groupOrder.map((source) => {
            const list = grouped[source];
            if (list.length === 0) return null;
            return (
              <div key={source} style={{ marginTop: 12 }}>
                <h4 style={{ fontSize: 12, fontWeight: 600, margin: "0 0 6px", color: "var(--ink-3)" }}>
                  {groupLabels[source]} ({list.length})
                </h4>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                  {list.map((skill) => (
                    <li key={skill.name + skill.filePath} style={{ fontSize: 12, padding: "4px 0", borderBottom: "1px solid var(--line-softer)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <code style={{ fontWeight: 600 }}>{skill.name}</code>
                        <span style={{ color: "var(--muted)", flex: 1 }}>{skill.description}</span>
                      </div>
                      <code style={{ fontSize: 11, color: "var(--muted)", display: "block", marginTop: 2 }}>{skill.filePath}</code>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Inline forms
// ─────────────────────────────────────────────────────────────────

function ImportSkillForm({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = source.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await importSkillFromGithub(trimmed);
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to import ${trimmed}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="config-form" role="form" aria-label="Import skill from GitHub" style={{ marginBottom: 16 }}>
      <div className="config-field">
        <label>GitHub source</label>
        <input
          className="config-input"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="vercel-labs/agent-skills (or vercel-labs/agent-skills@web-design-guidelines)"
          disabled={busy}
        />
        <p className="config-field-help" style={{ fontSize: 11, color: "var(--muted)" }}>
          Runs <code>npx skills add &lt;source&gt; -g -y</code>. Skill installs to <code>~/.agents/skills/</code> and shows up in the list below. Typically takes 5-30s.
        </p>
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="config-form-footer">
        <button type="button" className="config-edit-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="config-save-btn"
          onClick={() => void submit()}
          disabled={busy || !source.trim()}
        >
          {busy ? "Installing…" : "Install"}
        </button>
      </div>
    </div>
  );
}

function CreateSkillForm({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await createManualSkill({ name: name.trim(), description: description.trim(), content });
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="config-form" role="form" aria-label="Create custom skill" style={{ marginBottom: 16 }}>
      <div className="config-field">
        <label>Name</label>
        <input
          className="config-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="lowercase-with-hyphens"
          disabled={busy}
        />
        <p className="config-field-help" style={{ fontSize: 11, color: "var(--muted)" }}>
          Lowercase letters, digits, and hyphens; must start with a letter; max 64 chars.
        </p>
      </div>
      <div className="config-field">
        <label>Description (firing condition)</label>
        <input
          className="config-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='e.g. "Use when the user asks for a code review of the current branch"'
          disabled={busy}
        />
        <p className="config-field-help" style={{ fontSize: 11, color: "var(--muted)" }}>
          The model reads this to decide when to load the skill. Be specific about what triggers it.
        </p>
      </div>
      <div className="config-field">
        <label>Content (markdown body)</label>
        <textarea
          className="config-input"
          rows={10}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Skill body in markdown.&#10;&#10;Steps, examples, references..."
          style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 13 }}
          disabled={busy}
        />
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="config-form-footer">
        <button type="button" className="config-edit-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="config-save-btn"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !description.trim() || !content.trim()}
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

function EditManualSkillForm({
  skill,
  onCancel,
  onSuccess,
}: {
  skill: SkillView;
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await getSkillDetail(skill.name);
        if (cancelled) return;
        setDescription(detail.description);
        setContent(detail.content);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load skill body");
        setContent(""); // fall back so the form is at least usable
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.name]);

  async function submit() {
    if (content == null) return;
    if (!description.trim()) {
      setError("Description cannot be empty.");
      return;
    }
    if (!content.trim()) {
      setError("Content cannot be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateManualSkill(skill.name, {
        description: description.trim(),
        content,
      });
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  if (content == null && !error) {
    return <p className="config-card-meta">Loading SKILL.md…</p>;
  }

  return (
    <div className="config-form" role="form" aria-label={`Edit ${skill.name}`} style={{ marginTop: 8 }}>
      {skill.sourceKind === "builtin" ? (
        <div
          role="note"
          style={{
            padding: "8px 10px",
            marginBottom: 12,
            border: "1px solid var(--warning, #d97706)",
            background: "rgba(217, 119, 6, 0.08)",
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong>Per-instance override.</strong> Saving stores the change in
          Magister's database for this instance — the leader sees your version,
          the repo's <code>packages/builtin-skills/{skill.dirName}/SKILL.md</code>{" "}
          stays untouched. Click <em>Reset to default</em> on the card to
          discard the override and restore the bundled version. Changes
          take effect on the leader's next turn (no restart needed).
        </div>
      ) : null}
      <div className="config-field">
        <label>Description</label>
        <input
          className="config-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="config-field">
        <label>Content (markdown body)</label>
        <textarea
          className="config-input"
          rows={14}
          value={content ?? ""}
          onChange={(e) => setContent(e.target.value)}
          style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 13 }}
          disabled={busy}
        />
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="config-form-footer">
        <button type="button" className="config-edit-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="config-save-btn"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
