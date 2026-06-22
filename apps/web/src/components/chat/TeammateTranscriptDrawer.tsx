/**
 * sidechain drawer for long teammate
 * transcripts. The inline body in ToolPairRow caps at
 * TRANSCRIPT_INLINE_CAP=100 events (D2h). Above that, this drawer
 * fetches the full event log via `GET /tasks/:taskId/teammate/
 * :parentToolUseId/transcript` (indexed by parent_tool_use_id from
 * Step 0b) and renders it on demand.
 *
 * Scope choice for v1: cold-load on open + manual Refresh button. The
 * full live-tail merge state machine in Δ.7 (queue → drain → switch
 * to direct apply) is parked for a follow-up — its complexity isn't
 * justified yet because (a) most users won't open the drawer while
 * the teammate is actively running and (b) the parent ToolPart's
 * inline transcript already shows the live tail. Refresh is a one-
 * click recovery if they want the latest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getTeammateTranscript,
  type TeammateTranscriptEntry,
} from "../../lib/api";
import { useUiStore } from "../../stores/uiStore";

const PAGE_LIMIT = 200;

type DrawerState =
  | { kind: "idle" }
  | { kind: "loading"; events: TeammateTranscriptEntry[] }
  | { kind: "ready"; events: TeammateTranscriptEntry[]; hasMore: boolean; lastSeq: number }
  | { kind: "error"; message: string };

export function TeammateTranscriptDrawer() {
  const open = useUiStore((s) => s.transcriptDrawer);
  const close = useUiStore((s) => s.closeTranscriptDrawer);
  const [state, setState] = useState<DrawerState>({ kind: "idle" });
  const lastFetchKey = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (params: { taskId: string; parentToolUseId: string; since: number; reset: boolean }) => {
      try {
        const res = await getTeammateTranscript({
          taskId: params.taskId,
          parentToolUseId: params.parentToolUseId,
          since: params.since,
          limit: PAGE_LIMIT,
        });
        setState((prev) => {
          const prevEvents = !params.reset && (prev.kind === "ready" || prev.kind === "loading")
            ? prev.events
            : [];
          return {
            kind: "ready",
            events: [...prevEvents, ...res.events],
            hasMore: res.hasMore,
            lastSeq: res.lastSeq,
          };
        });
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [],
  );

  // Open / re-open: cold-load page 1.
  useEffect(() => {
    if (!open) {
      setState({ kind: "idle" });
      lastFetchKey.current = null;
      return;
    }
    const key = `${open.taskId}::${open.parentToolUseId}`;
    if (lastFetchKey.current === key) return;
    lastFetchKey.current = key;
    setState({ kind: "loading", events: [] });
    void fetchPage({
      taskId: open.taskId,
      parentToolUseId: open.parentToolUseId,
      since: 0,
      reset: true,
    });
  }, [open, fetchPage]);

  // Escape key closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const events = useMemo(() => {
    if (state.kind === "loading" || state.kind === "ready") return state.events;
    return [];
  }, [state]);

  const onRefresh = useCallback(() => {
    if (!open) return;
    setState({ kind: "loading", events: [] });
    void fetchPage({
      taskId: open.taskId,
      parentToolUseId: open.parentToolUseId,
      since: 0,
      reset: true,
    });
  }, [open, fetchPage]);

  const onLoadMore = useCallback(() => {
    if (!open) return;
    if (state.kind !== "ready" || !state.hasMore) return;
    void fetchPage({
      taskId: open.taskId,
      parentToolUseId: open.parentToolUseId,
      since: state.lastSeq,
      reset: false,
    });
  }, [open, state, fetchPage]);

  if (!open) return null;

  const title = open.teammateName ? `${open.teammateName} · transcript` : "Teammate transcript";

  return (
    <>
      <div
        className="teammate-drawer-backdrop"
        role="presentation"
        onClick={close}
        aria-hidden="true"
      />
      <aside
        className="teammate-drawer"
        role="dialog"
        aria-label={title}
        aria-modal="true"
      >
        <header className="teammate-drawer__header">
          <span className="teammate-drawer__title">{title}</span>
          <span className="teammate-drawer__count">
            {events.length > 0 ? `${events.length} event${events.length === 1 ? "" : "s"}` : null}
          </span>
          <button
            type="button"
            className="teammate-drawer__refresh"
            onClick={onRefresh}
            disabled={state.kind === "loading"}
            aria-label="Refresh transcript"
            title="Refresh"
          >
            ↻
          </button>
          <button
            type="button"
            className="teammate-drawer__close"
            onClick={close}
            aria-label="Close transcript drawer"
          >
            ×
          </button>
        </header>

        <div className="teammate-drawer__body">
          {state.kind === "loading" && events.length === 0 && (
            <p className="teammate-drawer__placeholder">Loading transcript…</p>
          )}
          {state.kind === "error" && (
            <p className="teammate-drawer__placeholder teammate-drawer__placeholder--error">
              {state.message}
            </p>
          )}
          {events.length > 0 && (
            <ul className="teammate-drawer__events">
              {events.map((ev) => (
                <TranscriptRow key={ev.id} event={ev} />
              ))}
            </ul>
          )}
          {state.kind === "ready" && state.hasMore && (
            <button
              type="button"
              className="teammate-drawer__load-more"
              onClick={onLoadMore}
              disabled={state.kind !== "ready"}
            >
              Load more (sinceSeq={state.lastSeq})
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function TranscriptRow({ event }: { event: TeammateTranscriptEntry }) {
  const payload = useMemo(() => {
    if (!event.payloadJson) return null;
    try {
      return JSON.parse(event.payloadJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [event.payloadJson]);

  // Compact summary per event type. Stream deltas are aggregated by
  // the row's `text` field; tool calls show name+args; tool results
  // show the truncated outputSummary; everything else dumps payload.
  let summary: string | null = null;
  if (event.type === "leader.stream_delta" && payload) {
    const text = typeof payload.text === "string" ? payload.text : null;
    summary = text ? text.slice(0, 200) : null;
  } else if (event.type === "leader.tool_call" && payload) {
    const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const input = typeof payload.inputSummary === "string" ? payload.inputSummary : "";
    summary = `${name}(${input.slice(0, 150)})`;
  } else if (event.type === "leader.tool_result" && payload) {
    const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
    const output = typeof payload.outputSummary === "string" ? payload.outputSummary : "";
    const error = payload.isError === true;
    summary = `${name} → ${error ? "ERROR " : ""}${output.slice(0, 200)}`;
  } else if (payload) {
    summary = JSON.stringify(payload).slice(0, 200);
  }

  return (
    <li className={`teammate-drawer__event teammate-drawer__event--${event.type.replace(/[^a-z0-9]/gi, "-")}`}>
      <span className="teammate-drawer__event-type">{event.type.replace("leader.", "")}</span>
      {summary && (
        <pre className="teammate-drawer__event-summary">{summary}</pre>
      )}
    </li>
  );
}
