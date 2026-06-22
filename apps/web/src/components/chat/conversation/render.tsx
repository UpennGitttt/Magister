/**
 * Render components for the chatStore-driven conversation view.
 * Replaces the flat-array message rendering in legacy ChatArea
 * (PR 3 cutover, spec §4 PR 3).
 *
 * Hierarchy:
 *   <ConversationView conversation={Conversation}>
 *     <ExchangeView exchange={Exchange}>
 *       <UserBubble />
 *       <ResponseView response={AssistantResponse}>
 *         <SealedTextPart /> | <StreamingTextPart />
 *         <ToolPairRow />     | <ToolGroup />
 *         <ModelErrorRow />
 *       </ResponseView>
 *     </ExchangeView>
 *   </ConversationView>
 *
 * Tool grouping is a pure render-time pass (`groupConsecutiveTools`)
 * — runs ≥2 of consecutive completed tool parts collapse into a
 * "Used N tools" header, mirroring the prior collapsed-tool behavior
 * the old renderer had. Unit-tested in render.test.ts.
 */

import { Fragment, memo, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import {
  describeSpeaker,
  formatRelativeTime,
  speakerDotClass,
  type SpeakerInfo,
} from "./message-header";
import { useSelectedTaskId } from "../../../hooks/useSelectedTaskId";
import { useUiStore } from "../../../stores/uiStore";
import type { TurnSummary, TurnToolSummary } from "../../../lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  AssistantResponse,
  Exchange,
  MediaPart,
  ModelErrorPart,
  PlanPart,
  ResponsePart,
  SystemPart,
  TextPart,
  ThinkingPart,
  TodoListPart,
  ToolPart,
} from "./types";
import { PlanCard } from "./PlanCard";
import {
  PLAN_TOKEN_APPROVED,
  PLAN_TOKEN_CANCELLED,
  PLAN_TOKEN_REVISED_PREFIX,
} from "./plan-tokens";
import { resolveApproval } from "../../../lib/api";

// ──────────────────────────────────────────────────────────────────────
// Top-level: Exchange + Response
// ──────────────────────────────────────────────────────────────────────

export const ExchangeView = memo(function ExchangeView({
  exchange,
  taskId,
  turnSummary,
}: {
  exchange: Exchange;
  /** Required for plan-card buttons to post sentinel tokens via
   *  `sendTaskMessage`. Pass through from the parent (ChatArea). */
  taskId: string;
  turnSummary?: TurnSummary | undefined;
}) {
  // Placeholder thinking display lives ENTIRELY inside ResponseView
  // now (kimi review caught that having a separate placeholder here
  // and a real ThinkingBlock inside ResponseView created a DOM seam
  // when the first delta arrived — different component types at
  // different positions). ResponseView decides itself when to render
  // the placeholder via ThinkingBlock part={null}.
  //
  // Per-message header strip: every message bubble carries a 22px
  // speaker+timestamp row above it. ExchangeView owns the prev-
  // speaker context that bridges the user bubble into the response,
  // so ResponseView can suppress the leader header on the first
  // assistant part only when the previous speaker was already the
  // same agent within a 60s window. (User -> leader is always a new
  // speaker so this never collides at the gap.)
  const userSpeaker = describeSpeaker("user");
  return (
    <>
      <UserBubble
        content={exchange.user.content}
        speaker={userSpeaker}
        {...(exchange.user.createdAtMs !== undefined ? { timestampMs: exchange.user.createdAtMs } : {})}
        {...(exchange.user.attachments ? { attachments: exchange.user.attachments } : {})}
      />
      {/* Plan-mode badge — shown when the leader has called
          enter_plan_mode mid-conversation. Distinct from the user-
          toggled "Plan first" button (uiStore.planMode); this badge
          reflects per-exchange runtime state so the user can see
          the model entered plan mode even when they didn't pre-
          toggle. The badge sits above ResponseView so it's the
          first thing visible when the model starts thinking in
          plan mode. */}
      {exchange.planPhase && exchange.planPhase !== "idle" && exchange.planPhase !== "done" ? (
        <PlanPhaseBadge phase={exchange.planPhase} />
      ) : null}
      <ResponseView
        response={exchange.response}
        status={exchange.status}
        taskId={taskId}
        exchangeId={exchange.id}
        timing={exchange.timing}
        turnSummary={turnSummary}
        priorSpeakerRoleKey={userSpeaker.roleKey}
        {...(exchange.user.createdAtMs !== undefined ? { priorSpeakerStampMs: exchange.user.createdAtMs } : {})}
      />
    </>
  );
});

// ──────────────────────────────────────────────────────────────────────
// Per-message header strip — speaker + timestamp row above each bubble.
// ──────────────────────────────────────────────────────────────────────

const HEADER_GROUP_WINDOW_MS = 60_000;

function MessageHeader({
  speaker,
  subTag,
  timestampMs,
}: {
  speaker: SpeakerInfo;
  subTag?: string;
  timestampMs?: number;
}) {
  // Coarse 30s tick — relative-time buckets are minute-grained past
  // the first 60s, so a half-minute cadence keeps every header fresh
  // without burning CPU on long histories. Only ticks while at least
  // one timestamp is present on the row.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timestampMs === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [timestampMs]);
  const rel = timestampMs !== undefined ? formatRelativeTime(timestampMs, Date.now()) : null;
  return (
    <div className="message-header" role="presentation">
      <span className={speakerDotClass(speaker)} aria-hidden="true" />
      <span className="message-header__speaker">{speaker.label}</span>
      {subTag && <span className="message-header__subtag">{subTag}</span>}
      {rel && <span className="message-header__time">{rel}</span>}
    </div>
  );
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  return now;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

type RenderTiming = Exchange["timing"] | NonNullable<TurnSummary["timing"]> | undefined;

function activePauseStartedAtMsForTiming(timing: RenderTiming): number | undefined {
  return timing && "activePauseStartedAtMs" in timing
    ? timing.activePauseStartedAtMs
    : undefined;
}

function workedMsForTiming(
  timing: RenderTiming,
  status: Exchange["status"],
  now: number,
): number | null {
  if (timing?.startedAtMs === undefined) return null;
  if ((status === "complete" || status === "failed") && typeof timing.elapsedMs === "number") {
    return timing.elapsedMs;
  }
  const endAt = activePauseStartedAtMsForTiming(timing) ?? timing.completedAtMs ?? now;
  return Math.max(0, endAt - timing.startedAtMs - (timing.pausedMs ?? 0));
}

function summarizeLiveTools(response: AssistantResponse): TurnToolSummary {
  const summary: TurnToolSummary = {
    readCount: 0,
    writeCount: 0,
    approvalCount: 0,
    delegationCount: 0,
    failedCount: 0,
    totalCount: 0,
  };
  for (const part of response.parts) {
    if (part.kind !== "tool") continue;
    summary.totalCount += 1;
    if (part.name === "spawn_teammate") summary.delegationCount += 1;
    if (part.pendingApproval) summary.approvalCount += 1;
    if (part.result?.isError) summary.failedCount += 1;
  }
  return summary;
}

function TurnSummaryStrip({
  status,
  timing,
  response,
  turnSummary,
}: {
  status: Exchange["status"];
  timing?: Exchange["timing"] | undefined;
  response: AssistantResponse;
  turnSummary?: TurnSummary | undefined;
}) {
  const running = status === "pending" || status === "streaming";
  const effectiveTiming = timing ?? turnSummary?.timing;
  const activePauseStartedAtMs = activePauseStartedAtMsForTiming(effectiveTiming);
  const now = useNow(running && effectiveTiming?.startedAtMs !== undefined && activePauseStartedAtMs === undefined);
  const workedMs = workedMsForTiming(effectiveTiming, status, now);

  const paused = running && activePauseStartedAtMs !== undefined;
  const timingLabel = workedMs === null ? null : paused
    ? `Paused for approval · worked ${formatDuration(workedMs)}`
    : running
    ? `Working (${formatDuration(workedMs)})`
    : `Worked for ${formatDuration(workedMs)}`;
  const toolSummary = turnSummary?.toolSummary ?? summarizeLiveTools(response);
  const hasSummary = timingLabel !== null || toolSummary.totalCount > 0;
  if (!hasSummary) return null;

  return (
    <div
      className={`chat-turn-timing chat-turn-summary-strip ${paused ? "chat-turn-timing--paused" : ""}`}
      role="status"
      aria-live={running ? "off" : "polite"}
    >
      <span className="chat-turn-timing__dot" aria-hidden="true" />
      {timingLabel && <span className="chat-turn-summary-strip__item">{timingLabel}</span>}
      {toolSummary.totalCount > 0 && (
        <span className="chat-turn-summary-strip__item">Tools {toolSummary.totalCount}</span>
      )}
      {toolSummary.failedCount > 0 && (
        <span className="chat-turn-summary-strip__item">Failed {toolSummary.failedCount}</span>
      )}
    </div>
  );
}

function PlanPhaseBadge({ phase }: { phase: "planning" | "awaiting_approval" }) {
  const label = phase === "awaiting_approval"
    ? "Awaiting plan approval"
    : "Plan mode — read-only, no edits";
  return (
    <div className="plan-phase-badge" role="status" aria-label={label}>
      <span className="plan-phase-badge__icon" aria-hidden>📋</span>
      <span className="plan-phase-badge__label">{label}</span>
      {phase === "planning" ? (
        <span className="plan-phase-badge__dot" aria-hidden>●</span>
      ) : null}
    </div>
  );
}

/**
 * Plan-mode sentinel tokens are framework communications (Approve /
 * Revise / Cancel posted by PlanCard buttons), not user-typed
 * content. The PlanCard above already shows the user what they
 * chose — duplicating the raw token as a chat bubble is noise. Filter
 * them out at render time so even buggy histories (e.g. user
 * spam-clicked Cancel before the backend was wired up) read cleanly.
 */
function isSentinelToken(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed === PLAN_TOKEN_APPROVED
    || trimmed === PLAN_TOKEN_CANCELLED
    || trimmed.startsWith(PLAN_TOKEN_REVISED_PREFIX)
    // Ralph-loop continuation messages — auto-injected by the
    // backend worker after each goal-mode turn. Filtering them
    // out of the user bubble keeps the conversation visually
    // about the actual task, not "user said: continue, leader
    // said ...". The GoalPill above the chat shows iteration
    // progress instead.
    || trimmed.startsWith("<<goal_continuation>>")
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Quick glyph hint by mime / extension. Pure visual sugar — the
 *  filename next to it carries the real signal. */
function fileGlyph(meta: { filename: string; mimeType: string }): string {
  if (meta.mimeType.startsWith("image/")) return "🖼";
  const lower = meta.filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "📝";
  if (lower.endsWith(".pdf")) return "📕";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "📄";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) return "📊";
  return "📎";
}

function UserBubble({
  content,
  attachments,
  speaker,
  timestampMs,
}: {
  content: string;
  attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
  speaker?: SpeakerInfo;
  timestampMs?: number;
}) {
  // A bubble with no text but staged attachments still wants to
  // render — silent drop-on-empty would hide that the user sent
  // anything at all.
  const hasAttachments = !!attachments && attachments.length > 0;
  if (!content && !hasAttachments) return null;
  if (isSentinelToken(content)) return null;
  return (
    <>
      {speaker && (
        <MessageHeader
          speaker={speaker}
          {...(timestampMs !== undefined ? { timestampMs } : {})}
        />
      )}
    <div className="message-row message-row--user">
      <div className="message-bubble message-user">
        {content && <div>{content}</div>}
        {hasAttachments && (
          <div
            className="message-user__attachments"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.35rem",
              marginTop: content ? "0.5rem" : 0,
            }}
          >
            {attachments!.map((att, i) => (
              <span
                key={`${att.filename}-${i}`}
                title={`${att.filename} · ${formatBytes(att.sizeBytes)}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "0.4rem",
                  // Use a token-based background that contrasts on
                  // both legacy and current themes.
                  background: "var(--surface-soft, rgba(0, 0, 0, 0.06))",
                  border: "1px solid var(--line-soft, rgba(0, 0, 0, 0.08))",
                  fontSize: "0.85em",
                }}
              >
                <span aria-hidden="true">{fileGlyph(att)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: "16ch", whiteSpace: "nowrap" }}>
                  {att.filename}
                </span>
                <span style={{ opacity: 0.65, fontSize: "0.85em" }}>
                  {formatBytes(att.sizeBytes)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/**
 * Placeholder rendered during the wait between "user clicks Send" and
 * the first model event. Now wired through the single `ThinkingBlock`
 * component with `part={null}` so the placeholder and the real block
 * share the same React component type at the same DOM position. When
 * the first thinking_delta arrives and ResponseView swaps the prop
 * from null to a real ThinkingPart, React reconciles in place — no
 * unmount / remount, no DOM seam.
 *
 * (v1 of this PR had a separate `PreemptiveThinkingHeader` component
 * rendered in ExchangeView as a sibling of ResponseView. React saw
 * the placeholder and the real block as different component types
 * in different positions and did a full remount — kimi review caught
 * the regression.)
 */

function ResponseView({
  response,
  status,
  taskId,
  exchangeId,
  timing,
  turnSummary,
  priorSpeakerRoleKey,
  priorSpeakerStampMs,
}: {
  response: AssistantResponse;
  status: Exchange["status"];
  taskId: string;
  exchangeId: string;
  timing?: Exchange["timing"] | undefined;
  turnSummary?: TurnSummary | undefined;
  /** Speaker roleKey of the bubble that precedes the response stream
   *  (the user bubble, in the normal flow). Drives the suppression-
   *  within-60s rule across the user→assistant boundary. */
  priorSpeakerRoleKey?: string;
  priorSpeakerStampMs?: number;
}) {
  // Stable key the placeholder ThinkingBlock and the eventual real
  // ThinkingPart at index 0 will share so React can reconcile them
  // as the same element rather than unmount+mount when the first
  // thinking_delta arrives. MUST stay in sync with projector's
  // `thinkingPartId(requestId, 0)` format.
  const thinkingPlaceholderKey = `${exchangeId}:thinking:0`;
  const showPlaceholder = response.parts.length === 0
    && (status === "streaming" || status === "pending");
  // Synthesize a single-item items array containing a placeholder
  // ThinkingBlock when no real parts exist yet — keeps the
  // placeholder INSIDE the same items.map call so React's keyed
  // reconciliation reuses the DOM when the real part replaces it.
  // (Earlier versions rendered the placeholder as a sibling of
  // items.map, which kimi review caught as a remount-in-disguise.)
  const items: Array<RenderItem | { kind: "thinking-placeholder" }> = showPlaceholder
    ? [{ kind: "thinking-placeholder" }]
    : groupConsecutiveTools(response.parts);
  const summary = (
    <TurnSummaryStrip
      key="turn-summary"
      status={status}
      timing={timing}
      response={response}
      turnSummary={turnSummary}
    />
  );
  if (items.length === 0) return <>{summary}</>;

  // Per-item header decisions — see HEADER_GROUP_WINDOW_MS. Walks the
  // items in render order, tracking (prevRoleKey, prevStampMs). For
  // each item that owns a bubble (text / thinking / tool / model-error
  // / plan) we ask: same speaker as the previous bubble within 60s? If
  // yes, suppress the header; if no, emit one.
  const headerByIdx = computeItemHeaders(
    items,
    priorSpeakerRoleKey ?? null,
    priorSpeakerStampMs ?? null,
  );

  return (
    <>
      {summary}
      {items.map((it, idx) => {
        let node: ReactElement | null = null;
        const header = headerByIdx[idx];
        const headerEl = header
          ? <MessageHeader
              speaker={header.speaker}
              {...(header.subTag ? { subTag: header.subTag } : {})}
              {...(header.timestampMs !== undefined ? { timestampMs: header.timestampMs } : {})}
            />
          : null;
        if (it.kind === "thinking-placeholder") {
          node = <ThinkingBlock key={thinkingPlaceholderKey} part={null} />;
        } else {
          switch (it.kind) {
            case "text":
              node = it.part.sealed
                ? <SealedTextPart key={it.part.id} part={it.part} />
                : <StreamingTextPart key={it.part.id} part={it.part} />;
              break;
            case "thinking":
              node = <ThinkingBlock key={it.part.id} part={it.part} />;
              break;
            case "media":
              node = <MediaPartBlock key={it.part.id} part={it.part} />;
              break;
            case "tool":
              node = <ToolPairRow key={it.part.id} part={it.part} />;
              break;
            case "tool-group":
              node = <ToolGroup key={it.key} parts={it.parts} />;
              break;
            case "model-error":
              node = <ModelErrorRow key={it.part.id} part={it.part} />;
              break;
            case "plan":
              node = <PlanCard key={it.part.id} part={it.part} taskId={taskId} />;
              break;
            case "todo_list":
              node = <TodoListBlock key={it.part.id} part={it.part} />;
              break;
            case "system":
              node = <SystemNoticeRow key={it.part.id} part={it.part} />;
              break;
            default:
              node = null;
          }
        }
        return (
          <Fragment key={itemKey(it)}>
            {headerEl}
            {node}
          </Fragment>
        );
      })}
    </>
  );
}

type ItemHeader = {
  speaker: SpeakerInfo;
  subTag?: string;
  timestampMs?: number;
};

/**
 * Pure pass: decide which render items get a header row and which
 * inherit the previous speaker's grouping. Items without an
 * associated bubble (thinking-placeholder, system, todo_list,
 * tool-group) get no header — they aren't "speakerful". The pass
 * carries the last-shown speaker forward across the list so a run
 * of tool calls reads as one speaker block, with the timestamp only
 * appearing on the first row.
 */
function computeItemHeaders(
  items: Array<RenderItem | { kind: "thinking-placeholder" }>,
  initialRoleKey: string | null,
  initialStampMs: number | null,
): Array<ItemHeader | null> {
  let prevRoleKey: string | null = initialRoleKey;
  let prevStampMs: number | null = initialStampMs;
  const out: Array<ItemHeader | null> = [];
  for (const it of items) {
    const candidate = describeItemSpeaker(it);
    if (!candidate) {
      out.push(null);
      continue;
    }
    const { speaker, stampMs, subTag } = candidate;
    const sameSpeaker = prevRoleKey === speaker.roleKey;
    const withinWindow =
      sameSpeaker
      && stampMs !== null
      && prevStampMs !== null
      && (stampMs - prevStampMs) < HEADER_GROUP_WINDOW_MS;
    if (sameSpeaker && (withinWindow || prevStampMs === null || stampMs === null)) {
      // Suppress header; keep prevStampMs as the head-of-group anchor
      // so subsequent items still group against the original window
      // origin (not the most recent message — that would let groups
      // grow unbounded under sustained streaming).
      out.push(null);
    } else {
      out.push({
        speaker,
        ...(subTag ? { subTag } : {}),
        ...(stampMs !== null ? { timestampMs: stampMs } : {}),
      });
      prevRoleKey = speaker.roleKey;
      prevStampMs = stampMs;
    }
  }
  return out;
}

function describeItemSpeaker(
  item: RenderItem | { kind: "thinking-placeholder" },
): { speaker: SpeakerInfo; stampMs: number | null; subTag?: string } | null {
  switch (item.kind) {
    case "text": {
      const speaker = describeSpeaker("agent", item.part.agentRole, item.part.agentName);
      return { speaker, stampMs: item.part.createdAtMs ?? null };
    }
    case "thinking": {
      // Thinking has no per-part agent metadata yet; falls back to
      // leader role. The dot color matches the surrounding agent.
      const speaker = describeSpeaker("agent");
      return { speaker, stampMs: null, subTag: "THINKING" };
    }
    case "media": {
      const speaker = describeSpeaker("agent", item.part.agentRole, item.part.agentName);
      return {
        speaker,
        stampMs: item.part.createdAtMs ?? null,
        subTag: `MEDIA · ${item.part.mediaKind.toUpperCase()}`,
      };
    }
    case "tool": {
      const speaker = describeSpeaker("agent", item.part.agentRole, item.part.agentName);
      return {
        speaker,
        stampMs: item.part.createdAtMs ?? null,
        subTag: `TOOL · ${item.part.name}`,
      };
    }
    case "tool-group": {
      const first = item.parts[0];
      const speaker = describeSpeaker("agent", first?.agentRole, first?.agentName);
      return {
        speaker,
        stampMs: first?.createdAtMs ?? null,
        subTag: `TOOLS · ${item.parts.length}`,
      };
    }
    case "model-error":
      return { speaker: describeSpeaker("agent"), stampMs: null, subTag: "MODEL ERROR" };
    case "plan":
      return { speaker: describeSpeaker("agent"), stampMs: null, subTag: "PLAN" };
    case "todo_list":
    case "system":
    case "thinking-placeholder":
    default:
      return null;
  }
}

function itemKey(it: RenderItem | { kind: "thinking-placeholder" }): string {
  if (it.kind === "thinking-placeholder") return "thinking-placeholder";
  if (it.kind === "tool-group") return it.key;
  return it.part.id;
}

// ──────────────────────────────────────────────────────────────────────
// Text parts (sealed vs streaming)
// ──────────────────────────────────────────────────────────────────────

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

const SealedTextPart = memo(function SealedTextPart({ part }: { part: TextPart }) {
  return (
    <div className="message-row message-row--assistant">
      <div className="message-bubble message-assistant">
        <MessageMarkdown>{part.content}</MessageMarkdown>
      </div>
    </div>
  );
}, (a, b) => a.part.id === b.part.id && a.part.content === b.part.content && a.part.sealed === b.part.sealed);

/**
 * Live streaming text leaf — subscribes to the part's TextBuffer via
 * useSyncExternalStore. The buffer reference is stable for the part's
 * lifetime (chatStore guarantee, spec §3.5), so React never sees a
 * torn snapshot or a swapped store.
 *
 * Renders plain pre-wrapped text (NOT markdown) during streaming —
 * react-markdown re-parses on every children change, and at 60fps
 * that's a known performance cliff (commit cb4a7bf history). When the
 * part seals, the parent swaps to <SealedTextPart/> which DOES use
 * markdown.
 */
function StreamingTextPart({ part }: { part: TextPart }) {
  const text = useSyncExternalStore(
    part.buffer ? part.buffer.subscribe : NOOP_SUBSCRIBE,
    part.buffer ? part.buffer.getSnapshot : () => part.content,
    () => part.content,
  );
  return (
    <div className="message-row message-row--assistant">
      <div className="message-bubble message-assistant message-streaming">
        <div className="message-streaming__text">
          <span className="streaming-plaintext">{text}</span>
          <span className="message-streaming__cursor" aria-hidden="true">▌</span>
        </div>
      </div>
    </div>
  );
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

// ──────────────────────────────────────────────────────────────────────
// Media parts
// ──────────────────────────────────────────────────────────────────────

const MediaPartBlock = memo(function MediaPartBlock({ part }: { part: MediaPart }) {
  const altText = part.caption?.trim() || part.filename;
  const [lightbox, setLightbox] = useState(false);
  return (
    <div className="message-row message-row--assistant message-row--media">
      <figure className="message-media">
        {part.mediaKind === "image" ? (
          <>
            <img
              className="message-media__image"
              src={part.url}
              alt={altText}
              loading="lazy"
              role="button"
              tabIndex={0}
              onClick={() => setLightbox(true)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setLightbox(true); }}
              {...(part.width !== undefined ? { width: part.width } : {})}
              {...(part.height !== undefined ? { height: part.height } : {})}
            />
            {lightbox && (
              <div
                className="media-lightbox"
                role="dialog"
                aria-label={altText}
                onClick={() => setLightbox(false)}
                onKeyDown={(e) => { if (e.key === "Escape") setLightbox(false); }}
              >
                <img src={part.url} alt={altText} className="media-lightbox__img" />
              </div>
            )}
          </>
        ) : (
          <video
            className="message-media__video"
            controls
            preload="metadata"
            aria-label={altText}
          >
            <source src={part.url} type={part.mimeType} />
            {part.filename}
          </video>
        )}
        {part.caption ? (
          <figcaption className="message-media__caption">{part.caption}</figcaption>
        ) : null}
      </figure>
    </div>
  );
}, (a, b) =>
  a.part.id === b.part.id
  && a.part.url === b.part.url
  && a.part.caption === b.part.caption
  && a.part.width === b.part.width
  && a.part.height === b.part.height);

// ──────────────────────────────────────────────────────────────────────
// Tool parts
// ──────────────────────────────────────────────────────────────────────

// events kept in `transcript[]` are
// memory-bounded (TRANSCRIPT_MEMORY_CAP=500). Inline rendering caps
// further: above this many we render first-50 + elision marker +
// last-10 to keep the DOM under §5/D2h's 200-node cap. The drawer
// reaches further events via the lazy-load endpoint.
const TRANSCRIPT_INLINE_CAP = 100;
const INLINE_HEAD_COUNT = 50;
const INLINE_TAIL_COUNT = 10;

function normalizeDuplicateText(value: string | undefined | null): string | null {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  return normalized ? normalized : null;
}

function sameDuplicateText(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeDuplicateText(a);
  const right = normalizeDuplicateText(b);
  return left !== null && right !== null && left === right;
}

function transcriptPartDuplicatesSummary(part: ResponsePart, summary: string | undefined): boolean {
  return part.kind === "text" && sameDuplicateText(part.content, summary);
}

const ToolPairRow = memo(function ToolPairRow({ part }: { part: ToolPart }) {
  const [expanded, setExpanded] = useState(false);
  // spawn_teammate is the leader's primary delegation tool. Render
  // with role + goal preview prominently so the user sees the
  // multi-agent dispatch as a first-class event ("→ coder: implement
  // X") rather than a generic "spawn_teammate" call buried in JSON
  // args. The expand path still shows full args + summary.
  const teammateMeta = part.name === "spawn_teammate"
    ? extractTeammateMeta(part.input)
    : null;
  const argsSummary = teammateMeta ? "" : formatToolArgs(part.input);
  const status: "running" | "ok" | "error" = teammateMeta && part.teammateStatus === "completed"
    ? "ok"
    : teammateMeta && (part.teammateStatus === "failed" || part.teammateStatus === "cancelled")
    ? "error"
    : part.result === null
    ? "running"
    : part.result.isError ? "error" : "ok";

  const icon = status === "running"
    ? <span className="tool-pair-row__icon tool-pair-row__icon--running" aria-hidden="true">⏳</span>
    : status === "error"
    ? <span className="tool-pair-row__icon tool-pair-row__icon--error" aria-hidden="true">❌</span>
    : <span className="tool-pair-row__icon tool-pair-row__icon--ok" aria-hidden="true">✓</span>;

  // teammate transcript inline
  // expansion. When this ToolPart is a spawn_teammate AND the
  // projector has populated `teammateRunId` (Step 2a), the body
  // also renders the teammate's nested events. Body is mounted
  // ONLY when expanded (React conditional, not CSS hide) — this
  // is D2a's primary perf win for sessions with many spawned
  // teammates.
  const hasTranscript =
    part.teammateRunId !== undefined ||
    (part.transcriptEventCount ?? 0) > 0 ||
    (part.transcript?.length ?? 0) > 0;
  const transcriptCount = part.transcriptEventCount ?? 0;
  const teammateStatusLabel = hasTranscript ? part.teammateStatus ?? "spawned" : null;
  const teammateDuration = teammateMeta ? formatTeammateDuration(part) : null;
  const teammateLastMessage = part.teammateLastMessage
    ? compactHeaderText(part.teammateLastMessage, 120)
    : null;
  const inlineTranscript = part.transcript?.filter(
    (transcriptPart) => !transcriptPartDuplicatesSummary(transcriptPart, part.teammateSummary),
  ) ?? [];
  const resultDuplicatesSummary =
    part.result !== null &&
    part.result.isError === false &&
    sameDuplicateText(part.result.output, part.teammateSummary);
  const visibleResult = resultDuplicatesSummary ? null : part.result;
  const statusDotClass = teammateStatusLabel === "completed"
    ? "tool-pair-row__teammate-status--ok"
    : teammateStatusLabel === "failed" || teammateStatusLabel === "cancelled"
    ? "tool-pair-row__teammate-status--error"
    : "tool-pair-row__teammate-status--running";

  return (
    <div className={`message-row message-row--tool-pair ${teammateMeta ? "message-row--teammate" : ""}`}>
      <button
        type="button"
        className={`tool-pair-row ${teammateMeta ? "tool-pair-row--teammate" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {icon}
        {teammateMeta ? (
          <>
            <span className="tool-pair-row__name tool-pair-row__name--teammate">
              <span className="tool-pair-row__teammate-arrow" aria-hidden="true">→</span>
              {" "}
              {teammateMeta.role}
            </span>
            {(part.teammateModel
              || teammateDuration
              || part.teammateToolCount !== undefined
              || part.teammateInputTokens !== undefined) && (
              <span className="tool-pair-row__teammate-meta">
                {part.teammateModel && (
                  <span className="tool-pair-row__teammate-chip">{part.teammateModel}</span>
                )}
                {teammateDuration && (
                  <span className="tool-pair-row__teammate-chip">{teammateDuration}</span>
                )}
                {part.teammateToolCount !== undefined && (
                  <span className="tool-pair-row__teammate-chip">Tools {part.teammateToolCount}</span>
                )}
                {(part.teammateInputTokens !== undefined || part.teammateOutputTokens !== undefined) && (
                  <span
                    className="tool-pair-row__teammate-chip"
                    title={teammateTokenTitle(part)}
                  >
                    {formatTeammateTokens(part)}
                  </span>
                )}
              </span>
            )}
            {teammateLastMessage && (
              <span className="tool-pair-row__teammate-last">{teammateLastMessage}</span>
            )}
            {hasTranscript && (
              <span className={`tool-pair-row__teammate-status ${statusDotClass}`}>
                {teammateStatusLabel}
                {transcriptCount > 0 ? ` · ${transcriptCount} event${transcriptCount === 1 ? "" : "s"}` : ""}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="tool-pair-row__name">{part.name}</span>
            {argsSummary && <span className="tool-pair-row__args">{argsSummary}</span>}
          </>
        )}
        <span className="tool-pair-row__chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {part.pendingApproval && part.result === null && (
        <ApprovalRow approval={part.pendingApproval} />
      )}
      {expanded && (
        <div className="tool-pair-row__body">
          {part.input != null && (
            <div className="tool-pair-row__section">
              <div className="tool-pair-row__section-label">Args</div>
              <pre className="tool-pair-row__pre">{stringifyInput(part.input)}</pre>
            </div>
          )}
          {hasTranscript && inlineTranscript.length > 0 && (
            <div className="tool-pair-row__section tool-pair-row__section--teammate-transcript">
              <div className="tool-pair-row__section-label">
                Teammate transcript ({transcriptCount} event{transcriptCount === 1 ? "" : "s"})
                <TeammateOpenDrawerButton
                  toolUseId={part.toolUseId}
                  {...(part.teammateName ?? part.teammateRole
                    ? { teammateName: part.teammateName ?? part.teammateRole ?? "" }
                    : {})}
                />
              </div>
              <TeammateTranscriptInline parts={inlineTranscript} totalCount={transcriptCount} />
            </div>
          )}
          {part.teammateStatus === "failed" && (part.teammateFailureReason || part.teammateNextAction) && (
            <div className="tool-pair-row__section tool-pair-row__section--teammate-failure">
              {part.teammateFailureReason && (
                <>
                  <div className="tool-pair-row__section-label tool-pair-row__section-label--error">Failure reason</div>
                  <pre className="tool-pair-row__pre">{part.teammateFailureReason}</pre>
                </>
              )}
              {part.teammateNextAction && (
                <>
                  <div className="tool-pair-row__section-label">Suggested next action</div>
                  <pre className="tool-pair-row__pre">{part.teammateNextAction}</pre>
                </>
              )}
            </div>
          )}
          {part.teammateSummary && (
            <div className="tool-pair-row__section tool-pair-row__section--summary">
              <div className="tool-pair-row__section-label">Final summary</div>
              <div className="tool-pair-row__summary-md">
                <MessageMarkdown>{part.teammateSummary}</MessageMarkdown>
              </div>
            </div>
          )}
          {visibleResult && (
            <div className="tool-pair-row__section">
              <div className={`tool-pair-row__section-label ${visibleResult.isError ? "tool-pair-row__section-label--error" : ""}`}>
                {visibleResult.isError ? "Error" : "Result"}
              </div>
              <pre className="tool-pair-row__pre">{visibleResult.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}, (a, b) =>
  a.part.id === b.part.id
  && a.part.name === b.part.name
  && a.part.result === b.part.result
  && a.part.pendingApproval?.approvalId === b.part.pendingApproval?.approvalId
  // include teammate fields in equality so the
  // header re-renders on status / count change. Reference equality
  // on `transcript` is enough — the projector copies on append.
  && a.part.teammateStatus === b.part.teammateStatus
  && a.part.transcriptEventCount === b.part.transcriptEventCount
  && a.part.transcript === b.part.transcript
  && a.part.teammateSummary === b.part.teammateSummary
  && a.part.teammateRuntime === b.part.teammateRuntime
  && a.part.teammateModel === b.part.teammateModel
  && a.part.teammateStartedAtMs === b.part.teammateStartedAtMs
  && a.part.teammateCompletedAtMs === b.part.teammateCompletedAtMs
  && a.part.teammateToolCount === b.part.teammateToolCount
  && a.part.teammateLastMessage === b.part.teammateLastMessage
  && a.part.teammateFailureReason === b.part.teammateFailureReason
  && a.part.teammateNextAction === b.part.teammateNextAction);

/**
 * render a teammate's nested
 * transcript inline. Body is only mounted when its parent ToolPart
 * is expanded (D2a). When the transcript exceeds
 * TRANSCRIPT_INLINE_CAP, we render first-50 + elision marker +
 * last-10 to bound DOM size — matches the cap the projector enforces
 * on memory.
 */
const TeammateTranscriptInline = memo(function TeammateTranscriptInline({
  parts,
  totalCount,
}: {
  parts: ResponsePart[];
  totalCount: number;
}) {
  const overCap = parts.length > TRANSCRIPT_INLINE_CAP;
  if (!overCap) {
    return (
      <div className="teammate-transcript">
        {parts.map(renderTranscriptPart)}
      </div>
    );
  }
  const head = parts.slice(0, INLINE_HEAD_COUNT);
  const tail = parts.slice(parts.length - INLINE_TAIL_COUNT);
  const middleCount = parts.length - head.length - tail.length;
  return (
    <div className="teammate-transcript">
      {head.map(renderTranscriptPart)}
      <div className="teammate-transcript__elision" aria-label="Collapsed events">
        … {middleCount} event{middleCount === 1 ? "" : "s"} collapsed (total {totalCount}). Open the transcript drawer to see them.
      </div>
      {tail.map(renderTranscriptPart)}
    </div>
  );
}, (a, b) => a.parts === b.parts && a.totalCount === b.totalCount);

/**
 * opens the sidechain transcript drawer.
 * Lives next to the inline transcript label so the user has a clear
 * affordance for the full event log even when the inline view is
 * truncated or they want to inspect a specific event in detail.
 */
const TeammateOpenDrawerButton = memo(function TeammateOpenDrawerButton({
  toolUseId,
  teammateName,
}: {
  toolUseId: string;
  teammateName?: string;
}) {
  const taskId = useSelectedTaskId();
  const openDrawer = useUiStore((s) => s.openTranscriptDrawer);
  if (!taskId) return null;
  return (
    <button
      type="button"
      className="tool-pair-row__open-drawer"
      onClick={(e) => {
        e.stopPropagation(); // Don't toggle the parent ToolPairRow expand state.
        openDrawer({ taskId, parentToolUseId: toolUseId, ...(teammateName ? { teammateName } : {}) });
      }}
      title="Open full transcript in side drawer"
    >
      Open transcript →
    </button>
  );
});

function renderTranscriptPart(part: ResponsePart): ReactElement | null {
  switch (part.kind) {
    case "text":
      return part.sealed
        ? <SealedTextPart key={part.id} part={part} />
        : <StreamingTextPart key={part.id} part={part} />;
    case "thinking":
      return <ThinkingBlock key={part.id} part={part} />;
    case "media":
      return <MediaPartBlock key={part.id} part={part} />;
    case "tool":
      // Recursive render: a depth=2 spawn_teammate inside a depth=1
      // teammate's transcript still renders as a ToolPairRow. Inline
      // rendering caps recursion depth at the projector level (Δ.8
      // deferral) — depth>=2 events arrive flat in this transcript.
      return <ToolPairRow key={part.id} part={part} />;
    case "model-error":
      return <ModelErrorRow key={part.id} part={part} />;
    case "system":
      return <SystemNoticeRow key={part.id} part={part} />;
    default:
      return null;
  }
}

/**
 * Inline approve/reject for a dangerous-command gate paused on
 * `command-approval-service`. Lives next to the ToolPart it gates so
 * the user has the full command context. POSTs to the existing
 * /approvals/:id/approve|reject endpoints; the projector clears
 * pendingApproval when the matching tool_result lands, which removes
 * this row automatically.
 */
/**
 * Sandbox-elevation v4.3 §4.6 — model justification renderer.
 *
 * Two defense-in-depth lines:
 *   1. Text content goes through React as a plain text node, so any
 *      remaining HTML/script content (server should have stripped
 *      already via sanitizeJustification) is rendered literally,
 *      never executed.
 *   2. The label `🤖 Model's reason:` is HARD-CODED here, not derived
 *      from server data — even if the model writes a string like
 *      `🤖 Magister's reason:` into its own justification text, the
 *      chrome label stays "Model's reason:" so the user always knows
 *      who wrote what.
 *
 * 5-line cap with "Show more / Show less" toggle prevents the model
 * from padding-out the card with whitespace.
 */
function ModelJustification({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const isLong = lines.length > 5;
  const visibleText = !expanded && isLong ? lines.slice(0, 5).join("\n") : text;
  return (
    <div className="chat-approval-card__justification">
      <div className="chat-approval-card__justification-label">🤖 Model's reason:</div>
      <pre className="chat-approval-card__justification-text">{visibleText}</pre>
      {isLong ? (
        <button
          type="button"
          className="chat-approval-card__justification-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show more (${lines.length - 5} more lines)`}
        </button>
      ) : null}
    </div>
  );
}

function ApprovalRow({
  approval,
}: {
  approval: {
    approvalId: string;
    reason: string;
    command: string;
    toolKind?: "bash" | "mcp_tool";
    subjectKey?: string | null;
    // Sandbox-elevation v4.3 §4.1 §4.6 — optional v4 fields
    justification?: string;
    sandboxMode?: "use_default" | "with_additional_permissions" | "require_escalated";
    additionalPermissions?: {
      network?: { enabled?: boolean };
      file_system?: {
        entries: Array<{
          path: string;
          access: "read" | "write";
          sensitivity: "safe" | "caution" | "critical";
          sensitivityReason: string;
        }>;
      };
    };
    denyReadRequestedButUnsupported?: Array<{
      path: string;
      classification: "safe" | "caution" | "critical";
    }>;
  };
}) {
  const [state, setState] = useState<"idle" | "pending" | "resolved" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Task-scoped + 5-minute trust shortcuts. Mutually exclusive
  // (toggling one clears the other); the server's resolve route only
  // honors trust_for_task when set, else trust_for_minutes.
  const [trustForTask, setTrustForTask] = useState(false);
  const [trustForMinutes, setTrustForMinutes] = useState(false);
  // Sandbox-elevation v4.3 §4.5 (codex Q2) — dual-channel conflict
  // notice. Set when the server reports our resolve lost to a
  // concurrent click from another channel (Web vs Feishu).
  const [conflictNotice, setConflictNotice] = useState<
    { storedOutcome: "approved" | "rejected" | "expired" | "pending" } | null
  >(null);

  // Once the API confirms the approval, mark the card "resolved"
  // locally and hide it. Earlier we waited for the SSE tool_result to
  // clear pendingApproval, but the model's thinking step between
  // bash-run and tool_result emission is often 1-2 min (esp. with
  // thinking models like qwen3.5-plus). The projector still clears
  // the underlying pendingApproval when tool_result lands, so this is
  // purely a
  // visual fast-path — no state drift.
  if (state === "resolved") return null;

  // Label the trust scope by what the user can actually reason about.
  // For MCP we know the server id; for bash we only know "this kind
  // of command" (subject is "*"), so phrase it neutrally.
  const isMcp = approval.toolKind === "mcp_tool";
  const subjectLabel = isMcp && approval.subjectKey
    ? `“${approval.subjectKey}”`
    : "commands like this";

  const submit = async (decision: "approve" | "reject") => {
    if (state === "pending") return;
    setState("pending");
    setErrMsg(null);
    try {
      const opts =
        decision === "approve"
          ? trustForTask
            ? { trustForTask: true }
            : trustForMinutes
              ? { trustForMinutes: 5 }
              : undefined
          : undefined;
      const response = await resolveApproval(approval.approvalId, decision, opts);
      // Sandbox-elevation v4.3 §4.5 — if the server reports a
      // dual-channel collision, show a yellow notice instead of
      // silently hiding. The other channel (Web or Feishu) already
      // resolved this approval with a different decision.
      if (response.conflict && response.storedOutcome) {
        setConflictNotice({ storedOutcome: response.storedOutcome });
        // Hide the card after 3s — the SSE event will eventually
        // clear pendingApproval too.
        setTimeout(() => setState("resolved"), 3000);
        return;
      }
      // Server confirmed — hide the card immediately. SSE tool_result
      // will eventually clear pendingApproval too (projector strip),
      // but that may be 1-2 min away if the model is thinking after
      // the bash returns. Don't make the user stare at a "..." spinner
      // for the whole model turn.
      setState("resolved");
    } catch (err) {
      setState("error");
      setErrMsg(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="chat-approval-card" role="alert" aria-live="polite">
      <div className="chat-approval-card__header">
        <span className="chat-approval-card__icon" aria-hidden="true">🔒</span>
        <span className="chat-approval-card__title">Approval needed</span>
      </div>
      <div className="chat-approval-card__reason">{approval.reason}</div>
      {approval.command ? (
        <pre className="chat-approval-card__command">{approval.command}</pre>
      ) : null}

      {/* Sandbox-elevation v4.3 §4.7 — deny-read-requested banner.
          Red bordered notice ABOVE the path list (more prominent).
          Model wanted these paths blocked from reading but v4 can't
          enforce; user should treat as sensitive in their judgment. */}
      {approval.denyReadRequestedButUnsupported && approval.denyReadRequestedButUnsupported.length > 0 ? (
        <div className="chat-approval-card__deny-read-notice" role="alert">
          <div className="chat-approval-card__deny-read-title">
            ⚠️ Model requested deny-read for these paths (v4 doesn't support deny-read)
          </div>
          <ul className="chat-approval-card__deny-read-list">
            {approval.denyReadRequestedButUnsupported.map((entry) => (
              <li key={entry.path} className="chat-approval-card__deny-read-row">
                <span className="chat-approval-card__path-tag chat-approval-card__path-tag--critical">🔴</span>
                <code className="chat-approval-card__path">{entry.path}</code>
              </li>
            ))}
          </ul>
          <div className="chat-approval-card__deny-read-hint">
            The model wanted these blocked from reading. Magister v4 cannot enforce this — they may
            be readable if other binds expose them. Reject if you don't accept this limitation.
          </div>
        </div>
      ) : null}

      {/* Sandbox-elevation v4.3 §4.1 §4.7 — additional_permissions paths
          grouped by access (write first, more prominent), color-coded
          by sensitivity classification. */}
      {approval.additionalPermissions?.file_system?.entries
        && approval.additionalPermissions.file_system.entries.length > 0 ? (
        <div className="chat-approval-card__paths">
          <div className="chat-approval-card__paths-title">Additional permissions requested:</div>
          {(["write", "read"] as const).map((access) => {
            const entries = approval.additionalPermissions?.file_system?.entries.filter(
              (e) => e.access === access,
            ) ?? [];
            if (entries.length === 0) return null;
            return (
              <div key={access} className="chat-approval-card__paths-group">
                <div className="chat-approval-card__paths-access-label">
                  {access === "write" ? "✏️ Write access" : "👁 Read access"}
                </div>
                <ul className="chat-approval-card__paths-list">
                  {entries.map((entry) => (
                    <li
                      key={`${entry.access}:${entry.path}`}
                      className={`chat-approval-card__paths-row chat-approval-card__paths-row--${entry.sensitivity}`}
                      title={entry.sensitivityReason}
                    >
                      <span className="chat-approval-card__path-tag" aria-label={entry.sensitivity}>
                        {entry.sensitivity === "critical" ? "🔴" : entry.sensitivity === "caution" ? "🟡" : "🟢"}
                      </span>
                      <code className="chat-approval-card__path">{entry.path}</code>
                      <span className="chat-approval-card__path-reason">{entry.sensitivityReason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {approval.additionalPermissions.network?.enabled ? (
            <div className="chat-approval-card__paths-network">
              🌐 Network: all hosts (per-host scoping coming in v4.5)
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Sandbox-elevation v4.3 §4.6 — model-generated justification
          rendered as plain text (React text node, no innerHTML), with
          explicit chrome label so the user knows it's FROM the model
          (server-controlled label string, not part of the justification).
          5-line cap with show-more. The text is already sanitized
          server-side (justification-sanitizer.ts). */}
      {approval.justification ? (
        <ModelJustification text={approval.justification} />
      ) : null}

      <div className="chat-approval-card__trust">
        <label className="chat-approval-card__trust-row">
          <input
            type="checkbox"
            checked={trustForMinutes}
            disabled={state === "pending"}
            onChange={(e) => {
              setTrustForMinutes(e.target.checked);
              if (e.target.checked) setTrustForTask(false);
            }}
          />
          <span>Trust {subjectLabel} for 5 minutes</span>
        </label>
        <label className="chat-approval-card__trust-row">
          <input
            type="checkbox"
            checked={trustForTask}
            disabled={state === "pending"}
            onChange={(e) => {
              setTrustForTask(e.target.checked);
              if (e.target.checked) setTrustForMinutes(false);
            }}
          />
          <span>Trust {subjectLabel} for this task</span>
        </label>
      </div>
      <div className="chat-approval-card__actions">
        <button
          type="button"
          className="chat-approval-card__btn chat-approval-card__btn--approve"
          disabled={state === "pending"}
          onClick={() => void submit("approve")}
        >
          {state === "pending"
            ? "…"
            : (() => {
                // Sandbox-elevation v4.3 spec acceptance #11 — dynamic
                // label reflects what the user is granting. Helps the
                // user notice they're approving N specific paths
                // (not just generic command consent).
                const pathCount =
                  approval.additionalPermissions?.file_system?.entries.length ?? 0;
                if (pathCount > 0) {
                  return `✓ Approve & grant ${pathCount} path${pathCount === 1 ? "" : "s"}`;
                }
                return "✓ Approve";
              })()}
        </button>
        <button
          type="button"
          className="chat-approval-card__btn chat-approval-card__btn--reject"
          disabled={state === "pending"}
          onClick={() => void submit("reject")}
        >
          ✗ Reject
        </button>
      </div>
      {errMsg && <div className="chat-approval-card__error">{errMsg}</div>}
      {conflictNotice ? (
        <div className="chat-approval-card__conflict" role="status" aria-live="polite">
          ⚠️ Approval was already <strong>{conflictNotice.storedOutcome}</strong> by another channel
          (Web or Feishu) — your action was not applied.
        </div>
      ) : null}
    </div>
  );
}

function ToolGroup({ parts }: { parts: ToolPart[] }) {
  const [expanded, setExpanded] = useState(false);
  const distinctNames = Array.from(new Set(parts.map((p) => p.name))).slice(0, 3);
  const summary = distinctNames.join(", ");
  return (
    <div className="message-row message-row--tool-group">
      <button
        type="button"
        className="tool-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span aria-hidden="true">📁</span>
        <strong>Used {parts.length} tools</strong>
        {summary && <span className="tool-group__summary">— {summary}</span>}
        <span className="tool-group__chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-group__body">
          {parts.map((p) => <ToolPairRow key={p.id} part={p} />)}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Model error
// ──────────────────────────────────────────────────────────────────────

const ModelErrorRow = memo(function ModelErrorRow({ part }: { part: ModelErrorPart }) {
  return (
    <div className="message-row message-row--model-error">
      <div className="message-bubble message-model-error">
        <span aria-hidden="true">❌</span>
        <span>Model error</span>
        <pre className="model-error__detail">{part.message}</pre>
      </div>
    </div>
  );
}, (a, b) => a.part.id === b.part.id && a.part.message === b.part.message);

// ──────────────────────────────────────────────────────────────────────
// System notice (compaction / doom-loop / max-turns)
// ──────────────────────────────────────────────────────────────────────

const SystemNoticeRow = memo(function SystemNoticeRow({ part }: { part: SystemPart }) {
  // Status variant (the local /status slash command output) renders
  // always-expanded with no chevron — the detail IS the message. All
  // backend-emitted variants (compaction / doom_loop / max_turns /
  // recovery) keep the click-to-expand pattern so the conversation
  // log stays scannable.
  const alwaysExpanded = part.variant === "status";
  const [expanded, setExpanded] = useState(alwaysExpanded);
  const hasDetail = !!part.detail && part.detail.trim().length > 0;
  const showDetail = (alwaysExpanded || expanded) && hasDetail;
  return (
    <div className={`chat-system-notice chat-system-notice--${part.variant}`}>
      <button
        type="button"
        className="chat-system-notice__header"
        onClick={
          alwaysExpanded
            ? undefined
            : hasDetail
              ? () => setExpanded((v) => !v)
              : undefined
        }
        disabled={!hasDetail || alwaysExpanded}
        aria-expanded={hasDetail && !alwaysExpanded ? expanded : undefined}
      >
        <span className="chat-system-notice__headline">{part.headline}</span>
        {hasDetail && !alwaysExpanded && (
          <span className="chat-system-notice__chevron">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {showDetail && (
        <div className="chat-system-notice__detail">{part.detail}</div>
      )}
    </div>
  );
}, (a, b) => a.part.id === b.part.id && a.part.headline === b.part.headline && a.part.detail === b.part.detail);

// ──────────────────────────────────────────────────────────────────────
// Todo list block — live plan tracker emitted by `update_plan`.
// Spec: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md
// ──────────────────────────────────────────────────────────────────────

const TODO_GLYPH: Record<TodoListPart["todos"][number]["status"], string> = {
  pending: "□",
  in_progress: "▶",
  completed: "✔",
  cancelled: "⊘",
};

const TodoListBlock = memo(function TodoListBlock({ part }: { part: TodoListPart }) {
  const counts = part.todos.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const total = part.todos.length;
  const done = counts.completed ?? 0;

  return (
    <div className="chat-todo-list" role="list" aria-label="Plan">
      <div className="chat-todo-list__header">
        <span className="chat-todo-list__title">Plan</span>
        <span className="chat-todo-list__progress">
          {done}/{total}
          {(counts.in_progress ?? 0) > 0 ? " · running" : null}
        </span>
      </div>
      <ul className="chat-todo-list__items">
        {part.todos.map((t, idx) => (
          <li
            key={`${part.id}:${idx}`}
            // Priority is in the schema but not rendered in v1 — see
            // spec §7.4. Add the priority modifier here when UI design
            // for it lands.
            className={`chat-todo-item chat-todo-item--${t.status}`}
            role="listitem"
            aria-current={t.status === "in_progress" ? "step" : undefined}
          >
            <span className="chat-todo-item__glyph" aria-hidden>
              {TODO_GLYPH[t.status]}
            </span>
            <span className="chat-todo-item__text">
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}, (a, b) => {
  if (a.part.id !== b.part.id) return false;
  if (a.part.todos.length !== b.part.todos.length) return false;
  for (let i = 0; i < a.part.todos.length; i++) {
    const x = a.part.todos[i]!;
    const y = b.part.todos[i]!;
    if (x.content !== y.content || x.activeForm !== y.activeForm || x.status !== y.status || x.priority !== y.priority) {
      return false;
    }
  }
  return true;
});

// ──────────────────────────────────────────────────────────────────────
// Thinking block — reasoning content streamed before the answer.
// Spec: docs/specs/2026-04-28-thinking-stream-spec.md
// ──────────────────────────────────────────────────────────────────────

const ThinkingBlock = memo(function ThinkingBlock({ part }: { part: ThinkingPart | null }) {
  // `part === null` is the placeholder mode (between user click Send
  // and the first model event). Renders just the header. When the
  // first thinking_delta arrives ResponseView swaps `part` from null
  // to a real ThinkingPart on this same component instance — React
  // reconciles in place rather than mounting a different component
  // type, no DOM seam.
  //
  // Real-mode rationale: read part.content DIRECTLY, bypass the
  // TextBuffer animator. The 60fps typewriter smooths slow model
  // output (good for the visible answer text) but actively hides
  // fast model output — a thinking burst of ~50 chars in 60ms is
  // the model's real emission rate, and animating it out stretches
  // it into a typewriter that obscures the actual streaming. Users
  // expecting opencode-CLI-style streaming see the buffer-smoothed
  // version as "all at once". Direct content read matches a TUI
  // printing bytes as they arrive.
  const sealed = part?.sealed ?? false;
  const visibleText = part?.content ?? "";

  // Local wall-clock for the "Thought for X.Xs" summary. NOT stored
  // in the projector (would break replay determinism). Live sessions
  // get accurate numbers; cold-load snapshot replay shows "Thought
  // for a moment" since we mounted AFTER the part was already sealed.
  const [mountedAt] = useState(() => Date.now());
  const [sealedAt, setSealedAt] = useState<number | null>(null);
  const [userToggled, setUserToggled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!sealed || sealedAt !== null) return;
    setSealedAt(Date.now());
  }, [sealed, sealedAt]);

  // Fold the moment streaming ends. Manual toggle (clicking the
  // header) still wins — `userToggled` overrides the auto-fold.
  // While streaming (not yet sealed) the body stays expanded so the
  // user can watch reasoning unfold live.
  const expanded = userToggled !== null ? userToggled : !sealed;

  const elapsedSec = sealed && sealedAt
    ? ((sealedAt - mountedAt) / 1000)
    : null;
  const summary = sealed
    ? (elapsedSec !== null && elapsedSec >= 0.1
        ? `🤔 Thought for ${elapsedSec.toFixed(1)}s`
        : "🤔 Thought for a moment")
    : "🤔 Thinking...";

  return (
    <div className={`chat-thinking-block ${sealed ? "chat-thinking-block--sealed" : "chat-thinking-block--streaming"}`}>
      <button
        type="button"
        className="chat-thinking-block__header"
        onClick={() => setUserToggled((prev) => prev === null ? !expanded : !prev)}
        aria-expanded={expanded}
      >
        <span className="chat-thinking-block__summary">{summary}</span>
        {visibleText && (
          <span className="chat-thinking-block__chevron">{expanded ? "▾" : "▸"}</span>
        )}
      </button>
      {expanded && visibleText && (
        <div className="chat-thinking-block__body">{visibleText}</div>
      )}
    </div>
  );
}, (prev, next) => {
  // Memoize on (id, content, sealed). The big body text can be 80KB;
  // without memo, every parent re-render (RAF-batched thinking_delta
  // on a sibling exchange, snapshot replay tick, etc.) re-renders the
  // full string and forces a browser layout. On mobile that's the
  // dominant lag source during a long thinking burst.
  if (prev.part === next.part) return true;
  if (prev.part === null || next.part === null) return false;
  return prev.part.id === next.part.id
    && prev.part.content === next.part.content
    && prev.part.sealed === next.part.sealed;
});

// ──────────────────────────────────────────────────────────────────────
// Tool grouping (pure pass)
// ──────────────────────────────────────────────────────────────────────

type RenderItem =
  | { kind: "text"; part: TextPart }
  | { kind: "thinking"; part: ThinkingPart }
  | { kind: "media"; part: MediaPart }
  | { kind: "tool"; part: ToolPart }
  | { kind: "tool-group"; key: string; parts: ToolPart[] }
  | { kind: "model-error"; part: ModelErrorPart }
  | { kind: "plan"; part: PlanPart }
  | { kind: "todo_list"; part: TodoListPart }
  | { kind: "system"; part: SystemPart };

/**
 * Walk parts in order; runs of ≥2 consecutive completed (result !== null)
 * tool parts collapse into a `tool-group`. A running (result === null)
 * tool part keeps its peers from grouping — we want the user to see
 * each tool in flight without the collapse hiding progress.
 *
 * Pure: no React hooks, deterministic. Unit-tested for boundary cases.
 */
export function groupConsecutiveTools(parts: ResponsePart[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i]!;
    if (p.kind !== "tool" || p.result === null) {
      // text / thinking / model-error / running tool / plan / system —
      // emit individually. Without an explicit thinking branch the
      // default fall-through would render ThinkingParts as red
      // ModelErrorRow (silent regression caught in spec review).
      if (p.kind === "text") out.push({ kind: "text", part: p });
      else if (p.kind === "thinking") out.push({ kind: "thinking", part: p });
      else if (p.kind === "media") out.push({ kind: "media", part: p });
      else if (p.kind === "tool") out.push({ kind: "tool", part: p });
      else if (p.kind === "plan") out.push({ kind: "plan", part: p });
      else if (p.kind === "todo_list") out.push({ kind: "todo_list", part: p });
      else if (p.kind === "system") out.push({ kind: "system", part: p });
      else out.push({ kind: "model-error", part: p });
      i++;
      continue;
    }
    // Found a completed tool. Look ahead for ≥1 more consecutive completed tool.
    const run: ToolPart[] = [p];
    let j = i + 1;
    while (j < parts.length) {
      const q = parts[j]!;
      if (q.kind === "tool" && q.result !== null) {
        run.push(q);
        j++;
      } else break;
    }
    if (run.length >= 2) {
      out.push({ kind: "tool-group", key: `tool-group:${p.id}`, parts: run });
    } else {
      out.push({ kind: "tool", part: p });
    }
    i = j;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function stripMarkdownSyntax(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function compactHeaderText(value: string, max: number): string {
  const oneLine = stripMarkdownSyntax(value).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function formatTeammateDuration(part: ToolPart): string | null {
  if (part.teammateStartedAtMs === undefined) return null;
  const end = part.teammateCompletedAtMs ?? Date.now();
  return formatDuration(end - part.teammateStartedAtMs);
}

function formatTeammateTokens(part: ToolPart): string {
  const inn = part.teammateInputTokens ?? 0;
  const out = part.teammateOutputTokens ?? 0;
  return `${compactTokenCount(inn)} → ${compactTokenCount(out)}`;
}

function teammateTokenTitle(part: ToolPart): string {
  const inn = part.teammateInputTokens ?? 0;
  const out = part.teammateOutputTokens ?? 0;
  const cache = part.teammateCacheReadTokens ?? 0;
  const lines = [`${inn.toLocaleString()} input tokens`, `${out.toLocaleString()} output tokens`];
  if (cache > 0) lines.push(`${cache.toLocaleString()} cache-read tokens`);
  return lines.join(" · ");
}

function compactTokenCount(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function extractTeammateMeta(input: unknown): { role: string; goalPreview: string } | null {
  // Backend now emits `data.input` as a structured object (see
  // tool-execution.ts:summarizeToolInputForEvent) so the projector
  // hands us a Record. Older `leader.tool_call` events recorded
  // before that change only have `inputSummary` (a JSON string);
  // the projector's data.input fallback maps that here, so we also
  // handle the string case via best-effort JSON.parse — falls
  // through to generic rendering if the string was truncated mid-
  // value and won't parse.
  let obj: Record<string, unknown> | null = null;
  if (input && typeof input === "object") {
    obj = input as Record<string, unknown>;
  } else if (typeof input === "string" && input.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!obj) return null;
  const role = typeof obj.role === "string" ? obj.role.trim() : "";
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  if (!role) return null;
  // Strip the leader's most common prompt-engineering preamble.
  // Leaders frequently produce goals like
  //   "Role: coder\nTask: <actual task>"  or
  //   "Role: coder Task: <actual task>"
  // which renders as a long common prefix across sibling spawns and
  // makes the cards look "all the same" — the differentiating
  // content gets buried past the preview cutoff. The card already
  // shows the role explicitly via "→ <role>", so drop the duplicate
  // before truncating.
  const stripPrefix = (s: string): string => {
    const m = s.match(/^\s*role\s*[:：]\s*\S+\s*(?:[.\n]|\s)\s*(?:task|goal|objective)\s*[:：]\s*/i);
    if (m) return s.slice(m[0].length);
    const t = s.match(/^\s*(?:task|goal|objective)\s*[:：]\s*/i);
    if (t) return s.slice(t[0].length);
    return s;
  };
  const cleaned = stripPrefix(goal);
  const oneLine = cleaned.replace(/\s+/g, " ").trim();
  // 160 chars (≈ 2 visual rows) gives sibling spawns enough room for
  // the differentiating clause to show even when leaders preface with
  // a 30-50 char common context sentence.
  const goalPreview = oneLine.length > 160 ? oneLine.slice(0, 157) + "…" : oneLine;
  return { role, goalPreview };
}

function formatToolArgs(input: unknown): string {
  if (input == null) return "";
  let str: string;
  if (typeof input === "string") str = input;
  else {
    try { str = JSON.stringify(input); } catch { return ""; }
  }
  const compact = str.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
}

function stringifyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}
