import { createSqliteClient, ensureDatabaseInitialized } from "@magister/db";

const DEFAULT_OUTBOUND_CLAIM_LEASE_MS = 5 * 60 * 1000;

// How often the server's reaper loop runs.
export const OUTBOUND_CLAIM_REAPER_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

type OutboundClaimResult =
  | {
      acquired: true;
      claimToken: string;
    }
  | {
      acquired: false;
      reason: "already_finalized" | "inflight";
    };

export class ChannelOutboundDeliveryClaimRepository {
  async acquireClaim(input: {
    outboundEventId: string;
    occurredAt?: Date;
    leaseMs?: number;
  }): Promise<OutboundClaimResult> {
    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    const nowMs = (input.occurredAt ?? new Date()).getTime();
    const leaseMs = input.leaseMs ?? DEFAULT_OUTBOUND_CLAIM_LEASE_MS;
    const claimToken = `claim_${crypto.randomUUID()}`;
    let committed = false;

    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const row = sqlite
        .prepare(
          "select state, claim_token, claimed_at from channel_outbound_delivery_locks where outbound_event_id = ? limit 1",
        )
        .get(input.outboundEventId) as
        | {
            state?: string;
            claim_token?: string | null;
            claimed_at?: number | null;
          }
        | undefined;

      if (row?.state === "delivered" || row?.state === "failed") {
        sqlite.exec("ROLLBACK");
        return {
          acquired: false,
          reason: "already_finalized",
        };
      }

      const claimedAt = typeof row?.claimed_at === "number" ? row.claimed_at : 0;
      if (row?.state === "claimed" && claimedAt + Math.max(leaseMs, 1) > nowMs) {
        sqlite.exec("ROLLBACK");
        return {
          acquired: false,
          reason: "inflight",
        };
      }

      if (row) {
        sqlite
          .prepare(
            "update channel_outbound_delivery_locks set state = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ? where outbound_event_id = ?",
          )
          .run(claimToken, nowMs, nowMs, input.outboundEventId);
      } else {
        sqlite
          .prepare(
            "insert into channel_outbound_delivery_locks (outbound_event_id, state, claim_token, claimed_at, updated_at) values (?, 'claimed', ?, ?, ?)",
          )
          .run(input.outboundEventId, claimToken, nowMs, nowMs);
      }

      sqlite.exec("COMMIT");
      committed = true;
      return {
        acquired: true,
        claimToken,
      };
    } catch (error) {
      if (!committed) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          // Best effort rollback.
        }
      }
      throw error;
    } finally {
      sqlite.close();
    }
  }

  /**
   * Release any 'claimed' rows whose lease has expired (i.e. the process
   * that acquired them crashed before calling finalizeClaim). Resets them
   * to state='unclaimed' so the next delivery poll can re-acquire them.
   *
   * Mirror of the release semantics in finalizeClaim: clears claim_token
   * and claimed_at, bumps updated_at. Returns the number of rows reaped.
   *
   * Wire via a periodic setInterval in server.ts so crashed-process locks
   * don't produce permanent silent message loss.
   */
  async reapExpiredClaims(nowMs: number): Promise<number> {
    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    try {
      const result = sqlite
        .prepare(
          `update channel_outbound_delivery_locks
             set state = 'unclaimed', claim_token = null, claimed_at = null, updated_at = ?
           where state = 'claimed'
             and (claimed_at + ?) <= ?`,
        )
        .run(nowMs, DEFAULT_OUTBOUND_CLAIM_LEASE_MS, nowMs);
      return result.changes;
    } finally {
      sqlite.close();
    }
  }

  async finalizeClaim(input: {
    outboundEventId: string;
    claimToken: string;
    state: "delivered" | "failed";
    occurredAt?: Date;
  }) {
    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    const nowMs = (input.occurredAt ?? new Date()).getTime();
    let committed = false;

    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const result = sqlite
        .prepare(
          "update channel_outbound_delivery_locks set state = ?, claim_token = null, claimed_at = null, updated_at = ? where outbound_event_id = ? and claim_token = ?",
        )
        .run(input.state, nowMs, input.outboundEventId, input.claimToken);
      sqlite.exec("COMMIT");
      committed = true;
      return result.changes > 0;
    } finally {
      if (!committed) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          // Best effort rollback.
        }
      }
      sqlite.close();
    }
  }
}
