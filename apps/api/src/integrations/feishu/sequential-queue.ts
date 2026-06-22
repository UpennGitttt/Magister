/**
 * Per-key sequential task queue.
 *
 * Why we need it: Feishu's IM API is per-request, not per-chat. Two
 * concurrent `text_delta` events for the same chat can land out of
 * order at the network layer, producing scrambled card updates or
 * even rejected `sequence` values on the CardKit stream. Wrapping
 * every send for a given chat in this queue guarantees the network
 * call for delta N starts only after delta N-1's HTTP response has
 * landed.
 *
 * Design tenets:
 * - Each `key` (typically `feishu:${bindingId}` per per-chat
 *   serialization, or a `:control` / `:btw` suffix for priority lanes)
 *   gets its own promise chain.
 * - Tasks chain via `.then(task, task)` — passing the same handler
 *   for both `onFulfilled` AND `onRejected` means a failed task
 *   does NOT poison subsequent enqueues. The next task still runs;
 *   the chain itself never enters a rejected terminal state.
 * - Auto-cleanup: when a task completes and no further task has
 *   been chained behind it (i.e. `queues.get(key) === itsPromise`),
 *   we delete the key from the map. Keeps `queues` from growing
 *   unboundedly across long-running operators.
 *
 * NOT a fair scheduler. Tasks for different keys run concurrently;
 * tasks for the same key run strictly in FIFO order.
 *
 * NOT a rate limiter — that's `streaming-card.ts`'s throttle. This
 * just serializes. If you call enqueue 1000 times instantly, all 1000
 * will run as fast as the network allows, just one-at-a-time.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Schedule `task` after every prior task with the same `key` has
 * completed. Returns the promise for `task`'s own result.
 *
 * Failures inside `task` are returned to the caller (the promise
 * rejects), but the chain continues — the next call to `enqueue(key, …)`
 * runs regardless of whether the previous task threw.
 */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  // Use the same handler for both resolve and reject paths so a
  // failed task doesn't break the chain — next enqueue still runs.
  const next = prev.then(task, task) as Promise<T>;
  queues.set(key, next);
  // Cleanup: once this task settles, if no one has chained behind
  // us we drop the key. We compare by reference to make sure we
  // don't delete a chain that someone ELSE has appended to in the
  // microtask between our `.set` and the cleanup.
  //
  // Using `.then(cleanup, cleanup)` instead of `.finally(cleanup)`
  // because `.finally` returns a derived promise that propagates
  // the rejection — if nothing catches THAT derived promise, bun
  // reports an unhandled rejection even though the original `next`
  // is returned to the caller and DOES get caught. The `.then`
  // form returns a fulfilled promise and we explicitly `void` it.
  void next.then(
    () => {
      if (queues.get(key) === next) queues.delete(key);
    },
    () => {
      if (queues.get(key) === next) queues.delete(key);
    },
  );
  return next;
}

/**
 * Build a queue key for the standard "per-chat" serialization.
 * Use the optional `lane` to access priority lanes:
 *   - undefined → main queue
 *   - "control" → abort / cancel commands (cuts in front of streaming)
 *   - "btw"     → "between" commands; isolated from main + control
 *
 * Note: `bindingId` is the conversation_bindings.id, not the
 * platform `chat_id`. Magister's binding model already collapses 1:1
 * chats and group-topic-thread-scoped chats into distinct bindings;
 * keying on bindingId picks up that scope for free without needing
 * to know about threadId here.
 */
export function feishuChatKey(bindingId: string, lane?: "control" | "btw"): string {
  return lane ? `feishu:${bindingId}:${lane}` : `feishu:${bindingId}`;
}

/**
 * Test helper — never call from production. Clears all queues. Used
 * by integration tests that need a clean slate between runs.
 */
export function __resetQueueForTests(): void {
  queues.clear();
}

/**
 * Diagnostic snapshot — returns the current keys in the map. Used by
 * `GET /diagnostics/feishu` to surface queue depth/health.
 */
export function getQueueSnapshot(): { activeKeys: string[]; size: number } {
  return { activeKeys: Array.from(queues.keys()), size: queues.size };
}
