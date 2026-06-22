export const MEMORY_CONFIG = {
  agingDays: 30,
  staleDays: 90,
  typedEntryBodyMaxBytes: 8 * 1024,       // 8 KB
  typedEntryBodyMaxLines: 200,
  // Cheatsheet bodies are full-injected every turn, so the cap stays
  // tight — same shape as typed entries. Scratchpad is task-scoped
  // and meant to hold richer in-flight notes (open files, current
  // mental model, partial diffs) so its cap is 2× to absorb that.
  cheatsheetBodyMaxBytes: 8 * 1024,
  cheatsheetBodyMaxLines: 200,
  scratchpadBodyMaxBytes: 16 * 1024,
  scratchpadBodyMaxLines: 400,
  descriptionMaxChars: 120,
  sweeperIntervalMs: 24 * 60 * 60 * 1000, // 24 h
  indexRebuildDebounceMs: 200,
  // Hard cap on the rendered <memories> block.
  // The injection runs on every leader turn, so an uncapped store
  // silently eats context budget once an install accumulates a few
  // hundred typed entries plus full-body cheatsheets and scratchpad.
  // 16 KB ≈ 4K tokens; overflow truncates the typed-entry index and
  // emits a footer pointing the model at view_memory.
  injectionMaxBytes: 16 * 1024,
} as const;
