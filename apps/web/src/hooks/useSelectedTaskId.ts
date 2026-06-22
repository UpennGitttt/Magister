import { useParams } from "react-router-dom";

/**
 * The currently-selected task id, derived from the URL via React Router.
 *
 * URL is the single source of truth for selection. A previous design kept
 * a mirrored `selectedTaskId` in Zustand and wrote to both URL and store
 * during a send; the two state systems would commit on different ticks and
 * the route-sync effect would observe a window where they disagreed,
 * wiping in-flight optimistic state. With URL-as-truth that race cannot
 * happen — there is only one writer (React Router) and one reader (this
 * hook).
 */
export function useSelectedTaskId(): string | null {
  const { taskId } = useParams<{ taskId?: string }>();
  return taskId ?? null;
}
