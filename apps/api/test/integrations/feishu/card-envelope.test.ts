import { expect, test } from "bun:test";
import {
  buildEnvelope,
  decodeEnvelope,
  FEISHU_CARD_ENVELOPE_VERSION,
  newIdempotencyKey,
} from "../../../src/integrations/feishu/card-envelope";

const SECRET = "test-secret-do-not-use-in-prod";

test("buildEnvelope sets oc version + sig", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "approval-1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  expect(env.oc).toBe(FEISHU_CARD_ENVELOPE_VERSION);
  expect(env.k).toBe("button");
  expect(env.a).toBe("approval.approve");
  expect(typeof env.sig).toBe("string");
  expect(env.sig!.length).toBe(64); // sha256 hex
});

test("roundtrip: built envelope decodes as structured", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "approval-1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: { operatorOpenId: "u1", eventChatId: "h1", secret: SECRET },
  });
  expect(decoded.kind).toBe("structured");
  if (decoded.kind === "structured") {
    expect(decoded.envelope.a).toBe("approval.approve");
  }
});

test("expired envelope returns stale", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() - 1, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: { operatorOpenId: "u1", eventChatId: "h1", secret: SECRET },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("stale");
});

test("wrong user returns wrong_user", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: { operatorOpenId: "u2-different", eventChatId: "h1", secret: SECRET },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("wrong_user");
});

test("skipUserCheck bypasses user mismatch (single-operator mode)", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: {
      operatorOpenId: "u2-different",
      eventChatId: "h1",
      secret: SECRET,
      skipUserCheck: true,
    },
  });
  expect(decoded.kind).toBe("structured");
});

test("wrong chat returns wrong_conversation", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: { operatorOpenId: "u1", eventChatId: "h2-different", secret: SECRET },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("wrong_conversation");
});

test("tampered sig returns bad_signature", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  // Flip one bit in the sig
  const tampered = {
    ...env,
    sig: env.sig!.slice(0, -2) + (env.sig!.endsWith("00") ? "01" : "00"),
  };
  const decoded = decodeEnvelope({
    value: tampered,
    context: { operatorOpenId: "u1", eventChatId: "h1", secret: SECRET },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("bad_signature");
});

test("wrong secret returns bad_signature", () => {
  const env = buildEnvelope({
    kind: "button",
    action: "approval.approve",
    context: { u: "u1", h: "h1", s: "a1", e: Date.now() + 60_000, t: "p2p" },
    secret: SECRET,
  });
  const decoded = decodeEnvelope({
    value: env,
    context: { operatorOpenId: "u1", eventChatId: "h1", secret: "different-secret" },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("bad_signature");
});

test("non-versioned payload returns legacy", () => {
  const decoded = decodeEnvelope({
    value: { command: "approve" },
    context: { secret: SECRET },
  });
  expect(decoded.kind).toBe("legacy");
});

test("malformed structured payload returns malformed", () => {
  const decoded = decodeEnvelope({
    value: { oc: FEISHU_CARD_ENVELOPE_VERSION, k: "invalid_kind", a: "approve", sig: "x" },
    context: { secret: SECRET },
  });
  expect(decoded.kind).toBe("invalid");
  if (decoded.kind === "invalid") expect(decoded.reason).toBe("malformed");
});

test("newIdempotencyKey is unique enough", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  expect(a).not.toBe(b);
  expect(a.startsWith("magister-")).toBe(true);
});
