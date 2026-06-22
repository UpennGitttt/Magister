/**
 * Inline card for slash command results.
 *
 * Renders the SlashResult union as a focused, dismissable panel inside
 * the chat. The card is purely client-side state — it doesn't create
 * messages or tasks, doesn't sync with SSE, and doesn't survive a page
 * reload. Slash queries are ephemeral peeks at system state, not
 * durable conversation entries.
 */

import { useEffect, useRef, useState } from "react";

export type SlashResult =
  | { kind: "system_status"; data: { headline: string; detail: string } }
  | { kind: "stop_result"; data: { message: string } }
  | { kind: "compact_result"; data: { message: string } }
  | { kind: "goal_activated"; data: { message: string } }
  | { kind: "error"; data: { command: string; message: string } }
  | {
      kind: "goal_activation";
      data: {
        taskId: string | null;
        original: string;
        phase: "confirm" | "optimizing" | "review" | "error";
        optimized?: string;
        errorMessage?: string;
        compressed?: boolean;
        /** Non-null when /model override couldn't be applied during
         *  optimize. Surfaced on the review card so the user notices
         *  the result was produced by the agent default, not their
         *  picked model. */
        overrideWarning?: string | null;
        onActivate: (text: string) => void;
        onOptimize: () => Promise<void>;
        onUpdate: (next: Partial<{ phase: "confirm" | "optimizing" | "review" | "error"; optimized: string; errorMessage: string; compressed: boolean; overrideWarning: string | null }>) => void;
      };
    }
  | {
      kind: "model_picker";
      data: {
        taskId: string;
        phase: "loading" | "list" | "confirm-switch" | "switching" | "error";
        current: { modelName: string; providerLabel: string; apiDialect: string } | null;
        options: Array<{
          modelName: string;
          providerLabel: string;
          apiDialect: string;
          contextWindow?: number | null;
          recent?: boolean;
        }>;
        pendingPick?: { modelName: string; apiDialect: string };
        errorMessage?: string;
        onPick: (modelName: string | null) => Promise<void>;
        onConfirmSwitch: () => Promise<void>;
        onCancelSwitch: () => void;
      };
    }
  | {
      kind: "model_switched";
      data: {
        message: string;
        modelName: string;
        provider: string;
        dialect: string;
      };
    };

export function SlashCommandCard({
  result,
  onDismiss,
  variant = "card",
}: {
  result: SlashResult;
  onDismiss: () => void;
  /** "card" = self-contained bordered note (default). "flat" = drops the
   *  border/background/margin so the result sits cleanly inside an
   *  anchored popover panel (the interactive /model + /goal flows). */
  variant?: "card" | "flat";
}) {
  const [collapsed, setCollapsed] = useState(false);

  const title = (() => {
    switch (result.kind) {
      case "system_status": return result.data.headline;
      case "stop_result": return "/stop";
      case "compact_result": return "/compact";
      case "goal_activated": return "/goal — activated";
      case "error": return `Error: /${result.data.command}`;
      case "goal_activation": {
        const phase = result.data.phase;
        if (phase === "confirm") return "/goal — confirm activation";
        if (phase === "optimizing") return "/goal — optimizing...";
        if (phase === "review") return "/goal — review optimized objective";
        if (phase === "error") return "/goal — optimization failed";
        return "/goal";
      }
      case "model_picker": {
        const phase = result.data.phase;
        if (phase === "loading") return "/model — loading…";
        if (phase === "confirm-switch") return "/model — confirm dialect switch";
        if (phase === "switching") return "/model — switching…";
        if (phase === "error") return "/model — failed";
        return "/model — pick a model";
      }
      case "model_switched": return "/model — switched";
    }
  })();

  const flat = variant === "flat";
  return (
    <div
      role="region"
      aria-label={title}
      style={{
        background: flat ? "transparent" : "var(--surface-soft, rgba(0, 0, 0, 0.04))",
        border: flat ? "none" : "1px solid var(--border, rgba(0, 0, 0, 0.12))",
        borderRadius: flat ? 0 : "0.5rem",
        padding: flat ? "0.15rem 0.1rem" : "0.55rem 0.85rem",
        margin: flat ? 0 : "0.4rem 0.75rem",
        fontSize: "0.9em",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
        }}
      >
        <strong style={{ flex: 1 }}>{title}</strong>
        <button
          type="button"
          className="config-edit-btn"
          onClick={() => setCollapsed((c) => !c)}
          style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="config-edit-btn"
          onClick={onDismiss}
          style={{ padding: "0.1rem 0.4rem", fontSize: "0.85em" }}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {!collapsed && <Body result={result} onDismiss={onDismiss} />}
    </div>
  );
}

function Body({ result, onDismiss }: { result: SlashResult; onDismiss: () => void }) {
  switch (result.kind) {
    case "error":
      return (
        <div style={{ color: "var(--error)" }}>
          {result.data.message}
        </div>
      );

    case "stop_result":
      return <div>{result.data.message}</div>;

    case "compact_result":
      return <div>{result.data.message}</div>;

    case "goal_activated":
      return <div>{result.data.message}</div>;

    case "system_status":
      // Detail is multi-line plain text; render as monospace pre so
      // the layout from formatStatusReportForChat is preserved.
      return (
        <pre
          style={{
            margin: 0,
            padding: "0.4rem 0.6rem",
            background: "rgba(0, 0, 0, 0.04)",
            borderRadius: "0.25rem",
            maxHeight: 320,
            overflow: "auto",
            fontSize: "0.85em",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {result.data.detail || "(no detail)"}
        </pre>
      );

    case "goal_activation":
      return <GoalActivationBody data={result.data} />;

    case "model_picker":
      return <ModelPickerBody data={result.data} onDismiss={onDismiss} />;

    case "model_switched":
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          <div>{result.data.message}</div>
          <div style={{ opacity: 0.7, fontSize: "0.85em" }}>
            Provider: {result.data.provider} · Dialect: {result.data.dialect}
          </div>
        </div>
      );
  }
}

type ModelPickerData = Extract<SlashResult, { kind: "model_picker" }>["data"];

function ModelPickerBody({ data, onDismiss }: { data: ModelPickerData; onDismiss: () => void }) {
  if (data.phase === "loading") {
    return <div style={{ opacity: 0.7 }}>Loading available models…</div>;
  }
  if (data.phase === "error") {
    return <div style={{ color: "var(--error)" }}>{data.errorMessage || "Failed to load models"}</div>;
  }
  if (data.phase === "switching") {
    return <div style={{ opacity: 0.7 }}>Switching to {data.pendingPick?.modelName ?? "…"}…</div>;
  }
  if (data.phase === "confirm-switch" && data.pendingPick) {
    const fromDialect = data.current?.apiDialect ?? "(default)";
    const toDialect = data.pendingPick.apiDialect;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ fontSize: "0.9em" }}>
          Switching dialect: <strong>{fromDialect}</strong> → <strong>{toDialect}</strong>.
        </div>
        <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
          Replaying prior turns under the new dialect may downgrade some content:
          <ul style={{ margin: "0.25rem 0 0.25rem 1.2rem" }}>
            <li>Anthropic <code>thinking</code> blocks are dropped silently on OpenAI-compat (no behavior change today; logged for telemetry).</li>
            <li><code>tool_result</code> images on OpenAI-compat are replaced by <code>[image elided]</code> placeholders.</li>
          </ul>
        </div>
        <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
          <button type="button" className="config-edit-btn" onClick={data.onCancelSwitch}>Cancel</button>
          <button type="button" className="config-edit-btn" onClick={() => { void data.onConfirmSwitch(); }}>
            Confirm switch
          </button>
        </div>
      </div>
    );
  }

  // phase === "list" — extracted so its hooks aren't gated behind the
  // early returns above (rules-of-hooks).
  return <ModelPickerList data={data} onDismiss={onDismiss} />;
}

/**
 * Keyboard-navigable model list. Autofocuses on open so ↑/↓ move the
 * highlight (the "Reset to agent default" row is index 0, models follow),
 * Enter commits, Esc closes. Mouse hover keeps the highlight in sync.
 */
function ModelPickerList({ data, onDismiss }: { data: ModelPickerData; onDismiss: () => void }) {
  const opts = data.options;
  const currentKey = data.current?.modelName ?? "";

  // Flat row model: index 0 is the reset row, 1..n are the options.
  const rows: Array<{ disabled: boolean; pick: () => void }> = [
    { disabled: !data.current, pick: () => { void data.onPick(null); } },
    ...opts.map((o) => ({ disabled: false, pick: () => { void data.onPick(o.modelName); } })),
  ];

  // Start the highlight on the current model (or the reset row).
  const currentOptIdx = opts.findIndex((o) => o.modelName === currentKey);
  const [activeIndex, setActiveIndex] = useState(currentOptIdx >= 0 ? currentOptIdx + 1 : 0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus the list so keys land here without a click. preventScroll so
  // the page doesn't jump when the card appears.
  useEffect(() => {
    const el = containerRef.current;
    if (el && typeof el.focus === "function") {
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    }
  }, []);

  // Keep the active row in view as the user arrows past the fold.
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-mp-index="${activeIndex}"]`);
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const move = (delta: number) =>
    setActiveIndex((i) => ((i + delta) % rows.length + rows.length) % rows.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row && !row.disabled) row.pick();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
    }
  };

  const rowBg = (isActive: boolean, isCurrent: boolean) =>
    isActive ? "var(--surface-hover, rgba(0,0,0,0.06))" : isCurrent ? "rgba(0,0,0,0.04)" : "transparent";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <div style={{ fontSize: "0.85em", opacity: 0.7 }}>
        Current: <strong>{data.current?.modelName ?? "(default)"}</strong>
        {data.current ? ` · ${data.current.providerLabel} · ${data.current.apiDialect}` : ""}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="listbox"
        aria-label="Available models"
        aria-activedescendant={`mp-opt-${activeIndex}`}
        onKeyDown={onKeyDown}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.2rem",
          maxHeight: 320,
          overflow: "auto",
          border: "1px solid var(--border, rgba(0,0,0,0.08))",
          borderRadius: "0.3rem",
          padding: "0.3rem",
          outline: "none",
        }}
      >
        <button
          id="mp-opt-0"
          data-mp-index={0}
          type="button"
          role="option"
          aria-selected={activeIndex === 0}
          className="config-edit-btn"
          style={{
            textAlign: "left",
            padding: "0.3rem 0.5rem",
            background: rowBg(activeIndex === 0, false),
            borderColor: "transparent",
            boxShadow: activeIndex === 0 ? "inset 2px 0 0 var(--accent, #3b82f6)" : undefined,
            opacity: data.current ? 1 : 0.5,
          }}
          onMouseEnter={() => setActiveIndex(0)}
          onClick={() => { void data.onPick(null); }}
          disabled={!data.current}
        >
          ⤺ Reset to agent default
        </button>
        {opts.length === 0 ? (
          <div style={{ padding: "0.4rem 0.5rem", opacity: 0.6, fontSize: "0.9em" }}>
            No models found in <code>config/executors.json</code>.
          </div>
        ) : (
          opts.map((opt, i) => {
            const rowIndex = i + 1;
            const isActive = activeIndex === rowIndex;
            const isCurrent = opt.modelName === currentKey;
            return (
              <button
                key={opt.modelName}
                id={`mp-opt-${rowIndex}`}
                data-mp-index={rowIndex}
                type="button"
                role="option"
                aria-selected={isActive}
                className="config-edit-btn"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0.4rem",
                  alignItems: "center",
                  textAlign: "left",
                  padding: "0.3rem 0.5rem",
                  background: rowBg(isActive, isCurrent),
                  borderColor: "transparent",
                  boxShadow: isActive ? "inset 2px 0 0 var(--accent, #3b82f6)" : undefined,
                  fontWeight: isCurrent ? 600 : 400,
                }}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => { void data.onPick(opt.modelName); }}
              >
                <span>
                  {opt.modelName}
                  <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: "0.4rem", fontSize: "0.85em" }}>
                    {opt.providerLabel} · {opt.apiDialect}
                    {opt.recent ? " · recent" : ""}
                  </span>
                </span>
                {isCurrent ? <span style={{ fontSize: "0.85em", opacity: 0.6 }}>current</span> : null}
              </button>
            );
          })
        )}
      </div>
      <div style={{ fontSize: "0.75em", opacity: 0.5 }}>↑↓ navigate · Enter select · Esc close</div>
    </div>
  );
}

function GoalActivationBody({ data }: { data: Extract<SlashResult, { kind: "goal_activation" }>["data"] }) {
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState("");
  const isFreshChat = data.taskId === null;

  if (data.phase === "confirm") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <div>
          <div style={{ opacity: 0.7, fontSize: "0.85em", marginBottom: 2 }}>Objective:</div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{data.original}</div>
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="config-edit-btn"
            disabled={isFreshChat}
            title={isFreshChat ? "Optimization needs a conversation to optimize from. Start chatting first." : "Rewrite the goal with context from current conversation"}
            onClick={() => { void data.onOptimize(); }}
          >
            ✨ Optimize first
          </button>
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => data.onActivate(data.original)}
          >
            → Activate as-is
          </button>
        </div>
      </div>
    );
  }
  if (data.phase === "optimizing") {
    return <div style={{ opacity: 0.7 }}>Optimizing objective with current context...</div>;
  }
  if (data.phase === "review" && data.optimized) {
    if (editing) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <div style={{ opacity: 0.7, fontSize: "0.85em", marginBottom: 2 }}>Edit objective:</div>
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={Math.min(8, Math.max(3, editedText.split("\n").length + 1))}
            style={{
              width: "100%",
              padding: "0.4rem",
              fontFamily: "inherit",
              fontSize: "inherit",
              border: "1px solid var(--border, rgba(0, 0, 0, 0.2))",
              borderRadius: "0.25rem",
              background: "var(--surface, white)",
              color: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="config-edit-btn"
              onClick={() => {
                const final = editedText.trim();
                if (final) data.onActivate(final);
              }}
              disabled={editedText.trim().length === 0}
            >
              Activate edited
            </button>
            <button
              type="button"
              className="config-edit-btn"
              onClick={() => setEditing(false)}
            >
              Cancel edit
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {data.overrideWarning ? (
          <div
            role="alert"
            style={{
              padding: "0.35rem 0.5rem",
              border: "1px solid var(--warning, rgba(180, 120, 0, 0.5))",
              background: "var(--warning-soft, rgba(255, 200, 100, 0.12))",
              borderRadius: "0.25rem",
              fontSize: "0.85em",
            }}
          >
            ⚠ {data.overrideWarning}
          </div>
        ) : null}
        <div>
          <div style={{ opacity: 0.7, fontSize: "0.85em", marginBottom: 2 }}>Original:</div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.85 }}>{data.original}</div>
        </div>
        <div>
          <div style={{ opacity: 0.7, fontSize: "0.85em", marginBottom: 2 }}>Optimized{data.compressed ? " (context was snipped)" : ""}:</div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{data.optimized}</div>
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <button type="button" className="config-edit-btn" onClick={() => data.onActivate(data.optimized!)}>
            Use optimized
          </button>
          <button
            type="button"
            className="config-edit-btn"
            onClick={() => {
              setEditedText(data.optimized ?? "");
              setEditing(true);
            }}
          >
            Edit...
          </button>
          <button type="button" className="config-edit-btn" onClick={() => data.onActivate(data.original)}>
            Use original
          </button>
        </div>
      </div>
    );
  }
  if (data.phase === "error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <div style={{ color: "var(--error)" }}>{data.errorMessage ?? "Optimization failed."}</div>
        <div>
          <div style={{ opacity: 0.7, fontSize: "0.85em", marginBottom: 2 }}>Original:</div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{data.original}</div>
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button type="button" className="config-edit-btn" onClick={() => data.onActivate(data.original)}>
            → Activate as-is
          </button>
        </div>
      </div>
    );
  }
  return null;
}
