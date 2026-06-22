/**
 * Module-level mirror of the currently-selected task id.
 *
 * Why this exists: the URL is the single source of truth for "what task is
 * the user looking at" — components read it via `useSelectedTaskId()` which
 * wraps `useParams()`. But code that runs OUTSIDE React (WebSocket event
 * handlers in `wsStore`, for example) cannot use hooks. They consult this
 * mirror instead.
 *
 * The mirror is updated by exactly one writer: a `useEffect` in `ChatPage`
 * that watches the URL param and calls `setCurrentSelectedTaskId` whenever
 * it changes. There is no second source of truth and no race.
 */

let currentSelectedTaskId: string | null = null;

export function setCurrentSelectedTaskId(id: string | null): void {
  currentSelectedTaskId = id;
}

export function getCurrentSelectedTaskId(): string | null {
  return currentSelectedTaskId;
}
