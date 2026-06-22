export type FeishuFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateFeishuClientOptions = {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: FeishuFetch;
};

export type FeishuTextMessageInput = {
  chatId: string;
  text: string;
};

export type FeishuReplyTextMessageInput = {
  messageId: string;
  text: string;
  replyInThread?: boolean;
};

export type FeishuMessageReactionInput = {
  messageId: string;
  emojiType: string;
};

export type FeishuTextMessageResult = {
  messageId: string;
};

export type FeishuReplyTextMessageResult = {
  messageId: string;
};

export type FeishuDeleteMessageReactionInput = {
  messageId: string;
  reactionId: string;
};

export type FeishuMessageReactionResult = {
  reactionId: string;
};

export type FeishuCardMessageInput = {
  chatId: string;
  card: object;
};

export type FeishuCardMessageResult = {
  messageId: string;
};

export type FeishuReplyCardMessageInput = {
  messageId: string;
  card: object;
  replyInThread?: boolean;
};

/**
 * CardKit primitives — used by `streaming-card.ts` to mint a card,
 * patch its elements in real time, and (optionally) tear it down.
 *
 * `cardJson`: standard Feishu card schema 2.0 payload (header, body,
 * elements...). The same shape you'd pass to `sendCardMessage`, but
 * the card is created as an independent entity FIRST, then a separate
 * IM message references it by card_id. That two-step is what enables
 * the per-element PATCH stream.
 *
 * `idempotencyKey`: pass `newIdempotencyKey()` from `card-envelope.ts`
 * so a retried POST returns the SAME card_id (not a duplicate card).
 * Feishu honors this header.
 */
export type FeishuCreateCardInput = {
  cardJson: object;
  idempotencyKey: string;
};

/**
 * Input for a terminal full-card replace via the CardKit "update card entity"
 * endpoint (`PUT /open-apis/cardkit/v1/cards/{card_id}`).
 *
 * Spike-confirmed (2026-06-02, code:0 live against prod Feishu):
 *   body = { card: { type: "card_json", data: JSON.stringify(cardJson) }, sequence, uuid }
 *
 * i.e. `card` is a nested object whose `data` field is the card JSON as a
 * string — same pattern as the `createCard` top-level `{ type, data }` pair,
 * but wrapped under a `card` key. DO NOT pass `card` as a plain string
 * (that returns a non-0 code) or as a raw object (same rejection).
 */
export type FeishuUpdateCardInput = {
  cardId: string;
  cardJson: object;
  /**
   * Monotonically increasing per-card sequence. Must be greater than any
   * preceding patchCardElement / patchCardSettings sequences on the same card.
   * Feishu rejects duplicate or out-of-order sequences with code 11402.
   */
  sequence: number;
  /**
   * Per-PUT UUID for client-side dedup. Use a fresh UUID for each call
   * (e.g. `crypto.randomUUID()` or `upd_<cardId>_<sequence>`).
   */
  uuid: string;
};

export type FeishuCreateCardResult = {
  cardId: string;
};

export type FeishuPatchCardElementInput = {
  cardId: string;
  elementId: string;
  /**
   * Replacement payload for the element. For `markdown` elements:
   * `{ content: "..." }`. For `column_set` etc., the SDK accepts the
   * full element body. Pass the same shape you would in a card-create
   * `elements: [...]` entry, minus the wrapping `{ tag, element_id }`.
   */
  partial: object;
  /**
   * Monotonically increasing per-card sequence number. Feishu rejects
   * out-of-order or duplicate sequences with code 11402; the streaming
   * card manager tracks this in-memory and retries once on miss.
   */
  sequence: number;
  /**
   * Per-PATCH UUID for client-side dedup. Format is up to the caller;
   * we use `s_<cardId>_<sequence>` so a retried PATCH (same sequence)
   * sends the same UUID.
   */
  uuid: string;
};

/**
 * Reference a created card from an IM message so users can see + click
 * it. Same shape as `sendCardMessage` but the body is `{ type: "card",
 * data: { card_id } }` instead of an inline schema.
 */
export type FeishuSendCardRefInput = {
  chatId: string;
  cardId: string;
};

export type FeishuSendCardRefResult = {
  messageId: string;
};

type FeishuApiEnvelope = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  data?: {
    message_id?: string;
    reaction_id?: string;
    card_id?: string;
  };
};

const DEFAULT_FEISHU_BASE_URL = "https://open.feishu.cn";

/**
 * Feishu API error carrying the structured `code` from the response
 * envelope (or the HTTP status when the body never parsed). The
 * single-card streaming session inspects `.code === 11402` to handle a
 * duplicate/out-of-order sequence explicitly (retry-same-seq vs advance)
 * instead of treating every failure as an opaque network blip.
 */
export class FeishuApiError extends Error {
  /** Feishu business code (e.g. 11402 = sequence compare failed), or undefined for transport failures. */
  readonly code: number | undefined;
  /** HTTP status when the failure was at the transport layer (!response.ok). */
  readonly httpStatus: number | undefined;
  constructor(message: string, opts?: { code?: number; httpStatus?: number }) {
    super(message);
    this.name = "FeishuApiError";
    this.code = opts?.code;
    this.httpStatus = opts?.httpStatus;
  }
}

/** Feishu's "sequence number compare failed" business code (duplicate/out-of-order PATCH sequence). */
export const FEISHU_SEQUENCE_CONFLICT_CODE = 11402;

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function parseFeishuJsonResponse(response: Response) {
  if (!response.ok) {
    // Pull body for the error message so 400s aren't opaque "HTTP 400"
    // (the actual cause — invalid field, sequence mismatch, body size —
    // lives in the response payload). The business `code` (e.g. 11402)
    // can also live in a non-2xx body, so try to surface it.
    let detail = "";
    let bodyCode: number | undefined;
    try {
      const text = await response.text();
      if (text) {
        detail = ` body=${text.slice(0, 500)}`;
        try {
          const parsed = JSON.parse(text) as { code?: number };
          if (typeof parsed.code === "number") bodyCode = parsed.code;
        } catch {
          /* body wasn't JSON */
        }
      }
    } catch {
      /* ignore */
    }
    throw new FeishuApiError(
      `Feishu API request failed with HTTP ${response.status}${detail}`,
      { httpStatus: response.status, ...(bodyCode !== undefined ? { code: bodyCode } : {}) },
    );
  }

  const payload = (await response.json()) as FeishuApiEnvelope;
  if (payload.code !== 0) {
    throw new FeishuApiError(
      payload.msg ?? `Feishu API request failed with code ${payload.code ?? -1}`,
      { ...(typeof payload.code === "number" ? { code: payload.code } : {}) },
    );
  }

  return payload;
}

type FeishuApiEnvelopeWithExpire = FeishuApiEnvelope & { expire?: number };

let cachedToken: { token: string; expiresAt: number; cacheKey: string } | null = null;

// Async singleflight for token refresh. Two concurrent
// getTenantAccessToken() callers shouldn't BOTH initiate a refresh —
// they should share the same in-flight Promise. Bun is single-threaded
// so this isn't thread safety; it's race-across-await prevention.
//
// Keyed by cacheKey so multiple Feishu apps (uncommon but possible)
// don't interfere with each other's refresh.
const inflightRefresh = new Map<string, Promise<string>>();

/** Reset the module-level token cache. Useful in tests. */
export function resetFeishuTokenCache() {
  cachedToken = null;
  inflightRefresh.clear();
}

export function createFeishuClient(options: CreateFeishuClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_FEISHU_BASE_URL);
  const cacheKey = `${options.appId}:${baseUrl}`;

  async function getTenantAccessToken() {
    if (cachedToken && cachedToken.cacheKey === cacheKey && Date.now() < cachedToken.expiresAt) {
      return cachedToken.token;
    }

    // Singleflight: if another caller is already refreshing this
    // cacheKey, await their promise instead of starting a duplicate
    // POST. Without this, ~10 concurrent leader-loop calls would
    // each fire their own token request the moment cachedToken
    // expires; Feishu has unpublished but observable rate limits on
    // the token endpoint.
    const inflight = inflightRefresh.get(cacheKey);
    if (inflight) return inflight;

    const refresh = (async () => {
      try {
        const response = await fetchImpl(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            app_id: options.appId,
            app_secret: options.appSecret,
          }),
        });

        const payload = (await parseFeishuJsonResponse(response)) as FeishuApiEnvelopeWithExpire;
        if (!payload.tenant_access_token) {
          throw new Error("Feishu tenant access token missing from response");
        }

        const expireSeconds = typeof payload.expire === "number" ? payload.expire : 7200;
        cachedToken = {
          token: payload.tenant_access_token,
          expiresAt: Date.now() + (expireSeconds - 300) * 1000, // refresh 5 min before expiry
          cacheKey,
        };
        return payload.tenant_access_token;
      } finally {
        // Always clear, regardless of success/failure — otherwise a
        // failed refresh would block all future getTenantAccessToken()
        // calls forever.
        inflightRefresh.delete(cacheKey);
      }
    })();
    inflightRefresh.set(cacheKey, refresh);
    return refresh;
  }

  async function sendTextMessage(input: FeishuTextMessageInput): Promise<FeishuTextMessageResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: input.chatId,
        msg_type: "text",
        content: JSON.stringify({
          text: input.text,
        }),
      }),
    });

    const payload = await parseFeishuJsonResponse(response);
    const messageId = payload.data?.message_id;
    if (!messageId) {
      throw new Error("Feishu message_id missing from response");
    }

    return { messageId };
  }

  async function replyTextMessage(
    input: FeishuReplyTextMessageInput,
  ): Promise<FeishuReplyTextMessageResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages/${input.messageId}/reply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({
          text: input.text,
        }),
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
      }),
    });

    const payload = await parseFeishuJsonResponse(response);
    const messageId = payload.data?.message_id;
    if (!messageId) {
      throw new Error("Feishu reply message_id missing from response");
    }

    return { messageId };
  }

  async function addMessageReaction(
    input: FeishuMessageReactionInput,
  ): Promise<FeishuMessageReactionResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(`${baseUrl}/open-apis/im/v1/messages/${input.messageId}/reactions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: input.emojiType,
        },
      }),
    });

    const payload = await parseFeishuJsonResponse(response);
    const reactionId = payload.data?.reaction_id;
    if (!reactionId) {
      throw new Error("Feishu reaction_id missing from response");
    }

    return { reactionId };
  }

  async function deleteMessageReaction(
    input: FeishuDeleteMessageReactionInput,
  ): Promise<void> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(
      `${baseUrl}/open-apis/im/v1/messages/${input.messageId}/reactions/${input.reactionId}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
    );

    await parseFeishuJsonResponse(response);
  }

  async function sendCardMessage(
    input: FeishuCardMessageInput,
  ): Promise<FeishuCardMessageResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(
      `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receive_id: input.chatId,
          msg_type: "interactive",
          content: JSON.stringify(input.card),
        }),
      },
    );

    const payload = await parseFeishuJsonResponse(response);
    const messageId = payload.data?.message_id;
    if (!messageId) {
      throw new Error("Feishu message_id missing from response");
    }

    return { messageId };
  }

  async function replyCardMessage(
    input: FeishuReplyCardMessageInput,
  ): Promise<FeishuCardMessageResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(
      `${baseUrl}/open-apis/im/v1/messages/${input.messageId}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          msg_type: "interactive",
          content: JSON.stringify(input.card),
          ...(input.replyInThread ? { reply_in_thread: true } : {}),
        }),
      },
    );

    const payload = await parseFeishuJsonResponse(response);
    const messageId = payload.data?.message_id;
    if (!messageId) {
      throw new Error("Feishu reply message_id missing from response");
    }

    return { messageId };
  }

  /**
   * Create a card entity via the CardKit API. The card lives
   * independently of any IM message; subsequent `patchCardElement`
   * calls reference it by `cardId`. To make the card visible to
   * users you then `sendCardRef` it into a chat.
   *
   * Idempotent: pass the same `idempotencyKey` to retry POST and
   * Feishu returns the same `card_id` instead of duplicating.
   */
  async function createCard(input: FeishuCreateCardInput): Promise<FeishuCreateCardResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(`${baseUrl}/open-apis/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "card_json",
        data: JSON.stringify(input.cardJson),
        idempotency_key: input.idempotencyKey,
      }),
    });
    const payload = await parseFeishuJsonResponse(response);
    const cardId = payload.data?.card_id;
    if (!cardId) {
      throw new Error("Feishu card_id missing from createCard response");
    }
    return { cardId };
  }

  /**
   * Update a single element of a previously-created card.
   *
   * Endpoint is `PUT /cardkit/v1/cards/{card_id}/elements/{element_id}/content`
   * with body `{ content, sequence, uuid }`.
   * The earlier `PATCH` + `{ partial_element }` shape was the SDK's
   * generic-update path; the streaming-specific content endpoint is
   * what actually accepts incremental updates with sequence ordering.
   *
   * `partial.content` should be a string (markdown text for the
   * element). The full `partial` object is passed in for forward
   * compatibility but only the `content` field is read.
   *
   * Sequence ordering: each PUT must carry a monotonically increasing
   * `sequence` per card; Feishu rejects out-of-order or duplicate
   * sequences with code 11402, surfaced here as a thrown Error.
   * Caller (`streaming-card.ts`) tracks sequence in-memory.
   */
  async function patchCardElement(input: FeishuPatchCardElementInput): Promise<void> {
    const token = await getTenantAccessToken();
    const content =
      typeof (input.partial as { content?: unknown }).content === "string"
        ? (input.partial as { content: string }).content
        : JSON.stringify(input.partial);
    const response = await fetchImpl(
      `${baseUrl}/open-apis/cardkit/v1/cards/${input.cardId}/elements/${input.elementId}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content,
          sequence: input.sequence,
          uuid: input.uuid,
        }),
      },
    );
    await parseFeishuJsonResponse(response);
  }

  /**
   * Update card-level settings (e.g. flip `streaming_mode: false` to
   * stop the typewriter animation when a stream completes). Same
   * sequence/uuid idempotency as element PATCH.
   *
   * Wire shape:
   *   {
   *     "settings": "<JSON-stringified string>",   // ← string, NOT object
   *     "sequence": N,
   *     "uuid": "..."
   *   }
   * where the inner JSON is `{ "config": { streaming_mode, summary, ... } }`.
   *
   * Passing the settings as a raw nested object (without the `config`
   * wrapper, without the outer JSON.stringify) makes Feishu reject the
   * call with HTTP 400 and the card stays in streaming/Working state
   * forever — that was the root cause of the "[Working…] never
   * clears" symptom.
   */
  async function patchCardSettings(input: {
    cardId: string;
    /** Goes inside the `config` envelope as JSON. */
    settings: object;
    sequence: number;
    uuid: string;
  }): Promise<void> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(
      `${baseUrl}/open-apis/cardkit/v1/cards/${input.cardId}/settings`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          settings: JSON.stringify({ config: input.settings }),
          sequence: input.sequence,
          uuid: input.uuid,
        }),
      },
    );
    await parseFeishuJsonResponse(response);
  }

  /**
   * Upload an image to Feishu's image store and return the `image_key`
   * used to embed it in card elements (`img` tag or `image` element).
   *
   * Sends a multipart POST to `/open-apis/im/v1/images` with
   * `image_type=message` and the raw image bytes. The `content-type`
   * header is intentionally omitted — the runtime (fetch / Bun) sets
   * it automatically with the correct multipart boundary when `body`
   * is a `FormData` instance.
   */
  async function uploadImage(input: { data: Buffer; filename: string }): Promise<{ imageKey: string }> {
    const token = await getTenantAccessToken();
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([new Uint8Array(input.data)]), input.filename);
    const response = await fetchImpl(`${baseUrl}/open-apis/im/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }, // content-type set automatically (multipart boundary) by FormData
      body: form,
    });
    const payload = await parseFeishuJsonResponse(response);
    const imageKey = (payload.data as Record<string, unknown> | undefined)?.image_key as string | undefined;
    if (!imageKey) throw new Error("Feishu image_key missing from uploadImage response");
    return { imageKey };
  }

  /**
   * Terminal full-card replace via the CardKit "update card entity" endpoint.
   *
   * Used at the end of a streaming turn to:
   *   1. Swap the streaming card for a final `card_json` that has
   *      `streaming_mode: false` (stops typewriter animation).
   *   2. Inline media (images uploaded via `uploadImage`).
   *   3. Finalize the complete tools panel and answer body in one round-trip.
   *
   * Spike-confirmed shape (2026-06-02, code:0 live):
   *   PUT /open-apis/cardkit/v1/cards/{card_id}
   *   body = {
   *     card: { type: "card_json", data: JSON.stringify(cardJson) },
   *     sequence: N,
   *     uuid: "..."
   *   }
   *
   * The `sequence` must be strictly greater than any preceding
   * patchCardElement / patchCardSettings sequences on the same card.
   * Caller is responsible for draining any in-flight element patches
   * (to prevent sequence ordering violations) before calling updateCard.
   */
  async function updateCard(input: FeishuUpdateCardInput): Promise<void> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(`${baseUrl}/open-apis/cardkit/v1/cards/${input.cardId}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        card: { type: "card_json", data: JSON.stringify(input.cardJson) },
        sequence: input.sequence,
        uuid: input.uuid,
      }),
    });
    await parseFeishuJsonResponse(response);
  }

  /**
   * Reference a card in an IM message so users can see + click it.
   * The card body is delivered inline as `{ type: "card", data:
   * { card_id } }` per Feishu's "card_id reference" message format.
   */
  async function sendCardRef(input: FeishuSendCardRefInput): Promise<FeishuSendCardRefResult> {
    const token = await getTenantAccessToken();
    const response = await fetchImpl(
      `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receive_id: input.chatId,
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: input.cardId } }),
        }),
      },
    );
    const payload = await parseFeishuJsonResponse(response);
    const messageId = payload.data?.message_id;
    if (!messageId) {
      throw new Error("Feishu message_id missing from sendCardRef response");
    }
    return { messageId };
  }

  return {
    getTenantAccessToken,
    sendTextMessage,
    replyTextMessage,
    addMessageReaction,
    deleteMessageReaction,
    sendCardMessage,
    replyCardMessage,
    createCard,
    patchCardElement,
    patchCardSettings,
    sendCardRef,
    uploadImage,
    updateCard,
  };
}

export type FeishuClient = ReturnType<typeof createFeishuClient>;
