/**
 * M5 P2-#8 (2026-05-15): process-local telemetry for the memory
 * subsystem. Phase 3's spec required this to decide whether the
 * auxiliary-LLM extractor is "worth keeping on the hot path" — the
 * decision was deferred because we had no data. This module collects
 * the missing data.
 *
 * What's tracked:
 *   - extractor invocations per reason (pre_compact / failure_reflection / amem_link)
 *   - extractor latency distribution (recent ring buffer)
 *   - ops applied vs proposed vs skipped (yield rate)
 *   - extractor errors (count + last N messages)
 *   - injection rendered-block byte size per turn (recent samples)
 *   - sweeper tick stats (duration, updated count, refs repaired, mtime-race skips)
 *
 * Design:
 *   - Process-local. No DB round-trip on hot path. The Diagnostics
 *     endpoint reads this aggregate; full per-event audit lives in
 *     `execution_events` (extractor failures are already mirrored
 *     there by `recordExtractorErrorEvent`).
 *   - Ring buffer caps memory at a fixed footprint regardless of
 *     uptime — we don't want 30-day-old runs to consume RAM.
 *   - Reset on `restart.sh` (acceptable — token usage is the
 *     long-horizon metric and that one is durable).
 *
 * Restart-survivability is intentionally NOT a goal. Operators who
 * need long-term trends should query `execution_events` directly.
 */

import type { ExtractReason } from "./memory-extractor-service";

const RECENT_BUFFER = 100;

interface ExtractorSample {
  reason: ExtractReason;
  durationMs: number;
  applied: number;
  skipped: number;
  parsed: number;
  errorCount: number;
  at: number;
}

interface InjectionSample {
  bytes: number;
  truncated: boolean;
  at: number;
}

interface SweeperSample {
  durationMs: number;
  updated: number;
  refsRepaired: number;
  mtimeRaceSkips: number;
  at: number;
}

const counters = {
  extractorRuns: { pre_compact: 0, failure_reflection: 0, amem_link: 0 },
  extractorApplied: { pre_compact: 0, failure_reflection: 0, amem_link: 0 },
  extractorSkipped: { pre_compact: 0, failure_reflection: 0, amem_link: 0 },
  extractorErrors: { pre_compact: 0, failure_reflection: 0, amem_link: 0 },
  extractorCoalesced: { pre_compact: 0, failure_reflection: 0, amem_link: 0 },
  injectionRenders: 0,
  injectionTruncations: 0,
  sweeperTicks: 0,
  sweeperMtimeRaceSkips: 0,
  authRejects: 0,
};

const extractorRing: ExtractorSample[] = [];
const injectionRing: InjectionSample[] = [];
const sweeperRing: SweeperSample[] = [];
const errorRing: Array<{ reason: ExtractReason; message: string; at: number }> = [];

function pushRing<T>(ring: T[], item: T) {
  ring.push(item);
  if (ring.length > RECENT_BUFFER) ring.shift();
}

export function recordExtractorRun(s: Omit<ExtractorSample, "at">): void {
  counters.extractorRuns[s.reason]++;
  counters.extractorApplied[s.reason] += s.applied;
  counters.extractorSkipped[s.reason] += s.skipped;
  if (s.errorCount > 0) counters.extractorErrors[s.reason]++;
  pushRing(extractorRing, { ...s, at: Date.now() });
}

export function recordExtractorCoalesced(reason: ExtractReason): void {
  counters.extractorCoalesced[reason]++;
}

export function recordExtractorError(
  reason: ExtractReason,
  message: string,
): void {
  pushRing(errorRing, { reason, message: message.slice(0, 240), at: Date.now() });
}

export function recordInjection(bytes: number, truncated: boolean): void {
  counters.injectionRenders++;
  if (truncated) counters.injectionTruncations++;
  pushRing(injectionRing, { bytes, truncated, at: Date.now() });
}

export function recordSweeper(s: Omit<SweeperSample, "at">): void {
  counters.sweeperTicks++;
  counters.sweeperMtimeRaceSkips += s.mtimeRaceSkips;
  pushRing(sweeperRing, { ...s, at: Date.now() });
}

export function recordAuthReject(): void {
  counters.authRejects++;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? null;
}

export interface MemoryTelemetrySnapshot {
  generatedAt: string;
  counters: typeof counters;
  extractor: {
    recentSamples: number;
    latencyMsP50: number | null;
    latencyMsP95: number | null;
    appliedRate: number | null; // applied / (applied + skipped + 0 if both 0)
    errorRate: number | null;
  };
  injection: {
    recentSamples: number;
    bytesP50: number | null;
    bytesP95: number | null;
    truncationRate: number | null;
  };
  sweeper: {
    recentSamples: number;
    avgDurationMs: number | null;
    totalMtimeRaceSkips: number;
  };
  recentErrors: Array<{
    reason: ExtractReason;
    message: string;
    at: string;
  }>;
}

export function snapshotMemoryTelemetry(): MemoryTelemetrySnapshot {
  const extLatencies = extractorRing
    .map((s) => s.durationMs)
    .slice()
    .sort((a, b) => a - b);
  const totalProposed = extractorRing.reduce(
    (n, s) => n + s.applied + s.skipped,
    0,
  );
  const totalApplied = extractorRing.reduce((n, s) => n + s.applied, 0);
  const errorRuns = extractorRing.filter((s) => s.errorCount > 0).length;

  const injBytes = injectionRing
    .map((s) => s.bytes)
    .slice()
    .sort((a, b) => a - b);
  const truncCount = injectionRing.filter((s) => s.truncated).length;

  const sweepDurations = sweeperRing.map((s) => s.durationMs);
  const avgSweepDuration =
    sweepDurations.length === 0
      ? null
      : sweepDurations.reduce((n, d) => n + d, 0) / sweepDurations.length;

  return {
    generatedAt: new Date().toISOString(),
    counters: { ...counters },
    extractor: {
      recentSamples: extractorRing.length,
      latencyMsP50: percentile(extLatencies, 0.5),
      latencyMsP95: percentile(extLatencies, 0.95),
      appliedRate: totalProposed > 0 ? totalApplied / totalProposed : null,
      errorRate:
        extractorRing.length > 0 ? errorRuns / extractorRing.length : null,
    },
    injection: {
      recentSamples: injectionRing.length,
      bytesP50: percentile(injBytes, 0.5),
      bytesP95: percentile(injBytes, 0.95),
      truncationRate:
        injectionRing.length > 0 ? truncCount / injectionRing.length : null,
    },
    sweeper: {
      recentSamples: sweeperRing.length,
      avgDurationMs: avgSweepDuration,
      totalMtimeRaceSkips: counters.sweeperMtimeRaceSkips,
    },
    recentErrors: errorRing.slice(-20).map((e) => ({
      reason: e.reason,
      message: e.message,
      at: new Date(e.at).toISOString(),
    })),
  };
}

// Test-only.
export function _resetMemoryTelemetryForTests(): void {
  for (const k of Object.keys(counters) as (keyof typeof counters)[]) {
    const v = counters[k];
    if (typeof v === "number") (counters[k] as any) = 0;
    else for (const r of Object.keys(v)) (v as any)[r] = 0;
  }
  extractorRing.length = 0;
  injectionRing.length = 0;
  sweeperRing.length = 0;
  errorRing.length = 0;
}
