import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteMemory,
  listMemory,
  upsertCheatsheet,
  viewMemory,
  type MemoryEntryDetail,
  type MemoryListEntry,
  type MemoryListResponse,
} from "../../lib/api";
import { EmptyState } from "../ui/EmptyState";
import "../../styles/memory.css";

type Scope = "user-global" | "project";
type TypedKind = "user" | "project" | "feedback" | "reference";

const SCOPES: Scope[] = ["user-global", "project"];
const TYPE_ORDER: TypedKind[] = ["user", "project", "feedback", "reference"];

const TYPE_LABELS: Record<TypedKind, { dotVar: string; blurb: string }> = {
  user: {
    dotVar: "var(--mem-user)",
    blurb: "stable user preferences + role",
  },
  project: {
    dotVar: "var(--mem-project)",
    blurb: "architecture + decisions for this project",
  },
  feedback: {
    dotVar: "var(--mem-feedback)",
    blurb: "lessons learned from corrections / failures",
  },
  reference: {
    dotVar: "var(--mem-reference)",
    blurb: "external pointers + facts to remember",
  },
};

const CHEATSHEET_COPY: Record<Scope, string> = {
  "user-global":
    "Commands, gotchas, TILs you want at hand in every session — cross-project. The full body injects into the leader's prompt every turn.",
  project:
    "Notes pinned to THIS project — local conventions, repo-specific commands, things that don't generalize.",
};

export function MemoryList() {
  const [data, setData] = useState<MemoryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, MemoryEntryDetail>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [editingCheatsheet, setEditingCheatsheet] = useState<Scope | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const fetched = await listMemory();
      setData(fetched);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleExpand(path: string) {
    if (expanded[path]) {
      const next = { ...expanded };
      delete next[path];
      setExpanded(next);
      return;
    }
    setPending((prev) => ({ ...prev, [`view::${path}`]: true }));
    try {
      const detail = await viewMemory(path);
      setExpanded((prev) => ({ ...prev, [path]: detail }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((prev) => {
        const next = { ...prev };
        delete next[`view::${path}`];
        return next;
      });
    }
  }

  async function onDelete(path: string) {
    if (!confirm(`Delete memory entry "${path}"?`)) return;
    setPending((prev) => ({ ...prev, [`delete::${path}`]: true }));
    try {
      await deleteMemory(path);
      const next = { ...expanded };
      delete next[path];
      setExpanded(next);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending((prev) => {
        const copy = { ...prev };
        delete copy[`delete::${path}`];
        return copy;
      });
    }
  }

  if (loading) return <p className="settings-loading">Loading memory…</p>;
  if (error) return <p className="settings-error">{error}</p>;
  if (!data) return null;

  const total = data["user-global"].length + data.project.length;
  const typedTotal = SCOPES.reduce(
    (n, s) =>
      n +
      data[s].filter(
        (e) => e.type !== "cheatsheet" && e.type !== "scratchpad",
      ).length,
    0,
  );
  const scratchpadTotal = SCOPES.reduce(
    (n, s) => n + data[s].filter((e) => e.type === "scratchpad").length,
    0,
  );
  const cheatsheetTotal = SCOPES.reduce(
    (n, s) => n + data[s].filter((e) => e.type === "cheatsheet").length,
    0,
  );

  // First-time onboarding: completely empty memory deserves a focused
  // hero rather than a stat chips row of zeros + 3 empty sections.
  // Surfaces the same three-concept explainer but anchors a single
  // primary action (create the user-global cheatsheet — the most
  // useful first artifact).
  if (total === 0) {
    return (
      <div className="mem">
        <section className="mem-hero">
          <div className="mem-hero__eyebrow">Memory</div>
          <h2 className="mem-hero__title">Nothing in memory yet.</h2>
          <p className="mem-hero__lede">
            Memory carries facts forward between sessions. Three flavors,
            each used differently by the leader:
          </p>
          <div className="mem-hero__rows">
            <div className="mem-hero__row">
              <span
                className="mem-hero__dot"
                style={{ background: "var(--mem-cheatsheet)" }}
              />
              <div>
                <div className="mem-hero__row-title">Cheatsheets</div>
                <div className="mem-hero__row-body">
                  Hand-curated notes — commands, gotchas, TILs. Injected
                  in full into the leader's prompt every turn. Two slots:
                  one cross-project, one per-project.
                </div>
              </div>
            </div>
            <div className="mem-hero__row">
              <span
                className="mem-hero__dot"
                style={{ background: "var(--mem-user)" }}
              />
              <div>
                <div className="mem-hero__row-title">Typed entries</div>
                <div className="mem-hero__row-body">
                  Written by the leader as it captures durable facts —
                  user preferences, architecture decisions, lessons
                  learned, references. Indexed in the prompt; bodies
                  loaded on demand via <code>load_memory</code>.
                </div>
              </div>
            </div>
            <div className="mem-hero__row">
              <span
                className="mem-hero__dot"
                style={{ background: "var(--mem-scratchpad)" }}
              />
              <div>
                <div className="mem-hero__row-title">Scratchpads</div>
                <div className="mem-hero__row-body">
                  Per-task working notes — open files, partial diffs,
                  the leader's current mental model. Auto-purged when
                  the task is.
                </div>
              </div>
            </div>
          </div>
          <div className="mem-hero__actions">
            <button
              type="button"
              className="mem-hero__cta"
              aria-label="Create your first cheatsheet (user-global scope)"
              onClick={() => setEditingCheatsheet("user-global")}
            >
              Create your first cheatsheet
            </button>
            <span className="mem-hero__hint">
              Or just start working — the leader writes typed entries on its own.
            </span>
          </div>
        </section>
        {editingCheatsheet ? (
          <CheatsheetEditor
            scope={editingCheatsheet}
            hasExisting={false}
            onCancel={() => setEditingCheatsheet(null)}
            onSaved={async () => {
              setEditingCheatsheet(null);
              await refresh();
            }}
          />
        ) : null}
      </div>
    );
  }

  // Editorial top — replaces the prior stat-chip strip + 3-concept
  // intro grid for the populated state. Title + 1-paragraph lede
  // + inline summary stats; the 3 concepts are conveyed by the
  // section captions below instead of redundant intro tiles.
  const titleEntries =
    total === 1
      ? "1 entry across two scopes"
      : `${total} entries across two scopes`;

  return (
    <div className="mem">
      <header className="mem-toplevel">
        <div className="mem-toplevel__primary">
          <div className="mem-toplevel__eyebrow">Memory</div>
          <h2 className="mem-toplevel__title">{titleEntries}</h2>
          <p className="mem-toplevel__lede">
            Notes carried forward between sessions — cheatsheets injected
            in full every turn, typed entries indexed and loaded on demand,
            scratchpads scoped to a task.
          </p>
          <div className="mem-toplevel__stats">
            <span className="mem-toplevel__stat">
              <strong>{cheatsheetTotal}</strong> cheatsheets
            </span>
            <span aria-hidden="true" className="mem-toplevel__stat-sep">·</span>
            <span className="mem-toplevel__stat">
              <strong>{typedTotal}</strong> typed
            </span>
            <span aria-hidden="true" className="mem-toplevel__stat-sep">·</span>
            <span className="mem-toplevel__stat">
              <strong>{scratchpadTotal}</strong> scratchpads
            </span>
          </div>
        </div>
        <button
          type="button"
          className="mem-toplevel__refresh"
          onClick={() => void refresh()}
          aria-label="Refresh memory listing"
        >
          Refresh
        </button>
      </header>

      {/* ---- Cheatsheets section ---- */}
      <section className="mem-section">
        <header className="mem-section__head">
          <h3 className="mem-section__title">
            <span
              className="mem-section__dot"
              style={{ background: "var(--mem-cheatsheet)" }}
              aria-hidden="true"
            />
            Cheatsheets
            <span className="mem-section__count">{cheatsheetTotal}/2</span>
          </h3>
          <p className="mem-section__caption">
            Hand-curated. Full body injected into the leader's prompt every
            turn — one cross-project, one per-project.
          </p>
        </header>
        <div className="mem-cheatsheet-grid">
          {SCOPES.map((scope) => {
            const current =
              data[scope].find((e) => e.type === "cheatsheet") ?? null;
            return (
              <CheatsheetCard
                key={scope}
                scope={scope}
                current={current}
                detail={current ? expanded[current.path] : undefined}
                expandPending={
                  current ? pending[`view::${current.path}`] === true : false
                }
                deletePending={
                  current ? pending[`delete::${current.path}`] === true : false
                }
                onToggle={
                  current ? () => void toggleExpand(current.path) : undefined
                }
                onDelete={
                  current ? () => void onDelete(current.path) : undefined
                }
                onEdit={() => setEditingCheatsheet(scope)}
              />
            );
          })}
        </div>
      </section>

      {editingCheatsheet ? (
        <CheatsheetEditor
          scope={editingCheatsheet}
          hasExisting={data[editingCheatsheet].some(
            (e) => e.type === "cheatsheet",
          )}
          onCancel={() => setEditingCheatsheet(null)}
          onSaved={async () => {
            const path = `${editingCheatsheet}/cheatsheet`;
            const next = { ...expanded };
            delete next[path];
            setExpanded(next);
            setEditingCheatsheet(null);
            await refresh();
          }}
        />
      ) : null}

      {/* ---- Typed entries section ---- */}
      <section className="mem-section">
        <header className="mem-section__head">
          <h3 className="mem-section__title">
            <span
              className="mem-section__dot"
              style={{ background: "var(--mem-user)" }}
              aria-hidden="true"
            />
            Typed entries
            <span className="mem-section__count">{typedTotal}</span>
          </h3>
          <p className="mem-section__caption">
            Written by the leader's <code>upsert_memory</code> tool as
            it captures durable facts. Indexed in the prompt; bodies
            loaded on demand.
          </p>
        </header>
        {typedTotal === 0 ? (
          <EmptyState
            compact
            icon="◇"
            title="No typed entries yet"
            description="The leader writes these as it captures durable facts — user preferences, architecture decisions, feedback, and references. They'll appear here as tasks run."
          />
        ) : (
          <TypedEntriesGroups
            data={data}
            expanded={expanded}
            pending={pending}
            toggleExpand={toggleExpand}
            onDelete={onDelete}
          />
        )}
      </section>

      {/* ---- Scratchpads section ---- */}
      {scratchpadTotal > 0 ? (
        <section className="mem-section">
          <header className="mem-section__head">
            <h3 className="mem-section__title">
              <span
                className="mem-section__dot"
                style={{ background: "var(--mem-scratchpad)" }}
                aria-hidden="true"
              />
              Scratchpads
              <span className="mem-section__count">{scratchpadTotal}</span>
            </h3>
            <p className="mem-section__caption">
              Per-task working notes — open files, partial diffs, the
              leader's current mental model. Auto-purged when the
              task is.
            </p>
          </header>
          <div className="mem-cheatsheet-grid">
            {SCOPES.flatMap((scope) =>
              data[scope]
                .filter((e) => e.type === "scratchpad")
                .map((entry) => (
                  <MemoryCard
                    key={entry.path}
                    entry={entry}
                    detail={expanded[entry.path]}
                    expandPending={pending[`view::${entry.path}`] === true}
                    deletePending={pending[`delete::${entry.path}`] === true}
                    onToggle={() => void toggleExpand(entry.path)}
                    onDelete={() => void onDelete(entry.path)}
                  />
                )),
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function TypedEntriesGroups({
  data,
  expanded,
  pending,
  toggleExpand,
  onDelete,
}: {
  data: MemoryListResponse;
  expanded: Record<string, MemoryEntryDetail>;
  pending: Record<string, boolean>;
  toggleExpand: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const byType = useMemo(() => {
    const out: Record<TypedKind, MemoryListEntry[]> = {
      user: [],
      project: [],
      feedback: [],
      reference: [],
    };
    for (const scope of SCOPES) {
      for (const entry of data[scope]) {
        if (entry.type === "cheatsheet" || entry.type === "scratchpad") continue;
        const k = entry.type as TypedKind;
        if (out[k]) out[k].push(entry);
      }
    }
    return out;
  }, [data]);

  return (
    <>
      {TYPE_ORDER.map((kind) => {
        const entries = byType[kind];
        if (entries.length === 0) return null;
        const meta = TYPE_LABELS[kind];
        return (
          <div key={kind} style={{ marginBottom: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                margin: "10px 0 8px",
              }}
            >
              <span
                className="mem-intro__dot"
                style={{ background: meta.dotVar }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--ink)",
                }}
              >
                {kind}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-3)",
                  letterSpacing: "0.02em",
                }}
              >
                — {meta.blurb}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: "var(--ink-2)",
                  background: "var(--paper-3)",
                  border: "1px solid var(--line-softer)",
                  borderRadius: "var(--radius)",
                  padding: "2px 7px",
                }}
              >
                {entries.length}
              </span>
            </div>
            <div className="mem-cheatsheet-grid">
              {entries.map((entry) => (
                <MemoryCard
                  key={entry.path}
                  entry={entry}
                  detail={expanded[entry.path]}
                  expandPending={pending[`view::${entry.path}`] === true}
                  deletePending={pending[`delete::${entry.path}`] === true}
                  onToggle={() => toggleExpand(entry.path)}
                  onDelete={() => onDelete(entry.path)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function CheatsheetCard({
  scope,
  current,
  detail,
  expandPending,
  deletePending,
  onToggle,
  onDelete,
  onEdit,
}: {
  scope: Scope;
  current: MemoryListEntry | null;
  detail: MemoryEntryDetail | undefined;
  expandPending: boolean;
  deletePending: boolean;
  onToggle: (() => void) | undefined;
  onDelete: (() => void) | undefined;
  onEdit: () => void;
}) {
  if (!current) {
    return (
      <button
        type="button"
        className="mem-card-empty"
        onClick={onEdit}
        aria-label={`Create ${scope} cheatsheet`}
      >
        <div className="mem-card-empty__head">
          <span className="mem-card-empty__plus" aria-hidden>
            +
          </span>
          <span className="mem-card-empty__title">{scope}/cheatsheet</span>
        </div>
        <p className="mem-card-empty__copy">{CHEATSHEET_COPY[scope]}</p>
        <div className="mem-card-empty__cta">Create cheatsheet →</div>
      </button>
    );
  }

  const lastAccessed = current.lastAccessedAt.slice(0, 10);
  // Per spec §5.10: cheatsheet card shows a scope pill (USER blue /
  // PROJECT sage) rather than a generic "cheatsheet" tag — the path
  // already says "<scope>/cheatsheet".
  const scopeTagStyle =
    scope === "user-global"
      ? { background: "var(--blue-soft)", color: "var(--blue)" }
      : { background: "var(--sage-soft)", color: "var(--sage-deep)" };
  return (
    <article className="mem-card mem-card--cheatsheet">
      <div className="mem-card__head">
        <span className="mem-card__path">
          <span className="mem-card__path-prefix">{scope}/</span>cheatsheet
        </span>
        <span className="mem-card__tags">
          <span className="mem-type-tag" style={scopeTagStyle}>
            {scope === "user-global" ? "user" : "project"}
          </span>
        </span>
      </div>
      <p className="mem-card__desc">{current.description}</p>
      <div className="mem-card__meta">last accessed {lastAccessed}</div>
      {detail ? <pre className="mem-card__body">{detail.body}</pre> : null}
      <div className="mem-card__actions">
        {onToggle ? (
          <button
            type="button"
            className="mem-btn"
            onClick={onToggle}
            disabled={expandPending}
          >
            {expandPending ? "Loading…" : detail ? "Collapse" : "View body"}
          </button>
        ) : null}
        <button type="button" className="mem-btn mem-btn--primary" onClick={onEdit}>
          Edit
        </button>
        {onDelete ? (
          <button
            type="button"
            className="mem-btn mem-btn--danger"
            onClick={onDelete}
            disabled={deletePending}
          >
            {deletePending ? "Deleting…" : "Delete"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function MemoryCard({
  entry,
  detail,
  expandPending,
  deletePending,
  onToggle,
  onDelete,
}: {
  entry: MemoryListEntry;
  detail: MemoryEntryDetail | undefined;
  expandPending: boolean;
  deletePending: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const lastAccessed = entry.lastAccessedAt.slice(0, 10);
  const variant = `mem-card--${entry.type}`;
  // Split path so the prefix dims out and the leaf reads as the
  // distinct address.
  const segments = entry.path.split("/");
  const leaf = segments[segments.length - 1] ?? entry.path;
  const prefix = segments.slice(0, -1).join("/");

  return (
    <article className={`mem-card ${variant}`}>
      <div className="mem-card__head">
        <span className="mem-card__path">
          {prefix ? (
            <span className="mem-card__path-prefix">{prefix}/</span>
          ) : null}
          {leaf}
        </span>
        <span className="mem-card__tags">
          <span className="mem-type-tag">{entry.type}</span>
          {entry.agingFlag ? (
            <span
              className={`mem-flag mem-flag--${entry.agingFlag}`}
              title={
                entry.agingFlag === "stale"
                  ? "Not accessed in 90+ days — candidate for removal."
                  : "Not accessed in 30+ days — consider pruning."
              }
            >
              {entry.agingFlag}
            </span>
          ) : null}
          {entry.codeChanged ? (
            <span
              className="mem-flag mem-flag--code-changed"
              title={
                entry.gitAnchor
                  ? `Workspace HEAD has moved since this entry was written (gitAnchor: ${entry.gitAnchor.slice(0, 7)}).`
                  : "Workspace HEAD has moved since this entry was written."
              }
            >
              workspace changed
            </span>
          ) : null}
          {entry.supersededBy ? (
            <span
              className="mem-flag mem-flag--superseded"
              title={`Replaced by ${entry.supersededBy}`}
            >
              superseded
            </span>
          ) : null}
        </span>
      </div>
      <p className="mem-card__desc">{entry.description}</p>
      <div className="mem-card__meta">last accessed {lastAccessed}</div>
      {detail ? <pre className="mem-card__body">{detail.body}</pre> : null}
      <div className="mem-card__actions">
        <button
          type="button"
          className="mem-btn"
          onClick={onToggle}
          disabled={expandPending}
        >
          {expandPending ? "Loading…" : detail ? "Collapse" : "View body"}
        </button>
        <button
          type="button"
          className="mem-btn mem-btn--ghost mem-btn--danger"
          onClick={onDelete}
          disabled={deletePending}
        >
          {deletePending ? "Deleting…" : "Delete"}
        </button>
      </div>
    </article>
  );
}

function CheatsheetEditor({
  scope,
  hasExisting,
  onCancel,
  onSaved,
}: {
  scope: Scope;
  hasExisting: boolean;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  // Always fetch the current body on mount when an entry exists.
  // Pre-fix the editor pulled from the parent's `expanded` map which
  // was empty until the user clicked "View body" — opening Edit
  // directly used default placeholders and Save would have silently
  // overwritten the on-disk content.
  const [loading, setLoading] = useState(hasExisting);
  const [loaded, setLoaded] = useState(!hasExisting);
  const [description, setDescription] = useState(`${scope} cheatsheet`);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Optimistic-concurrency etag: lastAccessedAt the editor saw on
  // load. Server compares + 409s on mismatch.
  const [loadedLastAccessedAt, setLoadedLastAccessedAt] = useState<string | null>(
    null,
  );
  const [conflictDetected, setConflictDetected] = useState(false);

  const reloadFromServer = useCallback(async () => {
    if (!hasExisting) return;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setConflictDetected(false);
    try {
      const detail = await viewMemory(`${scope}/cheatsheet`);
      setDescription(detail.frontmatter.description);
      setBody(detail.body);
      setLoadedLastAccessedAt(detail.frontmatter.lastAccessedAt);
      setLoaded(true);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? `Failed to load existing cheatsheet: ${err.message}`
          : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [scope, hasExisting]);

  useEffect(() => {
    if (!hasExisting) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await viewMemory(`${scope}/cheatsheet`);
        if (cancelled) return;
        setDescription(detail.frontmatter.description);
        setBody(detail.body);
        setLoadedLastAccessedAt(detail.frontmatter.lastAccessedAt);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? `Failed to load existing cheatsheet: ${err.message}`
              : String(err),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, hasExisting]);

  async function onSave() {
    setSaving(true);
    setSaveError(null);
    setConflictDetected(false);
    try {
      await upsertCheatsheet(scope, {
        description,
        body,
        ...(loadedLastAccessedAt
          ? { expectedLastAccessedAt: loadedLastAccessedAt }
          : {}),
      });
      await onSaved();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setConflictDetected(true);
        setSaveError(
          "The cheatsheet was changed elsewhere since you loaded it. Reload before saving — your draft is preserved here.",
        );
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  // A11y: focus the first input on mount, focus-trap inside the
  // modal, restore focus on close, dismiss with Escape.
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const shouldAutofocus =
      window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;
    if (shouldAutofocus) {
      firstFieldRef.current?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, input, textarea, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onCancel, saving]);

  return (
    <div
      className="mem-editor-backdrop mem"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-editor-title"
        ref={dialogRef}
        className="mem-editor"
      >
        <div className="mem-editor__head">
          <div className="mem-editor__title">
            <span className="mem-editor__eyebrow">
              {hasExisting ? "Edit cheatsheet" : "New cheatsheet"}
            </span>
            <span
              className="mem-editor__path"
              id="cheatsheet-editor-title"
            >
              {scope}/cheatsheet
            </span>
          </div>
          <button
            type="button"
            className="mem-editor__close"
            onClick={() => !saving && onCancel()}
            aria-label="Close"
            disabled={saving}
          >
            ×
          </button>
        </div>

        <div className="mem-editor__body">
          <div className="mem-editor__form">
            <div className="mem-editor__field">
              <label className="mem-editor__label" htmlFor="cs-desc">
                Description
              </label>
              <input
                id="cs-desc"
                ref={firstFieldRef}
                type="text"
                maxLength={120}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mem-editor__input"
                placeholder={`e.g. "${scope} cheatsheet"`}
              />
              <span className="mem-editor__hint">
                ≤ 120 chars · shown in the entries list and the runtime trace
              </span>
            </div>

            <div className="mem-editor__field" style={{ flex: 1 }}>
              <label className="mem-editor__label" htmlFor="cs-body">
                Body
              </label>
              <textarea
                id="cs-body"
                rows={16}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="mem-editor__textarea"
                placeholder={
                  "# Project shortcuts\n\n- bun run dev:web → vite HMR on :3701\n- bash scripts/restart.sh → prod restart\n\n## Gotchas\n\n- ..."
                }
              />
              <span className="mem-editor__hint">
                Markdown · ≤ 8 KB / 200 lines · full body injects into the
                leader's system prompt every turn
              </span>
            </div>

            {loadError ? (
              <div className="mem-editor__error">
                {loadError} — Save is disabled to prevent overwriting the
                existing entry with defaults. Close and retry.
              </div>
            ) : null}
            {saveError ? (
              <div className="mem-editor__error">{saveError}</div>
            ) : null}
          </div>

          <div className="mem-editor__preview">
            <p className="mem-editor__preview-eyebrow">Preview</p>
            {body.trim().length === 0 ? (
              <p className="mem-editor__preview-empty">
                The body preview will appear here as you type. The leader sees
                exactly this content, verbatim.
              </p>
            ) : (
              <pre className="mem-editor__preview-body">{body}</pre>
            )}
          </div>
        </div>

        <div className="mem-editor__foot">
          {conflictDetected ? (
            <button
              type="button"
              className="mem-btn"
              onClick={() => void reloadFromServer()}
              disabled={saving || loading}
            >
              Reload from server
            </button>
          ) : null}
          <button
            type="button"
            className="mem-btn"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="mem-btn mem-btn--primary"
            onClick={() => void onSave()}
            disabled={
              saving ||
              loading ||
              !loaded ||
              conflictDetected ||
              description.trim().length === 0
            }
          >
            {loading ? "Loading…" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
