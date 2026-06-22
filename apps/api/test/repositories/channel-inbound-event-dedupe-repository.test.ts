/**
 * ChannelInboundEventDedupeRepository — atomic dedupe tests (DP2).
 *
 * Verifies:
 *   - A new key is claimed (acquired: true).
 *   - A completed key returns duplicate_completed.
 *   - A processing key with a live lease returns duplicate_inflight.
 *   - An expired-lease processing row is refreshed and re-claimed.
 *   - Two concurrent "inserts" of the same fresh key — exactly one sees
 *     acquired:true and the other sees duplicate_inflight (DP2 atomicity).
 *
 * Isolation: each test gets a fresh temp SQLite via MAGISTER_DB_PATH.
 * No mock.module — uses the real repository against an in-process DB.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "inbound-dedupe-repo-test-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("claimProcessingKeys: new key → acquired:true", async () => {
  const { ChannelInboundEventDedupeRepository } = await import(
    "../../src/repositories/channel-inbound-event-dedupe-repository"
  );
  const repo = new ChannelInboundEventDedupeRepository();
  const result = await repo.claimProcessingKeys({
    bindingId: "binding_1",
    dedupeKeys: ["key_new"],
  });
  expect(result.acquired).toBe(true);
});

test("claimProcessingKeys: completed key → duplicate_completed", async () => {
  const { ChannelInboundEventDedupeRepository } = await import(
    "../../src/repositories/channel-inbound-event-dedupe-repository"
  );
  const repo = new ChannelInboundEventDedupeRepository();
  // Claim and immediately complete.
  const first = await repo.claimProcessingKeys({
    bindingId: "binding_2",
    dedupeKeys: ["key_completed"],
  });
  expect(first.acquired).toBe(true);
  await repo.markProcessingKeysCompleted({
    bindingId: "binding_2",
    dedupeKeys: ["key_completed"],
  });
  // Second claim must be rejected.
  const second = await repo.claimProcessingKeys({
    bindingId: "binding_2",
    dedupeKeys: ["key_completed"],
  });
  expect(second.acquired).toBe(false);
  if (!second.acquired) {
    expect(second.reason).toBe("duplicate_completed");
    expect(second.duplicateKey).toBe("key_completed");
  }
});

test("claimProcessingKeys: inflight key with live lease → duplicate_inflight", async () => {
  const { ChannelInboundEventDedupeRepository } = await import(
    "../../src/repositories/channel-inbound-event-dedupe-repository"
  );
  const repo = new ChannelInboundEventDedupeRepository();
  const now = new Date();
  // First claim with a 10-minute lease.
  const first = await repo.claimProcessingKeys({
    bindingId: "binding_3",
    dedupeKeys: ["key_inflight"],
    occurredAt: now,
    leaseMs: 10 * 60 * 1000,
  });
  expect(first.acquired).toBe(true);
  // Second claim at the same time — lease is still live.
  const second = await repo.claimProcessingKeys({
    bindingId: "binding_3",
    dedupeKeys: ["key_inflight"],
    occurredAt: now,
  });
  expect(second.acquired).toBe(false);
  if (!second.acquired) {
    expect(second.reason).toBe("duplicate_inflight");
  }
});

test("claimProcessingKeys: expired-lease row is refreshed and re-claimed", async () => {
  const { ChannelInboundEventDedupeRepository } = await import(
    "../../src/repositories/channel-inbound-event-dedupe-repository"
  );
  const repo = new ChannelInboundEventDedupeRepository();
  const past = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
  // Claim with a 1 ms lease in the past — lease is already expired.
  const first = await repo.claimProcessingKeys({
    bindingId: "binding_4",
    dedupeKeys: ["key_expired"],
    occurredAt: past,
    leaseMs: 1,
  });
  expect(first.acquired).toBe(true);
  // Second claim now — lease expired, should succeed.
  const second = await repo.claimProcessingKeys({
    bindingId: "binding_4",
    dedupeKeys: ["key_expired"],
  });
  expect(second.acquired).toBe(true);
});

test("DP2: two concurrent inserts of same fresh key → exactly one acquired, one duplicate_inflight", async () => {
  // This is the core DP2 atomicity test: without INSERT OR IGNORE the
  // old SELECT-then-INSERT could let both concurrent callers see "no row"
  // and both proceed to insert, leaving a duplicate or silent data loss.
  // With INSERT OR IGNORE, exactly one insert wins (changes=1) and the
  // other sees the existing row (changes=0) → duplicate_inflight.
  const { ChannelInboundEventDedupeRepository } = await import(
    "../../src/repositories/channel-inbound-event-dedupe-repository"
  );
  const repo = new ChannelInboundEventDedupeRepository();
  // Run both claims truly concurrently (both in-flight before either commits).
  const [r1, r2] = await Promise.all([
    repo.claimProcessingKeys({ bindingId: "binding_5", dedupeKeys: ["key_concurrent"] }),
    repo.claimProcessingKeys({ bindingId: "binding_5", dedupeKeys: ["key_concurrent"] }),
  ]);
  const acquiredCount = [r1, r2].filter((r) => r.acquired).length;
  const duplicateCount = [r1, r2].filter((r) => !r.acquired).length;
  // Exactly one must win, one must lose.
  expect(acquiredCount).toBe(1);
  expect(duplicateCount).toBe(1);
  // The loser must be duplicate_inflight (not duplicate_completed — the
  // winner hasn't called markProcessingKeysCompleted yet).
  const loser = [r1, r2].find((r) => !r.acquired);
  if (loser && !loser.acquired) {
    expect(loser.reason).toBe("duplicate_inflight");
  }
});
