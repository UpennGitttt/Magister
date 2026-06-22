import { createHmac, timingSafeEqual } from "node:crypto";

import type { FeishuConfig } from "./feishu-config";

export type FeishuSignatureHeaders = {
  timestamp?: string;
  nonce?: string;
  signature?: string;
};

type VerifyFeishuSignatureInput = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  config: Pick<FeishuConfig, "verificationToken">;
};

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
) {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function serializeSignedPayload(payload: unknown) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

export function buildFeishuRequestSignature(input: {
  timestamp: string;
  nonce: string;
  verificationToken: string;
  rawBody: string;
}) {
  return createHmac("sha256", input.verificationToken)
    .update(`${input.timestamp}:${input.nonce}:${input.rawBody}`)
    .digest("hex");
}

export function getFeishuSignatureHeaders(
  headers: Record<string, string | string[] | undefined>,
): FeishuSignatureHeaders {
  const timestamp = getHeaderValue(headers, "x-feishu-request-timestamp");
  const nonce = getHeaderValue(headers, "x-feishu-request-nonce");
  const signature = getHeaderValue(headers, "x-feishu-signature");

  return {
    ...(timestamp ? { timestamp } : {}),
    ...(nonce ? { nonce } : {}),
    ...(signature ? { signature } : {}),
  };
}

export function verifyFeishuSignature(input: VerifyFeishuSignatureInput) {
  const { timestamp, nonce, signature } = getFeishuSignatureHeaders(input.headers);

  if (!timestamp || !nonce || !signature || !input.config.verificationToken) {
    return {
      ok: false as const,
      reason: "missing_headers" as const,
    };
  }

  const expectedSignature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: input.config.verificationToken,
    rawBody: input.rawBody,
  });

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return {
      ok: false as const,
      reason: "invalid_signature" as const,
    };
  }

  return {
    ok: true as const,
    timestamp,
    nonce,
    signature,
  };
}
