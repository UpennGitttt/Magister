import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Versioned, signed card action envelope.
 *
 * Replaces the older `feishu-approval-card.ts` HMAC-token scheme,
 * which signed only `(approvalId, bindingId, resolution, expiresAt)`
 * — enough for replay protection but missing chat/user context, which
 * means a leaked token could be redeemed from any chat by any user
 * with knowledge of the structure.
 *
 * Adds a `sig` field carrying an HMAC over
 * `(kind, action, context)` so a stolen card-action JSON can't be
 * replayed after the operator's secret rotates.
 *
 * Envelope shape:
 *   {
 *     oc:  "ocf1"                    // protocol version
 *     k:   "button" | "quick" | "meta"
 *     a:   "approval.approve" | ...  // action name
 *     q?:  "quoted text"             // optional, surfaces on click
 *     m?:  { ... }                   // optional metadata
 *     c?:  {                         // context
 *       u: "<open_id>"               // expected clicker
 *       h: "<chat_id>"               // expected chat
 *       s: "<approval-id or task-id>"
 *       e: <expiry epoch ms>
 *       t: "p2p" | "group"
 *     }
 *     sig: "<hmac-sha256 hex>"       // signed over kind+action+context
 *   }
 *
 * On click, the Feishu gateway forwards `action.value` (the parsed
 * envelope) plus the operator's open_id and the chat_id. `decode()`
 * validates:
 *   1. `oc === "ocf1"`              — accept versioned envelopes only
 *   2. `e > now`                    — not expired
 *   3. `u === operator.open_id`     — same user
 *      (skipped in Magister single-operator mode — Q5 answer)
 *   4. `h === context.chat_id`      — same chat
 *   5. `sig` matches recomputed HMAC
 *
 * The four failures get distinct reasons (`malformed | stale |
 * wrong_user | wrong_conversation | bad_signature`) so the gateway
 * can show a clear toast to the user instead of a generic "rejected".
 */

export const FEISHU_CARD_ENVELOPE_VERSION = "ocf1";

export type FeishuCardEnvelopeKind = "button" | "quick" | "meta";

export type FeishuCardEnvelopeReason =
  | "malformed"
  | "stale"
  | "wrong_user"
  | "wrong_conversation"
  | "bad_signature";

export type FeishuCardEnvelopeContext = {
  u?: string;
  h?: string;
  s?: string;
  e?: number;
  t?: "p2p" | "group";
};

export type FeishuCardEnvelopeMetadata = Record<
  string,
  string | number | boolean | null | undefined
>;

export type FeishuCardEnvelope = {
  oc: typeof FEISHU_CARD_ENVELOPE_VERSION;
  k: FeishuCardEnvelopeKind;
  a: string;
  q?: string;
  m?: FeishuCardEnvelopeMetadata;
  c?: FeishuCardEnvelopeContext;
  sig?: string;
};

export type DecodedFeishuCardEnvelope =
  | { kind: "structured"; envelope: FeishuCardEnvelope }
  | { kind: "legacy"; text: string }
  | { kind: "invalid"; reason: FeishuCardEnvelopeReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetadataValue(value: unknown): value is string | number | boolean | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Build the canonical string used for signing. Stable key order so
 * sign + verify produce identical bytes on both sides. Excludes the
 * `sig` field itself (obvious circular dep) and `oc` (protocol-level,
 * not security-relevant).
 */
function canonicalize(envelope: Omit<FeishuCardEnvelope, "oc" | "sig">): string {
  const parts: string[] = [];
  parts.push(`k=${envelope.k}`);
  parts.push(`a=${envelope.a}`);
  if (envelope.q !== undefined) parts.push(`q=${envelope.q}`);
  if (envelope.m !== undefined) {
    // Sort metadata keys for deterministic signing
    const keys = Object.keys(envelope.m).sort();
    for (const key of keys) {
      parts.push(`m.${key}=${String(envelope.m[key])}`);
    }
  }
  if (envelope.c !== undefined) {
    if (envelope.c.u !== undefined) parts.push(`c.u=${envelope.c.u}`);
    if (envelope.c.h !== undefined) parts.push(`c.h=${envelope.c.h}`);
    if (envelope.c.s !== undefined) parts.push(`c.s=${envelope.c.s}`);
    if (envelope.c.e !== undefined) parts.push(`c.e=${envelope.c.e}`);
    if (envelope.c.t !== undefined) parts.push(`c.t=${envelope.c.t}`);
  }
  return parts.join("\n");
}

function signEnvelope(input: {
  envelope: Omit<FeishuCardEnvelope, "oc" | "sig">;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(canonicalize(input.envelope))
    .digest("hex");
}

/**
 * Build a card-action envelope ready to embed as a button's `value`
 * field. Caller provides everything except `oc` (auto-set) and
 * `sig` (computed here).
 *
 * `expiresAt`: callers usually compute as `Date.now() + ttlMs`. The
 * spec defaults to 5 min for approvals and 30 min for non-destructive
 * cards — the envelope itself doesn't care, just refuses stale ones
 * at decode time.
 */
export function buildEnvelope(input: {
  kind: FeishuCardEnvelopeKind;
  action: string;
  context?: FeishuCardEnvelopeContext;
  metadata?: FeishuCardEnvelopeMetadata;
  quoted?: string;
  secret: string;
}): FeishuCardEnvelope {
  const base: Omit<FeishuCardEnvelope, "oc" | "sig"> = {
    k: input.kind,
    a: input.action,
    ...(input.quoted !== undefined ? { q: input.quoted } : {}),
    ...(input.metadata !== undefined ? { m: input.metadata } : {}),
    ...(input.context !== undefined ? { c: input.context } : {}),
  };
  const sig = signEnvelope({ envelope: base, secret: input.secret });
  return {
    oc: FEISHU_CARD_ENVELOPE_VERSION,
    ...base,
    sig,
  };
}

export type DecodeContext = {
  /**
   * The clicker's open_id from the Feishu event. Used for the
   * `wrong_user` check.
   */
  operatorOpenId?: string;
  /**
   * The chat_id from the event context. Used for the
   * `wrong_conversation` check.
   */
  eventChatId?: string;
  /**
   * Secret used to verify `sig`. Same secret used when building.
   */
  secret: string;
  /**
   * Override `now` for deterministic testing. Defaults to `Date.now()`.
   */
  now?: number;
  /**
   * In single-operator mode (Q5), skip user_id match — any operator
   * can click any card. Default false (strict mode).
   */
  skipUserCheck?: boolean;
};

/**
 * Validate + parse a card-action payload received from Feishu.
 *
 * Three outcomes:
 *   - `structured`: valid versioned envelope → caller dispatches on
 *     `envelope.a` (action name)
 *   - `legacy`: not our format → caller falls back to text command
 *     parsing (e.g. plain message dispatch). Mostly for back-compat
 *     during the migration window.
 *   - `invalid`: format detected but failed validation. `reason`
 *     pinpoints why so the gateway can surface a clear error.
 */
export function decodeEnvelope(input: {
  value: unknown;
  context: DecodeContext;
}): DecodedFeishuCardEnvelope {
  const { value, context } = input;
  const now = context.now ?? Date.now();

  if (!isRecord(value) || value.oc !== FEISHU_CARD_ENVELOPE_VERSION) {
    return {
      kind: "legacy",
      text: isRecord(value) && typeof value.text === "string" ? value.text : String(value),
    };
  }

  if (
    (value.k !== "button" && value.k !== "quick" && value.k !== "meta") ||
    typeof value.a !== "string" ||
    !value.a
  ) {
    return { kind: "invalid", reason: "malformed" };
  }

  if (value.q !== undefined && typeof value.q !== "string") {
    return { kind: "invalid", reason: "malformed" };
  }

  if (value.m !== undefined) {
    if (!isRecord(value.m)) return { kind: "invalid", reason: "malformed" };
    for (const v of Object.values(value.m)) {
      if (!isMetadataValue(v)) return { kind: "invalid", reason: "malformed" };
    }
  }

  if (value.c !== undefined) {
    if (!isRecord(value.c)) return { kind: "invalid", reason: "malformed" };
    const c = value.c as FeishuCardEnvelopeContext;
    if (c.u !== undefined && typeof c.u !== "string") return { kind: "invalid", reason: "malformed" };
    if (c.h !== undefined && typeof c.h !== "string") return { kind: "invalid", reason: "malformed" };
    if (c.s !== undefined && typeof c.s !== "string") return { kind: "invalid", reason: "malformed" };
    if (c.e !== undefined && !Number.isFinite(c.e)) return { kind: "invalid", reason: "malformed" };
    if (c.t !== undefined && c.t !== "p2p" && c.t !== "group") {
      return { kind: "invalid", reason: "malformed" };
    }

    if (typeof c.e === "number" && c.e < now) {
      return { kind: "invalid", reason: "stale" };
    }

    if (!context.skipUserCheck && c.u && context.operatorOpenId) {
      if (c.u.trim() !== context.operatorOpenId.trim()) {
        return { kind: "invalid", reason: "wrong_user" };
      }
    }

    if (c.h && context.eventChatId) {
      if (c.h.trim() !== context.eventChatId.trim()) {
        return { kind: "invalid", reason: "wrong_conversation" };
      }
    }
  }

  // Verify HMAC last so format/context checks short-circuit obviously
  // bad payloads without spending crypto cycles.
  if (typeof value.sig !== "string") {
    return { kind: "invalid", reason: "bad_signature" };
  }
  const { sig: _drop, oc: _oc, ...rest } = value as FeishuCardEnvelope;
  const expected = signEnvelope({
    envelope: rest as Omit<FeishuCardEnvelope, "oc" | "sig">,
    secret: context.secret,
  });
  const actualBuf = Buffer.from(value.sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  // `timingSafeEqual` throws on length mismatch — guard explicitly
  // so a tampered short sig doesn't crash the gateway.
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return { kind: "invalid", reason: "bad_signature" };
  }

  return {
    kind: "structured",
    envelope: {
      oc: FEISHU_CARD_ENVELOPE_VERSION,
      k: value.k as FeishuCardEnvelopeKind,
      a: value.a,
      ...(value.q !== undefined ? { q: value.q as string } : {}),
      ...(value.m !== undefined ? { m: value.m as FeishuCardEnvelopeMetadata } : {}),
      ...(value.c !== undefined ? { c: value.c as FeishuCardEnvelopeContext } : {}),
      sig: value.sig,
    },
  };
}

/**
 * Convenience: extract a fresh idempotency key for a card-create.
 * Used by `streaming-card.ts` to make `POST /cardkit/v1/cards`
 * retry-safe — same `idempotency_key` returns the same card_id.
 */
export function newIdempotencyKey(): string {
  return `magister-${randomUUID()}`;
}
