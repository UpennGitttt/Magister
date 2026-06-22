/**
 * Per-text-part streaming text buffer.
 *
 * One instance per `TextPart`, owned by the part for its lifetime; never
 * reassigned. (Replaces the prior module-level singleton, which was
 * deleted in PR 3.3 of the chat data-flow refactor.)
 *
 * Why per-part: the singleton design forced cross-task and cross-segment
 * state (e.g. resetting between tool-call boundaries inside the same
 * turn) to be coordinated externally. With one instance per part, the
 * lifecycle is trivial — the part's mount-to-seal window IS the buffer's
 * window.
 *
 * `useSyncExternalStore` integration: the leaf component reads via
 *   `useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, () => "")`
 * and the buffer reference is stable for the part's life, so React never
 * sees a torn snapshot or a swapped store.
 *
 * Animator pattern: a `requestAnimationFrame` loop advances `currentText`
 * toward `targetText` at a fixed cadence.
 */

const TYPING_CHARS_PER_FRAME = 12; // ~720 chars/sec at 60 fps

export class TextBuffer {
  private targetText = "";
  private currentText = "";
  private rafId: number | undefined = undefined;
  private readonly subscribers = new Set<() => void>();
  private drainResolvers: Array<() => void> = [];

  /** Append a text delta. Kicks the animator if idle. */
  appendDelta = (text: string): void => {
    if (!text) return;
    this.targetText += text;
    if (this.rafId === undefined && this.currentText.length < this.targetText.length) {
      this.rafId = this.scheduleTick();
    }
  };

  /**
   * Pre-seed the buffer with already-rendered text — used by snapshot
   * hydration so the leaf paints the rebuilt text immediately rather than
   * typing it out a second time. Both `target` and `current` jump to the
   * same value.
   */
  seed = (text: string): void => {
    this.targetText = text;
    this.currentText = text;
    this.notify();
  };

  /** useSyncExternalStore hook target. Returns an unsubscribe. */
  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  };

  /** useSyncExternalStore snapshot. */
  getSnapshot = (): string => this.currentText;

  /**
   * The FULL accumulated text (the animation target), regardless of how
   * far the typewriter has caught up. Unlike `getSnapshot()` (which
   * returns the partially-revealed `currentText`), this is the complete
   * streamed text. Used at seal time to reconcile the part's canonical
   * `content` when per-delta content accumulation is skipped — see
   * `chatStore.applyWireEvent` leader text_delta decoupling.
   */
  getFullText = (): string => this.targetText;

  /**
   * Wait for the typewriter to drain. Returns the final text. Callers
   * (e.g. seal-on-tool-call) await this before mutating the parent
   * conversation so the user sees the segment fully revealed before the
   * next tool row appears.
   */
  drain = (): Promise<string> => {
    if (this.currentText.length >= this.targetText.length) {
      return Promise.resolve(this.currentText);
    }
    return new Promise((resolve) => {
      this.drainResolvers.push(() => resolve(this.currentText));
    });
  };

  /** True iff the typewriter is still typing toward target. */
  isAnimating = (): boolean => this.currentText.length < this.targetText.length;

  /**
   * Stop the animator and resolve any pending drainers. Called when the
   * part is sealed — after this point the buffer is dead; the part
   * renders from `content` instead.
   */
  dispose = (): void => {
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const r of resolvers) {
      try { r(); } catch { /* swallow */ }
    }
    this.subscribers.clear();
  };

  private tick = (): void => {
    this.rafId = undefined;

    if (this.currentText.length < this.targetText.length) {
      const next = Math.min(
        this.currentText.length + TYPING_CHARS_PER_FRAME,
        this.targetText.length,
      );
      this.currentText = this.targetText.slice(0, next);
      this.notify();
    }

    if (this.currentText.length < this.targetText.length) {
      this.rafId = this.scheduleTick();
      return;
    }

    // Drained — flush waiters.
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const r of resolvers) {
      try { r(); } catch { /* swallow */ }
    }
  };

  /**
   * `requestAnimationFrame` is unavailable in Node test environments.
   * Fall back to a `setTimeout`-based 60 Hz tick so projector tests can
   * exercise the animator without jsdom.
   */
  private scheduleTick(): number {
    if (typeof requestAnimationFrame === "function") {
      return requestAnimationFrame(this.tick);
    }
    return setTimeout(this.tick, 1000 / 60) as unknown as number;
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try { cb(); } catch { /* swallow */ }
    }
  }
}
