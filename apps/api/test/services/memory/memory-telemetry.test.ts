/**
 * Memory telemetry snapshot — P2-#8 (2026-05-15).
 */
import { beforeEach, expect, test } from "bun:test";
import {
  _resetMemoryTelemetryForTests,
  recordExtractorRun,
  recordExtractorError,
  recordExtractorCoalesced,
  recordInjection,
  recordSweeper,
  recordAuthReject,
  snapshotMemoryTelemetry,
} from "../../../src/services/memory/memory-telemetry";

beforeEach(() => {
  _resetMemoryTelemetryForTests();
});

test("snapshot returns empty/zero state on fresh counters", () => {
  const snap = snapshotMemoryTelemetry();
  expect(snap.counters.extractorRuns.pre_compact).toBe(0);
  expect(snap.extractor.recentSamples).toBe(0);
  expect(snap.extractor.latencyMsP50).toBeNull();
  expect(snap.injection.recentSamples).toBe(0);
  expect(snap.sweeper.recentSamples).toBe(0);
});

test("recordExtractorRun updates counters and yields percentiles", () => {
  for (let i = 1; i <= 10; i++) {
    recordExtractorRun({
      reason: "pre_compact",
      durationMs: i * 100,
      applied: 2,
      skipped: 1,
      parsed: 3,
      errorCount: 0,
    });
  }
  const snap = snapshotMemoryTelemetry();
  expect(snap.counters.extractorRuns.pre_compact).toBe(10);
  expect(snap.counters.extractorApplied.pre_compact).toBe(20);
  expect(snap.counters.extractorSkipped.pre_compact).toBe(10);
  expect(snap.extractor.latencyMsP50).toBe(600); // 6th of 10 sorted
  expect(snap.extractor.appliedRate).toBeCloseTo(20 / 30);
  expect(snap.extractor.errorRate).toBe(0);
});

test("recordExtractorError populates recentErrors ring", () => {
  recordExtractorError("amem_link", "boom");
  const snap = snapshotMemoryTelemetry();
  expect(snap.recentErrors.length).toBe(1);
  expect(snap.recentErrors[0]!.reason).toBe("amem_link");
  expect(snap.recentErrors[0]!.message).toBe("boom");
});

test("recordInjection tracks truncation rate", () => {
  recordInjection(100, false);
  recordInjection(100, true);
  recordInjection(100, true);
  const snap = snapshotMemoryTelemetry();
  expect(snap.counters.injectionRenders).toBe(3);
  expect(snap.counters.injectionTruncations).toBe(2);
  expect(snap.injection.truncationRate).toBeCloseTo(2 / 3);
});

test("recordSweeper accumulates mtime-race skips", () => {
  recordSweeper({
    durationMs: 5,
    updated: 3,
    refsRepaired: 0,
    mtimeRaceSkips: 2,
  });
  recordSweeper({
    durationMs: 7,
    updated: 1,
    refsRepaired: 1,
    mtimeRaceSkips: 1,
  });
  const snap = snapshotMemoryTelemetry();
  expect(snap.counters.sweeperTicks).toBe(2);
  expect(snap.counters.sweeperMtimeRaceSkips).toBe(3);
  expect(snap.sweeper.avgDurationMs).toBe(6);
});

test("recordAuthReject increments the auth-reject counter", () => {
  recordAuthReject();
  recordAuthReject();
  expect(snapshotMemoryTelemetry().counters.authRejects).toBe(2);
});

test("recordExtractorCoalesced increments the coalesced counter", () => {
  recordExtractorCoalesced("pre_compact");
  expect(snapshotMemoryTelemetry().counters.extractorCoalesced.pre_compact).toBe(1);
});
