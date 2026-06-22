/**
 * ChannelOutboundDeliveryClaimRepository — lease expiry and reaper tests.
 *
 * Covers:
 *   - acquireClaim succeeds when a prior lease is expired (lease steal)
 *   - acquireClaim fails (inflight) when a live lease is held
 *   - reapExpiredClaims releases expired-but-claimed rows
 *   - reapExpiredClaims leaves live-claimed rows untouched
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "outbound-claim-repo-test-"));
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

test("acquireClaim returns acquired=true when no prior lock exists", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const result = await repo.acquireClaim({
    outboundEventId: "event_new_1",
  });
  expect(result.acquired).toBe(true);
  if (result.acquired) {
    expect(result.claimToken).toMatch(/^claim_/);
  }
});

test("acquireClaim returns inflight when a live lease is held", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const leaseMs = 5 * 60 * 1000; // 5 minutes (default)
  const claimedAt = Date.now();

  // First acquisition succeeds.
  const first = await repo.acquireClaim({
    outboundEventId: "event_live_lease_1",
    occurredAt: new Date(claimedAt),
    leaseMs,
  });
  expect(first.acquired).toBe(true);

  // Second attempt while lease is still live — should be refused.
  const nowBeforeExpiry = claimedAt + leaseMs - 1000; // 1 second before expiry
  const second = await repo.acquireClaim({
    outboundEventId: "event_live_lease_1",
    occurredAt: new Date(nowBeforeExpiry),
    leaseMs,
  });
  expect(second.acquired).toBe(false);
  if (!second.acquired) {
    expect(second.reason).toBe("inflight");
  }
});

test("acquireClaim steals an expired lease (crash-recovery path)", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const leaseMs = 5 * 60 * 1000; // 5 minutes
  const claimedAt = Date.now() - leaseMs - 1000; // expired 1 second ago

  // Simulate an expired stale claim by acquiring at a time in the past.
  const stale = await repo.acquireClaim({
    outboundEventId: "event_expired_lease_1",
    occurredAt: new Date(claimedAt),
    leaseMs,
  });
  expect(stale.acquired).toBe(true);

  // Now attempt to re-acquire after the lease has expired.
  const nowAfterExpiry = claimedAt + leaseMs + 1000;
  const fresh = await repo.acquireClaim({
    outboundEventId: "event_expired_lease_1",
    occurredAt: new Date(nowAfterExpiry),
    leaseMs,
  });
  expect(fresh.acquired).toBe(true);
  // The new claim token must differ from the stale one.
  if (fresh.acquired && stale.acquired) {
    expect(fresh.claimToken).not.toBe(stale.claimToken);
  }
});

test("reapExpiredClaims releases expired claimed rows but not live ones", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const leaseMs = 5 * 60 * 1000;
  const now = Date.now();
  const expiredClaimedAt = now - leaseMs - 1000; // expired
  const liveClaimedAt = now - 1000; // live (only 1s old)

  // Seed an expired claim.
  const expiredClaim = await repo.acquireClaim({
    outboundEventId: "event_reap_expired_1",
    occurredAt: new Date(expiredClaimedAt),
    leaseMs,
  });
  expect(expiredClaim.acquired).toBe(true);

  // Seed a live claim.
  const liveClaim = await repo.acquireClaim({
    outboundEventId: "event_reap_live_1",
    occurredAt: new Date(liveClaimedAt),
    leaseMs,
  });
  expect(liveClaim.acquired).toBe(true);

  // Reap at current time — only the expired row should be released.
  const reaped = await repo.reapExpiredClaims(now);
  expect(reaped).toBe(1);

  // Verify: the expired event is now re-claimable.
  const reClaim = await repo.acquireClaim({
    outboundEventId: "event_reap_expired_1",
    occurredAt: new Date(now),
    leaseMs,
  });
  expect(reClaim.acquired).toBe(true);

  // Verify: the live event is still locked (inflight).
  const liveCheck = await repo.acquireClaim({
    outboundEventId: "event_reap_live_1",
    occurredAt: new Date(now),
    leaseMs,
  });
  expect(liveCheck.acquired).toBe(false);
  if (!liveCheck.acquired) {
    expect(liveCheck.reason).toBe("inflight");
  }
});

test("reapExpiredClaims returns 0 when no expired claims exist", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const reaped = await repo.reapExpiredClaims(Date.now());
  expect(reaped).toBe(0);
});

test("reapExpiredClaims does not release rows in delivered or failed state", async () => {
  const { ChannelOutboundDeliveryClaimRepository } = await import(
    "../../src/repositories/channel-outbound-delivery-claim-repository"
  );
  const repo = new ChannelOutboundDeliveryClaimRepository();
  const leaseMs = 5 * 60 * 1000;
  const expiredClaimedAt = Date.now() - leaseMs - 1000;

  // Acquire and immediately finalize as delivered.
  const claim = await repo.acquireClaim({
    outboundEventId: "event_reap_delivered_1",
    occurredAt: new Date(expiredClaimedAt),
    leaseMs,
  });
  expect(claim.acquired).toBe(true);
  if (claim.acquired) {
    await repo.finalizeClaim({
      outboundEventId: "event_reap_delivered_1",
      claimToken: claim.claimToken,
      state: "delivered",
    });
  }

  // Reaper should leave delivered rows untouched.
  const reaped = await repo.reapExpiredClaims(Date.now());
  expect(reaped).toBe(0);

  // Confirm the event is still flagged as already_finalized.
  const retry = await repo.acquireClaim({
    outboundEventId: "event_reap_delivered_1",
  });
  expect(retry.acquired).toBe(false);
  if (!retry.acquired) {
    expect(retry.reason).toBe("already_finalized");
  }
});
