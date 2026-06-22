import { useEffect, useMemo, useRef, useState } from "react";
import { getMcpPrompts, type McpPromptDescriptor } from "../../lib/api";

/**
 * Built-in slash commands handled by the chat shell directly (no MCP
 * round-trip). Distinguished from MCP prompts at the menu level so the
 * caller can dispatch the right action — built-ins typically navigate
 * or open a panel; prompts seed a new task.
 */
export type SlashBuiltin = {
  name: string;
  description: string;
  available?: (ctx: Record<string, unknown>) => boolean;
};

/**
 * Flattened, ordered menu entry. Built-ins come first, then MCP
 * prompts — the same order they render in. Reported up to the parent
 * (ChatInput) via `onItemsChange` so the textarea's keydown handler can
 * map `activeIndex` → the right select action without re-deriving the
 * filtered/ordered list (which lives here, behind the async prompt
 * fetch).
 */
export type SlashMenuItem =
  | { type: "builtin"; builtin: SlashBuiltin }
  | { type: "prompt"; prompt: McpPromptDescriptor };

/** True if `needle`'s chars appear in order within `haystack` (e.g.
 *  "cmp" ⊂ "compact"). Both args must already be lowercased. */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Match quality of `needle` against one field — lower is better:
 *  0 = prefix, 1 = substring, 2 = subsequence, null = no match. */
function matchScore(haystack: string, needle: string): number | null {
  if (haystack.startsWith(needle)) return 0;
  if (haystack.includes(needle)) return 1;
  return isSubsequence(needle, haystack) ? 2 : null;
}

/** Best score across an item's fields. Field 0 (the name) keeps its
 *  tier; later fields (description / server) are demoted so a name match
 *  always outranks a description-only match. Empty needle → 0 (neutral,
 *  preserves source order). */
function bestScore(fields: string[], needle: string): number | null {
  if (!needle) return 0;
  let best: number | null = null;
  for (let i = 0; i < fields.length; i++) {
    const s = matchScore(fields[i]!.toLowerCase(), needle);
    if (s === null) continue;
    const weighted = i === 0 ? s : s + 3;
    if (best === null || weighted < best) best = weighted;
  }
  return best;
}

export function SlashMenu({
  filter,
  onSelect,
  onSelectBuiltin,
  builtins,
  onClose,
  builtinContext,
  activeIndex,
  onItemsChange,
  onHoverIndex,
}: {
  filter: string;
  onSelect: (prompt: McpPromptDescriptor) => void;
  onSelectBuiltin: (builtin: SlashBuiltin) => void;
  builtins: SlashBuiltin[];
  onClose: () => void;
  builtinContext?: Record<string, unknown>;
  /** Index of the keyboard-highlighted row (managed by ChatInput). */
  activeIndex: number;
  /** Reports the ordered, filtered entry list up to the parent so its
   *  keydown handler can resolve `activeIndex` → select action. */
  onItemsChange: (items: SlashMenuItem[]) => void;
  /** Mouse hover sets the active row so pointer + keyboard agree. */
  onHoverIndex: (index: number) => void;
}) {
  const [prompts, setPrompts] = useState<McpPromptDescriptor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getMcpPrompts();
        if (!cancelled) setPrompts(data.items);
      } catch {
        if (!cancelled) setPrompts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only the first word of the filter is the command name. The rest are
  // arguments (e.g. "/goal fix the bug" → command="goal", args="fix the bug").
  // Without this, typing "/goal hello" filters by the literal string
  // "goal hello" and matches nothing.
  const f = filter.toLowerCase().split(/\s+/, 1)[0] ?? "";

  // Ranked, flattened entry list. Each candidate is scored against the
  // command token (prefix > substring > subsequence; name beats
  // description), then sorted by score → built-ins-first on ties →
  // source order. This replaces the old "all built-ins, then all
  // prompts, plain substring filter" so typing `/cl` lands on `clear`
  // (prefix) above `goal` (matches via its "clear" description), and
  // `/cmpct` still finds `compact` via subsequence.
  const items = useMemo<SlashMenuItem[]>(() => {
    type Scored = { item: SlashMenuItem; score: number; typeRank: number; idx: number };
    const scored: Scored[] = [];
    builtins.forEach((b, idx) => {
      if (b.available && !b.available(builtinContext ?? {})) return;
      const s = bestScore([b.name, b.description], f);
      if (s !== null) scored.push({ item: { type: "builtin", builtin: b }, score: s, typeRank: 0, idx });
    });
    prompts.forEach((p, idx) => {
      const s = bestScore([p.name, p.serverName, p.description ?? ""], f);
      if (s !== null) scored.push({ item: { type: "prompt", prompt: p }, score: s, typeRank: 1, idx });
    });
    scored.sort((a, b) => a.score - b.score || a.typeRank - b.typeRank || a.idx - b.idx);
    return scored.map((s) => s.item);
    // builtinContext is a dep so availability (e.g. /compact, /stop)
    // re-evaluates when the task's running state flips while the menu is
    // open. Its identity churns each render, so this memo effectively
    // recomputes per render — fine for a tiny list, and the upstream
    // report is gated by the signature-keyed effect below.
  }, [builtins, prompts, f, builtinContext]);

  // Report the ordered list up to the parent, but only when the SET
  // actually changes (signature key) — not on every render — so we
  // don't thrash the parent's clamp/reset state.
  const itemsKey = items
    .map((it) => (it.type === "builtin" ? `b:${it.builtin.name}` : `p:${it.prompt.serverId}:${it.prompt.name}`))
    .join("|");
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  useEffect(() => {
    onItemsChangeRef.current(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // stable signature; `items` identity churns every render by design.
  }, [itemsKey]);

  const hasAny = items.length > 0;

  // Keep the keyboard-highlighted row scrolled into view as the user
  // arrows past the visible window.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-slash-index="${activeIndex}"]`);
    // `scrollIntoView` is absent in jsdom (tests) and some headless envs.
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Close button sits OUTSIDE the inner role="listbox" container —
  // ARIA requires children of role="listbox" to be options.
  return (
    <div className="slash-menu" aria-label="Slash commands">
      <button type="button" className="slash-menu__close" onClick={onClose} aria-label="Close menu">
        {"×"}
      </button>
      {loading && !hasAny ? (
        <div className="slash-menu__empty">Loading…</div>
      ) : !hasAny ? (
        <div className="slash-menu__empty">
          {filter
            ? `No matches for "${filter}".`
            : "No commands or MCP prompts available."}
        </div>
      ) : (
        <div role="listbox" aria-label="Available commands" ref={listRef}>
          {items.map((item, index) => {
            const isActive = index === activeIndex;
            const className = `slash-menu__item${isActive ? " slash-menu__item--active" : ""}`;
            if (item.type === "builtin") {
              const b = item.builtin;
              return (
                <button
                  key={`builtin:${b.name}`}
                  type="button"
                  className={className}
                  data-slash-index={index}
                  onClick={() => onSelectBuiltin(b)}
                  onMouseEnter={() => onHoverIndex(index)}
                  role="option"
                  aria-selected={isActive}
                >
                  <span className="slash-menu__server">built-in</span>
                  <span className="slash-menu__name">/{b.name}</span>
                  <span className="slash-menu__desc">{b.description}</span>
                </button>
              );
            }
            const p = item.prompt;
            return (
              <button
                key={`${p.serverId}:${p.name}`}
                type="button"
                className={className}
                data-slash-index={index}
                onClick={() => onSelect(p)}
                onMouseEnter={() => onHoverIndex(index)}
                role="option"
                aria-selected={isActive}
              >
                <span className="slash-menu__server">{p.serverName}</span>
                <span className="slash-menu__name">/{p.name}</span>
                {p.description ? <span className="slash-menu__desc">{p.description}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
