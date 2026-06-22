import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GoalPill } from "./GoalPill";
import { ActiveTeammatesPanel } from "./ActiveTeammatesPanel";
import { useParams } from "react-router-dom";
import { useSelectedTaskId } from "../../hooks/useSelectedTaskId";
import { useChatStore } from "../../stores/chatStore";
import { useTaskStore } from "../../stores/taskStore";
import { cancelGoal, getTask, getTaskMessages, getTaskTurnSummaries } from "../../lib/api";
import type { TurnSummary } from "../../lib/types";
import { ExchangeView } from "./conversation/render";

import { attachChatStoreSSEAdapter } from "./conversation/sseAdapter";

/**
 * Memoized markdown renderer for assistant text. Vanilla react-markdown
 * with GFM (tables, strikethrough, autolink) — no extra widgets, no
 * Tailwind. Styled by `.message-bubble .markdown-body` rules in chat.css.
 *
 * react-markdown + remark-gfm wrapped in memo with a children-equality
 * comparator so completed messages skip re-parse on parent re-renders.
 */
const MessageMarkdown = memo(
  function MessageMarkdown({ children }: { children: string }) {
    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
      </div>
    );
  },
  (a, b) => a.children === b.children,
);


/**
 * Compact collapsible row that merges a tool_call + tool_result into one
 * line: status icon + tool name + dim args summary, click to expand for
 * full args + result. Replaces the previous two full-width rows per tool
 * call.
 */
type ToolPairRowProps = {
  call: Message | null;
  result: Message | null;
};
const ToolPairRow = memo(function ToolPairRow({ call, result }: ToolPairRowProps) {
  const [expanded, setExpanded] = useState(false);
  const status: "running" | "ok" | "error" = result
    ? (result.isError ? "error" : "ok")
    : "running";
  const toolName = call?.toolName ?? result?.toolName ?? "tool";
  const argsSummary = (() => {
    const detail = call?.detail;
    if (!detail) return "";
    // First line of detail, capped to a one-line summary.
    // detail is JSON-pretty-printed for live rows; collapse here.
    const compact = detail.replace(/\s+/g, " ").trim();
    return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
  })();

  const icon = status === "running" ? (
    <span className="tool-pair-row__icon tool-pair-row__icon--running" aria-hidden="true">⏳</span>
  ) : status === "error" ? (
    <span className="tool-pair-row__icon tool-pair-row__icon--error" aria-hidden="true">❌</span>
  ) : (
    <span className="tool-pair-row__icon tool-pair-row__icon--ok" aria-hidden="true">✓</span>
  );

  return (
    <div className="message-row message-row--tool-pair">
      <button
        type="button"
        className="tool-pair-row"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {icon}
        <span className="tool-pair-row__name">{toolName}</span>
        {argsSummary && <span className="tool-pair-row__args">{argsSummary}</span>}
        <span className="tool-pair-row__chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-pair-row__body">
          {call?.detail && (
            <div className="tool-pair-row__section">
              <div className="tool-pair-row__section-label">Args</div>
              <pre className="tool-pair-row__pre">{call.detail}</pre>
            </div>
          )}
          {result ? (
            <div className="tool-pair-row__section">
              <div className="tool-pair-row__section-label">
                {result.isError ? "Error" : "Result"}
              </div>
              <pre className="tool-pair-row__pre">{result.detail ?? "(no output)"}</pre>
            </div>
          ) : (
            <div className="tool-pair-row__section tool-pair-row__section--running">
              Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.call?.id === next.call?.id
  && prev.result?.id === next.result?.id
  && prev.result?.isError === next.result?.isError
  && prev.result?.detail === next.result?.detail);

/**
 * Auto-group of N consecutive *completed* tool-pair rows into a single
 * collapsible header "Used N tools — name1, name2, …".
 *
 * Only kicks in for >=2 pairs that have all completed. While any pair is
 * still running, the parent render keeps them flat so live progress shows.
 */
type ToolGroupProps = {
  pairs: Array<{ key: string; call: Message | null; result: Message | null }>;
  /** True on first mount of this group. Use a stable groupKey across
   * re-renders so the open state survives. */
  defaultOpen: boolean;
};
const ToolGroup = memo(function ToolGroup({ pairs, defaultOpen }: ToolGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Show up to 3 distinct tool names. "+N more" refers to the count of
  // additional UNIQUE names beyond the displayed list — not call count,
  // since a turn can call the same tool many times and that's not "more
  // tools".
  const allNames = pairs.map((p) => p.call?.toolName ?? p.result?.toolName ?? "tool");
  const uniqueNames = Array.from(new Set(allNames));
  const displayedNames = uniqueNames.slice(0, 3);
  const extraUnique = uniqueNames.length - displayedNames.length;
  const summary = `${displayedNames.join(", ")}${extraUnique > 0 ? ` +${extraUnique} more` : ""}`;

  return (
    <div className="message-row message-row--tool-group">
      <button
        type="button"
        className="tool-group-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-group-header__icon" aria-hidden="true">📁</span>
        <span className="tool-group-header__label">Used {pairs.length} tools</span>
        <span className="tool-group-header__summary">— {summary}</span>
        <span className="tool-group-header__chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-group__body">
          {pairs.map((p) => (
            <ToolPairRow key={p.key} call={p.call} result={p.result} />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if (prev.pairs.length !== next.pairs.length) return false;
  for (let i = 0; i < prev.pairs.length; i++) {
    if (prev.pairs[i]!.key !== next.pairs[i]!.key) return false;
    if (prev.pairs[i]!.result?.id !== next.pairs[i]!.result?.id) return false;
  }
  return true;
});

type Message = {
  id: string;
  role: "user" | "assistant" | "tool-call" | "tool-result" | "meta";
  content: string;
  detail?: string | undefined;
  toolName?: string | undefined;
  /** The id of the tool_use block this row belongs to (set on both
   * tool-call and tool-result rows). Used at render time to pair them
   * into a single collapsible <ToolPairRow/>. */
  toolUseId?: string | undefined;
  isError?: boolean | undefined;
  /** Backend requestId stamped on user-role LeaderMessage at creation.
   * Used by chatStore.hydrateUserPrompts to bind prompts to exchanges
   * by id (precise) instead of by tail position (fragile when one
   * leader run absorbs multiple mailbox prompts). Absent for old
   * checkpoints predating this field — the hydrate code falls back
   * to tail-pair when every prompt is missing this. */
  requestId?: string | undefined;
};

type CompactionEvent = {
  id: string;
  preTokens: number;
  postTokens: number;
  truncated: number;
  snipped: number;
  dropped: number;
  llmCompacted: boolean;
  timestamp: number;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: unknown): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          "text" in b &&
          typeof (b as { text: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return String(content ?? "");
}

function parseMessages(raw: unknown[]): Message[] {
  const messages: Message[] = [];

  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as {
      type: string;
      content: unknown;
      toolUseId?: string;
      isError?: boolean;
      isMeta?: boolean;
      requestId?: string;
    };

    if (m.type === "user") {
      const text = extractText(m.content);
      if (text) {
        const normalized = text.trim();
        if (m.isMeta === true && normalized.startsWith("[")) {
          const [headline, ...detailLines] = normalized.split("\n");
          const detail = detailLines.join("\n").trim();
          messages.push({
            id: `msg-${i}-meta`,
            role: "meta",
            content: headline ?? normalized,
            detail: detail || undefined,
          });
          continue;
        }
        messages.push({
          id: `msg-${i}`,
          role: "user",
          content: text,
          ...(m.requestId ? { requestId: m.requestId } : {}),
        });
      }
    } else if (m.type === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];

      const textBlocks = blocks.filter(
        (b: { type: string; text?: string }) => b.type === "text" && b.text,
      );
      if (textBlocks.length > 0) {
        messages.push({
          id: `msg-${i}-text`,
          role: "assistant",
          content: textBlocks.map((b: { text: string }) => b.text).join("\n"),
        });
      }

      const toolBlocks = blocks.filter(
        (b: { type: string }) => b.type === "tool_use",
      );
      for (const tool of toolBlocks) {
        const t = tool as { id?: string; name?: string; input?: unknown };
        messages.push({
          id: `msg-${i}-tool-${t.id ?? "unknown"}`,
          role: "tool-call",
          toolName: t.name,
          toolUseId: t.id,
          content: `🔧 ${t.name ?? "tool"}`,
          detail: t.input ? JSON.stringify(t.input, null, 2) : undefined,
        });
      }
    } else if (m.type === "tool_result") {
      const isError = m.isError;
      const rawContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      messages.push({
        id: `msg-${i}-result`,
        role: "tool-result",
        isError,
        toolUseId: m.toolUseId,
        content: `${isError ? "❌" : "✅"} Result`,
        detail: rawContent.length > 0 ? rawContent : undefined,
      });
    } else {
      const text = extractText(m.content);
      if (text) {
        messages.push({ id: `msg-${i}`, role: "assistant", content: text });
      }
    }
  }

  return messages;
}

function formatTokens(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

// Memoized so that the typewriter's per-frame setMessages on the streaming
// bubble doesn't force a re-render of every prior done message in a long
// conversation. Comparing message identity (id + content + done flag) is
// enough — these are the only fields that change for a non-streaming row.
const ExpandableMessage = memo(function ExpandableMessage({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false);

  if (msg.role === "meta") {
    const hasDetail = Boolean(msg.detail && msg.detail.trim().length > 0);
    return (
      <div className="chat-compaction-notice">
        <div
          className="chat-compaction-header"
          onClick={hasDetail ? () => setExpanded((prev) => !prev) : undefined}
        >
          <span>📦 {msg.content}</span>
          {hasDetail && (
            <span className="chat-compaction-toggle">{expanded ? "▾" : "▸"}</span>
          )}
        </div>
        {expanded && hasDetail && (
          <div className="chat-compaction-details">
            <div>{msg.detail}</div>
          </div>
        )}
      </div>
    );
  }

  const isToolMsg = msg.role === "tool-call" || msg.role === "tool-result";
  const isAssistant = msg.role === "assistant";

  return (
    <div className={`message-row message-row--${msg.role}`}>
      <div
        className={`message-bubble message-${msg.role} ${isToolMsg && msg.detail ? "message-expandable" : ""}`}
        onClick={isToolMsg && msg.detail ? () => setExpanded(!expanded) : undefined}
      >
        {/* Render assistant content as markdown so **bold**, code fences,
            lists, headings show correctly. User and tool rows stay plain
            text — that matches the standard convention. */}
        {isAssistant ? <MessageMarkdown>{msg.content}</MessageMarkdown> : msg.content}
        {isToolMsg && msg.detail && (
          <span className="message-expand-hint">{expanded ? " ▾" : " ▸"}</span>
        )}
      </div>
      {expanded && msg.detail && (
        <pre className="message-detail">{msg.detail}</pre>
      )}
    </div>
  );
}, (prev, next) => prev.msg.id === next.msg.id
  && prev.msg.content === next.msg.content
  && prev.msg.detail === next.msg.detail
  && prev.msg.isError === next.msg.isError);

/** Chat renders only the last N user-turn groups by default. The full history
 * is still kept in state and can be revealed via the "Show earlier" banner. */
const VISIBLE_TURN_LIMIT = 15;

/** Slice messages so only the last `limit` user turns are visible. Returns
 * { visible, hidden } where `hidden` is how many messages were trimmed. */
export function sliceToRecentTurns(messages: Message[], limit: number): { visible: Message[]; hidden: number } {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") userIndices.push(i);
  }
  if (userIndices.length <= limit) {
    return { visible: messages, hidden: 0 };
  }
  const firstKeptIdx = userIndices[userIndices.length - limit]!;
  return { visible: messages.slice(firstKeptIdx), hidden: firstKeptIdx };
}

export function ChatArea() {
  const tasks = useTaskStore((s) => s.tasks);
  const selectedTaskId = useSelectedTaskId();
  // URL is the source of truth for the active workspace inside the
  // chat shell (ChatPage already handles redirecting the picker into
  // the URL). Reading via useParams keeps this dependency cheap and
  // free of side effects so tests don't need a workspace context.
  const { workspaceId: urlWorkspaceId } = useParams<{ workspaceId?: string }>();
  const loading = useTaskStore((s) => s.loading);
  const isWaitingForResponse = useTaskStore((s) => s.isWaitingForResponse);
  const chatRefreshCounter = useTaskStore((s) => s.chatRefreshCounter);
  const [messages, setMessages] = useState<Message[]>([]);
  const [compactionEvents, setCompactionEvents] = useState<CompactionEvent[]>([]);
  const [turnSummaries, setTurnSummaries] = useState<Record<string, TurnSummary>>({});
  const [expandedCompactions, setExpandedCompactions] = useState<Record<string, boolean>>({});
  const [fetching, setFetching] = useState(false);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);
  // Stash of /messages user prompts that chatStore re-applies whenever its
  // exchange count for this task changes (the /messages fetch can race the
  // SSE snapshot — whichever lands first, the prompts get applied as soon
  // as both sides have data).
  const pendingUserPromptsRef = useRef<Array<{ content: string; requestId?: string }>>([]);

  const selectedTask = selectedTaskId
    ? (tasks.find((t) => t.id === selectedTaskId) ?? null)
    : null;
  const selectedTaskState = selectedTask?.state ?? null;

  const toggleCompaction = useCallback((id: string) => {
    setExpandedCompactions((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Subscribe to the chatStore conversation for the current task. This is
  // the ONLY conversational state the modern render path reads. Legacy
  // `messages` array is a fallback for pre-PR-1 tasks (those whose
  // execution_events all carry NULL requestId, dropped by the projector).
  const conversation = useChatStore((s) =>
    selectedTaskId ? s.conversations[selectedTaskId] : undefined,
  );
  // hasModernExchanges: chatStore has any exchange (including pure-optimistic).
  // hasModernAppliedEvents: at least one exchange has applied a server event
  //   (lastAppliedSeq > 0). Distinguishes "user just typed" from "stream live".
  const hasModernExchanges = (conversation?.exchanges.length ?? 0) > 0;
  const hasModernAppliedEvents = useChatStore((s) =>
    selectedTaskId ? s.hasModernEvents(selectedTaskId) : false,
  );
  // Render modern when we have any exchange AND either:
  //   (a) there's no legacy history for this task — i.e. it's a fresh or
  //       fully-modern task, so the optimistic exchange should show its
  //       user bubble + thinking dots immediately on Enter without waiting
  //       for SSE to deliver the first event; or
  //   (b) at least one server event has applied — the new turn is
  //       confirmed modern, render its progress.
  // The narrow remaining case (legacy task + optimistic-only follow-up,
  // before any event applies) keeps the legacy fallback so pre-PR-1
  // history stays visible while SSE catches up.
  const isModern = hasModernExchanges && (messages.length === 0 || hasModernAppliedEvents);
  const exchangeCount = conversation?.exchanges.length ?? 0;
  useEffect(() => {
    if (!selectedTaskId) return;
    const prompts = pendingUserPromptsRef.current;
    if (prompts.length === 0) return;
    useChatStore.getState().hydrateUserPrompts(selectedTaskId, prompts);
  }, [selectedTaskId, exchangeCount]);

  // Reset state when navigating to a different task.
  useEffect(() => {
    pendingUserPromptsRef.current = [];
    const store = useTaskStore.getState();
    if (!store.isWaitingForResponse) {
      setMessages([]);
    }
    setCompactionEvents([]);
    setTurnSummaries({});
    setExpandedCompactions({});
    setShowAllTurns(false);
  }, [selectedTaskId]);

  const terminalExchangeKey = (conversation?.exchanges ?? [])
    .map((exchange) => `${exchange.id}:${exchange.status}`)
    .join("|");

  useEffect(() => {
    if (!selectedTaskId) {
      setTurnSummaries({});
      return;
    }
    let cancelled = false;
    getTaskTurnSummaries(selectedTaskId)
      .then((items) => {
        if (cancelled) return;
        setTurnSummaries(Object.fromEntries(items.map((item) => [item.requestId, item])));
      })
      .catch(() => {
        if (!cancelled) setTurnSummaries({});
      });
    return () => { cancelled = true; };
  }, [selectedTaskId, chatRefreshCounter, terminalExchangeKey]);

  // ── Fetch messages from API (legacy fallback + chatStore prompt hydrate) ──

  useEffect(() => {
    if (!selectedTaskId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const store = useTaskStore.getState();
    const isInitialLoad = messages.length === 0 && !store.isWaitingForResponse;
    if (isInitialLoad) setFetching(true);

    getTaskMessages(selectedTaskId, { tail: true, limit: 120 })
      .then((data) => {
        if (cancelled) return;
        const fetched = parseMessages(data.messages);
        setFetching(false);

        // Hydrate user prompts into chatStore. The execution_events stream
        // doesn't carry user content; the /messages API does. We bind by
        // backend-stamped requestId when available, falling back to
        // tail-position pairing for old checkpoints where the field is
        // absent on every prompt (see chatStore.hydrateUserPrompts for
        // the fallback rule).
        //
        // Race timing: the SSE snapshot may not have arrived yet, so
        // chatStore exchanges may be empty at the moment this fetch
        // resolves — hydrateUserPrompts would no-op then. Stash the
        // prompts on a ref and let a separate effect re-apply them
        // every time chatStore's exchange count changes for this task.
        const promptsInOrder = fetched
          .filter((m) => m.role === "user")
          .map((m) => ({
            content: m.content,
            ...(m.requestId ? { requestId: m.requestId } : {}),
          }));
        pendingUserPromptsRef.current = promptsInOrder;
        if (promptsInOrder.length > 0) {
          useChatStore.getState().hydrateUserPrompts(selectedTaskId, promptsInOrder);
        }

        // Legacy fallback: pre-PR-1 tasks (events with NULL requestId) drop
        // through chatStore's stale filter, so the legacy `messages` array
        // backs their render. Modern tasks render from chatStore.exchanges
        // and never read `messages` — assigning here is harmless.
        setMessages(fetched);
      })
      .catch(() => {
        if (!cancelled) setFetching(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTaskId, chatRefreshCounter]);

  // ── EventSource → chatStore ──

  // Depend on urlWorkspaceId so that switching workspaces forces SSE
  // to close and reopen, even when the selectedTaskId happens to be
  // the same task id. Without this, a stale SSE connection scoped to
  // the previous workspace can keep pushing events into chatStore
  // after the user has moved on, contaminating the new workspace view.
  useEffect(() => {
    if (!selectedTaskId) return;
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(selectedTaskId)}/stream?light=true`);
    const detach = attachChatStoreSSEAdapter(stream, selectedTaskId);
    return () => {
      detach();
      stream.close();
    };
  }, [selectedTaskId, urlWorkspaceId]);

  // Fallback poll: if SSE/WS miss terminal events (network drop, proxy
  // timeout, restart), the UI stays stuck in "Working" forever. Poll
  // task state every 30s while the task appears active; clear waiting
  // state if the backend reports it as terminal.
  useEffect(() => {
    if (!selectedTaskId) return;
    const interval = setInterval(async () => {
      const tasks = useTaskStore.getState().tasks;
      const task = tasks.find((t) => t.id === selectedTaskId);
      if (task && /done|completed|failed|cancelled|error/i.test(task.state)) return;
      try {
        const fresh = await getTask(selectedTaskId);
        if (/done|completed|failed|cancelled|error/i.test(fresh.state)) {
          useTaskStore.getState().completeSend(selectedTaskId);
          useTaskStore.getState().fetchTasks();
          useChatStore.getState().forceCompleteTask(selectedTaskId);
        }
      } catch { /* best-effort */ }
    }, 30_000);
    return () => clearInterval(interval);
  }, [selectedTaskId]);


  // ── Auto-scroll ──

  // Pin to bottom whenever conversation content grows. Watches both the
  // modern path (exchange count + parts across all exchanges) and the
  // legacy path (flat messages + compaction notices). Streaming text
  // deltas inside a single TextPart don't tick this counter — that's
  // fine, the per-turn growth (new text segment, new tool call, new
  // exchange) is what the user expects "scroll to bottom" to track.
  const modernPartsCount = (conversation?.exchanges ?? []).reduce(
    (sum, ex) => sum + ex.response.parts.length,
    0,
  );
  const totalCount = messages.length + compactionEvents.length + exchangeCount + modernPartsCount;
  useEffect(() => {
    if (totalCount > prevCount.current) {
      // Only pin to bottom if the user is already near the bottom — never
      // yank them down mid-read. Threshold of 100px matches the prior
      // ChatArea behavior.
      const container = containerRef.current;
      const nearBottom =
        !container
        || container.scrollHeight - (container.scrollTop + container.clientHeight) <= 100;
      if (nearBottom) {
        // Bulk deltas (hydration chunks: many parts arriving in a single
        // tick) use instant scroll. Multiple "smooth" calls stacking
        // during hydration produced a visible "sliding upward" animation.
        // Live incremental updates (1-2 parts per tick) keep smooth feel.
        const delta = totalCount - prevCount.current;
        const behavior: ScrollBehavior = delta > 3 ? "auto" : "smooth";
        bottomRef.current?.scrollIntoView({ behavior });
      }
    }
    prevCount.current = totalCount;
  }, [totalCount]);

  // When the user themselves sends a message, force a pin-to-bottom
  // regardless of their current scroll position. The nearBottom check
  // above intentionally respects mid-read state for INCOMING content
  // (model emissions), but the user's own send is implicit consent to
  // see the new exchange. Without this, a user who scrolled up to read
  // history would press Send and never see their typed bubble.
  useEffect(() => {
    const onUserSent = () => {
      // Use rAF so the optimistic exchange has rendered before scroll.
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
      });
    };
    window.addEventListener("magister:chat-pin-bottom", onUserSent);
    return () => window.removeEventListener("magister:chat-pin-bottom", onUserSent);
  }, []);

  // Jump-to-bottom FAB visibility. Tracks distance from the bottom of
  // the scroll container; show the button when the user has scrolled
  // up more than `JUMP_THRESHOLD_PX`, hide it when they're back near
  // the bottom. The same listener drives the streaming-active pulse
  // (`isWaitingForResponse && scrolledUp`) so the user knows the
  // agent is still producing content below their current viewport.
  const JUMP_THRESHOLD_PX = 200;
  const [scrolledUp, setScrolledUp] = useState(false);
  // Listener re-attaches when the render path can flip — task switch
  // or `loading` change. Earlier `[]` deps version attached only
  // once at mount; if that first render hit the loading / empty-state
  // early return (where `<div className="chat-messages">` is rendered
  // WITHOUT `containerRef`), the listener missed the main-path mount
  // entirely and the FAB never appeared.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distance =
        container.scrollHeight - (container.scrollTop + container.clientHeight);
      setScrolledUp(distance > JUMP_THRESHOLD_PX);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Initial measurement after first paint — content may have already
    // grown taller than the viewport before the scroll event ever fires.
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [selectedTaskId, loading, fetching, hasModernExchanges, messages.length]);
  const handleJumpToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // ── Render ──

  // Empty/Loading guards must not hide the modern path. If chatStore has
  // exchanges to render — even pure-optimistic ones — fall through to the
  // render below so the user sees their just-sent prompt + thinking dots
  // without waiting for /messages to round-trip.
  if (!selectedTask && messages.length === 0 && !hasModernExchanges) {
    return (
      <div className="chat-messages">
        <div className="chat-messages__empty">
          <span className="chat-messages__empty-icon" aria-hidden="true">&#128172;</span>
          <h2>Start a new conversation</h2>
          <p>Type a prompt below to create a task, or select a conversation from the sidebar.</p>
        </div>
      </div>
    );
  }

  if ((loading || fetching) && !isWaitingForResponse && messages.length === 0 && !hasModernExchanges) {
    return (
      <div className="chat-messages">
        <div className="chat-messages__loading">Loading messages...</div>
      </div>
    );
  }

  return (
    <>
      {selectedTask && (
        <header className="chat-area-header">
          <span className="chat-area-header__title">{selectedTask.title}</span>
          {/* Inline state badge removed — the state is already conveyed by:
                - WorkbenchNarrativeBanner (yellow/red banner above)
                  for CANCELLED / FAILED / blocked / waiting states
                - Per-session row badge in the Sessions panel on the left
                - Session Context panel state chip on the right
                - Chat-turn-timing strip ("Working Xs") for active turns
              The header chip was the 4th repeat in the same viewport. */}
        </header>
      )}

      {selectedTask?.goalObjective && (
        <GoalPill
          goalObjective={selectedTask.goalObjective ?? null}
          goalStatus={selectedTask.goalStatus ?? null}
          goalStartedAt={selectedTask.goalStartedAt ?? null}
          goalCompletedAt={selectedTask.goalCompletedAt ?? null}
          goalIterations={selectedTask.goalIterations ?? 0}
          goalTokensUsed={selectedTask.goalTokensUsed ?? 0}
          onClear={() => {
            void cancelGoal(selectedTask.id).then(() => {
              useTaskStore.getState().fetchTasks();
            });
          }}
        />
      )}

      <ActiveTeammatesPanel
        taskId={selectedTask?.id ?? null}
        taskState={selectedTask?.state ?? null}
      />

      <div className="chat-messages-frame">
      <div ref={containerRef} className="chat-messages" role="log" aria-live="polite">
        {(() => {
          // Render from chatStore.exchanges for modern tasks (those with
          // at least one applied server event tagged with a requestId
          // post-PR-1, per `hasModernEvents`). Legacy tasks (pre-PR-1,
          // all events have NULL requestId, dropped by the projector)
          // fall back to the flat-messages render below. The `isModern`
          // gate intentionally ignores pure-optimistic exchanges so that
          // typing a follow-up on a legacy task does not blank out its
          // history before SSE has responded.
          if (isModern && conversation) {
            const limit = showAllTurns ? Infinity : VISIBLE_TURN_LIMIT;
            const total = conversation.exchanges.length;
            const visible = total <= limit
              ? conversation.exchanges
              : conversation.exchanges.slice(total - limit);
            const hidden = total - visible.length;
            return (
              <>
                {hidden > 0 && (
                  <button
                    type="button"
                    className="chat-window-banner"
                    onClick={() => setShowAllTurns(true)}
                  >
                    Show earlier ({hidden} hidden)
                  </button>
                )}
                {visible.map((exchange) => (
                  <ExchangeView
                    key={exchange.id}
                    exchange={exchange}
                    taskId={selectedTaskId!}
                    turnSummary={turnSummaries[exchange.id]}
                  />
                ))}
              </>
            );
          }

          // Legacy fallback — pre-PR-1 tasks. Same flat-array
          // pair-and-group rendering as before. Will be deleted in a
          // follow-up once no production tasks remain pre-requestId.
          const { visible, hidden } = showAllTurns
            ? { visible: messages, hidden: 0 }
            : sliceToRecentTurns(messages, VISIBLE_TURN_LIMIT);
          return (
            <>
              {hidden > 0 && (
                <button
                  type="button"
                  className="chat-window-banner"
                  onClick={() => setShowAllTurns(true)}
                >
                  Show earlier ({hidden} hidden)
                </button>
              )}
              {(() => {
                // Step 1: pair tool-call + tool-result by toolUseId (B1).
                // Step 2: collapse runs of ≥2 *completed* consecutive pairs
                // into a single <ToolGroup/> "Used N tools" header (B2).
                // Aligned with backend terminal-state set (routes/tasks.ts).
                // Missing BLOCKED/MERGE_WAITING/PR_OPEN previously left those
                // legacy tasks' tool runs un-grouped (chat clutter).
                const terminalStates = ["DONE", "COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "MERGE_WAITING", "PR_OPEN"];
                type Pair = { key: string; call: Message | null; result: Message | null };
                type Item =
                  | { kind: "msg"; msg: Message }
                  | { kind: "pair"; pair: Pair }
                  | { kind: "group"; key: string; pairs: Pair[] };
                const flat: Array<{ kind: "msg"; msg: Message } | { kind: "pair"; pair: Pair }> = [];
                const used = new Set<number>();
                for (let idx = 0; idx < visible.length; idx++) {
                  if (used.has(idx)) continue;
                  const msg = visible[idx]!;
                  if (msg.role === "tool-call" && msg.toolUseId) {
                    let resultIdx = -1;
                    for (let j = idx + 1; j < visible.length; j++) {
                      const cand = visible[j];
                      if (cand && cand.role === "tool-result" && cand.toolUseId === msg.toolUseId) {
                        resultIdx = j;
                        break;
                      }
                    }
                    const result = resultIdx >= 0 ? visible[resultIdx]! : null;
                    if (resultIdx >= 0) used.add(resultIdx);
                    flat.push({ kind: "pair", pair: { key: msg.id, call: msg, result } });
                    continue;
                  }
                  if (msg.role === "tool-result" && msg.toolUseId) {
                    flat.push({ kind: "pair", pair: { key: msg.id, call: null, result: msg } });
                    continue;
                  }
                  flat.push({ kind: "msg", msg });
                }

                const grouped: Item[] = [];
                let runStart = -1;
                for (let i = 0; i <= flat.length; i++) {
                  const it = flat[i];
                  const isCompletedPair = it && it.kind === "pair" && it.pair.result !== null;
                  if (isCompletedPair) {
                    if (runStart < 0) runStart = i;
                  } else {
                    if (runStart >= 0) {
                      const runLen = i - runStart;
                      if (runLen >= 2) {
                        const pairs = flat.slice(runStart, i).map((x) => (x as { kind: "pair"; pair: Pair }).pair);
                        grouped.push({ kind: "group", key: pairs.map((p) => p.key).join("|"), pairs });
                      } else {
                        for (let k = runStart; k < i; k++) {
                          grouped.push(flat[k] as { kind: "pair"; pair: Pair });
                        }
                      }
                      runStart = -1;
                    }
                    if (it) grouped.push(it);
                  }
                }

                return grouped.map((it) => {
                  if (it.kind === "group") {
                    return <ToolGroup key={it.key} pairs={it.pairs} defaultOpen={true} />;
                  }
                  if (it.kind === "pair") {
                    return <ToolPairRow key={it.pair.key} call={it.pair.call} result={it.pair.result} />;
                  }
                  return <ExpandableMessage key={it.msg.id} msg={it.msg} />;
                });
              })()}
            </>
          );
        })()}

        {/* Compaction notices: only shown when the full history is visible.
            Their purpose is explaining old context loss; surfacing them
            inside a windowed view is misleading (they'd appear "recent"). */}
        {showAllTurns && compactionEvents.map((ev) => {
          const expanded = expandedCompactions[ev.id] === true;
          return (
            <div className="chat-compaction-notice" key={ev.id}>
              <div className="chat-compaction-header" onClick={() => toggleCompaction(ev.id)}>
                <span>📦 Context compacted ({formatTokens(ev.preTokens)} → {formatTokens(ev.postTokens)} tokens)</span>
                <span className="chat-compaction-toggle">{expanded ? "▾" : "▸"}</span>
              </div>
              {expanded && (
                <div className="chat-compaction-details">
                  {ev.truncated > 0 && <div>Truncated: {ev.truncated} large tool results</div>}
                  {ev.snipped > 0 && <div>Snipped: {ev.snipped} old tool results</div>}
                  {ev.dropped > 0 && <div>Dropped: {ev.dropped} oldest turns</div>}
                  {ev.llmCompacted && <div>LLM summary applied</div>}
                </div>
              )}
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>
      {scrolledUp ? (
        <button
          type="button"
          className={
            `chat-jump-to-bottom${
              isWaitingForResponse ? " chat-jump-to-bottom--active" : ""
            }`
          }
          onClick={handleJumpToBottom}
          aria-label={
            isWaitingForResponse
              ? "Agent is producing — jump to latest"
              : "Jump to latest"
          }
          title={
            isWaitingForResponse
              ? "Agent still producing — jump to latest"
              : "Jump to latest"
          }
        >
          <svg
            className="chat-jump-to-bottom__icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <path
              d="M8 3.5v8.5m0 0L4 8m4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {isWaitingForResponse ? (
            <span className="chat-jump-to-bottom__pulse" aria-hidden />
          ) : null}
        </button>
      ) : null}
      </div>
    </>
  );
}
