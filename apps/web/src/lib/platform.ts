/**
 * Platform-aware helpers for keyboard-shortcut affordances.
 *
 * Why this file exists: hotkey hints sprinkled across the UI (Dashboard
 * command chips, ChatPage session search "⌘ K" sub-label, ChatInput
 * "⌘ ⏎ send" footer) all hard-coded the Mac glyph. On Windows / Linux
 * the actual modifier is Ctrl, so showing ⌘ is a lie; on a touch-only
 * device there's no keyboard at all and the hint is pure noise.
 *
 * Module is environment-safe: every check guards `typeof navigator`
 * + `typeof window` so SSR or jsdom test runs don't blow up.
 */

/**
 * Returns the modifier-key glyph appropriate for the current platform.
 *
 * - Mac (incl. iPad-with-keyboard which presents as Macintosh in UA):
 *   `⌘`
 * - Everything else: literal `Ctrl`
 *
 * The Dashboard chips and key hints render this so the same component
 * works on both platforms without per-build flags. Recompute on demand
 * rather than caching — cheap and avoids stale-on-SSR-hydrate bugs.
 */
export function getModSymbol(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(ua) ? "⌘" : "Ctrl";
}

/**
 * `true` when the device has no fine-pointer (touch-only). Lets call
 * sites suppress keyboard chips so phones / tablets don't show empty
 * shortcuts the user can't trigger.
 *
 * Backed by `hover: none` + `pointer: coarse` — same definition CSS
 * media queries use, kept in sync so JS-conditional renders and
 * CSS-only hides don't diverge.
 */
export function isTouchOnlyDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return (
      window.matchMedia("(hover: none) and (pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Matches a KeyboardEvent against a `[modKey + key]` shortcut without
 * caring whether the user hit ⌘ or Ctrl — `e.metaKey || e.ctrlKey`
 * covers both Mac and Win/Linux. Pass `key` in lowercase form for
 * letters; pass `"Enter"` exactly for Enter.
 */
export function isModShortcut(
  event: KeyboardEvent,
  key: string,
): boolean {
  if (!event.metaKey && !event.ctrlKey) return false;
  // Some browsers report "K" capitalized when Shift is held; the
  // shortcut here is the bare ⌘K (no Shift), so reject Shift-K
  // combinations to avoid hijacking the user's text.
  if (event.shiftKey || event.altKey) return false;
  if (key === "Enter") return event.key === "Enter";
  return event.key.toLowerCase() === key.toLowerCase();
}
