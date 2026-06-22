import { createSqliteClient, ensureDatabaseInitialized } from "@magister/db";

const DEFAULT_INBOUND_PROCESSING_LEASE_MS = 2 * 60 * 1000;

type InboundClaimResult =
  | {
      acquired: true;
    }
  | {
      acquired: false;
      reason: "duplicate_completed" | "duplicate_inflight";
      duplicateKey: string;
    };

export class ChannelInboundEventDedupeRepository {
  async claimProcessingKeys(input: {
    bindingId: string;
    dedupeKeys: string[];
    occurredAt?: Date;
    leaseMs?: number;
  }): Promise<InboundClaimResult> {
    const normalizedKeys = [...new Set(input.dedupeKeys.map((key) => key.trim()).filter(Boolean))];
    if (normalizedKeys.length === 0) {
      return {
        acquired: true,
      };
    }

    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    const nowMs = (input.occurredAt ?? new Date()).getTime();
    const leaseMs = input.leaseMs ?? DEFAULT_INBOUND_PROCESSING_LEASE_MS;
    const leaseExpiresAt = nowMs + Math.max(leaseMs, 1);
    let committed = false;

    try {
      sqlite.exec("BEGIN IMMEDIATE");

      // DP2: Make the new-row path atomic via INSERT OR IGNORE.
      // The primary key (binding_id, dedupe_key) makes the insert a no-op
      // when a row already exists. `changes === 1` means we own a fresh row;
      // `changes === 0` means the row pre-existed and we need to inspect it.
      // This eliminates the SELECT-then-INSERT TOCTOU window — the INSERT
      // itself is the atomic check-and-claim operation.
      const insertIgnoreRow = sqlite.prepare(
        "insert or ignore into channel_inbound_event_keys (binding_id, dedupe_key, status, first_seen_at, lease_expires_at, updated_at) values (?, ?, 'processing', ?, ?, ?)",
      );
      const readRow = sqlite.prepare(
        "select status, lease_expires_at from channel_inbound_event_keys where binding_id = ? and dedupe_key = ? limit 1",
      );
      const updateRow = sqlite.prepare(
        "update channel_inbound_event_keys set status = 'processing', lease_expires_at = ?, updated_at = ? where binding_id = ? and dedupe_key = ?",
      );

      for (const key of normalizedKeys) {
        const info = insertIgnoreRow.run(input.bindingId, key, nowMs, leaseExpiresAt, nowMs) as {
          changes: number;
        };

        if (info.changes === 1) {
          // Fresh row — we claimed it atomically; nothing more to do for this key.
          continue;
        }

        // Row already existed — inspect state to decide duplicate vs expired-lease refresh.
        const row = readRow.get(input.bindingId, key) as
          | { status?: string; lease_expires_at?: number | null }
          | undefined;

        if (row?.status === "completed") {
          sqlite.exec("ROLLBACK");
          return {
            acquired: false,
            reason: "duplicate_completed",
            duplicateKey: key,
          };
        }

        const lease = typeof row?.lease_expires_at === "number" ? row.lease_expires_at : 0;
        if (row?.status === "processing" && lease > nowMs) {
          sqlite.exec("ROLLBACK");
          return {
            acquired: false,
            reason: "duplicate_inflight",
            duplicateKey: key,
          };
        }

        // Expired-lease row — refresh the lease so this caller owns it.
        updateRow.run(leaseExpiresAt, nowMs, input.bindingId, key);
      }

      sqlite.exec("COMMIT");
      committed = true;
      return {
        acquired: true,
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

  async markProcessingKeysCompleted(input: {
    bindingId: string;
    dedupeKeys: string[];
    occurredAt?: Date;
  }) {
    const normalizedKeys = [...new Set(input.dedupeKeys.map((key) => key.trim()).filter(Boolean))];
    if (normalizedKeys.length === 0) {
      return;
    }

    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    const nowMs = (input.occurredAt ?? new Date()).getTime();
    let committed = false;

    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const updateRow = sqlite.prepare(
        "update channel_inbound_event_keys set status = 'completed', lease_expires_at = null, updated_at = ? where binding_id = ? and dedupe_key = ? and status = 'processing'",
      );

      for (const key of normalizedKeys) {
        updateRow.run(nowMs, input.bindingId, key);
      }

      sqlite.exec("COMMIT");
      committed = true;
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

  async releaseProcessingKeys(input: {
    bindingId: string;
    dedupeKeys: string[];
    occurredAt?: Date;
  }) {
    const normalizedKeys = [...new Set(input.dedupeKeys.map((key) => key.trim()).filter(Boolean))];
    if (normalizedKeys.length === 0) {
      return;
    }

    const sqlite = createSqliteClient();
    ensureDatabaseInitialized(sqlite);
    const nowMs = (input.occurredAt ?? new Date()).getTime();
    let committed = false;

    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const releaseRow = sqlite.prepare(
        "update channel_inbound_event_keys set lease_expires_at = ?, updated_at = ? where binding_id = ? and dedupe_key = ? and status = 'processing'",
      );

      for (const key of normalizedKeys) {
        releaseRow.run(nowMs - 1, nowMs, input.bindingId, key);
      }

      sqlite.exec("COMMIT");
      committed = true;
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
