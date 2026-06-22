/**
 * Per-message header strip helpers — pure functions consumed by
 * render.tsx to draw a 22px speaker+timestamp row above each chat
 * message bubble. See spec/inline notes in render.tsx for placement.
 *
 * Header rules:
 *   - Speaker name from role: "You" for user, "Leader" for the leader
 *     loop, role-titlecase otherwise.
 *   - Dot color keyed off role: sage (leader), blue (coder),
 *     ochre (reviewer), red (failed/error), ink (user), purple
 *     (architect), sage-deep (lander), blue (evaluator).
 *   - Relative timestamp ("just now", "2m ago", "1h ago") computed
 *     from a stamped wall-clock ms vs the current render frame.
 *   - Consecutive messages from the same speaker within 60s are
 *     visually grouped (no header on the follow-up). Caller decides
 *     suppression — these helpers only describe.
 */

export type SpeakerKind = "user" | "leader" | "agent";

export type SpeakerInfo = {
  /** Displayed name, e.g. "You", "Leader", "Coder". */
  label: string;
  /** CSS modifier slug; drives dot color via .message-header__dot--<slug>. */
  dotSlug: string;
  /** Underlying role (lowercase) for grouping ids. */
  roleKey: string;
};

/**
 * Decide the speaker block from an optional role + name (as carried on
 * each part). `kind="user"` ignores role/name and renders "You".
 */
export function describeSpeaker(
  kind: SpeakerKind,
  role?: string,
  name?: string,
): SpeakerInfo {
  if (kind === "user") {
    return { label: "You", dotSlug: "user", roleKey: "user" };
  }
  // Normalise to lowercase for stable slug → CSS class mapping.
  const lowered = (role ?? "leader").toLowerCase().trim() || "leader";
  const dotSlug = slugForRole(lowered);
  // Prefer the wire-carried display name; fall back to titlecasing the
  // role. "leader" → "Leader", "coder" → "Coder".
  const fallback = lowered.charAt(0).toUpperCase() + lowered.slice(1);
  const label = (name && name.trim().length > 0) ? name.trim() : fallback;
  return { label, dotSlug, roleKey: lowered };
}

function slugForRole(role: string): string {
  switch (role) {
    case "leader":
    case "manager":
      return "leader";
    case "coder":
      return "coder";
    case "reviewer":
      return "reviewer";
    case "architect":
      return "architect";
    case "lander":
      return "lander";
    case "evaluator":
      return "evaluator";
    case "you":
    case "user":
      return "user";
    default:
      // Unknown / custom roles get a neutral sage tint so they don't
      // clash with the named palette. We never throw — chat headers
      // must survive every weird role label.
      return "leader";
  }
}

export function speakerDotClass(info: SpeakerInfo): string {
  return `message-header__dot message-header__dot--${info.dotSlug}`;
}

/**
 * "2m ago" style relative time. Coarse buckets — chat conversations
 * don't need second-precision for headers, and ticking every second
 * would force needless re-renders of every header row in a long
 * session. Caller decides whether to ever update; for static
 * timestamps older than a few minutes the value is stable.
 */
export function formatRelativeTime(stampMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - stampMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Group-suppression key. Used by the renderer to decide whether to
 * show the header at all on a given row — within a 60s window the
 * follow-up message stays headerless so visually-grouped exchanges
 * read like iMessage.
 */
export function groupingKey(info: SpeakerInfo): string {
  return info.roleKey;
}
